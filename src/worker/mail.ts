import type { NoticeSendStatus, PersonNotice } from "../shared/types.ts";

// Sending a reimbursement notice, and folding Cloudflare's delivery events back
// into a status the Reimbursement tab can render.
//
// The app used to render notices and let the treasurer paste them into their own
// mail client, which meant replies reached a human. Sending directly would throw
// that away, so every message carries a Reply-To that routes back into the
// corrections queue — see `replyAddress` below and inbound.ts for the other end.

export interface MailBindings {
  DB: D1Database;
  EMAIL: SendEmail;
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
  REPLY_DOMAIN?: string;
  MAIL_FALLBACK?: string;
}

const EPS = 0.005;

/**
 * How far along a status is. Queue delivery is unordered and at-least-once, so
 * a `deferred` event can arrive after the `delivered` that superseded it — the
 * consumer only ever moves a message forward through this ranking.
 *
 * Terminal failures outrank `delivered` because a message accepted by the MX and
 * bounced afterwards really did fail. `complained` is highest: it can only follow
 * a delivery, and it's the one outcome that needs a human to look.
 */
const STATUS_RANK: Record<NoticeSendStatus, number> = {
  queued: 0,
  sent: 1,
  deferred: 2,
  delivered: 3,
  failed: 4,
  rejected: 5,
  bounced: 6,
  complained: 7,
};

export const rankStatus = (s: NoticeSendStatus): number => STATUS_RANK[s] ?? 0;

/** Cloudflare event type -> our status. Unknown types are ignored, not guessed. */
export const STATUS_FOR_EVENT: Record<string, NoticeSendStatus> = {
  "cf.email.sending.message.delivered": "delivered",
  "cf.email.sending.message.deferred": "deferred",
  "cf.email.sending.message.bounced": "bounced",
  "cf.email.sending.message.failed": "failed",
  "cf.email.sending.message.rejected": "rejected",
  "cf.email.sending.message.complained": "complained",
};

/**
 * The Reply-To for one notice: `r+<statement token>@<REPLY_DOMAIN>`.
 *
 * Reusing the statement token means a reply is attributable to exactly one
 * (snapshot, person) with no new secret to mint and no subject-line parsing.
 * It leaks nothing further either — the same token is already in the statement
 * URL in the body of the very message this address is attached to.
 */
export const replyAddress = (env: MailBindings, token: string): string | null =>
  env.REPLY_DOMAIN ? `r+${token}@${env.REPLY_DOMAIN}` : null;

/**
 * Pull the `r+<token>` back out of a recipient address.
 *
 * The token's case is significant (it's base64url), so it's matched exactly —
 * a mailer that lowercased the local part would miss here and the reply would
 * take the fallback-forward path in inbound.ts rather than being misattributed.
 */
export function tokenFromReplyAddress(address: string): string | null {
  const local = address.trim().split("@")[0] ?? "";
  const m = /^[Rr]\+([A-Za-z0-9_-]{16,64})$/.exec(local);
  return m ? m[1] : null;
}

/** The `E_*` code the send binding attaches to its errors, when it has one. */
function errorCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "E_UNKNOWN";
}

/** Human-facing explanation for the codes a treasurer can actually act on. */
export function explainSendError(code: string, detail: string): string {
  switch (code) {
    case "E_RECIPIENT_SUPPRESSED":
      return "That address hard-bounced or reported spam previously, so Cloudflare is refusing to send to it. Check the address, then clear it from the suppression list in the Cloudflare dashboard.";
    case "E_SENDER_NOT_VERIFIED":
    case "E_SENDER_DOMAIN_NOT_AVAILABLE":
      return "This app's sending domain isn't onboarded onto Cloudflare Email Sending yet. Nothing can go out until that's done.";
    case "E_VALIDATION_ERROR":
    case "E_FIELD_MISSING":
      return `The message was rejected as malformed: ${detail}`;
    case "E_DAILY_LIMIT_EXCEEDED":
      return "The account's daily sending quota is used up. Try again tomorrow.";
    case "E_RATE_LIMIT_EXCEEDED":
      return "Sending too fast — wait a moment and send again.";
    default:
      return detail || "The mail service rejected the message.";
  }
}

export interface SendOutcome {
  id: number;
  status: NoticeSendStatus;
  error_code: string | null;
  error_detail: string | null;
}

/**
 * Send one prepared notice and record the attempt.
 *
 * The row is written BEFORE the send so an attempt that throws still leaves an
 * audited record — a bounce a treasurer never hears about is the exact failure
 * this feature exists to prevent.
 */
export async function sendNotice(
  env: MailBindings,
  notice: PersonNotice,
  tripId: number,
  sentBy: string,
): Promise<SendOutcome> {
  const to = (notice.person.email ?? "").trim();
  if (!to) throw new Error("no email address on file for that person");
  const from = env.MAIL_FROM;
  if (!from) throw new Error("MAIL_FROM is not configured");
  const replyTo = replyAddress(env, notice.token);

  const inserted = await env.DB.prepare(
    `INSERT INTO notice_sends
       (token, trip_id, person_id, snapshot_id, to_email, reply_to, subject, amount, sent_by, status_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     RETURNING id`,
  )
    .bind(
      notice.token,
      tripId,
      notice.person.id,
      notice.snapshot.id,
      to,
      replyTo ?? from,
      notice.subject,
      notice.net,
      sentBy,
    )
    .first<{ id: number }>();
  if (!inserted) throw new Error("could not record the send");
  const id = inserted.id;

  try {
    const res = await env.EMAIL.send({
      to,
      from: { email: from, name: env.MAIL_FROM_NAME ?? "Troop 10" },
      ...(replyTo ? { replyTo } : {}),
      subject: notice.subject,
      html: notice.html,
      text: notice.body,
    });
    await env.DB.prepare(
      "UPDATE notice_sends SET message_id = ?, status = 'sent', status_at = datetime('now') WHERE id = ?",
    )
      .bind(res.messageId, id)
      .run();
    return { id, status: "sent", error_code: null, error_detail: null };
  } catch (e) {
    const code = errorCode(e);
    const detail = e instanceof Error ? e.message : String(e);
    await env.DB.prepare(
      "UPDATE notice_sends SET status = 'failed', error_code = ?, error_detail = ?, status_at = datetime('now') WHERE id = ?",
    )
      .bind(code, detail.slice(0, 500), id)
      .run();
    return { id, status: "failed", error_code: code, error_detail: explainSendError(code, detail) };
  }
}

/** A notice with no balance either way has nothing to tell anyone. */
export const worthSending = (notice: PersonNotice): boolean => Math.abs(notice.net) > EPS;
