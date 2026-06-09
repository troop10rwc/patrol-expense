import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent } from "react";
import type {
  TripBundle,
  TripSummary,
  Person,
  CostGroup,
  GroupSummary,
  SettlementStatus,
  RosterMember,
  PersonType,
  SnapshotMeta,
  Snapshot,
  ImportPreview,
} from "../shared/types.ts";
import { diffBundles, type BundleDiff, type FieldChange } from "../shared/diff.ts";
import { api, money, HOME_ADDRESS, logoutUrl, UnauthorizedError, type Me } from "./api.ts";
import { BASE_PATH } from "../shared/constants.ts";

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

// Build an in-app href / read the path relative to the mount point.
const appHref = (p: string) => `${BASE_PATH}${p}`;
function appPath(): string {
  const p = location.pathname;
  return (p.startsWith(BASE_PATH) ? p.slice(BASE_PATH.length) : p) || "/";
}

// Authentication is handled by Cloudflare Access (Slack SSO) in front of the
// app, so a request that reaches us is already signed in. We just read the
// identity; the rare 401 means Access didn't pass a valid token.
export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined=loading
  useEffect(() => {
    api.me()
      .then(setMe)
      .catch((e) => { if (e instanceof UnauthorizedError) setMe(null); else { console.error(e); setMe(null); } });
  }, []);

  if (me === undefined) return <div className="t10-app"><div className="wrap">Loading…</div></div>;
  if (me === null) return <div className="t10-app"><NoAccess /></div>;

  const m = appPath().slice(1).match(UUID_RE);
  return (
    <div className="t10-app">
      <TopNav me={me} />
      {m ? <TripView uuid={m[1]} /> : <IndexPage />}
    </div>
  );
}

function NoAccess() {
  return (
    <div className="wrap signin">
      <h1>Troop 10 Expenses</h1>
      <p className="empty">We couldn't read your sign-in. Reload the page, or sign in again.</p>
      <a className="btn" href={logoutUrl}>Sign in again</a>
    </div>
  );
}

// Cross-app product switcher shared across the Troop 10 back office. Each app is
// mounted same-origin under its own base path (Expenses at /expenses, the gear
// list at /gearlist), so these are plain in-page links. `active` is the app we
// are — here, always Expenses.
const APPS: { id: string; label: string; href: string }[] = [
  { id: "expenses", label: "Expenses", href: BASE_PATH },
  { id: "gearlist", label: "Gearlist", href: "/gearlist" },
];
const ACTIVE_APP = "expenses";

function TopNav({ me }: { me: Me }) {
  return (
    <header className="appnav">
      <div className="appnav__inner">
        <a className="appnav__brand" href={appHref("/")}>
          <span className="appnav__badge">T10</span>
          <span className="appnav__brandtext">Troop 10<small>RWC Back Office</small></span>
        </a>
        <nav className="appnav__products" aria-label="Apps">
          {APPS.map((a) => (
            <a
              key={a.id}
              className={`appnav__product${a.id === ACTIVE_APP ? " appnav__product--active" : ""}`}
              aria-current={a.id === ACTIVE_APP ? "page" : undefined}
              href={a.href}
            >
              {a.label}
            </a>
          ))}
        </nav>
        <div className="appnav__spacer" />
        <span className="appnav__user">Signed in as <strong>{me.name}</strong></span>
        <a className="appnav__signout" href={logoutUrl}>Sign out</a>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ Index page
function IndexPage() {
  const [summaries, setSummaries] = useState<TripSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);

  useEffect(() => {
    api.getSummary().then(setSummaries).catch((e) => { setError(String(e)); setSummaries([]); });
  }, []);

  async function seed() {
    setBusy(true);
    setError(null);
    try {
      await api.seed();
      setSummaries(await api.getSummary());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Create the trip, then open it.
  async function createTrip(input: { name: string; trip_date: string | null; slack_url: string | null }) {
    const bundle = await api.createTrip(input);
    location.href = appHref(`/${bundle.trip.uuid}/${bundle.trip.slug}`);
  }

  if (!summaries) return <div className="wrap">Loading…</div>;

  return (
    <div className="wrap">
      <header className="app">
        <div>
          <h1>Patrol Expense</h1>
          <div className="meta"><span>Troop trip expense sheets</span></div>
        </div>
        <div className="row">
          <button className="btn ghost" onClick={() => setShowImport(true)}>Import from Google Sheet</button>
          <button className="btn" onClick={() => setShowNew(true)}>+ New trip</button>
        </div>
      </header>

      {error && <div className="err">{error}</div>}

      {showNew && <NewTripModal onClose={() => setShowNew(false)} onCreate={createTrip} />}
      {showImport && <ImportModal onClose={() => setShowImport(false)} />}

      {summaries.length === 0 ? (
        <div className="card">
          <p className="empty">No trips yet.</p>
          <button className="btn" disabled={busy} onClick={seed}>
            {busy ? "Loading…" : "Load 2026 Winter Lodge sample"}
          </button>
        </div>
      ) : (
        <div className="card">
          <table className="trips">
            <thead>
              <tr>
                <th>Trip</th>
                <th>Date</th>
                <th>Planning doc</th>
                <th>Slack channel</th>
                <th className="num">Total cost</th>
                <th className="num">Reimbursed</th>
              </tr>
            </thead>
            <tbody>
              {summaries.map((s) => (
                <tr key={s.trip.uuid}>
                  <td>
                    <a className="trip-link" href={appHref(`/${s.trip.uuid}/${s.trip.slug}#expenses`)}>
                      {s.trip.name}
                    </a>
                  </td>
                  <td className="hint">{s.trip.trip_date ?? "—"}</td>
                  <td>
                    {s.trip.planning_doc_url
                      ? <a href={s.trip.planning_doc_url} target="_blank" rel="noreferrer">Doc ↗</a>
                      : <span className="hint">—</span>}
                  </td>
                  <td>
                    {s.trip.slack_url
                      ? <a href={s.trip.slack_url} target="_blank" rel="noreferrer">Channel ↗</a>
                      : <span className="hint">—</span>}
                  </td>
                  <td className="num">{money(s.totalCost)}</td>
                  <td className="num">
                    {s.settleTotal > 0
                      ? <span className={`pill ${s.settleDone === s.settleTotal ? "pill-new" : ""}`}>{s.settleDone}/{s.settleTotal} settled</span>
                      : <span className="hint">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewTripModal({
  onClose, onCreate,
}: {
  onClose: () => void;
  onCreate: (input: { name: string; trip_date: string | null; slack_url: string | null }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [slack, setSlack] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: name.trim(), trip_date: date || null, slack_url: slack.trim() || null });
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>New trip</h2>
        {error && <div className="err">{error}</div>}
        <label className="fld" style={{ marginBottom: 10 }}>Name <span className="req">*</span>
          <input
            autoFocus
            value={name}
            disabled={busy}
            placeholder="e.g. 2026 Summer Camp"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          />
        </label>
        <label className="fld" style={{ marginBottom: 10 }}>Date <span className="hint">(optional)</span>
          <input type="date" value={date} disabled={busy} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="fld" style={{ marginBottom: 16 }}>Slack channel <span className="hint">(optional)</span>
          <input
            value={slack}
            disabled={busy}
            placeholder="https://….slack.com/archives/…"
            inputMode="url"
            onChange={(e) => setSlack(e.target.value)}
          />
        </label>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? "Creating…" : "Create trip"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Import an ad-hoc expense Google Sheet into a new trip. Two steps: paste a
// link to get a preview (with inline flags for broken formulas / mismatched
// totals / unknown payers), fix anything flagged, then commit. The commit
// creates the trip and an "Import baseline" snapshot.
function ImportModal({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameOf = (ref: string) => preview?.people.find((p) => p.ref === ref)?.displayName ?? ref;

  async function runPreview() {
    if (!url.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      setPreview(await api.importPreview(url.trim()));
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  function setPayer(groupName: string, idx: number, payerRef: string) {
    setPreview((prev) => prev && {
      ...prev,
      expenseGroups: prev.expenseGroups.map((g) =>
        g.name === groupName
          ? { ...g, receipts: g.receipts.map((r, i) => (i === idx ? { ...r, payerRef: payerRef || null } : r)) }
          : g),
    });
  }

  function setResolution(ref: string, value: string) {
    setPreview((prev) => prev && {
      ...prev,
      people: prev.people.map((p) =>
        p.ref === ref
          ? { ...p, resolution: value === "guest" ? { kind: "guest" } : { kind: "roster", bsa_number: value.slice(4) } }
          : p),
    });
  }

  const blockingCount = preview
    ? preview.expenseGroups.reduce((n, g) => n + g.receipts.filter((r) => r.amount > 0 && !r.payerRef).length, 0)
    : 0;

  async function commit() {
    if (!preview || busy || blockingCount) return;
    setBusy(true); setError(null);
    try {
      const { bundle } = await api.importCommit(preview);
      location.href = appHref(`/${bundle.trip.uuid}/${bundle.trip.slug}#reimbursement`);
    } catch (e) { setError(String(e)); setBusy(false); }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal import-modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ marginTop: 0 }}>Import from Google Sheet</h2>
        {error && <div className="err">{error}</div>}

        {!preview ? (
          <>
            <p className="hint" style={{ marginTop: 0 }}>
              Paste a shareable link to an expense-report sheet. It must be shared
              “Anyone with the link”. We’ll show a preview and flag any problems
              before importing.
            </p>
            <label className="fld" style={{ marginBottom: 16 }}>Google Sheet link <span className="req">*</span>
              <input
                autoFocus value={url} disabled={busy} inputMode="url"
                placeholder="https://docs.google.com/spreadsheets/d/…"
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") runPreview(); }}
              />
            </label>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
              <button className="btn" disabled={busy || !url.trim()} onClick={runPreview}>
                {busy ? "Reading…" : "Preview import"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="card" style={{ marginBottom: 12 }}>
              <strong>{preview.trip.name}</strong>
              <div className="meta">
                <span>{preview.trip.trip_date ?? "no date"}</span>
                {preview.trip.planning_doc_url && (
                  <a href={preview.trip.planning_doc_url} target="_blank" rel="noreferrer">Doc ↗</a>
                )}
              </div>
            </div>

            {preview.flags.length > 0 && (
              <div className="card" style={{ marginBottom: 12 }}>
                <h3 style={{ marginTop: 0 }}>Detected issues</h3>
                <ul className="import-flags">
                  {preview.flags.map((f, i) => (
                    <li key={i}><span className={`pill flag-${f.severity}`}>{f.severity}</span> {f.message}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="card" style={{ marginBottom: 12 }}>
              <h3 style={{ marginTop: 0 }}>Expenses by group</h3>
              <p className="hint" style={{ marginTop: 0 }}>
                Receipts and payers come straight from each patrol/unit tab. Choose a payer for any receipt that’s missing one.
              </p>
              {preview.expenseGroups.map((g) => (
                <div key={g.name} style={{ marginBottom: 12 }}>
                  <div><strong>{g.name}</strong> <span className="hint">· {g.memberRefs.length} attending · {money(g.total)}</span></div>
                  <table className="trips">
                    <tbody>
                      {g.receipts.length === 0 && <tr><td className="hint" colSpan={3}>No receipts on this tab.</td></tr>}
                      {g.receipts.map((rc, i) => (
                        <tr key={i}>
                          <td>{rc.description}</td>
                          <td className="num">{money(rc.amount)}</td>
                          <td>
                            <select
                              value={rc.payerRef ?? ""}
                              className={rc.amount > 0 && !rc.payerRef ? "needs" : ""}
                              onChange={(e) => setPayer(g.name, i, e.target.value)}
                            >
                              <option value="">— choose payer —</option>
                              {preview.people.map((p) => <option key={p.ref} value={p.ref}>{p.displayName}</option>)}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>

            {preview.travelGroups.length > 0 && (
              <div className="card" style={{ marginBottom: 12 }}>
                <h3 style={{ marginTop: 0 }}>Travel</h3>
                <table className="trips">
                  <thead><tr><th>Route</th><th>From → To</th><th className="num">Round trip</th><th className="num">Drivers</th><th className="num">$/driver</th></tr></thead>
                  <tbody>
                    {preview.travelGroups.map((t) => (
                      <tr key={t.name}>
                        <td>{t.name}</td>
                        <td className="hint">{(t.origin ?? "?").split(",")[0]} → {(t.destination ?? "?").split(",")[0]}</td>
                        <td className="num">{t.roundTripMiles != null ? `${t.roundTripMiles} mi` : "—"}</td>
                        <td className="num">{t.driverRefs.length}</td>
                        <td className="num">{money(t.reimbursementPerDriver)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {preview.prepayments.length > 0 && (
              <div className="card" style={{ marginBottom: 12 }}>
                <h3 style={{ marginTop: 0 }}>Pre-reimbursed</h3>
                <table className="trips">
                  <tbody>
                    {preview.prepayments.map((pp, i) => (
                      <tr key={i}><td>{nameOf(pp.personRef)}</td><td className="num">{money(pp.amount)}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {preview.summary.length > 0 && (
              <div className="card" style={{ marginBottom: 12 }}>
                <h3 style={{ marginTop: 0 }}>Summary-tab check</h3>
                <p className="hint" style={{ marginTop: 0 }}>
                  Each person’s “Total Owed” on the Summary tab vs. the sum of its own line items. Red = the sheet shows a broken/mis-formatted value.
                </p>
                <table className="trips">
                  <thead><tr><th>Person</th><th className="num">Summary shows</th><th className="num">Line items sum</th><th></th></tr></thead>
                  <tbody>
                    {preview.summary.map((s, i) => {
                      const ok = s.parsedValue != null && Math.abs(s.parsedValue - s.recomputed) < 0.005;
                      return (
                        <tr key={i}>
                          <td>{nameOf(s.personRef)}</td>
                          <td className="num">
                            {s.parsedValue == null ? <span className="flag-bad">{s.rawValue || "—"}</span> : money(s.parsedValue)}
                          </td>
                          <td className="num">{money(s.recomputed)}</td>
                          <td>{ok ? <span className="pill">✓</span> : <span className="pill flag-warning">check</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {preview.people.some((p) => p.rosterCandidates) && (
              <div className="card" style={{ marginBottom: 12 }}>
                <h3 style={{ marginTop: 0 }}>Resolve people</h3>
                {preview.people.filter((p) => p.rosterCandidates).map((p) => (
                  <label key={p.ref} className="fld" style={{ marginBottom: 8 }}>{p.displayName} (…{p.code})
                    <select
                      value={p.resolution.kind === "roster" ? `bsa:${p.resolution.bsa_number}` : "guest"}
                      onChange={(e) => setResolution(p.ref, e.target.value)}
                    >
                      <option value="guest">Local guest</option>
                      {p.rosterCandidates!.map((c) => (
                        <option key={c.bsa_number} value={`bsa:${c.bsa_number}`}>{c.name} ({c.bsa_number})</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            )}

            <div className="row" style={{ justifyContent: "space-between" }}>
              <button className="btn ghost" disabled={busy} onClick={() => setPreview(null)}>← Back</button>
              <div className="row">
                <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
                <button className="btn" disabled={busy || blockingCount > 0} onClick={commit}>
                  {busy ? "Importing…" : blockingCount ? `Choose ${blockingCount} payer(s)` : "Import as new trip"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Trip view
function TripView({ uuid }: { uuid: string }) {
  const [bundle, setBundle] = useState<TripBundle | null>(null);
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(() => {
    const h = location.hash.slice(1) as Tab;
    return (TAB_ORDER as string[]).includes(h) ? h : "patrols";
  });
  const [titleDraft, setTitleDraft] = useState("");

  useEffect(() => {
    (async () => {
      try {
        setBundle(await api.getTripByUuid(uuid));
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [uuid]);

  // Keep the URL in sync with the loaded trip's slug (uuid is permanent).
  // Preserve the current tab as a hash so links/back stay meaningful.
  useEffect(() => {
    if (!bundle) return;
    const want = appHref(`/${bundle.trip.uuid}/${bundle.trip.slug}#${tab}`);
    if (location.pathname + location.hash !== want) history.replaceState(null, "", want);
  }, [bundle?.trip.uuid, bundle?.trip.slug, tab]);

  useEffect(() => {
    if (bundle) setTitleDraft(bundle.trip.name);
  }, [bundle?.trip.id, bundle?.trip.name]);

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
        <p><a className="back-link" href={appHref("/")}>← All trips</a></p>
        <div className="err">{error ?? "Trip not found."}</div>
      </div>
    );
  }

  const t = bundle.trip;
  return (
    <div className="wrap">
      <p style={{ margin: "0 0 8px" }}><a className="back-link" href={appHref("/")}>← All trips</a></p>
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
// Per-person changes since the latest snapshot: person_id -> { added, field->change }.
interface RowChange { added: boolean; fields: Map<string, FieldChange> }

function Reimbursement({ bundle, run, busy }: TabProps) {
  const tripId = bundle.trip.id;
  const [showAll, setShowAll] = useState(false);
  const [changes, setChanges] = useState<{ since: SnapshotMeta | null; diff: BundleDiff | null } | null>(null);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);

  // Refresh the diff + snapshot list (call after taking/deleting a snapshot).
  const reload = useCallback(async () => {
    const [ch, list] = await Promise.all([api.getChanges(tripId), api.listSnapshots(tripId)]);
    setChanges(ch);
    setSnapshots(list);
  }, [tripId]);

  // Re-derive whenever the live bundle changes (the parent hands a new bundle
  // object after every edit), so highlights always reflect the current state.
  useEffect(() => {
    let cancelled = false;
    api.getChanges(tripId).then((c) => { if (!cancelled) setChanges(c); }).catch(() => {});
    api.listSnapshots(tripId).then((s) => { if (!cancelled) setSnapshots(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, [bundle, tripId]);

  const changeByPerson = useMemo(() => {
    const m = new Map<number, RowChange>();
    for (const r of changes?.diff?.paysheet.rows ?? []) {
      m.set(r.person_id, { added: !!r.added, fields: new Map(r.changes.map((c) => [c.field, c])) });
    }
    return m;
  }, [changes]);

  const rows = bundle.paysheet.rows
    .filter((r) => showAll || r.paid || r.owed || r.prepay)
    .sort((a, b) => a.outstanding - b.outstanding);

  const owedToPeople = rows.filter((r) => r.outstanding > 0.005).reduce((s, r) => s + r.outstanding, 0);
  const owedByPeople = rows.filter((r) => r.outstanding < -0.005).reduce((s, r) => s - r.outstanding, 0);
  const since = changes?.since ?? null;

  return (
    <>
    <Snapshots bundle={bundle} changes={changes} snapshots={snapshots} reload={reload} />
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
            // Call out cells whose value moved since the last snapshot: keep the
            // highlight, and show the explicit before → after underneath.
            const rc = changeByPerson.get(r.person_id);
            const cls = (f: string, base = "num") => rc?.fields.has(f) ? `${base} changed` : base;
            const note = (f: string) => {
              const c = rc?.fields.get(f);
              return c ? <div className="diff-note">{fmtVal(f, c.from)} → {fmtVal(f, c.to)}</div> : null;
            };
            return (
              <tr key={r.person_id} className={`${!r.paid && !r.owed && !r.prepay ? "zero" : ""}${rc?.added ? " row-added" : ""}`}>
                <td>{r.name} {r.code && <span className="hint">({r.code})</span>}{rc?.added && <span className="pill pill-new" style={{ marginLeft: 6 }}>new</span>}</td>
                <td className={cls("paid")}>{r.paid ? money(r.paid) : ""}{note("paid")}</td>
                <td className={cls("owed")}>{r.owed ? money(r.owed) : ""}{note("owed")}</td>
                <td className={cls("prepay")}>{r.prepay ? money(r.prepay) : ""}{note("prepay")}</td>
                <td className={cls("outstanding")}>{label}</td>
                <td className={rc?.fields.has("status") ? "changed" : ""}>
                  <select
                    className={`status-${r.status}`}
                    value={r.status}
                    disabled={busy}
                    onChange={(e) =>
                      run(() => api.setStatus(bundle.trip.id, r.person_id, e.target.value as SettlementStatus))
                    }
                  >
                    {/* Direction-appropriate terminal state: the troop pays a
                        person it owes; it receives from a person who owes it. */}
                    <option value="none">—</option>
                    <option value="requested">requested</option>
                    {(o > 0.005 || r.status === "paid") && <option value="paid">paid</option>}
                    {(o < -0.005 || r.status === "received") && <option value="received">received</option>}
                  </select>
                  {note("status")}
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
        {since && changes?.diff?.hasChanges && <> <span className="changed-key">Highlighted</span> cells show <em>before → after</em> for changes since the snapshot taken {fmtTime(since.created_at)}.</>}
      </small></p>
    </div>
    </>
  );
}

// ------------------------------------------------------------------ Snapshots
const MONEY_FIELDS = new Set([
  "amount", "paid", "owed", "prepay", "balance", "outstanding", "totalExpenses", "totalPrepaid",
]);
function fmtVal(field: string, v: unknown): string {
  if (typeof v === "number" && MONEY_FIELDS.has(field)) return money(v);
  if (v == null || v === "") return "—";
  return String(v);
}
function fmtChange(ch: FieldChange): string {
  return `${ch.field}: ${fmtVal(ch.field, ch.from)} → ${fmtVal(ch.field, ch.to)}`;
}
function fmtTime(s: string): string {
  // SQLite datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC.
  const d = new Date(s.replace(" ", "T") + "Z");
  return isNaN(d.getTime()) ? s : d.toLocaleString();
}

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Accounting-style money: negatives in parentheses, e.g. -208.5 -> "($208.50)".
function accounting(n: number): string {
  const s = `$${Math.abs(n).toFixed(2)}`;
  return n < 0 ? `(${s})` : s;
}

// CSV of a snapshot's reimbursement summary (its frozen paysheet). Money is
// written as raw signed numbers (spreadsheet-friendly). When a previous snapshot
// is supplied, a "Net change vs prev" column gives each person's net movement.
function buildSummaryCsv(b: TripBundle, prev?: TripBundle | null): string {
  const prevNet = prev ? netFromBundle(prev) : null;
  const header = ["Adult", "Code", "Paid", "Owes (share)", "Pre-reimbursed", "Net"];
  if (prevNet) header.push("Net change vs prev");
  header.push("Settlement");

  const rows: unknown[][] = [header];
  for (const r of b.paysheet.rows) {
    if (!(r.paid || r.owed || r.prepay)) continue;
    const cells: unknown[] = [r.name, r.code ?? "", round2(r.paid), round2(r.owed), round2(r.prepay), round2(r.outstanding)];
    if (prevNet) {
      const pv = prevNet(r.person_id);
      cells.push(pv != null ? round2(r.outstanding - pv) : "");
    }
    cells.push(r.status);
    rows.push(cells);
  }
  return rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Resolve a person id to a name using a specific bundle's people. */
function nameFromBundle(b: TripBundle): (id: number) => string {
  const m = new Map(b.people.map((p) => [p.id, p.name] as const));
  return (id) => m.get(id) ?? `#${id}`;
}

/** Resolve a person id to their net (outstanding) in a specific bundle. */
function netFromBundle(b: TripBundle): (id: number) => number | undefined {
  const m = new Map(b.paysheet.rows.map((r) => [r.person_id, r.outstanding] as const));
  return (id) => m.get(id);
}

/** Itemized human-readable list of a diff.
 * mode "full"   — every change, including each person's recomputed paysheet row.
 * mode "inputs" — only the edits that were actually made (expenses, prepayments,
 *   people, settlement status) plus totals; the derived per-person share/net
 *   recalculations are left out (those show up in the summary table's ± column). */
function DiffList({ diff, nameOf, netOf, mode = "full" }: { diff: BundleDiff; nameOf: (id: number) => string; netOf?: (id: number) => number | undefined; mode?: "full" | "inputs" }) {
  // " — paid $208.50" / " — received $30.00" for a settlement that reached a
  // terminal state, using the person's net at the "to" side of the diff.
  const settleAmt = (r: BundleDiff["paysheet"]["rows"][number], st?: FieldChange) => {
    if (!st || (st.to !== "paid" && st.to !== "received")) return "";
    const net = netOf?.(r.person_id);
    return net == null ? "" : ` — ${st.to === "paid" ? "paid" : "received"} ${money(Math.abs(net))}`;
  };
  return (
    <ul className="diff">
      {diff.expenses.added.map((e) => (
        <li key={`ea${e.id}`} className="pos">+ Expense “{e.description}” {money(e.amount)} (paid by {nameOf(e.payer_id)})</li>
      ))}
      {diff.expenses.removed.map((e) => (
        <li key={`er${e.id}`} className="neg">− Expense “{e.description}” {money(e.amount)}</li>
      ))}
      {diff.expenses.changed.map((e) => (
        <li key={`ec${e.id}`}>✎ Expense “{e.description}” — {e.changes.map(fmtChange).join(", ")}</li>
      ))}
      {diff.prepayments.added.map((p) => (
        <li key={`pa${p.id}`} className="pos">+ Pre-reimbursement {money(p.amount)} to {nameOf(p.person_id)}</li>
      ))}
      {diff.prepayments.removed.map((p) => (
        <li key={`pr${p.id}`} className="neg">− Pre-reimbursement {money(p.amount)}</li>
      ))}
      {diff.people.added.map((p) => (
        <li key={`na${p.id}`} className="pos">+ Person {p.name}</li>
      ))}
      {diff.people.removed.map((p) => (
        <li key={`nr${p.id}`} className="neg">− Person {p.name}</li>
      ))}
      {diff.paysheet.rows
        .filter((r) => mode === "full" || r.added || r.removed || r.changes.some((c) => c.field === "status"))
        .map((r) => {
          if (r.added) return <li key={`ps${r.person_id}`} className="pos">+ {r.name} added to paysheet</li>;
          if (r.removed) return <li key={`ps${r.person_id}`} className="neg">− {r.name} removed from paysheet</li>;
          const st = r.changes.find((c) => c.field === "status");
          if (mode === "inputs") {
            return <li key={`ps${r.person_id}`}>{r.name}: {st ? fmtChange(st) : ""}{settleAmt(r, st)}</li>;
          }
          return <li key={`ps${r.person_id}`}>{r.name}: {r.changes.map(fmtChange).join(", ")}{settleAmt(r, st)}</li>;
        })}
      {diff.paysheet.totalExpenses && <li>Total expenses: {fmtChange(diff.paysheet.totalExpenses)}</li>}
      {diff.paysheet.totalPrepaid && <li>Pre-reimbursed total: {fmtChange(diff.paysheet.totalPrepaid)}</li>}
    </ul>
  );
}

interface SnapshotsProps {
  bundle: TripBundle;
  changes: { since: SnapshotMeta | null; diff: BundleDiff | null } | null;
  snapshots: SnapshotMeta[];
  reload: () => Promise<void>;
}

function Snapshots({ bundle, changes, snapshots, reload }: SnapshotsProps) {
  const tripId = bundle.trip.id;
  const { personById } = useMaps(bundle);
  const [label, setLabel] = useState("");
  const [snapBusy, setSnapBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Snapshot | null>(null);
  // The diff that produced the open snapshot (vs the one before it). hasPrev is
  // false for the very first snapshot (nothing to compare against).
  const [viewingDiff, setViewingDiff] = useState<{ diff: BundleDiff | null; hasPrev: boolean } | null>(null);

  async function takeSnapshot() {
    setSnapBusy(true);
    setErr(null);
    try {
      await api.takeSnapshot(tripId, label.trim() || undefined);
      setLabel("");
      await reload();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSnapBusy(false);
    }
  }

  async function remove(sid: number) {
    if (!confirm("Delete this snapshot? This cannot be undone.")) return;
    setSnapBusy(true);
    setErr(null);
    try {
      await api.deleteSnapshot(sid);
      if (viewing?.id === sid) { setViewing(null); setViewingDiff(null); }
      await reload();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSnapBusy(false);
    }
  }

  async function open(sid: number) {
    setErr(null);
    if (viewing?.id === sid) { setViewing(null); setViewingDiff(null); return; } // toggle closed
    try {
      const snap = await api.getSnapshot(sid);
      // The previous (older) snapshot is the next row in the newest-first list.
      const idx = snapshots.findIndex((x) => x.id === sid);
      const prevMeta = idx >= 0 ? snapshots[idx + 1] : undefined;
      const info = prevMeta
        ? { diff: diffBundles((await api.getSnapshot(prevMeta.id)).bundle, snap.bundle), hasPrev: true }
        : { diff: null, hasPrev: false };
      setViewing(snap);
      setViewingDiff(info);
    } catch (e) {
      setErr(String(e));
    }
  }

  // Download a CSV of the snapshot's reimbursement summary (its frozen
  // paysheet), with each person's net change vs the previous snapshot.
  async function downloadSummaryCsv(s: SnapshotMeta) {
    setErr(null);
    try {
      const snap = await api.getSnapshot(s.id);
      const idx = snapshots.findIndex((x) => x.id === s.id);
      const prevMeta = idx >= 0 ? snapshots[idx + 1] : undefined;
      const prev = prevMeta ? (await api.getSnapshot(prevMeta.id)).bundle : null;
      downloadCsv(`reimbursement-summary-snapshot-${s.id}-${bundle.trip.slug}.csv`, buildSummaryCsv(snap.bundle, prev));
    } catch (e) {
      setErr(String(e));
    }
  }

  const payerName = (id: number) => personById.get(id)?.name ?? `#${id}`;
  const diff = changes?.diff;

  return (
    <div className="card">
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>Snapshots</h2>
        <div className="spacer" />
        <input
          className="sm"
          style={{ width: 160 }}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (optional)"
          disabled={snapBusy}
        />
        <button className="btn" disabled={snapBusy} onClick={takeSnapshot}>
          {snapBusy ? "Saving…" : "Take snapshot"}
        </button>
      </div>

      {err && <div className="err">{err}</div>}

      {/* Changes since the latest snapshot */}
      {changes && !changes.since && (
        <p className="hint">No snapshots yet. Take one to freeze the current reimbursement state and track changes from here.</p>
      )}
      {changes?.since && diff && !diff.hasChanges && (
        <p className="hint">No changes since {fmtTime(changes.since.created_at)}.</p>
      )}
      {changes?.since && diff?.hasChanges && (
        <div style={{ marginBottom: 8 }}>
          <h3 style={{ marginBottom: 6 }}>Changes since {fmtTime(changes.since.created_at)}</h3>
          <DiffList diff={diff} nameOf={payerName} netOf={netFromBundle(bundle)} />
        </div>
      )}

      {/* History — clicking a row expands the changes that went into that
          snapshot (its diff vs the previous snapshot) inline below it. */}
      {snapshots.length > 0 && (
        <table>
          <thead>
            <tr><th>Taken</th><th>Label</th><th>By</th><th className="num">Total</th><th className="num">Outstanding</th><th></th></tr>
          </thead>
          <tbody>
            {snapshots.map((s) => {
              const isOpen = viewing?.id === s.id;
              return (
                <Fragment key={s.id}>
                  <tr className={isOpen ? "snapshot-open" : ""}>
                    <td><a href="#" onClick={(e) => { e.preventDefault(); open(s.id); }}>{isOpen ? "▾ " : "▸ "}{fmtTime(s.created_at)}</a></td>
                    <td>{s.label || <span className="hint">—</span>}</td>
                    <td>{s.created_by || <span className="hint">—</span>}</td>
                    <td className="num">{money(s.totalExpenses)}</td>
                    <td className="num">{money(s.outstanding)}</td>
                    <td className="num snapshot-actions">
                      <a href="#" title="Download this snapshot's reimbursement summary as CSV" onClick={(e) => { e.preventDefault(); downloadSummaryCsv(s); }}>⬇ CSV</a>
                      <button className="btn danger" disabled={snapBusy} onClick={() => remove(s.id)}>Delete</button>
                    </td>
                  </tr>
                  {isOpen && viewing && (() => {
                    // Per-person net movement vs the previous snapshot, for the ± column.
                    const netDelta = new Map<number, number>();
                    for (const dr of viewingDiff?.diff?.paysheet.rows ?? []) {
                      const o = dr.changes.find((c) => c.field === "outstanding");
                      if (o && typeof o.from === "number" && typeof o.to === "number") netDelta.set(dr.person_id, round2(o.to - o.from));
                    }
                    const hasPrev = !!viewingDiff?.hasPrev;
                    return (
                      <tr className="snapshot-detail">
                        <td colSpan={6}>
                          <h4 style={{ margin: "0 0 6px" }}>Changes captured in this snapshot</h4>
                          {!hasPrev ? (
                            <p className="hint">First snapshot — this is the baseline; there's nothing earlier to compare against.</p>
                          ) : viewingDiff?.diff?.hasChanges ? (
                            <DiffList diff={viewingDiff.diff} nameOf={nameFromBundle(viewing.bundle)} netOf={netFromBundle(viewing.bundle)} mode="inputs" />
                          ) : (
                            <p className="hint">No changes from the previous snapshot.</p>
                          )}
                          <h4 style={{ margin: "10px 0 6px" }}>Reimbursement summary</h4>
                          <table>
                            <thead>
                              <tr>
                                <th>Adult</th><th className="num">Paid</th><th className="num">Owes (share)</th>
                                <th className="num">Pre-reimbursed</th><th className="num">Net</th>
                                {hasPrev && <th className="num">± vs prev</th>}
                                <th>Settlement</th>
                              </tr>
                            </thead>
                            <tbody>
                              {viewing.bundle.paysheet.rows.filter((r) => r.paid || r.owed || r.prepay).map((r) => {
                                const o = r.outstanding;
                                const lbl = Math.abs(o) < 0.005
                                  ? <span className="settled">—</span>
                                  : <span className={o > 0 ? "pos" : "neg"}>{accounting(o)}</span>;
                                const nd = netDelta.get(r.person_id);
                                return (
                                  <tr key={r.person_id}>
                                    <td>{r.name} {r.code && <span className="hint">({r.code})</span>}</td>
                                    <td className="num">{r.paid ? money(r.paid) : ""}</td>
                                    <td className="num">{r.owed ? money(r.owed) : ""}</td>
                                    <td className="num">{r.prepay ? money(r.prepay) : ""}</td>
                                    <td className="num">{lbl}</td>
                                    {hasPrev && (
                                      <td className="num">
                                        {nd != null && Math.abs(nd) > 0.005 && (
                                          <span className={nd > 0 ? "pos" : "neg"}>{accounting(nd)}</span>
                                        )}
                                      </td>
                                    )}
                                    <td>{r.status}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                          <p><small className="hint">Read-only — frozen state as of {fmtTime(viewing.created_at)}{hasPrev ? "; ± shows the change vs the prior snapshot" : ""}.</small></p>
                        </td>
                      </tr>
                    );
                  })()}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
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
  value, onChange, onPick, onBlur, busy, placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick?: (v: string) => void;
  onBlur?: () => void;
  busy?: boolean;
  placeholder?: string;
}) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  // Only query after the user actually types, so a prefilled value (e.g. the
  // default "From" address) never fires a Google request on mount. Using a ref
  // gated on real input — rather than "skip first render" — is robust against
  // StrictMode's double-invoked effects in dev.
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (!dirtyRef.current) return;
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
    dirtyRef.current = false; // selecting isn't "typing"; don't re-query
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
        onChange={(e) => { dirtyRef.current = true; onChange(e.target.value); }}
        onFocus={() => suggestions.length && setOpen(true)}
        onBlur={() => { setTimeout(() => setOpen(false), 150); onBlur?.(); }}
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

  type RouteDraft = typeof draft;
  const snapshot = (d: RouteDraft) => JSON.stringify(d);
  const lastSaved = useRef(snapshot(draft));

  // Auto-save the route's calculator fields. Persists only when something
  // actually changed, then the worker re-materializes each driver's
  // reimbursement into the paysheet.
  function persistIfChanged(d: RouteDraft, oneWay?: number) {
    const s = snapshot(d);
    if (s === lastSaved.current) return;
    lastSaved.current = s;
    run(() =>
      api.updateGroup(group.id, {
        name: group.name,
        origin: d.origin,
        destination: d.destination,
        one_way_miles: oneWay ?? (d.round_trip_miles ? Math.round((d.round_trip_miles / 2) * 10) / 10 : null),
        round_trip_miles: Number(d.round_trip_miles),
        tolls: Number(d.tolls),
        rate_override:
          d.rate_override == null || d.rate_override === ("" as unknown) ? null : Number(d.rate_override),
        cost_group_id: d.cost_group_id,
      }),
    );
  }

  // Compute most-direct driving distance via the Worker proxy, set round-trip
  // miles (= one-way × 2), and auto-save.
  async function calcDistance(next: RouteDraft) {
    if (!next.origin.trim() || !next.destination.trim()) { persistIfChanged(next); return; }
    setCalc({ loading: true });
    try {
      const r = await api.geoDistance(next.origin, next.destination);
      const withMiles = { ...next, round_trip_miles: r.round_trip_miles };
      setDraft(withMiles);
      setCalc({ loading: false, oneWay: r.one_way_miles });
      persistIfChanged(withMiles, r.one_way_miles);
    } catch (e) {
      setCalc({ loading: false, err: String(e) });
      persistIfChanged(next); // still save the address even if distance lookup fails
    }
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
            onPick={(v) => calcDistance({ ...draft, origin: v })}
            onBlur={() => persistIfChanged(draft)}
          />
        </label>
        <label className="fld" style={{ flex: 1, minWidth: 180 }}>To
          <AddressInput
            value={draft.destination}
            busy={busy}
            placeholder="Destination address"
            onChange={(v) => setDraft((d) => ({ ...d, destination: v }))}
            onPick={(v) => calcDistance({ ...draft, destination: v })}
            onBlur={() => persistIfChanged(draft)}
          />
        </label>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <label className="fld">Round-trip mi
          <input className="sm" value={draft.round_trip_miles}
            onChange={(e) => setDraft({ ...draft, round_trip_miles: Number(e.target.value) })}
            onBlur={() => persistIfChanged(draft)} inputMode="decimal" />
        </label>
        <button
          className="btn ghost"
          style={{ alignSelf: "flex-end" }}
          disabled={busy || calc.loading || !draft.origin.trim() || !draft.destination.trim()}
          onClick={() => calcDistance(draft)}
          title="Most-direct driving distance via Google Maps"
        >
          {calc.loading ? "…" : "↻ distance"}
        </button>
        <label className="fld">Tolls
          <input className="sm" value={draft.tolls}
            onChange={(e) => setDraft({ ...draft, tolls: Number(e.target.value) })}
            onBlur={() => persistIfChanged(draft)} inputMode="decimal" />
        </label>
        <label className="fld">Rate ($/mi)
          <input className="sm" value={draft.rate_override ?? ""} placeholder={bundle.trip.mileage_rate.toFixed(2)}
            onChange={(e) => setDraft({ ...draft, rate_override: e.target.value === "" ? null : Number(e.target.value) })}
            onBlur={() => persistIfChanged(draft)} inputMode="decimal" />
        </label>
        <label className="fld">Charge to
          <select value={draft.cost_group_id ?? ""}
            onChange={(e) => {
              const next = { ...draft, cost_group_id: e.target.value ? Number(e.target.value) : null };
              setDraft(next);
              persistIfChanged(next);
            }}>
            {costGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </label>
        <div className="fld">
          <span>Per driver</span>
          <div className="v" style={{ fontSize: 18, fontWeight: 600 }}>{money(reimb)}</div>
        </div>
      </div>
      {(calc.oneWay != null || calc.err) && (
        <p style={{ margin: "8px 0 0" }}>
          {calc.err
            ? <small className="neg">Distance lookup failed: {calc.err}</small>
            : <small className="hint">Most direct route: {calc.oneWay} mi one-way · {draft.round_trip_miles} mi round-trip · saved.</small>}
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
