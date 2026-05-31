import { useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import type {
  TripBundle,
  Person,
  CostGroup,
  GroupSummary,
  SettlementStatus,
  RosterMember,
  PersonType,
} from "../shared/types.ts";
import { api, money, HOME_ADDRESS } from "./api.ts";

type Tab = "patrols" | "travel" | "expenses" | "reimbursement" | "settings";
const TAB_ORDER: Tab[] = ["patrols", "travel", "expenses", "reimbursement", "settings"];
const labels: Record<Tab, string> = {
  patrols: "Patrols",
  travel: "Travel",
  expenses: "Expenses",
  reimbursement: "Reimbursement",
  settings: "⚙",
};
const UUID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export function App() {
  const [bundle, setBundle] = useState<TripBundle | null>(null);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("patrols");
  const [titleDraft, setTitleDraft] = useState("");

  // Load: prefer the trip from URL (/:uuid/:slug); else first trip in DB.
  useEffect(() => {
    (async () => {
      try {
        const m = location.pathname.slice(1).match(UUID_RE);
        if (m) {
          setBundle(await api.getTripByUuid(m[1]));
        } else {
          const trips = await api.listTrips();
          if (trips.length) setBundle(await api.getTrip(trips[0].id));
        }
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Keep the URL in sync with the loaded trip. Title edits don't change it;
  // only slug changes do (the UUID is permanent).
  useEffect(() => {
    if (!bundle) return;
    const want = `/${bundle.trip.uuid}/${bundle.trip.slug}`;
    if (location.pathname !== want) history.replaceState(null, "", want);
  }, [bundle?.trip.uuid, bundle?.trip.slug]);

  // Resync the title input when the trip changes (or after a save round-trip).
  useEffect(() => {
    if (bundle) setTitleDraft(bundle.trip.name);
  }, [bundle?.trip.id, bundle?.trip.name]);

  // The registered roster comes from roster-db; refetch when the trip or its
  // configured units change.
  useEffect(() => {
    if (!bundle) return;
    let cancelled = false;
    api
      .getRoster(bundle.trip.id)
      .then((r) => { if (!cancelled) setRoster(r); })
      .catch((e) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
  }, [bundle?.trip.id, bundle?.trip.roster_units.join(",")]);

  async function run(fn: () => Promise<TripBundle>) {
    setBusy(true);
    setError(null);
    try {
      setBundle(await fn());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function saveTitle() {
    if (!bundle) return;
    const next = titleDraft.trim();
    if (!next || next === bundle.trip.name) {
      setTitleDraft(bundle.trip.name);
      return;
    }
    run(() => api.updateTrip(bundle.trip.id, { name: next }));
  }

  if (loading) return <div className="wrap">Loading…</div>;

  if (!bundle) {
    return (
      <div className="wrap">
        <h1>Patrol Expense</h1>
        <p className="empty">No trip yet. Load the 2026 Winter Lodge sample to get started.</p>
        {error && <div className="err">{error}</div>}
        <button className="btn" disabled={busy} onClick={() => run(api.seed)}>
          {busy ? "Loading…" : "Load 2026 Winter Lodge data"}
        </button>
      </div>
    );
  }

  const t = bundle.trip;
  return (
    <div className="wrap">
      <header className="app">
        <div style={{ flex: 1, minWidth: 220 }}>
          <input
            className="title-input"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
              if (e.key === "Escape") { setTitleDraft(t.name); (e.currentTarget as HTMLInputElement).blur(); }
            }}
            aria-label="Trip title"
            disabled={busy}
          />
          <div className="meta">
            {t.trip_date && <span>📅 {t.trip_date}</span>}
            {t.planning_doc_url && (
              <span>
                <a href={t.planning_doc_url} target="_blank" rel="noreferrer">Planning doc</a>
              </span>
            )}
            {t.slack_url && (
              <span>
                <a href={t.slack_url} target="_blank" rel="noreferrer">Slack channel</a>
              </span>
            )}
          </div>
        </div>
        <button className="btn ghost" disabled={busy} onClick={() => run(api.seed)}>
          Reset to sample data
        </button>
      </header>

      <nav className="tabs">
        {TAB_ORDER.map((x) => (
          <button
            key={x}
            className={`${tab === x ? "active" : ""} ${x === "settings" ? "tab-gear" : ""}`}
            onClick={() => setTab(x)}
            aria-label={x === "settings" ? "Settings" : undefined}
            title={x === "settings" ? "Settings" : undefined}
          >
            {labels[x]}
          </button>
        ))}
      </nav>

      {error && <div className="err">{error}</div>}

      {tab === "patrols" && <Patrols bundle={bundle} roster={roster} run={run} busy={busy} />}
      {tab === "travel" && <Travel bundle={bundle} roster={roster} run={run} busy={busy} />}
      {tab === "expenses" && <Expenses bundle={bundle} roster={roster} run={run} busy={busy} />}
      {tab === "reimbursement" && <Reimbursement bundle={bundle} roster={roster} run={run} busy={busy} />}
      {tab === "settings" && <Settings bundle={bundle} roster={roster} run={run} busy={busy} />}
    </div>
  );
}

interface TabProps {
  bundle: TripBundle;
  roster: RosterMember[];
  busy: boolean;
  run: (fn: () => Promise<TripBundle>) => Promise<void>;
}

// A selectable person for the pickers, identified by a ref the API understands.
interface PickItem {
  ref: string; // "id:<localId>" | "bsa:<bsaNumber>"
  name: string;
  type: PersonType;
  sub?: string; // secondary line (patrol, guardian, "guest", email…)
  email?: string | null;
}

/**
 * Build the picker pool from local people + the live roster, de-duplicating
 * roster members already projected locally (matched by bsa_number). `kind`
 * limits the pool to adults (drivers) or everyone (attendance).
 */
function buildPool(
  bundle: TripBundle,
  roster: RosterMember[],
  kind: "all" | "adults",
): PickItem[] {
  const personById = new Map(bundle.people.map((p) => [p.id, p]));
  const localBsa = new Set(bundle.people.map((p) => p.bsa_number).filter(Boolean) as string[]);

  const localItems: PickItem[] = bundle.people
    .filter((p) => kind === "all" || p.type === "adult")
    .map((p) => ({
      ref: `id:${p.id}`,
      name: p.name,
      type: p.type,
      email: p.email,
      sub:
        p.source === "local"
          ? p.type === "scout"
            ? `guest · ${p.parent_id ? personById.get(p.parent_id)?.name ?? "" : "no parent"}`
            : "guest"
          : p.type === "scout"
            ? p.parent_id ? personById.get(p.parent_id)?.name ?? "" : ""
            : "adult",
    }));

  const rosterItems: PickItem[] = roster
    .filter((m) => kind === "all" || m.type === "adult")
    .filter((m) => !localBsa.has(m.bsa_number))
    .map((m) => ({
      ref: `bsa:${m.bsa_number}`,
      name: m.name,
      type: m.type,
      email: m.email,
      sub:
        m.type === "scout"
          ? [m.patrol, m.guardian?.name].filter(Boolean).join(" · ") || "youth"
          : "adult",
    }));

  return [...localItems, ...rosterItems].sort((a, b) => a.name.localeCompare(b.name));
}

function useMaps(bundle: TripBundle) {
  return useMemo(() => {
    const personById = new Map<number, Person>(bundle.people.map((p) => [p.id, p]));
    const groupById = new Map<number, CostGroup>(bundle.groups.map((g) => [g.id, g]));
    const summaryByGroup = new Map<number, GroupSummary>(
      bundle.groupSummaries.map((s) => [s.group.id, s]),
    );
    const adults = bundle.people
      .filter((p) => p.type === "adult")
      .sort((a, b) => a.name.localeCompare(b.name));
    return { personById, groupById, summaryByGroup, adults };
  }, [bundle]);
}

// ------------------------------------------------------------------ Reimbursement
function Reimbursement({ bundle, run, busy }: TabProps) {
  const [showAll, setShowAll] = useState(false);
  const rows = bundle.paysheet.rows
    .filter((r) => showAll || r.paid || r.owed || r.prepay)
    .sort((a, b) => a.outstanding - b.outstanding);

  const owedToPeople = rows.filter((r) => r.outstanding > 0.005).reduce((s, r) => s + r.outstanding, 0);
  const owedByPeople = rows.filter((r) => r.outstanding < -0.005).reduce((s, r) => s - r.outstanding, 0);

  return (
    <div className="card">
      <div className="kpi" style={{ marginBottom: 18 }}>
        <div><div className="k">Total expenses</div><div className="v">{money(bundle.paysheet.totalExpenses)}</div></div>
        <div><div className="k">Pre-reimbursed</div><div className="v">{money(bundle.paysheet.totalPrepaid)}</div></div>
        <div><div className="k">Owed to people</div><div className="v pos">{money(owedToPeople)}</div></div>
        <div><div className="k">Owed by people</div><div className="v neg">{money(owedByPeople)}</div></div>
      </div>

      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Who owes / is owed</h2>
        <div className="spacer" />
        <label className="row" style={{ alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          <span className="hint">Show everyone ({bundle.paysheet.rows.length})</span>
        </label>
      </div>

      <table>
        <thead>
          <tr>
            <th>Adult</th>
            <th className="num">Paid</th>
            <th className="num">Owes (share)</th>
            <th className="num">Pre-reimbursed</th>
            <th className="num">Net</th>
            <th>Settlement</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const o = r.outstanding;
            const label =
              o > 0.005 ? <span className="pos">owed {money(o)}</span> :
              o < -0.005 ? <span className="neg">owes {money(-o)}</span> :
              <span className="settled">—</span>;
            return (
              <tr key={r.person_id} className={!r.paid && !r.owed && !r.prepay ? "zero" : ""}>
                <td>{r.name} {r.code && <span className="hint">({r.code})</span>}</td>
                <td className="num">{r.paid ? money(r.paid) : ""}</td>
                <td className="num">{r.owed ? money(r.owed) : ""}</td>
                <td className="num">{r.prepay ? money(r.prepay) : ""}</td>
                <td className="num">{label}</td>
                <td>
                  <select
                    className={`status-${r.status}`}
                    value={r.status}
                    disabled={busy}
                    onChange={(e) =>
                      run(() => api.setStatus(bundle.trip.id, r.person_id, e.target.value as SettlementStatus))
                    }
                  >
                    <option value="none">—</option>
                    <option value="requested">requested</option>
                    <option value="received">received</option>
                    <option value="paid">paid</option>
                  </select>
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={6} className="empty">No activity yet.</td></tr>
          )}
        </tbody>
      </table>
      <p><small className="hint">
        Net = what they paid − their share of expenses − pre-reimbursements.
        Green means the troop owes them; red means they owe the troop.
      </small></p>
    </div>
  );
}

// ------------------------------------------------------------------ Expenses
function Expenses({ bundle, roster, run, busy }: TabProps) {
  const { personById } = useMaps(bundle);
  const costGroups = bundle.groups.filter((g) => g.kind !== "travel");
  // Payer pool: adults from local people + roster (deduped), as refs.
  const adultPool = useMemo(() => buildPool(bundle, roster, "adults"), [bundle, roster]);
  const [groupId, setGroupId] = useState<number>(costGroups[0]?.id ?? 0);
  const [payerRef, setPayerRef] = useState<string>("");
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");

  const effectivePayer = payerRef || adultPool[0]?.ref || "";

  function add() {
    const amt = parseFloat(amount);
    if (!desc || !groupId || !effectivePayer || isNaN(amt)) return;
    run(() => api.addExpense(bundle.trip.id, { group_id: groupId, payer_ref: effectivePayer, description: desc, amount: amt }))
      .then(() => { setDesc(""); setAmount(""); });
  }

  return (
    <div className="card">
      <h2>Add a receipt</h2>
      <div className="row">
        <label className="fld">Cost group
          <select value={groupId} onChange={(e) => setGroupId(Number(e.target.value))}>
            {costGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <label className="fld">Paid by
          <select value={effectivePayer} onChange={(e) => setPayerRef(e.target.value)}>
            {adultPool.map((p) => <option key={p.ref} value={p.ref}>{p.name}</option>)}
          </select>
        </label>
        <label className="fld" style={{ flex: 1, minWidth: 160 }}>Description
          <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="e.g. Food - Safeway" />
        </label>
        <label className="fld">Amount
          <input className="sm" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" inputMode="decimal" />
        </label>
        <button className="btn" disabled={busy} onClick={add}>Add</button>
      </div>

      {bundle.groups.map((g) => {
        const rows = bundle.expenses.filter((e) => e.group_id === g.id);
        if (rows.length === 0) return null;
        const summary = bundle.groupSummaries.find((s) => s.group.id === g.id)!;
        return (
          <div key={g.id}>
            <h3>{g.name} — {money(summary.total)}{summary.totalShares > 0 && <> · {money(summary.perShare)}/share ({summary.totalShares} shares)</>}</h3>
            <table>
              <thead>
                <tr><th>Receipt</th><th>Paid by</th><th className="num">Amount</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td>{e.description}{e.source_travel_group_id && <span className="pill" style={{ marginLeft: 6 }}>auto</span>}</td>
                    <td>{personById.get(e.payer_id)?.name ?? "?"}</td>
                    <td className="num">{money(e.amount)}</td>
                    <td className="num">
                      {!e.source_travel_group_id && (
                        <button className="btn danger" disabled={busy} onClick={() => run(() => api.deleteExpense(e.id))}>Delete</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

// ------------------------------------------------------------------ Travel
function Travel({ bundle, roster, run, busy }: TabProps) {
  const travelGroups = bundle.groups.filter((g) => g.kind === "travel");
  const costGroups = bundle.groups.filter((g) => g.kind !== "travel");
  const [newName, setNewName] = useState("");

  function addRoute() {
    const name = newName.trim() || `Travel:Route ${travelGroups.length + 1}`;
    run(() =>
      api.addGroup(bundle.trip.id, {
        name,
        kind: "travel",
        sort_order: 10 + travelGroups.length,
        cost_group_id: costGroups[0]?.id ?? null,
        origin: HOME_ADDRESS,
        tolls: 0,
      }),
    ).then(() => setNewName(""));
  }

  return (
    <div className="card">
      <h2>Travel reimbursements</h2>
      <p><small className="hint">
        Each driver is reimbursed (round-trip miles × rate) + tolls. The total is charged
        as expenses to the chosen cost group and flows into the paysheet automatically.
      </small></p>
      {travelGroups.map((g) => (
        <TravelGroup key={g.id} group={g} bundle={bundle} roster={roster} run={run} busy={busy} />
      ))}
      {travelGroups.length === 0 && <p className="empty">No travel routes yet.</p>}

      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14, marginTop: 14 }}>
        <div className="row">
          <label className="fld" style={{ flex: 1, minWidth: 220 }}>New route
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Travel:Backup"
            />
          </label>
          <button className="btn" disabled={busy} onClick={addRoute}>Add route</button>
        </div>
      </div>
    </div>
  );
}

// Address text input with Google Places autocomplete (proxied via the Worker).
function AddressInput({
  value, onChange, onPick, busy, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick?: (v: string) => void;
  busy?: boolean;
  placeholder?: string;
}) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  // Skip the first render so a prefilled value (e.g. the default "From"
  // address) doesn't fire a Google request / open the dropdown on mount.
  const skipRef = useRef(true);

  useEffect(() => {
    if (skipRef.current) { skipRef.current = false; return; }
    const q = value.trim();
    if (q.length < 3) { setSuggestions([]); setOpen(false); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await api.geoAutocomplete(q);
        if (!cancelled) { setSuggestions(r.map((x) => x.description)); setOpen(true); }
      } catch { if (!cancelled) setSuggestions([]); }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [value]);

  function pick(v: string) {
    skipRef.current = true; // don't re-query for the value we just set
    setOpen(false);
    setSuggestions([]);
    onChange(v);
    onPick?.(v);
  }

  return (
    <div className="ac">
      <input
        value={value}
        disabled={busy}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => suggestions.length && setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && suggestions.length > 0 && (
        <div className="ac-menu">
          {suggestions.map((s) => (
            <button type="button" key={s} disabled={busy} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(s)}>
              <span>{s}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TravelGroup({ group, bundle, roster, run, busy }: { group: CostGroup } & TabProps) {
  const summary = bundle.groupSummaries.find((s) => s.group.id === group.id)!;
  const costGroups = bundle.groups.filter((g) => g.kind !== "travel");
  const driverIds = summary.driverIds ?? [];
  const pool = useMemo(() => buildPool(bundle, roster, "adults"), [bundle, roster]);

  const [draft, setDraft] = useState<{
    origin: string;
    destination: string;
    round_trip_miles: number;
    tolls: number;
    rate_override: number | null;
    cost_group_id: number | null;
  }>({
    origin: group.origin || HOME_ADDRESS,
    destination: group.destination ?? "",
    round_trip_miles: group.round_trip_miles ?? (group.one_way_miles ? group.one_way_miles * 2 : 0),
    tolls: group.tolls ?? 0,
    rate_override: group.rate_override,
    cost_group_id: group.cost_group_id ?? costGroups[0]?.id ?? null,
  });
  const [calc, setCalc] = useState<{ loading: boolean; oneWay?: number; err?: string }>({ loading: false });

  const rate = draft.rate_override ?? bundle.trip.mileage_rate;
  const reimb = Math.round((draft.round_trip_miles * rate + Number(draft.tolls)) * 100) / 100;

  // Compute most-direct driving distance between two addresses via the Worker
  // proxy, and populate round-trip miles (= one-way × 2).
  async function calcDistance(from: string, to: string) {
    if (!from.trim() || !to.trim()) return;
    setCalc({ loading: true });
    try {
      const r = await api.geoDistance(from, to);
      setDraft((d) => ({ ...d, round_trip_miles: r.round_trip_miles }));
      setCalc({ loading: false, oneWay: r.one_way_miles });
    } catch (e) {
      setCalc({ loading: false, err: String(e) });
    }
  }

  function saveCalculator() {
    run(() =>
      api.updateGroup(group.id, {
        name: group.name,
        origin: draft.origin,
        destination: draft.destination,
        one_way_miles: calc.oneWay ?? Math.round((draft.round_trip_miles / 2) * 10) / 10,
        round_trip_miles: Number(draft.round_trip_miles),
        tolls: Number(draft.tolls),
        rate_override:
          draft.rate_override == null || draft.rate_override === ("" as unknown)
            ? null
            : Number(draft.rate_override),
        cost_group_id: draft.cost_group_id,
      }),
    );
  }

  return (
    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14, marginTop: 14 }}>
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>{group.name}</h3>
        <div className="spacer" />
        <button className="btn danger" disabled={busy} onClick={() => run(() => api.deleteGroup(group.id))}>Delete route</button>
      </div>
      <div className="row">
        <label className="fld" style={{ flex: 1, minWidth: 180 }}>From
          <AddressInput
            value={draft.origin}
            busy={busy}
            placeholder="Start address"
            onChange={(v) => setDraft((d) => ({ ...d, origin: v }))}
            onPick={(v) => calcDistance(v, draft.destination)}
          />
        </label>
        <label className="fld" style={{ flex: 1, minWidth: 180 }}>To
          <AddressInput
            value={draft.destination}
            busy={busy}
            placeholder="Destination address"
            onChange={(v) => setDraft((d) => ({ ...d, destination: v }))}
            onPick={(v) => calcDistance(draft.origin, v)}
          />
        </label>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <label className="fld">Round-trip mi
          <input className="sm" value={draft.round_trip_miles} onChange={(e) => setDraft({ ...draft, round_trip_miles: Number(e.target.value) })} inputMode="decimal" />
        </label>
        <button
          className="btn ghost"
          style={{ alignSelf: "flex-end" }}
          disabled={busy || calc.loading || !draft.origin.trim() || !draft.destination.trim()}
          onClick={() => calcDistance(draft.origin, draft.destination)}
          title="Most-direct driving distance via Google Maps"
        >
          {calc.loading ? "…" : "↻ distance"}
        </button>
        <label className="fld">Tolls
          <input className="sm" value={draft.tolls} onChange={(e) => setDraft({ ...draft, tolls: Number(e.target.value) })} inputMode="decimal" />
        </label>
        <label className="fld">Rate ($/mi)
          <input className="sm" value={draft.rate_override ?? ""} placeholder={bundle.trip.mileage_rate.toFixed(2)}
            onChange={(e) => setDraft({ ...draft, rate_override: e.target.value === "" ? null : Number(e.target.value) })} inputMode="decimal" />
        </label>
        <label className="fld">Charge to
          <select value={draft.cost_group_id ?? ""} onChange={(e) => setDraft({ ...draft, cost_group_id: e.target.value ? Number(e.target.value) : null })}>
            {costGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <div className="fld">
          <span>Per driver</span>
          <div className="v" style={{ fontSize: 18, fontWeight: 600 }}>{money(reimb)}</div>
        </div>
        <button className="btn" style={{ alignSelf: "flex-end" }} disabled={busy} onClick={saveCalculator}>Save route</button>
      </div>
      {(calc.oneWay != null || calc.err) && (
        <p style={{ margin: "8px 0 0" }}>
          {calc.err
            ? <small className="neg">Distance lookup failed: {calc.err}</small>
            : <small className="hint">Most direct route: {calc.oneWay} mi one-way · {draft.round_trip_miles} mi round-trip. Remember to Save route.</small>}
        </p>
      )}

      <h3>Drivers ({driverIds.length}) — total {money(reimb * driverIds.length)}</h3>
      <PersonPicker
        value={driverIds.map((id) => `id:${id}`)}
        pool={pool}
        busy={busy}
        onChange={(refs) => run(() => api.setDrivers(group.id, refs))}
        placeholder="Add a driver — or paste names/emails"
      />
    </div>
  );
}

// ------------------------------------------------------------------ Patrols (cost groups + attendance)
function Patrols({ bundle, roster, run, busy }: TabProps) {
  const costGroups = bundle.groups.filter((g) => g.kind !== "travel");
  const [name, setName] = useState("");
  const [kind, setKind] = useState("patrol");

  return (
    <div className="card">
      <h2>Cost groups &amp; attendance</h2>
      <p><small className="hint">
        A group's expenses are split by shares, derived from who attended. Add adults and
        youth via the autocomplete — or paste a list of names/emails to bulk-add. Each
        attendee is one share, billed to the responsible adult (a youth → their parent;
        an adult → themselves).
      </small></p>

      <div className="row" style={{ marginBottom: 8 }}>
        <label className="fld" style={{ flex: 1, minWidth: 160 }}>New group
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Patrol:Hawks" />
        </label>
        <label className="fld">Kind
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="patrol">patrol</option>
            <option value="unit">unit</option>
          </select>
        </label>
        <button className="btn" disabled={busy || !name} onClick={() => run(() => api.addGroup(bundle.trip.id, { name, kind })).then(() => setName(""))}>Add</button>
      </div>

      {costGroups.map((g) => (
        <MembersEditor key={g.id} group={g} bundle={bundle} roster={roster} run={run} busy={busy} />
      ))}
    </div>
  );
}

// Normalize a string for matching: lowercase, strip "(...)", collapse whitespace.
function norm(s: string): string {
  return s.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
}

function matchPick(token: string, pool: PickItem[]): PickItem | null {
  const t = token.trim();
  if (!t) return null;
  if (t.includes("@")) {
    const e = t.toLowerCase();
    return pool.find((p) => (p.email ?? "").toLowerCase() === e) ?? null;
  }
  const n = norm(t);
  return pool.find((p) => norm(p.name) === n) ?? null;
}

/**
 * Chips + autocomplete + paste UI for picking a set of people from a pool.
 * Works in "ref space": value and onChange use refs ("id:N" / "bsa:NNN"), so
 * both local people and (not-yet-projected) roster members are selectable.
 */
function PersonPicker({
  value, pool, busy, onChange, placeholder,
}: {
  value: string[];
  pool: PickItem[];
  busy: boolean;
  onChange: (nextRefs: string[]) => void;
  placeholder?: string;
}) {
  const valueSet = useMemo(() => new Set(value), [value]);
  const byRef = useMemo(() => new Map(pool.map((p) => [p.ref, p])), [pool]);
  const selected = value
    .map((ref) => byRef.get(ref))
    .filter((p): p is PickItem => !!p)
    .sort((a, b) => a.name.localeCompare(b.name));

  const [query, setQuery] = useState("");
  const [note, setNote] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return pool
      .filter((p) => !valueSet.has(p.ref))
      .filter((p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        (p.email ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8);
  }, [query, pool, valueSet]);

  function add(ref: string) { setNote(null); setQuery(""); onChange([...value, ref]); }
  function remove(ref: string) { setNote(null); onChange(value.filter((x) => x !== ref)); }

  function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    if (!/[\n,;\t]/.test(text)) return; // single value: let it type normally
    e.preventDefault();
    const tokens = text.split(/[\n,;\t]+/).map((s) => s.trim()).filter(Boolean);
    const next = new Set(value);
    const unmatched: string[] = [];
    let added = 0;
    for (const tok of tokens) {
      const p = matchPick(tok, pool);
      if (p) { if (!next.has(p.ref)) added++; next.add(p.ref); }
      else unmatched.push(tok);
    }
    setQuery("");
    setNote(`Added ${added}.` + (unmatched.length ? ` No match for: ${unmatched.join(", ")}` : ""));
    onChange([...next]);
  }

  return (
    <>
      <div className="chips">
        {selected.map((p) => (
          <span key={p.ref} className={`chip ${p.type === "scout" ? "chip-youth" : "chip-adult"}`}>
            <span>{p.name}</span>
            <button type="button" disabled={busy} onClick={() => remove(p.ref)} aria-label={`Remove ${p.name}`}>×</button>
          </span>
        ))}
        {selected.length === 0 && <span className="hint">No one added yet.</span>}
      </div>
      <div className="ac">
        <input
          value={query}
          disabled={busy}
          placeholder={placeholder ?? "Add by name or email — or paste a list"}
          onChange={(e) => setQuery(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && candidates[0]) {
              e.preventDefault();
              add(candidates[0].ref);
            }
          }}
        />
        {query && candidates.length > 0 && (
          <div className="ac-menu">
            {candidates.map((p) => (
              <button type="button" key={p.ref} disabled={busy} onClick={() => add(p.ref)}>
                <span>{p.name}</span>
                <span className="hint">{p.sub}{p.email ? ` · ${p.email}` : ""}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {note && <p style={{ margin: "6px 0 0" }}><small className="hint">{note}</small></p>}
    </>
  );
}

function MembersEditor({ group, bundle, roster, run, busy }: { group: CostGroup } & TabProps) {
  const { personById } = useMaps(bundle);
  const summary = bundle.groupSummaries.find((s) => s.group.id === group.id)!;
  const memberIds = summary.memberIds;
  const pool = useMemo(() => buildPool(bundle, roster, "all"), [bundle, roster]);

  // For each billable adult, the contributors (themselves + their attending youth).
  const shareBreakdown = useMemo(() => {
    const m = new Map<number, Person[]>();
    for (const pid of memberIds) {
      const p = personById.get(pid);
      if (!p) continue;
      const aid = p.type === "adult" ? p.id : p.parent_id;
      if (aid == null) continue;
      const list = m.get(aid) ?? [];
      list.push(p);
      m.set(aid, list);
    }
    return [...m.entries()]
      .map(([aid, contribs]) => ({
        adult: personById.get(aid)!,
        contributors: contribs.sort(
          (a, b) =>
            (a.type === "adult" ? -1 : 1) - (b.type === "adult" ? -1 : 1) ||
            a.name.localeCompare(b.name),
        ),
      }))
      .filter((r) => !!r.adult)
      .sort((a, b) => b.contributors.length - a.contributors.length);
  }, [memberIds, personById]);

  const orphaned = memberIds.some((id) => {
    const p = personById.get(id);
    return p && p.type === "scout" && (p.parent_id == null || personById.get(p.parent_id)?.type !== "adult");
  });

  return (
    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 12, marginTop: 12 }}>
      <div className="toolbar" style={{ marginBottom: 8 }}>
        <strong>{group.name}</strong>
        <span className="pill">{group.kind}</span>
        <span className="hint">
          {money(summary.total)} · {summary.totalShares} shares
          {summary.totalShares > 0 && <> · {money(summary.total / summary.totalShares)}/share</>}
        </span>
        <div className="spacer" />
        {group.kind === "patrol" && (
          <button className="btn danger" disabled={busy} onClick={() => run(() => api.deleteGroup(group.id))}>Delete group</button>
        )}
      </div>

      <PersonPicker
        value={memberIds.map((id) => `id:${id}`)}
        pool={pool}
        busy={busy}
        onChange={(refs) => run(() => api.setMembers(group.id, refs))}
      />

      {orphaned && (
        <p style={{ margin: "6px 0 0" }}>
          <small className="neg">A listed youth has no responsible adult and won't be billed. Assign a parent in the Roster tab.</small>
        </p>
      )}
      {shareBreakdown.length > 0 && (
        <p style={{ margin: "6px 0 0" }}>
          <small className="hint">
            → {summary.totalShares} shares:{" "}
            {shareBreakdown.map((s, i) => (
              <span key={s.adult.id}>
                {i > 0 && ", "}
                <span className="tip" tabIndex={0}>
                  {s.adult.name} {s.contributors.length}
                  <span className="tip-body" role="tooltip">
                    {s.contributors.map((c) => (
                      <span key={c.id} className="tip-row">
                        <span>{c.name}</span>
                        <span className="tip-x">×1</span>
                      </span>
                    ))}
                  </span>
                </span>
              </span>
            ))}
          </small>
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Settings (sheet config + roster)
function Settings({ bundle, roster, run, busy }: TabProps) {
  return (
    <>
      <SheetSettings bundle={bundle} roster={roster} run={run} busy={busy} />
      <Roster bundle={bundle} roster={roster} run={run} busy={busy} />
    </>
  );
}

function SheetSettings({ bundle, run, busy }: TabProps) {
  const trip = bundle.trip;
  const [slug, setSlug] = useState(trip.slug);
  const [date, setDate] = useState(trip.trip_date ?? "");
  const [pdoc, setPdoc] = useState(trip.planning_doc_url ?? "");
  const [slack, setSlack] = useState(trip.slack_url ?? "");
  const [rate, setRate] = useState(String(trip.mileage_rate));
  const [units, setUnits] = useState(trip.roster_units.join(", "));

  useEffect(() => {
    setSlug(trip.slug);
    setDate(trip.trip_date ?? "");
    setPdoc(trip.planning_doc_url ?? "");
    setSlack(trip.slack_url ?? "");
    setRate(String(trip.mileage_rate));
    setUnits(trip.roster_units.join(", "));
  }, [trip.id, trip.slug, trip.trip_date, trip.planning_doc_url, trip.slack_url, trip.mileage_rate, trip.roster_units.join(",")]);

  function save(patch: Record<string, unknown>) {
    run(() => api.updateTrip(trip.id, patch));
  }

  return (
    <div className="card">
      <h2>Sheet settings</h2>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="fld" style={{ flex: 1, minWidth: 240 }}>URL slug
          <input
            value={slug}
            disabled={busy}
            onChange={(e) => setSlug(e.target.value)}
            onBlur={() => slug.trim() && slug !== trip.slug && save({ slug: slug.trim() })}
          />
          <small className="hint">URL: /{trip.uuid}/{trip.slug}</small>
        </label>
        <label className="fld" style={{ minWidth: 160 }}>Date
          <input
            type="date"
            value={date}
            disabled={busy}
            onChange={(e) => setDate(e.target.value)}
            onBlur={() => date !== (trip.trip_date ?? "") && save({ trip_date: date || null })}
          />
        </label>
        <label className="fld" style={{ width: 130 }}>Mileage rate ($/mi)
          <input
            className="sm"
            value={rate}
            disabled={busy}
            inputMode="decimal"
            onChange={(e) => setRate(e.target.value)}
            onBlur={() => {
              const n = Number(rate);
              if (Number.isFinite(n) && n !== trip.mileage_rate) save({ mileage_rate: n });
            }}
          />
        </label>
      </div>
      <div className="row">
        <label className="fld" style={{ flex: 1, minWidth: 260 }}>Planning doc URL
          <input
            value={pdoc}
            disabled={busy}
            placeholder="https://…"
            onChange={(e) => setPdoc(e.target.value)}
            onBlur={() => pdoc !== (trip.planning_doc_url ?? "") && save({ planning_doc_url: pdoc || null })}
          />
        </label>
        <label className="fld" style={{ flex: 1, minWidth: 260 }}>Slack channel URL
          <input
            value={slack}
            disabled={busy}
            placeholder="https://….slack.com/archives/…"
            onChange={(e) => setSlack(e.target.value)}
            onBlur={() => slack !== (trip.slack_url ?? "") && save({ slack_url: slack || null })}
          />
        </label>
        <label className="fld" style={{ flex: 1, minWidth: 220 }}>Roster units (from roster-db)
          <input
            value={units}
            disabled={busy}
            placeholder="Troop 10 F, Crew 10"
            onChange={(e) => setUnits(e.target.value)}
            onBlur={() => {
              const next = units.split(",").map((s) => s.trim()).filter(Boolean);
              if (next.join(",") !== trip.roster_units.join(",")) save({ roster_units: next });
            }}
          />
          <small className="hint">Comma-separated; which units populate the picker.</small>
        </label>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Roster
// The registered roster is read from roster-db (read-only). Only unregistered
// additions (guests) are stored locally and can be added/removed here.
function Roster({ bundle, roster, run, busy }: TabProps) {
  const { personById } = useMaps(bundle);
  const adultPool = useMemo(() => buildPool(bundle, roster, "adults"), [bundle, roster]);

  const regAdults = roster.filter((m) => m.type === "adult");
  const regYouth = roster.filter((m) => m.type === "scout");
  const guests = bundle.people
    .filter((p) => p.source === "local")
    .sort((a, b) => a.name.localeCompare(b.name));

  const [name, setName] = useState("");
  const [type, setType] = useState("scout");
  const [parentRef, setParentRef] = useState<string>("");

  const effectiveParent = parentRef || adultPool[0]?.ref || "";

  function add() {
    if (!name.trim()) return;
    run(() =>
      api.addPerson(bundle.trip.id, {
        name: name.trim(),
        type,
        parent_ref: type === "scout" ? effectiveParent : undefined,
      }),
    ).then(() => { setName(""); });
  }

  return (
    <div className="card">
      <h2>Roster</h2>
      <p><small className="hint">
        Registered members come from <strong>roster-db</strong> (units: {bundle.trip.roster_units.join(", ") || "none"})
        and are read-only here. Add unregistered attendees (e.g. visiting cub scouts) as guests below —
        they stay local to this sheet and are never written back to roster-db.
      </small></p>

      <h3>Add a guest (unregistered)</h3>
      <div className="row" style={{ marginBottom: 16 }}>
        <label className="fld" style={{ flex: 1, minWidth: 180 }}>Name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claire S." />
        </label>
        <label className="fld">Type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="scout">youth</option>
            <option value="adult">adult</option>
          </select>
        </label>
        {type === "scout" && (
          <label className="fld" style={{ minWidth: 180 }}>Billed to
            <select value={effectiveParent} onChange={(e) => setParentRef(e.target.value)}>
              {adultPool.map((p) => <option key={p.ref} value={p.ref}>{p.name}</option>)}
            </select>
          </label>
        )}
        <button className="btn" disabled={busy || !name.trim()} onClick={add}>Add guest</button>
      </div>

      {guests.length > 0 && (
        <table style={{ marginBottom: 18 }}>
          <thead>
            <tr><th>Guest</th><th>Type</th><th>Billed to</th><th></th></tr>
          </thead>
          <tbody>
            {guests.map((p) => (
              <tr key={p.id}>
                <td>{p.name} <span className="pill">guest</span></td>
                <td className="hint">{p.type === "scout" ? "youth" : "adult"}</td>
                <td className="hint">{p.parent_id ? personById.get(p.parent_id)?.name ?? "—" : "—"}</td>
                <td className="num"><button className="btn danger" disabled={busy} onClick={() => run(() => api.deletePerson(p.id))}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="row" style={{ alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 280 }}>
          <h3>Registered adults ({regAdults.length})</h3>
          <div style={{ maxHeight: 360, overflow: "auto" }}>
            <table>
              <tbody>
                {regAdults.map((m) => (
                  <tr key={m.bsa_number}>
                    <td>{m.name}</td>
                    <td className="hint">{m.email}</td>
                  </tr>
                ))}
                {regAdults.length === 0 && <tr><td className="empty">No roster loaded.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 280 }}>
          <h3>Registered youth ({regYouth.length})</h3>
          <div style={{ maxHeight: 360, overflow: "auto" }}>
            <table>
              <tbody>
                {regYouth.map((m) => (
                  <tr key={m.bsa_number}>
                    <td>{m.name}</td>
                    <td className="hint">{m.patrol}</td>
                    <td className="hint">{m.guardian?.name}</td>
                  </tr>
                ))}
                {regYouth.length === 0 && <tr><td className="empty">No roster loaded.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
