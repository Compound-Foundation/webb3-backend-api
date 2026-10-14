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
and only then **switched on** ("activated"). Until the switch, users see no
change at all, and after it, one command switches back.

## Before you start

- The environment's database has every migration applied, and this happened
  **before** the worker release that needs it:
  `npm run d1:migrate:stage` or `npm run d1:migrate:production`.
- The worker is deployed, and it reaches the node provider proxy.
- The environment has `COMET_REGISTRY_ADMIN_TOKEN_HASH` set, and you have the
  admin token itself — not its hash. See
  [The admin token](#the-admin-token) if the environment has none yet.
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

Nothing runs on your machine but the requests: the Worker being deployed
imports the source, proposes the decisions and applies them. For the terminal
commands:

```sh
export API=https://v3-api-stage.compound.xyz        # the environment you work on
export TOKEN='<admin token>'
```

Every step shows the terminal command, and beside it the same request for
Postman, written as the request itself: the method and URL on the first line,
then the headers, then the body. To use them:

- Create a Postman environment with the variables `API` (the environment's
  address, e.g. `https://v3-api-stage.compound.xyz`, or `http://localhost:8787`),
  `TOKEN` (the admin token) and `V` (the draft's id, filled in step 1).
- Send every administrative request with `Authorization: Bearer {{TOKEN}}` —
  or set **Authorization → Bearer Token → `{{TOKEN}}`** once on the collection
  and let the requests inherit it.
- A body is **Body → raw → JSON**. Postman then adds
  `Content-Type: application/json` itself.
- Postman shows the whole answer; each step says which fields to look at.

> **An environment that already serves users.** The market, account and
> history routes read their markets from the registry and answer `503` while
> no version is active. Do not let the release that reads from the registry go
> live in such an environment before a version is active there. Once it is
> live, a client that pages transaction history with a cursor it was given
> before is told to start over, once (`409 REGISTRY_VERSION_CHANGED`).

### The admin token

Every administrative route takes one bearer token per environment, and the
worker keeps only its SHA-256: what is configured cannot be used as the
token. Issue the token once, keep it in the team's password manager, and put
the hash — never the token — into the environment.

**1. Make a token.** 32 random bytes are plenty:

```sh
export TOKEN="$(openssl rand -hex 32)"
```

**2. Hash it.** Use `printf`, not `echo`: `echo` adds a newline, the newline
would be part of what is hashed, and the token you then send would not match.

```sh
printf '%s' "$TOKEN" | shasum -a 256 | cut -d ' ' -f 1
```

On Linux `sha256sum` takes the place of `shasum -a 256`, and OpenSSL works
anywhere. Keep the `cut` with either: each prints more than the hash — `  -`
or ` *stdin` after it — and the environment takes the 64 hex digits alone.

```sh
printf '%s' "$TOKEN" | openssl dgst -sha256 -r | cut -d ' ' -f 1
```

**3. Put the hash into the environment.** Wrangler prompts for the value and
stores it as a secret, so it never reaches the repository:

```sh
npx wrangler secret put COMET_REGISTRY_ADMIN_TOKEN_HASH --env stage
npx wrangler secret put COMET_REGISTRY_ADMIN_TOKEN_HASH --env production
```

For a worker you run on your own machine, the same line goes into `.dev.vars`,
which git ignores:

```
COMET_REGISTRY_ADMIN_TOKEN_HASH=<the hash from step 2>
```

**4. Check it** with any administrative read — an unknown version id is
enough, because reaching a `404` means the token was accepted:

```sh
curl -s -o /dev/null -w '%{http_code}\n' \
  "$API/registry/v1/admin/versions/00000000-0000-4000-8000-000000000000" \
  -H "Authorization: Bearer $TOKEN"
```

`404` is what you want. `401` means the hash in the environment is not this
token's: one made with `echo`, another token's, or the token itself, stored
in place of its hash. `403` means the environment has no hash it can use:
none at all — an unconfigured admin API is a closed one — or a value that is
not 64 hex digits, such as a hash copied with the `  -` or ` *stdin` printed
after it. The answer's message says which; run the command again without
`-o /dev/null` to see it. Either way, put the hash in again (steps 2 and 3).

**Rotating.** Repeat steps 1–3. The previous token stops working the moment
the secret is updated, without a deploy, so replace it in the password
manager first and tell whoever else holds it. There is one token per
environment: a stage token is not a production one.

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

### 2. Read what the release proposes

```sh
curl -s "$API/registry/v1/admin/versions/$V/proposal/review" -H "Authorization: Bearer $TOKEN"
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions/{{V}}/proposal/review
Authorization: Bearer {{TOKEN}}
```

**Why.** This is the human check. The Worker writes down, for the markets the
draft imported, the decisions the API and the website already act on today —
names, features, which feed prices what — as a document to read, with where
each kind of value came from. It changes nothing.

The proposal exists for this first bring-up only. Once a version has been
switched on, the decisions live in the registry and every draft inherits
them, so the proposal routes answer `409`: a later draft is reviewed with the
overlay routes, as in [Describing a new market](#describing-a-new-market).

**You should see** "Nothing." under **Needs a decision**, and a **Digest**
near the top — note it for the next step. Skim the tables.

**If not.** A market listed under "Needs a decision" is one the constants do
not describe. It is not proposed, and stays switched off; the rest can be
applied without it, and it is described afterwards — see
[Describing a new market](#describing-a-new-market). A value that is wrong is
corrected by a developer in the tables of `src/registry/bootstrap.ts`, and
the release that carries the correction proposes it.

The same proposal as data, with the digest and the documents it would write,
is `GET {{API}}/registry/v1/admin/versions/{{V}}/proposal`.

### 3. Apply it

```sh
curl -s -X POST "$API/registry/v1/admin/versions/$V/proposal/apply" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason": "first registry version", "digest": "<digest from the review>"}' | jq '.error // {changed, unreviewed}'
```

Postman:

```http
POST {{API}}/registry/v1/admin/versions/{{V}}/proposal/apply
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{"reason": "first registry version", "digest": "<digest from the review>"}
```

**Why.** The Worker builds the proposal again and writes it into the draft
only if it is still the one with that digest — exactly what you read. It is
all or nothing: if any part is refused, nothing is written. Users still see
no change.

**You should see** `"changed": true`, and `unreviewed` empty — or holding only
the markets listed under "Needs a decision".

**If not.** A `409` naming another digest means the proposal changed since you
read it — another release was deployed, or another draft is being read. Read
the review again. Applying the same digest twice is safe: it answers
`"changed": false`.

A `422` with `details.code` `OVERLAY_CREATION_BLOCK_WRONG` names a market
whose creation block, as the release proposes it, is not the block its Comet
was deployed in, and says how it is wrong; nothing is written. A developer
corrects it in the Comet's constants (`lib/well-known/contracts`), and the
release that carries the correction proposes it.

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
(step 1 with `{"forceNewAttempt": true, "holdForReview": true, "reason": "..."}`);
it keeps everything already reviewed, so steps 2 and 3 only change what was
wrong.

### 5. Compare with what the API uses today

```sh
curl -s "$API/registry/v1/admin/versions/$V/shadow" -H "Authorization: Bearer $TOKEN" \
  | jq '{onlyInStatic: .shadow.onlyInStatic, onlyInRegistry: .shadow.onlyInRegistry,
         disabledInRegistry: .shadow.disabledInRegistry,
         differences: [.shadow.differences[] | "\(.scope) \(.field)"]}'
```

Postman:

```http
GET {{API}}/registry/v1/admin/versions/{{V}}/shadow
Authorization: Bearer {{TOKEN}}
```

In the answer, look at `shadow.onlyInStatic`, `shadow.onlyInRegistry`,
`shadow.disabledInRegistry` and `shadow.differences` — each difference names
its `scope` and `field`.

**Why.** The last check before users see anything. It compares the draft
with the market list written into the API's code, which is what the API
served before the registry. That makes it the check for moving an environment
onto the registry: it shows that every market the API served comes across
with the same addresses and feeds, or says why not. It knows nothing about a
market the code does not describe.

**You should see** empty `onlyInStatic`, `onlyInRegistry` and
`disabledInRegistry`, and exactly the differences listed in
[Known differences](#known-differences). They are expected: the code is out
of date in those places, and the draft took the blockchain's answer.

`disabledInRegistry` names the markets the code serves and the draft switches
off. `agrees` does not count them and their fields are not compared, so a
market switched off by mistake shows here and nowhere else — its known
differences even drop out of the list. Each one must be a market you decided
not to serve.

**If not.** Anything else — a market missing on either side, a field not in
the list — **do not switch on.** Show the output to a developer.

### 6. Switch it on

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
users notice. It is recorded with your reason, and can be undone — see
[Switching back](#switching-back).

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
it is not empty. Take the first; never take a version listed below the one
that is on, which would switch the registry back to an older commit.

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

**Why.** This compares the draft with the version that is on — not with the
API's code — so it shows everything the new commit changes.

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

Steps 6 and 7 above for the version — validated first, if it was a held
draft — with `"expectedActiveVersionId"` in the body of step 6 naming the
version that is on: `comparedWith` in the answer of step 2. Step 5
(`shadow`) still compares with the API's code, and while that code exists it
is worth a look: a difference not in [Known differences](#known-differences)
on a market the code describes is the commit changing that market. It cannot
say anything about a market the code does not describe.

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
| `displayName` | The market's label on the website: `USDC`, `ETH` for a WETH market, `USDC.e` | Agree it with the frontend developer: the website builds its market key from it |
| `baseAsset.displayName` | The base asset's name on the website: `USD Coin`, `Ether`, `Tether` | The same |
| `slug` | The market's key in the website's links | `null`, unless another market of the network that is not switched off has the same label; then a unique lowercase key such as `usdc-institutional` |
| `isInstitutional` | Listed in the website's institutional section | Usually `false` |
| `contractName` | The Comet's name, shown in governance action titles | The Comet contract's `symbol()`, for example `cUSDTv3` |
| `status` | Whether the market is served | `enabled`; `disabled` keeps it off |
| `isDefault` | The market the website opens first | `false` — exactly one market in the whole registry is the default |
| `creationBlock` | Where the market's history and indexes start | The block the Comet proxy was deployed in (the explorer's "Contract Creation"). Must be above `0` for a market that is served. The write holds it against the chain — the Comet has code at that block and none at the block before it — and refuses one the chain contradicts with `422` `OVERLAY_CREATION_BLOCK_WRONG`, saying whether it is before the deployment, after it, or past the latest block |
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

Then steps 4, 6 and 7 of the first bring-up, and step 2 above for what the
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

Steps 4, 6 and 7 of the first bring-up. The market reports `success` from
the first request after the switch: the exception changes what its summaries
are cached under. So do the days of its history, a remapped collateral's
included: a day before its replacement was deployed is read from the feed
the Comet named that day, and only a day neither answers stays `partially`.

`GET /registry/v1/admin/status` does not report a market whose feed reverts:
alert on the `price feed reverted:` log line instead.

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
reported as one that could not be read (`partially`). And `/registry/v1/*`
serves the old facts, which a client that prices from the registry's feeds
would use.

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
status again and decide again.

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

The id is the version to go **back to**, which must have been validated. It
is the `previousVersionId` in the answer of the activation you are undoing,
and it is also in the activation history that
`GET /registry/v1/admin/versions/<the version that is on>` lists.

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
which version is on and who switched it on, whether its data is cached, when
the source was last checked, how the last import went, which drafts are
still open, and when the chain was last read again, and for which version
(`chainCheck`).

When `alerts` is not empty, each name says what to do:

| Alert | What it means | What to do |
|---|---|---|
| `configuration-invalid` | A registry setting of this environment is set to something it does not take; `configuration.invalid` names each. The import refuses to start while one of its own is invalid, and a read takes the default in its place | Correct the value in the environment's `[vars]` in `wrangler.toml` and deploy: the numbers are whole numbers, `COMET_SOURCE_REPOSITORY` is `owner/repository` and `COMET_SOURCE_REF` a branch, a tag or a commit |
| `no-active-version` | Nothing is switched on, so every market route answers `503` | Bring a version up — [Bringing an environment up for the first time](#bringing-an-environment-up-for-the-first-time) |
| `candidate-awaiting-review` | A draft is held for review and no import is running | Review it, then validate it (step 4 of [the first bring-up](#bringing-an-environment-up-for-the-first-time)) |
| `candidate-awaiting-activation` | A new commit was imported and validated, and is waiting to be switched on; `candidates.validated` names it | [When the source changes](#when-the-source-changes). The alert holds until a version at least that new is switched on: one you decide not to switch on keeps it raised until a newer commit's version is |
| `candidate-drops-markets` | A version waiting to be switched on would stop serving markets the version on serves; its `unserved` in `candidates.validated` names them, by their keys in the version on. Nothing holds it back | Step 2 of [When the source changes](#when-the-source-changes): `markets.unserved` says where each Comet went. Confirm every one with a developer before switching it on, and describe a renamed one under its new key first. The alert holds until a version at least that new is switched on |
| `commit-rejected` | The newest commit imported completely but did not validate, and the scheduled job will not import it again by itself; `sync.rejectedCommit` names it | Read why it failed (`GET /registry/v1/admin/versions/<versionId>`). If a decision was wrong, hold a new attempt (step 1 of [Describing a new market](#describing-a-new-market)), correct it there and validate; otherwise the alert clears when the source moves on |
| `chain-drift` | The version on stores a price feed or a collateral asset its market's Comet no longer answers with: governance changed the market on chain after the import, and the source did not move. `chainCheck.drifts` names each, with what the version stores and what the chain answers. Until a version that agrees is on, the summary at the latest block leaves out a collateral the Comet added ([A market that changed on chain](#a-market-that-changed-on-chain)) | [A market that changed on chain](#a-market-that-changed-on-chain): import the commit again with `forceNewAttempt`, check what it changes and switch it on. The alert clears once the next hourly invocation has checked the version on and found it agrees with the chain, within the hour of the switch |
| `last-sync-failed` | The last import ended `failed`. `sync.lastRun.lastError` says how: `validation failed` is a draft that failed a check, and `cancelled by <actor>: <reason>` a run somebody cancelled. A root that fails does not fail the run, and neither do the checks of a run held for review — the first import of an environment, or one with `holdForReview`: it completes, its draft left open | After `validation failed`, read the draft's checks: `GET /registry/v1/admin/versions/<sync.lastRun.registryVersionId>` lists them under `validation.checks`, failed first, with their `details`. If `all-roots-imported` is among them, the run gave roots up: `GET /registry/v1/admin/sync-runs/<sync.lastRun.id>` lists them with `status` `failed`, and why in each `lastError`. Fix that — most often the node provider proxy — and the scheduled job tries the commit again, or force a new attempt. Otherwise `commit-rejected` is raised as well: follow it. After a cancel, import again as `sync-stalled` says |
| `sync-failing` | The import that is running keeps failing: the last root it tried failed, or an invocation has failed since before trying one, and the roots left failed have spent two attempts or more between them — two roots once, or one root twice. A single failure does not raise it. `sync.lastRun.lastError` says why, once an invocation has recorded it | Read its run: `GET /registry/v1/admin/sync-runs/<id>` lists each root with why it failed and the `attempts` it has spent. `SOURCE_REQUEST_FAILED` and `CHAIN_REQUEST_FAILED` are GitHub or the node provider proxy not answering: fix the proxy, or wait for GitHub, and the next hourly invocation carries on. Until then an invocation that imports nothing spends an attempt of each root it tries, and a root is given up after five, whatever failed it. `the invocation importing this root did not finish` is an invocation stopped in the middle of that root — a deploy, or a Worker past its time or CPU: the next one tries it again, and if one market keeps stopping it, the worker's logs say what did. Until the next one records it, such a root is still `processing`, under a `leaseExpiresAt` already past, and the run's `lastError` is still that of the attempt before it — `null` if that one succeeded. `the database did not answer` is D1 failing under that root — restarted, overloaded or cut off. A restart or an overload spends the attempt all the same, and the next invocation tries the root again; if it keeps coming back, check the database's health. The worker's log line `registry root failed` has what D1 said, as it has the whole of a fault, which a root records as `an unexpected error interrupted the import`. Anything else is the root itself. A `lastError` that no root of the run carries — `OVERLAY_INVALID` naming a `version …`, or `an unexpected error interrupted the import` — is an invocation that failed before it tried a root: see `sync-stalled`, which the status raises as well once nothing has moved for two hours |
| `sync-stalled` | A run says it is running, but nobody is continuing it: the hourly trigger is not firing, or every invocation fails before it imports a market | Read why in `sync.lastRun.lastError`; where it is `null`, the worker's log line `registry sync failed` names the service that did not answer — GitHub, the node provider proxy or the database — and once it answers, the hourly import resumes the run by itself. A `lastError` that comes back the same every hour does not pass: cancel the run — `POST /registry/v1/admin/sync-runs/<sync.lastRun.id>/cancel` with `{"reason": "…"}` — fix what it names, then import again with `{"forceNewAttempt": true, "reason": "…"}` (step 1 of [the first bring-up](#bringing-an-environment-up-for-the-first-time)). That attempt is of the commit the tracked ref names now: if the source has moved on since the run started — the cancel's answer names the run's `sourceCommitSha` — it imports the newer commit and leaves the run's draft open. To keep what was reviewed on that draft, send the run's `sourceCommitSha` with `forceNewAttempt` instead; otherwise close the draft as the row on a draft of an older commit in [When something goes wrong](#when-something-goes-wrong) says. Cancelling does not help with two of them, which a new attempt meets the same way. `an unexpected error interrupted the import` is a fault, which the log has whole as `registry sync failed unexpectedly`: see `INTERNAL` in [When something goes wrong](#when-something-goes-wrong). `OVERLAY_INVALID` naming a `version …` is a decision that version stores, the one on or an earlier attempt of the commit, which this release no longer takes: a developer's to fix, in a release. Once either is fixed, the hourly import resumes the run by itself |
| `sync-overdue` | The source has not been checked for more than two days | The hourly trigger is not firing, or every invocation fails before it records a check: a failed one is a failed Cron in the dashboard's Cron events, and the worker's log line `registry sync failed` says why |
| `snapshot-not-cached` | The active version is not in the cache | Harmless by itself — the next request refills it. If it persists, the KV namespace is misconfigured for this environment |
| `cache-unreadable` | The KV namespace itself did not answer | Check the `kv_registry` binding of this environment: until it answers there is no cache, and no older version to fall back on if the database fails |

This is the request to point a monitor at: poll it every few minutes and
alert when `alerts` is not empty, or when the request itself fails.

## What the registry keeps

The registry never deletes a version. Every attempt at importing a commit
is a version with all its rows — about 1,500 for the source today, some 400
of them the results of one validation — and a version, its checks, its
overlay events and the activations are kept by the schema: triggers refuse
to delete them, and the rows of a version that has been decided cannot
change. A version is written only when the source has a new commit, or an
attempt at one is retried or forced, so the database grows with the
source's commits, which stays far below D1's limits for years. Keeping them
is what makes a rollback to any earlier version possible, and what keeps the
audit trail whole. A version names who asked for the import that created it
(`createdBy`): the operator for one an administrative sync created, whatever
the request asked for, and `registry-cron:<environment>` for one the hourly
job created — the same as its run's `requestedBy`.

The foreign keys from a version's snapshot rows and checks to it say
`ON DELETE CASCADE`, but no cascade ever runs while those triggers refuse the
delete; its overlay events and activations say `RESTRICT`. The cascades are
there for a retention job that does not exist yet: one that removes old
versions has to replace those triggers in a migration of its own, keep the
active version and the ones a rollback may still need, and keep the audit
rows of every version it removes elsewhere.

## Known differences

What `shadow` reports for a registry bootstrapped from
`Compound-Foundation/comet@a34d9b571c83`. Each is a place where the market
list in the API's code is out of date, and the registry has the blockchain's
answer.

| Difference | Why it is expected |
|---|---|
| `1/institutional_usdc rewards.asset`, `rewards.contract`, `rewards.priceFeed` | The market has no rewards configured on chain; the code declares COMP rewards for it as a placeholder |
| `2020/weth` and `2020/wron` `rewards.asset`, `rewards.priceFeed` | No rewards are configured on Ronin; the code declares placeholders |
| `534352/usdc rewards.priceFeed` | Scroll has no COMP price feed; the code points at the market's own base feed |
| `1/wbtc baseAsset.priceFeed`, `baseAsset.usdPriceFeed` | The market prices in BTC through its own WBTC/BTC feed; the code flattens it onto BTC/USD |
| `8453/aero baseAsset.priceFeed`, `baseAsset.usdPriceFeed` | The market's feed already answers AERO / USD; the code gives it the USDC feed |
| `42161/usdc`, `42161/usdt`, `8453/usdc` `baseAsset.priceFeed` | These markets moved to newer (SVR) price feeds; the code has the old ones |
| `5000/usde baseAsset.priceFeed`, `baseAsset.priceFeedDecimals` | The market reads a USDe / USD feed with 8 decimals; the code has another USDe / USD feed with 18 |
| `137/usdt`, `42161/usdt` `baseAsset.symbol` | Tether renamed USDT to USDT0 and USD₮0 on these chains |
| `42161/usdc.e baseAsset.symbol` | Bridged USDC calls itself USDC on chain; the code calls it USDC.e |

A newer commit, or a change to the code's market list, can change this list.
A difference not in it is worth a developer's look before switching on.

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
| `400`, `details.code` `OVERLAY_INVALID`, from the import or an overlay route, with a message that begins `version <id> market` or `version <id> network` — or, from `GET …/markets/<chainId>/<deploymentKey>/overlay`, with the market's key, such as `1/weth.displayName` | A decision a version stores that this release no longer takes. From the import, the version is the one on or an earlier attempt of the commit: every import fails on it before it imports a market, and spends nothing; `/admin/status` has it as `sync.lastRun.lastError`, and raises `sync-stalled` once nothing has moved for two hours. From an overlay route, it is the draft's own: every overlay write to the draft — `PUT …/overlay`, `PUT …/overlays`, applying the proposal — reads all of its decisions first and is refused, the one that would replace that decision too, and so is the `GET` of the network or market that holds it | Report it to a developer with the message: a release that reads the decision again fixes it. The import then carries on by itself; cancelling the run does not help before that, since a new attempt reads the same decision. A draft the overlay routes refuse cannot be reviewed until then: leave it open, and do not validate it or switch it on — validation does not read the decisions again, and a version on that holds such a decision stops every import |
| Linea WETH's reward price is about `0.009` (`reward_asset.price` in the rewards routes) | The environment was brought up before its proposal quoted the COMP / ETH reward feed in the base asset, and every later version inherited `"quote": "usd"` | Hold a draft (`{"forceNewAttempt": true, "holdForReview": true, "reason": "quote Linea WETH's reward feed in its base asset"}`), read `…/versions/$V/markets/59144/weth/overlay`, send it back with `rewardPriceFeed.quote` `"base"`, then validate and switch it on (steps 4, 6 and 7 of the first bring-up) |
| `CHAIN_REQUEST_FAILED` in the import | The worker cannot reach the node provider proxy, or the proxy did not serve the calls, or did not answer them within 30 seconds. The worker's log line `registry root failed` has the status the proxy answered and its URL without the key: `HTTP 503` is no provider answering the proxy, `HTTP 401` the proxy refusing `NODE_PROXY_KEY` | Fix the proxy, its binding or its key; importing again continues where it stopped |
| A network under `chainCheck.unreadable` in `/admin/status` | The check of the chain could not read that network, for the reason it names — most often `CHAIN_REQUEST_FAILED`, as in the row above. Nothing new is known about its markets: it raises no `chain-drift` of its own and clears none, since a drift found there before stays, with the `seenAt` of the last read that found it. The warning `registry chain not read` in the worker's log has the cause | Fix the proxy for that network. The check reads it again at the next hourly invocation, until it has read every network |
| `chain-drift` in `/admin/status` | The chain answers a market's feed or collateral otherwise than the version on stores it | [A market that changed on chain](#a-market-that-changed-on-chain) |
| `422`, `details.code` `OVERLAY_CREATION_BLOCK_WRONG`, writing an overlay or applying the proposal | A `creationBlock` the document changes is not the block the market's Comet was deployed in; the message says whether it is before the deployment, after it, or past the latest block. Nothing was written | Send the block the chain's explorer gives as the Comet's "Contract Creation" (step 4 of [Describing a new market](#describing-a-new-market)). From the proposal, the release's own constant is wrong: see step 3 of [the first bring-up](#bringing-an-environment-up-for-the-first-time) |
| `401` | The token is wrong, or is the hash | Use the admin token itself |
| `413` | The request body is larger than the route takes | Send less: a directory of overlays in several requests |
| `429`, "too many administrative requests from this address" | More than 60 administrative requests in a minute from your address — over IPv6, from your /64 — whatever they were: every request under `/registry/v1/admin/` is counted by address before its token is checked, a wrong token or a path no route takes included, and the right token is refused too once the address has spent its budget | Wait the seconds its `Retry-After` names — a minute at most. A script in a loop, or a monitor sharing your address, is what spends it |
| `429`, "too many … requests with this token" | More than 30 administrative requests in a minute with your token, counted per family of routes. Reads count too, and every read shares one budget — a monitor polling `/admin/status` with your token spends it with you — while each kind of command has its own | Wait the seconds its `Retry-After` names. The environment has one token, so a monitor polls the status every few minutes, not in a loop |
| `422`, `details.code` `OVERLAY_FEED_UNREADABLE`, writing an overlay | A feed the overlay names does not answer its decimals on that chain: it reverts, or nothing is deployed at that address there — most often a feed of another chain | Check the address against the chain's feed; a `503` instead is the node provider not answering, and worth trying again |
| `409` writing overlays, "… registry version cannot be changed" or "is no longer importing" | The draft is no longer open: it was validated, switched on, or replaced by a newer attempt of its commit (`GET /registry/v1/admin/versions/<id>` says which) | Look for the newest open draft first (`GET /registry/v1/admin/versions?status=importing`) and continue there; start a new attempt (step 1 with `forceNewAttempt`) only if there is none |
| `409` on apply, naming another digest | The proposal changed since you read it | Read the review again, and apply its digest |
| `409` on validate, "the import … is still running" | The import has not finished | Send step 1 again until it completes |
| `409` on validate, "the candidate changed while it was being validated" | An overlay was written to the draft while it was being checked, so the checks no longer described it and none was kept | Validate it again |
| `409` writing an overlay, "is no longer the one this was decided against" or "changed while this overlay was being written" | Somebody changed the draft between your read and your write | Read the overlay again — `GET …/markets/<chainId>/<deploymentKey>/overlay` or `GET …/networks/<chainId>/overlay`, whose answer has its `digest` — redo your change on it, and send it with that digest as `expectedDigest`, or under the document's key in `expectedDigests` of a `PUT …/overlays` |
| `409` writing an overlay, "already has that slug", "is already the default" or "cannot carry a reward price feed" | The document conflicts with the rest of the draft: another market of the network keeps that slug, another market is the default, or the market's rewards contract names no reward token. The draft is open, and nothing was written | Change the document, not the draft. Choose another slug, or move it with both markets in one `PUT …/overlays`; move the default the same way, both markets in one request. Read both first, and send each one's `digest` under its key in `expectedDigests` (`{"1/usdc": "<digest>", "1/weth": "<digest>"}`), so a change made to either since is not undone. A market without a reward token takes `"rewardPriceFeed": null` and both rewards capabilities `false` |
| `409` on activate or rollback, "the active version is …" | Somebody switched another version on after you looked | Read the status again and decide again |
| `409` on the proposal, its review or apply, "the proposal is for its first version only" | A version of this environment has been switched on, and the decisions live in the registry: the proposal would undo what was reviewed since | Review the draft with the overlay routes — [Describing a new market](#describing-a-new-market) |
| A version is `invalid` with the failed check `served-network-reviewed` | It serves a market of a network nobody has described — a chain no version had before | An `invalid` version can no longer be changed. Hold a new attempt (step 1 of [Describing a new market](#describing-a-new-market)), which keeps what was reviewed in this one; describe the network there (step 5), then validate it and switch it on (steps 4, 6 and 7 of the first bring-up) |
| A root failed with `OVERLAY_INVALID`, "is the default market by the decisions it inherits, but … already is the default" | The draft holds another default than the one its import inherits: the draft's default was moved to a market it holds before the import reached the market that opened by default, or a version that names another default was switched on while the import was running | If the draft's default was moved, the draft is still importing, and the root has attempts left (`attempts` below five in `GET /registry/v1/admin/sync-runs/<id>`): move the default back, import the rest, then move the default with both markets in one `PUT …/overlays`, with their digests under `expectedDigests` as in the row on a slug above. Otherwise continue the import until it ends — each request spends one of the root's five attempts — and hold a new attempt (step 1 of [Describing a new market](#describing-a-new-market)): it inherits the default the draft moved, or the one switched on, and imports both markets |
| `idle` from import, "attempt … of this commit imported every root and is invalid" | The commit was imported completely and did not validate; another attempt would fail the same way, so the scheduled job does not make one | Read why it failed (`GET /registry/v1/admin/versions/<registryVersionId>`). Correct the decisions in a held attempt (step 1 of [Describing a new market](#describing-a-new-market)) and validate it, or wait for a new commit |
| `idle` from import, "attempt … did not import every root; it is tried again after …" | Roots of the last attempt did not import — a chain that did not answer, or contracts the source names before they are deployed | Nothing: the scheduled job tries again then. To try now, force a new attempt |
| `idle` from import, "a candidate of this commit is held for review" | A draft of this commit is already waiting for you | Use that draft — its id is in the answer — or force a new attempt. The new attempt closes that draft only once it succeeds; if it fails, the draft is still there to validate |
| `idle` from import, "upstream was checked recently", with no `registryVersionId` | The source was checked less than a day ago and nothing is importing, so the request had nothing to do and names no draft | On a first bring-up the hourly job has finished the import and held its draft: it is under `candidates.importing` in `GET /registry/v1/admin/status`, and has every market only if `sync.lastRun` there has `completedCount` equal to `expectedCount`; if not, fix why the job gave markets up and start a new attempt ([If the hourly job got there first](#1-import--take-a-snapshot-of-the-source)). Later, see [Find the new version](#1-find-the-new-version) |
| A version is `invalid` with the failed check `superseded-by-newer-attempt` | A newer attempt of the same commit succeeded and replaced this draft; its `details` name which | Work on that attempt. Reviews made on this draft before the replacement was imported are in it; anything reviewed here afterwards is not — redo it on the newest draft (`GET /registry/v1/admin/versions?status=importing`) |
| `/admin/status` keeps listing a draft of an older commit | The source moved to a newer commit while that draft was open; drafts are only replaced by attempts of their own commit, because reviews do not carry across commits | Finish it (validate it — that also closes it), or, if the newer commit's version has taken its place, validate it anyway to close it |
| `409 CONFLICT`, `details.code` `SYNC_ALREADY_RUNNING` | An import is in progress — the hourly one, a request you already sent, or one you are asking to change with `forceNewAttempt`, `holdForReview` or `sourceCommitSha`. Such a request that failed, with a `503` say, may have started its run first: sent again as it was, it is refused. "another invocation is importing right now" means an invocation holds the run this very moment. A request that failed gave it back as it failed, unless the database was still not answering then (`registry lease not released` in the worker's log); that one, like one stopped without an answer — by a deploy, or past the time or CPU a Worker is given — holds it until its lease runs out, at most 15 minutes | Continue it with an empty body until it says `completed`, sending it again a little later while another invocation is importing; only then ask for a new attempt. A run that every request fails on the same way never says `completed`: cancel it, as `sync-stalled` in [Keeping an eye on it](#keeping-an-eye-on-it) says |
| A market reports `"status": "partially"` or `"status": "error"` | A price feed it reads reverts, usually one Chainlink retired | [A market that stopped answering](#a-market-that-stopped-answering) |
| Answers carry `X-Registry-Stale: <seconds>`, and the log has the error `registry database unreachable; answering from the version it last named` | The database could not be reached, so the API is answering from the version it last saw, and saying how old it is. Each isolate logs the error once a minute while this lasts | Check the database's health; the API recovers by itself once D1 answers, and starts returning `503` if the outage outlasts the configured window |
| `503 UPSTREAM_UNAVAILABLE` from the market and registry routes, or from `/admin/status` | The database could not be reached, and there is no version within the window to answer from. Or, from a route that reads the chain — the market and account routes, transaction history, governance — the node provider proxy did not serve the request: no provider answered it, the worker could not reach the proxy or lost its answer, or the proxy answered a call with an error that is not a revert. Such an answer says `a node provider did not answer`, with the proxy's `Retry-After` when it sent one; the worker's log line `route failed` with the answer's `requestId` has the error — `HTTP 401` in it is the proxy refusing `NODE_PROXY_KEY` — and the proxy's own log has `upstream error` or `json-rpc error` | Check the database's health; nothing in the registry needs changing. For a node provider, fix the proxy, its binding or its key: the routes answer again as soon as it serves them |
| `500 INTERNAL` from the market and registry routes | The database answered with a fault — most often a release deployed before its migrations — or a bug, such as a call the contract reverted where the route needed its value. A node provider that did not answer is a `503`, not this. The worker's log line `route failed` or `registry route failed` with the answer's `requestId` has the error | Apply the migrations if they are missing; otherwise report the log line |
| A market reports `"status": "error"` with the message `creationBlock … is past the latest block, …`, and the log has the warning `creation block not reached` naming its Comet | The active version holds a creation block the market's chain has not reached — one no overlay write checked, such as one an import inherited. None of the market's values can be read, so the market routes and `/account/{address}/rewards` answer it as `error`, and the other markets as usual. This stops by itself once the chain reaches the block, but the market's history then repeats the day of that block for every day before it | Switch back, or give the market the block its Comet was deployed in, as step 7 of [the first bring-up](#7-check-that-it-is-on) says — after the error has stopped by itself too |
| The worker's log has the warning `computation cache unreadable` or `computation cache unwritable`, with what KV answered | KV refused a call to the namespace computed values are cached in, `kv_mainnet` or `kv_testnet`: `429` is a value written twice in a second, `503` KV not answering. The request was answered without the cache — a value it could not read was computed again from the chain, and one it could not write was not kept — so it was slower, and asked the node provider more. Each isolate says each once a minute while it lasts | Nothing for a `429` now and then. A `503` that keeps coming back is KV not answering: every request reads the chain while it lasts, and transaction history fails (the next row), so check Cloudflare's status and the node provider proxy |
| `500 INTERNAL` from transaction history, and the log line `route failed` has `KV GET failed` or `KV PUT failed` | KV refused a history cursor. Cursors are kept in `kv_mainnet` with the computed values, but nothing computes one again: a page whose cursor KV cannot read fails, and so does a page whose cursor it cannot keep, rather than hand out a cursor no later page could read. A first page fails so only after it has been read in full from the chain, since its cursor is written last. While KV does not answer, every page of history fails, though the other routes answer | Check Cloudflare's status; nothing in the registry needs changing. The client may ask again, and history answers as soon as KV does |
| The worker's log has the warning `history cursor written twice in a second`, with KV's `429` | Two pages asked within a second kept the same cursor — the same page asked twice, or the first pages of two accounts without history at one block: a cursor's id is the digest of what it holds, and names no account. KV takes one write a second to a key, so it refused the second write of a cursor it had just taken, and the page was answered with it | Nothing |
