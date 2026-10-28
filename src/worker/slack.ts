import { MAX_ATTACHMENT_BYTES, isAllowedAttachmentType, safeFilename } from "./attachments.ts";

// "Attach to expense report" — a Slack message shortcut that files a receipt
// photo against a trip and a cost group.
//
// The flow, end to end:
//   1. A parent posts a photo of a receipt in the trip's Slack channel.
//   2. They pick "Attach to expense report" from the message's ⋮ menu. Slack
//      POSTs a signed `message_action` here and we open a modal asking which
//      expense report (trip) and which patrol/unit it belongs to, plus the
//      amount and what it was for.
//   3. Changing the expense report re-renders the modal (`block_actions`) so the
//      "Charge to" list is that trip's own patrols and not another trip's.
//   4. Submitting (`view_submission`) queues a `slack_receipts` row and copies
//      the file out of Slack into R2. A leader approves it on the Expenses tab,
//      and only THAT creates the expense.
//
// Two things are load-bearing about the design:
//
// * **Slack is not an identity.** Everything else in this app authenticates with
//   the `__Secure-troop_session` cookie from id.troop10rwc.org. A Slack
//   workspace has guests, bots and people who left the troop, so a signed Slack
//   payload proves only "someone in the workspace", never "this member may
//   change the books". That's why submissions land in an inert review queue —
//   the same posture as the public statement page's `corrections`. The Slack
//   user IS correlated to a member (`users.slack_sub` in the shared identity DB)
//   so the treasurer sees who sent it and the payer comes pre-filled, but an
//   unmatched sender is shown as unmatched rather than quietly trusted.
//
// * **Slack's 3-second budget.** `views.open` must be called with a trigger_id
//   that expires in 3s, so the shortcut path does nothing but two indexed D1
//   reads. Pulling the file bytes out of Slack is far too slow for that budget,
//   so `view_submission` writes the row synchronously (which is what makes the
//   modal able to report a bad amount) and moves the bytes in `waitUntil`,
//   reporting the outcome as a threaded reply on the original message.

export interface SlackBindings {
  DB: D1Database;
  RECEIPTS: R2Bucket;
  /** Shared identity DB (troop10-id), read-only: `users.slack_sub` -> member. */
  IDDB: D1Database;
  /** Slack app signing secret — verifies every request actually came from Slack. */
  SLACK_SIGNING_SECRET?: string;
  /** Bot token (xoxb-…). Needs `files:read` to download a tagged receipt and
   *  `chat:write` to reply in the thread. Without it the feature is off. */
  SLACK_BOT_TOKEN?: string;
}

/** Shortcut callback_ids, as configured in the Slack app's Interactivity setup. */
export const SHORTCUT_CALLBACK_ID = "attach_receipt";
const VIEW_CALLBACK_ID = "attach_receipt_modal";
/** "Add as unit expense" — a non-trip reimbursement, typically run in #treasurer. */
export const UNIT_SHORTCUT_CALLBACK_ID = "add_unit_expense";
const UNIT_VIEW_CALLBACK_ID = "unit_expense_modal";

/** One message rarely carries more; past this it's an album, not a receipt. */
const MAX_SLACK_FILES = 5;
/** Flood stop, mirroring MAX_CORRECTIONS_PER_PERSON on the public route. */
const MAX_PENDING_PER_USER = 20;
/** Slack rejects an option whose text runs past this. */
const OPTION_TEXT_MAX = 75;
/** Slack replays are only accepted inside this window (their documented value). */
const MAX_SIGNATURE_AGE_SECONDS = 300;

// ---------------------------------------------------------------- signature

const hexToBytes = (hex: string): Uint8Array | null => {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/**
 * Verify Slack's `v0` request signature over the RAW body.
 *
 * The comparison runs through `crypto.subtle.verify` rather than rebuilding the
 * hex digest and comparing strings, because that comparison is constant-time for
 * free — a string `===` on a MAC is a textbook timing oracle.
 *
 * The timestamp check is what makes a captured-and-replayed payload useless: the
 * signature stays valid forever, the five-minute window does not.
 */
export async function verifySlackSignature(
  rawBody: string,
  timestamp: string | null,
  signature: string | null,
  signingSecret: string,
): Promise<boolean> {
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > MAX_SIGNATURE_AGE_SECONDS) return false;
  if (!signature.startsWith("v0=")) return false;
  const provided = hexToBytes(signature.slice(3));
  if (!provided || provided.byteLength !== 32) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    provided,
    new TextEncoder().encode(`v0:${timestamp}:${rawBody}`),
  );
}

// ------------------------------------------------------------- Slack Web API

interface SlackApiResult { ok: boolean; error?: string; [k: string]: unknown }

async function slackApi(token: string, method: string, body: unknown): Promise<SlackApiResult> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  // Slack answers 200 with `ok:false` for application errors; a non-200 is a
  // transport/auth problem and has no JSON body worth parsing.
  const json = (await res.json().catch(() => ({ ok: false, error: "bad_json" }))) as SlackApiResult;
  if (!json.ok) console.warn(`slack ${method} failed:`, json.error);
  return json;
}

/** Reply under the tagged message, so the answer lands where the ask was made. */
export async function postThreadReply(
  env: SlackBindings,
  channel: string | null,
  threadTs: string | null,
  text: string,
): Promise<void> {
  if (!env.SLACK_BOT_TOKEN || !channel || !threadTs) return;
  await slackApi(env.SLACK_BOT_TOKEN, "chat.postMessage", { channel, thread_ts: threadTs, text });
}

// --------------------------------------------------------- payload fragments

interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

/** What the modal carries between `views.open` and `view_submission`. */
interface ViewMeta {
  files: { id: string; name: string; mimetype: string; size: number; url: string }[];
  channel: string | null;
  ts: string | null;
  permalink: string | null;
}

/**
 * The message's archive URL, assembled from the payload rather than fetched.
 *
 * `chat.getPermalink` would be the official way, but it's an extra round trip
 * inside the 3-second trigger_id budget for a link whose format is stable and
 * fully determined by what we already hold.
 */
function archiveUrl(teamDomain: string | undefined, channel: string | null, ts: string | null): string | null {
  if (!teamDomain || !channel || !ts) return null;
  return `https://${teamDomain}.slack.com/archives/${channel}/p${ts.replace(".", "")}`;
}

/** The files on a tagged message we're willing to store, by the app's own rules. */
function usableFiles(files: SlackFile[]): ViewMeta["files"] {
  const out: ViewMeta["files"] = [];
  for (const f of files) {
    if (out.length >= MAX_SLACK_FILES) break;
    const mimetype = f.mimetype ?? "";
    const url = f.url_private_download ?? f.url_private ?? "";
    const size = f.size ?? 0;
    if (!url || !isAllowedAttachmentType(mimetype)) continue;
    if (size <= 0 || size > MAX_ATTACHMENT_BYTES) continue;
    out.push({ id: f.id ?? "", name: f.name ?? f.title ?? "receipt", mimetype, size, url });
  }
  return out;
}

// ------------------------------------------------------------- modal blocks

const plain = (text: string) => ({ type: "plain_text" as const, text, emoji: true });
const truncate = (s: string) => (s.length > OPTION_TEXT_MAX ? `${s.slice(0, OPTION_TEXT_MAX - 1)}…` : s);
const option = (value: string, text: string) => ({ text: plain(truncate(text)), value });

interface TripOption { id: number; name: string; trip_date: string | null }
interface GroupOption { id: number; name: string; kind: string }

/** A one-line modal that just explains why there's nothing to do. */
function noticeView(title: string, message: string) {
  return {
    type: "modal",
    title: plain(title),
    close: plain("Close"),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: message } }],
  };
}

function receiptView(
  meta: ViewMeta,
  trips: TripOption[],
  tripId: number,
  groups: GroupOption[],
  groupId: number | null,
  draft: { amount?: string; description?: string },
) {
  const tripOpt = (t: TripOption) => option(String(t.id), t.trip_date ? `${t.name} (${t.trip_date})` : t.name);
  const groupOpt = (g: GroupOption) => option(String(g.id), g.name);
  const selectedTrip = trips.find((t) => t.id === tripId) ?? trips[0];
  const selectedGroup = groups.find((g) => g.id === groupId) ?? groups[0];

  const fileNames = meta.files.map((f) => f.name).join(", ");
  const blocks: unknown[] = [
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `📎 ${meta.files.length === 1 ? "*1 file*" : `*${meta.files.length} files*`}: ${fileNames}` }],
    },
    {
      type: "input",
      block_id: "trip",
      // Re-renders the modal so "Charge to" below lists THIS trip's patrols.
      // Without it the two selects could disagree and the submission would be
      // charged to a group belonging to another trip.
      dispatch_action: true,
      label: plain("Expense report"),
      element: {
        type: "static_select",
        action_id: "trip",
        options: trips.map(tripOpt),
        ...(selectedTrip ? { initial_option: tripOpt(selectedTrip) } : {}),
      },
    },
  ];

  if (groups.length > 0) {
    blocks.push({
      type: "input",
      block_id: "group",
      label: plain("Charge to"),
      element: {
        type: "static_select",
        action_id: "group",
        options: groups.map(groupOpt),
        ...(selectedGroup ? { initial_option: groupOpt(selectedGroup) } : {}),
      },
    });
  } else {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "_That expense report has no patrols or unit group yet — pick another._" },
    });
  }

  blocks.push(
    {
      type: "input",
      block_id: "amount",
      label: plain("Amount"),
      element: {
        type: "plain_text_input",
        action_id: "amount",
        placeholder: plain("0.00"),
        ...(draft.amount ? { initial_value: draft.amount } : {}),
      },
    },
    {
      type: "input",
      block_id: "description",
      label: plain("What was it for?"),
      element: {
        type: "plain_text_input",
        action_id: "description",
        max_length: 200,
        placeholder: plain("e.g. Food — Safeway"),
        ...(draft.description ? { initial_value: draft.description } : {}),
      },
    },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: "A leader reviews this before it lands on the expense report — nothing is charged to anyone yet.",
      }],
    },
  );

  return {
    type: "modal",
    callback_id: VIEW_CALLBACK_ID,
    title: plain("Attach receipt"),
    ...(groups.length > 0 ? { submit: plain("Send to treasurer") } : {}),
    close: plain("Cancel"),
    private_metadata: JSON.stringify(meta),
    blocks,
  };
}

// ------------------------------------------------------------------ queries

/**
 * Trips a receipt can actually be filed against: newest first, and only those
 * with somewhere to charge it. A trip with no non-travel cost group would render
 * a static_select with zero options, which Slack rejects outright.
 */
async function selectableTrips(db: D1Database): Promise<TripOption[]> {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.name, t.trip_date
         FROM trips t
        WHERE EXISTS (SELECT 1 FROM cost_groups g WHERE g.trip_id = t.id AND g.kind != 'travel')
        ORDER BY t.id DESC
        LIMIT 100`,
    )
    .all<TripOption>();
  return results ?? [];
}

/** Charge targets for one trip. Travel groups are excluded: their expenses are
 *  regenerated from the mileage calculator and a hand-added row wouldn't survive. */
async function chargeGroups(db: D1Database, tripId: number): Promise<GroupOption[]> {
  const { results } = await db
    .prepare("SELECT id, name, kind FROM cost_groups WHERE trip_id = ? AND kind != 'travel' ORDER BY sort_order, id")
    .bind(tripId)
    .all<GroupOption>();
  return results ?? [];
}

/**
 * The troop member behind a Slack user id.
 *
 * The identity service signs members in with Slack OIDC and stores the `sub`
 * claim as `users.slack_sub`; Slack's OIDC `sub` is the bare member id (`U…`),
 * which is exactly what an interaction payload's `user.id` carries. The
 * team-scoped spelling is tried alongside it in the same query so a provider
 * that namespaces the subject still resolves, at no extra round trip.
 *
 * A miss is normal and not an error: workspace guests and members who've never
 * signed in to the troop apps have no row. The caller records the miss and the
 * review queue shows it, which is the honest outcome — far better than inventing
 * an identity for a submission that's about to become money.
 */
export async function resolveSlackMember(
  iddb: D1Database,
  teamId: string | null,
  slackUserId: string,
): Promise<{ email: string | null; name: string | null } | null> {
  const candidates = teamId ? [slackUserId, `${teamId}-${slackUserId}`] : [slackUserId];
  try {
    const row = await iddb
      .prepare(
        `SELECT email, name FROM users WHERE slack_sub IN (${candidates.map(() => "?").join(", ")}) LIMIT 1`,
      )
      .bind(...candidates)
      .first<{ email: string | null; name: string | null }>();
    return row ?? null;
  } catch (e) {
    console.warn("slack member lookup failed:", (e as Error).message);
    return null;
  }
}

/** That member as a person ON this trip, if they're on it. Null is fine — the
 *  leader picks the payer at approval. */
async function payerOnTrip(db: D1Database, tripId: number, email: string | null): Promise<number | null> {
  if (!email) return null;
  const row = await db
    .prepare(
      "SELECT id FROM people WHERE trip_id = ? AND type = 'adult' AND email IS NOT NULL AND lower(email) = lower(?) LIMIT 1",
    )
    .bind(tripId, email)
    .first<{ id: number }>();
  return row?.id ?? null;
}

// ------------------------------------------------------------ interactions

/** Read one modal input back out of a `view.state.values` blob. */
function stateValue(view: any, blockId: string, actionId: string): string | null {
  const v = view?.state?.values?.[blockId]?.[actionId];
  if (!v) return null;
  return v.selected_option?.value ?? v.value ?? null;
}

/** Dollars a person typed: "$12.34", "12.34", "1,234.50" all mean the same. */
export function parseAmount(raw: string | null): number | null {
  const cleaned = (raw ?? "").replace(/[$,\s]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

/**
 * Open the modal for a tagged message.
 *
 * Everything here is on the trigger_id clock, so it's two indexed reads and one
 * API call — no file work, no Slack lookups.
 */
async function onMessageAction(env: SlackBindings, payload: any): Promise<void> {
  const token = env.SLACK_BOT_TOKEN!;
  const triggerId = payload.trigger_id;
  const channel = payload.channel?.id ?? null;
  const ts = payload.message?.ts ?? payload.message_ts ?? null;

  const files = usableFiles((payload.message?.files ?? []) as SlackFile[]);
  if (files.length === 0) {
    await slackApi(token, "views.open", {
      trigger_id: triggerId,
      view: noticeView(
        "No receipt found",
        "That message has no photo or PDF attached that I can file.\n\nPost the receipt image (or a PDF, up to 10 MB) and run *Attach to expense report* on _that_ message.",
      ),
    });
    return;
  }

  const trips = await selectableTrips(env.DB);
  if (trips.length === 0) {
    await slackApi(token, "views.open", {
      trigger_id: triggerId,
      view: noticeView("No expense reports yet", "There's no trip with a patrol or unit group to charge this to yet."),
    });
    return;
  }

  // Default to the trip whose Slack channel this is, so the common case — a
  // receipt posted in the trip's own channel — needs no picking at all.
  const fromChannel = channel
    ? await env.DB.prepare(
        "SELECT id, name, trip_date FROM trips WHERE slack_url LIKE ? ORDER BY id DESC LIMIT 1",
      )
        .bind(`%${channel}%`)
        .first<TripOption>()
    : null;
  const tripId = fromChannel && trips.some((t) => t.id === fromChannel.id) ? fromChannel.id : trips[0].id;
  const groups = await chargeGroups(env.DB, tripId);

  const meta: ViewMeta = {
    files,
    channel,
    ts,
    permalink: archiveUrl(payload.team?.domain, channel, ts),
  };
  await slackApi(token, "views.open", {
    trigger_id: triggerId,
    view: receiptView(meta, trips, tripId, groups, null, {}),
  });
}

/** The expense report changed — re-render so "Charge to" follows it. */
async function onTripChanged(env: SlackBindings, payload: any): Promise<void> {
  const token = env.SLACK_BOT_TOKEN!;
  const view = payload.view;
  const tripId = Number(payload.actions?.[0]?.selected_option?.value);
  if (!view?.id || !Number.isInteger(tripId)) return;

  const meta = JSON.parse(view.private_metadata || "{}") as ViewMeta;
  const [trips, groups] = await Promise.all([selectableTrips(env.DB), chargeGroups(env.DB, tripId)]);

  await slackApi(token, "views.update", {
    view_id: view.id,
    hash: view.hash,
    // Carry the typed amount and description across the re-render — retyping
    // them because the trip list moved would be the app's fault, not theirs.
    view: receiptView(meta, trips, tripId, groups, null, {
      amount: stateValue(view, "amount", "amount") ?? undefined,
      description: stateValue(view, "description", "description") ?? undefined,
    }),
  });
}

/** `response_action: errors` keeps the modal open with the message under the field. */
const fieldError = (block: string, message: string) => ({
  response_action: "errors",
  errors: { [block]: message },
});

/**
 * Queue the submission.
 *
 * The row is written inline — it's cheap, and it's what lets a bad amount come
 * back as a field error rather than a silent failure after the modal has closed.
 * The bytes move in `waitUntil` afterwards, because pulling a 10 MB photo out of
 * Slack cannot fit in the 3 seconds Slack allows this response.
 */
async function onViewSubmission(
  env: SlackBindings,
  payload: any,
  ctx: ExecutionContext,
): Promise<Record<string, unknown> | null> {
  const view = payload.view;
  const meta = JSON.parse(view?.private_metadata || "{}") as ViewMeta;
  const slackUserId: string = payload.user?.id ?? "";
  const slackUserName: string =
    payload.user?.name ?? payload.user?.username ?? payload.user?.id ?? "someone on Slack";
  const teamId: string | null = payload.team?.id ?? null;

  const tripId = Number(stateValue(view, "trip", "trip"));
  const groupId = Number(stateValue(view, "group", "group"));
  const amount = parseAmount(stateValue(view, "amount", "amount"));
  const description = (stateValue(view, "description", "description") ?? "").trim();

  if (amount == null) return fieldError("amount", "Enter the amount on the receipt, e.g. 48.21");
  if (!description) return fieldError("description", "Say what this was for, e.g. Food — Safeway");
  if (!Number.isInteger(tripId) || !Number.isInteger(groupId)) {
    return fieldError("trip", "Pick an expense report and where to charge it.");
  }
  if (!meta.files?.length) {
    return fieldError("amount", "I lost track of the file on that message — start the shortcut again.");
  }

  // The two selects are rendered together, but a stale modal (left open while
  // the trip was edited in the app) could still submit a group from elsewhere.
  const group = await env.DB.prepare(
    "SELECT id, name FROM cost_groups WHERE id = ? AND trip_id = ? AND kind != 'travel'",
  )
    .bind(groupId, tripId)
    .first<{ id: number; name: string }>();
  if (!group) return fieldError("group", "That patrol is no longer on this expense report — pick another.");

  const { count } = (await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM slack_receipts WHERE slack_user_id = ? AND status = 'pending'",
  )
    .bind(slackUserId)
    .first<{ count: number }>()) ?? { count: 0 };
  if (count >= MAX_PENDING_PER_USER) {
    return fieldError(
      "amount",
      "You already have plenty of receipts waiting for review — give the treasurer a chance to catch up.",
    );
  }

  const member = await resolveSlackMember(env.IDDB, teamId, slackUserId);
  const payerId = await payerOnTrip(env.DB, tripId, member?.email ?? null);

  const inserted = await env.DB.prepare(
    `INSERT INTO slack_receipts
       (trip_id, group_id, slack_user_id, slack_team_id, slack_user_name, submitter_email, payer_id,
        description, amount, slack_channel_id, slack_message_ts, slack_permalink)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      tripId, groupId, slackUserId, teamId, slackUserName, member?.email ?? null, payerId,
      description, amount, meta.channel, meta.ts, meta.permalink,
    )
    .first<{ id: number }>();
  if (!inserted) return fieldError("amount", "Couldn't save that — try again in a moment.");

  ctx.waitUntil(
    storeSlackFiles(env, inserted.id, tripId, meta, { amount, description, groupName: group.name }).catch((e) => {
      console.error("slack receipt file transfer failed", e);
    }),
  );

  return { response_action: "clear" };
}

/**
 * Copy a tagged message's files out of Slack into R2 under `prefix`, calling
 * `record` for each one that lands. Returns how many did.
 *
 * Shared by both shortcuts: the receipt queue and unit expenses store into
 * different tables, but the download rules are the same.
 */
async function copySlackFiles(
  env: SlackBindings,
  meta: ViewMeta,
  prefix: string,
  record: (key: string, filename: string, f: ViewMeta["files"][number], size: number) => Promise<unknown>,
): Promise<number> {
  let stored = 0;
  for (const f of meta.files) {
    // private_metadata was written by `usableFiles` and can't be edited without
    // the signing secret, but it does make a round trip through the client, so
    // the rules are applied again here rather than taken on trust.
    if (!isAllowedAttachmentType(f.mimetype) || f.size <= 0 || f.size > MAX_ATTACHMENT_BYTES) continue;
    try {
      const res = await fetch(f.url, { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } });
      // A bad or unscoped token doesn't 401 here — Slack answers 200 with its
      // HTML sign-in page, which would otherwise be stored as "the receipt".
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || type.includes("text/html")) {
        console.warn(`slack file download refused (${res.status} ${type})`);
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) continue;

      const filename = safeFilename(f.name);
      const key = `${prefix}/${crypto.randomUUID()}-${filename}`;
      // Object first, so a committed row always points at real bytes.
      await env.RECEIPTS.put(key, bytes, { httpMetadata: { contentType: f.mimetype } });
      await record(key, filename, f, bytes.byteLength);
      stored++;
    } catch (e) {
      console.error("slack file copy failed", e);
    }
  }
  return stored;
}

/**
 * Copy the tagged files out of Slack into R2 and record them.
 *
 * A queued receipt with no photo is worse than no queued receipt — the treasurer
 * would see an amount with nothing to check it against — so if not one file
 * survives, the row is removed and the failure is said out loud in the thread
 * rather than left to be discovered at review time.
 */
async function storeSlackFiles(
  env: SlackBindings,
  receiptId: number,
  tripId: number,
  meta: ViewMeta,
  summary: { amount: number; description: string; groupName: string },
): Promise<void> {
  const stored = await copySlackFiles(env, meta, `trip/${tripId}/slack/${receiptId}`, (key, filename, f, size) =>
    env.DB.prepare(
      `INSERT INTO slack_receipt_files (receipt_id, trip_id, r2_key, filename, content_type, size, slack_file_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(receiptId, tripId, key, filename, f.mimetype, size, f.id || null)
      .run(),
  );

  if (stored === 0) {
    await env.DB.prepare("DELETE FROM slack_receipts WHERE id = ?").bind(receiptId).run();
    await postThreadReply(
      env,
      meta.channel,
      meta.ts,
      "⚠️ I couldn't copy that receipt out of Slack, so nothing was filed. Try the shortcut again, or add it directly in the expense app.",
    );
    return;
  }

  await postThreadReply(
    env,
    meta.channel,
    meta.ts,
    `📎 Filed for review — *${summary.description}*, ${money(summary.amount)}, charged to *${summary.groupName}*. A leader will confirm it before it lands on the expense report.`,
  );
}

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * Entry point for every Slack interaction. The caller has already verified the
 * signature; this only dispatches on payload type.
 *
 * Returns the JSON body Slack should get back, or null for "200, no body" —
 * which is what a shortcut and a block action both want.
 */
export async function handleSlackInteraction(
  env: SlackBindings,
  payload: any,
  ctx: ExecutionContext,
): Promise<Record<string, unknown> | null> {
  if (!env.SLACK_BOT_TOKEN) {
    console.warn("slack interaction ignored: SLACK_BOT_TOKEN is not configured");
    return null;
  }

  switch (payload?.type) {
    case "message_action":
      if (payload.callback_id === SHORTCUT_CALLBACK_ID) await onMessageAction(env, payload);
      else if (payload.callback_id === UNIT_SHORTCUT_CALLBACK_ID) await onUnitMessageAction(env, payload);
      return null;

    case "block_actions":
      if (payload.actions?.[0]?.action_id === "trip") await onTripChanged(env, payload);
      return null;

    case "view_submission":
      if (payload.view?.callback_id === VIEW_CALLBACK_ID) return onViewSubmission(env, payload, ctx);
      if (payload.view?.callback_id === UNIT_VIEW_CALLBACK_ID) return onUnitViewSubmission(env, payload, ctx);
      return null;

    default:
      return null;
  }
}

/**
 * Tell the thread what a leader decided. Fire-and-forget from the review routes:
 * Slack being down must never stop a treasurer approving a receipt.
 */
export async function notifyReviewed(
  env: SlackBindings,
  receipt: { slack_channel_id: string | null; slack_message_ts: string | null; description: string; amount: number },
  outcome: "approved" | "rejected",
  note: string | null,
): Promise<void> {
  const text =
    outcome === "approved"
      ? `✅ *${receipt.description}* (${money(receipt.amount)}) is on the expense report.`
      : `🚫 *${receipt.description}* (${money(receipt.amount)}) wasn't added${note ? `: ${note}` : "."}`;
  await postThreadReply(env, receipt.slack_channel_id, receipt.slack_message_ts, text);
}

// ------------------------------------------------------------ unit expenses
//
// "Add as unit expense": the same move as "Attach to expense report", for money
// that isn't tied to a trip — a parent posts a receipt in #treasurer and asks
// to be paid back. The modal asks who to reimburse (defaulting to whoever
// posted the receipt, since the person running the shortcut is often the
// treasurer filing it on their behalf), the amount, and what it was for.
//
// Same posture as the receipt queue: the row lands `pending`, which counts
// toward nothing. A signed-in leader approves it in the app.

/** What the unit modal carries between `views.open` and `view_submission`. */
type UnitViewMeta = ViewMeta;

function unitExpenseView(meta: UnitViewMeta, payeeSlackId: string | null) {
  const fileNames = meta.files.map((f) => f.name).join(", ");
  return {
    type: "modal",
    callback_id: UNIT_VIEW_CALLBACK_ID,
    title: plain("Unit expense"),
    submit: plain("Send to treasurer"),
    close: plain("Cancel"),
    private_metadata: JSON.stringify(meta),
    blocks: [
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `📎 ${meta.files.length === 1 ? "*1 file*" : `*${meta.files.length} files*`}: ${fileNames}` }],
      },
      {
        type: "input",
        block_id: "payee",
        label: plain("Reimburse"),
        element: {
          type: "users_select",
          action_id: "payee",
          ...(payeeSlackId ? { initial_user: payeeSlackId } : {}),
        },
      },
      {
        type: "input",
        block_id: "amount",
        label: plain("Amount"),
        element: { type: "plain_text_input", action_id: "amount", placeholder: plain("0.00") },
      },
      {
        type: "input",
        block_id: "description",
        label: plain("What was it for?"),
        element: {
          type: "plain_text_input",
          action_id: "description",
          max_length: 200,
          placeholder: plain("e.g. First-aid kit restock — REI"),
        },
      },
      {
        type: "input",
        block_id: "spent_on",
        optional: true,
        label: plain("Date on the receipt"),
        element: { type: "datepicker", action_id: "spent_on" },
      },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: "The treasurer reviews this before it's owed — nothing is recorded as money yet.",
        }],
      },
    ],
  };
}

async function onUnitMessageAction(env: SlackBindings, payload: any): Promise<void> {
  const token = env.SLACK_BOT_TOKEN!;
  const triggerId = payload.trigger_id;
  const channel = payload.channel?.id ?? null;
  const ts = payload.message?.ts ?? payload.message_ts ?? null;

  const files = usableFiles((payload.message?.files ?? []) as SlackFile[]);
  if (files.length === 0) {
    await slackApi(token, "views.open", {
      trigger_id: triggerId,
      view: noticeView(
        "No receipt found",
        "That message has no photo or PDF attached that I can file.\n\nPost the receipt image (or a PDF, up to 10 MB) and run *Add as unit expense* on _that_ message.",
      ),
    });
    return;
  }

  const meta: UnitViewMeta = { files, channel, ts, permalink: archiveUrl(payload.team?.domain, channel, ts) };
  // Default the payee to the message's author: the receipt is theirs. Bots and
  // integrations post without a `user`, which just leaves the picker empty.
  const author: string | null = payload.message?.user ?? null;
  await slackApi(token, "views.open", { trigger_id: triggerId, view: unitExpenseView(meta, author) });
}

async function onUnitViewSubmission(
  env: SlackBindings,
  payload: any,
  ctx: ExecutionContext,
): Promise<Record<string, unknown> | null> {
  const view = payload.view;
  const meta = JSON.parse(view?.private_metadata || "{}") as UnitViewMeta;
  const slackUserId: string = payload.user?.id ?? "";
  const slackUserName: string =
    payload.user?.name ?? payload.user?.username ?? payload.user?.id ?? "someone on Slack";
  const teamId: string | null = payload.team?.id ?? null;

  const payeeSlackId = view?.state?.values?.payee?.payee?.selected_user ?? null;
  const amount = parseAmount(stateValue(view, "amount", "amount"));
  const description = (stateValue(view, "description", "description") ?? "").trim();
  const spentOn: string | null = view?.state?.values?.spent_on?.spent_on?.selected_date ?? null;

  if (!payeeSlackId) return fieldError("payee", "Pick who should be paid back.");
  if (amount == null) return fieldError("amount", "Enter the amount on the receipt, e.g. 48.21");
  if (!description) return fieldError("description", "Say what this was for, e.g. First-aid kit restock");
  if (!meta.files?.length) {
    return fieldError("amount", "I lost track of the file on that message — start the shortcut again.");
  }

  const { count } = (await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM unit_expenses WHERE slack_user_id = ? AND status = 'pending'",
  )
    .bind(slackUserId)
    .first<{ count: number }>()) ?? { count: 0 };
  if (count >= MAX_PENDING_PER_USER) {
    return fieldError(
      "amount",
      "You already have plenty of expenses waiting for review — give the treasurer a chance to catch up.",
    );
  }

  // The payee is correlated to a member the same way the submitter is. A miss
  // is recorded as a miss: payee_email stays NULL and the treasurer picks the
  // member at approval, rather than this guessing who is owed money.
  const payee = await resolveSlackMember(env.IDDB, teamId, payeeSlackId);
  const payeeName =
    payee?.name ?? (payeeSlackId === slackUserId ? slackUserName : `Slack member ${payeeSlackId}`);

  const inserted = await env.DB.prepare(
    `INSERT INTO unit_expenses
       (payee_email, payee_name, payee_slack_id, description, amount, spent_on, status, source,
        slack_user_id, slack_team_id, slack_user_name, slack_channel_id, slack_message_ts, slack_permalink)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', 'slack', ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      payee?.email ?? null, payeeName, payeeSlackId, description, amount, spentOn,
      slackUserId, teamId, slackUserName, meta.channel, meta.ts, meta.permalink,
    )
    .first<{ id: number }>();
  if (!inserted) return fieldError("amount", "Couldn't save that — try again in a moment.");

  ctx.waitUntil(
    storeUnitFiles(env, inserted.id, meta, { amount, description, payeeSlackId }).catch((e) => {
      console.error("unit expense file transfer failed", e);
    }),
  );
  return { response_action: "clear" };
}

/** As `storeSlackFiles`: no file that survives means no row. */
async function storeUnitFiles(
  env: SlackBindings,
  unitExpenseId: number,
  meta: UnitViewMeta,
  summary: { amount: number; description: string; payeeSlackId: string },
): Promise<void> {
  const stored = await copySlackFiles(env, meta, `unit/${unitExpenseId}`, (key, filename, f, size) =>
    env.DB.prepare(
      `INSERT INTO unit_expense_files (unit_expense_id, r2_key, filename, content_type, size, slack_file_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(unitExpenseId, key, filename, f.mimetype, size, f.id || null)
      .run(),
  );

  if (stored === 0) {
    await env.DB.prepare("DELETE FROM unit_expenses WHERE id = ?").bind(unitExpenseId).run();
    await postThreadReply(
      env,
      meta.channel,
      meta.ts,
      "⚠️ I couldn't copy that receipt out of Slack, so nothing was filed. Try the shortcut again, or add it in the expense app under Unit expenses.",
    );
    return;
  }

  await postThreadReply(
    env,
    meta.channel,
    meta.ts,
    `📎 Filed as a unit expense — *${summary.description}*, ${money(summary.amount)}, to reimburse <@${summary.payeeSlackId}>. The treasurer will review it.`,
  );
}

/**
 * Tell the thread where a unit expense went: approved, turned down, or paid.
 * Fire-and-forget from the routes, like `notifyReviewed`.
 */
export async function notifyUnitExpense(
  env: SlackBindings,
  row: {
    slack_channel_id: string | null;
    slack_message_ts: string | null;
    payee_slack_id: string | null;
    payee_name: string;
    description: string;
    amount: number;
  },
  outcome: "approved" | "rejected" | "paid",
  note: string | null,
): Promise<void> {
  const who = row.payee_slack_id ? `<@${row.payee_slack_id}>` : row.payee_name;
  const what = `*${row.description}* (${money(row.amount)})`;
  const text =
    outcome === "approved"
      ? `✅ ${what} is approved — the troop owes ${who}.`
      : outcome === "paid"
        ? `💸 ${what} has been paid to ${who}${note ? ` — ${note}` : "."}`
        : `🚫 ${what} wasn't approved${note ? `: ${note}` : "."}`;
  await postThreadReply(env, row.slack_channel_id, row.slack_message_ts, text);
}
