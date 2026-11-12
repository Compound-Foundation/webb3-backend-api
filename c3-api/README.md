# Compound III API

A serverless worker for building cacheable incremental computations over
historical blockchain data.

An API is exposed for querying computations against deployed v3 markets,
used by the Compound III frontend. See [./API.md](./API.md).

# Getting Started

Install dependencies with Node.js 22 or newer:
```sh
npm install
```

The worker reads its markets from the registry in its D1 database, and the
chain through the node provider proxy, so a local run needs both.

Create the local database, with every migration applied:
```sh
npm run d1:migrate:local
```

Run the node provider proxy on this machine, in a terminal of its own, with
its provider keys in `../node-provider-proxy/.dev.vars` (see
[Configuration](../node-provider-proxy/README.md#configuration) in its
README). It is a package of its own, so its dependencies are installed there,
the first time, before it starts:
```sh
cd ../node-provider-proxy
npm install
npm start -- --port 8788
```

Then, in a second terminal and from this directory, run a local
auto-reloading development build of the worker bound to it:
```sh
npx wrangler dev --local -c wrangler.local-proxy.toml entrypoint.ts
```

[`wrangler.local-proxy.toml`](./wrangler.local-proxy.toml) is the local
environment of `wrangler.toml` with the proxy bound to the worker, as stage
and production bind theirs. `npm start` runs the worker without it, against
the proxy that `NODE_PROXY_HOST` and `NODE_PROXY_KEY` in `.dev.vars` name — a
deployed one, reached over HTTPS ([.dev.vars.example](./.dev.vars.example)).
With neither, every read of the chain fails.

Every market route answers `503 REGISTRY_NOT_ACTIVE` until a registry
version is active. Bring one up as an operator brings up an environment: put
the hashes of two admin tokens of your own into `.dev.vars`, as entries of
`COMET_REGISTRY_ADMIN_TOKENS` with the role `admin` under two names — one
approves the version and the other switches it on — before starting the
worker ([The admin tokens](./REGISTRY_RUNBOOK.md#the-admin-tokens)), and follow
[Bringing an environment up for the first time](./REGISTRY_RUNBOOK.md#bringing-an-environment-up-for-the-first-time)
with `API=http://localhost:8787`.

Then hit an endpoint:
```
curl 'http://localhost:8787/market/{network}/{contract}/summary'
```

Substituting the address of a Comet the active version serves for
`{contract}` — `/registry/v1/networks/{chain_id}/markets` lists them — and a
network (e.g. mainnet) for `{network}`.

See [API.md](./API.md) for documentation of routes with examples.

# Application Database (D1)

The worker binds one Cloudflare D1 database as `APP_DB`, shared by every
D1-backed feature. Each environment in `wrangler.toml` points `APP_DB` at
its own physical database, and all of them apply the single ordered
migration stream in [./migrations](./migrations). Never renumber a
migration that has been applied anywhere.

Migrations are numbered in the order they are applied, not by feature:
`0001` is the Comet registry schema, `0002` marks the markets nobody has
reviewed yet, and `0003` adds how the frontend lists a market — its slug and
whether it is institutional. `0004` drops the columns and indexes nothing
uses, and `0005` stores token policies — which tokens an administrator has
marked strategic, and the audit of every change. `0006` stores which
collaterals of which Comets an administrator has marked legacy, with the audit
of every change, and `0007` renames them deprecated collaterals: tables,
columns, view, indexes and triggers alike. `0008` stores which collaterals of
which Comets an administrator has hidden from token discovery, with the audit
of every change. `0011` adds the approvals an activation needs, and an
environment that applied it first applies `0005` to `0008` after it:
`wrangler d1 migrations apply` applies every file not applied yet, by name.
`0009` and `0010` are left to work merged later.

Apply migrations to the local Miniflare database under `.wrangler/state`:
```sh
npm run d1:migrate:local
npx wrangler d1 execute APP_DB --local --command "PRAGMA foreign_key_check;"
```

Remote migrations always name the environment and must run before the
worker release that needs them:
```sh
npm run d1:migrate:stage
npm run d1:migrate:production
```

A migration has to work with the release deployed before it, which serves
until the deploy that follows.

The Comet registry also binds `kv_registry` for its snapshot cache, its last
check of the chain, the deprecated and the hidden collateral decisions it
last recorded and the last announcement it gave up, two rate limiters for
its administrative routes, and an hourly Cron trigger for its resumable sync.
`REGISTRY_ADMIN_AUTH_RATE_LIMITER` counts every request under
`/registry/v1/admin/` before its token is checked, 60 a minute for each
client address (`CF-Connecting-IP`; an IPv6 client by its /64), so wrong
tokens and unknown paths are paid for too; `REGISTRY_ADMIN_RATE_LIMITER`
counts every authenticated one on a route its token's role reaches, reads as
well as commands, 30 a minute for each admin token and route family. Every
environment gives each its own namespace id. One invocation imports
`COMET_SYNC_MARKETS_PER_INVOCATION` markets and leaves the rest to the next
one, resuming from the checkpoints in `APP_DB`; upstream is checked for a new
commit once per `COMET_UPSTREAM_CHECK_INTERVAL_S`. The chain is read again for
the version that is on as often, by the first invocation of each such
interval — of each day (UTC), with the day every environment sets — and
within the hour for a version switched on;
`GET /registry/v1/admin/status` reports it as `chainCheck` and raises
`chain-drift` where the two differ.

An invocation whose import fails — GitHub not answering while it looks for
the commit to import, D1 not answering, or a setting the import refuses —
fails the Cron, so the Cron's metrics and past events in the dashboard show
it. The platform does not run it again: the next invocation resumes from the
checkpoints. A market whose own reads fail — its root from GitHub, or the
chain through the node provider proxy — fails only its root: the invocation
records why on the run, goes on with the next market and succeeds, and
`GET /registry/v1/admin/status` raises `sync-failing` once such failures
repeat. An invocation that finds another one importing, such as an
administrative sync, has nothing to do and succeeds too. A request to GitHub
that has not answered within 20 seconds, or a batch to the node provider
proxy within 30, is given up as a service that did not answer, so a
connection nobody answers cannot hold the import, and every sync waiting for
it, open.

The registry's numbers — `COMET_SYNC_LEASE_SECONDS`,
`COMET_SYNC_MARKETS_PER_INVOCATION`, `COMET_UPSTREAM_CHECK_INTERVAL_S`,
`REGISTRY_SNAPSHOT_CACHE_TTL_S`, `REGISTRY_STALE_FALLBACK_MAX_S` and
`COMET_REGISTRY_APPROVAL_TTL_S`, how long an approval lets its version be
switched on, a day by default and a week at most — are whole numbers, and
unset or empty is the default. A value that is not one is
never used: the import refuses to start over one of its own, a read takes
the default in its place, and `GET /registry/v1/admin/status` names it under
the alert `configuration-invalid`, as it does a `COMET_SOURCE_REPOSITORY` or
`COMET_SOURCE_REF` that names no source, and a `COMET_REGISTRY_WEBHOOK_URL`
that is not an `https` URL, to which nothing is announced. That one is a
secret, corrected with `npx wrangler secret put` rather than a deploy.

The secrets, and every other value an environment sets outside
`wrangler.toml` — the registry's among them, such as
`COMET_REGISTRY_ADMIN_TOKENS` and `COMET_REGISTRY_WEBHOOK_URL` — are listed in
[./.dev.vars.example](./.dev.vars.example). Copy it to
`.dev.vars` for local runs; deployed environments set them with
`npx wrangler secret put <NAME> --env <environment>`, never in
`wrangler.toml`. Stage and production set `COMET_GITHUB_TOKEN`: without a
token GitHub allows 60 API requests an hour per address, and a Worker shares
its address with every other Worker that leaves Cloudflare through it.

Run the worker with the scheduled-event test route and trigger the Cron
handler locally — with the node provider proxy on this machine, add
`--test-scheduled` to the command in [Getting Started](#getting-started)
instead of `npm run start:scheduled`:
```sh
npm run start:scheduled
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+*+*+*+*"
```

# Workers Plan

Stage and production run on the Workers Paid plan, and need it. An
invocation there may make 10,000 subrequests — every `fetch`, every request
through a service binding, and every KV operation and D1 statement or batch
counts — and spend 30 seconds of CPU, or 15 minutes in the hourly Cron. The
Free plan gives an invocation 50 subrequests and 10 milliseconds of CPU,
which the registry's import does not fit: an administrative sync of the
whole source makes about 230 subrequests, seven for each of its 29 markets —
its root from GitHub, three rounds of reads from the node, three D1
statements or batches — and about thirty for the run.

`wrangler.toml` sets no `[limits]`, so stage and production have the plan's
defaults: an import of the whole source, or the summary of every market — four
calls to the node provider proxy per network, and three D1 statements for the
decisions it marks collaterals with ([Token Visibility](#token-visibility)) —
stays far inside its subrequests. The history of every market, with none of
its days cached, stays inside them as well: three calls to the proxy per
market and one per network, beside four KV operations for each day of each
market — about 3,600 subrequests for the 29 markets of the source over 30
days. A `[limits]` section changes them for one Worker, for example to a
million subrequests and 60 seconds of CPU an invocation.

# The Comet Market Registry

Markets, their tokens, and their price feeds come from the registry in
`APP_DB`, not from the static constants. One activated version answers a
whole request: the router that answers it loads the version once, hands the
same catalog to every computation of that request, and reports which version
answered in `X-Registry-Version` and `X-Registry-Checksum` on the response.

A computation takes a market in one form: the Comet the catalog materialized
for it (`RegistryComet`, in
[lib/model/comet-registry.ts](./lib/model/comet-registry.ts)) — the contract
shape the static constants used, carrying the version's description of the
market. Its units, its labels, its reward feed and the price exceptions of
its network are read from that description, and every computation that
reads it, or hands its market to one that does, is typed to take nothing
else. The constants name no market of a mainnet any more, but their `Comet`
key still types a Comet read from them as `['Comet'][alias]`, and such a read
does not compile there: [the consumers test](./tests/lib/registry/consumers.test.ts)
holds one of that type to every refusal. What the compiler cannot type — a
cast, or a name computed at run time — it cannot refuse either.

What that means for the endpoints:

- a route that resolves a market — `/market/...`, `/account/.../rewards`,
  `/account/.../transaction_history` — answers `503` when no version is
  active. There is no static market list to fall back to, and serving one
  nobody reviewed would be worse than failing;
- an address the active version does not describe is not a market, and is
  refused with `400`, on any network;
- transaction history cursors carry the version they were issued against,
  the markets it reads, and the block their ranges of logs are counted
  from. A cursor stays valid across versions that read the same markets
  from the same blocks; one from a version that read others, or counted
  from another block, is refused with `409 REGISTRY_VERSION_CHANGED`,
  whatever mainnet market its `markets[]` names, and the client restarts
  pagination. So is a cursor issued before the registry, which carries no
  version, whatever it reads;
- a market summary, and each day of its history, takes what the market's
  collateral is and the feed that prices its base asset from the version;
  what the Comet holds, the feed it reads for each collateral at the block,
  and the prices are read on chain. Its totals are given in the market's
  quote unit and, beside them, in USD. A collateral the Comet listed after
  the import is left out until a version describes it, and transaction
  history reads the amounts of a token no version describes at the decimals
  the token reports ([API.md](./API.md));
- routes that resolve no market — V2 and gas price — never read `APP_DB`,
  and governance reads it only to name the markets of proposal actions, and
  the tokens and price feeds the static constants do not name. The proposal
  list, and the vote receipts with their proposals (`with_proposal_data`),
  describe the actions of the page they answer again, with the markets of
  the active version merged in, with every token they name and every feed
  they read, so they read the registry once on every request that answers
  an action. The version names the markets it serves and the disabled
  markets it holds without serving them, each by its contract name, or its
  label where it has none, their tokens by their symbols and their feeds as
  `PriceFeed`, each linked at its address checksummed, and a cap or an
  amount of a token is written at the decimals the version read. Of the
  tokens and feeds, the constants keep only these: COMP on every chain that
  has one, WETH on Ethereum, Optimism and Base, ETH and the other
  underlyings of the V2 cTokens, Arbitrum's bridged USDC (USDC.e), which
  its chain names as it does native USDC, and on Ethereum the tokens and
  the two feeds they write in lowercase — cbBTC, USDe, tBTC, LBTC, pumpBTC,
  wstETH, cbETH, KNC and stETH — whose links keep that case. Such a token
  keeps the constants' name and link, and takes the version's decimals
  where the version holds it. A market the active version does not hold,
  and a token or feed neither it nor the constants name, shows as its
  address. While the registry cannot be read, so does every one the
  constants do not keep, and the cap of such a token is written at 18
  decimals: every action is then described against the constants alone, by
  the build answering rather than the one that cached it, and the answer is
  given all the same. A governance path that names as its contract an
  address the constants do not keep — a Comet, a token or a feed, such as
  `/governance/ethereum-mainnet/{comet}/proposals` — is refused with `400`
  `Error: Contract address not known`, as any address the constants do not
  know is.

A commit can be imported more than once — discovery tries again after an
attempt that did not import every root, each time later, and an operator can
force a new attempt. An attempt that imported every root and still failed
validation is not tried again by itself: it would fail the same way, so the
status names the commit until a person forces an attempt or the source moves
on. Once a newer attempt
of a commit succeeds — validates, or is held for review with every root
imported — the commit's older attempts still importing are closed as
`invalid`. Discovery closes any it finds left over, older than the commit's
newest successful attempt, before it decides what is held. A draft is never
closed by an attempt that has merely started, so a forced attempt that fails
leaves the draft before it open and still validatable. The reason is one
failed check, `superseded-by-newer-attempt`, added to the draft's latest
validation attempt with the replacing attempt in its details, so the draft
still reports what had failed on it before. A draft left open would otherwise
be listed as work to review and would stop discovery at it.

Only attempts of the same commit replace each other. Reviews are inherited
between attempts of one commit — a later attempt takes what earlier ones
reviewed, and a newer review of the same market wins — but not across
commits, so a draft of a commit the tracked ref has moved past is left open:
validate it to close it. What an earlier attempt hands down is what an
overlay was written for in it, which its audit events name; the rest of its
rows are copies of the version that was on when it was imported, and come
from the version on now instead, so a hotfix or a rollback activated between
two attempts is not undone by the second — except where the first was
reviewed: a document is handed down whole, with what the version on then
decided for its network or market. Nor is the rollback of an attempt
of the commit: once one has been switched off, neither it nor an attempt
before it hands anything down, because what they reviewed was switched on
with it and off again. Where the merged decisions name two default markets,
the one an attempt decided is kept and the other is merged as not the
default, and an import that would still write a second default is refused as
`OVERLAY_INVALID`, naming both.

## What a request reads

A version never changes once it exists, and only the pointer to the active
one moves. So a request reads the pointer from D1 — one statement — and
everything else from somewhere cheaper. The registry's own routes and the
market routes read it the same way:

- the isolate holds in memory the versions it has served, and the catalog it
  built from each, and reuses them for as long as the pointer names them. The
  active version has a place of its own, so reading pinned versions by id
  never pushes it out;
- the bytes of a version are cached in the `kv_registry` namespace under a key
  that names the version and its checksum, so an isolate that has never seen
  it pays a KV read rather than hydrating the snapshot out of D1. What KV
  holds is trusted only when it names the version as the version's row does —
  id, source repository and commit, checksum — and its content matches that
  checksum, and only those parts are served; anything else is refused,
  answered from D1, and written over. Market ids are the one part the
  checksum does not cover;
- an entry is written once and never expires: it is never wrong, only
  unwanted, and the hourly job removes those of versions nothing is about to
  serve — every version but the active one, the one an outage would fall back
  to, and the validated ones newer than the active one. A version switched on
  while the job runs is cached again, by the job, by the activation or by the
  first read;
- a validated candidate is cached before it is activated — by the import that
  validated it, by `POST .../validate`, and by the activation itself — so an
  activation is a pointer move and no request pays the serialization;
- `REGISTRY_SNAPSHOT_CACHE_TTL_S` is the `max-age` public reads advertise to
  browsers and proxies.

The deprecated and the hidden collateral decisions
([Deprecated Collaterals](#deprecated-collaterals),
[Hidden Collaterals](#hidden-collaterals)) are no part of a version, so they
are not cached with it. `/active` and the market reads read them beside the
pointer, in one more statement for each kind, and mark the version's
collaterals with them in the answer; the answer's `ETag` names the flags it
carries, so a decision that changes them is never confirmed with a `304` to a
client holding a copy made before it.

When D1 cannot be reached at all, a request is answered from the version D1
last named, for up to `REGISTRY_STALE_FALLBACK_MAX_S` after that. Such a
response carries `X-Registry-Stale` with its age in seconds and
`Cache-Control: no-store`, so nothing downstream keeps it and no client
mistakes it for the current version; the outage itself is logged as an
error, once a minute per isolate. Set the window to `0` in an environment that
would rather fail than answer from an older version. Past the window, or with
nothing cached, every route answers `503 UPSTREAM_UNAVAILABLE`. A D1 that
answers "no version is active" is an answer, not an outage: it is served as
`503 REGISTRY_NOT_ACTIVE`, never from the cache; and a D1 that answers with a
fault, such as a table a migration has not created yet, is a `500`, never
masked by the cache. The routes that read the token policy, deprecated
collateral or hidden collateral tables are the one exception, for those
tables: without migration `0005` the token policy routes, without `0007`
`/active`, the market reads and the deprecated collateral routes, and without
`0008` the same reads and the hidden collateral routes, answer
`503 UPSTREAM_UNAVAILABLE`, naming the migrations to apply.

During an outage `/active` and the market reads mark deprecated and hidden
collaterals by the decisions the worker last recorded in `kv_registry`, in a
record of each kind. Every command that decides about a collateral records
its kind's once it has committed. An isolate checks a record against the
decisions it reads whenever they are not the ones it last found there or
wrote, and every five minutes besides, and writes them only where the record
differs: KV takes one write a second to a key, and the isolates of a deploy,
starting together, mostly find the record right. KV also keeps whichever
write reaches it last, so a read that began before a decision and wrote after
it puts back the decisions before it, until the next check puts that right,
within about five minutes while the reads go on. An answer that could read
the version but not the decisions, of one kind or both, is marked the same
way, as `X-Registry-Stale: 0`, and one with either kind not recorded to
answer with is `503 UPSTREAM_UNAVAILABLE`. With the window at `0` nothing is
recorded, and nothing is answered from the records.

An operator changes what the API serves by importing, reviewing, validating,
approving and activating a version; see the admin routes in
[./API.md](./API.md). Each administrative token has a name and a role, and
an environment lists its tokens in the secret `COMET_REGISTRY_ADMIN_TOKENS`
([The admin tokens](./REGISTRY_RUNBOOK.md#the-admin-tokens)); without that
list, the admin API refuses every request. Every change a token makes is
recorded under its name, but for a validation, which decides nothing and
records only its checks; its role — `monitor`, `reader`, `operator` or
`admin` — bounds the routes it may call. The step-by-step procedure, with
what to expect at each step and what to do when something else happens, is
[./REGISTRY_RUNBOOK.md](./REGISTRY_RUNBOOK.md).

A version is switched on by two people: an admin approves it, and an admin
of another name activates it while the approval is in force, a day unless
`COMET_REGISTRY_APPROVAL_TTL_S` says otherwise. The approval names the
version on that its giver read the changes against, is of the change from
that version to the approved one, and lets one activation through. A
rollback needs nobody's approval, so that undoing a bad version takes one
person, but it goes back one step only: to the version the one on replaced
when it was last activated, if that is older. Going further back takes
another rollback, and each is announced. The code holds these rules for
every move, and migration `0011` holds them in the database too from an
environment's first approval on. A decision about a token or a collateral
([Token Visibility](#token-visibility)) is one admin's: it takes effect as
soon as it is made, needs nobody's approval, and is not announced.

Every activation and rollback that changes what is served is announced,
once it has committed, to the webhook `COMET_REGISTRY_WEBHOOK_URL` names — a
Slack incoming webhook for the team's channel: who switched which version
on, in place of which, who approved it, which networks and markets that
added, removed or changed, and last, why ([API.md](./API.md#registry-v1)).
So is every approval, as it is given. The message is best
effort, sent once and given up after 5 seconds, and fails no command; the
audit is the record, and the status raises `notification-failing` when a
message was given up
([Announcing changes](./REGISTRY_RUNBOOK.md#announcing-changes)).

## Bringing a registry up from nothing

An import writes every market it finds. What the source and the chain state
— addresses, tokens, decimals, feeds, collateral — it reads itself; what they
cannot state — names, whether a market is served, its capabilities, the unit
its base is quoted in, its reward feed, price exceptions — is a reviewed
decision, inherited from the active version, a market's for the Comet they
were made for. A market no version has reviewed — a deployment key the source
has given another Comet among them — is written disabled, with every
capability off, and marked unreviewed: its rows exist and can be reviewed in
place, and until then it changes nothing the API serves.

The first import of an environment has nothing to inherit, so every market
arrives unreviewed. That run imports the whole source and then holds the
candidate open instead of validating it, because a version of nothing but
unreviewed markets could only end invalid.

There are ten networks and twenty-nine markets to review, and every value is
one this API acted on before the registry: the static constants named the
markets and their feeds, the branches the registry replaced decided their
capabilities, quote units and price exceptions, and the frontend lists them
under its labels.
Those decisions are checked in as the body of `PUT /versions/{id}/overlays`,
[`registry/seed/production.json`](./registry/seed/README.md), with each
market's Comet beside it in `production.comets.json`. The operator checks
that the candidate holds the seed's markets and sends the file, and nothing
runs outside the environment but the requests:

```sh
# 1. import the whole source in one request. The run ends "heldForReview";
#    note the registryVersionId it answers
curl -X POST .../registry/v1/admin/sync -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}'

# 2. check that the candidate holds every market of the seed, under the Comet
#    production.comets.json names for it
curl .../registry/v1/admin/versions/$VERSION/changes -H "Authorization: Bearer $TOKEN" \
  | jq -r '.markets.added[] | "\(.scope) \(.market.contracts.comet)"'

# 3. send the seed: every decision, one transaction
curl -X PUT .../registry/v1/admin/versions/$VERSION/overlays \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @registry/seed/production.json

# 4. validate; one admin approves, and another activates. The first
#    approval and activation expect nothing to be on; later ones name the
#    version that is
curl -X POST .../registry/v1/admin/versions/$VERSION/validate ...
curl -X POST .../registry/v1/admin/versions/$VERSION/approve ... \
  -H "Authorization: Bearer $APPROVER_TOKEN" \
  -d '{"reason": "read its changes", "expectedActiveVersionId": null}'
curl -X POST .../registry/v1/admin/versions/$VERSION/activate ... \
  -d '{"reason": "first registry version", "expectedActiveVersionId": null}'
```

An administrative sync imports up to fifty markets per request (`markets`
bounds it); the Cron keeps to `COMET_SYNC_MARKETS_PER_INVOCATION` an hour,
which is what the steady state needs. Either way each root is attempted at
most once per request, so a node provider that is briefly down costs one
attempt of each root, not all five.

[The file's README](./registry/seed/README.md) says where each kind of value
came from, and why a value departs from its rule where one does. The quote
units were read from the chain rather than the constants, which were wrong
about them in places; labels and presentation data — asset display overrides
and unwrapped collateral pairs — existed nowhere but the frontend, and were
copied once from it at a named commit. Nothing in this API reads the
presentation, but the first version already serves it, and the frontend stops
being where it is decided.

Each document is complete, in the form the registry stores it, which is how
`GET …/overlay` answers. The `PUT` writes all of them or none, in one D1
transaction, after every document is parsed, every network and market it
names is found, and the chain has confirmed what only the chain can: each
creation block, by the Comet's code at that block and none at the block
before, and the scale of each feed the candidate does not know yet. A market
of the candidate the file does not describe stays switched off and
unreviewed, and is described with the market overlay route; a market of the
file the candidate does not hold refuses the whole file, which step 2 shows
first. `expectedDigests` is `null` for every document, so the file is taken
only by a candidate nobody has reviewed: sent again, or to a draft that
inherited decisions, it is refused with `409`.

A correction to the file is a pull request, which the seed's tests hold to
what the route and validation would refuse
([Changing it](./registry/seed/README.md#changing-it));
[the preflight](./REGISTRY_RUNBOOK.md#the-preflight) holds it against the
real chain before an environment depends on it. Once a version is active, the
registry is where the decisions live, and a later version inherits them: the
file is not sent again, and a decision is changed with the overlay routes.

### A market the source adds later

A new deployment in the Comet repository arrives with the next commit as one
more unreviewed market: disabled, not failing anything, while the rest of the
commit validates and can be activated as usual. A deployment on a chain no
version described yet arrives the same way, and so does its network: under
its canonical name, unreviewed, and listed by no public read while it serves
nothing. To serve it, import the commit again with the candidate held, review
the new market — and the new network with it, since validation refuses a
network nobody reviewed that serves a market — and validate:

```sh
curl -X POST .../registry/v1/admin/sync ... \
  -d '{"forceNewAttempt": true, "holdForReview": true, "reason": "review the new market"}'
# a market of a chain no version described yet needs its network reviewed too
curl -X PUT  .../registry/v1/admin/versions/$VERSION/networks/<chain>/overlay ...
curl -X PUT  .../registry/v1/admin/versions/$VERSION/markets/<chain>/<key>/overlay ...
curl -X POST .../registry/v1/admin/versions/$VERSION/validate ...
```

A new attempt at the same commit inherits what was reviewed for the attempts
before it, so a candidate that ended invalid does not mean reviewing it all
again.

# Token Policies

An administrator can mark a token strategic. A strategic token is shown in
every market that takes it as collateral, whatever that market holds of it,
unless that market's Comet hides it (`hidden`) or has it deprecated
(`deprecated`). `/summary` reads the mark on every request
([Token Visibility](#token-visibility)). A policy is decided, audited, and
read back through the administrative routes ([API.md](./API.md)).

A policy belongs to the token — a chain id and an address — and not to a
registry version, so it survives every activation; a version that drops the
token and a later one that brings it back bring its policy back with it. It
is decided only for a token of the active version, and a token nobody has
decided about is not strategic, without a row. While a version without the
token is active, its decision is kept, listed as `retained`, and readable with
its history. Every change is written in one D1 transaction with an event that
records the value it replaced, the value it set, the actor and the reason, and
migration `0005` enforces that in the database: a policy row is written only
beside its token's newest event, which records that change; events are never
edited, replaced or deleted, and a policy row is never deleted.

A reviewed list of decisions is a file, and nobody writes its addresses by
hand: the export answers every token of every network of the
active version with its decision, in exactly the form review and apply take
back. Mark the tokens the list decides, give the reason once for the list or
on a row, review the diff, and apply the changes it shows. Apply writes the
whole list in one D1 transaction, with one event per change, and refuses the
whole list, writing nothing, if any row names a chain or a token the active
version does not hold, names a token by a symbol that is not its own, or
changes a decision without a reason:

```sh
curl -s "$API/registry/v1/admin/token-policies" -H "Authorization: Bearer $TOKEN" > token-policies.json
# edit token-policies.json: "isStrategic": true on the approved tokens, and "reason"
curl -s -X POST "$API/registry/v1/admin/token-policies/review" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data @token-policies.json > review.json
jq 'if .error then .error else .summary end' review.json
# apply the rows the review shows as changes
jq 'if .error then error("the review failed: \(.error.message)")
    elif .summary.problems > 0 then error("the review found problems: fix the file and review it again")
    elif .summary.change == 0 then error("the review shows no change: there is nothing to apply")
    else {reason: null, policies: [.policies[] | select(.action == "change") | {chainId, tokenAddress, symbol, isStrategic: .requested, reason}]}
    end' review.json > reviewed.json \
  && curl -s -X POST "$API/registry/v1/admin/token-policies/apply" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' --data @reviewed.json \
  | jq 'if .error then .error else .summary end'
```

Apply compares the list with the decisions in force when it runs, so review it
right before applying it, and apply the rows the review shows as changes
rather than the edited file: a decision someone makes on another token after
the review then stays as it is. Applying a list again changes nothing. A list
applies only where the active version holds every token it names, so the file
kept for other environments is best reduced to the rows the list decides —
the routes leave every token a list does not name as it is — and reviewed in
each environment before it is applied there.

# Deprecated Collaterals

An administrator can mark a collateral of a market deprecated: one the app
no longer offers in that market, and keeps showing to a user who still holds
some of it, so that it can be withdrawn. This replaces the list the frontend
kept itself, which calls them legacy collateral, and which is also
how it keeps wUSDM out of the USDT market now: that rule is the list's
row for it, and so, once the list is applied, the decision `isDeprecated` on
wUSDM in cUSDTv3. `/registry/v1/active` and the market reads mark every
collateral with `isDeprecated`, by the decisions in force when they answer,
and `/summary` says of each collateral whether its Comet has it deprecated
(`is_deprecated`), which Comets of its chain do (`deprecated_in`), and
whether an enabled market takes it as collateral and every one that does has
it deprecated (`is_network_deprecated`). The market no longer offers such a
collateral, so token discovery does not show it there, whatever else holds:
`deprecated`, or `hidden` where the market hides it as well, which is asked
first ([Token Visibility](#token-visibility)). Every other market that takes
the token decides it by its own decisions and its own value there, and the
app decides per market what it offers.

A decision belongs to the collateral of the Comet — a chain id, the Comet's
address and the token's — and not to a registry version, so it survives
every activation, as a token policy does; a version that drops the
collateral from its market and a later one that brings it back bring its
decision back with it. It is decided only for a collateral of a market of the
active version, and a collateral nobody has decided about is not deprecated,
without a row. Every change is written in one D1 transaction with an event
that records the value it replaced, the value it set, the actor and the
reason, and the schema enforces that in the database as `0005` does for
token policies: migration `0006` created it while the feature was called
legacy collaterals, and `0007` renamed it.

The routes are those of the token policies, for a collateral of a Comet in
place of a token, under the same limiter budgets: marking a collateral and
applying a list share the `policy` one, and the reads and the review count as
reads. One collateral is marked with
`PATCH …/networks/{chain_id}/markets/{comet}/collaterals/{token}/deprecated`,
and a list is exported, reviewed without writing anything, and applied in one
transaction:

```sh
curl -s "$API/registry/v1/admin/deprecated-collaterals" -H "Authorization: Bearer $TOKEN" > deprecated-collaterals.json
# edit deprecated-collaterals.json: "isDeprecated": true on the deprecated collaterals, and "reason"
curl -s -X POST "$API/registry/v1/admin/deprecated-collaterals/review" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data @deprecated-collaterals.json > review.json
jq 'if .error then .error else .summary end' review.json
# apply the rows the review shows as changes
jq 'if .error then error("the review failed: \(.error.message)")
    elif .summary.problems > 0 then error("the review found problems: fix the file and review it again")
    elif .summary.change == 0 then error("the review shows no change: there is nothing to apply")
    else {reason: null, collaterals: [.collaterals[] | select(.action == "change") | {chainId, cometAddress, deploymentKey, tokenAddress, symbol, isDeprecated: .requested, reason}]}
    end' review.json > reviewed.json \
  && curl -s -X POST "$API/registry/v1/admin/deprecated-collaterals/apply" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' --data @reviewed.json \
  | jq 'if .error then .error else .summary end'
```

Apply compares the list with the decisions in force when it runs, as it does
for token policies: a decision someone makes after the review is changed like
any other row the list contradicts, and shows in the answer as a change. That
is why the snippet applies only the rows the review shows as changes, as the
runbook does
([A reviewed list of deprecated collaterals](./REGISTRY_RUNBOOK.md#a-reviewed-list-of-deprecated-collaterals)).

The frontend's list is not seeded by a migration: a migration cannot know
which version an environment has on, and a decision is only made about a
collateral of one. It is checked in beside the registry seed, as
[`registry/seed/production.deprecated-collaterals.json`](./registry/seed/README.md#the-deprecated-collaterals):
20 collaterals of five Ethereum markets, with every Comet and token address,
in a list the review and apply routes take as it is. A first bring-up
reviews it and applies what it changes once its first version is on
([REGISTRY_RUNBOOK.md](./REGISTRY_RUNBOOK.md#8-mark-the-initial-deprecated-collaterals)),
and the runbook says where each address comes from
([The initial list of deprecated collaterals](./REGISTRY_RUNBOOK.md#the-initial-list-of-deprecated-collaterals)).

# Hidden Collaterals

An administrator can hide a collateral of a market from token discovery. A
hidden collateral stays a collateral of its market: the market still takes
it, and a user's positions in it and the actions on them are shown as
before; only discovery leaves it out. To stop offering a collateral in a
market, an administrator marks it deprecated instead
([Deprecated Collaterals](#deprecated-collaterals)).
`/registry/v1/active` and the market reads mark every collateral with
`isHidden` beside `isDeprecated`, by the decisions in force when they answer.
`/summary` answers a collateral its Comet hides as one discovery does not
show in that market (`is_visible: false`, `visibility_reason: hidden`),
whatever else holds, before anything else is asked: even when it is
strategic, deprecated there, or worth the threshold there, and even when it
is also the base or reward token of a market
([Token Visibility](#token-visibility)). It says per collateral which Comets
of the chain hide its token (`hidden_in`), and no other market's decision
hides it in a market: each decides by its own. So to keep a token out of
discovery on the whole chain, an administrator hides it in every market that
takes it as collateral, those whose status is `deprecated` among them; a
market that has it deprecated does not show it either, as `deprecated`.

A decision belongs to the collateral of the Comet — a chain id, the Comet's
address and the token's — and not to a registry version, as a deprecated
collateral's does, so it survives every activation and comes back with a
version that brings the collateral back to its market. It is decided only for
a collateral of a market of the active version, so a collateral a new version
adds can be hidden only once that version is on, and from the switch until it
is hidden, discovery decides one nobody has decided about in its market by
its strategic mark and its value there, whatever the other markets that take
the token decide. It names the token the version holds, not the one the app
shows in its place: WETH, which the app shows as ETH at the zero address on
seven chains (WPOL and WRON likewise, as POL and RON), and wstETH, beside
which the app offers stETH on Ethereum. A collateral nobody has decided about
is not hidden, without a row. Every change is written in one D1 transaction
with its audit event, and migration `0008` enforces that in the database as
`0007` does for deprecated collaterals, in tables of its own. It only adds
them, so the release before it runs on beside them; a Worker rolled back to
that release ignores the decisions.

The routes are those of the deprecated collaterals, under the same limiter
budgets: hiding a collateral and applying a list share the `policy` one, and
the reads and the review count as reads. One collateral is hidden with
`PATCH …/networks/{chain_id}/markets/{comet}/collaterals/{token}/hidden`, and
a list is exported, reviewed without writing anything, and applied in one
transaction, with its rows under `hiddenCollaterals`, so that neither kind's
review takes the other's file:

```sh
curl -s "$API/registry/v1/admin/hidden-collaterals" -H "Authorization: Bearer $TOKEN" > hidden-collaterals.json
# edit hidden-collaterals.json: "isHidden": true on the collaterals to hide, and "reason"
curl -s -X POST "$API/registry/v1/admin/hidden-collaterals/review" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data @hidden-collaterals.json > review.json
jq 'if .error then .error else .summary end' review.json
# apply the rows the review shows as changes
jq 'if .error then error("the review failed: \(.error.message)")
    elif .summary.problems > 0 then error("the review found problems: fix the file and review it again")
    elif .summary.change == 0 then error("the review shows no change: there is nothing to apply")
    else {reason: null, hiddenCollaterals: [.hiddenCollaterals[] | select(.action == "change") | {chainId, cometAddress, deploymentKey, tokenAddress, symbol, isHidden: .requested, reason}]}
    end' review.json > reviewed.json \
  && curl -s -X POST "$API/registry/v1/admin/hidden-collaterals/apply" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' --data @reviewed.json \
  | jq 'if .error then .error else .summary end'
```

The runbook has the steps
([Hiding a collateral](./REGISTRY_RUNBOOK.md#hiding-a-collateral)). Every
command records the hidden decisions in force in `kv_registry` once it has
committed, apart from the deprecated ones, and `/active`, the market reads and
`/summary` answer with that record while D1 cannot be reached
([What a request reads](#what-a-request-reads)). Nothing is hidden when an
environment is brought up: there is no list to seed.

# Token Visibility

`/summary` says of each collateral whether token discovery shows its token in
that market (`is_visible`), and why (`visibility_reason`): a token the
market's Comet hides is not shown there
([Hidden Collaterals](#hidden-collaterals)), whatever else holds, which is
asked first; otherwise one it has deprecated is not shown there either
([Deprecated Collaterals](#deprecated-collaterals)); and any other is shown
when it is strategic ([Token Policies](#token-policies)), when what that
market holds of it is worth at least USD 250,000, or when that value cannot
be read, and is not shown otherwise. What the other markets of the chain hold
of the token, or decide about it, takes no part, and every market the active
version serves is decided so, whatever its status. The value is computed with
the market, never stored in D1, and compared exactly, in fixed point.

The words of the rule, as these sections, API.md and the code use them:

- a market _takes_ a token that the active version lists among its
  collateral, whatever is decided about it. It is _served_ when its status
  is `enabled` or `deprecated`, and only an _enabled_ one counts in whether a
  token is deprecated across its chain (`is_network_deprecated`);
- a market _offers_ a token it takes that is not deprecated there, and
  _leaves it to discovery_ where it offers it and does not hide it;
- a collateral's _value_ is what its market holds of it (`totalsCollateral`)
  at its price, in USD, at the block the summary read the market at: what the
  market holds none of is worth nothing, whatever its price, and a value
  whose price, or whose conversion to USD, could not be read is not known, as
  is one a remap prices through the feed it replaces, its replacement having
  stopped answering;
- a token a market leaves to discovery is decided there _by its strategic
  mark and its value_: shown when it is strategic, when its value there
  cannot be read, or when it is worth at least the threshold there, and
  otherwise not (`below_threshold`);
- `isDeprecated` is a Comet's decision on a collateral of
  `/registry/v1/active`, as `is_deprecated` is in `/summary`;
  `is_network_deprecated` says that an enabled market takes the token, and
  that every one that does has it deprecated. `isHidden` is only ever a
  Comet's decision.

A market's collateral is valued with the rest of its summary, from the same
reads: what the Comet holds of each collateral and its price, at the market's
block of the minute, the block every other field of the market is read at,
converted to USD as its totals are (`marketLatestSummary`), so the values
that are known add up to its `total_collateral_value_usd`, but where a remap
fell back on the feed it replaces, which the total counts and the value does
not. The header of that block is read beside them, in the first round of the
market's reads, once for the markets of a network read at the same block,
and dates the market's values, once (`collateral_value_block`); a header the
node does not give leaves the date out and fails nothing, and the log says
`block header not read` once a minute per network. All of it is
cached with the summary of the minute (`marketMinutelySummary`), so a
request in a minute already read asks the node for the latest block alone. A
value is never carried over from an earlier minute: a node that does not
serve the market's reads fails the summary, as it always has.

# Testing

Run unit and e2e dump tests with:

```
npm test
```

Note that the node-tap test runner has been configured to run tests on the compiled js files
instead of ts files using ts-node. This creates a significant performance improvement. However,
it means that to run an individual test, one must use the path to the js file directly. Eg.

```sh
# ❌ this fails
npm test tests/lib/computations/market/historical-market-day-summaries.test.ts

# ✅ this is good
npm test dist/tests/lib/computations/market/historical-market-day-summaries.test.js
```

Tests that need real Workers bindings run the worker in workerd with local
D1, KV, and rate-limit bindings through Wrangler's test harness
([`registryHarness`](./tests/util/registry-harness.ts)), applying the
migrations to fresh storage for every test. They need no Cloudflare
account or network access:

```sh
npm run test:worker
```

Node-side tests build their worker environment with
[`makeTestEnv`](./tests/util/test-env.ts). Its D1 and rate-limit bindings
throw when used, so code that needs them must be tested through the
harness, or be handed them: a database from
[`activeRegistryDatabase`](./tests/util/registry-database.ts), and, for
the administrative routes, the token and limiters of `adminTestEnv`,
which let every request through.

Every test that needs neither a node provider nor the R2 dumps runs with one
command, which is what CI runs: the registry suites above, and the unit tests
of the rest of the worker.

```sh
npm run test:offline
```

[`tests/offline.sh`](./tests/offline.sh) names each test it leaves out by
its file, and says why. A new test runs there, in whichever directory it
lives, unless it is added to that list as one that needs either.

## How to Update E2E test dumps
The E2E tests have been configured with dumps in order to significantly cut down on requests to
node providers. There are two types of dump files which are used in tests

1. Cache seed dumps
2. Result dumps

Tests use the cache seed dumps are used to populate the in memory cache, thus bypassing any requests
to node providers. When computations are run, they hit the cache directly and the result of the computations / handlers
are written to result dump files. The test then compares the result of the result of the computation
with the result dump file.

Using this approach is great, however it means that there is a bit more work needed when updating tests
since the dumps will go out of sync. To update the dumps, one may follow these steps:

```sh
# Allow fetch passthrough to hit node providers and regenerate the result dump file
# NOTE: it is necessary to sync the dumps first with ./tests/dumps/sync.sh
TEST_FLAGS_ALLOW_FETCH_PASSTHROUGH=true TEST_FLAGS_REGENERATE_DUMP=true npm test <path to test file>

# Regenerate the cache seed for the test
TEST_FLAGS_REGENERATE_CACHE_SEED=true npm test <path to test file>
```

Every branch reads the dumps from the same place in R2. Two tests pin the
SHA-256 of their expectation in `EXPECTATION_SHA256`, and their dumps are
named by it: the all-networks historical summary
([`historical-summary.test.ts`](./tests/e2e/market/all-networks/all-contracts/historical-summary.test.ts))
and the historical market day summaries
([`historical-market-day-summaries.test.ts`](./tests/lib/computations/market/historical-market-day-summaries.test.ts)).
Regenerating them writes new files, named by the new hash, and the test
prints the hash; pin it in the test, run the test again without the flags,
upload the files with the sync script below, and commit the pin. A dump that
changed in R2 without its pin fails the test instead of being compared
against, and a branch that regenerates these dumps never replaces the ones
another branch pins. The other tests' dumps are not pinned: each is one file
for every branch, and regenerating it replaces it for all of them, so a test
is pinned this way before a change to its output is recorded.

A regeneration reads the chain without a cache seed, which takes minutes, so
it needs a longer timeout than tap's default of 30 seconds. Name the tests
whose dumps you regenerate:

```sh
npm run build
TEST_FLAGS_ALLOW_FETCH_PASSTHROUGH=true TEST_FLAGS_REGENERATE_DUMP=true TEST_FLAGS_REGENERATE_CACHE_SEED=true \
  npx tap --disable-coverage --timeout=900 \
  dist/tests/e2e/market/all-networks/all-contracts/historical-summary.test.js \
  dist/tests/lib/computations/market/historical-market-day-summaries.test.js
```

At this point, you should now have some updated dump files. Due to the large size of these files, we don't
store them in git. Instead, they are stored in a cloudflare R2 bucket. To update the files in the bucket, we
have a script that does a bidirectional sync with `rclone`. First install `rclone`

```sh
brew install rclone # May need to install it from somewhere else depending on your OS
```

You will then need to add a configuration file for `rclone` to access cloudflare

```sh
# ~/.config/rclone/rclone.conf

[{your.r2.domain}]
type = s3
provider = Other
env_auth = true
# R2 credentials
access_key_id = 🤐
secret_access_key = 🤐

endpoint = https://<r2-id>.r2.cloudflarestorage.com
```



After setting that up, you can now run the sync script. This will update the files in the r2 bucket.

```sh
./tests/dumps/sync.sh
```

# Network Compatibility

The API should support any EVM-compatible networks where Comet is
deployed. It serves the mainnets the registry imports from Compound's
source — Ethereum, Polygon, Arbitrum, Optimism, Base, Scroll, Mantle, Linea,
Unichain and Ronin (`src/registry/source/roots.ts`).

Testnets are not served: the registry does not import them, so no market of
one can be resolved. A request that names one — a testnet network of a
market route, `testnets=include`, or a testnet market in the transaction
history — is answered `400` with the code `TESTNET_NOT_SERVED`
([API.md](./API.md#the-market-registry)). Which networks are testnets is what
`lib/well-known/networks` defines.

## Adding a New Network

Adding support for a new network requires configuring the API with a
network description, a list of required contracts, and some node
endpoint(s) that support the new network.

NOTE that the node endpoint for the network _must_ support all of the
`eth_*` JSON-RPCs corresponding with the computations defined in
`lib/computations/evm`. For example, `lib/computations/evm/eth-call.ts`
requires `eth_call` support; `lib/computations/evm/eth-get-logs.ts`
requires `eth_getLogs` support, with arbitrarily-sized block ranges; and
so on.

1. Adding a network description

In `./lib/eth-constants.ts` there is a `Networks` constant. Networks are
described by:

- `chainId`, numeric unambiguous EIP-155 identifier
- `chain`, the common name of the chain to which the network belongs
- `network`, the specific name of the network on that chain corresponding
  to the `chainId`.

For example: `{ chainId: 137, chain: 'polygon', network: 'mainnet' }`.

2. Adding node endpoints

In `./lib/eth-constants.ts` there is a `NodeEndpoints` constant map.
Networks are mapped by name to the node endpoints which are available to
the API that support the network.

If multiple available endpoints support the new network, enumerate as many
as desired, and order them by preference. Earlier-ranked node endpoints
will generally be used over later-ranked ones for a given network.

For example:

```
const NodeEndpoints: { [name in NetworkName]: string[] } = {
  // ...
  'ethereum-goerli': [
    'https://goerli.infura.io/v3/<infura_secret>',
  ],
  // ...
};
```

3. Add some block time estimates and well-known timestamps

In some areas of the API, an estimate of the number of seconds it takes to
confirm a block is used to extrapolate timestamps. Two configuration maps
enable this:

- `estimatedAverageBlockTimeStepChanges`: NetworkName -> ordered pairs of [ block, blockTime ]
- `wellKnownTimestampSnapshots`: NetworkName -> ordered pairs of [ block, timestamp ]

Adding more and more accurate steps to the
`estimatedAverageBlockTimeStepChanges` map may significantly affect the
overall accuracy of estimated timestamps for that network. Grossly
inaccurate estimates can result in the API computing answers affected by
time skew, which can present as user-facing bugs in some circumstances.

You should add test-cases to `./tests/lib/timestamp-estimate.test.ts` for
your new network to ensure that estimations don't error too widely.

The accuracy of `Eth.estimateBlockTimestampRelative(..)` should not error
more than 1hr (3,600s) for a new network when performing estimates
relative to the 'latest' block

The epsilon accuracy of `Eth.estimateBlockTimestamp(..)` is configurable
per-network, but in general should not exceed ~3hrs (10,800s).

4. Add well-known contracts

Under `lib/well-known/contracts` each network has a module where the
well-known contracts on that network are described.

Markets do not belong there any more. Comet deployments, their base,
collateral and reward tokens, and their price feeds come from the Comet
registry: add the network to the allowlist in
`src/registry/source/roots.ts`, import it, review its overlay, and activate
the version. Nothing about a new market requires a Worker release.

What a new network still needs here is everything the registry does not
describe: the governance contracts, a `BridgeReceiver` corollary where
governance is bridged, and any V2 or tooling contracts the API names. Its
COMP stays here too, because the governance routes find COMP by name; its
other tokens and its price feeds do not belong here, because the registry
names them.

See `lib/well-known/contracts/polygon-mainnet.ts` for an example.

Depending on how governance is implemented for a network, you may also
require a corollary to the `BridgeReceiver` contract, in order to
properly format proposal actions for governance.

5. If necessary: update `describeContractCallForHumans(...)`

In `lib/well-known/contracts/utils.ts`, there is a large function defined
called `describeContractCallForHumans`. This is responsible for properly
formatting proposal actions for governance endpoints by filtering on
function names, payloads, networks addressed, etc. to construct speficic
case-by-case human-readable descriptions of the actions taken by a
proposal.

If you are adding a new network with bridged governance from Ethereum
mainnet, proposals targeting that network will not have human-readable
actions on the proposal overview page of the governance site unless you
update this function appropriately.

Search for references to `'PolygonBridge'` and `'sendMessageToChild'` to
identify areas of this function related to formatting proposals across
chains between Ethereum and Polygon. Each cross-chain network can require
its own custom logic, but this can at least provide a starting point for
reference.

If you are adding a new network on an existing already-configured chain,
like 'ethereum' or 'polygon', you can likely skip this step. However, if
this network belongs to a new chain, step 5. will be very important to
ensuring that the proposal to activate the new market is readable and
accessible for the community to review.

6. Handle new network for cross-chain proposals

In `lib/well-known/contracts/utils.ts`, there is a function called
`getNetworkIfCrossChain` that needs to be modified to recognize the
new network for cross-chain proposals targetting the network.

In `src/governance-handlers/proposals.ts`, there is a function called
`hydrateCrossChainProposalsWithMoreStates` that also needs to be modified
to support the new network.

# Request Routing
The server accepts requests at the Cloudflare worker
[entrypoint](./entrypoint.ts), which decides by the path, and nowhere else,
which of two routers answers a request:

- everything under `/registry/v1` goes to the
  [registry router](./src/registry/router.ts): the registry's public reads
  and its administrative routes, with their preflights, their errors and
  their CORS headers;
- every other path goes to the legacy [router](./src/router.ts) and its
  handlers: the market routes in [./src/market.ts](./src/market.ts), and the
  governance, account, transaction history and V2 routes in their
  directories under `./src`. The entrypoint answers their preflight itself,
  and adds their CORS headers.

A router either fails the request (typically with a 4xx error because the URI
path is malformed), or passes it to a handler, which invokes the symbolic
computation engine to produce a response. The entrypoint adds the security
headers to every response, and what each kind of route answers a browser
with is in [./src/http/cors.ts](./src/http/cors.ts).

Basically:
`curl /example -> entrypoint -> router -> handler -> Response`.

# Symbolic Computations

The v3-api is written on top of a symbolic computation evaluator. The
evaluator replaces symbols in an expression with values until the
computation is complete.

In this case, the symbols are the names of computations. This is like
dependency injection: rather than invoking a function like:

```ts
utilization({ blockNumber: 123 })
```

You can reference the utilization at block 123 symbolically:

```ts
pull({ utilization: { blockNumber: 123 } })
```

A 'pull' is a special type of expression that symbolizes looking up the
results of referenced computations. The symbolic computation evaluator
knows how to interpret a `pull`, and so to evaluate this expression it
looks up the utilization at block 123.

Since we aren't invoking the utilization function directly, the evaluator
gets to decide:
- _how_ to pull the utilization at block 123, and
- _when_ to pull the utilization at block 123.

For our purposes, the evaluator can decide to read the utilization at
block 123 out of a cache, for example. The evaluator could also:

- defer and batch together computations that do I/O, like JSON-RPCs
- unroll recursive computations up to a recursion depth limit
- identify independent computations that can be performed in parallel
- anticipate resource exhaustion, like exceeding the subrequest limit.

Expressions containing symbols are called "reducible expressions," or
"redexes." `pull({ utilization: { blockNumber: 123 } })` uses the `pull`
redex, which is actually shorthand for a special kind of `pipe` redex.
Every redex can be rewritten as one of the two generalized redex types:

- `pipe` redexes, which are functions of symbols; and
- `join` redexes, which are functions of other redexes.

A `pipe` looks up some symbols by name in a given context and computes
something out of the results. So, for example:

```ts
pipe([
  { ethGetBlock: { blockReference: 'latest' } },
  ({ ethGetBlock: block }) => block.timestamp
])
```

The above `pipe` gets the `'latest'` block and extracts its timestamp.
`ethGetBlock` is the symbol to look up, `{ blockReference: 'latest' }` is
the context, and the function is the expression that uses the symbol to
compute something (in this case, the timestamp). The first item in the
tuple, the map of symbols and contexts, is also called a "lookup". The
second item is just called the "pipe function".

Remembering our example, we mentioned that `pull` is shorthand for a kind
of `pipe`: specifically, a `pull` is a `pipe` where the "pipe function" is
a no-op: it just returns values for symbols in the "lookup."

A `join`, on the other hand, is recursive: it reduces an array of other
redexes and computes something out of the results. So, for example:

```ts
const blockTimestamp = (blockReference: Eth.BlockReference) => pipe([
    { ethGetBlock: { blockReference } },
    ({ ethGetBlock: block }) => block.timestamp
])

join([
  [
    blockTimestamp({ blockReference: 10000 }),
    blockTimestamp({ blockReference: 20000 }),
    blockTimestamp({ blockReference: 30000 }),
  ],
  ([ t1, t2, t3 ]) => ((t2 - t1) + (t3 - t2)) / 20000,
])
```

The above `join` computes the average time between blocks for blocks
10,000 through 30,000 sampling one block every 10,000 blocks. The first
item of the tuple is the "redexes" or the "map", and the second item of
the tuple is the "join function" or the "reduce".

You can also think of redex as a recursive type, where `pipe`s are the
base-case and `join`s are the recursive case. Every `join` eventually ends
in a series of `pipe`s.

In addition to `pull`, there are many other shorthand redexes for common
types of `pipe` and `join`. Notably:

- `pull`  is a `pipe` that returns the result of the lookup unchanged
- `split` is a `join` that returns the results of its redexes unchanged
- `value` is a `pipe` with an empty lookup that just returns a value
- `pull1` is a `pull` that looks up only one symbol and unwraps it
- `pipe1` is a `pipe` that looks up only one symbol and unwraps it

An example for each expression:

```ts
pull({ ethGetBlock: { blockReference: 'latest' } })
// reduces to `{ ethGetBlock: <latest block> }`

pull1({ ethGetBlock: { blockReference: 'latest' } })
// reduces to <latest block> (unwrapped from `{ ethGetBlock: ... }`)

pipe1([
  { ethGetBlock: { blockReference: 'latest' } },
  latestBlock => latestBlock.timestamp
])
// note that with pipe1, you don't need to unwrap the result of the lookup

split([
  pull1({ ethGetBlock: { blockReference: 0 } }),
  pull1({ ethGetBlock: { blockReference: 'latest' } }),
])
// reduces to [ <block 0>, <latest block> ]

value(5)
// reduces to 5
// equivalent to pipe([ {}, ({}) => 5 ])
```

In all the above examples, we have omitted a key detail: reducible
expressions are constrained so that they can only reference symbols that
are in "scope". So the general type looks less like (pseudocode):

```ts
// pipe-type: [ Lookup, (results: any) => Return | Redex<Return> ]
// join-type: [ Redex<Return>[], (results: any[]) => Return | Redex<Return> ]
type Redex<Return> = [
  (Lookup | Redex<Return>[]),
  (results: any) => (Return | Redex<Return>)
]
```

and more like (pseudocode):

```ts
// pipe-type: [ Lookup<Scope>, (results: any) => Return | Redex<Scope, Return> ]
// join-type: [ Redex<Scope, Return>[], (results: any[]) => Return | Redex<Scope, Return> ]
type Redex<Scope, Return> = [
  (Lookup<Scope> | Redex<Scope, Return>[]),
  (results: any) => (Return | Redex<Scope, Return>)
]
```

The `Scope` type is a union of the `Compute.Spec`s upon which the
expression may depend. A `Compute.Spec` specifies a computation as the
following:

```ts
type SpecLike = {
  name: string,                // e.g. 'utilization'
  depends: Spec[],             // e.g. [ EthCall ]
  expects: Key.ProducesKey,    // string|number|boolean|Array<...>|...
  returns: Json.Representable, // Json values and implementors of toJSON()
};
```

Every computation has a `Spec` which "narrows" or "extends" the generic
type `SpecLike` above. So in practice, an exact spec type for the
utilization computation might look like:

```ts
type Utilization = {
  name: 'utilization';
  depends: [ EthCall ];
  returns: BigNumber;
  expects: {
    network: ('ethereum-mainnet' | 'ethereum-goerli');
    blockNumber: number;
    contract: {
      address: `0x${string}`;
      creationBlock: number;
    };
  };
};
```

Taking note of the base type, we see that each value satisfies the value
from the base type but is more specific: the `name` field is a `string`
literal type; the `depends` array references the `Spec`s of other
computations that will be in `Scope` for any reducible expressions used by
the computation; and the `returns` type must be either a primitive JSON
value or otherwise `JSON.stringify`able. The `expects` type has to satisfy
`ProducesKey`, which is similar to `Json.Representable` but instead of a
type that `ProducesKey` producing JSON it produces a string key. Every
computation implements a `key(...): string` function that must produce a
uniquely-identifiable key for the computation; this is used to create
human-readable cache keys for invocations of the computation.

Going back to redex `Scope`s, if we consider the scope for our original
example it would need to be written:

```ts
pull<Utilization>({ utilization: { blockNumber: 123, ... } })
```

You may already be thinking "writing out the `Scope` for every redex is a
lot of boilerplate." Yes! But in practice, you never need to specify the
`Scope` of a redex during its construction because the `Scope` has already
been provided by use of a `Functor`.

A `Functor` is a concept borrowed from OCaml, where it is used to
instantiate abstract modules for a type. This is similar to instantiating
a class with values passed into its constructor, but more general: since
you're instantiating a type, you still have to implement the _module_
returned by the `Functor` for that type. It's more similar to implementing
a generic abstract class.

For example, we can use a `Functor` to generate redex factory functions:

```ts
function RedexFunctor<Scope>() {
  return {
    pull(lookup: Lookup<Scope>) { ... },
    // ...
  };
}

const { pull } = RedexFunctor<EthGetBlock | Utilization>();

// now this type-checks:
pipe1([
  { ethGetBlock: { blockReference: 'latest' } },
  latest => pull1({ utilization: { blocNumber: latest.number } })
]);

// but this still does not:
pull({ somethingElse: { what: 'even is this' } });
```

This way it's not necessary to write code by constantly passing in the
same generics. So you should never need to write:

```ts
pull<EthGetBlock>({ ethGetBlock: { blockReference: 'latest' } });
```

which would indeed be pretty tedious.

We can not only use `Functor`s to instantiate redex factories, but also to
implement computation `Spec`s:

```ts
// Compute.Spec is a constructor for SpecLike types
// NOTE that we do not provide a `depends`, it defaults to empty: []
type A = Compute.Spec<{
  name: 'a',
  expects: number,
  returns: string,
}>;

const a = Compute.Functor<A>().implement({
  // No need to annotate types here, we passed in `A` to the `Functor`
  // So `num` is type `A['expects']` or `number`...
  // ... and the return type must be `A['returns']` or `string`.
  compute(num) {
    return num.toString();
  },
});
```

Depending on the type of computation, a `Functor` implementation may
require methods other than `compute`. The `AbiFunction` computation
`Functor` is implemented with a `signature` and a `parser`. For example,
we can look at `./lib/computations/comet/get-price.ts`:

```ts
import { BigFixnum }    from '../../bigfixnum.js';
import * as Eth         from '../../eth-constants.js';
import * as AbiFunction from '../abi-function.js';

type GetPrice = AbiFunction.Spec<{
  name: 'getPrice',
  expects: { priceFeed: Eth.Address },
  returns: BigFixnum,
}>;

const { implement } = AbiFunction.Functor<GetPrice>();
const getPrice = implement({
  signature: `function getPrice(address) view returns (uint256)`,
  parameters: ({ priceFeed }) => [ priceFeed ],
  parser: ([ u256 ]) => BigFixnum.from({ decimals: 8, value: u256 }),
});

export { GetPrice, getPrice };
```

An `AbiFunction` computation is not implemented by writing a `compute`
method, but by providing:

1. An ABI signature, like `function getPrice(address) returns (uint256)`
2. A transformation from context to function parameters
3. A parser from the raw ABI response into the desired return type
4. Optionally, what a revert of the call answers (`reverted`). Without it a
   revert fails the computation, as any other error of the call does; the
   real `getPrice` answers one, to report a price feed Chainlink retired
   instead of failing every summary that reads it

Behind the scenes, a `compute` function is generated for you that uses the
implemented methods to abstract away the boilerplate involved in invoking
an ABI function -- which includes encoding the input parameters, decoding
the result, and constructing and performing a JSON-RPC call to an Ethereum
node provider.

Thanks to the `AbiFunction.Functor`, we don't have to provide type
annotations anywhere in our implementation logic -- they were already
provided when we instantiated the module and before we implemented it.

Now in order to actually run these computations, we need an `Evaluator`.
Like a redex, an `Evaluator` has a scope that describes which computations
it is capable of computing:

```ts
const abcEvaluator = Evaluator<A|B|C>({ a, b, c });
const getPriceEvaluator = Evaluator<GetPrice>({ getPrice });

abcEvaluator.evaluate(abcEvaluator.pull1({ a: 5 }));
TBD TBD TBD
```
