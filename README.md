# Patrol Expense

Troop 10 trip-expense tracker. A Cloudflare Worker (Hono) + React/Vite SPA on a
normalized D1 database, mounted as a same-origin tab at
**`troop10rwc.org/manage/expenses`**.

- **Authentication is self-hosted member sessions** (the `@troop10rwc/kit`
  model). The shared identity service at **`id.troop10rwc.org`** signs members in
  (Slack enrollment + passkeys) and sets the `__Secure-troop_session` cookie; the
  Worker validates it against the shared `troop10-id` D1. No app-level sign-in.
- Roster comes from the external **roster-db** D1 (read-only).
- Travel addresses use Google Maps (autocomplete + most-direct driving distance) via a server-side proxy.

## Layout

```
src/shared    types + constants (BASE_PATH=/manage/expenses, HOME_ADDRESS)
src/worker    Hono API, session auth (auth.ts), roster reader, geo proxy, seed,
              paysheet engine, notice mail (mail.ts, events.ts, inbound.ts)
src/client    React SPA (App.tsx), API client
migrations    D1 schema
```

The Worker owns the whole `/manage/expenses/*` subpath: it strips the prefix,
routes `/api` to Hono, and serves the SPA via the assets binding.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars      # then fill in values
npm run db:migrate:local            # apply migrations to local D1
npm run dev                         # http://localhost:5173/manage/expenses/
```

`.dev.vars` (gitignored) holds secrets. There's no identity service in front of
local dev, so set `DEV_AUTH_BYPASS=1` to skip auth (every request becomes a fixed
"Dev User"). `wrangler login` is required because the ROSTER and IDDB bindings
read the real `roster-db` / `troop10-id` D1s (`remote: true`).

Click **Load 2026 Winter Lodge sample** (or `POST /manage/expenses/api/seed`) to seed demo data.

## Authentication (member sessions)

Auth is **self-hosted member sessions**, shared across Troop 10 apps via
`@troop10rwc/kit`. The standalone identity service at **`id.troop10rwc.org`**
handles enrollment (Slack, workspace-locked) and the daily driver (passkeys),
mints the `__Secure-troop_session` cookie (`Domain=troop10rwc.org`), and writes
each session to the shared **`troop10-id`** D1. This Worker doesn't sign anyone
in — it reads the cookie and resolves it against `troop10-id` (bound read-only as
`IDDB`) with the kit's `d1SessionLookup` (`src/worker/auth.ts`). An API call with
no live session gets a `401` carrying `AUTH_ORIGIN`; the SPA then bounces the
browser to `${AUTH_ORIGIN}/login?redirect=…`, which returns here once signed in.

**Domain constraint.** The session cookie is scoped to `troop10rwc.org`, so the
app must be served under **`*.troop10rwc.org`** — a `*.workers.dev` host can never
receive it. That's why `workers_dev`/`preview_urls` are off: an authenticated
preview must be served from a `*.troop10rwc.org` route, not a workers.dev URL.

## Reimbursement notices (per-person emails)

Each row on the **Reimbursement** tab with a nonzero net gets an **✉ Email**
button. It prepares that person's notice, previews it as the recipient will see
it, and sends it through **Cloudflare Email Sending** (`src/worker/mail.ts`).

The email is **deliberately high level** — the headline amount, which cost
groups the share covers, the three or four figures that net out to it, and then
links. Every receipt and per-group split lives on the statement page, so the
message stays skimmable on a phone. Both renderings come from
`src/worker/notice.ts` and carry identical content; the modal previews either.
The HTML is built for mail clients, not browsers: table layout, inline styles
only, no classes, webfonts, flexbox, or `<style>` block.

**Send rebuilds the message server-side** from the snapshot — the client posts
only the token, never a rendered body, so nothing can substitute its own
figures. Sending the same notice twice returns `409`; the modal turns that into
a confirmation rather than a second email. A resend is a *new* `notice_sends`
row: "we wrote twice and the first bounced" is exactly the history a treasurer
chasing a payment needs.

*Other ways to send* keeps the old clipboard and `mailto:` routes — the only way
to reach someone whose roster row has no address. `mailto:` can only carry plain
text (RFC 6068), so *Copy formatted email* writes both `text/html` and
`text/plain` clipboard flavors. Sent that way the app can't track delivery and
the reply goes to whoever sent it.

### What the Notice column knows

Cloudflare publishes delivery events to a queue (`queue()` in `index.ts` →
`src/worker/events.ts`), which advances `notice_sends.status`. Queue delivery is
at-least-once and unordered, so events are logged append-only in
`notice_send_events` (deduped on `(message_id, type, occurred_at)`) and status
only ever moves *forward* through a ranking — a late `deferred` can't
un-deliver a message.

The chip ranks by what needs acting on, not by chronology: **spam report** and
**bounced** outrank everything, because those are the people who won't find out
what they owe. **read** means they opened their statement page.

There is deliberately **no "opened" state for the email itself.** Cloudflare has
no open tracking, and a tracking pixel would mostly measure Apple Mail Privacy
Protection prefetching images — a number that looks authoritative and means
nothing. Statement views (counted on the page's own data fetch) are a real
person; that's what the column shows.

**Notices are always cut from a snapshot, never live data** — an email quotes an
amount, so the arithmetic behind it has to stay re-readable afterwards. If a trip
has no snapshot yet, preparing a notice returns `409`; take one first.

Every email carries a **shared statement link** (`/manage/expenses/s/<token>`),
the app's only unauthenticated surface. Recipients include parents with no
identity account, so the token *is* the credential: it authorizes exactly one
person's figures for one snapshot, and the page re-derives everything from that
frozen bundle, so the page and the email can never disagree. Links are stored
(`statement_links`), reused per (snapshot, person), and revocable from the modal.
Deleting a snapshot invalidates the links cut from it.

Recipients report problems two ways, and **both land in the same review queue**:
the "report it here" link (`/s/<token>#report`), or simply hitting Reply. Every
notice carries `Reply-To: r+<token>@<REPLY_DOMAIN>`, a catch-all Email Routing
subdomain wired to the Worker's `email()` handler (`src/worker/inbound.ts`).
Reusing the statement token means a reply is attributable to exactly one
(snapshot, person) with no new secret and no subject parsing — and it leaks
nothing, since that token is already in the statement URL in the same message.

Inbound replies are parsed with `postal-mime`, stripped of the quoted original,
and filed as `corrections` with `source='email'`. Photos ride along into R2
(`correction_attachments`) — the notice copy asks for "a photo of the receipt",
so replies carry them. Mail that can't be attributed (bare address, revoked
link, spam) forwards to `MAIL_FALLBACK`; a handler that just returns would make
Cloudflare drop the message silently, so every path forwards or rejects.

Like the form, this is **inert** — it queues a claim and never touches an
expense. Fix the receipt on the Expenses tab, snapshot again, then re-send.

Payment instructions are per-trip (⚙ Settings), reproduced verbatim in notices
for anyone who owes, and copied forward to each new trip.

## Email setup (one-time, Cloudflare + Google Workspace)

`troop10rwc.org` runs on **Google Workspace**, so the order here matters. Read
the whole section before touching DNS.

**Why sending is safe.** Cloudflare Email Sending parks *all* of its records on a
`cf-bounce` subdomain — MX (bounce collection), SPF, and a `cf-bounce` DKIM
selector. It never touches the apex MX, and SPF authenticates the *envelope*
sender (on `cf-bounce.troop10rwc.org`), so the apex `v=spf1
include:_spf.google.com -all` is never consulted and never needs editing.
Google's `google._domainkey` selector doesn't collide.

**The one hazard is DMARC.** Onboarding proposes `_dmarc` = `v=DMARC1;
p=reject;` on the apex. There is no `_dmarc` record today, and `p=reject` would
immediately start rejecting mail from *any* service that sends as
`@troop10rwc.org` without alignment (Slack, sign-up tools, a Workspace user on a
third-party client). **Edit it to `p=none` with a `rua=` address before
applying**, read the reports for ~2 weeks, then tighten.

### 1. Sending

Requires the **Workers Paid** plan (3,000 messages/month included, then
$0.35/1,000).

1. Dashboard → Compute → Email Service → **Email Sending** → Onboard Domain →
   `troop10rwc.org`. Review the DNS diff; expect only the four records above.
2. Change the `_dmarc` value to `p=none` with a `rua=` address before applying.
3. Verify nothing moved:
   ```sh
   dig +short MX troop10rwc.org    # must still be aspmx.l.google.com et al.
   dig +short TXT troop10rwc.org   # must still be the single Google SPF
   ```
4. Create `expenses@troop10rwc.org` in the Workspace admin console as an alias or
   group pointing at the treasurer — the safety net for anyone who mails it
   directly instead of replying.
5. Verify authentication end to end — see below. Do this **before** wiring
   anything else; it's the check that decides whether you can safely tighten
   DMARC later.

### Verifying authentication (step 5, in detail)

Cloudflare will happily deliver mail that fails DMARC while the policy is
`p=none` — that's what `p=none` means. So a test that only confirms "the email
arrived" proves nothing. The point of this step is to confirm the mail is
*aligned*, so that when you later move to `p=quarantine` or `p=reject` the
troop's notices don't start landing in spam. Finding that out now costs a test
message; finding it out later means parents stop getting their bills.

#### Send the tests

No deploy needed — the CLI sends through the same infrastructure the Worker will:

```bash
npx wrangler email sending send --from "expenses@troop10rwc.org" --from-name "Troop 10 Expenses" --to "you@gmail.com" --subject "Auth test 1" --text "Checking SPF, DKIM and DMARC alignment."
```

Send a second one to a **non-Gmail** mailbox — Outlook.com, Yahoo, or iCloud.
Two independent evaluators catch a misconfiguration one of them tolerates, and
between them they cover where troop families actually read mail.

Two addresses to avoid for this test:

- **Anything `@troop10rwc.org`.** Google may treat same-domain mail specially,
  which can give a falsely clean result. It's also a *different* test worth
  running separately — see "Sending to your own domain" below.
- **Made-up addresses.** A hard bounce to a nonexistent mailbox costs sender
  reputation and lands the address on the account suppression list.

#### Read the headers

- **Gmail** — open the message → ⋮ → **Show original**. The top panel summarizes
  SPF/DKIM/DMARC; the raw source is underneath.
- **Outlook.com** — ⋯ → **View** → **View message source**.
- **Apple Mail** — **View** → **Message** → **All Headers** (⇧⌘H).

Find the `Authentication-Results` header added by the *receiving* server (the
topmost one — anything below it was added upstream and isn't authoritative):

```
Authentication-Results: mx.google.com;
       dkim=pass header.i=@troop10rwc.org header.s=cf-bounce;
       spf=pass (google.com: domain of <...>@cf-bounce.troop10rwc.org designates ... as permitted sender) smtp.mailfrom=<...>@cf-bounce.troop10rwc.org;
       dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=troop10rwc.org
```

Four things to check, in order of how much they matter:

| Check | Expected | Why |
|---|---|---|
| `dmarc=` | `pass` | The verdict everything else feeds |
| `dkim=` … `header.i=` / `header.d=` | `@troop10rwc.org` | **The one that matters most** — see below |
| `header.from=` | `troop10rwc.org` | The domain DMARC evaluates against |
| `spf=` … `smtp.mailfrom=` | `pass`, on `cf-bounce.troop10rwc.org` | Confirms the envelope really is on the bounce subdomain |

#### Why the DKIM `d=` is the one that matters

DMARC passes if **either** SPF or DKIM passes *and is aligned* with the domain in
the `From:` header. Alignment, not just passing — a message can have `spf=pass`
and still fail DMARC if the SPF-authenticated domain isn't the From domain.

Those two mechanisms align differently here:

- **SPF** authenticates the envelope sender, which is on
  `cf-bounce.troop10rwc.org`, while the `From:` is `troop10rwc.org`. Those are
  different hostnames, so they align only under DMARC's **relaxed** mode (same
  organizational domain), which is the default. Publish `aspf=s` and SPF
  alignment breaks.
- **DKIM** signs with a `d=` domain. The record lives at
  `cf-bounce._domainkey.troop10rwc.org` — selector `cf-bounce`, signing domain
  `troop10rwc.org` — so `d=` is the bare domain, which is **strict** alignment.
  That holds under any DMARC mode.

**Verified 2026-08-22** against a Gmail delivery:

```
dkim=pass header.i=@troop10rwc.org header.s=cf-bounce
spf=pass  smtp.mailfrom=bounces@cf-bounce.troop10rwc.org
dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=troop10rwc.org
```

DKIM is strictly aligned (`header.i` exactly matches `header.from`), so the
DMARC pass survives tightening the policy — and would survive `adkim=s` too.
SPF passes but is only *relaxed*-aligned, as predicted, so DKIM is the leg
actually holding this up. **Nothing about this app's own mail blocks moving to
`p=quarantine` or `p=reject`;** the only remaining question is other senders.

Cloudflare double-signs: a second signature with `d=cloudflare-smtp.net`
(`s=cf2024-1`) rides along as their own infrastructure reputation. It's expected
and irrelevant to alignment — only the `d=troop10rwc.org` one counts.

**Forwarding was tested too**, via a domain that relays to Gmail. After the
forward the final verdict was:

```
spf=softfail  (relay IP isn't in cf-bounce's SPF record)
dkim=pass     header.i=@troop10rwc.org
dmarc=pass
```

SPF *always* breaks on forwarding — the envelope sender survives but the
connecting IP is the forwarder's. DMARC passed regardless because the DKIM
signature travels with the message. This is the abstract point above proven on
real mail, and it matters practically: families forward troop mail, and some run
their own domain relaying to Gmail. Were DKIM not aligned, forwarded notices
would be rejected at `p=reject`.

#### Sending to your own domain

Separately, send one test to a real `@troop10rwc.org` mailbox. Mail arriving at
Google Workspace that claims to be *from* your own domain but originates outside
Google can trip **Gmail's spoofing protection** ("Protect against spoofing of
domain names", under Admin console → Apps → Google Workspace → Gmail → Safety →
Spoofing and authentication). A correctly aligned DMARC pass normally satisfies
it, but this configuration — a Workspace domain with a second authorized sender —
is exactly the shape that setting targets. If these land in spam while the
external tests didn't, that's where to look.

#### If something fails

| Symptom | Likely cause |
|---|---|
| `dkim=none` or `dkim=temperror` | DNS hasn't propagated. Wait, then `dig +short TXT cf-bounce._domainkey.troop10rwc.org` |
| `dkim=fail` | The DKIM record was altered or truncated on the way into DNS — re-copy it from the dashboard |
| `spf=fail` / `spf=softfail` | `dig +short TXT cf-bounce.troop10rwc.org` should be `v=spf1 include:_spf.mx.cloudflare.net ~all` |
| `dmarc=fail` with both others passing | An alignment problem, not an authentication one — compare `header.from=` against `d=` and `smtp.mailfrom=` |
| Delivered but in spam, auth all passing | Reputation on a brand-new sending domain. Normal at first; it settles with consistent low-volume sending |

#### Google Postmaster Tools

Outbound messages carry `Feedback-ID: troop10rwc.org:5:5:Cloudflare`, which means
Gmail will attribute reputation, spam-rate, and delivery-error data to the domain
if you register it at [postmaster.google.com](https://postmaster.google.com/).
Worth doing: most troop families read mail in Gmail, and this is the only place
that reports *their* spam-marking rate back to you. Cloudflare sends from a
shared IP pool (`bg-hj.cloudflare-smtp.net`), so domain reputation — which this
tracks — is what you actually control.

#### Before tightening DMARC

Published record: `v=DMARC1; p=none; rua=mailto:dmarc-reports@troop10rwc.org`.

⚠️ **Confirm `dmarc-reports@troop10rwc.org` actually receives mail.** If that
alias doesn't exist in Workspace, the aggregate reports bounce and the two-week
observation period silently collects nothing — which is the whole basis for
deciding it's safe to tighten.

Sit at `p=none` for ~2 weeks and read those reports (gzipped XML —
[dmarcian](https://dmarcian.com/) and similar will render them). You're looking
for **every** source that sends as `@troop10rwc.org`: Google Workspace, this app
(already confirmed aligned above), and anything you'd forgotten — which is the
usual reason a `p=reject` rollout goes wrong.

**Expect `spf=fail, dkim=pass` rows from IPs you don't recognize, and don't
panic.** That's forwarding, not spoofing — see the forwarding test above — and
those messages are passing DMARC on DKIM exactly as intended. Misreading them as
an attack is the most common way a DMARC rollout goes sideways. The rows that
actually need attention are **`dkim=fail`** ones from a source you recognize:
that's a legitimate sender that isn't signing as your domain.

Note the apex SPF is `-all`, a *hard* fail. Any other service sending as
`@troop10rwc.org` through an apex envelope is already failing SPF; at `p=none`
that's invisible, at `p=reject` it stops being delivered. The reports are where
you'll find it. Only move to `p=quarantine`, then later `p=reject`, once every
legitimate source in them is aligned.

### 2. Delivery events

Two queues carry the Email Sending lifecycle into the Worker's `queue()` handler:

```sh
npx wrangler queues create patrol-expense-email-events
npx wrangler queues create patrol-expense-email-events-dlq
```

Then subscribe the queue to this zone's sending events. **Needs wrangler ≥ 4.125**
— `--source email.sending` doesn't exist in earlier versions, and the repo's
pinned wrangler may be older, hence `wrangler@latest`:

```sh
npx -y wrangler@latest queues subscription create patrol-expense-email-events --source email.sending --zone-id f5e862938ba258cbffe768a1a00da794 --domain troop10rwc.org --name patrol-expense-notice-delivery --events message.delivered,message.deferred,message.bounced,message.failed,message.rejected,message.complained
```

All six events matter: `events.ts` maps each to a status, and dropping any one
leaves messages stuck at whatever they reached last. Verify with:

```sh
npx -y wrangler@latest queues subscription list patrol-expense-email-events
```

The consumer itself is declared in `wrangler.jsonc` and attaches on deploy —
`wrangler queues list` should show `consumers: 1`. Note that `producers` stays
`0`: an event subscription isn't a conventional producer, so the subscription
list above is the authoritative check, not the producer count.

Email *Routing* events (inbound forwards, replies, Worker-emitted routing) are
**not** published here — this is outbound sending only.

### 3. Inbound replies — apex-safe, but the order matters

Replies arrive at `r+<token>@reply.troop10rwc.org`, an Email Routing subdomain.
This coexists with Google Workspace, but **only because the apex MX was restored
by hand after onboarding** — the onboarding flow itself is destructive and has no
opt-out.

#### Why this needs care

Email Routing is a zone-level feature; its Subdomains option lives inside the
apex domain's settings, so the apex must be onboarded first. Onboarding writes
these (`wrangler email routing dns get troop10rwc.org`):

```
MX  troop10rwc.org  route1/2/3.mx.cloudflare.net
TXT troop10rwc.org  "v=spf1 include:_spf.mx.cloudflare.net ~all"
TXT cf2024-1._domainkey.troop10rwc.org  "v=DKIM1; ..."
```

The apex MX records are the dangerous ones: they displace Google's, and inbound
troop mail starts arriving at Cloudflare where — with no matching rule — it is
rejected. **Restore Google's apex MX immediately afterwards.** Isolating
`reply.troop10rwc.org` as its own Cloudflare zone would avoid this entirely, but
subdomain zones are Enterprise-only.

The SPF record turned out to be *merged* rather than replaced, which is the safe
behavior — but verify it, don't assume it. Two `v=spf1` records on one name is a
permanent error under RFC 7208.

#### Verified end state (2026-08-23)

```sh
dig +short MX troop10rwc.org          # 1 smtp.google.com   <- Google, restored
dig +short TXT troop10rwc.org         # exactly ONE v=spf1 record
dig +short MX reply.troop10rwc.org    # route1/2/3.mx.cloudflare.net
```

- **Apex MX** is Google's modern single-record form (`smtp.google.com`), not the
  older five `aspmx.l.google.com` entries. Both are valid; this one is current.
- **Apex SPF** is now
  `v=spf1 include:_spf.mx.cloudflare.net include:_spf.google.com ~all` — merged,
  single record, 2 of the 10 permitted DNS lookups. Note it downgraded `-all` to
  `~all`; that is a real policy change, defensible alongside DMARC but worth a
  deliberate decision.
- `cf2024-1._domainkey` at the apex is harmless — a distinct selector from both
  Google's `google._domainkey` and Sending's `cf-bounce._domainkey`.
- `wrangler email routing settings troop10rwc.org` reports **`misconfigured`**.
  That is expected and correct here: it means the apex MX isn't Cloudflare's,
  which is the whole point. Subdomain routing is unaffected.

**Confirmed by real delivery, both directions:**

| Direction | Evidence |
|---|---|
| Outbound Workspace | `spf=pass`, `dkim=pass header.s=google`, `dmarc=pass` — the merged SPF still authorizes Google's relays |
| Inbound to the domain | `Delivered-To: noahcampbell@troop10rwc.org` via `mx.google.com` |

#### Remaining wiring

1. Deploy the Worker (the routing rule targets it by name, so it must exist).
2. Dashboard → Email Routing → `reply.troop10rwc.org` → **catch-all** rule →
   *Send to a Worker* → `patrol-expense`. Rules for a routing subdomain are
   dashboard-only; `wrangler email routing rules` is zone-scoped and can't see
   them.
3. Set `MAIL_FALLBACK` to a **verified destination address**
   (`wrangler email routing addresses list`). `message.forward()` fails to
   unverified addresses — `inbound.ts` rejects rather than dropping in that case,
   so nothing vanishes, but unattributable replies bounce instead of reaching a
   human.
4. Reply to a notice and confirm it lands in the corrections queue.

### Local development

Sends are simulated by `wrangler dev` and go nowhere. To exercise the real
service, add `"remote": true` to the `send_email` binding in `wrangler.jsonc` —
mail actually goes out, so use an address you own — and take it back out before
deploying.

## Production deploy

1. **D1**: `wrangler d1 create patrol_expense`, then put the returned id into
   `wrangler.jsonc` (`d1_databases[0].database_id`).
2. **Migrations**: `npm run db:migrate:remote`.
3. **Secrets** (`wrangler secret put NAME`): `GOOGLE_MAPS_API_KEY`. Do **not** set
   `DEV_AUTH_BYPASS` in production.
3a. **Email**: see [Email setup](#email-setup-one-time-cloudflare--google-workspace)
   above — the domain must be onboarded and the queues created before notices can
   go out. Until then Send fails with `E_SENDER_NOT_VERIFIED` and says so in
   plain language; the clipboard routes still work and nothing else is affected.
4. **Auth**: `wrangler.jsonc` sets `AUTH_ORIGIN` (`https://id.troop10rwc.org`) and
   binds the shared `troop10-id` D1 read-only as `IDDB`. The identity service must
   already be deployed at that origin (repo: `troop10rwc/id`).
5. **Route**: `wrangler.jsonc` declares `troop10rwc.org/manage/expenses*` (the
   zone is on Cloudflare; all other paths fall through to the existing site).
6. `npm run deploy`.
7. On troop10rwc.org, add an **"Expenses"** link to the top nav pointing at
   `/manage/expenses` (the main site is managed separately).

## Notes

- Cross-database joins aren't possible in D1, so roster members referenced by a
  trip are projected into a local `people` table (`source='roster'`); guests are
  `source='local'` and never written back to roster-db.
- Travel reimbursements are materialized as expenses so they flow into the paysheet.
- Two things reduce what the troop still owes a person, and they stay separate:
  a **prepayment** (a lump sum handed over, entered against the person) and a
  **reimbursed receipt** (tick the *Reimbursed* box on the Expenses tab to say
  that one receipt has been paid back to whoever fronted it). Both are
  subtracted from that person's net on the Reimbursement tab; neither changes
  the trip's total cost or anyone's share. Auto travel rows can't be marked —
  the travel calculator rewrites them on every recalculation, so there's no
  durable receipt to settle; pay those drivers off on the Reimbursement tab.
