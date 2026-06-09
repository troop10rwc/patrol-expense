// Pure (DB-free) logic for the Google Sheet import: parse the sheet's four
// side-by-side blocks, resolve people against the roster, reconstruct
// receipts + attendance from the owed amounts, and flag whatever doesn't
// reconcile. The DB I/O lives in index.ts; everything here is unit-testable.

import { round2 } from "./engine.ts";
import { parseCurrency } from "./csv.ts";
import type {
  RosterMember,
  PersonType,
  GroupKind,
  ImportPreview,
  ImportPerson,
  ImportPersonResolution,
  ImportExpenseGroup,
  ImportPrepayment,
  ImportSummaryRow,
  ImportFlag,
} from "../shared/types.ts";

const EPS = 0.005; // cent tolerance, matching the engine/diff convention
const last4 = (bsa: string) => bsa.slice(-4);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const cell = (r: string[], i: number) => (r[i] ?? "").trim();

/** "Jane Doe (1234)" -> { displayName: "Jane Doe", code: "1234" }. */
function parsePersonCell(raw: string): { displayName: string; code: string | null } {
  const m = raw.match(/^(.*?)\s*\((\d{3,4})\)\s*$/);
  return m ? { displayName: m[1].trim(), code: m[2] } : { displayName: raw.trim(), code: null };
}

function groupKindFromName(name: string): GroupKind {
  const n = name.toLowerCase();
  if (n.startsWith("travel")) return "travel";
  if (n.startsWith("patrol")) return "patrol";
  return "unit";
}

interface BlockCols {
  prePerson: number; preAmount: number;
  expGroup: number; expPerson: number; expAmount: number;
  sumPerson: number; sumAmount: number;
}

/** Find the header row ("…Expenses…") and derive each block's column offsets. */
function findHeader(rows: string[][]): { idx: number; cols: BlockCols } | null {
  for (let i = 0; i < rows.length; i++) {
    const expGroup = rows[i].findIndex((c) => c.trim().toLowerCase() === "expenses");
    if (expGroup < 0) continue;
    const pre = rows[i].findIndex((c) => c.trim().toLowerCase() === "pre-reimbursed");
    const prePerson = pre >= 0 ? pre : 1;
    return {
      idx: i,
      cols: {
        prePerson, preAmount: prePerson + 1,
        expGroup, expPerson: expGroup + 1, expAmount: expGroup + 2,
        sumPerson: expGroup + 3, sumAmount: expGroup + 4,
      },
    };
  }
  return null;
}

function parseMeta(rows: string[][]): { name: string; trip_date: string | null; planning_doc_url: string | null } {
  let name = "", date: string | null = null, doc: string | null = null;
  for (const r of rows) {
    const label = cell(r, 1).toLowerCase();
    const val = cell(r, 2);
    if (label === "trip name") name = val;
    else if (label === "date") date = val || null;
    else if (label === "trip planning doc") doc = val || null;
  }
  return { name, trip_date: date, planning_doc_url: doc };
}

interface RawExpense { group: string; rawName: string; owed: number | null }
interface RawPrepay { rawName: string; amount: number | null }
interface RawSummary { rawName: string; rawValue: string }

function parseBlocks(rows: string[][], idx: number, cols: BlockCols) {
  const prepay: RawPrepay[] = [];
  const expenses: RawExpense[] = [];
  const summary: RawSummary[] = [];
  for (let i = idx + 1; i < rows.length; i++) {
    const r = rows[i];
    const pre = cell(r, cols.prePerson);
    if (pre) prepay.push({ rawName: pre, amount: parseCurrency(cell(r, cols.preAmount)) });
    const grp = cell(r, cols.expGroup);
    const expPerson = cell(r, cols.expPerson);
    if (grp && expPerson) expenses.push({ group: grp, rawName: expPerson, owed: parseCurrency(cell(r, cols.expAmount)) });
    const sumPerson = cell(r, cols.sumPerson);
    if (sumPerson) summary.push({ rawName: sumPerson, rawValue: cell(r, cols.sumAmount) });
  }
  return { prepay, expenses, summary };
}

function resolveOne(displayName: string, code: string | null, roster: RosterMember[]): {
  resolution: ImportPersonResolution; type: PersonType; rosterCandidates?: { bsa_number: string; name: string }[];
} {
  if (!code) return { resolution: { kind: "guest" }, type: "adult" };
  const candidates = roster.filter((m) => last4(m.bsa_number) === code);
  if (candidates.length === 0) return { resolution: { kind: "guest" }, type: "adult" };
  const exact = candidates.find((m) => norm(m.name) === norm(displayName));
  const pick = exact ?? (candidates.length === 1 ? candidates[0] : null);
  if (pick) return { resolution: { kind: "roster", bsa_number: pick.bsa_number }, type: pick.type };
  return {
    resolution: { kind: "guest" },
    type: "adult",
    rosterCandidates: candidates.map((m) => ({ bsa_number: m.bsa_number, name: m.name })),
  };
}

/** Build the deduped people registry + a raw-name -> ref lookup. */
function buildPeople(rawNames: string[], roster: RosterMember[]) {
  const byKey = new Map<string, ImportPerson>();
  const rawToRef = new Map<string, string>();
  let n = 0;
  for (const rawName of rawNames) {
    const { displayName, code } = parsePersonCell(rawName);
    const key = code ? `c:${code}` : `n:${norm(displayName)}`;
    let person = byKey.get(key);
    if (!person) {
      const resolved = resolveOne(displayName, code, roster);
      person = {
        ref: `p${n++}`, rawName, displayName, code, type: resolved.type,
        resolution: resolved.resolution,
        ...(resolved.rosterCandidates ? { rosterCandidates: resolved.rosterCandidates } : {}),
      };
      byKey.set(key, person);
    }
    rawToRef.set(rawName, person.ref);
  }
  return { people: [...byKey.values()], refOf: (rn: string) => rawToRef.get(rn)! };
}

/** Infer the payer of a group receipt from the prepayments (only a confident match). */
function inferPayer(total: number, prepayments: ImportPrepayment[]): string | null {
  const near = prepayments.filter((p) => Math.abs(p.amount - total) < EPS);
  return near.length === 1 ? near[0].personRef : null;
}

/**
 * Turn the parsed CSV rows into an ImportPreview: trip meta, people, groups
 * (with reconstructed receipts), prepayments, summary cross-check, and flags.
 * Throws if the sheet layout can't be recognized.
 */
export function buildPreview(
  rows: string[][],
  roster: RosterMember[],
  sheetUrl: string,
  sheetId: string,
  rosterUnits: string[],
): ImportPreview {
  const header = findHeader(rows);
  if (!header) throw new Error("could not find the 'Expenses' header — is this the expense-report layout?");
  const meta = parseMeta(rows);
  const { prepay, expenses, summary } = parseBlocks(rows, header.idx, header.cols);

  const { people, refOf } = buildPeople(
    [...prepay.map((p) => p.rawName), ...expenses.map((e) => e.rawName), ...summary.map((s) => s.rawName)],
    roster,
  );

  const flags: ImportFlag[] = [];

  // People-level flags.
  for (const p of people) {
    if (p.rosterCandidates) {
      flags.push({ kind: "ambiguous_person", severity: "warning", personRef: p.ref,
        message: `${p.displayName}: ${p.rosterCandidates.length} roster members share BSA …${p.code} — pick one or keep as a guest.` });
    } else if (p.resolution.kind === "guest") {
      flags.push({ kind: "unmatched_person", severity: "info", personRef: p.ref,
        message: `${p.displayName} isn't in the roster — importing as a local guest.` });
    }
  }

  // Prepayments.
  const prepayments: ImportPrepayment[] = prepay.map((p) => ({
    personRef: refOf(p.rawName), amount: round2(p.amount ?? 0), note: "Pre-Reimbursed (imported)",
  }));

  // Reconstruct groups (owed-space -> members + one receipt per group).
  const groupNames: string[] = [];
  const byGroup = new Map<string, RawExpense[]>();
  for (const e of expenses) {
    if (!byGroup.has(e.group)) { byGroup.set(e.group, []); groupNames.push(e.group); }
    byGroup.get(e.group)!.push(e);
  }

  const groups: ImportExpenseGroup[] = groupNames.map((name) => {
    const items = byGroup.get(name)!;
    const lineItems = items.map((e) => ({ personRef: refOf(e.rawName), owed: round2(e.owed ?? 0) }));
    const total = round2(lineItems.reduce((s, li) => s + li.owed, 0));

    if (items.some((e) => e.owed == null)) {
      flags.push({ kind: "group_unreconciled", severity: "warning", groupName: name,
        message: `${name}: a line item amount couldn't be read — verify the receipt total.` });
    }

    // Recover implied shares from the smallest positive owed (= one share).
    const positives = lineItems.map((li) => li.owed).filter((v) => v > 0);
    const perShare = positives.length ? Math.min(...positives) : 0;
    if (perShare > 0) {
      for (const li of lineItems) {
        if (li.owed <= 0) continue;
        const ratio = li.owed / perShare;
        const shares = Math.round(ratio);
        if (Math.abs(ratio - shares) > 0.02) {
          flags.push({ kind: "group_unreconciled", severity: "warning", groupName: name, personRef: li.personRef,
            message: `${name}: ${money(li.owed)} for ${nameOf(people, li.personRef)} doesn't divide evenly into shares of ${money(perShare)}.` });
        } else if (shares > 1) {
          flags.push({ kind: "uneven_shares", severity: "info", groupName: name, personRef: li.personRef,
            message: `${nameOf(people, li.personRef)} owes ${shares}× the base share in ${name} — add their ${shares - 1} dependent(s) to attendance after import.` });
        }
      }
    }

    const payerRef = inferPayer(total, prepayments);
    if (!payerRef) {
      flags.push({ kind: "payer_unknown", severity: "blocking", groupName: name,
        message: `${name}: the sheet doesn't say who paid the ${money(total)} — choose a payer before importing.` });
    }

    return {
      name, kind: groupKindFromName(name), lineItems, total,
      receipt: { description: `Imported: ${name}`, amount: total, payerRef },
    };
  });

  // Summary cross-check (the missed-formula detector).
  const owedByRef = new Map<string, number>();
  for (const g of groups) for (const li of g.lineItems) owedByRef.set(li.personRef, (owedByRef.get(li.personRef) ?? 0) + li.owed);

  const summaryRows: ImportSummaryRow[] = summary.map((s) => {
    const ref = refOf(s.rawName);
    const parsedValue = parseCurrency(s.rawValue);
    const recomputed = round2(owedByRef.get(ref) ?? 0);
    if (parsedValue == null) {
      flags.push({ kind: "broken_formula", severity: "warning", personRef: ref, rawValue: s.rawValue, expected: recomputed,
        message: `${nameOf(people, ref)}: "${s.rawValue}" isn't a dollar amount — a formula was likely missed (should be ${money(recomputed)}).` });
    } else if (Math.abs(round2(parsedValue) - recomputed) > EPS) {
      flags.push({ kind: "summary_mismatch", severity: "warning", personRef: ref, found: parsedValue, expected: recomputed,
        message: `${nameOf(people, ref)}: sheet total ${money(parsedValue)} ≠ sum of line items ${money(recomputed)}.` });
    }
    return { personRef: ref, rawValue: s.rawValue, parsedValue, recomputed };
  });

  return {
    sheetId, sheetUrl,
    trip: {
      name: meta.name || "Imported trip",
      trip_date: meta.trip_date,
      planning_doc_url: meta.planning_doc_url,
      rosterUnits,
      mileage_rate: 0.28,
    },
    people, groups, prepayments, summary: summaryRows, flags,
  };
}

function nameOf(people: ImportPerson[], ref: string): string {
  return people.find((p) => p.ref === ref)?.displayName ?? ref;
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}
