// Pure diff between two TripBundle snapshots. Used to answer "what changed
// since the last snapshot?" — shared by the worker (for the /changes endpoint)
// and the client. Has no I/O and no dependency on D1 or roster-db.

import type { Expense, Person, Prepayment, TripBundle } from "./types.ts";

export interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface ExpenseChange {
  id: number;
  description: string;
  changes: FieldChange[];
}

export interface PaysheetRowChange {
  person_id: number;
  name: string;
  added?: boolean;
  removed?: boolean;
  changes: FieldChange[];
}

export interface BundleDiff {
  hasChanges: boolean;
  expenses: {
    added: Expense[];
    removed: Expense[];
    changed: ExpenseChange[];
  };
  prepayments: {
    added: Prepayment[];
    removed: Prepayment[];
  };
  people: {
    added: Person[];
    removed: Person[];
  };
  paysheet: {
    rows: PaysheetRowChange[];
    totalExpenses: FieldChange | null;
    totalPrepaid: FieldChange | null;
  };
}

// Money values are stored already rounded to cents by the engine (round2), but
// compare with a small epsilon so float noise is never flagged as a change.
const EPS = 0.005;
function numChanged(a: number, b: number): boolean {
  return Math.abs((a ?? 0) - (b ?? 0)) > EPS;
}

// A travel-generated expense is deleted + reinserted (new id) whenever the
// travel group is regenerated, so it can't be matched by id across snapshots.
// Match those by their stable (source_travel_group_id, payer_id) instead.
function expenseKey(e: Expense): string {
  return e.source_travel_group_id != null
    ? `tg:${e.source_travel_group_id}:${e.payer_id}`
    : `id:${e.id}`;
}

const EXPENSE_FIELDS: (keyof Expense)[] = ["description", "amount", "group_id", "payer_id"];

function diffExpenses(prev: Expense[], curr: Expense[]): BundleDiff["expenses"] {
  const prevByKey = new Map(prev.map((e) => [expenseKey(e), e]));
  const currByKey = new Map(curr.map((e) => [expenseKey(e), e]));

  const added: Expense[] = [];
  const removed: Expense[] = [];
  const changed: ExpenseChange[] = [];

  for (const [key, c] of currByKey) {
    const p = prevByKey.get(key);
    if (!p) {
      added.push(c);
      continue;
    }
    const changes: FieldChange[] = [];
    for (const f of EXPENSE_FIELDS) {
      const before = p[f];
      const after = c[f];
      const differs = f === "amount" ? numChanged(before as number, after as number) : before !== after;
      if (differs) changes.push({ field: f, from: before, to: after });
    }
    if (changes.length) changed.push({ id: c.id, description: c.description, changes });
  }
  for (const [key, p] of prevByKey) {
    if (!currByKey.has(key)) removed.push(p);
  }
  return { added, removed, changed };
}

function diffById<T extends { id: number }>(prev: T[], curr: T[]): { added: T[]; removed: T[] } {
  const prevIds = new Set(prev.map((x) => x.id));
  const currIds = new Set(curr.map((x) => x.id));
  return {
    added: curr.filter((x) => !prevIds.has(x.id)),
    removed: prev.filter((x) => !currIds.has(x.id)),
  };
}

const PAYSHEET_FIELDS = ["paid", "owed", "prepay", "balance", "outstanding"] as const;

function diffPaysheet(prev: TripBundle["paysheet"], curr: TripBundle["paysheet"]): BundleDiff["paysheet"] {
  const prevByPerson = new Map(prev.rows.map((r) => [r.person_id, r]));
  const currByPerson = new Map(curr.rows.map((r) => [r.person_id, r]));
  const rows: PaysheetRowChange[] = [];

  for (const c of curr.rows) {
    const p = prevByPerson.get(c.person_id);
    if (!p) {
      rows.push({ person_id: c.person_id, name: c.name, added: true, changes: [] });
      continue;
    }
    const changes: FieldChange[] = [];
    for (const f of PAYSHEET_FIELDS) {
      if (numChanged(p[f], c[f])) changes.push({ field: f, from: p[f], to: c[f] });
    }
    if (p.status !== c.status) changes.push({ field: "status", from: p.status, to: c.status });
    if (changes.length) rows.push({ person_id: c.person_id, name: c.name, changes });
  }
  for (const p of prev.rows) {
    if (!currByPerson.has(p.person_id)) {
      rows.push({ person_id: p.person_id, name: p.name, removed: true, changes: [] });
    }
  }

  return {
    rows,
    totalExpenses: numChanged(prev.totalExpenses, curr.totalExpenses)
      ? { field: "totalExpenses", from: prev.totalExpenses, to: curr.totalExpenses }
      : null,
    totalPrepaid: numChanged(prev.totalPrepaid, curr.totalPrepaid)
      ? { field: "totalPrepaid", from: prev.totalPrepaid, to: curr.totalPrepaid }
      : null,
  };
}

export function diffBundles(prev: TripBundle, curr: TripBundle): BundleDiff {
  const expenses = diffExpenses(prev.expenses, curr.expenses);
  const prepayments = diffById(prev.prepayments, curr.prepayments);
  const people = diffById(prev.people, curr.people);
  const paysheet = diffPaysheet(prev.paysheet, curr.paysheet);

  const hasChanges =
    expenses.added.length > 0 ||
    expenses.removed.length > 0 ||
    expenses.changed.length > 0 ||
    prepayments.added.length > 0 ||
    prepayments.removed.length > 0 ||
    people.added.length > 0 ||
    people.removed.length > 0 ||
    paysheet.rows.length > 0 ||
    paysheet.totalExpenses != null ||
    paysheet.totalPrepaid != null;

  return { hasChanges, expenses, prepayments, people, paysheet };
}
