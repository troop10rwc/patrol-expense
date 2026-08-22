import type {
  Correction,
  NoticePaidLine,
  NoticeShareLine,
  PersonNotice,
  PublicStatement,
  TripBundle,
} from "../shared/types.ts";
import { buildStatement } from "./statement.ts";

// Reimbursement notices: one person's "here's what you owe (or we owe you), and
// here's exactly why" for one event.
//
// Everything below reads from a snapshot's frozen bundle, never from live
// tables. That's the whole point of the feature: the email quotes a number, so
// the breakdown behind that number has to stay readable and unchanged after the
// fact — even if receipts are added, patrols re-split, or people removed the
// next day. The only live figures anywhere are the other-event balances on the
// shared page, which are explicitly labelled as current rather than frozen.

const EPS = 0.005;
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function money(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : ""}$${abs}`;
}

/** SQLite's `datetime('now')` is UTC "YYYY-MM-DD HH:MM:SS"; show troop-local. */
export function fmtWhen(sqliteUtc: string): string {
  const d = new Date(sqliteUtc.replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return sqliteUtc;
  return d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Greedy wrap so plain-text email bodies don't arrive as one endless line. */
function wrap(text: string, width = 76): string {
  return text
    .split("\n")
    .map((para) => {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) return "";
      const lines: string[] = [];
      let line = words[0];
      for (const w of words.slice(1)) {
        if (line.length + 1 + w.length > width) { lines.push(line); line = w; }
        else line += ` ${w}`;
      }
      lines.push(line);
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * Assemble one person's breakdown from a frozen bundle.
 *
 * The share lines are the heart of it: for every cost group this person was
 * billed in, show the group's own total, how many ways it split, and how many
 * of those shares are theirs (themselves plus any youth they're responsible
 * for). That's the arithmetic that produced "owed", spelled out — a member
 * disputing their number can check each step without a spreadsheet.
 */
export function buildNotice(
  bundle: TripBundle,
  snapshot: { id: number; label: string | null; created_at: string },
  personId: number,
  token: string,
  url: string,
): PersonNotice | null {
  const person = bundle.people.find((p) => p.id === personId);
  const row = bundle.paysheet.rows.find((r) => r.person_id === personId);
  if (!person || !row) return null;

  const nameOf = (id: number) => bundle.people.find((p) => p.id === id)?.name ?? `#${id}`;
  const groupName = (id: number) => bundle.groups.find((g) => g.id === id)?.name ?? `#${id}`;

  const shareLines: NoticeShareLine[] = [];
  for (const s of bundle.groupSummaries) {
    const mine = s.shares.find((sh) => sh.person_id === personId);
    if (!mine || mine.share_count === 0) continue;
    // Which attendees those shares actually pay for: this adult, plus the youth
    // whose share is attributed to them.
    const covers = s.memberIds
      .map((id) => bundle.people.find((p) => p.id === id))
      .filter((p): p is NonNullable<typeof p> => !!p && (p.id === personId || p.parent_id === personId))
      .map((p) => p.name);
    shareLines.push({
      group_id: s.group.id,
      groupName: s.group.name,
      kind: s.group.kind,
      groupTotal: round2(s.total),
      totalShares: s.totalShares,
      perShare: round2(s.perShare),
      shareCount: mine.share_count,
      subtotal: round2(mine.share_count * s.perShare),
      covers,
      expenses: bundle.expenses
        .filter((e) => e.group_id === s.group.id)
        .map((e) => ({ description: e.description, amount: round2(e.amount), payer: nameOf(e.payer_id) })),
    });
  }
  shareLines.sort((a, b) => b.subtotal - a.subtotal);

  const paidLines: NoticePaidLine[] = bundle.expenses
    .filter((e) => e.payer_id === personId)
    .map((e) => ({
      description: e.description,
      amount: round2(e.amount),
      groupName: groupName(e.group_id),
      reimbursed: e.reimbursed_at != null,
    }));

  const prepayLines = bundle.prepayments
    .filter((p) => p.person_id === personId)
    .map((p) => ({ note: p.note, amount: round2(p.amount) }));

  const notice: PersonNotice = {
    trip: {
      uuid: bundle.trip.uuid,
      slug: bundle.trip.slug,
      name: bundle.trip.name,
      trip_date: bundle.trip.trip_date,
    },
    snapshot,
    person: { id: person.id, name: person.name, email: person.email },
    shareLines,
    paidLines,
    prepayLines,
    tripTotal: round2(bundle.paysheet.totalExpenses),
    paid: round2(row.paid),
    owed: round2(row.owed),
    prepay: round2(row.prepay),
    reimbursed: round2(row.reimbursed ?? 0),
    net: round2(row.outstanding),
    status: row.status,
    paymentInstructions: bundle.trip.payment_instructions?.trim() || null,
    token,
    url,
    subject: "",
    html: "",
    body: "",
  };
  notice.subject = renderSubject(notice);
  notice.html = renderHtml(notice);
  notice.body = renderBody(notice);
  return notice;
}

function tripLabel(n: PersonNotice): string {
  return n.trip.trip_date ? `${n.trip.name} (${n.trip.trip_date})` : n.trip.name;
}

export function renderSubject(n: PersonNotice): string {
  if (n.net < -EPS) return `${n.trip.name} - ${money(-n.net)} due`;
  if (n.net > EPS) return `${n.trip.name} - ${money(n.net)} reimbursement`;
  return `${n.trip.name} - expense summary`;
}

/**
 * The one-line summary of what this person's share covers, e.g.
 * "Unit:Overall and Patrol:Patrol1". The arithmetic behind it lives on the
 * statement page — the email only has to say which pots the money came from.
 */
function coversPhrase(n: PersonNotice): string {
  const names = n.shareLines.map((l) => l.groupName);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Which way the money goes, in words. The amount is rendered separately so
 *  the HTML can set it in its own type size. */
function headlineLabel(n: PersonNotice): string {
  if (n.net < -EPS) return "You owe the troop";
  if (n.net > EPS) return "The troop owes you";
  return "You're all settled";
}

/** The figures worth putting in the email itself; everything else is a click away. */
function summaryRows(n: PersonNotice): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (n.paid) rows.push({ label: "Receipts you paid", value: money(n.paid) });
  if (n.owed) rows.push({ label: "Your share of trip costs", value: `-${money(n.owed)}` });
  if (n.reimbursed) rows.push({ label: "Receipts already paid back to you", value: `-${money(n.reimbursed)}` });
  if (n.prepay) rows.push({ label: "Already reimbursed to you", value: `-${money(n.prepay)}` });
  return rows;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Troop palette, inlined. Email clients strip <style> blocks and know nothing
// about CSS variables, so every colour is a literal on the element that uses it.
const IN = "#1b2118";      // ink
const SOFT = "#545b49";    // ink-soft
const FAINT = "#878d77";   // ink-faint
const SURFACE = "#faf8f1";
const SURFACE2 = "#f2ede0";
const LINE = "#d7cfba";
const CLAY = "#bf4329";
const CLAY_DEEP = "#9c3520";
const PINE_DEEP = "#1d3d27";
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

/**
 * Render the HTML email — what the recipient actually sees.
 *
 * Deliberately high level: the headline amount, the few figures behind it, and
 * a button to the statement page. Every receipt and per-group split lives
 * behind that link, so the email stays skimmable on a phone and the detail
 * stays somewhere it can't be forwarded out of context.
 *
 * Built for mail clients, not browsers: table layout, inline styles only, no
 * flexbox/grid/classes/webfonts. It reaches the recipient by being pasted into
 * the treasurer's own mail client (mailto: can only carry plain text), so it
 * must survive a rich-text paste.
 */
export function renderHtml(n: PersonNotice): string {
  const firstName = escapeHtml(n.person.name.split(/\s+/)[0] || n.person.name);
  const owes = n.net < -EPS;
  const owed = n.net > EPS;
  const amountColor = owes ? CLAY_DEEP : owed ? PINE_DEEP : SOFT;
  const covers = coversPhrase(n);

  const cell = `padding:7px 0;font-size:14px;color:${SOFT};border-bottom:1px solid ${LINE};`;
  const rows = summaryRows(n)
    .map(
      (r) => `<tr>
            <td style="${cell}">${escapeHtml(r.label)}</td>
            <td style="${cell}text-align:right;white-space:nowrap;color:${IN};">${r.value}</td>
          </tr>`,
    )
    .join("");

  const netRow = `<tr>
            <td style="padding:9px 0;font-size:14px;font-weight:700;color:${IN};">${owes ? "You owe" : owed ? "Owed to you" : "Settled"}</td>
            <td style="padding:9px 0;font-size:14px;font-weight:700;text-align:right;white-space:nowrap;color:${amountColor};">${money(Math.abs(n.net))}</td>
          </tr>`;

  // How they settle up. Only the direction that needs an instruction gets one.
  const payBlock = owes
    ? `<tr><td style="padding:0 0 22px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};padding-bottom:6px;">How to pay</div>
          <div style="font-size:14px;line-height:1.55;color:${IN};white-space:pre-wrap;">${
            n.paymentInstructions
              ? escapeHtml(n.paymentInstructions)
              : "Reply to this email and we'll send you payment details."
          }</div>
        </td></tr>`
    : owed
      ? `<tr><td style="padding:0 0 22px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};padding-bottom:6px;">Getting you paid</div>
          <div style="font-size:14px;line-height:1.55;color:${IN};">The troop will send your reimbursement — just reply if you'd prefer a particular method.</div>
        </td></tr>`
      : "";

  return `<div style="margin:0;padding:0;background:${SURFACE};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${SURFACE};">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;font-family:${FONT};color:${IN};">

        <tr><td style="padding-bottom:18px;">
          <div style="font-size:18px;font-weight:700;color:${IN};">${escapeHtml(n.trip.name)}</div>
          <div style="font-size:13px;color:${SOFT};padding-top:2px;">Expense summary for ${escapeHtml(n.person.name)}${
            n.trip.trip_date ? ` &middot; ${escapeHtml(n.trip.trip_date)}` : ""
          }</div>
        </td></tr>

        <tr><td style="padding-bottom:20px;font-size:15px;line-height:1.55;color:${IN};">Hi ${firstName},</td></tr>

        <tr><td style="padding-bottom:20px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${SURFACE2};border:1px solid ${LINE};border-radius:8px;">
            <tr><td align="center" style="padding:20px 16px;">
              <div style="font-size:13px;color:${SOFT};">${escapeHtml(headlineLabel(n))}</div>
              <div style="font-size:32px;font-weight:700;letter-spacing:-.02em;color:${amountColor};padding-top:4px;">${money(Math.abs(n.net))}</div>
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding-bottom:8px;font-size:14px;line-height:1.55;color:${IN};">
          ${
            covers
              ? `Your share covers <strong>${escapeHtml(covers)}</strong>. Here's how that nets out:`
              : "Here's how that nets out:"
          }
        </td></tr>

        <tr><td style="padding-bottom:20px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${rows}${netRow}</table>
          <div style="font-size:12px;color:${FAINT};padding-top:8px;">Figures frozen from the summary taken ${escapeHtml(
            fmtWhen(n.snapshot.created_at),
          )}${n.snapshot.label ? ` (${escapeHtml(n.snapshot.label)})` : ""}.</div>
        </td></tr>

        <tr><td style="padding-bottom:22px;">
          <a href="${escapeHtml(n.url)}" style="display:inline-block;background:${CLAY};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:11px 20px;border-radius:6px;">See every receipt &rarr;</a>
          <div style="font-size:12px;color:${FAINT};padding-top:8px;">Every receipt behind these numbers, no sign-in needed.</div>
        </td></tr>

        ${payBlock}

        <tr><td style="padding:0 0 22px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};padding-bottom:6px;">Something wrong?</div>
          <div style="font-size:14px;line-height:1.55;color:${IN};">
            Just <strong>reply to this email</strong> (a photo of the receipt helps), or
            <a href="${escapeHtml(n.url)}#report" style="color:${CLAY_DEEP};">report it here</a>.
            Both reach the same person.
          </div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</div>`;
}

/**
 * Plain-text twin of the HTML above — same content, same order.
 *
 * Not a legacy fallback: it's what the mailto: draft carries (mailto can only
 * hold plain text), and it's the text/plain half of the rich clipboard copy, so
 * a recipient whose client refuses HTML still gets the whole message.
 */
export function renderBody(n: PersonNotice): string {
  const firstName = n.person.name.split(/\s+/)[0] || n.person.name;
  const out: string[] = [];

  out.push(`Hi ${firstName},`);
  out.push("");
  out.push(wrap(`Your expense summary for ${tripLabel(n)}.`));
  out.push("");
  out.push(
    Math.abs(n.net) < EPS
      ? "YOU'RE ALL SETTLED - nothing due either way."
      : `${headlineLabel(n).toUpperCase()} ${money(Math.abs(n.net))}`,
  );
  out.push("");

  const covers = coversPhrase(n);
  if (covers) out.push(wrap(`Your share covers ${covers}. Here's how that nets out:`));
  for (const r of summaryRows(n)) out.push(`  ${r.label}: ${r.value}`);
  out.push(`  ${n.net < -EPS ? "You owe" : n.net > EPS ? "Owed to you" : "Settled"}: ${money(Math.abs(n.net))}`);
  out.push("");
  out.push(
    wrap(
      `Figures frozen from the summary taken ${fmtWhen(n.snapshot.created_at)}` +
        `${n.snapshot.label ? ` (${n.snapshot.label})` : ""}.`,
    ),
  );
  out.push("");
  out.push("SEE EVERY RECEIPT (no sign-in needed)");
  out.push(n.url);
  out.push("");

  if (n.net < -EPS) {
    out.push("HOW TO PAY");
    out.push(
      n.paymentInstructions
        ? wrap(n.paymentInstructions)
        : wrap("Reply to this email and we'll send you payment details."),
    );
    out.push("");
  } else if (n.net > EPS) {
    out.push("GETTING YOU PAID");
    out.push(wrap("The troop will send your reimbursement - just reply if you'd prefer a particular method."));
    out.push("");
  }

  out.push("SOMETHING WRONG?");
  out.push(
    wrap(
      "Just reply to this email (a photo of the receipt helps), or report it here: " +
        `${n.url}#report`,
    ),
  );

  return out.join("\n");
}

/**
 * The no-sign-in statement behind a link: this event's frozen notice, plus the
 * member's live balance on OTHER events so the page can answer "what do I owe
 * in total?" — the one question the single-event email can't.
 *
 * Cross-event figures are matched the same way the signed-in /me statement
 * matches (roster email -> bsa_number), so a link only ever widens to trips
 * that are provably the same member. A link with no email on the person row
 * stays scoped to its own event.
 */
export async function buildPublicStatement(
  db: D1Database,
  roster: D1Database,
  notice: PersonNotice,
  personEmail: string | null,
  corrections: Pick<Correction, "kind" | "message" | "created_at" | "status">[],
): Promise<PublicStatement> {
  const otherEvents: PublicStatement["otherEvents"] = [];
  if (personEmail) {
    try {
      const stmt = await buildStatement(db, roster, { email: personEmail, name: notice.person.name });
      for (const ev of stmt.events) {
        if (ev.trip.uuid === notice.trip.uuid) continue;
        if (Math.abs(ev.outstanding) < EPS) continue;
        otherEvents.push({ name: ev.trip.name, trip_date: ev.trip.trip_date, outstanding: ev.outstanding });
      }
    } catch {
      // Cross-event context is a bonus; never fail the page over it.
    }
  }

  return {
    notice,
    otherEvents,
    grandTotal: round2(notice.net + otherEvents.reduce((s, e) => s + e.outstanding, 0)),
    reported: corrections.map((c) => ({
      kind: c.kind,
      message: c.message,
      created_at: c.created_at,
      status: c.status,
    })),
  };
}

/** URL-safe bearer token for a statement link (~144 bits of entropy). */
export function newLinkToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
