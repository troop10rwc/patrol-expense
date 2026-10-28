import type {
  StatementUnitExpense,
  UnitExpense,
  UnitExpenseFile,
  UnitExpenseNotice,
  UnitExpenseSendSummary,
  UnitExpenseStatus,
} from "../shared/types.ts";
import {
  CLAY, CLAY_DEEP, FAINT, FONT, IN, LINE, PINE_DEEP, SOFT, SURFACE, SURFACE2,
  escapeHtml, fmtWhen, money, wrap,
} from "./notice.ts";

// Unit expenses: non-trip reimbursements. One member fronted something for the
// troop; the troop pays them back. No shares, no cost groups, no snapshots —
// the amount on the receipt IS the amount owed, so there's nothing to freeze.
//
// The trust posture matches the rest of the app: `pending` (how a Slack
// submission lands) is inert and counts toward nothing. Only a signed-in
// leader's approval — or a leader adding one directly — makes it money.

/** The full row, as stored. */
export type UnitExpenseRow = Omit<UnitExpense, "files" | "lastSend"> & {
  payee_slack_id: string | null;
  slack_user_id: string | null;
  slack_team_id: string | null;
  slack_channel_id: string | null;
  slack_message_ts: string | null;
};

const EPS = 0.005;

/** Every unit expense, open work first (pending, then owed), newest within each. */
export async function listUnitExpenses(db: D1Database): Promise<UnitExpense[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM unit_expenses
        ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 WHEN 'paid' THEN 2 ELSE 3 END,
                 id DESC`,
    )
    .all<UnitExpenseRow>();
  const rows = results ?? [];
  if (rows.length === 0) return [];

  // Files and the latest send, each in one query and grouped in memory — the
  // page renders as a list, so per-row lookups would be N round trips.
  const { results: files } = await db
    .prepare("SELECT id, unit_expense_id, filename, content_type, size FROM unit_expense_files ORDER BY id")
    .all<UnitExpenseFile>();
  const filesBy = new Map<number, UnitExpenseFile[]>();
  for (const f of files ?? []) {
    const list = filesBy.get(f.unit_expense_id) ?? [];
    list.push(f);
    filesBy.set(f.unit_expense_id, list);
  }

  const { results: sends } = await db
    .prepare(
      `SELECT s.unit_expense_id, s.kind, s.status, s.to_email, s.sent_at, s.error_detail,
              (SELECT COUNT(*) FROM unit_expense_sends WHERE unit_expense_id = s.unit_expense_id) AS count
         FROM unit_expense_sends s
        WHERE s.id = (SELECT MAX(id) FROM unit_expense_sends WHERE unit_expense_id = s.unit_expense_id)`,
    )
    .all<UnitExpenseSendSummary & { unit_expense_id: number }>();
  const sendBy = new Map<number, UnitExpenseSendSummary>();
  for (const { unit_expense_id, ...s } of sends ?? []) sendBy.set(unit_expense_id, s);

  return rows.map((r) => ({
    id: r.id,
    payee_email: r.payee_email,
    payee_name: r.payee_name,
    description: r.description,
    amount: r.amount,
    spent_on: r.spent_on,
    status: r.status,
    source: r.source,
    created_by: r.created_by,
    created_at: r.created_at,
    slack_user_name: r.slack_user_name,
    slack_permalink: r.slack_permalink,
    reviewed_by: r.reviewed_by,
    reviewed_at: r.reviewed_at,
    review_note: r.review_note,
    paid_by: r.paid_by,
    paid_at: r.paid_at,
    paid_note: r.paid_note,
    files: filesBy.get(r.id) ?? [],
    lastSend: sendBy.get(r.id) ?? null,
  }));
}

export async function getUnitExpense(db: D1Database, id: number): Promise<UnitExpenseRow | null> {
  return db.prepare("SELECT * FROM unit_expenses WHERE id = ?").bind(id).first<UnitExpenseRow>();
}

/**
 * One member's unit expenses for their statement, plus what's still owed.
 *
 * Matched by email, the same key the trip statement uses. Only `approved`
 * counts toward the outstanding figure: `pending` hasn't been agreed to yet,
 * and `paid` / `rejected` are settled one way or the other.
 */
export async function unitStatement(
  db: D1Database,
  email: string | null,
): Promise<{ items: StatementUnitExpense[]; outstanding: number }> {
  if (!email) return { items: [], outstanding: 0 };
  const { results } = await db
    .prepare(
      `SELECT id, description, amount, spent_on, status, created_at, paid_at, paid_note, review_note
         FROM unit_expenses
        WHERE payee_email IS NOT NULL AND lower(payee_email) = lower(?)
        ORDER BY id DESC
        LIMIT 100`,
    )
    .bind(email)
    .all<StatementUnitExpense>();
  const items = results ?? [];
  const outstanding = items
    .filter((i) => i.status === "approved")
    .reduce((s, i) => s + i.amount, 0);
  return { items, outstanding: Math.round(outstanding * 100) / 100 };
}

// ------------------------------------------------------------------- email

/** Which email a unit expense in this state warrants, if any. */
export function noticeKindFor(status: UnitExpenseStatus): "approved" | "paid" | null {
  return status === "approved" ? "approved" : status === "paid" ? "paid" : null;
}

/**
 * The email telling a payee where their reimbursement stands.
 *
 * Two variants, keyed off status: "approved" (the troop owes you $X, and here's
 * your running total across everything) and "paid" (it's on its way). Same
 * mail-client-safe construction as the trip notice in notice.ts: table layout,
 * inline styles, a plain-text twin. It links to My statement — the payee is a
 * member, so a signed-in page is the right place for the full picture.
 */
export function buildUnitNotice(
  row: UnitExpenseRow,
  statementUrl: string,
  totalOwed: number,
): UnitExpenseNotice | null {
  const kind = noticeKindFor(row.status);
  if (!kind) return null;

  const firstName = row.payee_name.split(/\s+/)[0] || row.payee_name;
  const paid = kind === "paid";
  const subject = paid
    ? `Reimbursed: ${row.description} (${money(row.amount)})`
    : `Approved: ${money(row.amount)} reimbursement for ${row.description}`;
  const headline = paid ? "We've paid you back" : "The troop owes you";
  const lead = paid
    ? `Your reimbursement for <strong>${escapeHtml(row.description)}</strong> has been paid${
        row.paid_note ? ` (${escapeHtml(row.paid_note)})` : ""
      }.`
    : `Your receipt for <strong>${escapeHtml(row.description)}</strong> has been approved. The troop will send your reimbursement — just reply if you'd prefer a particular method.`;
  // Other approved-but-unpaid unit expenses, so a member with three receipts in
  // flight isn't left adding them up.
  const others = Math.round((totalOwed - (paid ? 0 : row.amount)) * 100) / 100;

  const cell = `padding:7px 0;font-size:14px;color:${SOFT};border-bottom:1px solid ${LINE};`;
  const rows: { label: string; value: string }[] = [
    { label: "What for", value: row.description },
    ...(row.spent_on ? [{ label: "Spent on", value: row.spent_on }] : []),
    { label: "Amount", value: money(row.amount) },
    ...(paid && row.paid_at ? [{ label: "Paid", value: fmtWhen(row.paid_at) }] : []),
    ...(others > EPS ? [{ label: "Other unit expenses still owed to you", value: money(others) }] : []),
  ];
  const table = rows
    .map(
      (r) => `<tr>
            <td style="${cell}">${escapeHtml(r.label)}</td>
            <td style="${cell}text-align:right;color:${IN};">${escapeHtml(r.value)}</td>
          </tr>`,
    )
    .join("");

  const html = `<div style="margin:0;padding:0;background:${SURFACE};">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${SURFACE};">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;font-family:${FONT};color:${IN};">

        <tr><td style="padding-bottom:18px;">
          <div style="font-size:18px;font-weight:700;color:${IN};">Unit expense</div>
          <div style="font-size:13px;color:${SOFT};padding-top:2px;">Reimbursement for ${escapeHtml(row.payee_name)}</div>
        </td></tr>

        <tr><td style="padding-bottom:20px;font-size:15px;line-height:1.55;color:${IN};">Hi ${escapeHtml(firstName)},</td></tr>

        <tr><td style="padding-bottom:20px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${SURFACE2};border:1px solid ${LINE};border-radius:8px;">
            <tr><td align="center" style="padding:20px 16px;">
              <div style="font-size:13px;color:${SOFT};">${headline}</div>
              <div style="font-size:32px;font-weight:700;letter-spacing:-.02em;color:${PINE_DEEP};padding-top:4px;">${money(row.amount)}</div>
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding-bottom:12px;font-size:14px;line-height:1.55;color:${IN};">${lead}</td></tr>

        <tr><td style="padding-bottom:20px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${table}</table>
        </td></tr>

        <tr><td style="padding-bottom:22px;">
          <a href="${escapeHtml(statementUrl)}" style="display:inline-block;background:${CLAY};color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:11px 20px;border-radius:6px;">See my statement &rarr;</a>
          <div style="font-size:12px;color:${FAINT};padding-top:8px;">Everything the troop owes you, trips and unit expenses together.</div>
        </td></tr>

        <tr><td style="padding:0 0 22px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};padding-bottom:6px;">Something wrong?</div>
          <div style="font-size:14px;line-height:1.55;color:${IN};">Just <strong>reply to this email</strong> — it goes straight to the treasurer.</div>
        </td></tr>

      </table>
    </td></tr>
  </table>
</div>`;

  const out: string[] = [];
  out.push(`Hi ${firstName},`, "");
  out.push(`${headline.toUpperCase()} ${money(row.amount)}`, "");
  out.push(
    wrap(
      paid
        ? `Your reimbursement for ${row.description} has been paid${row.paid_note ? ` (${row.paid_note})` : ""}.`
        : `Your receipt for ${row.description} has been approved. The troop will send your reimbursement - just reply if you'd prefer a particular method.`,
    ),
    "",
  );
  for (const r of rows) out.push(`  ${r.label}: ${r.value}`);
  out.push("", "SEE MY STATEMENT", statementUrl, "");
  out.push("SOMETHING WRONG?", wrap("Just reply to this email - it goes straight to the treasurer."));

  return { kind, to: row.payee_email, subject, html, body: out.join("\n") };
}
