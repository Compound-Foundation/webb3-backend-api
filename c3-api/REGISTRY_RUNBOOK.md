# Comet registry runbook

For the person who brings the market registry up in an environment, or
switches it to a newer list of markets. You do not need to know how the
registry works inside; every step says what it is for, what to run, what you
should see, and what to do when you see something else.

The design behind it is in [README.md](./README.md#the-comet-market-registry),
and every route in [API.md](./API.md#registry-v1).

## The idea

The registry is the list of markets the API serves — their addresses,
tokens, prices, names, and which features each one has. A new list is never
edited in place. It is built as a **draft** (a "candidate version"), checked,
**approved** by one person, and only then **switched on** ("activated") by
another. Until the switch, users see no change at all, and after it, one
command switches back.

## Before you start

- The environment's database has every migration applied, and this happened
  **before** the worker release that needs it:
  `npm run d1:migrate:stage` or `npm run d1:migrate:production`.
- The worker is deployed, and it reaches the node provider proxy.
- The environment has admin tokens, and you hold one of your own with the
  role `admin` — the token itself, not its hash. See
  [The admin tokens](#the-admin-tokens) if the environment has none yet, or
  none for you.
- A second person with an `admin` token of their own approves what you switch
  on (step 5 of the bring-up): a version is switched on by two people, and
  two tokens of one name are one person. So the environment's list names two
  admins at least before the release with approvals reaches it
  ([The admin tokens](#the-admin-tokens)); with one, nobody there can switch a
  version on.
- The release with approvals is deployed to all of the environment's traffic
  at once, never beside the release before it in a gradual deployment, and
  every Worker bound to the environment's database runs it before anyone
  approves there — a second Worker of another branch on the same database
  too. Once an approval exists, the database refuses an older release's
  activations, and its rollbacks but the one step back, which then answer
  `500`: from then on a bad release is fixed by rolling forward, never by
  deploying an older one again. Until then, an older release still switches
  versions on without an approval. Its migration, `0011`, is applied before
  it, as every migration is.
- Stage and production have `COMET_GITHUB_TOKEN` set. Without a token GitHub
  allows the import 60 API requests an hour per address, which the Worker
  shares with every other Worker leaving Cloudflare through it, and an import
  fails with `SOURCE_REQUEST_FAILED`, "its rate limit is used up". A
  fine-grained GitHub token with read-only access to public repositories, and
  no other permission, is enough; Wrangler prompts for it:

  ```sh
  npx wrangler secret put COMET_GITHUB_TOKEN --env stage
  npx wrangler secret put COMET_GITHUB_TOKEN --env production
  ```

- The environment announces every approval, and every version switched on or
  rolled back to, in the team's channel:
  [Announcing changes](#announcing-changes) sets that up, once. Without it
  nothing is announced.
- [The preflight](#the-preflight) has passed on the commit being deployed,
  and in an environment that already serves users, the window it measured is
  announced (the note below).

Nothing runs on your machine but the requests: the Worker being deployed
imports the source, and checks the decisions you send it against the source
and the chain. Those decisions are the seed of the commit being deployed,
[`c3-api/registry/seed/production.json`](./registry/seed/README.md), so run
the terminal commands from the root of a checkout of that commit, with `jq`
installed, after:

```sh
export API=https://v3-api-stage.compound.xyz        # the environment you work on
export TOKEN='<your admin token>'
```

Every step shows the terminal command, and beside it the same request for
Postman, written as the request itself: the method and URL on the first line,
then the headers, then the body. To use them:

- Create a Postman environment with the variables `API` (the environment's
  address, e.g. `https://v3-api-stage.compound.xyz`, or `http://localhost:8787`),
  `TOKEN` (your admin token) and `V` (the draft's id, filled in step 1).
- Send every administrative request with `Authorization: Bearer {{TOKEN}}` —
  or set **Authorization → Bearer Token → `{{TOKEN}}`** once on the collection
  and let the requests inherit it.
- A body is **Body → raw → JSON**. Postman then adds
  `Content-Type: application/json` itself.
- Postman shows the whole answer; each step says which fields to look at.

> **An environment that already serves users.** The market, account and
> history routes read their markets from the registry and answer `503` while
> no version is active, and the release that reads from the registry serves
> users from the moment it is deployed. So the deploy opens a window of
> `503`s, which step 6 closes. Keep it short and expected:
>
> 1. Run [the preflight](#the-preflight) on the commit being deployed, and
>    time it. It is the same steps against the real chain, so it finds a
>    block or a feed the seed has wrong before anyone waits on it, and says
>    how long the window will be.
> 2. Announce the window beforehand — when it opens and how long it lasts —
>    to the frontend's maintainers and to whoever answers users.
> 3. Deploy, and run steps 1 to 8 below straight away, one after another,
>    with the second admin at hand for step 5.
>
> Once a version is active, a client that pages transaction history with a
> cursor it was given before is told to start over, once
> (`409 REGISTRY_VERSION_CHANGED`), whatever mainnet market its `markets[]`
> names. The history before the registry took any Comet it knew in
> `markets[]`: the page that starts over refuses one whose history the version
> does not serve (`400`), and a request that names a testnet one is refused
> before its cursor is read (`400 TESTNET_NOT_SERVED`).

### The admin tokens

Every administrative route takes a bearer token. Each person who works on
the registry, and each monitor, has a token of their own, with a name and a
role. The name is who holds the token: every change it makes is recorded
under that name, but for a validation, which decides nothing and records
only its checks. The role is what it may call, and each role may call
everything the one before it may:

| Role | May call | For |
|---|---|---|
| `monitor` | `GET /admin/status` | a monitor that polls the status |
| `reader` | every `GET` under `/admin`, and the review of a list of decisions | someone who reads drafts, versions and decisions |
| `operator` | besides, imports, cancelling a run, and overlay writes | someone who reviews drafts |
| `admin` | besides, validate, approve, activate and rollback, and the decisions about tokens and collaterals, one at a time or by a list | someone who decides what is served |

An import not held for review validates its draft by itself once it
completes, so an `operator` can import a version that validates; switching
it on takes two `admin`s of two names, one who approves it and another who
activates it. So an environment needs two people with the role `admin`, each
holding a token of their own, and one person never holds two names: the
names are what the registry tells people apart by. A decision about a token
or a collateral — marking a token strategic, a collateral deprecated or
hidden — is one admin's: it takes effect as soon as it is made, needs
nobody's approval, and is not announced.

The worker keeps only the SHA-256 of each token: what is configured cannot
be used as a token. Tokens go to their holders through the team's password
manager, and their hashes — never the tokens — into the environment, as one
secret: the list `COMET_REGISTRY_ADMIN_TOKENS`. Whoever can put that secret
can make a token of any name and role, so leave it to the environment's
owner. Each environment has its own list: a stage token is not a production
one.

**1. Make a token** for its holder. 32 random bytes are plenty:

```sh
export NEW_TOKEN="$(openssl rand -hex 32)"
```

**2. Hash it.** Use `printf`, not `echo`: `echo` adds a newline, the newline
would be part of what is hashed, and the token you then send would not match.

```sh
printf '%s' "$NEW_TOKEN" | shasum -a 256 | cut -d ' ' -f 1
```

On Linux `sha256sum` takes the place of `shasum -a 256`, and OpenSSL works
anywhere. Keep the `cut` with either: each prints more than the hash — `  -`
or ` *stdin` after it — and the list takes the 64 hex digits alone.

```sh
printf '%s' "$NEW_TOKEN" | openssl dgst -sha256 -r | cut -d ' ' -f 1
```

**3. Write the list**, `tokens.json`, with an entry for each token:

```json
[
  { "name": "alice",          "sha256": "<the hash from step 2>", "role": "admin",    "notAfter": null },
  { "name": "bob",            "sha256": "<his token's hash>",     "role": "admin",    "notAfter": null },
  { "name": "olga",           "sha256": "<her token's hash>",     "role": "operator", "notAfter": null },
  { "name": "status-monitor", "sha256": "<the monitor's hash>",   "role": "monitor",  "notAfter": null }
]
```

Each entry has these four, and nothing else:

- `name` — who holds the token: 1 to 64 lowercase letters, digits, `.`,
  `_`, `@` or `-`, the first a letter or a digit. Two entries share a name
  only while their holder rotates a token.
- `sha256` — the hash from step 2. A token is listed once.
- `role` — `monitor`, `reader`, `operator` or `admin`.
- `notAfter` — `null`, or the last instant the token is taken at, in UTC,
  such as `2027-05-01T00:00:00Z`.

Cloudflare stores a secret of at most 5 KB, which is about thirty entries,
so drop the entries of expired tokens whenever you put the list again. It
never shows a secret again either: keep `tokens.json`, which holds hashes
and no token, where the next change will start from, such as the password
manager.

**4. Put the list into the environment.** Wrangler reads the secret from the
pipe, on one line, and it takes effect without a deploy:

```sh
jq -c . tokens.json | npx wrangler secret put COMET_REGISTRY_ADMIN_TOKENS --env stage
jq -c . tokens.json | npx wrangler secret put COMET_REGISTRY_ADMIN_TOKENS --env production
```

For a worker you run on your own machine, the same line goes into
`.dev.vars`, which git ignores, in single quotes — with two `admin` tokens
of your own under two names, since a version is switched on by two:

```
COMET_REGISTRY_ADMIN_TOKENS='[{"name":"local-admin","sha256":"<the hash from step 2>","role":"admin","notAfter":null},{"name":"local-approver","sha256":"<the hash of a second token>","role":"admin","notAfter":null}]'
```

**5. Check each token** with a request its role may make: an unknown
version id for any role but `monitor`, because reaching a `404` means the
token was accepted, and the status for a `monitor`, which answers `200`:

```sh
curl -s -o /dev/null -w '%{http_code}\n' \
  "$API/registry/v1/admin/versions/00000000-0000-4000-8000-000000000000" \
  -H "Authorization: Bearer $NEW_TOKEN"
curl -s -o /dev/null -w '%{http_code}\n' "$API/registry/v1/admin/status" \
  -H "Authorization: Bearer $NEW_TOKEN"
```

For anything else, run the command again without `-o /dev/null` to see the
message:

- `401`, "the bearer token is not valid": the list has no entry for this
  token — a hash made with `echo`, another token's, or the token itself,
  listed in place of its hash. Hash it again (step 2) and put the list again.
- `401`, "the bearer token has expired": its `notAfter` has passed.
- `403`, "the token … has the role …, and this route needs …": the token is
  accepted, and its role does not reach the route — a `monitor`'s, on
  anything but the status.
- `403`, "… COMET_REGISTRY_ADMIN_TOKENS is malformed": the worker cannot read
  the list, such as one with a hash copied with the `  -` or ` *stdin`
  printed after it, and refuses every token until it can. The worker's log
  line `registry route refused`, under the answer's `requestId`, names the
  entry and what is wrong with it; correct the file and put it again
  (step 4).
- `403`, "… is not configured in this environment": the environment has no
  list, or one with no entry, and an unconfigured admin API is a closed one.
  Put the list (step 4).

**Rotating a token.** Make a new token for the same holder (steps 1 and 2),
add its entry under the same name and role, give the old entry a `notAfter`
a few days ahead, and put the list (step 4). Both tokens are taken until
then: the holder switches, and after it the old one is refused as expired.
Drop its entry the next time you put the list. A token that may have leaked
is not rotated: drop its entry and put the list, which refuses it from then
on.

### Announcing changes

Every move that changes what the registry serves — switching a version on,
or rolling back to one — is posted to the team's channel once it is made, so
the people who answer for the markets hear of it, whoever made it. So is
every approval, as it is given: the channel hears of a version about to go
on while it can still be stopped. Nothing else is posted: not an import, a
validation or a review, nor a decision about a token or a collateral, nor a
move that changed nothing, nor a move or an approval that was refused. The
channel reads:

> [production] bob approved registry version c0d77dad-… (commit a34d9b5)
> until 2026-11-05T11:00:00.000Z, against d9698ddd-…. Markets: 1 added,
> 0 removed, 2 changed, 0 no longer served; networks: 1 added, 0 removed,
> 0 changed. Reason: "read the changes"
>
> [production] alice activated registry version c0d77dad-… (commit a34d9b5),
> replacing d9698ddd-…, approved by bob. Markets: 1 added, 0 removed,
> 2 changed, 0 no longer served; networks: 1 added, 0 removed, 0 changed.
> Reason: "switch on the new commit"

The message carries the same facts for a program to read as well
(`registryEvent`, [API.md](./API.md#registry-v1)).

**1. Make a webhook** in Slack for the channel Compound names: an app with
Incoming Webhooks switched on, added to that channel. Its URL,
`https://hooks.slack.com/services/…`, is the credential: whoever holds it can
post to the channel. Keep it in the team's password manager, never in a
ticket, a chat or the repository. Stage and production may share a channel,
since every message names its environment.

**2. Test it** with a message of the shape the worker sends:

```sh
export WEBHOOK='<the webhook URL>'
curl -s -X POST "$WEBHOOK" -H 'Content-Type: application/json' -d '{
  "text": "[stage] a test of the registry webhook: nothing was switched on",
  "unfurl_links": false,
  "unfurl_media": false,
  "registryEvent": {
    "kind": "activate", "environment": "stage", "at": "2026-11-04T12:00:00.000Z",
    "actor": "alice", "reason": "a test of the webhook",
    "version": {
      "id": "00000000-0000-4000-8000-000000000000", "sourceRepository": "compound-foundation/comet",
      "sourceCommitSha": "0000000000000000000000000000000000000000",
      "checksum": "0000000000000000000000000000000000000000000000000000000000000000"
    },
    "previousVersion": null, "activationId": "00000000-0000-4000-8000-000000000001", "approval": null, "changes": null
  }
}'
```

**You should see** `ok`, and the text in the channel. Anything else is what
Slack says is wrong: `no_service` or `invalid_token` is a webhook removed or
mistyped, `channel_not_found` or `channel_is_archived` its channel gone, and
`invalid_payload` a body it did not take.

**3. Put it into the environment.** Wrangler prompts for it, and it takes
effect without a deploy:

```sh
npx wrangler secret put COMET_REGISTRY_WEBHOOK_URL --env stage
npx wrangler secret put COMET_REGISTRY_WEBHOOK_URL --env production
```

`GET /admin/status` then answers `"notifications": {"webhook": "on", …}`.
`"invalid"` there is a value that is not an `https` URL, which raises
`configuration-invalid` as well and is never posted to: put it again.

**It is best effort.** A message is sent once the move is made or the
approval given, and given up when the webhook has not answered in 5 seconds;
it never fails or delays the command. What was approved and switched on, by
whom and why is recorded either way: `GET /admin/versions/<id>` lists every
move of a version under `activations`, and every approval of it under
`approvals`. A message given up is in the worker's log as
`registry notification failed`, never with the webhook's URL, and the status
raises `notification-failing` until a later message is sent
([Keeping an eye on it](#keeping-an-eye-on-it)).

**To replace the webhook**, make the new one, test it and put it (steps 1 to
3), then remove the old one in Slack. **To stop announcing**, delete the
secret:

```sh
npx wrangler secret delete COMET_REGISTRY_WEBHOOK_URL --env stage
```

A worker you run on your own machine announces too when `.dev.vars` sets the
webhook: use a channel of your own there, never the team's.

### The preflight

The seed's tests check it against everything but the chain. What only the
chain can confirm — that each creation block is the block its Comet was
deployed in, and the decimals of each feed — step 3 of the bring-up checks as
it sends the file, and one block the chain contradicts refuses all of it. So
before an environment depends on the file, bring a registry up with it once
on your machine, on a database of its own, against the real chain. Nothing of
it reaches any environment.

**Set it up.** In `c3-api` of a checkout of the commit being deployed, put
into `.dev.vars` a `COMET_REGISTRY_ADMIN_TOKENS` that lists two admin tokens
of your own under two names (see [The admin tokens](#the-admin-tokens)) —
step 5 approves the version with one, and step 6 switches it on with the
other — a `COMET_GITHUB_TOKEN`, and the `NODE_PROXY_HOST` and
`NODE_PROXY_KEY` of a deployed node provider proxy whose providers keep
archive state: the creation blocks are read at past blocks. Leave
`COMET_REGISTRY_WEBHOOK_URL` out, or name a channel of your own: steps 5 and
6 approve a version and switch it on, which is announced. The local source
is the one stage and production import, `Compound-Foundation/comet` at
`main`. Then start the worker on an empty database, kept apart from your
usual local one:

```sh
cd c3-api
npx wrangler d1 migrations apply APP_DB --local --persist-to .wrangler/preflight
npx wrangler dev --local --persist-to .wrangler/preflight entrypoint.ts
```

With the proxy run on your machine instead
([README.md](./README.md#getting-started)), leave `NODE_PROXY_HOST` and
`NODE_PROXY_KEY` out of `.dev.vars`: a `NODE_PROXY_HOST` there overrides the
binding ([wrangler.local-proxy.toml](./wrangler.local-proxy.toml)). Give the
proxy, in `../node-provider-proxy/.dev.vars`, the keys of providers that keep
archive state, and add `-c wrangler.local-proxy.toml` to both commands.

**Bring it up.** In another terminal, from the root of the checkout, with
`export API=http://localhost:8787` and your first token in `TOKEN`, run steps
1 to 8 of [the first bring-up](#bringing-an-environment-up-for-the-first-time),
step 5 with your second token in `TOKEN`, and time them.

**You should see** each step answer as it says. Step 2 prints its
`compared:` line alone, or above it only markets the source has added, in
its second column. Step 3 answers `"changed": true`, with nothing unreviewed
but those; to check the file it asks the node 10 `eth_blockNumber`, 58
`eth_getCode` at past blocks — each Comet at its creation block and at the
block before — and the decimals of up to 19 feeds. Step 4 answers
`validated`, step 7 serves every market, none in `error`, and step 8's
review finds no problem: the version holds every collateral of the initial
list, which the tests cannot check for the wstETH and USDS markets. Then
compare `GET $API/registry/v1/active` with the markets the frontend lists
today: every one is there, under the same display name, base asset name,
slug, and default and institutional flags.

**If not.** What step 3 refuses, its table explains. Where the file is at
fault, it needs a change ([its README](./registry/seed/README.md#changing-it))
before any environment is brought up with it, and so does the list of step 8
for a row its review finds a problem in. A `503` there with
`details.code` `CHAIN_REQUEST_FAILED` and
"the node provider did not serve the code of 0x…", naming a Comet, is a
provider that did not serve the Comet's code at a past block — most often one
that does not keep the state of past blocks: route the network to one with
archive state. To run the preflight again, stop the worker, delete
`c3-api/.wrangler/preflight`, and start the worker again as above; delete it
once you are done, too.

## Bringing an environment up for the first time

### 1. Import — take a snapshot of the source

```sh
curl -s -X POST "$API/registry/v1/admin/sync" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | jq
export V=<registryVersionId from the answer>
```

Postman:

```http
POST {{API}}/registry/v1/admin/sync
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{}
```

Copy `registryVersionId` from the answer into the `V` variable — or let
Postman do it, with this under **Scripts → Post-response**:

```js
const id = pm.response.json().registryVersionId;
if (id) pm.environment.set('V', id);
```

**Why.** The registry reads the list of markets from Compound's official
repository at one exact commit, and reads from the blockchain everything the
chain can confirm: addresses, tokens, price feeds. The result is the draft.

What the chain cannot say — what a market is called, whether it is offered,
which features it has — is a human decision. On the first import there is no
earlier version to take those decisions from, so every market arrives
**switched off and unreviewed**, and the draft is **held**: nothing is decided
for you.

**You should see** `"status": "completed"` and `"heldForReview": true`, with
`"completed"` equal to `"expected"`: the draft holds every market of the
source. `"checksFailed"` counts the checks the draft does not pass yet: on a
first import it is never zero, because nothing has been reviewed — the
missing default market alone is one of them. You work it down in the steps
below. A `"completed"` below `"expected"` is an import that gave markets up —
its `"reason"` says how many — and a draft without them cannot validate:
start again as the end of this step says.

**If not.** `"status": "running"` means the import has more to do: send the
same request **with an empty body** (`{}`) and repeat until it answers
`"completed"`. The answer says how far it has got —

```json
{ "status": "running", "expected": 29, "completed": 23, "outstanding": 6 }
```

— where `expected` is how many markets the source has, `completed` how many
are imported, and `outstanding` how many are still to try. A market the chain
did not answer for goes back into the queue and is tried again by the next
request, so the number each request gets through varies. Which markets are
left, and why, is in `GET /registry/v1/admin/sync-runs/<syncRunId>`.

One request imports up to fifty markets: the budget of one Worker invocation
on the Workers Paid plan holds the whole source, which takes about 230 of its
10,000 subrequests. A request cut short after it has imported a market — by
GitHub or the node provider no longer answering, or not in time — leaves the
markets it did not reach to the next one, without holding that against them,
and repeating the request is the whole procedure; there is nothing to tune.
The database restarted under a market, or overloaded, is held against that
market, though: the market fails as `the database did not answer`, which
spends one of its five attempts, and the next request tries it again.

A request that finds GitHub or the node provider not answering before it has
imported anything is different: every market it tries fails, and spends one
of its five attempts. A market that has spent all five is given up, and the
draft can then no longer validate, so do not repeat such a request in a
loop. When an answer says `running` and `completed` is no higher than it was
before the request, read why in
`GET /registry/v1/admin/sync-runs/<syncRunId>`: `SOURCE_REQUEST_FAILED` or
`CHAIN_REQUEST_FAILED` there is GitHub or the node provider proxy not
answering — fix the proxy, or wait for GitHub, and only then send the
request again.

Do not repeat the request with `forceNewAttempt` or `holdForReview` while it
is running: those decisions belong to the run that is already in progress, so
the request is refused with `409` rather than quietly ignoring them. An error
means the import could not finish; see
[When something goes wrong](#when-something-goes-wrong).

**If the hourly job got there first.** The scheduled job imports too: it
starts the first import within the hour after the deploy, and goes on two
markets an hour (`COMET_SYNC_MARKETS_PER_INVOCATION`). Your request continues
that import and names its draft, as above, except in three cases:

- `409`, `details.code` `SYNC_ALREADY_RUNNING`, "another invocation is
  importing right now": the job is importing this very minute. Send the
  request again a minute later. A request of yours that failed, such as with a
  `503`, gave the import back as it failed, unless the database was still not
  answering then — the worker's log has `registry lease not released` for it.
  That one, like one stopped without an answer — by a deploy, or past the time
  or CPU a Worker is given — holds the import until its lease runs out, at
  most 15 minutes.
- `"status": "idle"`, `"reason": "upstream was checked recently"`, and
  `registryVersionId` `null`: the job has finished its import and held the
  draft, and the source was checked less than a day ago, so the request has
  nothing to do and names nothing. Expect this answer for as long as the
  draft is held: the job checks the source again once a day, and every check
  starts a new day.
- `"status": "idle"`, "a candidate of this commit is held for review": the
  same draft, named in `registryVersionId`. A request gets this answer only
  in the hour after a day runs out, before the job checks the source again,
  so it is not one to wait for.

After either `idle` answer, take the draft from the status, which also says
how the job's import went:

```sh
curl -s "$API/registry/v1/admin/status" -H "Authorization: Bearer $TOKEN" \
  | jq '{draft: .candidates.importing, lastRun: .sync.lastRun}'
export V=<the versionId listed under draft>
```

In Postman, `GET {{API}}/registry/v1/admin/status` with the token: the
`versionId` under `candidates.importing`, and `sync.lastRun`;
`GET /registry/v1/admin/versions?status=importing` lists the same draft.

Use the draft only if the job imported every market: in `sync.lastRun`,
`completedCount` equals `expectedCount`, and `failedCount` is `0`. A
`failedCount` above `0` counts the markets the job gave up after five
attempts each, and a draft without them cannot validate — the run says
`completed` all the same, because a first import is held whatever it brought
in. Read why in `GET /registry/v1/admin/sync-runs/<sync.lastRun.id>`, fix the
cause — most often the node provider proxy — and send this step with
`{"forceNewAttempt": true, "reason": "first import"}`: a new import of the
whole source, whose draft you use instead. Once it has every market, it
closes the incomplete one.

### 2. Check that the draft holds the seed's markets

```sh
set -o pipefail
jq -r 'to_entries[] | "\(.key) \(.value)"' c3-api/registry/seed/production.comets.json | LC_ALL=C sort > seed-markets.txt &&
curl -sS "$API/registry/v1/admin/versions/$V/changes" -H "Authorization: Bearer $TOKEN" > changes.json &&
jq -r '.markets.added[] | "\(.scope) \(.market.contracts.comet)"' changes.json | LC_ALL=C sort > draft-markets.txt &&
LC_ALL=C comm -3 seed-markets.txt draft-markets.txt &&
echo "compared: $(wc -l < draft-markets.txt | tr -d ' ') markets in the draft"
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions/{{V}}/changes
Authorization: Bearer {{TOKEN}}
```

Each entry of `markets.added` is a market of the draft, with its key as
`scope` and its Comet as `market.contracts.comet`: compare them with
`c3-api/registry/seed/production.comets.json`.

**Why.** The seed names each market by its key, such as `1/usdc`, and its
decisions were made for one Comet, which `production.comets.json` beside it
names. The draft holds what the source listed at the commit it imported, and
since the seed was written the source may have added a deployment, renamed or
dropped one, or given a key another Comet. This compares the two before
anything is sent. It changes nothing.

**You should see** only `compared: 29 markets in the draft`, with no line
above it: the draft holds every market of the seed, under the seed's Comet,
and no other. In Postman, 29 entries under `markets.added`, each the key and
the Comet of one line of the file.

**If not.**

- A line at the start of the row — `comm`'s first column — is a market of the
  seed that the draft does not hold under that Comet: the source dropped or
  renamed it, or gave its key another Comet, and then a second-column line
  names the key with the Comet the draft holds. Stop: the draft refuses the
  seed whole, with `404` for a key it lacks and `422` for a key that names
  another Comet. The file needs a change, by a pull request
  ([its README](./registry/seed/README.md#changing-it)); nothing in the
  Worker reads it, so the change needs no release of its own. While users
  wait, it is quicker to cut the file down to what the draft holds under the
  seed's Comets ([its README](./registry/seed/README.md#cutting-it-down)) and
  describe the rest afterwards.
- A line indented into the second column, alone, is a market the source lists
  and the seed does not describe. The seed leaves it switched off and
  unreviewed, the draft can be switched on without it, and it is described
  afterwards — see [Describing a new market](#describing-a-new-market). Go on.
- `jq: error … Cannot iterate over null` means the request was refused, and
  nothing was compared: `jq .error changes.json` says why
  ([When something goes wrong](#when-something-goes-wrong)).
- A `curl: (N) …` line means the request did not reach the API — `API`
  unset, or the host down or out of reach — and nothing was compared. Set
  `API`, or wait for the host, and run the block again.

### 3. Send the seed

```sh
curl -s -X PUT "$API/registry/v1/admin/versions/$V/overlays" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @c3-api/registry/seed/production.json | jq '.error // {changed, unreviewed}'
```

Postman:

```http
PUT {{API}}/registry/v1/admin/versions/{{V}}/overlays
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

<the file c3-api/registry/seed/production.json>
```

Send the file as it is: **Body → binary**, and select it. Set the
`Content-Type: application/json` header yourself.

**Why.** The file holds every decision about the seed's networks and markets,
each the whole document the overlay routes take, and the draft takes all of
them in one request — or, if any part is refused, none. Before anything is
written, the Worker holds the file against the chain: each creation block has
to be the block its Comet was deployed in, and it reads the decimals of every
feed the file names that the draft does not know yet. Users still see no
change.

**You should see** `"changed": true`, and `unreviewed` empty — or holding only
the markets of step 2's second column, and under `networks` a chain whose
every market is among them.

**If not.** Whatever the answer, nothing was written, so the file can be sent
again once the cause is fixed.

| What you see | What it means | What to do |
|---|---|---|
| `404`, "chain …, …/… not imported into this registry version yet" | The draft lacks networks and markets the file names; the message names every one | Do as step 2 says for a line in its first column |
| `404`, "no registry version with that id" | `V` is not the draft's id | Take it from step 1 |
| `409`, `details.code` `OVERLAY_CHANGED`, "the overlay of network …, market … is no longer the one this was decided against", with `details.current` naming each | A scope the file names holds a review. Either the file is in already — sent before, by a request whose answer you did not see — or part of the draft was reviewed before the file came | Read the draft: `GET …/versions/$V`. If its `unreviewed` lists no more than step 2's second column, the file is in: go on to step 4. If it lists more, the rest was reviewed by hand, or handed down from an earlier attempt of this commit (step 4) or from a version that is on, when this is no first bring-up: describe what is left with the overlay routes ([Describing a new market](#describing-a-new-market)) |
| `409`, `details.code` `VERSION_NOT_IMPORTING`, "… registry version cannot be changed" | The draft is no longer open: it was validated, or replaced by a newer attempt of its commit | As the `409` row on writing overlays in [When something goes wrong](#when-something-goes-wrong) says |
| `409`, `details.code` `OVERLAY_CHANGED`, "the registry version changed while this overlay was being written" | Something else wrote to the draft in the same moment | Send it again |
| `409`, `details.code` `REWARD_FEED_WITHOUT_REWARD`, "… has no reward asset on chain, so it cannot carry a reward price feed" | The file gives a reward feed to a market whose rewards contract names no reward token | The file needs a change: that market's rewards off and no reward feed, as `1/institutional_usdc` has ([its README](./registry/seed/README.md#changing-it)) |
| `422`, `details.code` `OVERLAY_CREATION_BLOCK_WRONG`, "markets.….creationBlock … is before the Comet … was deployed", "is after" it, or "is past the latest block" | The file's block for that market is not the block its Comet was deployed in, or the key names another Comet than the one the file was made for (step 2) | If step 2 showed the key under another Comet, the file's block is right for the Comet the file was made for: take the key's document and its expectation out ([its README](./registry/seed/README.md#cutting-it-down)), and describe the market for its new Comet after the bring-up ([Describing a new market](#describing-a-new-market)). Never give the old document the new Comet's block: its other decisions were made for the old one. Otherwise the file needs the block the chain's explorer gives as the "Contract Creation" of the Comet `production.comets.json` names ([its README](./registry/seed/README.md#changing-it)). [The preflight](#the-preflight) finds this before an environment depends on it |
| `422`, `details.code` `OVERLAY_FEED_UNREADABLE` | A feed the file names does not answer its decimals on that chain: it reverts, or nothing is deployed at that address there | The file needs the right feed ([its README](./registry/seed/README.md#changing-it)) |
| `422`, `details.code` `CHAIN_RESPONSE_INVALID`, "the code of 0x… returned no data", "eth_blockNumber returned no data" or "… no block number" | The node provider answered the creation-block check with something that is neither code nor a block number. The file is not at fault | Send it again; if it repeats, route the network to another provider |
| `503 UPSTREAM_UNAVAILABLE`, `details.code` `CHAIN_REQUEST_FAILED` | The node provider did not answer the reads, or not in time, or did not serve one. "The node provider did not serve the code of 0x…", naming a Comet, is that Comet's code at a past block, which the creation blocks are read at: most often a provider that does not keep the state of past blocks | Send it again once the proxy answers. For a Comet's code, route the network to a provider with archive state |
| `400`, "the request body must be JSON" | The request had no `Content-Type: application/json`, which `--data-binary` alone does not send | Send it with the header |
| `400`, `details.code` `OVERLAY_INVALID`, naming a document of the file | The file is not the one the commit holds: a document was edited into one the overlay routes refuse | Send the file as the commit has it; its tests refuse such a file |
| `400`, "expectedDigests names …, which this request has no overlay for" | A file cut down without its expectations: it still expects a document it left out | Cut `expectedDigests` with the documents, as [its README](./registry/seed/README.md#cutting-it-down) does |

Any other answer is in [When something goes wrong](#when-something-goes-wrong).

### 4. Let the registry check the draft

```sh
curl -s -X POST "$API/registry/v1/admin/versions/$V/validate" \
  -H "Authorization: Bearer $TOKEN" | jq '.error // {status: .version.status}'
```

Postman:

```http
POST {{API}}/registry/v1/admin/versions/{{V}}/validate
Authorization: Bearer {{TOKEN}}
```

No body: the check decides nothing, so it takes no reason. In the answer,
look at `version.status`.

**Why.** The registry checks that the draft holds together: exactly one
market opens by default, every market that is offered has what it needs to
price its assets and rewards, no two markets could be confused on the
website. A draft that passes is **frozen**: nothing can change it any more.

**You should see** `"status": "validated"`.

**If not.** `"invalid"` means a check failed. Collect the reasons and pass
them to a developer:

```sh
curl -s "$API/registry/v1/admin/versions/$V" -H "Authorization: Bearer $TOKEN" | jq .validation
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions/{{V}}
Authorization: Bearer {{TOKEN}}
```

The reasons are under `validation` in the answer.

A frozen draft cannot be fixed. Once the cause is fixed, start a new attempt
(step 1 with `{"forceNewAttempt": true, "holdForReview": true, "reason": "..."}`).
It keeps everything already reviewed, the seed's decisions with it, so the
seed is not sent to it again — step 3 would answer `409` — and only what was
wrong is changed, with the overlay routes as in step 5 of
[Describing a new market](#describing-a-new-market). An attempt that imports
a newer commit, because the source has moved on since, keeps nothing: send it
the seed as steps 2 and 3 say.

### 5. Have it approved

This step is another admin's, not yours: someone with an `admin` token of
their own, under another name, who reads what the version would change and
approves it. They run it with their own token in `TOKEN`:

```sh
curl -s "$API/registry/v1/admin/versions/$V/changes" -H "Authorization: Bearer $TOKEN" \
  | jq '{comparedWith, added: [.markets.added[].scope], networks: .networks.added}'
curl -s -X POST "$API/registry/v1/admin/versions/$V/approve" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"read the first registry version", "expectedActiveVersionId":null}' | jq '.error // .approval'
```

Postman, with the approver's token as `TOKEN`:

```http
POST {{API}}/registry/v1/admin/versions/{{V}}/approve
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{"reason": "read the first registry version", "expectedActiveVersionId": null}
```

`expectedActiveVersionId` is the version the approver read the changes
against, which every approval names: `null` here, because nothing is on yet,
and later the version that is on — `comparedWith` in the answer of
`…/versions/$V/changes`. In the answer, look at `usable` and `expiresAt`.

**Why.** A version is switched on by two people: one who approves it, and
another who switches it on. The approval covers exactly this version, which
can no longer change, against what is on now, and lets one switch through.
It is announced in the team's channel
([Announcing changes](#announcing-changes)). It cannot be taken back: one
given by mistake, or with a token that may have leaked, stays usable by any
other admin until it expires, is used, or another version goes on. Say so in
the channel, where it was announced.

**You should see** `"usable": true`, and an `expiresAt` a day ahead
(`COMET_REGISTRY_APPROVAL_TTL_S`): step 6 has until then. Once it has
expired unused, step 5 is done again.

**If not.** `400`, "expectedActiveVersionId is required": the body does not
say what the changes were read against; send it as above. `409`, "only a
validated version can be approved": step 4 first. `409`, "… as this approval
expected": a version is on that was not when you looked; read the changes
again against it and approve with its id.

### 6. Switch it on

Back to you, with your own token in `TOKEN` — not the approver's:

```sh
curl -s -X POST "$API/registry/v1/admin/versions/$V/activate" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"first registry version", "expectedActiveVersionId":null}' | jq
```

Postman:

```http
POST {{API}}/registry/v1/admin/versions/{{V}}/activate
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{"reason": "first registry version", "expectedActiveVersionId": null}
```

`expectedActiveVersionId` is the version you decided against: `null` here,
because nothing is on yet. Every later switch that comes back to this step
names the version that is on instead — `comparedWith` in the answer of
`…/versions/$V/changes`, or `activeVersionId` in
`GET /registry/v1/admin/versions`. If somebody switches another version on
while you are deciding, your switch is refused with `409` instead of quietly
undoing theirs.

**Why.** The API moves to the new list in one step. This is the only step
users notice. It is recorded with your reason and the approval it used,
announced in the team's channel ([Announcing changes](#announcing-changes)),
and can be undone — see [Switching back](#switching-back).

**You should see** `"changed": true` and an `approvalId`.

**If not.** `409` with `details.code` `APPROVAL_REQUIRED`: there is no
approval you may use. The message says against which version one is needed.
Step 5 was not done, was done with your own token or another of your name,
has expired, was used, or was given while another version was on: have it
done again.

A collateral a later version adds can be hidden from token discovery only
once that version is on: right after this step, hide what must not be shown
([Hiding a collateral](#hiding-a-collateral)). Until then discovery decides
it in its market as any other collateral there.

### 7. Check that it is on

```sh
curl -s "$API/registry/v1/active" | jq '[.networks[].markets | length] | add'
curl -si "$API/market/ethereum-mainnet/0xc3d688B66703497DAA19211EEdff47f25384cdc3/summary" | grep -i x-registry-version
curl -s -o /dev/null -w '%{http_code}\n' "$API/market/all-networks/all-contracts/summary"
curl -s -o /dev/null -w '%{http_code}\n' "$API/market/all-networks/all-contracts/historical/summary"
curl -s "$API/market/all-networks/all-contracts/summary" | jq -c '.[] | select(.status == "error")'
```

Postman:

```http
GET {{API}}/registry/v1/active

GET {{API}}/market/ethereum-mainnet/0xc3d688B66703497DAA19211EEdff47f25384cdc3/summary

GET {{API}}/market/all-networks/all-contracts/summary

GET {{API}}/market/all-networks/all-contracts/historical/summary
```

None needs the token. In the first answer, count the markets under
`networks[].markets`; in the second, the `X-Registry-Version` response header
is on the **Headers** tab. The next two read every market the version
serves, on every network: its summary at the latest block, and its past
days. The last lists the markets the summary answers as `error`; in Postman,
search the third answer for `"status": "error"`.

**You should see** the number of markets you reviewed, a
`X-Registry-Version` header equal to `$V`, `200` from both routes over every
network, and no market in `error`.

**If not.** A market in `error` with the message `creationBlock … is past
the latest block, …` holds a creation block its chain has not reached. None
of its values can be read, so the market routes and
`/account/{address}/rewards` answer it as `error`, and the other markets as
usual. Switch back to the version before
([Switching back](#switching-back)). Where there is none, or it answers the
market so too, hold a draft as in step 1 of
[Describing a new market](#describing-a-new-market), read the market's own
overlay with `GET …/markets/<chainId>/<deploymentKey>/overlay`, and send it
back as in its step 5 with the block its Comet was deployed in as
`creationBlock`, and the `digest` the read answered as `"expectedDigest"`:
the write holds the block against the chain. A market in `error` with
another message reads a price feed that reverts
([A market that stopped answering](#a-market-that-stopped-answering)).

Any other market those routes cannot read fails them for every market, with
an answer other than `200`. The worker's log line `route failed` with the
answer's `requestId` has the error, and the same two routes of each market —
`/market/<network>/<comet>/summary` and `…/historical/summary` — say which
market it is. Show both to a developer, and switch back to the version before
([Switching back](#switching-back)). On a first bring-up there is none: the
market at fault is switched off in a new attempt instead (step 1 of
[Describing a new market](#describing-a-new-market)).

One error is no market's: `Too many subrequests` in that log line says the
request ran out of the subrequests an invocation has
([README.md](./README.md#workers-plan)). Switch nothing off or back for it;
show it to a developer.

### 8. Mark the initial deprecated collaterals

```sh
curl -s -X POST "$API/registry/v1/admin/deprecated-collaterals/review" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @c3-api/registry/seed/production.deprecated-collaterals.json > review.json
jq 'if .error then .error else .summary, (.collaterals[] | select(.problem != null)) end' review.json
```

Postman:

```http
POST {{API}}/registry/v1/admin/deprecated-collaterals/review
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

<the file c3-api/registry/seed/production.deprecated-collaterals.json>
```

Send the file as it is: **Body → binary**, and select it. Set the
`Content-Type: application/json` header yourself.

**Why.** Until the registry served them, the app left 20 collaterals of five
Ethereum markets out by a list of its own. The file is that list, in the
form the review and apply routes take
([The initial list of deprecated collaterals](#the-initial-list-of-deprecated-collaterals)).
A collateral can be marked only while a version that holds it is on, so the
list goes in once step 6 has switched one on, and until it is applied, the
reads mark none of the 20 deprecated. The review writes nothing: it holds
every row against the version that is on, and says what applying the list
would change. Applying it is yours alone: unlike step 6, a decision about a
collateral takes effect as soon as it is made, needs nobody's approval, and
is not announced.

**You should see** `"change": 20`, `"unchanged": 0` and `"problems": 0`, and
nothing after them. Then apply what it changes, right after the review,
with the command of step 3 of
[A reviewed list of deprecated collaterals](#a-reviewed-list-of-deprecated-collaterals):
it reads this `review.json`, and answers `"changed": 20`. In Postman, when
the review shows `"change": 20`, every row of the file changes, so send the
file to `…/deprecated-collaterals/apply` as it went to the review; otherwise
write the body as that step says.

In an environment where the list was applied before, the review shows
`"change": 0` and `"unchanged": 20`: there is nothing to apply, and the
command of step 3 says so and sends nothing. Where only part of it was, the
review counts that part as `unchanged`, and apply writes the rest.

**If not.** A row printed after the summary has a `problem`: the version
that is on does not hold that collateral of that Comet, or names its market
or its token otherwise than the row does. Do not apply the file, and do not
edit it to get past the problem; the command of step 3 sends nothing while
the review has one. Tell a developer which row it is: the app's list was
written against what these markets took, so a market that no longer takes
one of them is the frontend's question, and the file changes by a pull
request ([its README](./registry/seed/README.md#the-deprecated-collaterals)).
`503` `REGISTRY_NOT_ACTIVE` means nothing is on yet: step 6 first. Any other
`error` in place of the summary is in
[When something goes wrong](#when-something-goes-wrong).

## When the source changes

Nothing needs doing to pick up a new commit. The scheduled job looks for one
once a day, imports it over the following hours, takes every decision from
the version that is on, and checks the result. Switching it on is always a
person's decision.

### 1. Find the new version

Once a version is on, the scheduled job validates what it imports, so a new
commit ends as a version that is `validated` and waiting to be switched on,
or `invalid`, with the checks it failed. The status names the one waiting:

```sh
curl -s "$API/registry/v1/admin/status" -H "Authorization: Bearer $TOKEN" | jq '.candidates.validated, .alerts'
export V=<the first versionId listed>
```

`candidates.validated` lists, newest first, the validated versions newer than
any ever switched on, and `alerts` has `candidate-awaiting-activation` while
it is not empty, and `candidate-awaiting-approval` while the first has no
approval anybody could switch it on with; its `approval` names one once it
is given. Take the first; never take a version listed below the one that is
on, which would switch the registry back to an older commit.

When the list is empty, nothing is waiting: the newest version
(`GET /registry/v1/admin/versions?limit=1`) is either still `importing` — the
import has not finished; wait for it, or continue it with `{}` below — or
`invalid`, and `GET /registry/v1/admin/versions/<id>` says which checks it
failed. An `invalid` version that imported every root raises
`commit-rejected`: the scheduled job does not import that commit again by
itself, because it would fail the same way.

Every version there is, newest first, with the one that is on named:

```sh
curl -s "$API/registry/v1/admin/versions" -H "Authorization: Bearer $TOKEN" | jq
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions
Authorization: Bearer {{TOKEN}}
```

`?status=importing` narrows it to the drafts held for review — an import
started with `holdForReview`, or the first one of an environment. A held
draft is reviewed in place and validated before it can be switched on (step 4
of the first bring-up); switching on a draft that is still importing answers
`409`.

Send the import request. While an import runs, and once the newest commit is
imported, the answer names the draft in `registryVersionId` — set `V` from it
only when the answer is `completed` with `imported`:

```sh
curl -s -X POST "$API/registry/v1/admin/sync" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | jq '.error // {status, outcome, registryVersionId, reason}'
export V=<registryVersionId>
```

Postman:

```http
POST {{API}}/registry/v1/admin/sync
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{}
```

Look at `status`, `outcome`, `registryVersionId` and `reason`. For a
particular commit, the body is `{"sourceCommitSha": "<commit>", "reason": "..."}`.

An answer of `upstream was checked recently` names no draft. To ask about a
particular commit instead, send `{"sourceCommitSha": "<commit>", "reason": "..."}`:
it answers with that commit's draft, importing it first if there is none.

### 2. See what switching it on would change

```sh
curl -s "$API/registry/v1/admin/versions/$V/changes" -H "Authorization: Bearer $TOKEN" \
  | jq '{status, comparedWith, added: [.markets.added[] | {scope, reviewed}], removed: .markets.removed,
         unserved: .markets.unserved,
         changed: [.markets.changed[] | "\(.scope) \(.field): \(.before) -> \(.after)"], networks}'
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions/{{V}}/changes
Authorization: Bearer {{TOKEN}}
```

Look at `markets.added` (each with `scope` and `reviewed`), `markets.removed`,
`markets.unserved` (each with `scope`, `comet` and `now`) and `markets.changed`
— each change names its `scope`, `field`, `before` and `after`. `networks` has
`added`, `removed` and `changed` for networks.

**Why.** This compares the draft with the version that is on, so it shows
everything the new commit changes.

**You should see** the markets the commit adds and drops, the ones users would
lose, and every field that differs on the others.

- A market under `added` with `"reviewed": false` is one the source has added.
  It is switched off, and the draft can be switched on without it; to offer it,
  see [Describing a new market](#describing-a-new-market).
- `removed` lists the keys the draft no longer has, and `unserved` the markets
  users lose once it is on: each Comet the version on serves that the draft
  serves under no key, by the key it is served under now. Its `now` says where
  the draft holds it: nowhere (`null`) for a deployment the source dropped; the
  new key, switched off, for one it renamed, which nobody has reviewed under
  that key yet; and its own key, switched off, for one a review switched off.
  A key the source gave another Comet shows the old Comet here, and the key's
  new Comet under `changed` as `contracts.comet`: that one comes in as a market
  nobody has reviewed, switched off, with none of the old one's decisions.
  While a validated version would drop any, the status raises
  `candidate-drops-markets`.
- The registry follows the source. A deployment the source drops stops being
  served once a version without it is on, and nothing keeps it served —
  `deprecated` is for a market the version still holds. Nothing holds such a
  draft back either: switching it on is the decision, so confirm every market
  under `unserved` with a developer first. One the source renamed is served
  again once it is described under its new key
  ([Describing a new market](#describing-a-new-market)), starting from the
  overlay its old key has in the version that is on:
  `…/versions/<comparedWith>/markets/<chainId>/<old key>/overlay`.
- A changed feed, contract, token or collateral on a market that stays is the
  commit changing that market. If nobody expected it, show it to a developer
  before switching on.

### 3. Switch it on

Steps 5, 6 and 7 above for the version — validated first, if it was a held
draft — with `"expectedActiveVersionId"` in the bodies of steps 5 and 6
naming the version that is on: `comparedWith` in the answer of step 2, which
the approver reads before approving.

## Describing a new market

A market the source adds arrives switched off and unreviewed, and nothing
serves it until someone describes it. Describing it is writing down the
decisions about it, in one document.

### 1. Hold a draft that includes it

The scheduled job's draft of a commit is checked and frozen as soon as it is
imported, so describing a market needs a new attempt of that commit, held open:

```sh
curl -s -X POST "$API/registry/v1/admin/sync" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"forceNewAttempt": true, "holdForReview": true, "reason": "describe <chainId>/<deploymentKey>"}' | jq
export V=<registryVersionId>
```

Postman:

```http
POST {{API}}/registry/v1/admin/sync
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{"forceNewAttempt": true, "holdForReview": true, "reason": "describe <chainId>/<deploymentKey>"}
```

Copy `registryVersionId` into `V`, or keep the post-response script from the
first bring-up on this request too. Send `{}` until the answer says
`"status": "completed"`, as in step 1 of
[the first bring-up](#1-import--take-a-snapshot-of-the-source).

**You should see** `"heldForReview": true`, with `"completed"` equal to
`"expected"`. A lower `"completed"` is an import that gave markets up — its
`"reason"` says how many — and its draft cannot validate: read why in
`GET /registry/v1/admin/sync-runs/<syncRunId>`, fix the cause, and hold
another attempt.

The new attempt keeps every decision already made, so only the new market
is left unreviewed — and its network, when it is on a chain no version
described before (step 5).

### 2. See what the import read about it

```sh
curl -s "$API/registry/v1/admin/versions/$V/changes" -H "Authorization: Bearer $TOKEN" \
  | jq '.markets.added[] | select(.reviewed | not)'
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions/{{V}}/changes
Authorization: Bearer {{TOKEN}}
```

The new market is the entry of `markets.added` with `"reviewed": false`; its
facts are under `market`.

This is everything the source and the chain say about the market: its Comet
and other contracts, its base token and that token's price feed, its reward
token if it has rewards, and its collateral. The decisions come next.

### 3. Start from a similar market

A market of the same network with the same kind of base asset usually shares
most decisions — the reward feed, the quote unit, the USD feed. Read its
document:

```sh
curl -s "$API/registry/v1/admin/versions/$V/markets/<chainId>/<similar deploymentKey>/overlay" \
  -H "Authorization: Bearer $TOKEN" | jq .overlay
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions/{{V}}/markets/<chainId>/<similar deploymentKey>/overlay
Authorization: Bearer {{TOKEN}}
```

Copy the `overlay` object from the answer: it is what step 5 sends, once the
fields below are decided. Its `creationBlock` is the other market's, which is
never this one's: replace it as step 4 says, or the write is refused.

### 4. Decide every field

| Field | What it is | Where the answer comes from |
|---|---|---|
| `displayName` | The market's label on the website: `USDC`, `ETH` for a WETH market, `USDC.e` | Agree it with the frontend's maintainers: the website builds its market key from it |
| `baseAsset.displayName` | The base asset's name on the website: `USD Coin`, `Ether`, `Tether` | The same |
| `slug` | The market's key in the website's links | `null`, unless another market of the network that is not switched off has the same label; then a unique lowercase key such as `usdc-institutional` |
| `isInstitutional` | Listed in the website's institutional section | Usually `false` |
| `contractName` | The Comet's name, shown in governance action titles | The Comet contract's `symbol()`, for example `cUSDTv3` |
| `status` | Whether the market is served | `enabled`; `disabled` keeps it off |
| `isDefault` | The market the website opens first | `false` — exactly one market in the whole registry is the default |
| `creationBlock` | Where the market's history and indexes start | The block the Comet proxy was deployed in (the explorer's "Contract Creation"). Must be above `0` for a market that is served. The write holds it against the chain — the Comet has code at that block and none at the block before it — and refuses one the chain contradicts with `422` `OVERLAY_CREATION_BLOCK_WRONG`, saying whether it is before the deployment, after it, or past the latest block. Markets whose history is served and that share a rewards contract are read together, from the earliest of their blocks: a version that moves it ends the history cursors clients hold, and each starts over once (`409`) |
| `collateralValueQuote` | The unit the market's own price feeds answer in | Call `description()` on the base token's price feed from step 2. `X / USD` → `usd`. `Constant price feed` (WETH, wstETH) or `WBTC / BTC` → `base` |
| `baseAsset.usdPriceFeedAddress` | The feed that turns the unit the market's feeds answer in into USD: the market summaries report it as `base_usd_price` | `null` when the quote is `usd`. When it is `base`, the USD feed of that unit on that chain: ETH / USD for a WETH market, BTC / USD for the WBTC market, whose feeds answer in BTC |
| `baseAsset.isWrappedNative` | The base token wraps the chain's own token | `true` for WETH on Ethereum and its L2s, WPOL, WMNT, WRON |
| `capabilities.rewards`, `capabilities.accountRewards`, `rewardPriceFeed` | Rewards | If step 2 shows no rewards contract or no reward token, the market has no rewards: both `false`, `rewardPriceFeed` `null`. Otherwise a COMP price feed of that chain, quoted in the unit its `description()` names: `COMP / USD` gives `"quote": "usd"`; `COMP / ETH` — the reward feed of mainnet's and Linea's WETH markets — gives `"quote": "base"`, which needs `collateralValueQuote` `base` and a `usdPriceFeedAddress`. Never pair a COMP / ETH address with `usd`: validation does not catch it, and the rewards routes would serve COMP priced in ETH as if in USD |
| `capabilities.transactionHistory` | Whether the market appears in users' transaction history | `true` if it should. The market needs a rewards contract, and a right `creationBlock` |

The document is complete or it is refused: a missing field is a decision
nobody made, not a default. The checks in step 4 of the first bring-up refuse
the combinations that cannot work — a `base` quote without a USD feed,
rewards without a feed or a rewards contract, a shared label without a slug,
a served market without a creation block — and a reward feed on a market
with no reward token, or a creation block the chain contradicts, is refused
as soon as it is sent.

### 5. Send it, then check and switch on

```sh
curl -s -X PUT "$API/registry/v1/admin/versions/$V/markets/<chainId>/<deploymentKey>/overlay" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason": "describe <chainId>/<deploymentKey>", "overlay": { ... }}' | jq
```

Postman:

```http
PUT {{API}}/registry/v1/admin/versions/{{V}}/markets/<chainId>/<deploymentKey>/overlay
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{
  "reason": "describe <chainId>/<deploymentKey>",
  "overlay": {
    "displayName": "USDC",
    "slug": null,
    "contractName": "cUSDCv3",
    "isDefault": false,
    "isInstitutional": false,
    "status": "enabled",
    "creationBlock": 11699480,
    "collateralValueQuote": "usd",
    "capabilities": { "rewards": true, "accountRewards": true, "transactionHistory": true },
    "baseAsset": { "displayName": "USD Coin", "isWrappedNative": false, "usdPriceFeedAddress": null },
    "rewardPriceFeed": { "address": "0x9dda783de64a9d1a60c49ca761ebe528c35ba428", "quote": "usd" }
  }
}
```

The overlay above is Base USDC's, as step 3 reads it; replace it with the
new market's decided fields.

A market on a chain no version described before needs its network described
too: until then the network carries its canonical name and nothing else, and
validation refuses a network nobody reviewed that serves a market
(`served-network-reviewed`). Its document is its name, how the website
presents its assets, and its price exceptions — for a new chain, usually
none. `"expectedDigest": null` says it is decided against a network nobody
has reviewed, so a description somebody else sent first is not overwritten:

```sh
curl -s -X PUT "$API/registry/v1/admin/versions/$V/networks/<chainId>/overlay" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason": "describe <chainId>", "overlay": {"displayName": "<the name the website shows>",
       "assetDisplayOverrides": [], "unwrappedCollateralAssets": [], "priceExceptions": []},
       "expectedDigest": null}' | jq
```

Then steps 4 to 7 of the first bring-up, and step 2 above for what the
draft changes. The new market is under `added`, now with `"reviewed": true`.

## A market that stopped answering

A market whose price feed reverts is reported with `"status": "partially"`
(a collateral's feed) or `"status": "error"` (its base or reward feed) until
a version says how to price what broke — see
[Market status](./API.md#market-status). Almost always it is a feed Chainlink
retired: the Comet reads it through `getPrice`, which reverts with it.

### 1. Find the feed

A feed that reverts is logged as a warning (`npx wrangler tail --env
production`, or the worker's logs in the Cloudflare dashboard), naming the
feed and a Comet that read it — once a minute per worker instance for as
long as it keeps reverting, however many markets and blocks read it:

```
price feed reverted: 0xe3a409ed15cd53afdefdd191ad945cec528a2496 read by 0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840 on ethereum-mainnet at block 23400000: execution reverted
```

The market's `collateralAssets` in
`GET /registry/v1/networks/<chainId>/markets/<comet>` say which asset reads
it. A feed none of them names can be the replacement of a remap among the
network's `priceExceptions` in `GET /registry/v1/active`: then neither it nor
the feed it replaces answered at that block. A replacement that reverts
while the feed it replaces answers — at a block before it was deployed — is
not logged.

The market's base feed, its `baseAsset.priceFeed` there, is logged only when
the feed its Comet names at that block did not answer either, by `/summary`
as by a history. So a base feed the Comet has moved off, which Chainlink
retired while the version still names it, is not logged: the API prices the
base asset through the Comet's feed meanwhile, and the daily chain check
raises the difference
([A market that changed on chain](#a-market-that-changed-on-chain)).

A price exception covers collateral feeds only. When the feed is the market's
base feed, the Comet itself cannot price its base asset and only its
governance can replace the feed. A reward feed or a base USD feed is changed
in the market's overlay instead (`rewardPriceFeed`,
`baseAsset.usdPriceFeedAddress`): hold a draft as in step 1 of
[Describing a new market](#describing-a-new-market), read the market's own
overlay with `GET …/markets/<chainId>/<deploymentKey>/overlay`, and send it
back changed as in its step 5, with the `digest` the read answered as
`"expectedDigest"`: if somebody changes the market in between, your write is
refused instead of undoing theirs.

An exception names a feed, not a token, and applies wherever a Comet reads
that feed: at the latest block, and at a past block a history reads. Where a
remap's replacement does not answer yet — at a block before it was deployed —
a history reads the feed the Comet named at that block instead. A feed
governance has since replaced is still priced by its exception on the days
the market read it. That is all the seeded exceptions of wUSDM and pumpBTC do
now: governance delisted both by moving them onto a "Constant price feed"
that answers 10^-8, which the summaries read like any other feed from then
on, with no exception.

### 2. Decide how to price it

| Kind | Use it when | What it needs |
|---|---|---|
| `deprecated_price_remap` | Another feed answers the same pair | `replacementPriceFeedAddress`; the registry reads its decimals on chain. Where the replacement does not answer — a day of history before it was deployed — the feed the Comet named that day is read instead |
| `fixed_price` | The asset keeps a value but no feed answers any more | `price.value`, the feed's last answer as an integer string, and `price.decimals`, the feed's scale |
| `zero_price` | The asset is being wound down and should count for nothing | Nothing more |

The `provenance` of each says what broke and why this price: it is what the
next operator reads.

### 3. Hold a draft and write the exception

Step 1 of [Describing a new market](#describing-a-new-market) holds the
draft. A network overlay is replaced as a whole, so start from the one the
draft holds — it can have exceptions the version on does not, handed down by
an earlier attempt or written by somebody else — and send it back with the
`digest` it was read with. A network lists a feed once, so an exception the
draft already holds for the feed is replaced by the one you write:

```sh
curl -s "$API/registry/v1/admin/versions/$V/networks/1/overlay" -H "Authorization: Bearer $TOKEN" > network.json

jq --arg feed '<the feed from step 1>' '($feed | ascii_downcase) as $feed | {
  reason: "price the feed 1/usdt reads, which reverts",
  overlay: (.overlay | .priceExceptions = [ (.priceExceptions[] | select(.priceFeedAddress != $feed)), {
    "kind": "zero_price",
    "priceFeedAddress": $feed,
    "provenance": "wUSDM / USD (cUSDTv3 collateral) reverts since <date>; <why this price>",
    "expiresAt": null
  } ]),
  expectedDigest: .digest
}' network.json > network.next.json

curl -s -X PUT "$API/registry/v1/admin/versions/$V/networks/1/overlay" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d @network.next.json | jq
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions/{{V}}/networks/1/overlay
Authorization: Bearer {{TOKEN}}

PUT {{API}}/registry/v1/admin/versions/{{V}}/networks/1/overlay
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{
  "reason": "price the feed 1/usdt reads, which reverts",
  "overlay": <the overlay the GET answered, with the exception in its priceExceptions in place of any it has for that feed>,
  "expectedDigest": "<the digest the GET answered>"
}
```

**You should see** `"changed": true`. A `409` that the overlay "is no longer
the one this was decided against" is a change somebody made to the network
since you read it: read it again, and add the exception to that.

An exception that should stop applying on its own takes an `expiresAt` such
as `"2027-01-01T00:00:00Z"`: a date, a time and its offset, still to come.
A date alone, or a time without its offset, is refused, because it names a
different moment depending on where it is read. An exception in `network.json`
that has expired since it was written is kept as it is when you send it back:
only an expiry you write or change has to be still to come.

### 4. Check and switch on

Steps 4 to 7 of the first bring-up. The market reports `success` from
the first request after the switch: the exception changes what its summaries
are cached under. So do the days of its history, a remapped collateral's
included: a day before its replacement was deployed is read from the feed
the Comet named that day, and only a day neither answers stays `partially`.

`GET /registry/v1/admin/status` does not report a market whose feed reverts:
alert on the `price feed reverted:` log line instead, as well as on the
status's `chain-drift`. A base feed of the version that reverts while the
feed its Comet names answers is not logged, since the API reads the
Comet's: the daily chain check, as `chain-drift`, is what reports it.

## A market that changed on chain

An import reads each market's base feed, collateral assets and their price
feeds from its Comet once, and the version serves them from then on.
Governance can change them on chain — most often a collateral's price feed —
without the source moving, and then the version on describes a market the
chain no longer has. Once a day, at its first invocation of the day (UTC),
the hourly job reads those facts again — whatever the import finds, and even
when an administrative sync checked the source first — and the status raises
`chain-drift` for what the chain now answers otherwise. Nothing is imported
or switched on by itself: that is yours to do.

### 1. Read what changed

```sh
curl -s "$API/registry/v1/admin/status" -H "Authorization: Bearer $TOKEN" | jq '.chainCheck'
```

Each entry of `drifts` names the network, the market (`chainId/deploymentKey`)
and its Comet, the asset — the base asset, or a collateral by its index, with
its token and symbol — the `field` that moved, what the version stores
(`stored`), what the chain answers now (`current`), and when the chain last
answered it so (`seenAt`). `field` is `priceFeed` for a feed, and `token` for
a collateral the Comet has added, removed or replaced at that index. The
market's page on the chain's explorer shows the same: `getAssetInfo(<index>)`
on the Comet answers the asset and its feed. A network listed under
`unreadable` keeps the drifts the last read of it found, with that read's
`seenAt`, until it can be read again.

The market's history was right all along about its collateral: it prices
each with the feed its Comet reads, and names it by the token's `symbol()`.
Its summary at the latest block prices collateral the same way, but lists
and names it as the version does: a collateral the Comet added is left out
until a version describes it, and one the Comet replaced at an index is
reported as one that could not be read (`partially`). A collateral the Comet
added is read in a user's transaction history at the decimals the token
reports, with no symbol. Both read the base asset through the base feed the
version stores first, so a base feed governance replaced is still read
first — once Chainlink retires it, the summaries, their history and the
rewards routes, `/account/{address}/rewards` among them, price the base
asset through the feed the Comet names instead, and answer `error` only
where that one reverts too. Until the market is imported again, the rewards
still name the version's feed as the market's (`base_asset.priceFeed` of
`/rewards/dapp-data`), even where they read the Comet's. And
`/registry/v1/*` serves the old facts, which a client that prices from the
registry's feeds would use.

The check does not read reward tokens: a rewards contract cannot start paying
another token, since CometRewards sets a market's token once, and the import
reads it from the contract the version names. A version that describes
another token than its rewards contract pays shows instead in the worker's
log, once a minute per market for as long as it lasts:

```
reward token differs from the registry: 0xc3d688B66703497DAA19211EEdff47f25384cdc3 on ethereum-mainnet pays 0x…, the version describes 0xc00e94cb662c3520282e6f5717214004a7f26888
```

This line should never appear. If it does, the version was not built from
that contract, and `/account/{address}/rewards` answers that market as
`error` until a version describes the token it pays: import the commit again
as below.

### 2. Import the commit again

```sh
curl -s -X POST "$API/registry/v1/admin/sync" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"forceNewAttempt": true, "reason": "read the chain again: 130/weth changed the feed of rsETH"}' | jq
export V=<registryVersionId from the answer>
```

Postman:

```http
POST {{API}}/registry/v1/admin/sync
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{"forceNewAttempt": true, "reason": "read the chain again: 130/weth changed the feed of rsETH"}
```

Send `{}` until the answer says `"status": "completed"`, as in step 1 of
[the first bring-up](#1-import--take-a-snapshot-of-the-source).

**Why.** A new attempt at the same commit reads every market from the chain
again and takes its decisions from the version that is on, with what was
reviewed over them in drafts of this commit that were never switched on — a
market renamed or described in a held draft that was then left. The source
has not moved, so everything else that differs is what the chain answers now.

**You should see** `"outcome": "imported"` and `"heldForReview": false`: the
version validated by itself. A draft that fails a check is answered
`422 UNPROCESSABLE` "validation failed" instead, with `syncRunId` and
`registryVersionId` in `details`: the checks it failed are under `validation`
in `GET /registry/v1/admin/versions/<registryVersionId>`, as in step 4 of
[the first bring-up](#bringing-an-environment-up-for-the-first-time). Any
other error is in [When something goes wrong](#when-something-goes-wrong).

### 3. See what it changes, and switch it on

Step 2 of [When the source changes](#2-see-what-switching-it-on-would-change)
shows the drift as a change of the market under `markets.changed` — such as
`collateralAssets[5].priceFeed.address` from what the version stores to what
the chain answers, or `collateralAssets.length` for a collateral added or
removed. A field of an overlay document is a decision, which no chain
changes: under `markets.changed`, a field that starts with `displayName`,
`slug`, `contractName`, `isDefault`, `isInstitutional`, `status`,
`creationBlock`, `collateralValueQuote`, `capabilities`,
`baseAsset.displayName`, `baseAsset.isWrappedNative`,
`baseAsset.usdPriceFeed`, `rewardAsset.priceFeed` or
`rewardAsset.priceFeedQuote`; under `networks.changed`, one that starts with
`displayName`, `presentation` or `priceExceptions`. A decision it lists was
reviewed in a draft of this commit that was never switched on (step 2), and
switching this attempt on switches it on too. Anything else it lists changed
on chain too; if nobody expected it, show it to a developer first.

A decision nobody meant is not undone by leaving this attempt off: every
later attempt of the commit takes it again, until a newer attempt reviews
that market or network otherwise. So hold one (step 1 of
[Describing a new market](#describing-a-new-market)), and for each market or
network such a decision is in, read what the version that is on holds —
`GET …/versions/<comparedWith>/markets/<chainId>/<deploymentKey>/overlay`, or
`GET …/versions/<comparedWith>/networks/<chainId>/overlay` — write into its
`overlay` those of the draft's decisions somebody did mean, and send it to
the draft as step 5 there does, with the `digest` the same `GET` answers for
the draft as `"expectedDigest"`. Validate the draft (step 4 of the first
bring-up): it is the version to switch on, not this attempt.

Switch the version on as step 3 of
[When the source changes](#3-switch-it-on) says. The next
hourly invocation reads the chain for the version on, within the hour. Until
it has, `chainCheck` is still the check of the version before it — its
`versionId` says which — and the alert stays; it clears once that check
finds the version agrees with the chain. Switching back to a version that
stores what drifted keeps it raised.

A version that changes a market's base feed prices the market's whole
history through the new feed, whatever its quote, and a day sampled before
that feed existed through the feed the Comet named that day. Such a day
answers `error` only where neither feed answered.

## Switching back

```sh
curl -s -X POST "$API/registry/v1/admin/versions/<previous version id>/rollback" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"why", "expectedActiveVersionId":"<the version that is on>"}' | jq
```

Postman:

```http
POST {{API}}/registry/v1/admin/versions/<previous version id>/rollback
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{"reason": "why", "expectedActiveVersionId": "<the version that is on>"}
```

The body names the version you are undoing as `expectedActiveVersionId`. If
somebody has switched another version on since you looked, the rollback is
refused with `409` naming it, rather than undoing their switch: read the
status again and decide again. A rollback is announced in the team's channel
as one, with the version it went back to and the one it left.

A rollback needs nobody's approval: undoing a bad version takes one person,
with any `admin` token. It goes back one step: to the version the one on
replaced when it was last activated, if that is older. To go further back,
roll back again from the version you restored; each step is announced on its
own. Anything else is refused with `409` and `details.code`
`ROLLBACK_TARGET_INVALID`, whose message names the version a rollback may
restore now, or says that none may: a version two steps back, one never on,
or one newer than the one on is switched on as steps 5 to 7 of the first
bring-up do, with another admin's approval.

Every import after this starts from the version you went back to, a new
attempt of the commit you switched off included: what was reviewed for the
version you left, or for the drafts of its commit before it, is not handed
down again. A market only the version you left described comes back
unreviewed and switched off; describe it again if it is still wanted.

A version imported while the version you left was on, of any commit, is
another matter: it was imported with that version's decisions, so switching
it on brings them back. What was reviewed in one of them is also handed down
to the later attempts of its commit, each market or network as the whole
document it holds — with what the version you left decided for it. Before
switching such a version on, or a later attempt of its commit, read what it
changes against the version you went back to
(`GET …/versions/<its id>/changes`), and undo a decision nobody meant as
step 3 of [A market that changed on chain](#3-see-what-it-changes-and-switch-it-on)
says.

The id is the version to go **back to**: the one the version on replaced
when it was last activated. It is the `previousVersionId` in the answer of
the activation you are undoing. The history of the version that is on has it
too, under the newest `activate` onto it:

```sh
export ON=<the version that is on>
curl -s "$API/registry/v1/admin/versions/$ON" -H "Authorization: Bearer $TOKEN" \
  | jq -r '.version.id as $on | first(.activations[] | select(.targetVersionId == $on and .action == "activate")) | .previousVersionId'
```

If it prints `null`, or nothing, a rollback has nothing to go back to: stop
there. Otherwise check that the version it printed is older than the version
on, which prints `true`; an id that names no version stops the check with
`not a version`:

```sh
export BACK=<the id it printed>
for id in "$BACK" "$ON"; do curl -s "$API/registry/v1/admin/versions/$id" -H "Authorization: Bearer $TOKEN"; done \
  | jq -s 'map(.version // error("not a version") | [ .createdAt, .attempt, .id ]) | .[0] < .[1]'
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions/<the version that is on>
Authorization: Bearer {{TOKEN}}
```

`activations` lists the moves that switched the version on or off, newest
first. The first `activate` whose `targetVersionId` is the version that is on
is the activation that last switched it on, and its `previousVersionId` is
the version to go back to. Not a `rollback` onto it: that one names the
newer version it was rolled back from. `null` there — nothing was on before
it — or no such `activate` means a rollback has nothing to go back to. To
check the version to go back to, open it as well: it is older when its
`version.createdAt` is earlier, or the same with a lower `version.attempt` —
the order `GET /registry/v1/admin/versions` lists them in, newest first. One
that is newer — `false` above — means the version on was switched on in
place of a newer one: a rollback restores nothing from it, and only an
activation, approved by another admin, switches another version on. To go
further back, roll back again from the version you restored: the newest
`activate` onto it names the step before.

## Marking a token strategic

A strategic token is meant to be shown in every market that takes it as
collateral, whatever that market holds of it, unless that market's Comet
hides it ([Hiding a collateral](#hiding-a-collateral)) or has it deprecated
([Marking a collateral deprecated](#marking-a-collateral-deprecated)).

The mark belongs to the token itself — its chain and its address — so it
stays when a newer version is switched on, and comes back if a version drops
the token and a later one brings it back. You can only mark a token the
version that is on holds, and every change needs a reason, which is kept with
who made it: the name of the token it was made with, which has the role
`admin`. A change takes effect as soon as it is made: unlike switching a
version on, it needs nobody's approval, and it is not announced. The same
holds for deprecating and hiding a collateral.

```sh
curl -s -X PATCH "$API/registry/v1/admin/networks/1/tokens/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2/policy" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"isStrategic": true, "reason": "Approved by governance"}' | jq
```

Postman:

```http
PATCH {{API}}/registry/v1/admin/networks/1/tokens/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2/policy
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{"isStrategic": true, "reason": "Approved by governance"}
```

**You should see** `"changed": true` and the time in `updatedAt`. Sending the
same request again answers `"changed": false` and records nothing, so it is
safe to repeat. To take the mark away, send `"isStrategic": false` with a
reason.

To see every token of a chain with its mark, and one token's history (newest
change first):

```sh
curl -s "$API/registry/v1/admin/networks/1/tokens" -H "Authorization: Bearer $TOKEN" \
  | jq '.tokens[] | select(.isStrategic) | {symbol, address, updatedAt, updatedBy}'
curl -s "$API/registry/v1/admin/networks/1/tokens/<address>/policy" -H "Authorization: Bearer $TOKEN" | jq .events
```

Postman:

```http
GET {{API}}/registry/v1/admin/networks/1/tokens
Authorization: Bearer {{TOKEN}}
```

A mark stays when a version that drops its token is switched on: the chain's
list shows it under `retained`, and the token's history still answers, with
`"inActiveVersion": false`. It applies again the moment a version that holds
the token is switched on, so read `retained` before switching such a version
on, and take a mark away while the token is still served if it should not
come back.

### A reviewed list of strategic tokens

A list the product team approved is applied in three requests, and you never
type an address: the first one gives you every token as a file.

**1. Export the tokens.** Every token of every network that is on, with its
mark, in the form the next two requests take:

```sh
curl -s "$API/registry/v1/admin/token-policies" -H "Authorization: Bearer $TOKEN" > token-policies.json
jq 'if .error then .error else (.policies | length) end' token-policies.json   # how many tokens, or why not
```

Postman:

```http
GET {{API}}/registry/v1/admin/token-policies
Authorization: Bearer {{TOKEN}}
```

(**Save Response → Save to a file**.) Edit the file: set `"isStrategic": true`
on the approved tokens (or `false` to take a mark away) and write why in the
`"reason"` at the top. A row may carry its own `"reason"`, which wins. Leave
every other row as it is, or delete it: a row that changes nothing needs no
reason, and a token the list does not name is left as it is. Step 3 applies
only the rows the review shows as changes.

**2. See what it would change** — this writes nothing, and keeps the answer
for step 3:

```sh
curl -s -X POST "$API/registry/v1/admin/token-policies/review" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data @token-policies.json > review.json
jq 'if .error then .error else .summary, (.policies[] | select(.action == "change" or .problem != null)) end' review.json
```

Postman:

```http
POST {{API}}/registry/v1/admin/token-policies/review
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

(Body → raw → JSON, and paste the file)
```

Pasting into **raw → JSON** is what sets `Content-Type: application/json`.
**Body → binary** works too, with that header added by hand; without it the
API answers `400 the request body must be JSON`.

**You should see** `"problems": 0`, and under `change` exactly the tokens the
list decides, each with what it is now (`current`), what the list wants
(`requested`) and the reason it will be recorded with. A row with a `problem` names a chain or a token the version that
is on does not hold, a symbol that is not that token's, or a change without a
reason; fix the file and review it again.

**3. Apply what it changes** — right after the review:

```sh
jq 'if .error then error("the review failed: \(.error.message)")
    elif .summary.problems > 0 then error("the review found problems: fix the file and review it again")
    elif .summary.change == 0 then error("the review shows no change: there is nothing to apply")
    else {reason: null, policies: [.policies[] | select(.action == "change") | {chainId, tokenAddress, symbol, isStrategic: .requested, reason}]}
    end' review.json > reviewed.json \
  && curl -s -X POST "$API/registry/v1/admin/token-policies/apply" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' --data @reviewed.json \
  | jq 'if .error then .error else .summary end'
```

`jq` writes to `reviewed.json` only the rows the review shows under `change`,
each with the `reason` the review showed, which is the one the change is
recorded with, and the `symbol` the version names. If the review answered an
error, found problems or shows no change, `jq` says so, and nothing is sent.

Postman: the same request as step 2, to `…/token-policies/apply`, with
`reviewed.json` as the body. Without `jq`, write the body from the rows the
review shows under `change`: `{"reason": null, "policies": [ … ]}`, each row
with its `chainId`, `tokenAddress`, `symbol`, `requested` as `isStrategic`,
and `reason`.

**You should see** `"changed"` equal to the number of changes the review
showed. Apply compares `reviewed.json` with the decisions in force when it
runs: if the number differs, someone decided one of its tokens after your
review, and the answer's rows show which. It can only be lower: a token
someone gave the list's decision meanwhile is left as it is. Apply does not
touch a token `reviewed.json` does not name, whoever decided it after your
review; only a token of the list that someone changed and changed back since
is written as the review showed. The list is written in one go: if any row
cannot be applied (`422`, naming the rows), or a version is switched on or
one of its tokens decided while it is being written (`409`), nothing is
written. Applying `reviewed.json` again changes nothing.

To use the list in another environment, take the edited file, not
`reviewed.json`, which holds only what changes here, and keep only the rows
the list decides: a list applies only where the version that is on holds
every token it names, and another environment's version may not hold one of
them. Review it there and apply what it changes, as steps 2 and 3 do here.

## Marking a collateral deprecated

A deprecated collateral is a collateral of a market that the app no longer
offers there: it leaves it out of the market's collateral list, of what can
be supplied, and of the markets overview. A user who still holds some keeps
seeing it, so that it can be withdrawn. The decision is about one collateral
of one market — its chain, the market's Comet and the token — so a token can
be deprecated in one market and current in another. Token discovery does not
show a deprecated collateral in its market either. To keep a collateral out
of discovery while its market still offers it, hide it instead
([Hiding a collateral](#hiding-a-collateral)).

Like a strategic mark, the decision stays when a newer version is switched
on, and comes back if a version drops the collateral and a later one brings
it back. You can only decide about a collateral of a market of the version
that is on, and every change needs a reason, which is kept with who made it.

```sh
curl -s -X PATCH "$API/registry/v1/admin/networks/1/markets/0x3afdc9bca9213a35503b077a6072f3d0d5ab0840/collaterals/0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa/deprecated" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"isDeprecated": true, "reason": "Deprecated collateral of the USDT market"}' | jq
```

Postman:

```http
PATCH {{API}}/registry/v1/admin/networks/1/markets/0x3afdc9bca9213a35503b077a6072f3d0d5ab0840/collaterals/0xd5f7838f5c461feff7fe49ea5ebaf7728bb0adfa/deprecated
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{"isDeprecated": true, "reason": "Deprecated collateral of the USDT market"}
```

**You should see** `"changed": true` and the time in `updatedAt`. Sending the
same request again answers `"changed": false` and records nothing, so it is
safe to repeat. To make the collateral current again, send
`"isDeprecated": false` with a reason.

The reads say it in their next answer, which a browser may keep for up to 5
minutes (`REGISTRY_SNAPSHOT_CACHE_TTL_S`):

- `GET /registry/v1/networks/1/markets/<comet>`, the chain's market list and
  `/registry/v1/active` have `"isDeprecated": true` on that collateral of
  that market.

One collateral's decision, with its history, newest change first:

```sh
curl -s "$API/registry/v1/admin/networks/1/markets/<comet>/collaterals/<token>/deprecated" \
  -H "Authorization: Bearer $TOKEN" | jq
```

A decision stays when a version that drops the collateral from its market is
switched on: the export below lists it under `retained`, and its history
still answers, with `"inActiveVersion": false`. It applies again the moment a
version whose market takes the collateral, and is not disabled, is switched
on.

### A reviewed list of deprecated collaterals

A list is applied as a list of strategic tokens is, in three requests, and
you never type an address: the first one gives you every collateral as a
file.

**1. Export the collaterals.** Every collateral of every market of the
version that is on, with its decision, in the form the next two requests
take:

```sh
curl -s "$API/registry/v1/admin/deprecated-collaterals" -H "Authorization: Bearer $TOKEN" > deprecated-collaterals.json
jq 'if .error then .error else (.collaterals | length) end' deprecated-collaterals.json   # how many collaterals, or why not
```

Postman:

```http
GET {{API}}/registry/v1/admin/deprecated-collaterals
Authorization: Bearer {{TOKEN}}
```

(**Save Response → Save to a file**.) Edit the file: set `"isDeprecated": true`
on the collaterals the list decides (or `false` to make one current again) and
write why in the `"reason"` at the top. A row may carry its own `"reason"`,
which wins. Leave every other row as it is, or delete it. A row's
`deploymentKey` and `symbol` are there for you to read, and are checked: a
market or a symbol that is not the one the version that is on names is
refused. `retained` is not read. Step 3 applies only the rows the review
shows as changes.

**2. See what it would change** — this writes nothing, and keeps the answer
for step 3:

```sh
curl -s -X POST "$API/registry/v1/admin/deprecated-collaterals/review" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data @deprecated-collaterals.json > review.json
jq 'if .error then .error else .summary, (.collaterals[] | select(.action == "change" or .problem != null)) end' review.json
```

Postman:

```http
POST {{API}}/registry/v1/admin/deprecated-collaterals/review
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

(Body → raw → JSON, and paste the file)
```

**You should see** `"problems": 0`, and under `change` exactly the
collaterals the list decides, each with what it is now (`current`), what the
list wants (`requested`) and the reason it will be recorded with. A row with
a `problem` names a chain or a Comet the version that is on does not hold, a
token that is not a collateral of that Comet, a market or a symbol that is
not that row's, or a change without a reason; fix the file and review it
again.

**3. Apply what it changes** — right after the review:

```sh
jq 'if .error then error("the review failed: \(.error.message)")
    elif .summary.problems > 0 then error("the review found problems: fix the file and review it again")
    elif .summary.change == 0 then error("the review shows no change: there is nothing to apply")
    else {reason: null, collaterals: [.collaterals[] | select(.action == "change") | {chainId, cometAddress, deploymentKey, tokenAddress, symbol, isDeprecated: .requested, reason}]}
    end' review.json > reviewed.json \
  && curl -s -X POST "$API/registry/v1/admin/deprecated-collaterals/apply" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' --data @reviewed.json \
  | jq 'if .error then .error else .summary end'
```

`jq` writes to `reviewed.json` only the rows the review shows under `change`,
each with the `reason` the review showed, which is the one the change is
recorded with, and the `deploymentKey` and `symbol` the version names. If the
review answered an error, found problems or shows no change, `jq` says so,
and nothing is sent.

Postman: the same request as step 2, to `…/deprecated-collaterals/apply`,
with `reviewed.json` as the body. Without `jq`, write the body from the rows
the review shows under `change`: `{"reason": null, "collaterals": [ … ]}`,
each row with its `chainId`, `cometAddress`, `deploymentKey`, `tokenAddress`,
`symbol`, `requested` as `isDeprecated`, and `reason`.

**You should see** `"changed"` equal to the number of changes the review
showed. Apply compares `reviewed.json` with the decisions in force when it
runs: if the number differs, someone decided one of its collaterals after
your review, and the answer's rows show which. It can only be lower: a
collateral someone gave the list's decision meanwhile is left as it is. Apply
does not touch a collateral `reviewed.json` does not name, whoever decided it
after your review; only a collateral of the list that someone changed and
changed back since is written as the review showed. The list is written in
one go, as a list of strategic tokens is: if any row cannot be applied
(`422`, naming the rows), or a version is switched on or one of its
collaterals decided while it is being written (`409`), nothing is written.
Applying `reviewed.json` again changes nothing.

### The initial list of deprecated collaterals

Until the registry served them, the app left these collaterals out by a list
of its own, which calls them legacy collateral: 20 collaterals of five
Ethereum markets — the list is also how it keeps wUSDM out of the USDT
market, which its row `usdt`/`wUSDM` now decides as `isDeprecated`. The
list is checked in beside the seed, as
[`c3-api/registry/seed/production.deprecated-collaterals.json`](./registry/seed/README.md#the-deprecated-collaterals),
in the form `GET /registry/v1/admin/deprecated-collaterals` exports and the
review and apply routes take: every row with the address of its Comet and
of its token, the market's key and the token's symbol. Step 8 of
[the first bring-up](#8-mark-the-initial-deprecated-collaterals) sends it
once the environment's first version is on. Once it is applied,
`/registry/v1/active` and the market reads mark each listed collateral with
`"isDeprecated": true` in its market.

Where the addresses come from: for the USDT, USDC and WBTC markets, each is
what the registry's own data in the repository holds for that market and
that symbol — the registry's test fixture
(`tests/fixtures/registry/registry-snapshot-v1.json`), imported from the
Comet repository and read on chain — and in it each token is exactly one
collateral of its Comet:

| App's key | Market | Comet | Collaterals |
|---|---|---|---|
| `1:USDT` | `usdt` (cUSDTv3) | `0x3afdc9bca9213a35503b077a6072f3d0d5ab0840` | mETH, weETH, sdeUSD, wUSDM, deUSD, USDe |
| `1:USDC` | `usdc` (cUSDCv3) | `0xc3d688b66703497daa19211eedff47f25384cdc3` | rsETH, USDe, deUSD, sdeUSD |
| `1:WBTC` | `wbtc` (cWBTCv3) | `0xe85dc543813b8c2cfeaac371517b925a166a9293` | LBTC, pumpBTC |

The app's key `1:USDC` also names the institutional USDC market (ciUSDCv3,
`0x207158a267cbd2598bb3d611d8cbdee2709f2f8c`, its root in the source
fixtures). The version that is on lists its collateral as WETH, wstETH,
cbBTC and WBTC (`GET /registry/v1/networks/1/markets`), none of the four, so
the file names the USDC market alone; review shows it, since a token that is
no collateral of a Comet is a problem there.

The app's list also names 3 collaterals of the wstETH market and 5 of the
USDS market:

| App's key | Comet, from the seed (`registry/seed/production.comets.json`) | Collateral | Token address the repository holds |
|---|---|---|---|
| `1:wstETH` | cwstETHv3, `0x3d0bb1ccab520a66e607822fc55bc921738fafe3` | rsETH | `0xa1290d69c65a6fe4df752f95823fae25cb99e5a7` |
| | | ezETH | `0xbf5495efe5db9ce00f80364c8b423567e58d2110` |
| | | weETH | `0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee` |
| `1:USDS` | cUSDSv3, `0x5d409e56d886231adaf00c8775665ad0f9897b56` | USDe | `0x4c9edd5852cd905f086c759e8383e09bff1e68b3` |
| | | sdeUSD | `0x5c5b196abe0d54485975d1ec29617d42d9198326` |
| | | tBTC | `0x18084fba666a33d37592fa2633fd49a74dd93a88` |
| | | weETH | `0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee` |
| | | deUSD | `0x15700b564ca08d9439c58ca5053166e8317aa138` |

Nothing in the repository says which tokens these two Comets take as
collateral. The registry's test fixture holds four Ethereum markets — USDC,
WETH, USDT and WBTC — the source fixtures hold the roots of the USDC and
institutional USDC markets only, and the seed names both Comets
(`production.comets.json`) but no Comet's collateral. Each token address is
the one the fixture's Ethereum markets hold under that symbol. That each is
a collateral of its Comet is what a development deployment's active version
said: on 2026-10-22, its export listed each of the 8 exactly once, as a
collateral of its Comet, with the address and the symbol the table has.
Step 8's review checks every row of the file again, against the version
that is on where it is sent, before anything is written.

## Hiding a collateral

A hidden collateral is a collateral of a market that token discovery does not
show there. It stays a collateral of its market: the market still takes it,
and a user's positions in it and the actions on them are shown as before.
Hiding is about discovery alone; to stop offering a collateral in a market,
mark it deprecated instead
([Marking a collateral deprecated](#marking-a-collateral-deprecated)). The
decision is about one collateral of one market — its chain, the market's
Comet and the token — so a token can be hidden in one market and not in
another. Discovery decides each market by that market's own decisions: a
collateral its Comet hides is not shown there. No other market's decision
hides it there, so to keep a token out of discovery on the whole chain, hide
it in every market that takes it as collateral, those whose status is
`deprecated` among them; a market that has it deprecated does not show it
either.

**Name the token the version holds.** Take the addresses from the export
below, from the market reads (`GET /registry/v1/networks/<chain>/markets`) or
from the token policies (`GET /registry/v1/admin/networks/<chain>/tokens`),
never from what the app shows. Where the app shows a wrapped native token as
the chain's own coin, at the zero address — ETH for WETH on seven chains, POL
for WPOL, RON for WRON — hide the wrapped token: hiding WETH is what keeps
the app's ETH out of discovery. On Ethereum, hide wstETH, not the stETH the
app lets a user supply in its place: the stETH row follows wstETH's decision.
A request that names an address the app shows, and the version does not hold,
answers `404`.

Like a strategic mark, the decision stays when a newer version is switched
on, and comes back if a version drops the collateral and a later one brings
it back. You can only decide about a collateral of a market of the version
that is on, and every change needs a reason, which is kept with who made it.
So a collateral a new version adds can be hidden only once that version is
on: send the request right after the switch
([6. Switch it on](#6-switch-it-on)).

```sh
curl -s -X PATCH "$API/registry/v1/admin/networks/1/markets/0xc3d688b66703497daa19211eedff47f25384cdc3/collaterals/0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee/hidden" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"isHidden": true, "reason": "Not shown by discovery in the USDC market"}' | jq
```

Postman:

```http
PATCH {{API}}/registry/v1/admin/networks/1/markets/0xc3d688b66703497daa19211eedff47f25384cdc3/collaterals/0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee/hidden
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{"isHidden": true, "reason": "Not shown by discovery in the USDC market"}
```

**You should see** `"changed": true` and the time in `updatedAt`. Sending the
same request again answers `"changed": false` and records nothing, so it is
safe to repeat. To take the decision back, send `"isHidden": false` with a
reason.

The reads say it in their next answer, which a browser may keep for up to 5
minutes (`REGISTRY_SNAPSHOT_CACHE_TTL_S`):

- `GET /registry/v1/networks/1/markets/<comet>`, the chain's market list and
  `/registry/v1/active` have `"isHidden": true` on that collateral of that
  market.

One collateral's decision, with its history, newest change first:

```sh
curl -s "$API/registry/v1/admin/networks/1/markets/<comet>/collaterals/<token>/hidden" \
  -H "Authorization: Bearer $TOKEN" | jq
```

A decision stays when a version that drops the collateral from its market is
switched on: the export below lists it under `retained`, and its history
still answers, with `"inActiveVersion": false`. It applies again the moment a
version whose market takes the collateral, and is not disabled, is switched
on.

Nothing is hidden when an environment is brought up: there is no initial list
of hidden collaterals, as there is of deprecated ones.

### A reviewed list of hidden collaterals

A list is applied as a list of deprecated collaterals is, in three requests,
and you never type an address: the first one gives you every collateral as a
file.

**1. Export the collaterals.** Every collateral of every market of the
version that is on, with its hidden decision, in the form the next two
requests take:

```sh
curl -s "$API/registry/v1/admin/hidden-collaterals" -H "Authorization: Bearer $TOKEN" > hidden-collaterals.json
jq 'if .error then .error else (.hiddenCollaterals | length) end' hidden-collaterals.json   # how many collaterals, or why not
```

Postman:

```http
GET {{API}}/registry/v1/admin/hidden-collaterals
Authorization: Bearer {{TOKEN}}
```

(**Save Response → Save to a file**.) Edit the file: set `"isHidden": true` on
the collaterals the list hides (or `false` to take a decision back) and write
why in the `"reason"` at the top. A row may carry its own `"reason"`, which
wins. Leave every other row as it is, or delete it. A row's `deploymentKey`
and `symbol` are there for you to read, and are checked: a market or a symbol
that is not the one the version that is on names is refused. `retained` is
not read. The rows are under `hiddenCollaterals`, so a file of deprecated
collaterals sent here, or this one sent to the deprecated routes, is refused
with `400` (`unexpected properties`). Step 3 applies only the rows the review
shows as changes.

**2. See what it would change** — this writes nothing, and keeps the answer
for step 3:

```sh
curl -s -X POST "$API/registry/v1/admin/hidden-collaterals/review" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' --data @hidden-collaterals.json > review.json
jq 'if .error then .error else .summary, (.hiddenCollaterals[] | select(.action == "change" or .problem != null)) end' review.json
```

Postman:

```http
POST {{API}}/registry/v1/admin/hidden-collaterals/review
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

(Body → raw → JSON, and paste the file)
```

**You should see** `"problems": 0`, and under `change` exactly the
collaterals the list decides, each with what it is now (`current`), what the
list wants (`requested`) and the reason it will be recorded with. A row with
a `problem` names a chain or a Comet the version that is on does not hold, a
token that is not a collateral of that Comet — the ETH or the stETH the app
shows, say — a market or a symbol that is not that row's, or a change
without a reason; fix the file and review it again.

**3. Apply what it changes** — right after the review:

```sh
jq 'if .error then error("the review failed: \(.error.message)")
    elif .summary.problems > 0 then error("the review found problems: fix the file and review it again")
    elif .summary.change == 0 then error("the review shows no change: there is nothing to apply")
    else {reason: null, hiddenCollaterals: [.hiddenCollaterals[] | select(.action == "change") | {chainId, cometAddress, deploymentKey, tokenAddress, symbol, isHidden: .requested, reason}]}
    end' review.json > reviewed.json \
  && curl -s -X POST "$API/registry/v1/admin/hidden-collaterals/apply" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' --data @reviewed.json \
  | jq 'if .error then .error else .summary end'
```

`jq` writes to `reviewed.json` only the rows the review shows under `change`,
each with the `reason` the review showed, which is the one the change is
recorded with, and the `deploymentKey` and `symbol` the version names. If the
review answered an error, found problems or shows no change, `jq` says so,
and nothing is sent.

Postman: the same request as step 2, to `…/hidden-collaterals/apply`, with
`reviewed.json` as the body. Without `jq`, write the body from the rows the
review shows under `change`: `{"reason": null, "hiddenCollaterals": [ … ]}`,
each row with its `chainId`, `cometAddress`, `deploymentKey`, `tokenAddress`,
`symbol`, `requested` as `isHidden`, and `reason`.

**You should see** `"changed"` equal to the number of changes the review
showed. Apply compares `reviewed.json` with the decisions in force when it
runs, as it does for a list of deprecated collaterals: if the number is
lower, someone decided one of its collaterals after your review, and the
answer's rows show which. Apply does not touch a collateral `reviewed.json`
does not name. The list is written in one go: if any row cannot be applied
(`422`, naming the rows), or a version is switched on or one of its
collaterals decided while it is being written (`409`), nothing is written.
Applying `reviewed.json` again changes nothing.

To use the list in another environment, take the edited file, not
`reviewed.json`, which holds only what changes here, and keep only the rows
the list decides: another environment's version may not hold every
collateral it names. Review it there and apply what it changes, as steps 2
and 3 do here.

## Keeping an eye on it

One request tells you whether the registry is well:

```sh
curl -s "$API/registry/v1/admin/status" -H "Authorization: Bearer $TOKEN" | jq
```

Postman:

```http
GET {{API}}/registry/v1/admin/status
Authorization: Bearer {{TOKEN}}
```

**You should see** `"alerts": []`. Everything else in the answer is context:
which version is on, who switched it on and who approved that, whether its
data is cached, when
the source was last checked, how the last import went, which drafts are
still open, when the chain was last read again, and for which version
(`chainCheck`), and whether moves and approvals are announced
(`notifications`).

When `alerts` is not empty, each name says what to do:

| Alert | What it means | What to do |
|---|---|---|
| `configuration-invalid` | A registry setting of this environment is set to something it does not take; `configuration.invalid` names each. The import refuses to start while one of its own is invalid, a read takes the default in its place — an approval given meanwhile lasts the default day — and nothing is announced to a webhook that is not an `https` URL | Correct the value in the environment's `[vars]` in `wrangler.toml` and deploy: the numbers are whole numbers, `COMET_REGISTRY_APPROVAL_TTL_S` one from 1 to 604800 (a week), `COMET_SOURCE_REPOSITORY` is `owner/repository` and `COMET_SOURCE_REF` a branch, a tag or a commit. `COMET_REGISTRY_WEBHOOK_URL` is a secret instead: put it again, as the `https` URL of the webhook (step 3 of [Announcing changes](#announcing-changes)), or delete it |
| `no-active-version` | Nothing is switched on, so every market route answers `503` | Bring a version up — [Bringing an environment up for the first time](#bringing-an-environment-up-for-the-first-time) |
| `candidate-awaiting-review` | A draft is held for review and no import is running | Review it, then validate it (step 4 of [the first bring-up](#bringing-an-environment-up-for-the-first-time)) |
| `candidate-awaiting-activation` | A new commit was imported and validated, and is waiting to be switched on; `candidates.validated` names it | [When the source changes](#when-the-source-changes). The alert holds until a version at least that new is switched on: one you decide not to switch on keeps it raised until a newer commit's version is |
| `candidate-awaiting-approval` | The newest version waiting to be switched on has no approval anybody could switch it on with: none was given, or the one given expired, was used, or was given while another version was on | An admin reads what it changes and approves it (step 5 of [the first bring-up](#bringing-an-environment-up-for-the-first-time), with the version's id and the version on as `expectedActiveVersionId`). The alert clears then, and comes back if the approval expires unused or another version goes on first; its `approval` in `candidates.validated` names it while it holds |
| `candidate-drops-markets` | A version waiting to be switched on would stop serving markets the version on serves; its `unserved` in `candidates.validated` names them, by their keys in the version on. Nothing holds it back | Step 2 of [When the source changes](#when-the-source-changes): `markets.unserved` says where each Comet went. Confirm every one with a developer before switching it on, and describe a renamed one under its new key first. The alert holds until a version at least that new is switched on |
| `commit-rejected` | The newest commit imported completely but did not validate, and the scheduled job will not import it again by itself; `sync.rejectedCommit` names it | Read why it failed (`GET /registry/v1/admin/versions/<versionId>`). If a decision was wrong, hold a new attempt (step 1 of [Describing a new market](#describing-a-new-market)), correct it there and validate; otherwise the alert clears when the source moves on |
| `chain-drift` | The version on stores a price feed or a collateral asset its market's Comet no longer answers with: governance changed the market on chain after the import, and the source did not move. `chainCheck.drifts` names each, with what the version stores and what the chain answers. Until a version that agrees is on, the summary at the latest block leaves out a collateral the Comet added, and the summaries read the base feed the version stores, or where it reverts the one the Comet names ([A market that changed on chain](#a-market-that-changed-on-chain)) | [A market that changed on chain](#a-market-that-changed-on-chain): import the commit again with `forceNewAttempt`, check what it changes and switch it on. The alert clears once the next hourly invocation has checked the version on and found it agrees with the chain, within the hour of the switch |
| `last-sync-failed` | The last import ended `failed`. `sync.lastRun.lastError` says how: `validation failed` is a draft that failed a check, and `cancelled by <actor>: <reason>` a run somebody cancelled. A root that fails does not fail the run, and neither do the checks of a run held for review — the first import of an environment, or one with `holdForReview`: it completes, its draft left open | After `validation failed`, read the draft's checks: `GET /registry/v1/admin/versions/<sync.lastRun.registryVersionId>` lists them under `validation.checks`, failed first, with their `details`. If `all-roots-imported` is among them, the run gave roots up: `GET /registry/v1/admin/sync-runs/<sync.lastRun.id>` lists them with `status` `failed`, and why in each `lastError`. Fix that — most often the node provider proxy — and the scheduled job tries the commit again, or force a new attempt. Otherwise `commit-rejected` is raised as well: follow it. After a cancel, import again as `sync-stalled` says |
| `sync-failing` | The import that is running keeps failing: the last root it tried failed, or an invocation has failed since before trying one, and the roots left failed have spent two attempts or more between them — two roots once, or one root twice. A single failure does not raise it. `sync.lastRun.lastError` says why, once an invocation has recorded it | Read its run: `GET /registry/v1/admin/sync-runs/<id>` lists each root with why it failed and the `attempts` it has spent. `SOURCE_REQUEST_FAILED` and `CHAIN_REQUEST_FAILED` are GitHub or the node provider proxy not answering: fix the proxy, or wait for GitHub, and the next hourly invocation carries on. Until then an invocation that imports nothing spends an attempt of each root it tries, and a root is given up after five, whatever failed it. `the invocation importing this root did not finish` is an invocation stopped in the middle of that root — a deploy, or a Worker past its time or CPU: the next one tries it again, and if one market keeps stopping it, the worker's logs say what did. Until the next one records it, such a root is still `processing`, under a `leaseExpiresAt` already past, and the run's `lastError` is still that of the attempt before it — `null` if that one succeeded. `the database did not answer` is D1 failing under that root — restarted, overloaded or cut off. A restart or an overload spends the attempt all the same, and the next invocation tries the root again; if it keeps coming back, check the database's health. The worker's log line `registry root failed` has what D1 said, as it has the whole of a fault, which a root records as `an unexpected error interrupted the import`. Anything else is the root itself. A `lastError` that no root of the run carries — `OVERLAY_INVALID` naming a `version …`, or `an unexpected error interrupted the import` — is an invocation that failed before it tried a root: see `sync-stalled`, which the status raises as well once nothing has moved for two hours |
| `sync-stalled` | A run says it is running, but nobody is continuing it: the hourly trigger is not firing, or every invocation fails before it imports a market | Read why in `sync.lastRun.lastError`; where it is `null`, the worker's log line `registry sync failed` names the service that did not answer — GitHub, the node provider proxy or the database — and once it answers, the hourly import resumes the run by itself. A `lastError` that comes back the same every hour does not pass: cancel the run — `POST /registry/v1/admin/sync-runs/<sync.lastRun.id>/cancel` with `{"reason": "…"}` — fix what it names, then import again with `{"forceNewAttempt": true, "reason": "…"}` (step 1 of [the first bring-up](#bringing-an-environment-up-for-the-first-time)). That attempt is of the commit the tracked ref names now: if the source has moved on since the run started — the cancel's answer names the run's `sourceCommitSha` — it imports the newer commit and leaves the run's draft open. To keep what was reviewed on that draft, send the run's `sourceCommitSha` with `forceNewAttempt` instead; otherwise close the draft as the row on a draft of an older commit in [When something goes wrong](#when-something-goes-wrong) says. Cancelling does not help with two of them, which a new attempt meets the same way. `an unexpected error interrupted the import` is a fault, which the log has whole as `registry sync failed unexpectedly`: see `INTERNAL` in [When something goes wrong](#when-something-goes-wrong). `OVERLAY_INVALID` naming a `version …` is a decision that version stores, the one on or an earlier attempt of the commit, which this release no longer takes: a developer's to fix, in a release. Once either is fixed, the hourly import resumes the run by itself |
| `sync-overdue` | The source has not been checked for more than two days, or never: a fresh environment raises it beside `no-active-version` until its first import records a check | On a fresh environment, nothing: the first import clears it, whether the hourly job starts it or you do ([the first bring-up](#bringing-an-environment-up-for-the-first-time)). Otherwise the hourly trigger is not firing, or every invocation fails before it records a check: a failed one is a failed Cron in the dashboard's Cron events, and the worker's log line `registry sync failed` says why |
| `snapshot-not-cached` | The active version is not in the cache | Harmless by itself — the next request refills it. If it persists, the KV namespace is misconfigured for this environment |
| `cache-unreadable` | The KV namespace itself did not answer | Check the `kv_registry` binding of this environment: until it answers there is no cache, and no older version to fall back on if the database fails |
| `notification-failing` | A move went live, or an approval was given, and the channel was not told: the webhook refused the message, or did not answer within 5 seconds. `notifications.failure` names it — the version it named (`versionId`), and the move (`activationId`) or the approval (`approvalId`) — with what the webhook answered (`status`, `null` when it did not answer) and why. A `kind` of `null` is a message that failed before the move or the approval was read — the database did not answer right after it, none had that id, or the worker met a fault — and `reason` says which | Tell the channel what happened: `GET /registry/v1/admin/versions/<versionId>` lists the move under `activations` and the approval under `approvals`, or `active` in the status names the version on. A `status` of `403`, `404` or `410` is a webhook Slack no longer takes — removed, or its channel archived: make a new one and put it ([Announcing changes](#announcing-changes)). No `status` is Slack, or the way to it, not answering: nothing to fix if it happened once. The alert clears once a later message is sent, an approval's or a move's; to clear it once the channel has been told, delete its record: `npx wrangler kv key delete notification-failure:v1 --binding kv_registry --env <environment> --remote` |

This is the request to point a monitor at: poll it every few minutes and
alert when `alerts` is not empty, or when the request itself fails.

## What the registry keeps

The registry never deletes a version. Every attempt at importing a commit
is a version with all its rows — about 1,500 for the source today, some 400
of them the results of one validation — and a version, its checks, its
overlay events, its approvals and the activations are kept by the schema:
triggers refuse to delete them, and the rows of a version that has been
decided cannot change. A version is written only when the source has a new
commit, or an attempt at one is retried or forced, so the database grows
with the source's commits, which stays far below D1's limits for years.
Keeping them is what makes switching back possible — a rollback one step at
a time, or an approved activation of any earlier version — and what keeps
the audit trail whole. A version names who asked for the import that
created it (`createdBy`): the operator for one an administrative sync
created, whatever the request asked for, and `registry-cron:<environment>`
for one the hourly job created — the same as its run's `requestedBy`.

The foreign keys from a version's snapshot rows and checks to it say
`ON DELETE CASCADE`, but no cascade ever runs while those triggers refuse the
delete; its overlay events, approvals and activations say `RESTRICT`. The
cascades are there for a retention job that does not exist yet: one that
removes old versions has to replace those triggers in a migration of its
own, keep the active version and the ones a rollback may still need, and
keep the audit rows of every version it removes elsewhere.

## When something goes wrong

Every error answer is the envelope `{"error": {"code", "message", "requestId", "details"}}`:
below, `503 UPSTREAM_UNAVAILABLE` names the status and `error.code`, and a
code such as `SOURCE_REQUEST_FAILED` is the answer's `details.code`. The
worker logs every `5xx`, `401` and `403` answer under its `requestId`, and
every import a sync request runs under the `requestId` of its answer — a
refusal, such as a `409`, as the warning `registry sync refused`; any other
refusal is explained by the answer alone, but for `422` "validation failed",
whose reasons are in the draft it names.

| What you see | What it means | What to do |
|---|---|---|
| `INTERNAL` from the import, with a `requestId` | A fault rather than a service being down — most often the environment's database has no migrations applied. The worker's log has the error under `registry sync failed unexpectedly` | Apply the migrations (`npm run d1:migrate:<env>`), then import again; anything else is a bug to report with the log line |
| `UPSTREAM_UNAVAILABLE: the import was interrupted by a service that did not answer` | The database did not answer, or was restarted under the request; the log line `registry sync failed` has its message | Import again; if it persists, check the database |
| `503 UPSTREAM_UNAVAILABLE`, `details.code` `SOURCE_REQUEST_FAILED` | GitHub did not answer, or not within 20 seconds, or answered with an error status. "its rate limit is used up until …" is its hourly allowance spent, and "too many requests at once" its limit on bursts | Import again — after the time the message names, if it names one. Without `COMET_GITHUB_TOKEN` the allowance is 60 API requests an hour: set it ([Before you start](#before-you-start)) |
| `422`, `details.code` `SOURCE_CONFIGURATION_INVALID`, from the import | A setting the import reads is not what it takes, and the message names it; `/admin/status` raises `configuration-invalid` | Correct the value in `wrangler.toml` and deploy |
| `422`, `details.code` `SOURCE_TREE_TRUNCATED`, `SOURCE_CONTENT_TOO_LARGE` or `SOURCE_RESPONSE_INVALID` | GitHub answered, but with something the import cannot use, and would answer the same way again | Report it to a developer with the message; importing again does not help |
| `422`, "validation failed", from the import, with `details.syncRunId` and `details.registryVersionId` | The import finished and its draft failed a check: the draft is `invalid`, and can no longer change. `/admin/status` raises `last-sync-failed`, and `commit-rejected` as well when every root imported | Read the draft's checks: `GET /registry/v1/admin/versions/<registryVersionId>`, under `validation`. If `all-roots-imported` failed, `GET /registry/v1/admin/sync-runs/<syncRunId>` names the roots the run gave up, and why. Otherwise correct the decisions in a held attempt (step 1 of [Describing a new market](#describing-a-new-market)) and validate it, or wait for a new commit |
| `400`, `details.code` `OVERLAY_INVALID`, from the import or an overlay route, with a message that begins `version <id> market` or `version <id> network` — or, from `GET …/markets/<chainId>/<deploymentKey>/overlay`, with the market's key, such as `1/weth.displayName` | A decision a version stores that this release no longer takes. From the import, the version is the one on or an earlier attempt of the commit: every import fails on it before it imports a market, and spends nothing; `/admin/status` has it as `sync.lastRun.lastError`, and raises `sync-stalled` once nothing has moved for two hours. From an overlay route, it is the draft's own: every overlay write to the draft — `PUT …/overlay` and `PUT …/overlays` — reads all of its decisions first and is refused, the one that would replace that decision too, and so is the `GET` of the network or market that holds it | Report it to a developer with the message: a release that reads the decision again fixes it. The import then carries on by itself; cancelling the run does not help before that, since a new attempt reads the same decision. A draft the overlay routes refuse cannot be reviewed until then: leave it open, and do not validate it or switch it on — validation does not read the decisions again, and a version on that holds such a decision stops every import |
| Linea WETH's reward price is about `0.009` (`reward_asset.price` in the rewards routes) | The environment was brought up before 2cf4843, with the COMP / ETH reward feed quoted in USD, and every later version inherited `"quote": "usd"`. The seed quotes it in the base asset | Hold a draft (`{"forceNewAttempt": true, "holdForReview": true, "reason": "quote Linea WETH's reward feed in its base asset"}`), read `…/versions/$V/markets/59144/weth/overlay`, send it back with `rewardPriceFeed.quote` `"base"`, then validate and switch it on (steps 4 to 7 of the first bring-up) |
| `CHAIN_REQUEST_FAILED` in the import | The worker cannot reach the node provider proxy, or the proxy did not serve the calls, or did not answer them within 30 seconds. The worker's log line `registry root failed` has the status the proxy answered and its URL without the key: `HTTP 503` is no provider answering the proxy, `HTTP 401` the proxy refusing `NODE_PROXY_KEY` | Fix the proxy, its binding or its key; importing again continues where it stopped |
| A network under `chainCheck.unreadable` in `/admin/status` | The check of the chain could not read that network, for the reason it names — most often `CHAIN_REQUEST_FAILED`, as in the row above. Nothing new is known about its markets: it raises no `chain-drift` of its own and clears none, since a drift found there before stays, with the `seenAt` of the last read that found it. The warning `registry chain not read` in the worker's log has the cause | Fix the proxy for that network. The check reads it again at the next hourly invocation, until it has read every network |
| `chain-drift` in `/admin/status` | The chain answers a market's feed or collateral otherwise than the version on stores it | [A market that changed on chain](#a-market-that-changed-on-chain) |
| `422`, `details.code` `OVERLAY_CREATION_BLOCK_WRONG`, writing an overlay, the seed among them | A `creationBlock` the document changes is not the block the market's Comet was deployed in; the message says whether it is before the deployment, after it, or past the latest block. Nothing was written | Send the block the chain's explorer gives as the Comet's "Contract Creation" (step 4 of [Describing a new market](#describing-a-new-market)). From the seed, the file's block is wrong, or the key now names another Comet: see step 3 of [the first bring-up](#3-send-the-seed) |
| `401`, "the bearer token is not valid" | The token is not one the environment lists: a wrong one, or its hash in its place | Use the token itself; check it as step 5 of [The admin tokens](#the-admin-tokens) says |
| `401`, "the bearer token has expired" | Your token's `notAfter` has passed: it was rotated out | Use the token that replaced it, or ask the environment's owner for one |
| `403`, "the token … has the role …, and this route needs …" | Your token's role does not reach the route; `details.requiredRole` names the role that does | Ask for a token with that role, or ask its holder to make the change |
| `403`, "the administrative API is misconfigured in this environment: …", or "… is not configured …" | The environment has no token in its list, or a list the worker cannot read, so every token is refused | Step 5 of [The admin tokens](#the-admin-tokens) says what each message means and what to do |
| `413` | The request body is larger than the route takes | Send less: a directory of overlays, or a list of token policies, of deprecated or of hidden collaterals, in several requests |
| `429`, "too many administrative requests from this address" | More than 60 administrative requests in a minute from your address — over IPv6, from your /64 — whatever they were: every request under `/registry/v1/admin/` is counted by address before its token is checked, a wrong token or a path no route takes included, and the right token is refused too once the address has spent its budget | Wait the seconds its `Retry-After` names — a minute at most. A script in a loop, or a monitor sharing your address, is what spends it |
| `429`, "too many … requests with this token" | More than 30 administrative requests in a minute with your token, counted per family of routes. Reads count too, and every read shares one budget, while each kind of command has its own; anyone using your token spends it with you. Reviewing a list of token policies, of deprecated or of hidden collaterals writes nothing and counts as a read ("too many read requests"); marking a token or a collateral, hiding a collateral, and applying a list of any of them, share one budget ("too many policy requests") | Wait the seconds its `Retry-After` names. A monitor polls with a `monitor` token of its own, which spends nothing of yours |
| `404` marking a token | The version that is on does not hold that chain or that token | Check the chain id and the address against `GET /registry/v1/admin/networks/<chain>/tokens`; a token only a newer draft holds can be marked once that draft is switched on |
| `409` marking a token, `details.code` `TOKEN_LEFT_REGISTRY` ("left the active registry") | A version without that token was switched on while the change was being written; nothing was written | Check which version is on, and mark the token again if it is still there |
| `404` "no registry route matches …/token-policies" | The Worker at that address was deployed before token policies | Deploy the release with token policies first |
| `404` marking a collateral deprecated | The version that is on does not hold that chain, no market of it has that Comet, or that market does not take that token as collateral — the message says which | Check the addresses against the export (`GET /registry/v1/admin/deprecated-collaterals`); a collateral only a newer draft holds can be marked once that draft is switched on |
| `409` marking a collateral deprecated, `details.code` `COLLATERAL_LEFT_REGISTRY` ("left the collateral of") | A version whose market does not take that token was switched on while the change was being written; nothing was written | Check which version is on, and mark the collateral again if its market still takes it |
| `404` "no registry route matches …/deprecated-collaterals" | The Worker at that address was deployed before deprecated collaterals | Deploy the release with deprecated collaterals first |
| `404` hiding a collateral | The version that is on does not hold that chain, no market of it has that Comet, or that market does not take that token as collateral — the message says which. An address the app shows in place of the token the version holds is such a token: the zero address of ETH, POL or RON, or stETH beside wstETH | Take the addresses from the export (`GET /registry/v1/admin/hidden-collaterals`), the market reads (`GET /registry/v1/networks/<chain>/markets`) or the token policies (`GET /registry/v1/admin/networks/<chain>/tokens`) — WETH, WPOL, WRON or wstETH; a collateral only a newer draft holds can be hidden once that draft is switched on ([Hiding a collateral](#hiding-a-collateral)) |
| `409` hiding a collateral, `details.code` `COLLATERAL_LEFT_REGISTRY` ("left the collateral of") | A version whose market does not take that token was switched on while the change was being written; nothing was written | Check which version is on, and hide the collateral again if its market still takes it |
| `404` "no registry route matches …/hidden-collaterals", or "…/hidden" hiding a collateral | The Worker at that address was deployed before hidden collaterals | Deploy the release with hidden collaterals first |
| `422` applying a list | Some rows cannot be applied; `details.problems` names each with why; nothing was written | Fix those rows — review shows them in context — and apply again |
| `409` applying a list, `details.code` `TOKEN_LEFT_REGISTRY`, `COLLATERAL_LEFT_REGISTRY` or `DECISION_CHANGED` ("while it was being applied") | A version without one of the list's tokens, or collaterals, was switched on — or, for `DECISION_CHANGED`, someone else decided one of its rows — while the list was being written; nothing was written | Review the file again, then apply it |
| `503` "the database is missing tables this release needs", from a token policy, deprecated or hidden collateral route, `/active` or the market reads | The worker was deployed before its D1 migrations: the token policy tables, `0005`, the deprecated collateral tables, `0007`, or the hidden collateral tables, `0008`, are missing | Apply the migrations to this environment (`npm run d1:migrate:<env>`, or `npx wrangler d1 migrations apply APP_DB --remote -c <config>`) |
| `422`, `details.code` `OVERLAY_FEED_UNREADABLE`, writing an overlay | A feed the overlay names does not answer its decimals on that chain: it reverts, or nothing is deployed at that address there — most often a feed of another chain | Check the address against the chain's feed; a `503` instead is the node provider not answering, and worth trying again |
| `409` writing overlays, `details.code` `VERSION_NOT_IMPORTING` ("… registry version cannot be changed" or "is no longer importing") | The draft is no longer open: it was validated, switched on, or replaced by a newer attempt of its commit (`GET /registry/v1/admin/versions/<id>` says which) | Look for the newest open draft first (`GET /registry/v1/admin/versions?status=importing`) and continue there; start a new attempt (step 1 with `forceNewAttempt`) only if there is none |
| `409` on validate, `details.code` `IMPORT_STILL_RUNNING` ("the import … is still running") | The import has not finished | Send step 1 again until it completes |
| `409` on validate, `details.code` `CANDIDATE_CHANGED` ("the candidate changed while it was being validated") | An overlay was written to the draft while it was being checked, so the checks no longer described it and none was kept | Validate it again |
| `409` writing an overlay, `details.code` `OVERLAY_CHANGED` ("is no longer the one this was decided against" or "changed while this overlay was being written") | Somebody changed the draft between your read and your write | Read the overlay again — `GET …/markets/<chainId>/<deploymentKey>/overlay` or `GET …/networks/<chainId>/overlay`, whose answer has its `digest` — redo your change on it, and send it with that digest as `expectedDigest`, or under the document's key in `expectedDigests` of a `PUT …/overlays` |
| `409` writing an overlay, `details.code` `SLUG_TAKEN`, `DEFAULT_TAKEN` or `REWARD_FEED_WITHOUT_REWARD` ("already has that slug", "is already the default" or "cannot carry a reward price feed") | The document conflicts with the rest of the draft: another market of the network keeps that slug, another market is the default, or the market's rewards contract names no reward token. The draft is open, and nothing was written | Change the document, not the draft. Choose another slug, or move it with both markets in one `PUT …/overlays`; move the default the same way, both markets in one request. Read both first, and send each one's `digest` under its key in `expectedDigests` (`{"1/usdc": "<digest>", "1/weth": "<digest>"}`), so a change made to either since is not undone. A market without a reward token takes `"rewardPriceFeed": null` and both rewards capabilities `false` |
| `409` on activate, rollback or approve, `details.code` `CANDIDATE_STATE_CONFLICT` ("the active version is …" or "the active version changed to … while this … was decided") | Somebody switched another version on after you looked, or while your request was deciding. Nothing of yours was recorded | Read the status again and decide again |
| `409` on activate, `details.code` `APPROVAL_REQUIRED` | No approval of the version you may switch it on with: none was given, or it was given by you or another token of your name, has expired, was used, or was given while another version was on — the message names the version an approval is needed against. "Was used up while it was decided" is an approval another switch used in the meantime | Have another admin approve it again, against the version on (step 5 of [the first bring-up](#bringing-an-environment-up-for-the-first-time)), then switch it on |
| `409` on rollback, `details.code` `ROLLBACK_TARGET_INVALID` | A rollback goes back one step only, to the version the one on replaced when it was last activated, if that is older. This one is another — two steps back or more, never on, or newer — or nothing is on, or the version on was switched on in place of a newer one. The message names the version a rollback may restore now, or says that none may; "was switched on again while this rollback was decided" is the version on activated again meanwhile, in place of another | Roll back to the version the message names, one step at a time, as [Switching back](#switching-back) says. To switch on any other version, approve it and activate it (steps 5 to 7 of [the first bring-up](#bringing-an-environment-up-for-the-first-time)) |
| `400` on approve, "expectedActiveVersionId is required" | The approval does not say which version on its changes were read against | Read the changes, and send the version on as `expectedActiveVersionId` — `comparedWith` in their answer, or `null` when nothing is on (step 5 of [the first bring-up](#bringing-an-environment-up-for-the-first-time)) |
| `409` on approve, `details.code` `CANDIDATE_STATE_CONFLICT` ("is on already") | The version is the one on: there is no change to approve | Nothing |
| A version is `invalid` with the failed check `served-network-reviewed` | It serves a market of a network nobody has described — a chain no version had before | An `invalid` version can no longer be changed. Hold a new attempt (step 1 of [Describing a new market](#describing-a-new-market)), which keeps what was reviewed in this one; describe the network there (step 5), then validate it and switch it on (steps 4 to 7 of the first bring-up) |
| A root failed with `OVERLAY_INVALID`, "is the default market by the decisions it inherits, but … already is the default" | The draft holds another default than the one its import inherits: the draft's default was moved to a market it holds before the import reached the market that opened by default, or a version that names another default was switched on while the import was running | If the draft's default was moved, the draft is still importing, and the root has attempts left (`attempts` below five in `GET /registry/v1/admin/sync-runs/<id>`): move the default back, import the rest, then move the default with both markets in one `PUT …/overlays`, with their digests under `expectedDigests` as in the row on a slug above. Otherwise continue the import until it ends — each request spends one of the root's five attempts — and hold a new attempt (step 1 of [Describing a new market](#describing-a-new-market)): it inherits the default the draft moved, or the one switched on, and imports both markets |
| `idle` from import, "attempt … of this commit imported every root and is invalid" | The commit was imported completely and did not validate; another attempt would fail the same way, so the scheduled job does not make one | Read why it failed (`GET /registry/v1/admin/versions/<registryVersionId>`). Correct the decisions in a held attempt (step 1 of [Describing a new market](#describing-a-new-market)) and validate it, or wait for a new commit |
| `idle` from import, "attempt … did not import every root; it is tried again after …" | Roots of the last attempt did not import — a chain that did not answer, or contracts the source names before they are deployed | Nothing: the scheduled job tries again then. To try now, force a new attempt |
| `idle` from import, "a candidate of this commit is held for review" | A draft of this commit is already waiting for you | Use that draft — its id is in the answer — or force a new attempt. The new attempt closes that draft only once it succeeds; if it fails, the draft is still there to validate |
| `idle` from import, "upstream was checked recently", with no `registryVersionId` | The source was checked less than a day ago and nothing is importing, so the request had nothing to do and names no draft | On a first bring-up the hourly job has finished the import and held its draft: it is under `candidates.importing` in `GET /registry/v1/admin/status`, and has every market only if `sync.lastRun` there has `completedCount` equal to `expectedCount`; if not, fix why the job gave markets up and start a new attempt ([If the hourly job got there first](#1-import--take-a-snapshot-of-the-source)). Later, see [Find the new version](#1-find-the-new-version) |
| A version is `invalid` with the failed check `superseded-by-newer-attempt` | A newer attempt of the same commit succeeded and replaced this draft; its `details` name which | Work on that attempt. Reviews made on this draft before the replacement was imported are in it; anything reviewed here afterwards is not — redo it on the newest draft (`GET /registry/v1/admin/versions?status=importing`) |
| `/admin/status` keeps listing a draft of an older commit | The source moved to a newer commit while that draft was open; drafts are only replaced by attempts of their own commit, because reviews do not carry across commits | Finish it (validate it — that also closes it), or, if the newer commit's version has taken its place, validate it anyway to close it |
| `409 CONFLICT`, `details.code` `SYNC_ALREADY_RUNNING` | An import is in progress — the hourly one, a request you already sent, or one you are asking to change with `forceNewAttempt`, `holdForReview` or `sourceCommitSha`. Such a request that failed, with a `503` say, may have started its run first: sent again as it was, it is refused. "another invocation is importing right now" means an invocation holds the run this very moment. A request that failed gave it back as it failed, unless the database was still not answering then (`registry lease not released` in the worker's log); that one, like one stopped without an answer — by a deploy, or past the time or CPU a Worker is given — holds it until its lease runs out, at most 15 minutes | Continue it with an empty body until it says `completed`, sending it again a little later while another invocation is importing; only then ask for a new attempt. A run that every request fails on the same way never says `completed`: cancel it, as `sync-stalled` in [Keeping an eye on it](#keeping-an-eye-on-it) says |
| `409` cancelling a run, `details.code` `SYNC_RUN_HELD` ("an invocation holds the sync run until …") or `SYNC_RUN_ENDED` ("has already ended") | An invocation holds the run until the time the message names, and may be importing into it; or the run has ended already | Cancel it again once that time has passed. A run that has ended needs no cancel: `GET /registry/v1/admin/sync-runs/<id>` says how it ended |
| A market reports `"status": "partially"` or `"status": "error"` | A price feed it reads reverts, usually one Chainlink retired | [A market that stopped answering](#a-market-that-stopped-answering) |
| `/active` and the market reads carry `X-Registry-Stale: 0`, and the log has the warning `deprecated collateral decisions unreadable; answering with the ones last recorded`, or `hidden collateral decisions unreadable; answering with the ones last recorded` | The database answered for the version that is on, but not for the deprecated or the hidden collateral decisions, so the flags are the ones the API last recorded, and the answer may not be kept | Check the database's health; the answers recover by themselves once it answers |
| `503 UPSTREAM_UNAVAILABLE` from `/active` and the market reads while the database cannot be reached, though other routes answer from the cache | No deprecated, or no hidden, collateral decisions are recorded in the environment's `kv_registry` to answer with: no read of `/active` or the market reads, and no decision of that kind, has recorded them since this release, or the record was removed | Nothing to change: once the database answers, the reads record them again, within five minutes at most |
| Answers carry `X-Registry-Stale: <seconds>`, and the log has the error `registry database unreachable; answering from the version it last named` | The database could not be reached, so the API is answering from the version it last saw, and saying how old it is. Each isolate logs the error once a minute while this lasts | Check the database's health; the API recovers by itself once D1 answers, and starts returning `503` if the outage outlasts the configured window |
| `503 UPSTREAM_UNAVAILABLE` from the market and registry routes, or from `/admin/status` | The database could not be reached, and there is no version within the window to answer from. Or, from a route that reads the chain — the market and account routes, transaction history, governance — the node provider proxy did not serve the request: no provider answered it, the worker could not reach the proxy or lost its answer, or the proxy answered a call with an error that is not a revert. Such an answer says `a node provider did not answer`, with the proxy's `Retry-After` when it sent one; the worker's log line `route failed` with the answer's `requestId` has the error — `HTTP 401` in it is the proxy refusing `NODE_PROXY_KEY` — and the proxy's own log has `upstream error` or `json-rpc error` | Check the database's health; nothing in the registry needs changing. For a node provider, fix the proxy, its binding or its key: the routes answer again as soon as it serves them |
| `500 INTERNAL` from the market and registry routes | The database answered with a fault — most often a release deployed before its migrations — or a bug, such as a call the contract reverted where the route needed its value. A node provider that did not answer is a `503`, not this. The worker's log line `route failed` or `registry route failed` with the answer's `requestId` has the error. On an activation or a rollback, with "an activation requires an approval", "a rollback restores only the older version …" or "the active registry version moves only with its activation", it is a release from before approvals answering, after the environment's first approval: deployed again, or beside the release with approvals | Apply the migrations if they are missing; deploy the release with approvals, or a later one, to all traffic if an older one answers; otherwise report the log line |
| A market reports `"status": "error"` with the message `creationBlock … is past the latest block, …`, and the log has the warning `creation block not reached` naming its Comet | The active version holds a creation block the market's chain has not reached — one no overlay write checked, such as one an import inherited. None of the market's values can be read, so the market routes and `/account/{address}/rewards` answer it as `error`, and the other markets as usual. This stops by itself once the chain reaches the block, but the market's history then repeats the day of that block for every day before it | Switch back, or give the market the block its Comet was deployed in, as step 7 of [the first bring-up](#7-check-that-it-is-on) says — after the error has stopped by itself too |
| The worker's log has the error `registry notification failed`, under the `requestId` of an approval, an activation or a rollback | The approval or the move was made, and its message to the channel was given up. `status` is what the webhook answered; without one, `reason` says why: `did not answer within 5 seconds`, `the request failed` with the error's name (`errorName`), `the move could not be read` or `the approval could not be read`, the database failing right after it, or `no move has that id` or `no approval has that id`, a fault to report. The line never has the webhook's URL. `registry notification without changes` is a message sent without its counts, which the database did not give, and `registry notification failed unexpectedly` a fault of the worker's, logged with its error | As `notification-failing` in [Keeping an eye on it](#keeping-an-eye-on-it) says; report a fault with its log line |
| The worker's log has the warning `computation cache unreadable` or `computation cache unwritable`, with what KV answered | KV refused a call to the namespace computed values are cached in, `kv_mainnet` or `kv_testnet`: `429` is a value written twice in a second, `503` KV not answering. The request was answered without the cache — a value it could not read was computed again from the chain, and one it could not write was not kept — so it was slower, and asked the node provider more. Each isolate says each once a minute while it lasts | Nothing for a `429` now and then. A `503` that keeps coming back is KV not answering: every request reads the chain while it lasts, and transaction history fails (the next row), so check Cloudflare's status and the node provider proxy |
| `500 INTERNAL` from transaction history, and the log line `route failed` has `KV GET failed` or `KV PUT failed` | KV refused a history cursor. Cursors are kept in `kv_mainnet` with the computed values, but nothing computes one again: a page whose cursor KV cannot read fails, and so does a page whose cursor it cannot keep, rather than hand out a cursor no later page could read. A first page fails so only after it has been read in full from the chain, since its cursor is written last. While KV does not answer, every page of history fails, though the other routes answer | Check Cloudflare's status; nothing in the registry needs changing. The client may ask again, and history answers as soon as KV does |
| The worker's log has the warning `history cursor written twice in a second`, with KV's `429` | Two pages asked within a second kept the same cursor — the same page asked twice, or the first pages of two accounts without history at one block: a cursor's id is the digest of what it holds, and names no account. KV takes one write a second to a key, so it refused the second write of a cursor it had just taken, and the page was answered with it | Nothing |
