// Pure (DB-free) logic for the Google Sheet import. The workbook's per-area
// tabs (UnitOverall, PatrolPatrolN, Travel*) hold the real source data —
// receipts with payer, attendance, and travel routes — which map straight onto
// the app's model. The Summary tab gives the trip meta + pre-reimbursements, and
// (via the formatted CSV) a per-person "Total Owed" column we cross-check to
// flag missed-formula errors. DB I/O lives in index.ts; this is unit-testable.

import { round2 } from "./engine.ts";
import { parseCurrency } from "./csv.ts";
import type {
  RosterMember,
  PersonType,
  ImportPreview,
  ImportPerson,
  ImportPersonResolution,
  ImportExpenseGroup,
  ImportTravelGroup,
  ImportReceipt,
  ImportPrepayment,
  ImportSummaryRow,
  ImportFlag,
} from "../shared/types.ts";

const EPS = 0.005;
const last4 = (bsa: string) => bsa.slice(-4);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const cell = (r: string[] | undefined, i: number) => (r?.[i] ?? "").trim();
const num = (s: string): number | null => {
  const n = Number((s ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && s.trim() !== "" ? n : null;
};

function parsePersonCell(raw: string): { displayName: string; code: string | null } {
  const m = raw.match(/^(.*?)\s*\((\d{3,4})\)\s*$/);
  return m ? { displayName: m[1].trim(), code: m[2] } : { displayName: raw.trim(), code: null };
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

/** Deduped people registry that resolves names to roster members on first sight. */
function makeRegistry(roster: RosterMember[]) {
  const byKey = new Map<string, ImportPerson>();
  let n = 0;
  function getRef(rawName: string): string {
    const { displayName, code } = parsePersonCell(rawName);
    const key = code ? `c:${code}` : `n:${norm(displayName)}`;
    let p = byKey.get(key);
    if (!p) {
      const r = resolveOne(displayName, code, roster);
      p = { ref: `p${n++}`, rawName, displayName, code, type: r.type, resolution: r.resolution,
        ...(r.rosterCandidates ? { rosterCandidates: r.rosterCandidates } : {}) };
      byKey.set(key, p);
    }
    return p.ref;
  }
  return { getRef, list: () => [...byKey.values()] };
}

const isExpenseHeader = (rows: string[][]) => rows.findIndex((r) => cell(r, 0).toLowerCase() === "receipt");
const isTravelTab = (name: string, rows: string[][]) =>
  /^travel/i.test(name) || rows.some((r) => cell(r, 1).toLowerCase() === "trip cost calculator");
const travelGroupName = (tabName: string) => tabName.replace(/^Travel/i, "Travel:");

function parseExpenseTab(
  rows: string[][], headerIdx: number, reg: ReturnType<typeof makeRegistry>,
): ImportExpenseGroup | null {
  // Group name comes from the "Shares" column (E); fall back to the tab's own data.
  let groupName = "";
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const s = cell(rows[i], 4);
    if (s) { groupName = s; break; }
  }
  if (!groupName) return null;
  const kind: "unit" | "patrol" = /^unit/i.test(groupName) ? "unit" : "patrol";

  const receipts: ImportReceipt[] = [];
  const memberRefs: string[] = [];
  const seenMembers = new Set<string>();
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const desc = cell(rows[i], 0);
    const amount = num(cell(rows[i], 1));
    // Skip materialized travel reimbursements ("Travel:Primary" rows) — they're
    // regenerated from the travel group instead.
    if (desc && amount != null && !/^travel:/i.test(desc)) {
      const payerCell = cell(rows[i], 2);
      receipts.push({ description: desc, amount: round2(amount), payerRef: payerCell ? reg.getRef(payerCell) : null });
    }
    const member = cell(rows[i], 3);
    if (member) {
      const ref = reg.getRef(member);
      if (!seenMembers.has(ref)) { seenMembers.add(ref); memberRefs.push(ref); }
    }
  }
  const total = round2(receipts.reduce((s, r) => s + r.amount, 0));
  return { name: groupName, kind, receipts, memberRefs, total };
}

function parseTravelTab(
  name: string, rows: string[][], reg: ReturnType<typeof makeRegistry>,
): ImportTravelGroup {
  let origin: string | null = null, destination: string | null = null;
  let oneWayMiles: number | null = null, roundTripMiles: number | null = null;
  let tolls = 0, rate: number | null = null, reimb = 0;
  const driverRefs: string[] = [];
  let inDrivers = false;
  for (const r of rows) {
    const label = cell(r, 1).toLowerCase();
    const value = cell(r, 2);
    if (label === "from") origin = value || null;
    else if (label === "to") destination = value || null;
    else if (label === "1-way milage") oneWayMiles = num(value);
    else if (label === "round-trip") roundTripMiles = num(value);
    else if (label === "reimbursement") rate = num(value);
    else if (label === "tolls") tolls = num(value) ?? 0;
    else if (label === "driver reimbursement") reimb = num(value) ?? 0;
    if (inDrivers || label === "drivers") {
      inDrivers = true;
      if (value) driverRefs.push(reg.getRef(value));
    }
  }
  return {
    name: travelGroupName(name), origin, destination, oneWayMiles, roundTripMiles, tolls,
    rateOverride: rate, driverRefs, chargesTo: null, reimbursementPerDriver: round2(reimb),
  };
}

function parseSummaryMeta(rows: string[][]) {
  let name = "", date: string | null = null, doc: string | null = null;
  const prepay: { rawName: string; amount: number | null }[] = [];
  let inPrepay = false;
  for (const r of rows) {
    const label = cell(r, 1);
    const value = cell(r, 2);
    const l = label.toLowerCase();
    if (l === "trip name") name = value;
    else if (l === "date") date = value || null;
    else if (l === "trip planning doc") doc = value || null;
    if (inPrepay) {
      if (label) prepay.push({ rawName: label, amount: parseCurrency(value) });
      else if (!label && !value) inPrepay = false;
    }
    if (l === "pre-reimbursed") inPrepay = true;
  }
  return { name, date, doc, prepay };
}

/** Cross-check the Summary tab's per-person "Total Owed" against its own line
 * items (formatted CSV reveals broken cells like "2408%"). */
function summaryCrossCheck(csvRows: string[][], reg: ReturnType<typeof makeRegistry>) {
  const summary: ImportSummaryRow[] = [];
  const flags: ImportFlag[] = [];
  const headerIdx = csvRows.findIndex((r) => cell(r, 4).toLowerCase() === "expenses");
  if (headerIdx < 0) return { summary, flags };

  const owedByRef = new Map<string, number>();
  const rows: { person: string; raw: string }[] = [];
  for (let i = headerIdx + 1; i < csvRows.length; i++) {
    const grp = cell(csvRows[i], 4), person = cell(csvRows[i], 5), owed = parseCurrency(cell(csvRows[i], 6));
    if (grp && person && owed != null) {
      const ref = reg.getRef(person);
      owedByRef.set(ref, round2((owedByRef.get(ref) ?? 0) + owed));
    }
    const sumPerson = cell(csvRows[i], 7);
    if (sumPerson) rows.push({ person: sumPerson, raw: cell(csvRows[i], 8) });
  }
  for (const { person, raw } of rows) {
    const ref = reg.getRef(person);
    const parsed = parseCurrency(raw);
    const recomputed = round2(owedByRef.get(ref) ?? 0);
    const dn = reg.list().find((p) => p.ref === ref)?.displayName ?? person;
    if (parsed == null) {
      flags.push({ kind: "broken_formula", severity: "warning", personRef: ref, rawValue: raw, expected: recomputed,
        message: `${dn}: "${raw}" isn't a dollar amount on the Summary tab — a formula/format was likely missed (should be ${money(recomputed)}).` });
    } else if (Math.abs(parsed - recomputed) > EPS) {
      flags.push({ kind: "summary_mismatch", severity: "warning", personRef: ref, found: parsed, expected: recomputed,
        message: `${dn}: Summary shows ${money(parsed)} but its line items sum to ${money(recomputed)}.` });
    }
    summary.push({ personRef: ref, rawValue: raw, parsedValue: parsed, recomputed });
  }
  return { summary, flags };
}

/** Build the full preview from the parsed workbook tabs + the formatted Summary CSV. */
export function buildPreview(
  tabs: { name: string; rows: string[][] }[],
  summaryCsvRows: string[][] | null,
  roster: RosterMember[],
  sheetUrl: string,
  sheetId: string,
  rosterUnits: string[],
): ImportPreview {
  const reg = makeRegistry(roster);
  const flags: ImportFlag[] = [];

  const summaryTab = tabs.find((t) => t.name.toLowerCase() === "summary");
  const meta = summaryTab ? parseSummaryMeta(summaryTab.rows) : { name: "", date: null, doc: null, prepay: [] };

  const expenseGroups: ImportExpenseGroup[] = [];
  const travelGroups: ImportTravelGroup[] = [];
  for (const tab of tabs) {
    if (tab.name.toLowerCase() === "summary") continue;
    if (isTravelTab(tab.name, tab.rows)) {
      const g = parseTravelTab(tab.name, tab.rows, reg);
      if (g.destination || g.driverRefs.length) travelGroups.push(g);
      continue;
    }
    const hdr = isExpenseHeader(tab.rows);
    if (hdr >= 0) {
      const g = parseExpenseTab(tab.rows, hdr, reg);
      if (g && (g.receipts.length || g.memberRefs.length)) expenseGroups.push(g);
    }
  }

  // Travel reimbursements charge to the unit group.
  const unit = expenseGroups.find((g) => g.kind === "unit");
  for (const t of travelGroups) t.chargesTo = unit?.name ?? "Unit:Overall";

  // Trip mileage rate from the travel tabs (fall back to 0.28); clear per-group
  // overrides that just equal the trip rate.
  const tripRate = travelGroups.find((t) => t.rateOverride != null)?.rateOverride ?? 0.28;
  for (const t of travelGroups) t.rateOverride = t.rateOverride != null && Math.abs(t.rateOverride - tripRate) > 1e-9 ? t.rateOverride : null;

  const prepayments: ImportPrepayment[] = meta.prepay.map((p) => ({
    personRef: reg.getRef(p.rawName), amount: round2(p.amount ?? 0), note: "Pre-Reimbursed (imported)",
  }));

  const cross = summaryCsvRows ? summaryCrossCheck(summaryCsvRows, reg) : { summary: [], flags: [] };
  flags.push(...cross.flags);

  // Receipts missing a payer block the commit.
  for (const g of expenseGroups)
    for (const r of g.receipts)
      if (!r.payerRef)
        flags.push({ kind: "payer_unknown", severity: "blocking", groupName: g.name,
          message: `${g.name}: receipt "${r.description}" (${money(r.amount)}) has no payer — choose one before importing.` });

  // People-resolution flags.
  const people = reg.list();
  for (const p of people) {
    if (p.rosterCandidates)
      flags.push({ kind: "ambiguous_person", severity: "warning", personRef: p.ref,
        message: `${p.displayName} (…${p.code}): ${p.rosterCandidates.length} roster members share that BSA suffix — pick one or keep as a guest.` });
    else if (p.resolution.kind === "guest")
      flags.push({ kind: "unmatched_person", severity: "info", personRef: p.ref,
        message: `${p.displayName} isn't in the roster — importing as a local guest.` });
  }

  return {
    sheetId, sheetUrl,
    trip: {
      name: meta.name || "Imported trip",
      trip_date: meta.date,
      planning_doc_url: meta.doc,
      rosterUnits,
      mileage_rate: tripRate,
    },
    people, expenseGroups, travelGroups, prepayments, summary: cross.summary, flags,
  };
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}
