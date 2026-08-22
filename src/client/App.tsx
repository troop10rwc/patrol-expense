import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent } from "react";
import type {
  TripBundle,
  TripSummary,
  Person,
  Expense,
  CostGroup,
  GroupSummary,
  SettlementStatus,
  RosterMember,
  PersonType,
  SnapshotMeta,
  Snapshot,
  ImportPreview,
  PersonStatement,
  StatementEvent,
  PersonNotice,
  NoticeLink,
  Correction,
  CorrectionKind,
  PublicStatement,
  PaysheetRow,
} from "../shared/types.ts";
import { diffBundles, type BundleDiff, type FieldChange } from "../shared/diff.ts";
import { api, publicApi, money, HOME_ADDRESS, loginUrl, logoutUrl, UnauthorizedError, type Me } from "./api.ts";
import { BASE_PATH } from "../shared/constants.ts";
import { BackOfficeTopNav } from "@troop10rwc/ui";

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

// A shared statement link (/s/<token>) is matched before anything else: it
// exists precisely so someone with no troop account — a parent emailed a link —
// can see why they owe, so it must skip the sign-in bounce in BackOffice below.
const PUBLIC_STATEMENT_RE = /^\/s\/([A-Za-z0-9_-]{16,64})$/;

export function App() {
  const shared = appPath().match(PUBLIC_STATEMENT_RE);
  if (shared) return <div className="t10-app"><PublicStatementPage token={shared[1]} /></div>;
  return <BackOffice />;
}

// Member sessions are minted by the shared identity service (id.troop10rwc.org)
// and validated server-side per request (see src/worker/auth.ts). On load we ask
// who we are; a 401 means no live session, so we bounce the browser to the
// identity service's login page, which returns here once signed in.
function BackOffice() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined=loading
  useEffect(() => {
    api.me()
      .then(setMe)
      .catch((e) => {
        if (e instanceof UnauthorizedError && e.authOrigin) {
          window.location.href = loginUrl(e.authOrigin);
          return;
        }
        if (!(e instanceof UnauthorizedError)) console.error(e);
        setMe(null);
      });
  }, []);

  if (me === undefined) return <div className="t10-app"><div className="wrap">Loading…</div></div>;
  if (me === null) return <div className="t10-app"><NoAccess /></div>;

  const path = appPath();
  const m = path.slice(1).match(UUID_RE);
  const view = path === "/me" ? <StatementPage /> : m ? <TripView uuid={m[1]} /> : <IndexPage />;
  return (
    <div className="t10-app">
      <BackOfficeTopNav active="expenses" user={{ name: me.name }} logoutUrl={logoutUrl(me.authOrigin)} />
      {view}
    </div>
  );
}

function NoAccess() {
  return (
    <div className="wrap signin">
      <h1>Troop 10 Expenses</h1>
      <p className="empty">We couldn't start a sign-in. Reload the page to try again.</p>
      <a className="btn" href={location.href}>Reload</a>
    </div>
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
          <a className="btn ghost" href={appHref("/me")}>My statement</a>
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

// --------------------------------------------------------------- My statement
// The signed-in member's own expenses across every trip. One prominent grand
// total (flagged "Projected" when trips are still collecting), then a card per
// event showing the current owed/due and the snapshot deltas that explain how
// the number moved. Only this member's figures are shown.
function StatementPage() {
  const [stmt, setStmt] = useState<PersonStatement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.myStatement().then(setStmt).catch((e) => setError(String(e)));
  }, []);

  if (error)
    return (
      <div className="wrap">
        <div className="err">{error}</div>
        <p><a href={appHref("/")}>← All trips</a></p>
      </div>
    );
  if (!stmt) return <div className="wrap">Loading…</div>;

  return (
    <div className="wrap">
      <header className="app">
        <div>
          <h1>My statement</h1>
          <div className="meta"><span>Your expenses across every trip</span></div>
        </div>
        <div className="row"><a className="btn ghost" href={appHref("/")}>← All trips</a></div>
      </header>

      {!stmt.person.matched ? (
        <div className="card">
          <p className="empty">
            We couldn't match your sign-in{stmt.person.email ? ` (${stmt.person.email})` : ""} to a member on any trip.
          </p>
          <p className="hint">Statements are keyed to your roster email. If it looks wrong, ask a leader to check the roster.</p>
        </div>
      ) : (
        <>
          <StatementTotal stmt={stmt} />
          {stmt.events.map((ev) => <StatementEventCard key={ev.trip.uuid} ev={ev} />)}
        </>
      )}
    </div>
  );
}

// Signed delta with an explicit + / − (money() only shows − for negatives).
function signed(n: number): string {
  return `${n >= 0 ? "+" : "−"}${money(Math.abs(n))}`;
}

function StatementTotal({ stmt }: { stmt: PersonStatement }) {
  const t = stmt.totalOutstanding;
  const settled = Math.abs(t) < 0.005;
  const label = settled ? "You're all settled" : t > 0 ? "Troop owes you" : "You owe the troop";
  return (
    <div className="card stmt-total">
      <div className="stmt-total-label">
        {label}
        {stmt.projected && (
          <span className="pill" title="Includes trips still collecting expenses (not yet snapshotted)">Projected</span>
        )}
      </div>
      <div className={`stmt-total-amt ${t < 0 ? "neg" : ""}`}>{money(Math.abs(t))}</div>
      {stmt.projected && (
        <p className="hint">Some trips haven't been finalized in a snapshot yet, so this total may still change as expenses are collected.</p>
      )}
    </div>
  );
}

function StatementEventCard({ ev }: { ev: StatementEvent }) {
  const o = ev.outstanding;
  const settled = Math.abs(o) < 0.005;
  const dir = settled ? "Settled" : o > 0 ? "Owed to you" : "You owe";
  const showLive = ev.history.length > 0 && Math.abs(ev.liveDelta) > 0.005;
  return (
    <div className="card stmt-event">
      <div className="row stmt-event-head">
        <a className="trip-link" href={appHref(`/${ev.trip.uuid}/${ev.trip.slug}#reimbursement`)}>{ev.trip.name}</a>
        <span className="hint">{ev.trip.trip_date ?? "—"}</span>
        {ev.projected && (
          <span className="pill" title="Live figures differ from the latest snapshot, or none has been taken">Projected</span>
        )}
        {ev.status !== "none" && <span className="pill pill-new">{ev.status}</span>}
      </div>

      <div className="stmt-event-amt">
        <span className="hint">{dir}</span>{" "}
        <strong className={o < 0 ? "neg" : ""}>{money(Math.abs(o))}</strong>
      </div>
      <div className="hint stmt-breakdown">
        Paid {money(ev.paid)} · Share {money(ev.owed)}
        {ev.reimbursed ? ` · Paid back ${money(ev.reimbursed)}` : ""}
        {ev.prepay ? ` · Pre-reimbursed ${money(ev.prepay)}` : ""}
      </div>

      <div className="stmt-hist">
        {ev.history.length === 0 ? (
          <div className="stmt-hist-row">
            <span className="hint">No snapshot taken yet — projected from current expenses.</span>
          </div>
        ) : (
          ev.history.map((h, i) => (
            <div className="stmt-hist-row" key={h.snapshot_id}>
              <span className="stmt-hist-when">
                {fmtTime(h.created_at)}
                {h.label ? ` · ${h.label}` : i === 0 ? " · baseline" : ""}
              </span>
              <span className="stmt-hist-out">{money(h.outstanding)}</span>
              <span className={`stmt-hist-delta ${h.delta < 0 ? "neg" : ""}`}>{i === 0 ? "" : signed(h.delta)}</span>
            </div>
          ))
        )}
        {showLive && (
          <div className="stmt-hist-row projected">
            <span className="stmt-hist-when">Since last snapshot <span className="hint">(not captured)</span></span>
            <span className="stmt-hist-out">{money(ev.outstanding)}</span>
            <span className={`stmt-hist-delta ${ev.liveDelta < 0 ? "neg" : ""}`}>{signed(ev.liveDelta)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------- Shared statement
// What a reimbursement email links to. No sign-in: the token in the URL is the
// credential, so this renders for a parent with no troop account.
//
// Every figure here is re-derived from the same frozen snapshot the email was
// cut from — the page and the email can't drift apart — except the "other
// trips" roll-up, which is current by nature and labelled as such.
function PublicStatementPage({ token }: { token: string }) {
  const [st, setSt] = useState<PublicStatement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jumped = useRef(false);

  useEffect(() => {
    publicApi.statement(token).then(setSt).catch((e) => setError(String(e)));
  }, [token]);

  // The email's "report it here" link targets #report, but the form doesn't
  // exist until the statement has loaded — by then the browser has long since
  // given up on the fragment. Do the jump ourselves, once, so that link lands
  // on the form instead of the top of the page.
  useEffect(() => {
    if (!st || jumped.current || location.hash !== "#report") return;
    jumped.current = true;
    document.getElementById("report")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [st]);

  if (error)
    return (
      <div className="wrap shared">
        <h1>Troop 10 Expenses</h1>
        <div className="err">{error}</div>
        <p className="hint">
          Statement links are tied to a specific summary. If this one has been replaced or withdrawn,
          ask the trip's treasurer to send you a fresh one.
        </p>
      </div>
    );
  if (!st) return <div className="wrap shared">Loading…</div>;

  const n = st.notice;
  const owes = n.net < -0.005;
  const owed = n.net > 0.005;

  return (
    <div className="wrap shared">
      <header className="shared-head">
        <h1>{n.trip.name}</h1>
        <div className="meta">
          <span>Expense statement for {n.person.name}</span>
          {n.trip.trip_date && <span>{n.trip.trip_date}</span>}
        </div>
      </header>

      <div className="card stmt-total">
        <div className="stmt-total-label">
          {owes ? "You owe the troop" : owed ? "The troop owes you" : "You're all settled"}
        </div>
        <div className={`stmt-total-amt ${owes ? "neg" : ""}`}>{money(Math.abs(n.net))}</div>
        <p className="hint">
          Frozen from the summary taken {fmtTime(n.snapshot.created_at)}
          {n.snapshot.label ? ` (${n.snapshot.label})` : ""}. Later changes to the trip won't move
          this number until a new statement is sent.
        </p>
      </div>

      {st.otherEvents.length > 0 && (
        <div className="card">
          <h2>Everything you owe</h2>
          <table>
            <tbody>
              <tr>
                <td>{n.trip.name} <span className="hint">(this statement)</span></td>
                <td className="num">{accounting(n.net)}</td>
              </tr>
              {st.otherEvents.map((e) => (
                <tr key={e.name}>
                  <td>{e.name} <span className="hint">{e.trip_date ?? "current figures"}</span></td>
                  <td className="num">{accounting(e.outstanding)}</td>
                </tr>
              ))}
              <tr className="shared-total">
                <td><strong>Total</strong></td>
                <td className="num"><strong className={st.grandTotal < 0 ? "neg" : "pos"}>{accounting(st.grandTotal)}</strong></td>
              </tr>
            </tbody>
          </table>
          <p><small className="hint">
            Amounts in parentheses are what you owe. Other trips show their current figures, which
            can still move as those trips collect expenses.
          </small></p>
        </div>
      )}

      {n.shareLines.length > 0 && (
        <div className="card">
          <h2>Your share of trip costs — {money(n.owed)}</h2>
          <p className="hint">
            The trip cost {money(n.tripTotal)} in total. Each group's costs are split evenly across
            everyone in it; you cover your own share plus any youth you're responsible for.
          </p>
          {n.shareLines.map((l) => (
            <div className="share-line" key={l.group_id}>
              <div className="share-head">
                <strong>{l.groupName}</strong>
                <span className="num">{money(l.subtotal)}</span>
              </div>
              <div className="hint">
                {money(l.groupTotal)} split {l.totalShares} ways = {money(l.perShare)} each; you cover{" "}
                {l.shareCount}
                {l.covers.length > 0 && ` (${l.covers.join(", ")})`}
              </div>
              {l.expenses.length > 0 && (
                <details>
                  <summary>{l.expenses.length} receipt{l.expenses.length === 1 ? "" : "s"} in this group</summary>
                  <table>
                    <tbody>
                      {l.expenses.map((e, i) => (
                        <tr key={i}>
                          <td>{e.description}</td>
                          <td className="hint">paid by {e.payer}</td>
                          <td className="num">{money(e.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </div>
          ))}
        </div>
      )}

      {n.paidLines.length > 0 && (
        <div className="card">
          <h2>
            Receipts you paid — {money(n.paid)}
            {n.reimbursed > 0 && <span className="hint"> · {money(n.reimbursed)} already paid back</span>}
          </h2>
          <table>
            <tbody>
              {n.paidLines.map((l, i) => (
                <tr key={i} className={l.reimbursed ? "reimbursed" : undefined}>
                  <td>{l.description}</td>
                  <td className="hint">
                    {l.groupName}
                    {l.reimbursed && <span className="pill pill-new" style={{ marginLeft: 6 }}>paid back</span>}
                  </td>
                  <td className="num">{money(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {n.prepayLines.length > 0 && (
        <div className="card">
          <h2>Already reimbursed — {money(n.prepay)}</h2>
          <table>
            <tbody>
              {n.prepayLines.map((l, i) => (
                <tr key={i}><td>{l.note || "Reimbursement"}</td><td className="num">{money(l.amount)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card">
        <h2>How this adds up</h2>
        <table>
          <tbody>
            <tr><td>Receipts you paid</td><td className="num">{money(n.paid)}</td></tr>
            <tr><td>Your share of costs</td><td className="num">−{money(n.owed)}</td></tr>
            {n.reimbursed > 0 && (
              <tr><td>Receipts already paid back to you</td><td className="num">−{money(n.reimbursed)}</td></tr>
            )}
            {n.prepay > 0 && <tr><td>Already reimbursed to you</td><td className="num">−{money(n.prepay)}</td></tr>}
            <tr className="shared-total">
              <td><strong>{owes ? "You owe" : owed ? "Owed to you" : "Settled"}</strong></td>
              <td className="num"><strong className={owes ? "neg" : "pos"}>{money(Math.abs(n.net))}</strong></td>
            </tr>
          </tbody>
        </table>
      </div>

      {owes && n.paymentInstructions && (
        <div className="card">
          <h2>How to pay</h2>
          <p className="pay-instructions">{n.paymentInstructions}</p>
        </div>
      )}

      <CorrectionForm token={token} statement={st} onUpdate={setSt} />
    </div>
  );
}

const CORRECTION_LABELS: Record<CorrectionKind, string> = {
  missing_expense: "A receipt of mine is missing",
  wrong_amount: "An amount looks wrong",
  not_mine: "I shouldn't be in one of these groups",
  other: "Something else",
};

// Report a correction from the shared page. This only ever files a claim for the
// treasurer — it can't change an expense — so it's safe to expose to a link
// holder, and the reporter gets their filed reports back for confirmation.
function CorrectionForm({
  token, statement, onUpdate,
}: {
  token: string;
  statement: PublicStatement;
  onUpdate: (s: PublicStatement) => void;
}) {
  const [kind, setKind] = useState<CorrectionKind>("missing_expense");
  const [message, setMessage] = useState("");
  const [amount, setAmount] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    if (!message.trim() || busy) return;
    setBusy(true); setErr(null);
    try {
      const next = await publicApi.reportCorrection(token, {
        kind,
        message: message.trim(),
        amount: amount.trim() ? Number(amount) : null,
        reporter_name: name.trim() || undefined,
      });
      onUpdate(next);
      setMessage(""); setAmount(""); setDone(true);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    // #report is the anchor the email's "report it here" link targets, so that
    // link lands on the form rather than the top of the page.
    <div className="card" id="report">
      <h2>Something missing or wrong?</h2>
      <p className="hint">
        Tell us here and the trip's treasurer will review it — or just reply to the email that
        brought you here, which reaches the same person and lets you attach a photo of the receipt.
        Filing a report doesn't change any amount by itself.
      </p>

      {statement.reported.length > 0 && (
        <ul className="reported">
          {statement.reported.map((r, i) => (
            <li key={i}>
              <span className={`pill ${r.status === "resolved" ? "pill-new" : ""}`}>{r.status}</span>{" "}
              <strong>{CORRECTION_LABELS[r.kind]}</strong> — {r.message}{" "}
              <span className="hint">reported {fmtTime(r.created_at)}</span>
            </li>
          ))}
        </ul>
      )}

      {err && <div className="err">{err}</div>}
      {done && !err && <p className="hint">Thanks — that's been passed on to the treasurer.</p>}

      <div className="row" style={{ marginBottom: 10 }}>
        <label className="fld" style={{ flex: 1, minWidth: 240 }}>What's wrong?
          <select value={kind} disabled={busy} onChange={(e) => setKind(e.target.value as CorrectionKind)}>
            {(Object.keys(CORRECTION_LABELS) as CorrectionKind[]).map((k) => (
              <option key={k} value={k}>{CORRECTION_LABELS[k]}</option>
            ))}
          </select>
        </label>
        <label className="fld" style={{ width: 140 }}>Amount <span className="hint">(optional)</span>
          <input value={amount} disabled={busy} inputMode="decimal" placeholder="0.00"
            onChange={(e) => setAmount(e.target.value)} />
        </label>
        <label className="fld" style={{ width: 200 }}>Your name <span className="hint">(optional)</span>
          <input value={name} disabled={busy} placeholder={statement.notice.person.name}
            onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      <label className="fld" style={{ display: "block", marginBottom: 10 }}>Details
        <textarea
          rows={4}
          value={message}
          disabled={busy}
          placeholder="e.g. I paid $42.18 for gas on the way home and don't see it listed."
          onChange={(e) => setMessage(e.target.value)}
        />
      </label>
      <button className="btn" disabled={busy || !message.trim()} onClick={submit}>
        {busy ? "Sending…" : "Report this"}
      </button>
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
  const titleCancelled = useRef(false);

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
    // Escape blurs into this handler before its setTitleDraft has landed.
    if (titleCancelled.current) { titleCancelled.current = false; setTitleDraft(bundle.trip.name); return; }
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
              if (e.key === "Escape") { titleCancelled.current = true; (e.currentTarget as HTMLInputElement).blur(); }
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
  const [notices, setNotices] = useState<NoticeLink[]>([]);
  const [corrections, setCorrections] = useState<Correction[]>([]);
  const [noticeFor, setNoticeFor] = useState<PaysheetRow | null>(null);

  // Refresh the diff + snapshot list (call after taking/deleting a snapshot).
  const reload = useCallback(async () => {
    const [ch, list, links] = await Promise.all([
      api.getChanges(tripId), api.listSnapshots(tripId), api.listNotices(tripId),
    ]);
    setChanges(ch);
    setSnapshots(list);
    setNotices(links);
  }, [tripId]);

  const reloadCorrections = useCallback(async () => {
    setCorrections(await api.listCorrections(tripId));
  }, [tripId]);

  // Re-derive whenever the live bundle changes (the parent hands a new bundle
  // object after every edit), so highlights always reflect the current state.
  useEffect(() => {
    let cancelled = false;
    api.getChanges(tripId).then((c) => { if (!cancelled) setChanges(c); }).catch(() => {});
    api.listSnapshots(tripId).then((s) => { if (!cancelled) setSnapshots(s); }).catch(() => {});
    api.listNotices(tripId).then((n) => { if (!cancelled) setNotices(n); }).catch(() => {});
    api.listCorrections(tripId).then((c) => { if (!cancelled) setCorrections(c); }).catch(() => {});
    return () => { cancelled = true; };
  }, [bundle, tripId]);

  // One link per person for the row badge. A link cut from the current snapshot
  // wins over a merely newer one: what a leader needs to know is whether this
  // person has the figures they're looking at, not which link was made last.
  const noticeByPerson = useMemo(() => {
    const currentSnap = snapshots[0]?.id;
    const m = new Map<number, NoticeLink>();
    for (const n of notices) {
      const prev = m.get(n.person_id); // list arrives newest-first
      if (!prev || (prev.snapshot_id !== currentSnap && n.snapshot_id === currentSnap)) {
        m.set(n.person_id, n);
      }
    }
    return m;
  }, [notices, snapshots]);

  const changeByPerson = useMemo(() => {
    const m = new Map<number, RowChange>();
    for (const r of changes?.diff?.paysheet.rows ?? []) {
      m.set(r.person_id, { added: !!r.added, fields: new Map(r.changes.map((c) => [c.field, c])) });
    }
    return m;
  }, [changes]);

  const rows = bundle.paysheet.rows
    .filter((r) => showAll || r.paid || r.owed || r.prepay || r.reimbursed)
    .sort((a, b) => a.outstanding - b.outstanding);

  const owedToPeople = rows.filter((r) => r.outstanding > 0.005).reduce((s, r) => s + r.outstanding, 0);
  const owedByPeople = rows.filter((r) => r.outstanding < -0.005).reduce((s, r) => s - r.outstanding, 0);
  const since = changes?.since ?? null;

  return (
    <>
    <Snapshots bundle={bundle} changes={changes} snapshots={snapshots} reload={reload} />
    <Corrections corrections={corrections} reload={reloadCorrections} />
    {noticeFor && (
      <NoticeModal
        bundle={bundle}
        row={noticeFor}
        snapshots={snapshots}
        stale={!!changes?.diff?.hasChanges}
        onClose={() => setNoticeFor(null)}
        onPrepared={() => { api.listNotices(tripId).then(setNotices).catch(() => {}); }}
      />
    )}
    <div className="card">
      <div className="kpi" style={{ marginBottom: 18 }}>
        <div><div className="k">Total expenses</div><div className="v">{money(bundle.paysheet.totalExpenses)}</div></div>
        <div><div className="k">Pre-reimbursed</div><div className="v">{money(bundle.paysheet.totalPrepaid)}</div></div>
        <div>
          <div className="k">Receipts paid back</div>
          <div className="v">{money(bundle.paysheet.totalReimbursed ?? 0)}</div>
        </div>
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
            <th className="num">Reimbursed</th>
            <th className="num">Net</th>
            <th>Settlement</th>
            <th>Notice</th>
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
              <tr key={r.person_id} className={`${!r.paid && !r.owed && !r.prepay && !r.reimbursed ? "zero" : ""}${rc?.added ? " row-added" : ""}`}>
                <td>{r.name} {r.code && <span className="hint">({r.code})</span>}{rc?.added && <span className="pill pill-new" style={{ marginLeft: 6 }}>new</span>}</td>
                <td className={cls("paid")}>{r.paid ? money(r.paid) : ""}{note("paid")}</td>
                <td className={cls("owed")}>{r.owed ? money(r.owed) : ""}{note("owed")}</td>
                <td className={cls("prepay")}>{r.prepay ? money(r.prepay) : ""}{note("prepay")}</td>
                {/* Receipts of theirs already handed back, marked one by one on
                    the Expenses tab. Already netted out of the figure beside it. */}
                <td className={cls("reimbursed")}>{r.reimbursed ? money(r.reimbursed) : ""}{note("reimbursed")}</td>
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
                {/* Email is only meaningful when there's a balance to explain;
                    a settled row has nothing to tell anyone. */}
                <td className="notice-cell">
                  {Math.abs(o) > 0.005 ? (
                    <>
                      <button className="btn ghost sm-btn" onClick={() => setNoticeFor(r)}>
                        ✉ Email
                      </button>
                      {(() => {
                        const link = noticeByPerson.get(r.person_id);
                        if (!link) return null;
                        const current = link.snapshot_id === snapshots[0]?.id;
                        return (
                          <span
                            className={`pill ${current ? "pill-new" : ""}`}
                            title={`Statement link created ${fmtTime(link.created_at)}${current ? "" : " from an older snapshot"}`}
                          >
                            {current ? "prepared" : "older"}
                          </span>
                        );
                      })()}
                    </>
                  ) : (
                    <span className="hint">—</span>
                  )}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={8} className="empty">No activity yet.</td></tr>
          )}
        </tbody>
      </table>
      <p><small className="hint">
        Net = what they paid − their share of expenses − pre-reimbursements − receipts
        already paid back (marked on the Expenses tab).
        Green means the troop owes them; red means they owe the troop.
        {since && changes?.diff?.hasChanges && <> <span className="changed-key">Highlighted</span> cells show <em>before → after</em> for changes since the snapshot taken {fmtTime(since.created_at)}.</>}
      </small></p>
    </div>
    </>
  );
}

// ------------------------------------------------------- Reimbursement notice
// Prepare one person's email. The app never sends it: this hands back a draft
// the treasurer sends from their own mail client, so the recipient's reply —
// the fastest way to report a missing receipt — lands with a human who can act
// on it, and no member ever gets mail from an address that can't be answered.
//
// The figures always come from a snapshot, never from live data. An email
// quoting "$128.42" has to still be explainable next week, after the trip has
// moved on.
function NoticeModal({
  bundle, row, snapshots, stale, onClose, onPrepared,
}: {
  bundle: TripBundle;
  row: PaysheetRow;
  snapshots: SnapshotMeta[];
  stale: boolean;
  onClose: () => void;
  onPrepared: () => void;
}) {
  const [snapshotId, setSnapshotId] = useState<number | undefined>(snapshots[0]?.id);
  const [notice, setNotice] = useState<PersonNotice | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [copied, setCopied] = useState<"rich" | "link" | null>(null);
  const [view, setView] = useState<"rich" | "plain">("rich");

  // Re-prepare whenever the chosen snapshot changes. Preparing is idempotent
  // per (snapshot, person): it reuses the link already in someone's inbox
  // rather than minting a second one. `onPrepared` is deliberately out of the
  // dependency list — it's an inline callback, and refreshing the parent's list
  // must not re-trigger this.
  useEffect(() => {
    let cancelled = false;
    setBusy(true); setErr(null);
    api.prepareNotice(bundle.trip.id, row.person_id, snapshotId)
      .then((n) => { if (!cancelled) { setNotice(n); onPrepared(); } })
      .catch((e) => { if (!cancelled) setErr(String(e)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [bundle.trip.id, row.person_id, snapshotId]);

  async function copy(what: "rich" | "link", text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setErr("Couldn't reach the clipboard — select the text and copy it manually.");
    }
  }

  /**
   * Put the email on the clipboard in both flavors, so pasting into a mail
   * client keeps the formatting (text/html) while anything plainer still gets
   * readable text.
   *
   * This is how rich mail actually leaves the app: a mailto: URL can only carry
   * plain text (RFC 6068), and the app deliberately doesn't send mail itself.
   * Nothing may be awaited before `clipboard.write` — Safari only honours a
   * clipboard write inside the original user gesture.
   */
  async function copyRich() {
    if (!notice) return;
    try {
      if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([notice.html], { type: "text/html" }),
            "text/plain": new Blob([notice.body], { type: "text/plain" }),
          }),
        ]);
      } else {
        // Older Firefox has no ClipboardItem write: plain text beats nothing.
        await navigator.clipboard.writeText(notice.body);
      }
      setCopied("rich");
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setErr("Couldn't reach the clipboard — switch to Plain text and copy it manually.");
    }
  }

  async function revoke() {
    if (!notice) return;
    if (!confirm("Revoke this statement link? Anyone who already has it will get a 'no longer valid' page, and preparing the email again will mint a new link.")) return;
    setBusy(true);
    try {
      await api.revokeNotice(notice.token);
      onPrepared();
      onClose();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  }

  // Prefer the snapshot's address (who they were when it was cut), but fall
  // back to the live roster in case an address was added since.
  const liveEmail = bundle.people.find((p) => p.id === row.person_id)?.email ?? null;
  const email = notice?.person.email ?? liveEmail;
  const mailto = notice && email
    ? `mailto:${email}?subject=${encodeURIComponent(notice.subject)}&body=${encodeURIComponent(notice.body)}`
    : null;
  // Handing a very long mailto: to the OS is unreliable (Windows truncates
  // around 2KB), so point at the clipboard before it silently clips the email.
  const tooLongForMailto = !!mailto && mailto.length > 1900;
  const owes = !!notice && notice.net < -0.005;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal notice-modal" onClick={(e) => e.stopPropagation()}>
        <div className="toolbar">
          <h2 style={{ margin: 0 }}>Email {row.name}</h2>
          <div className="spacer" />
          {snapshots.length > 1 && (
            <label className="fld" style={{ width: 220 }}>Based on
              <select
                value={snapshotId ?? ""}
                disabled={busy}
                onChange={(e) => setSnapshotId(Number(e.target.value))}
              >
                {snapshots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {fmtTime(s.created_at)}{s.label ? ` · ${s.label}` : ""}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        {err && <div className="err">{err}</div>}

        {!email && (
          <div className="err">
            No email address on file for {row.name}. Copy the text below and send it yourself, or
            have their roster address added.
          </div>
        )}
        {stale && snapshotId === snapshots[0]?.id && (
          <p className="hint warn-note">
            The trip has changed since this snapshot was taken. The email quotes the snapshot's
            figures — take a new snapshot first if you want to send current numbers.
          </p>
        )}
        {owes && notice && !notice.paymentInstructions && (
          <p className="hint warn-note">
            No payment instructions set for this trip, so the email just asks them to reply for
            details. Add them under ⚙ Settings to include them here.
          </p>
        )}

        {busy && !notice ? (
          <p className="hint">Preparing…</p>
        ) : notice ? (
          <>
            <label className="fld" style={{ display: "block", marginBottom: 4 }}>To
              <input readOnly value={email ?? "—"} />
            </label>
            <label className="fld" style={{ display: "block", marginBottom: 4 }}>Subject
              <input readOnly value={notice.subject} />
            </label>
            <div className="preview-tabs">
              <button
                className={`preview-tab ${view === "rich" ? "on" : ""}`}
                onClick={() => setView("rich")}
              >
                Formatted
              </button>
              <button
                className={`preview-tab ${view === "plain" ? "on" : ""}`}
                onClick={() => setView("plain")}
              >
                Plain text
              </button>
            </div>
            {view === "rich" ? (
              // Sandboxed iframe: renders the email exactly as a mail client
              // will, without its inline styles bleeding into the app (or the
              // app's leaking in and flattering the preview).
              <iframe className="notice-preview" title="Email preview" sandbox="" srcDoc={notice.html} />
            ) : (
              <pre className="notice-body">{notice.body}</pre>
            )}

            <div className="row" style={{ marginTop: 12, alignItems: "center" }}>
              <button className="btn" onClick={copyRich}>
                {copied === "rich" ? "Copied ✓" : "Copy formatted email"}
              </button>
              <a
                className="btn ghost"
                href={mailto ?? "#"}
                onClick={(e) => { if (!mailto) e.preventDefault(); }}
                aria-disabled={!mailto}
                title="Opens a draft in your mail app. Mail links can only carry plain text, so this sends the unformatted version."
              >
                Open plain-text draft
              </a>
              <button className="btn ghost" onClick={() => copy("link", notice.url)}>
                {copied === "link" ? "Copied ✓" : "Copy link only"}
              </button>
              <div className="spacer" />
              <button className="btn ghost danger" disabled={busy} onClick={revoke}>Revoke link</button>
              <button className="btn ghost" onClick={onClose}>Close</button>
            </div>

            <p className="hint" style={{ marginTop: 10 }}>
              <strong>Copy formatted email</strong> puts the formatted version on your clipboard —
              paste it into a new message to {email ?? "them"} with the subject above and it keeps
              its formatting. The plain-text draft is there for mail apps that don't take a paste.
            </p>
            {tooLongForMailto && (
              <p className="hint warn-note">
                The plain-text draft is long enough that some mail apps truncate it. Prefer the
                formatted copy, or paste the plain text into a new message.
              </p>
            )}
            <p><small className="hint">
              The link in the email needs no sign-in — anyone holding it can read {row.name}'s
              statement, so send it only to them. Revoking it invalidates the URL immediately.
            </small></p>
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Corrections
// Claims reported from shared statements ("you're missing my gas receipt").
// Deliberately a review queue and nothing more: resolving one records that a
// human dealt with it — the actual fix is an ordinary edit on another tab.
function Corrections({
  corrections, reload,
}: {
  corrections: Correction[];
  reload: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  if (corrections.length === 0) return null;
  const openCount = corrections.filter((c) => c.status === "open").length;
  const shown = showResolved ? corrections : corrections.filter((c) => c.status === "open");

  async function setStatus(id: number, status: "open" | "resolved") {
    setBusy(true); setErr(null);
    try {
      await api.setCorrectionStatus(id, status);
      await reload();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="toolbar">
        <h2 style={{ margin: 0 }}>
          Reported corrections{openCount > 0 && <span className="pill" style={{ marginLeft: 8 }}>{openCount} open</span>}
        </h2>
        <div className="spacer" />
        <label className="row" style={{ alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          <span className="hint">Show resolved ({corrections.length - openCount})</span>
        </label>
      </div>

      {err && <div className="err">{err}</div>}

      {shown.length === 0 ? (
        <p className="hint">Nothing open — every reported correction has been dealt with.</p>
      ) : (
        <table>
          <thead>
            <tr><th>From</th><th>What</th><th className="num">Amount</th><th>Details</th><th>Reported</th><th></th></tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.id} className={c.status === "resolved" ? "zero" : ""}>
                <td>
                  {c.personName}
                  {c.reporter_name && c.reporter_name !== c.personName && (
                    <div className="hint">sent by {c.reporter_name}</div>
                  )}
                </td>
                <td>{CORRECTION_LABELS[c.kind]}</td>
                <td className="num">{c.amount != null ? money(c.amount) : ""}</td>
                <td className="correction-msg">{c.message}</td>
                <td className="hint">{fmtTime(c.created_at)}</td>
                <td className="num">
                  {c.status === "open" ? (
                    <button className="btn ghost sm-btn" disabled={busy} onClick={() => setStatus(c.id, "resolved")}>
                      Resolve
                    </button>
                  ) : (
                    <button className="btn ghost sm-btn" disabled={busy} onClick={() => setStatus(c.id, "open")}>
                      Reopen
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p><small className="hint">
        Reported from the statement links emailed out of this tab. Resolving one just marks it
        handled — fix the underlying receipt on the Expenses tab, then take a fresh snapshot
        before emailing updated figures.
      </small></p>
    </div>
  );
}

// ------------------------------------------------------------------ Snapshots
const MONEY_FIELDS = new Set([
  "amount", "paid", "owed", "prepay", "reimbursed", "balance", "outstanding",
  "totalExpenses", "totalPrepaid", "totalReimbursed",
]);
function fmtVal(field: string, v: unknown): string {
  if (typeof v === "number" && MONEY_FIELDS.has(field)) return money(v);
  // The reimbursed mark is a timestamp, but what changed is whether it's set.
  if (field === "reimbursed_at") return v == null || v === "" ? "not reimbursed" : "reimbursed";
  if (v == null || v === "") return "—";
  return String(v);
}
// Field names a reader shouldn't have to decode. Anything absent reads fine
// as-is ("paid", "owed", "prepay"…).
const FIELD_LABELS: Record<string, string> = {
  reimbursed_at: "reimbursement",
  reimbursed: "paid back",
};
function fmtChange(ch: FieldChange): string {
  return `${FIELD_LABELS[ch.field] ?? ch.field}: ${fmtVal(ch.field, ch.from)} → ${fmtVal(ch.field, ch.to)}`;
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
  const header = ["Adult", "Code", "Paid", "Owes (share)", "Pre-reimbursed", "Reimbursed", "Net"];
  if (prevNet) header.push("Net change vs prev");
  header.push("Settlement");

  const rows: unknown[][] = [header];
  for (const r of b.paysheet.rows) {
    if (!(r.paid || r.owed || r.prepay || r.reimbursed)) continue;
    const cells: unknown[] = [
      r.name, r.code ?? "", round2(r.paid), round2(r.owed), round2(r.prepay),
      round2(r.reimbursed ?? 0), round2(r.outstanding),
    ];
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
      {diff.paysheet.totalReimbursed && <li>Receipts paid back: {fmtChange(diff.paysheet.totalReimbursed)}</li>}
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
    // Statement links are cut from a snapshot, so deleting it breaks any link
    // already emailed from it — say so rather than let a member hit a dead URL.
    if (!confirm("Delete this snapshot? Any statement links emailed from it will stop working. This cannot be undone.")) return;
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
                                <th className="num">Pre-reimbursed</th><th className="num">Reimbursed</th><th className="num">Net</th>
                                {hasPrev && <th className="num">± vs prev</th>}
                                <th>Settlement</th>
                              </tr>
                            </thead>
                            <tbody>
                              {viewing.bundle.paysheet.rows.filter((r) => r.paid || r.owed || r.prepay || r.reimbursed).map((r) => {
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
                                    <td className="num">{r.reimbursed ? money(r.reimbursed) : ""}</td>
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
const ATTACHMENT_ACCEPT = "image/*,application/pdf";

function Expenses({ bundle, roster, run, busy }: TabProps) {
  const { personById } = useMaps(bundle);
  const costGroups = bundle.groups.filter((g) => g.kind !== "travel");
  // Payer pool: adults from local people + roster (deduped), as refs.
  const adultPool = useMemo(() => buildPool(bundle, roster, "adults"), [bundle, roster]);
  const [groupId, setGroupId] = useState<number>(costGroups[0]?.id ?? 0);
  const [payerRef, setPayerRef] = useState<string>("");
  const [desc, setDesc] = useState("");
  const [amount, setAmount] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  // Edit mode: pick receipts with checkboxes, then re-charge them to another
  // cost group. Travel-generated rows aren't selectable — their group is owned
  // by the travel calculator.
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [moveTo, setMoveTo] = useState<number>(0);

  const effectivePayer = payerRef || adultPool[0]?.ref || "";
  // Travel-generated rows are owned by the travel calculator, not by hand: they
  // can't be moved, marked reimbursed, or selected for either.
  const editable = (e: Expense) => !e.source_travel_group_id;
  // A stale id (receipt deleted elsewhere) must never reach a bulk call.
  const selectedIds = bundle.expenses.filter((e) => editable(e) && selected.has(e.id)).map((e) => e.id);
  const destination = costGroups.find((g) => g.id === moveTo) ?? costGroups[0];

  // Progress over the receipts that can actually be settled by hand, so the
  // count is one a treasurer can drive to zero.
  const markable = bundle.expenses.filter(editable);
  const reimbursedRows = markable.filter((e) => e.reimbursed_at);
  const reimbursedTotal = reimbursedRows.reduce((sum, e) => sum + e.amount, 0);
  const markableTotal = markable.reduce((sum, e) => sum + e.amount, 0);

  function toggle(id: number, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function stopEditing() {
    setEditing(false);
    setSelected(new Set());
  }

  function move() {
    if (!destination || selectedIds.length === 0) return;
    run(() => api.moveExpenses(bundle.trip.id, selectedIds, destination.id)).then(() => setSelected(new Set()));
  }

  function markReimbursed(reimbursed: boolean) {
    if (selectedIds.length === 0) return;
    run(() => api.setExpensesReimbursed(bundle.trip.id, selectedIds, reimbursed)).then(() => setSelected(new Set()));
  }

  function add() {
    const amt = parseFloat(amount);
    if (!desc || !groupId || !effectivePayer || isNaN(amt)) return;
    run(() =>
      api.addExpense(bundle.trip.id, { group_id: groupId, payer_ref: effectivePayer, description: desc, amount: amt }, files),
    ).then(() => {
      setDesc("");
      setAmount("");
      setFiles([]);
      if (fileInput.current) fileInput.current.value = "";
    });
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
        <label className="fld">Receipt files <span className="hint">(optional)</span>
          <input
            ref={fileInput}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            disabled={busy}
            onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
          />
        </label>
        <button className="btn" disabled={busy} onClick={add}>Add</button>
      </div>

      {bundle.expenses.length > 0 && (
        <div className="toolbar" style={{ marginTop: 22 }}>
          <h2 style={{ margin: 0 }}>Receipts</h2>
          <span className="hint">
            {reimbursedRows.length > 0
              ? `${reimbursedRows.length} of ${markable.length} paid back · ${money(reimbursedTotal)} of ${money(markableTotal)}`
              : "None paid back yet"}
          </span>
          <div className="spacer" />
          {editing ? (
            <button className="btn ghost" disabled={busy} onClick={stopEditing}>Done</button>
          ) : (
            <button className="btn ghost" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
          )}
        </div>
      )}

      {editing && (
        <div className="move-bar">
          <span className="move-count">{selectedIds.length} selected</span>
          <label className="fld">Move to
            <select value={destination?.id ?? 0} onChange={(e) => setMoveTo(Number(e.target.value))}>
              {costGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </label>
          <button className="btn" disabled={busy || selectedIds.length === 0 || !destination} onClick={move}>
            Move{selectedIds.length > 0 && destination ? ` ${selectedIds.length} to ${destination.name}` : ""}
          </button>
          {/* Settling a batch at once — the common case after writing one cheque
              that covers several of a person's receipts. */}
          <button className="btn ghost" disabled={busy || selectedIds.length === 0} onClick={() => markReimbursed(true)}>
            ✓ Mark{selectedIds.length > 0 ? ` ${selectedIds.length}` : ""} reimbursed
          </button>
          <button className="btn ghost" disabled={busy || selectedIds.length === 0} onClick={() => markReimbursed(false)}>
            Undo reimbursed
          </button>
          {selectedIds.length > 0 && (
            <button className="btn ghost" disabled={busy} onClick={() => setSelected(new Set())}>Clear</button>
          )}
          <span className="hint">Auto travel receipts can't be moved — change the travel group's cost group instead.</span>
        </div>
      )}

      {bundle.groups.map((g) => {
        const rows = bundle.expenses.filter((e) => e.group_id === g.id);
        if (rows.length === 0) return null;
        const summary = bundle.groupSummaries.find((s) => s.group.id === g.id)!;
        const groupEditable = rows.filter(editable);
        const allChecked = groupEditable.length > 0 && groupEditable.every((e) => selected.has(e.id));
        return (
          <div key={g.id}>
            <h3>{g.name} — {money(summary.total)}{summary.totalShares > 0 && <> · {money(summary.perShare)}/share ({summary.totalShares} shares)</>}</h3>
            <table>
              <thead>
                <tr>
                  {editing && (
                    <th className="check-col">
                      <input
                        type="checkbox"
                        aria-label={`Select all receipts in ${g.name}`}
                        disabled={busy || groupEditable.length === 0}
                        checked={allChecked}
                        onChange={(ev) => groupEditable.forEach((e) => toggle(e.id, ev.target.checked))}
                      />
                    </th>
                  )}
                  <th>Receipt</th><th>Paid by</th><th className="num">Amount</th>
                  <th className="reimb-col">Reimbursed</th>
                  <th>Files</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr
                    key={e.id}
                    className={`${editing && selected.has(e.id) ? "selected" : ""}${e.reimbursed_at ? " reimbursed" : ""}`.trim() || undefined}
                  >
                    {editing && (
                      <td className="check-col">
                        {editable(e) && (
                          <input
                            type="checkbox"
                            aria-label={`Select ${e.description}`}
                            disabled={busy}
                            checked={selected.has(e.id)}
                            onChange={(ev) => toggle(e.id, ev.target.checked)}
                          />
                        )}
                      </td>
                    )}
                    <td>{e.description}{e.source_travel_group_id && <span className="pill" style={{ marginLeft: 6 }}>auto</span>}</td>
                    <td>{personById.get(e.payer_id)?.name ?? "?"}</td>
                    <td className="num">{money(e.amount)}</td>
                    {/* The mark itself: ticking it says this receipt has been
                        paid back to its payer, so it stops counting toward what
                        they're owed on the Reimbursement tab. Auto travel rows
                        are regenerated from the travel calculator, so there's no
                        stable receipt here to settle by hand. */}
                    <td className="reimb-col">
                      {editable(e) ? (
                        <label className="reimb-toggle">
                          <input
                            type="checkbox"
                            disabled={busy}
                            checked={!!e.reimbursed_at}
                            aria-label={`Mark ${e.description} reimbursed to ${personById.get(e.payer_id)?.name ?? "payer"}`}
                            onChange={(ev) =>
                              run(() => api.setExpensesReimbursed(bundle.trip.id, [e.id], ev.target.checked))
                            }
                          />
                          {e.reimbursed_at && (
                            <span className="pill pill-new" title={`Marked ${fmtTime(e.reimbursed_at)}${e.reimbursed_by ? ` by ${e.reimbursed_by}` : ""}`}>paid back</span>
                          )}
                        </label>
                      ) : (
                        <span className="hint" title="Generated by the travel calculator — settle the driver on the Reimbursement tab.">—</span>
                      )}
                    </td>
                    <td><AttachmentCell expense={e} run={run} busy={busy} /></td>
                    <td className="num">
                      {editable(e) && (
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

// The Files cell for one receipt: existing attachments as inline links (with a
// remove ✕) plus an Attach control. Attaching is hidden for auto travel rows,
// which never carry receipts.
function AttachmentCell({ expense, run, busy }: { expense: Expense; run: TabProps["run"]; busy: boolean }) {
  const input = useRef<HTMLInputElement>(null);

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    if (picked.length) run(() => api.uploadAttachments(expense.id, picked));
    if (input.current) input.current.value = "";
  }

  return (
    <div className="attachments">
      {expense.attachments.map((a) => (
        <span key={a.id} className="attachment">
          <a href={api.attachmentUrl(a.id)} target="_blank" rel="noreferrer" title={a.filename}>
            {a.content_type === "application/pdf" ? "📄" : "🖼️"} {a.filename}
          </a>
          <button
            className="attachment-x"
            aria-label={`Remove ${a.filename}`}
            title="Remove"
            disabled={busy}
            onClick={() => run(() => api.deleteAttachment(a.id))}
          >
            ✕
          </button>
        </span>
      ))}
      {!expense.source_travel_group_id && (
        <>
          <button className="btn ghost sm-btn" disabled={busy} onClick={() => input.current?.click()}>
            Attach
          </button>
          <input
            ref={input}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            hidden
            onChange={onPick}
          />
        </>
      )}
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
        an adult → themselves). Click a group's name to rename it — expenses and
        attendance stay put.
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
          name="participant-search"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
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

/**
 * Inline rename for a cost group. Saves on blur / Enter, reverts on Escape or
 * an empty value. The PATCH sends only `name`, so nothing else on the group is
 * touched.
 */
function GroupNameInput({ group, run, busy }: { group: CostGroup; run: TabProps["run"]; busy: boolean }) {
  const [draft, setDraft] = useState(group.name);
  useEffect(() => setDraft(group.name), [group.id, group.name]);
  // Escape blurs, and blur saves — so flag the cancel for the blur that follows
  // (setDraft hasn't landed yet at that point, so `draft` is still the edit).
  const cancelled = useRef(false);

  function save() {
    if (cancelled.current) { cancelled.current = false; setDraft(group.name); return; }
    const next = draft.trim();
    if (!next || next === group.name) { setDraft(group.name); return; }
    run(() => api.updateGroup(group.id, { name: next }));
  }

  return (
    <input
      className="name-input"
      value={draft}
      disabled={busy}
      aria-label={`${group.kind} name`}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") { cancelled.current = true; e.currentTarget.blur(); }
      }}
    />
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
        <GroupNameInput group={group} run={run} busy={busy} />
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
  const [pay, setPay] = useState(trip.payment_instructions ?? "");

  useEffect(() => {
    setSlug(trip.slug);
    setDate(trip.trip_date ?? "");
    setPdoc(trip.planning_doc_url ?? "");
    setSlack(trip.slack_url ?? "");
    setRate(String(trip.mileage_rate));
    setUnits(trip.roster_units.join(", "));
    setPay(trip.payment_instructions ?? "");
  }, [trip.id, trip.slug, trip.trip_date, trip.planning_doc_url, trip.slack_url, trip.mileage_rate, trip.roster_units.join(","), trip.payment_instructions]);

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
      <div className="row" style={{ marginTop: 10 }}>
        <label className="fld" style={{ flex: 1 }}>How to pay the troop
          <textarea
            rows={3}
            value={pay}
            disabled={busy}
            placeholder="e.g. Zelle to treasurer@… , or mail a check payable to Troop 10 RWC. Include the trip name."
            onChange={(e) => setPay(e.target.value)}
            onBlur={() => pay !== (trip.payment_instructions ?? "") && save({ payment_instructions: pay || null })}
          />
          <small className="hint">
            Reproduced verbatim in reimbursement emails and on shared statements for anyone who owes
            money. Carried over to new trips.
          </small>
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
