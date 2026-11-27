# Comet registry runbook

For the person who brings the market registry up in an environment, or
switches it to a newer list of markets. You do not need to know how the
registry works inside; every step says what it is for, what to run, what you
should see, and what to do when you see something else.

The design behind it is in [README.md](./README.md#the-comet-market-registry),
and every route in [API.md](./API.md#registry-v1).

## The idea

The registry is the list of markets the API serves under `/registry/v1` —
their addresses, tokens, prices, names, and which features each one has. A
new list is never edited in place. It is built as a **draft** (a "candidate
version"), checked, **approved** by one person, and only then **switched on**
("activated") by another. Until the switch, users see no change at all, and
after it, one command switches back.

## Before you start

The commands are for a POSIX shell, zsh or bash, on macOS or Linux; on
Windows, run them in WSL. Everything here works on one environment at a
time, which you choose once, before anything else: set `ENVIRONMENT` to the
environment's name in `wrangler.toml`, as `export ENVIRONMENT=production`
does for production. Nothing in this runbook sets it again: every command
below that reaches an environment takes it, and stops while it is not set.

Log in to Cloudflare in the checkout's `c3-api`, with its dependencies
installed ([Getting Started](./README.md#getting-started)), after the
address read, which needs no login and stops while one of the variables
below points Wrangler elsewhere:
`npx tsc -p tsconfig.scripts.json && node dist/scripts/environment-address.js > /dev/null && npx wrangler login`,
which may do everything this runbook does. Or set a `CLOUDFLARE_API_TOKEN`
that may read Workers KV, the environment's zone and its Workers routes
(Zone Read and Workers Routes Read), and edit Workers scripts. Then read the
environment's address, `API`, in `c3-api`:

```sh
unset API; npx tsc -p tsconfig.scripts.json && node dist/scripts/environment-routing.js && API="$(node dist/scripts/environment-address.js)" && export API && echo "API=$API"
```

It prints the https address of the environment's custom domain once it has
checked how Cloudflare routes it, or stops, leaving `API` empty, so that no
token goes there:

- while `ENVIRONMENT` names no environment deployed to one custom domain of
  its own. That is the one address `wrangler.toml` gives: Cloudflare creates
  the custom domain's DNS record, which points to the Worker, and its
  certificate. A route of a zone is no such address: it runs the Worker only
  for the requests the zone's DNS sends through Cloudflare, and a route
  written with `http://` only for plain http;
- while Cloudflare routes the domain otherwise, which `wrangler.toml` cannot
  show. The check reads, with your login, the zone of the host, whose account
  must hold the environment's `kv_mainnet`, the Worker the custom domain is
  attached to, which must be the environment's, and the zone's Workers
  routes, of which none may run another Worker on the host: a route runs
  before a custom domain, and would take every request, its token too. One
  that a more specific route without a Worker would negate is refused all
  the same, since Cloudflare lists exceptions to its route specificity among
  its known issues: no route of another Worker may cover the host. A login
  that may not read the zone or its routes stops the check at
  `no active zone that this login reads …`, or at a `403` for the routes;
- while this machine's clock is more than an hour from Cloudflare's, which
  its answers carry: step 4 counts a rotation's 30 days by it;
- while a variable that points Wrangler elsewhere than Cloudflare's own API
  is set, in the shell or in a `.env` file of `c3-api` that Wrangler reads
  for the environment (`.env`, `.env.local`, `.env.<environment>` and
  `.env.<environment>.local`): `CLOUDFLARE_API_BASE_URL` or its old name
  `CF_API_BASE_URL`, `WRANGLER_API_ENVIRONMENT`, `CLOUDFLARE_COMPLIANCE_REGION`,
  or the login's `WRANGLER_AUTH_DOMAIN`, `WRANGLER_AUTH_URL`,
  `WRANGLER_TOKEN_URL` and `WRANGLER_REVOKE_URL`. With one of the first
  four, Wrangler can send its requests there, your login and the secrets
  the commands below put among them, and with one of the login's, your
  login, while the check reads Cloudflare's own API. Unset it, or remove it
  from the file. `DOTENV_KEY` too, with which Wrangler reads each of those
  files from the encrypted `.vault` beside it, such as `.env.vault`, where
  the check cannot look. The
  address read alone stops on all of them, which is why it comes before
  the login.

For a worker you run on your own machine, such as the preflight's, `API` is
`http://localhost:8787` instead, which the check passes without reading
anything: the token does not leave the machine.

Wrangler puts or deletes a secret in the Worker `wrangler.toml` names for the
environment, in the account it uses: the one `CLOUDFLARE_ACCOUNT_ID` names,
in the shell or in a `.env` file of `c3-api`, which Wrangler reads too
(`wrangler.toml` sets no `account_id`, which would come first), else the one
it remembers from an earlier run in this checkout, in
`node_modules/.cache/wrangler`, else the only one you can reach, and through
the API it uses, another than Cloudflare's own while one of the variables
above points it elsewhere. So every command below that puts or deletes a
secret first reads the environment's address, in the same command,
`node dist/scripts/environment-address.js > /dev/null`, which stops while
one of them is set and needs neither a login nor a deploy, and then checks
the account: it lists the keys of the environment's `kv_mainnet` that start
with
`account-check`, of which there are none, by the namespace id `wrangler.toml`
gives it, with
`npx wrangler kv key list --binding kv_mainnet --env "$ENVIRONMENT" --remote --prefix account-check`.
That id pins the account: only the environment's account holds the
namespace, which its deployed Worker already reads, so in any other account
the list fails, and the command stops before it writes. Read the address and
check the account the same way, in the same command, before you create the
environment's database or namespaces, as `wrangler.toml` asks. The
migrations need no account check: they write to the environment's database
by its id, which no other account holds. They read the address first all
the same, since one of the variables above would send them, and your login,
elsewhere.

The account check never asks, so it also stops while you can reach several
accounts and none is chosen, and while you are not logged in.
`Authentication error [code: 10000]` is a login or token that cannot read
the environment's account. When it stops for another account, run
`export CLOUDFLARE_ACCOUNT_ID=<its account ID>` with the account the
environment runs in, one of those `npx wrangler whoami` lists, and run the
whole command again: set for the check alone, it would not reach the
commands after it.

- The environment's database has every migration applied, and this happened
  **before** the worker release that needs it:
  `npx tsc -p tsconfig.scripts.json && node dist/scripts/environment-address.js > /dev/null && npm run "d1:migrate:$ENVIRONMENT"`.
- The worker is deployed, and it reaches the node provider proxy.
- The environment has admin tokens, and you hold one of your own with the
  role `admin` — the token itself, not its hash. See
  [The admin tokens](#the-admin-tokens) if the environment has none yet, or
  none for you.
- A second person with an `admin` token of their own approves what you switch
  on (step 5 of the bring-up). Each of their requests runs the routing check
  too, so they also need a checkout and a `CLOUDFLARE_API_TOKEN` with which
  it passes. Give them one that may only read — Zone Read, Workers Routes
  Read, Workers Scripts Read and Workers KV Storage Read: a login, or a token
  that may edit Workers scripts, could put the environment's secrets, its
  list of admin tokens among them, and so give one person two names. As
  [The admin tokens](#the-admin-tokens) says, whoever can put that secret
  can make a token of any name, so the rule holds only against those who
  cannot put it. A version is switched on by two people, and two tokens of
  one name are one person. So the environment's list names two admins at
  least before the release with approvals reaches it
  ([The admin tokens](#the-admin-tokens)); with one, nobody there can switch
  a version on.
- The release with approvals is deployed to all of the environment's traffic
  at once, never beside the release before it in a gradual deployment, and
  every Worker bound to the environment's database runs it before anyone
  approves there — a second Worker of another branch on the same database
  too. Once an approval exists, the database refuses an older release's
  activations, and its rollbacks but the one step back, which then answer
  `500`: from then on a bad release is fixed by rolling forward, never by
  deploying an older one again. Until then, an older release still switches
  versions on without an approval. Its migrations, `0011` and `0012`, are
  applied before it, as every migration is.
- The environment has `COMET_GITHUB_TOKEN` set. Without a token GitHub
  allows the import 60 API requests an hour per address, which the Worker
  shares with every other Worker leaving Cloudflare through it, and an import
  fails with `SOURCE_REQUEST_FAILED`, "its rate limit is used up". A
  fine-grained GitHub token with read-only access to public repositories, and
  no other permission, is enough; Wrangler prompts for it once the account
  is checked, run in `c3-api`:

  ```sh
  npx tsc -p tsconfig.scripts.json && node dist/scripts/environment-address.js > /dev/null \
    && npx wrangler kv key list --binding kv_mainnet --env "${ENVIRONMENT:?export it first}" --remote --prefix account-check > /dev/null \
    && npx wrangler secret put COMET_GITHUB_TOKEN --env "$ENVIRONMENT"
  ```

- [The preflight](#the-preflight) has passed on the commit being deployed.

Nothing of the bring-up runs on your machine but the requests and the
address read above: the Worker being deployed imports the source, and checks
the decisions you send it against the source and the chain. Those decisions
are the seed of the commit being deployed,
[`c3-api/registry/seed/production.json`](./registry/seed/README.md), so send
the requests to `API` from the root of a checkout of that commit, with `jq`
installed, after setting your token:

```sh
export TOKEN='<your admin token>'
```

Once the environment lists your token, the status names the environment that
answers at `API`, which must be `$ENVIRONMENT`; any other answer is one step 5
of [The admin tokens](#the-admin-tokens) explains. Read it in `c3-api`, the
routing checked again right before it, as every request that carries a
token is: a route can change between one command and the next, and the
check stops the request when it has:

```sh
API="$API" node dist/scripts/environment-routing.js && curl --disable -sS --noproxy localhost,127.0.0.1,::1 "$API/registry/v1/admin/status" -H "Authorization: Bearer $TOKEN" | jq -r '.environment // .error.code'
```

Every command below that sends your token runs the same check first, in
the same command: from the root of the checkout,
`(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable …`,
and in step 5 of [The admin tokens](#the-admin-tokens), which runs in
`c3-api`, `API="$API" node dist/scripts/environment-routing.js && curl --disable …`.
Send every request that carries your token this way, those this runbook
names only in prose too. A route that has moved since, while you waited for
an import or after a deploy, stops the command before the token goes out,
and running it again checks again. `API="$API"` hands the check the address
`curl` uses, exported or not. A worker on your own machine passes the check
at once. These commands also pass `--disable` first, so that curl reads no
`.curlrc`, whose `url` or `header` lines would send the request, the token
with it, somewhere the check never looked, and `--noproxy` for the loopback
addresses, so no proxy set for plain http sees a token sent to such a worker.

Run every other `npm run`, `npx` and `node` command in the checkout's `c3-api`,
which holds the Worker's configuration and the Wrangler it is built with:
from the root, npm finds no such script, and Wrangler no Worker.

Every step shows the terminal command, and beside it the same request for
Postman, written as the request itself: the method and URL on the first line,
then the headers, then the body. Postman is for a worker you run on your own
machine alone. It runs no routing check, and nothing ties a check run in a
terminal to the request it then sends, so send a token to a deployed
environment from the terminal only, where every command runs the check first,
in the same command. To use them:

- Create a Postman environment with the variables `API`,
  `http://localhost:8787`; `TOKEN`, the admin token your worker's list in
  `.dev.vars` takes, as its current value alone, its initial value left empty,
  since Postman shares an initial value with your team along with the
  environment; and `V`, the draft's id, filled in step 1. Send from the
  Postman desktop app, or on the web through the Desktop Agent: the Cloud
  Agent sends each request from Postman's servers, which do not reach your
  machine. Add `localhost`, `127.0.0.1` and `::1` to the proxy bypass of
  **Settings → Proxy**, or turn the proxy off, so the token in plain http goes
  to no proxy.
- Send every administrative request with `Authorization: Bearer {{TOKEN}}` —
  or set **Authorization → Bearer Token → `{{TOKEN}}`** once on the collection
  and let the requests inherit it.
- A body is **Body → raw → JSON**. Postman then adds
  `Content-Type: application/json` itself.
- Postman shows the whole answer; each step says which fields to look at.

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
| `reader` | every `GET` under `/admin` | someone who reads drafts and versions |
| `operator` | besides, imports, cancelling a run, and overlay writes | someone who reviews drafts |
| `admin` | besides, validate, approve, activate and rollback | someone who decides what is served |

An import not held for review validates its draft by itself once it
completes, so an `operator` can import a version that validates; switching
it on takes two `admin`s of two names, one who approves it and another who
activates it. So an environment needs two people with the role `admin`, each
holding a token of their own, and one person never holds two names: the
names are what the registry tells people apart by.

The worker keeps only the SHA-256 of each token: what is configured cannot
be used as a token. Tokens go to their holders through the team's password
manager, and their hashes — never the tokens — into the environment, as one
secret: the list `COMET_REGISTRY_ADMIN_TOKENS`. Whoever can put that secret
can make a token of any name and role, so leave it to the environment's
owner. Each environment has tokens and a list of its own: a token is made
for one environment and listed in no other.

The steps below work on the environment `ENVIRONMENT` names, as
[Before you start](#before-you-start) sets it; set it there first if you came
here directly. The environment's list is the file
`~/tokens.$ENVIRONMENT.json`. Step 4 puts it with `--env "$ENVIRONMENT"`, and
reads the environment's address into `API` again, where step 5 checks the
token.

A worker you run on your own machine, such as the preflight's, takes its
list from `.dev.vars` instead. Make its token and write its list as steps 1
to 3 say, as `~/tokens.local.json`, the entries of each new token's holder
checked with the command step 3 gives for it; put it into `.dev.vars` as the
end of step 4 says, never with Wrangler, before the worker starts; and check
it as step 5 says, after `export API=http://localhost:8787`, where the
status names `local`.

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

**3. Write the list**, `~/tokens.$ENVIRONMENT.json`, with an entry for each
token. Keep it outside the checkout, where git would not ignore it:

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
  only while their holder rotates a token, and then the token it replaces has
  a `notAfter` within 30 days: step 4 refuses a list with two tokens of one
  name that both last longer, which would leave the old one taken for good,
  and the worker one past 31 days, a day more by its own clock, so that a
  clock a little off never has it refuse a list step 4 put.
- `sha256` — the hash from step 2. A token is listed once.
- `role` — `monitor`, `reader`, `operator` or `admin`.
- `notAfter` — `null`, or the last instant the token is taken at, in UTC,
  such as `2027-05-01T00:00:00Z`.

Cloudflare stores a secret of at most 5 KB, which is about thirty entries,
so drop the entries of expired tokens whenever you put the list again. It
never shows a secret again either: keep the file, which holds hashes and no
token, where the next change will start from, such as the password manager.
Each environment's list has one owner, and each change starts from that file
as the last put left it, one change at a time: step 4 replaces the secret
whole, so a list made from an older copy would put back a token dropped
since.

Check the entry the file gives each new token, and in a rotation its
holder's other entry, before you put the list:
the worker records every change under that name, and allows what that role
allows, so a hash in the entry of another holder of the same role would
pass every check below, and the worker would record that holder's name.
With the token in `NEW_TOKEN`, this prints every entry of its holder, its
own marked `"new":true`:

```sh
: "${NEW_TOKEN:?make it first, as step 1 does}" && jq -c --arg sha "$(printf '%s' "$NEW_TOKEN" | shasum -a 256 | cut -d ' ' -f 1)" '[.[] | select((.sha256 | strings | ascii_downcase) == $sha) | .name] as $holders | [.[] | select(.name as $n | any($holders[]; . == $n)) | {name, role, notAfter, new: (((.sha256 | strings | ascii_downcase) == $sha) // false)}]' "$HOME/tokens.${ENVIRONMENT:?export it first}.json"
```

On Linux `sha256sum` takes the place of `shasum -a 256`, as in step 2.
There must be one entry marked `"new":true`, with its holder's name and
role, and the `notAfter` you meant: `null`, or the instant the token is to
stop being taken. For a new holder it is the only entry: one marked
`"new":false` is someone else's, whose name the new entry took. In a
rotation there is one more, `"new":false`, the token being replaced, which
must have the cutoff you gave it, a few days ahead, never `null`; a rotation
that prints no such entry has lost the old entry, or has the new one under
another name than the old one's. Any further `"new":false` entry is an older
token of the holder's, which must have a cutoff too, and goes once that has
passed. `[]` is a token the file does not list, or one hashed with `echo`;
two entries marked `"new":true`, or another name, role or `notAfter`, a hash
in the wrong entry. Correct the file and check again. For a worker you run
on your own machine, check its list, `~/tokens.local.json`:

```sh
: "${NEW_TOKEN:?make it first, as step 1 does}" && jq -c --arg sha "$(printf '%s' "$NEW_TOKEN" | shasum -a 256 | cut -d ' ' -f 1)" '[.[] | select((.sha256 | strings | ascii_downcase) == $sha) | .name] as $holders | [.[] | select(.name as $n | any($holders[]; . == $n)) | {name, role, notAfter, new: (((.sha256 | strings | ascii_downcase) == $sha) // false)}]' "$HOME/tokens.local.json"
```

**4. Put the list into the environment**, from `c3-api`. The command builds
the scripts it runs, and reads the environment's address into `API` again,
its routing checked first, as [Before you start](#before-you-start) does,
and prints it: step 5 checks the token there. A list the worker cannot read
closes the administrative API to every token, the owner's too, so it then
reads the file exactly as the worker will read the secret, with the worker's
own code (`scripts/admin-tokens.ts`), and puts nothing the worker would
refuse. It then checks the account Wrangler uses, as
[Before you start](#before-you-start) says, and makes sure the environment's
Worker exists in it: put into a Worker that is not there, Wrangler creates
one by that name, without asking when it reads from a pipe. Wrangler reads
the secret from the pipe, and it takes effect without a deploy:

```sh
unset API; npx tsc -p tsconfig.scripts.json \
  && node dist/scripts/environment-routing.js \
  && API="$(node dist/scripts/environment-address.js)" && export API && echo "API=$API" \
  && LIST="$(node dist/scripts/admin-tokens.js "$HOME/tokens.${ENVIRONMENT:?export it first}.json")" \
  && npx wrangler kv key list --binding kv_mainnet --env "$ENVIRONMENT" --remote --prefix account-check > /dev/null \
  && npx wrangler secret list --env "$ENVIRONMENT" > /dev/null \
  && printf '%s\n' "$LIST" | npx wrangler secret put COMET_REGISTRY_ADMIN_TOKENS --env "$ENVIRONMENT"
```

Wherever the address read of [Before you start](#before-you-start) would
stop, the command stops too, and puts nothing, leaving `API` empty.

When the worker would refuse the list, the check prints what the worker
would log, such as `COMET_REGISTRY_ADMIN_TOKENS[1].sha256 must be 64 hex
digits` for a hash not yet filled in, or `COMET_REGISTRY_ADMIN_TOKENS[0]
names notAfter twice` for a field written twice, which JSON alone would read
by its last value, or `… are two tokens of … that last more than 30 days`
for a rotation in which neither token stops within 30 days.
`cannot read …` is a file that is not there, and `… is empty` an empty one.
An error from `kv key list` is the account check stopping, for one of the
reasons [Before you start](#before-you-start) gives, and
`Worker "…" (env: …) not found` an environment whose Worker is not deployed
yet. In each case nothing is put: correct it and run the command again. A
list of no token, `[]`, is put, with a word that it closes the
administrative API to every request.

For a worker you run on your own machine, write its list as
`~/tokens.local.json` and run the check alone, from `c3-api`:

```sh
npx tsc -p tsconfig.scripts.json && node dist/scripts/admin-tokens.js "$HOME/tokens.local.json"
```

and put the line it prints into `.dev.vars`, which git ignores, in single
quotes — with two `admin` tokens of your own under two names, since a
version is switched on by two:

```
COMET_REGISTRY_ADMIN_TOKENS='[{"name":"local-admin","sha256":"<the hash from step 2>","role":"admin","notAfter":null},{"name":"local-approver","sha256":"<the hash of a second token>","role":"admin","notAfter":null}]'
```

**5. Check each token** with two requests that change nothing. The first is
a validation of a version that does not exist, with a body the worker
refuses, `[]` in place of an object: the role is checked before the body is
read, so the answer says whether the token is taken, and with which role.
The second reads the status, which names the environment that takes the
token at `API`. Each goes out, from `c3-api`, only once the routing of `API`
is checked again right before it, the check of
[Before you start](#before-you-start), since a route can change after step
4, a deploy among the things in between, or between the two. In another
shell, read `API` again first, as Before you start does. For a worker on
your own machine, `API` is `http://localhost:8787`, which the check passes:
the token never leaves the machine, and `--noproxy` keeps it off any proxy
set for plain http.

```sh
API="$API" node dist/scripts/environment-routing.js && curl --disable -sS --noproxy localhost,127.0.0.1,::1 -X POST "$API/registry/v1/admin/versions/00000000-0000-4000-8000-000000000000/validate" \
  -H "Authorization: Bearer $NEW_TOKEN" -H 'Content-Type: application/json' -d '[]' | jq -c .error
API="$API" node dist/scripts/environment-routing.js && curl --disable -sS --noproxy localhost,127.0.0.1,::1 "$API/registry/v1/admin/status" -H "Authorization: Bearer $NEW_TOKEN" | jq -r '.environment // .error.code'
```

- `"code":"BAD_REQUEST"`, "the request body must be a JSON object": the
  token is an `admin`'s. The body is refused before any version is looked
  up, so nothing is validated, whatever the id.
- `"code":"FORBIDDEN"` with `"details":{"role":"…","requiredRole":"admin"}`:
  the token is taken, with the role `details.role` names, which must be the
  role its entry lists.
- The status prints the environment's name, which must be `$ENVIRONMENT`, or
  `local` for a worker you run on your own machine. A token is listed in its
  own environment alone, so another environment never names itself here: it
  refuses the token, as below.

`API is empty`, from the check, is an `API` this shell has not read. Where
step 4 stopped before reading it, it also put nothing: run step 4 again once
what stopped it is fixed. Otherwise read `API` again, as
[Before you start](#before-you-start) says, or, for a worker on your own
machine, run `export API=http://localhost:8787`. A `curl: (N) …` line is a
request that did not reach the API, the host down or out of reach: wait for
the host. Either way nothing was checked: run the block again. If `jq`
reports a parse error, that answer is not JSON: run its line again, its
check with it, without its `| jq …` to see it. Any other answer to the first
request names its `code` and `message`, and the second prints that `code`:

- `UNAUTHORIZED` (`401`), "a bearer token is required": `NEW_TOKEN` is empty
  in this shell.
- `UNAUTHORIZED` (`401`), "the bearer token is not valid": the environment at
  `API` has no entry for this token. Either `API` is not `$ENVIRONMENT`'s
  address, and another environment answered, or the list has no entry for
  it: a hash made with `echo`, another token's, or the token itself, listed
  in place of its hash. Read `API` again first, as
  [Before you start](#before-you-start) says, then hash the token again
  (step 2) and put the list again. If step 4 put a list into an environment
  you did not mean, put that environment's own list back the same way.
- `UNAUTHORIZED` (`401`), "the bearer token has expired": its `notAfter` has
  passed.
- `FORBIDDEN` (`403`), "… COMET_REGISTRY_ADMIN_TOKENS is malformed": the
  worker cannot read the list, such as one with a hash copied with the `  -`
  or ` *stdin` printed after it, or an entry that names a field twice, and
  refuses every token until it can. Step 4 puts no such list, so it came
  another way. The worker's log line `registry route refused`, under the
  answer's `requestId`, names the entry and what is wrong with it; correct
  the file and put it again (step 4).
- `FORBIDDEN` (`403`), "… is not configured in this environment": the
  environment at `API` has no list, or one with no entry, and an unconfigured
  admin API is a closed one. Put the list (step 4), or, if you did, read
  `API` again, as [Before you start](#before-you-start) says.

**Rotating a token.** Make a new token for the same holder (steps 1 and 2),
add its entry under the same name and role, give the old entry a `notAfter`
a few days ahead, check the holder's entries as the end of step 3 does, and
put the list (step 4). Step 4 refuses the list while both entries last more
than 30 days, but it cannot tell which is the old one, and it takes a list
whose new token is meant to stop within 30 days while the old one never
does. Step 3's check tells them apart: the old token's entry,
`"new":false`, must show the cutoff you gave it. Both tokens are taken until
then: the holder switches, and after it the old one is refused as expired.
Drop its entry the next time you put the list. A token that may have leaked
is not rotated: drop its entry and put the list, which refuses it. Step 5
with that token then answers "the bearer token is not valid"; run that
check again after the next put, since a list made from an older copy would
put the token back (step 3).

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
archive state: the creation blocks are read at past blocks.
The local source is the one production imports,
`Compound-Foundation/comet` at `main`. Then start the worker on an empty
database, kept apart from your usual local one:

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
`export API=http://localhost:8787` and your first token in `TOKEN`, with
`export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1`,
which keeps the token off any proxy set for plain http, and with the
scripts built, `(cd c3-api && npx tsc -p tsconfig.scripts.json)`, since
each request runs the routing check first, run steps 1 to 7
of [the first bring-up](#bringing-an-environment-up-for-the-first-time),
step 5 with your second token in `TOKEN`, and time them.

**You should see** each step answer as it says. Step 2 prints its
`compared:` line alone, or above it only markets the source has added, in
its second column. Step 3 answers `"changed": true`, with nothing unreviewed
but those; to check the file it asks the node 10 `eth_blockNumber`, 58
`eth_getCode` at past blocks — each Comet at its creation block and at the
block before — and the decimals of up to 19 feeds. Step 4 answers
`validated`, and step 7 serves every market. Then compare
`GET $API/registry/v1/active` with the markets the frontend lists today:
every one is there, under the same display name, base asset name, slug, and
default and institutional flags.

**If not.** What step 3 refuses, its table explains. Where the file is at
fault, it needs a change ([its README](./registry/seed/README.md#changing-it))
before any environment is brought up with it. A `503` there with
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
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 -X POST "$API/registry/v1/admin/sync" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | jq
export V=<registryVersionId from the answer>
```

Postman, for a worker on your own machine:

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
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 "$API/registry/v1/admin/status" -H "Authorization: Bearer $TOKEN" \
  | jq '{draft: .candidates.importing, lastRun: .sync.lastRun}'
export V=<the versionId listed under draft>
```

In Postman, for a worker on your own machine,
`GET {{API}}/registry/v1/admin/status` with the token: the `versionId`
under `candidates.importing`, and `sync.lastRun`;
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
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -sS --noproxy localhost,127.0.0.1,::1 "$API/registry/v1/admin/versions/$V/changes" -H "Authorization: Bearer $TOKEN" > changes.json &&
jq -r '.markets.added[] | "\(.scope) \(.market.contracts.comet)"' changes.json | LC_ALL=C sort > draft-markets.txt &&
LC_ALL=C comm -3 seed-markets.txt draft-markets.txt &&
echo "compared: $(wc -l < draft-markets.txt | tr -d ' ') markets in the draft"
```

Postman, for a worker on your own machine:

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
  Worker reads it, so the change needs no release of its own. If the
  bring-up cannot wait for that, it is quicker to cut the file down to what
  the draft holds under the seed's Comets
  ([its README](./registry/seed/README.md#cutting-it-down)) and describe the
  rest afterwards.
- A line indented into the second column, alone, is a market the source lists
  and the seed does not describe. The seed leaves it switched off and
  unreviewed, the draft can be switched on without it, and it is described
  afterwards — see [Describing a new market](#describing-a-new-market). Go on.
- `jq: error … Cannot iterate over null` means the request was refused, and
  nothing was compared: `jq .error changes.json` says why
  ([When something goes wrong](#when-something-goes-wrong)).
- `API is empty`, from the check, is an `API` this shell has not read, and a
  `curl: (N) …` line a request that did not reach the API, the host down or
  out of reach; either way nothing was compared. Read `API` again, as
  [Before you start](#before-you-start) says, or wait for the host, and run
  the block again.

### 3. Send the seed

```sh
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 -X PUT "$API/registry/v1/admin/versions/$V/overlays" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @c3-api/registry/seed/production.json | jq '.error // {changed, unreviewed}'
```

Postman, for a worker on your own machine:

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
| `409`, "the overlay of network …, market … is no longer the one this was decided against", with `details.current` naming each | A scope the file names holds a review. Either the file is in already — sent before, by a request whose answer you did not see — or part of the draft was reviewed before the file came | Read the draft: `GET …/versions/$V`. If its `unreviewed` lists no more than step 2's second column, the file is in: go on to step 4. If it lists more, the rest was reviewed by hand, or handed down from an earlier attempt of this commit (step 4) or from a version that is on, when this is no first bring-up: describe what is left with the overlay routes ([Describing a new market](#describing-a-new-market)) |
| `409`, "… registry version cannot be changed" | The draft is no longer open: it was validated, or replaced by a newer attempt of its commit | As the `409` row on writing overlays in [When something goes wrong](#when-something-goes-wrong) says |
| `409`, "the registry version changed while this overlay was being written" | Something else wrote to the draft in the same moment | Send it again |
| `409`, "… has no reward asset on chain, so it cannot carry a reward price feed" | The file gives a reward feed to a market whose rewards contract names no reward token | The file needs a change: that market's rewards off and no reward feed, as `1/institutional_usdc` has ([its README](./registry/seed/README.md#changing-it)) |
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
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 -X POST "$API/registry/v1/admin/versions/$V/validate" \
  -H "Authorization: Bearer $TOKEN" | jq '.error // {status: .version.status}'
```

Postman, for a worker on your own machine:

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
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 "$API/registry/v1/admin/versions/$V" -H "Authorization: Bearer $TOKEN" | jq .validation
```

Postman, for a worker on your own machine:

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
approves exactly that. They run it from the root of their own checkout, with
their own token in `TOKEN`, the id of the version to approve in `V`
(`export V=<the versionId you give them>`), a `CLOUDFLARE_API_TOKEN` that
may only read in place of a Cloudflare login, as the bullet on the second
person in [Before you start](#before-you-start) says, and `API` read as that
section says, each request behind its own routing check.

First they read the changes, which the command keeps in a file in their home
directory and prints in full:

```sh
rm -f "$HOME/changes.${V:?export it first}.json" && (cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -sS --noproxy localhost,127.0.0.1,::1 "$API/registry/v1/admin/versions/$V/changes" -H "Authorization: Bearer $TOKEN" > "$HOME/changes.$V.json" && jq . "$HOME/changes.$V.json"
```

They read all of it: the networks and markets it adds, removes and changes,
against `comparedWith`, the version on — `null` here, since nothing is on
yet. A network it adds is listed whole, with its price exceptions, which
replace a market's price feed: check each against the decision that made
it. That is what the approval covers, by `snapshotChecksum`, the checksum of
the version's snapshot, which a version has once it is validated. A refusal
or a `curl: (N) …` line is no reading of the changes: they read them again
before going on. A `snapshotChecksum` of `null` is a version not validated
yet, as its `status` says: step 4 first.

Then they approve what they read, from that file:

```sh
SUM="$(jq -r '.snapshotChecksum // empty' "$HOME/changes.$V.json")" && : "${SUM:?the changes were not read: read them again}" \
  && (cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -sS --noproxy localhost,127.0.0.1,::1 -X POST "$API/registry/v1/admin/versions/$V/approve" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -c '{reason: "read the changes of \(.versionId) against \(.comparedWith // "no version on")", expectedActiveVersionId: .comparedWith, expectedSnapshotChecksum: .snapshotChecksum}' "$HOME/changes.$V.json")" | jq '.error // .approval'
```

Postman, for a worker on your own machine, with the approver's token as
`TOKEN`: first the changes, then the approval, with the `snapshotChecksum`
of those changes.

```http
GET {{API}}/registry/v1/admin/versions/{{V}}/changes
Authorization: Bearer {{TOKEN}}
```

```http
POST {{API}}/registry/v1/admin/versions/{{V}}/approve
Authorization: Bearer {{TOKEN}}
Content-Type: application/json

{"reason": "read the changes of <V> against no version on", "expectedActiveVersionId": null, "expectedSnapshotChecksum": "<snapshotChecksum of the changes>"}
```

Every approval names what its giver read: the version the changes were read
against, `expectedActiveVersionId` — `comparedWith` in their answer, `null`
here, and later the version that is on — and the snapshot they were of,
`expectedSnapshotChecksum`. The command takes both from the changes it kept,
so the approval covers those changes and no others. In its answer, look at
`usable` and `expiresAt`.

**Why.** A version is switched on by two people: one who approves it, and
another who switches it on. The approval covers exactly the snapshot read,
which can no longer change, against what is on now, and lets one switch
through. It cannot be taken back: one given by mistake, or with a token that
may have leaked, stays usable by any other admin until it expires, is used,
or a move switches its version on. Another version going on only suspends
it: a move back to the version it was given against, a rollback among them,
makes it usable again. Tell the other admins, so that nobody uses it before
its `expiresAt`.

**You should see** `"usable": true`, and an `expiresAt` a day ahead
(`COMET_REGISTRY_APPROVAL_TTL_S`): step 6 has until then. Once it has
expired unused, step 5 is done again.

**If not.**
- "SUM: the changes were not read": the file holds no changes of a validated
  version. Read them again; with a `snapshotChecksum` of `null`, step 4
  first.
- `jq: error: Could not open file …changes…`: the first command did not read
  the changes for this `V`, in this shell or at all; run it.
- `jq: parse error`: the answer was not the API's, such as an error page;
  read the changes again.
- `400`, "expectedActiveVersionId is required", "expectedSnapshotChecksum is
  required" or "expectedSnapshotChecksum must be the 64 lowercase hex
  characters …": the body does not say what was read, or not in that form;
  send it as above.
- `409`, "only a validated version can be approved": step 4 first.
- `409`, "… has the snapshot …, not … as this approval expected": the
  checksum sent is not this version's, from another version's changes or
  copied wrong; read this version's changes and approve from them.
- `409`, "the active version is …, not … as this approval expected": a
  version is on that was not when you read the changes; read them again,
  against it, and approve from them.

### 6. Switch it on

Back to you, with your own token in `TOKEN` — not the approver's:

```sh
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 -X POST "$API/registry/v1/admin/versions/$V/activate" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"first registry version", "expectedActiveVersionId":null}' | jq
```

Postman, for a worker on your own machine:

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

**Why.** The registry moves to the new list in one step, and `/registry/v1`
serves it from then on. It is recorded with your reason and the approval it
used, and can be undone — see [Switching back](#switching-back).

**You should see** `"changed": true` and an `approvalId`.

**If not.** `409` with `details.code` `APPROVAL_REQUIRED`: there is no
approval you may use. The message says against which version one is needed.
Step 5 was not done, was done with your own token or another of your name,
has expired, was used, or was given while another version was on: have it
done again.

### 7. Check that it is on

```sh
curl -s "$API/registry/v1/active" | jq '[.networks[].markets | length] | add'
curl -si "$API/registry/v1/active" | grep -i x-registry-version
```

Postman, for a worker on your own machine:

```http
GET {{API}}/registry/v1/active
```

Neither needs the token. In the answer, count the markets under
`networks[].markets`; the `X-Registry-Version` response header is on the
**Headers** tab.

**You should see** the number of markets you reviewed, and a
`X-Registry-Version` header equal to `$V`.

**If not.** A lower count is a market the version holds switched off:
`GET …/versions/$V` lists what is still unreviewed.

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
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 "$API/registry/v1/admin/status" -H "Authorization: Bearer $TOKEN" | jq '.candidates.validated, .alerts'
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
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 "$API/registry/v1/admin/versions" -H "Authorization: Bearer $TOKEN" | jq
```

Postman, for a worker on your own machine:

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
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 -X POST "$API/registry/v1/admin/sync" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{}' | jq '.error // {status, outcome, registryVersionId, reason}'
export V=<registryVersionId>
```

Postman, for a worker on your own machine:

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
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 "$API/registry/v1/admin/versions/$V/changes" -H "Authorization: Bearer $TOKEN" \
  | jq '{status, comparedWith, added: [.markets.added[] | {scope, reviewed}], removed: .markets.removed,
         unserved: .markets.unserved,
         changed: [.markets.changed[] | "\(.scope) \(.field): \(.before) -> \(.after)"], networks}'
```

Postman, for a worker on your own machine:

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
draft. Step 5 takes the version that is on from the changes it reads, its
`comparedWith`; step 6's body names it as `"expectedActiveVersionId"`:
`comparedWith` in the answer of step 2.

## Describing a new market

A market the source adds arrives switched off and unreviewed, and nothing
serves it until someone describes it. Describing it is writing down the
decisions about it, in one document.

### 1. Hold a draft that includes it

The scheduled job's draft of a commit is checked and frozen as soon as it is
imported, so describing a market needs a new attempt of that commit, held open:

```sh
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 -X POST "$API/registry/v1/admin/sync" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"forceNewAttempt": true, "holdForReview": true, "reason": "describe <chainId>/<deploymentKey>"}' | jq
export V=<registryVersionId>
```

Postman, for a worker on your own machine:

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
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 "$API/registry/v1/admin/versions/$V/changes" -H "Authorization: Bearer $TOKEN" \
  | jq '.markets.added[] | select(.reviewed | not)'
```

Postman, for a worker on your own machine:

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
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 "$API/registry/v1/admin/versions/$V/markets/<chainId>/<similar deploymentKey>/overlay" \
  -H "Authorization: Bearer $TOKEN" | jq .overlay
```

Postman, for a worker on your own machine:

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
| `contractName` | The Comet's name | The Comet contract's `symbol()`, for example `cUSDTv3` |
| `status` | Whether the market is served | `enabled`; `disabled` keeps it off |
| `isDefault` | The market the website opens first | `false` — exactly one market in the whole registry is the default |
| `creationBlock` | The block the market starts at | The block the Comet proxy was deployed in (the explorer's "Contract Creation"). Must be above `0` for a market that is served. The write holds it against the chain — the Comet has code at that block and none at the block before it — and refuses one the chain contradicts with `422` `OVERLAY_CREATION_BLOCK_WRONG`, saying whether it is before the deployment, after it, or past the latest block |
| `collateralValueQuote` | The unit the market's own price feeds answer in | Call `description()` on the base token's price feed from step 2. `X / USD` → `usd`. `Constant price feed` (WETH, wstETH) or `WBTC / BTC` → `base` |
| `baseAsset.usdPriceFeedAddress` | The feed that turns the unit the market's feeds answer in into USD | `null` when the quote is `usd`. When it is `base`, the USD feed of that unit on that chain: ETH / USD for a WETH market, BTC / USD for the WBTC market, whose feeds answer in BTC |
| `baseAsset.isWrappedNative` | The base token wraps the chain's own token | `true` for WETH on Ethereum and its L2s, WPOL, WMNT, WRON |
| `capabilities.rewards`, `capabilities.accountRewards`, `rewardPriceFeed` | Rewards | If step 2 shows no rewards contract or no reward token, the market has no rewards: both `false`, `rewardPriceFeed` `null`. Otherwise a COMP price feed of that chain, quoted in the unit its `description()` names: `COMP / USD` gives `"quote": "usd"`; `COMP / ETH` — the reward feed of mainnet's and Linea's WETH markets — gives `"quote": "base"`, which needs `collateralValueQuote` `base` and a `usdPriceFeedAddress`. Never pair a COMP / ETH address with `usd`: validation does not catch it, and the registry would serve COMP priced in ETH as if in USD |
| `capabilities.transactionHistory` | Whether the market has transaction history | `true` if it should. The market needs a rewards contract, and a right `creationBlock` |

The document is complete or it is refused: a missing field is a decision
nobody made, not a default. The checks in step 4 of the first bring-up refuse
the combinations that cannot work — a `base` quote without a USD feed,
rewards without a feed or a rewards contract, a shared label without a slug,
a served market without a creation block — and a reward feed on a market
with no reward token, or a creation block the chain contradicts, is refused
as soon as it is sent.

### 5. Send it, then check and switch on

```sh
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 -X PUT "$API/registry/v1/admin/versions/$V/markets/<chainId>/<deploymentKey>/overlay" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason": "describe <chainId>/<deploymentKey>", "overlay": { ... }}' | jq
```

Postman, for a worker on your own machine:

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
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 -X PUT "$API/registry/v1/admin/versions/$V/networks/<chainId>/overlay" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason": "describe <chainId>", "overlay": {"displayName": "<the name the website shows>",
       "assetDisplayOverrides": [], "unwrappedCollateralAssets": [], "priceExceptions": []},
       "expectedDigest": null}' | jq
```

Then steps 4 to 7 of the first bring-up, and step 2 above for what the
draft changes. The new market is under `added`, now with `"reviewed": true`.

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
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 "$API/registry/v1/admin/status" -H "Authorization: Bearer $TOKEN" | jq '.chainCheck'
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

`/registry/v1/*` serves the old facts, which a client that prices from the
registry's feeds would use.

### 2. Import the commit again

```sh
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 -X POST "$API/registry/v1/admin/sync" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"forceNewAttempt": true, "reason": "read the chain again: 130/weth changed the feed of rsETH"}' | jq
export V=<registryVersionId from the answer>
```

Postman, for a worker on your own machine:

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
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 -X POST "$API/registry/v1/admin/versions/<previous version id>/rollback" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"reason":"why", "expectedActiveVersionId":"<the version that is on>"}' | jq
```

Postman, for a worker on your own machine:

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

A rollback needs nobody's approval: undoing a bad version takes one person,
with any `admin` token. It goes back one step: to the version the one on
replaced when it was last activated, if that is older. To go further back,
roll back again from the version you restored. Anything else is refused with
`409` and `details.code` `ROLLBACK_TARGET_INVALID`, whose message names the
version a rollback may restore now, or says that none may: a version two
steps back, one never on, or one newer than the one on is switched on as
steps 5 to 7 of the first bring-up do, with another admin's approval.

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
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -sS --noproxy localhost,127.0.0.1,::1 "$API/registry/v1/admin/versions/${ON:?export it first}" -H "Authorization: Bearer $TOKEN" \
  | jq -rn '(try input catch error("no answer from the API: run it again")) | if .error then error(if .error.code == "NOT_FOUND" then "not a version" else "refused: \(.error.code), \(.error.message)" end) elif .version == null then error("no answer from the API: run it again") else .version.id as $on | first(.activations[] | select(.targetVersionId == $on and .action == "activate")) | .previousVersionId end'
```

If it prints `null`, or nothing, with neither a refusal of the routing check
nor an error line before it, a rollback has nothing to go back to: stop
there. `not a version` is an `ON` that names no version. A `curl: (N) …`
line is a request that did not reach the API, and `no answer from the API`,
or a `jq: parse error`, one answered with nothing or with something else
than the API's answer, such as an error page: run it again. A
`refused: <code>, <message>` line is a request the API refused, as it
refuses an expired token or a spent budget: look it up by its code and its
message in [When something goes wrong](#when-something-goes-wrong).
Otherwise check that the version it printed is older than the version on,
which prints `true`; an id that names no version stops the check with
`not a version`, a refused request with `refused: …`, and a request the
routing check stopped, or one that did not reach the API, with
`a request did not go out`:

```sh
export BACK=<the id it printed>
for id in "$BACK" "$ON"; do (cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -sS --noproxy localhost,127.0.0.1,::1 "$API/registry/v1/admin/versions/$id" -H "Authorization: Bearer $TOKEN"; done \
  | jq -s 'if length != 2 then error("a request did not go out: run it again") else map(.version // error(if .error.code == "NOT_FOUND" or .error == null then "not a version" else "refused: \(.error.code), \(.error.message)" end) | [ .createdAt, .attempt, .id ]) | .[0] < .[1] end'
```

Postman, for a worker on your own machine:

```http
GET {{API}}/registry/v1/admin/versions/<the version that is on>
Authorization: Bearer {{TOKEN}}
```

`activations` lists the moves that switched the version on or off, newest
first, as the database recorded them. The first `activate` whose
`targetVersionId` is the version that is on
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

## Keeping an eye on it

One request tells you whether the registry is well:

```sh
(cd c3-api && API="$API" node dist/scripts/environment-routing.js > /dev/null) && curl --disable -s --noproxy localhost,127.0.0.1,::1 "$API/registry/v1/admin/status" -H "Authorization: Bearer $TOKEN" | jq
```

Postman, for a worker on your own machine:

```http
GET {{API}}/registry/v1/admin/status
Authorization: Bearer {{TOKEN}}
```

**You should see** `"alerts": []`. Everything else in the answer is context:
which version is on, who switched it on and who approved that, whether its
data is cached, when
the source was last checked, how the last import went, which drafts are
still open, and when the chain was last read again, and for which version
(`chainCheck`).

When `alerts` is not empty, each name says what to do:

| Alert | What it means | What to do |
|---|---|---|
| `configuration-invalid` | A registry setting of this environment is set to something it does not take; `configuration.invalid` names each. The import refuses to start while one of its own is invalid, and a read takes the default in its place — an approval given meanwhile lasts the default day | Correct the value in the environment's `[vars]` in `wrangler.toml` and deploy: the numbers are whole numbers, `COMET_REGISTRY_APPROVAL_TTL_S` one from 1 to 604800 (a week), `COMET_SOURCE_REPOSITORY` is `owner/repository` and `COMET_SOURCE_REF` a branch, a tag or a commit |
| `no-active-version` | Nothing is switched on, so the registry's public reads answer `503` | Bring a version up — [Bringing an environment up for the first time](#bringing-an-environment-up-for-the-first-time) |
| `candidate-awaiting-review` | A draft is held for review and no import is running | Review it, then validate it (step 4 of [the first bring-up](#bringing-an-environment-up-for-the-first-time)) |
| `candidate-awaiting-activation` | A new commit was imported and validated, and is waiting to be switched on; `candidates.validated` names it | [When the source changes](#when-the-source-changes). The alert holds until a version at least that new is switched on: one you decide not to switch on keeps it raised until a newer commit's version is |
| `candidate-awaiting-approval` | The newest version waiting to be switched on has no approval anybody could switch it on with: none was given, or the one given expired, was used, or was given while another version was on | An admin reads what it changes and approves it (step 5 of [the first bring-up](#bringing-an-environment-up-for-the-first-time), with the version's id and the version on as `expectedActiveVersionId`). The alert clears then, and comes back if the approval expires unused or another version goes on first; its `approval` in `candidates.validated` names it while it holds |
| `candidate-drops-markets` | A version waiting to be switched on would stop serving markets the version on serves; its `unserved` in `candidates.validated` names them, by their keys in the version on. Nothing holds it back | Step 2 of [When the source changes](#when-the-source-changes): `markets.unserved` says where each Comet went. Confirm every one with a developer before switching it on, and describe a renamed one under its new key first. The alert holds until a version at least that new is switched on |
| `commit-rejected` | The newest commit imported completely but did not validate, and the scheduled job will not import it again by itself; `sync.rejectedCommit` names it | Read why it failed (`GET /registry/v1/admin/versions/<versionId>`). If a decision was wrong, hold a new attempt (step 1 of [Describing a new market](#describing-a-new-market)), correct it there and validate; otherwise the alert clears when the source moves on |
| `chain-drift` | The version on stores a price feed or a collateral asset its market's Comet no longer answers with: governance changed the market on chain after the import, and the source did not move. `chainCheck.drifts` names each, with what the version stores and what the chain answers | [A market that changed on chain](#a-market-that-changed-on-chain): import the commit again with `forceNewAttempt`, check what it changes and switch it on. The alert clears once the next hourly invocation has checked the version on and found it agrees with the chain, within the hour of the switch |
| `last-sync-failed` | The last import ended `failed`. `sync.lastRun.lastError` says how: `validation failed` is a draft that failed a check, and `cancelled by <actor>: <reason>` a run somebody cancelled. A root that fails does not fail the run, and neither do the checks of a run held for review — the first import of an environment, or one with `holdForReview`: it completes, its draft left open | After `validation failed`, read the draft's checks: `GET /registry/v1/admin/versions/<sync.lastRun.registryVersionId>` lists them under `validation.checks`, failed first, with their `details`. If `all-roots-imported` is among them, the run gave roots up: `GET /registry/v1/admin/sync-runs/<sync.lastRun.id>` lists them with `status` `failed`, and why in each `lastError`. Fix that — most often the node provider proxy — and the scheduled job tries the commit again, or force a new attempt. Otherwise `commit-rejected` is raised as well: follow it. After a cancel, import again as `sync-stalled` says |
| `sync-failing` | The import that is running keeps failing: the last root it tried failed, or an invocation has failed since before trying one, and the roots left failed have spent two attempts or more between them — two roots once, or one root twice. A single failure does not raise it. `sync.lastRun.lastError` says why, once an invocation has recorded it | Read its run: `GET /registry/v1/admin/sync-runs/<id>` lists each root with why it failed and the `attempts` it has spent. `SOURCE_REQUEST_FAILED` and `CHAIN_REQUEST_FAILED` are GitHub or the node provider proxy not answering: fix the proxy, or wait for GitHub, and the next hourly invocation carries on. Until then an invocation that imports nothing spends an attempt of each root it tries, and a root is given up after five, whatever failed it. `the invocation importing this root did not finish` is an invocation stopped in the middle of that root — a deploy, or a Worker past its time or CPU: the next one tries it again, and if one market keeps stopping it, the worker's logs say what did. Until the next one records it, such a root is still `processing`, under a `leaseExpiresAt` already past, and the run's `lastError` is still that of the attempt before it — `null` if that one succeeded. `the database did not answer` is D1 failing under that root — restarted, overloaded or cut off. A restart or an overload spends the attempt all the same, and the next invocation tries the root again; if it keeps coming back, check the database's health. The worker's log line `registry root failed` has what D1 said, as it has the whole of a fault, which a root records as `an unexpected error interrupted the import`. Anything else is the root itself. A `lastError` that no root of the run carries — `OVERLAY_INVALID` naming a `version …`, or `an unexpected error interrupted the import` — is an invocation that failed before it tried a root: see `sync-stalled`, which the status raises as well once nothing has moved for two hours |
| `sync-stalled` | A run says it is running, but nobody is continuing it: the hourly trigger is not firing, or every invocation fails before it imports a market | Read why in `sync.lastRun.lastError`; where it is `null`, the worker's log line `registry sync failed` names the service that did not answer — GitHub, the node provider proxy or the database — and once it answers, the hourly import resumes the run by itself. A `lastError` that comes back the same every hour does not pass: cancel the run — `POST /registry/v1/admin/sync-runs/<sync.lastRun.id>/cancel` with `{"reason": "…"}` — fix what it names, then import again with `{"forceNewAttempt": true, "reason": "…"}` (step 1 of [the first bring-up](#bringing-an-environment-up-for-the-first-time)). That attempt is of the commit the tracked ref names now: if the source has moved on since the run started — the cancel's answer names the run's `sourceCommitSha` — it imports the newer commit and leaves the run's draft open. To keep what was reviewed on that draft, send the run's `sourceCommitSha` with `forceNewAttempt` instead; otherwise close the draft as the row on a draft of an older commit in [When something goes wrong](#when-something-goes-wrong) says. Cancelling does not help with two of them, which a new attempt meets the same way. `an unexpected error interrupted the import` is a fault, which the log has whole as `registry sync failed unexpectedly`: see `INTERNAL` in [When something goes wrong](#when-something-goes-wrong). `OVERLAY_INVALID` naming a `version …` is a decision that version stores, the one on or an earlier attempt of the commit, which this release no longer takes: a developer's to fix, in a release. Once either is fixed, the hourly import resumes the run by itself |
| `sync-overdue` | The source has not been checked for more than two days, or never: a fresh environment raises it beside `no-active-version` until its first import records a check | On a fresh environment, nothing: the first import clears it, whether the hourly job starts it or you do ([the first bring-up](#bringing-an-environment-up-for-the-first-time)). Otherwise the hourly trigger is not firing, or every invocation fails before it records a check: a failed one is a failed Cron in the dashboard's Cron events, and the worker's log line `registry sync failed` says why |
| `snapshot-not-cached` | The active version is not in the cache | Harmless by itself — the next request refills it. If it persists, the KV namespace is misconfigured for this environment |
| `cache-unreadable` | The KV namespace itself did not answer | Check the `kv_registry` binding of this environment: until it answers there is no cache, and no older version to fall back on if the database fails |

A monitor sends this request alone, `GET $API/registry/v1/admin/status`,
every few minutes, with a `monitor` token of its own, and alerts when
`alerts` is not empty, or when the request fails. It runs no routing check,
so give it no other token: its role reads the status and nothing else.

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

Every error answer of the registry is the envelope
`{"error": {"code", "message", "requestId", "details"}}`: below,
`503 UPSTREAM_UNAVAILABLE` names the status and `error.code`, and a code such
as `SOURCE_REQUEST_FAILED` is the answer's `details.code`. The worker logs
every `5xx`, `401` and `403` answer of the registry under its `requestId`, and
every import a sync request runs under the `requestId` of its answer — a
refusal, such as a `409`, as the warning `registry sync refused`; any other
refusal is explained by the answer alone, but for `422` "validation failed",
whose reasons are in the draft it names.

| What you see | What it means | What to do |
|---|---|---|
| `INTERNAL` from the import, with a `requestId` | A fault rather than a service being down — most often the environment's database has no migrations applied. The worker's log has the error under `registry sync failed unexpectedly` | Apply the migrations (`node dist/scripts/environment-address.js > /dev/null && npm run "d1:migrate:$ENVIRONMENT"`, in `c3-api`), then import again; anything else is a bug to report with the log line |
| `UPSTREAM_UNAVAILABLE: the import was interrupted by a service that did not answer` | The database did not answer, or was restarted under the request; the log line `registry sync failed` has its message | Import again; if it persists, check the database |
| `503 UPSTREAM_UNAVAILABLE`, `details.code` `SOURCE_REQUEST_FAILED` | GitHub did not answer, or not within 20 seconds, or answered with an error status. "its rate limit is used up until …" is its hourly allowance spent, and "too many requests at once" its limit on bursts | Import again — after the time the message names, if it names one. Without `COMET_GITHUB_TOKEN` the allowance is 60 API requests an hour: set it, in `c3-api` ([Before you start](#before-you-start)) |
| `422`, `details.code` `SOURCE_CONFIGURATION_INVALID`, from the import | A setting the import reads is not what it takes, and the message names it; `/admin/status` raises `configuration-invalid` | Correct the value in `wrangler.toml` and deploy |
| `422`, `details.code` `SOURCE_TREE_TRUNCATED`, `SOURCE_CONTENT_TOO_LARGE` or `SOURCE_RESPONSE_INVALID` | GitHub answered, but with something the import cannot use, and would answer the same way again | Report it to a developer with the message; importing again does not help |
| `422`, "validation failed", from the import, with `details.syncRunId` and `details.registryVersionId` | The import finished and its draft failed a check: the draft is `invalid`, and can no longer change. `/admin/status` raises `last-sync-failed`, and `commit-rejected` as well when every root imported | Read the draft's checks: `GET /registry/v1/admin/versions/<registryVersionId>`, under `validation`. If `all-roots-imported` failed, `GET /registry/v1/admin/sync-runs/<syncRunId>` names the roots the run gave up, and why. Otherwise correct the decisions in a held attempt (step 1 of [Describing a new market](#describing-a-new-market)) and validate it, or wait for a new commit |
| `400`, `details.code` `OVERLAY_INVALID`, from the import or an overlay route, with a message that begins `version <id> market` or `version <id> network` — or, from `GET …/markets/<chainId>/<deploymentKey>/overlay`, with the market's key, such as `1/weth.displayName` | A decision a version stores that this release no longer takes. From the import, the version is the one on or an earlier attempt of the commit: every import fails on it before it imports a market, and spends nothing; `/admin/status` has it as `sync.lastRun.lastError`, and raises `sync-stalled` once nothing has moved for two hours. From an overlay route, it is the draft's own: every overlay write to the draft — `PUT …/overlay` and `PUT …/overlays` — reads all of its decisions first and is refused, the one that would replace that decision too, and so is the `GET` of the network or market that holds it | Report it to a developer with the message: a release that reads the decision again fixes it. The import then carries on by itself; cancelling the run does not help before that, since a new attempt reads the same decision. A draft the overlay routes refuse cannot be reviewed until then: leave it open, and do not validate it or switch it on — validation does not read the decisions again, and a version on that holds such a decision stops every import |
| `CHAIN_REQUEST_FAILED` in the import | The worker cannot reach the node provider proxy, or the proxy did not serve the calls, or did not answer them within 30 seconds. The worker's log line `registry root failed` has the status the proxy answered and its URL without the key: `HTTP 503` is no provider answering the proxy, `HTTP 401` the proxy refusing `NODE_PROXY_KEY` | Fix the proxy, its binding or its key; importing again continues where it stopped |
| A network under `chainCheck.unreadable` in `/admin/status` | The check of the chain could not read that network, for the reason it names — most often `CHAIN_REQUEST_FAILED`, as in the row above. Nothing new is known about its markets: it raises no `chain-drift` of its own and clears none, since a drift found there before stays, with the `seenAt` of the last read that found it. The warning `registry chain not read` in the worker's log has the cause | Fix the proxy for that network. The check reads it again at the next hourly invocation, until it has read every network |
| `chain-drift` in `/admin/status` | The chain answers a market's feed or collateral otherwise than the version on stores it | [A market that changed on chain](#a-market-that-changed-on-chain) |
| `422`, `details.code` `OVERLAY_CREATION_BLOCK_WRONG`, writing an overlay, the seed among them | A `creationBlock` the document changes is not the block the market's Comet was deployed in; the message says whether it is before the deployment, after it, or past the latest block. Nothing was written | Send the block the chain's explorer gives as the Comet's "Contract Creation" (step 4 of [Describing a new market](#describing-a-new-market)). From the seed, the file's block is wrong, or the key now names another Comet: see step 3 of [the first bring-up](#3-send-the-seed) |
| `401`, "the bearer token is not valid" | The token is not one the environment lists: a wrong one, or its hash in its place | Use the token itself; check it as step 5 of [The admin tokens](#the-admin-tokens) says |
| `401`, "the bearer token has expired" | Your token's `notAfter` has passed: it was rotated out | Use the token that replaced it, or ask the environment's owner for one |
| `403`, "the token … has the role …, and this route needs …" | Your token's role does not reach the route; `details.requiredRole` names the role that does | Ask for a token with that role, or ask its holder to make the change |
| `403`, "the administrative API is misconfigured in this environment: …", or "… is not configured …" | The environment has no token in its list, or a list the worker cannot read, so every token is refused | Step 5 of [The admin tokens](#the-admin-tokens) says what each message means and what to do |
| `413` | The request body is larger than the route takes | Send less: a directory of overlays in several requests |
| `429`, "too many administrative requests from this address" | More than 60 administrative requests in a minute from your address — over IPv6, from your /64 — whatever they were: every request under `/registry/v1/admin/` is counted by address before its token is checked, a wrong token or a path no route takes included, and the right token is refused too once the address has spent its budget | Wait the seconds its `Retry-After` names — a minute at most. A script in a loop, or a monitor sharing your address, is what spends it |
| `429`, "too many … requests with this token" | More than 30 administrative requests in a minute with your token, counted per family of routes. Reads count too, and every read shares one budget, while each kind of command has its own; anyone using your token spends it with you | Wait the seconds its `Retry-After` names. A monitor polls with a `monitor` token of its own, which spends nothing of yours |
| `422`, `details.code` `OVERLAY_FEED_UNREADABLE`, writing an overlay | A feed the overlay names does not answer its decimals on that chain: it reverts, or nothing is deployed at that address there — most often a feed of another chain | Check the address against the chain's feed; a `503` instead is the node provider not answering, and worth trying again |
| `409` writing overlays, "… registry version cannot be changed" or "is no longer importing" | The draft is no longer open: it was validated, switched on, or replaced by a newer attempt of its commit (`GET /registry/v1/admin/versions/<id>` says which) | Look for the newest open draft first (`GET /registry/v1/admin/versions?status=importing`) and continue there; start a new attempt (step 1 with `forceNewAttempt`) only if there is none |
| `409` on validate, "the import … is still running" | The import has not finished | Send step 1 again until it completes |
| `409` on validate, "the candidate changed while it was being validated" | An overlay was written to the draft while it was being checked, so the checks no longer described it and none was kept | Validate it again |
| `409` writing an overlay, "is no longer the one this was decided against" or "changed while this overlay was being written" | Somebody changed the draft between your read and your write | Read the overlay again — `GET …/markets/<chainId>/<deploymentKey>/overlay` or `GET …/networks/<chainId>/overlay`, whose answer has its `digest` — redo your change on it, and send it with that digest as `expectedDigest`, or under the document's key in `expectedDigests` of a `PUT …/overlays` |
| `409` writing an overlay, "already has that slug", "is already the default" or "cannot carry a reward price feed" | The document conflicts with the rest of the draft: another market of the network keeps that slug, another market is the default, or the market's rewards contract names no reward token. The draft is open, and nothing was written | Change the document, not the draft. Choose another slug, or move it with both markets in one `PUT …/overlays`; move the default the same way, both markets in one request. Read both first, and send each one's `digest` under its key in `expectedDigests` (`{"1/usdc": "<digest>", "1/weth": "<digest>"}`), so a change made to either since is not undone. A market without a reward token takes `"rewardPriceFeed": null` and both rewards capabilities `false` |
| `409` on activate, rollback or approve, "the active version is …", "the active version changed to … while this … was decided" or "other moves were written while this … was decided" | Somebody switched another version on after you looked, or while your request was deciding, or switched one on and back. Nothing of yours was recorded | Read the status again and decide again |
| `409` on activate, `details.code` `APPROVAL_REQUIRED` | No approval of the version you may switch it on with: none was given, or it was given by you or another token of your name, has expired, was used, or was given while another version was on — the message names the version an approval is needed against. "Was no longer in force when it was written" is an approval that expired between the check of your request and its write | Have another admin approve it again, against the version on (step 5 of [the first bring-up](#bringing-an-environment-up-for-the-first-time)), then switch it on |
| `409` on rollback, `details.code` `ROLLBACK_TARGET_INVALID` | A rollback goes back one step only, to the version the one on replaced when it was last activated, if that is older. This one is another — two steps back or more, never on, or newer — or nothing is on, or the version on was switched on in place of a newer one. The message names the version a rollback may restore now, or says that none may | Roll back to the version the message names, one step at a time, as [Switching back](#switching-back) says. To switch on any other version, approve it and activate it (steps 5 to 7 of [the first bring-up](#bringing-an-environment-up-for-the-first-time)) |
| `400` on approve, "expectedActiveVersionId is required" | The approval does not say which version on its changes were read against | Read the changes, and send the version on as `expectedActiveVersionId` — `comparedWith` in their answer, or `null` when nothing is on (step 5 of [the first bring-up](#bringing-an-environment-up-for-the-first-time)) |
| `400` on approve, "expectedSnapshotChecksum is required" or "must be the 64 lowercase hex characters" | The approval does not name the snapshot whose changes were read, or names it in another form | Read the changes, and approve from them as step 5 of [the first bring-up](#bringing-an-environment-up-for-the-first-time) does, which sends their `snapshotChecksum` as `expectedSnapshotChecksum` |
| `409` on approve, "… has the snapshot …, not … as this approval expected" | The checksum sent is not this version's: it came from another version's changes, or was copied wrong | Read this version's changes and approve from them (step 5 of [the first bring-up](#bringing-an-environment-up-for-the-first-time)) |
| `409` on approve, "is on already" | The version is the one on: there is no change to approve | Nothing |
| A version is `invalid` with the failed check `served-network-reviewed` | It serves a market of a network nobody has described — a chain no version had before | An `invalid` version can no longer be changed. Hold a new attempt (step 1 of [Describing a new market](#describing-a-new-market)), which keeps what was reviewed in this one; describe the network there (step 5), then validate it and switch it on (steps 4 to 7 of the first bring-up) |
| A root failed with `OVERLAY_INVALID`, "is the default market by the decisions it inherits, but … already is the default" | The draft holds another default than the one its import inherits: the draft's default was moved to a market it holds before the import reached the market that opened by default, or a version that names another default was switched on while the import was running | If the draft's default was moved, the draft is still importing, and the root has attempts left (`attempts` below five in `GET /registry/v1/admin/sync-runs/<id>`): move the default back, import the rest, then move the default with both markets in one `PUT …/overlays`, with their digests under `expectedDigests` as in the row on a slug above. Otherwise continue the import until it ends — each request spends one of the root's five attempts — and hold a new attempt (step 1 of [Describing a new market](#describing-a-new-market)): it inherits the default the draft moved, or the one switched on, and imports both markets |
| `idle` from import, "attempt … of this commit imported every root and is invalid" | The commit was imported completely and did not validate; another attempt would fail the same way, so the scheduled job does not make one | Read why it failed (`GET /registry/v1/admin/versions/<registryVersionId>`). Correct the decisions in a held attempt (step 1 of [Describing a new market](#describing-a-new-market)) and validate it, or wait for a new commit |
| `idle` from import, "attempt … did not import every root; it is tried again after …" | Roots of the last attempt did not import — a chain that did not answer, or contracts the source names before they are deployed | Nothing: the scheduled job tries again then. To try now, force a new attempt |
| `idle` from import, "a candidate of this commit is held for review" | A draft of this commit is already waiting for you | Use that draft — its id is in the answer — or force a new attempt. The new attempt closes that draft only once it succeeds; if it fails, the draft is still there to validate |
| `idle` from import, "upstream was checked recently", with no `registryVersionId` | The source was checked less than a day ago and nothing is importing, so the request had nothing to do and names no draft | On a first bring-up the hourly job has finished the import and held its draft: it is under `candidates.importing` in `GET /registry/v1/admin/status`, and has every market only if `sync.lastRun` there has `completedCount` equal to `expectedCount`; if not, fix why the job gave markets up and start a new attempt ([If the hourly job got there first](#1-import--take-a-snapshot-of-the-source)). Later, see [Find the new version](#1-find-the-new-version) |
| A version is `invalid` with the failed check `superseded-by-newer-attempt` | A newer attempt of the same commit succeeded and replaced this draft; its `details` name which | Work on that attempt. Reviews made on this draft before the replacement was imported are in it; anything reviewed here afterwards is not — redo it on the newest draft (`GET /registry/v1/admin/versions?status=importing`) |
| `/admin/status` keeps listing a draft of an older commit | The source moved to a newer commit while that draft was open; drafts are only replaced by attempts of their own commit, because reviews do not carry across commits | Finish it (validate it — that also closes it), or, if the newer commit's version has taken its place, validate it anyway to close it |
| `409 CONFLICT`, `details.code` `SYNC_ALREADY_RUNNING` | An import is in progress — the hourly one, a request you already sent, or one you are asking to change with `forceNewAttempt`, `holdForReview` or `sourceCommitSha`. Such a request that failed, with a `503` say, may have started its run first: sent again as it was, it is refused. "another invocation is importing right now" means an invocation holds the run this very moment. A request that failed gave it back as it failed, unless the database was still not answering then (`registry lease not released` in the worker's log); that one, like one stopped without an answer — by a deploy, or past the time or CPU a Worker is given — holds it until its lease runs out, at most 15 minutes | Continue it with an empty body until it says `completed`, sending it again a little later while another invocation is importing; only then ask for a new attempt. A run that every request fails on the same way never says `completed`: cancel it, as `sync-stalled` in [Keeping an eye on it](#keeping-an-eye-on-it) says |
| Answers carry `X-Registry-Stale: <seconds>`, and the log has the error `registry database unreachable; answering from the version it last named` | The database could not be reached, so the API is answering from the version it last saw, and saying how old it is. Each isolate logs the error once a minute while this lasts | Check the database's health; the API recovers by itself once D1 answers, and starts returning `503` if the outage outlasts the configured window |
| `503 UPSTREAM_UNAVAILABLE` from the registry routes, or from `/admin/status` | The database could not be reached, and there is no version within the window to answer from | Check the database's health; nothing in the registry needs changing |
| `500 INTERNAL` from the registry routes | The database answered with a fault — most often a release deployed before its migrations — or a bug. The worker's log line `registry route failed` with the answer's `requestId` has the error. On an activation or a rollback, with "an activation requires an approval", "a rollback restores only the older version …" or "the active registry version moves only with its activation", it is a release from before approvals answering, after the environment's first approval: deployed again, or beside the release with approvals | Apply the migrations if they are missing; deploy the release with approvals, or a later one, to all traffic if an older one answers; otherwise report the log line |
| The worker's log has the warning `computation cache unreadable` or `computation cache unwritable`, with what KV answered | KV refused a call to the namespace computed values are cached in, `kv_mainnet` or `kv_testnet`: `429` is a value written twice in a second, `503` KV not answering. The request was answered without the cache — a value it could not read was computed again from the chain, and one it could not write was not kept — so it was slower, and asked the node provider more. Each isolate says each once a minute while it lasts | Nothing for a `429` now and then. A `503` that keeps coming back is KV not answering: every request reads the chain while it lasts, and transaction history fails, so check Cloudflare's status and the node provider proxy |
