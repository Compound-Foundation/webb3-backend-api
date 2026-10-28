# The registry seed

[`production.json`](./production.json) is the first review of an
environment's registry: every decision about the networks and markets that
`Compound-Foundation/comet` lists on `main` — the source stage and production
import — as the body of `PUT /registry/v1/admin/versions/{id}/overlays`. A
first import has no version to inherit decisions from, so its draft holds
every market switched off and unreviewed; this file reviews all of it in one
request, all or nothing.

It holds 10 networks and 29 markets: 39 documents, of the 100 one request
takes, in under 30 KB of its 512 KiB. The count runs out first, at about 90
markets on these networks; past that, the file goes in two requests.

[`production.comets.json`](./production.comets.json) names each market's
Comet, lowercase. The overlays carry no address, so this is what the draft is
checked against before the file is sent.

The file is for a first draft only. Once a version has been switched on,
every later draft inherits its decisions, and one is changed with the overlay
routes in a held draft
([REGISTRY_RUNBOOK.md](../../REGISTRY_RUNBOOK.md#describing-a-new-market)).
Its `expectedDigests` say every document is decided against a scope nobody
has reviewed, so a draft that holds a review — the file sent twice, or a
draft that inherited decisions — refuses it whole with `409`, and nothing is
written.

Nothing in the Worker reads these files: the tests read them from the
repository, and they reach neither `dist` nor the bundle.

## Sending it

Steps 2 and 3 of
[the first bring-up](../../REGISTRY_RUNBOOK.md#bringing-an-environment-up-for-the-first-time),
from the root of a checkout: check that the draft holds every market of the
file under the Comet the companion names, then send it.

```sh
curl -s -X PUT "$API/registry/v1/admin/versions/$V/overlays" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  --data-binary @c3-api/registry/seed/production.json | jq '.error // {changed, unreviewed}'
```

The request needs the node provider. It holds every creation block against
the chain — the Comet has code at that block and none at the block before,
so it is 58 archive reads on 10 networks — and reads the decimals of every
feed the draft does not know yet, up to 19. The runbook lists every answer
and what to do about it.

## Cutting it down

A draft that lacks a market of the file refuses it whole, with `404` naming
everything it lacks: a source that has dropped or renamed a deployment, or a
local database importing another source. Cut the file down to what the draft
holds, the networks, the markets and their `expectedDigests` together — a key
in `expectedDigests` without its document is refused with `400`:

```sh
curl -sS "$API/registry/v1/admin/versions/$V/changes" -H "Authorization: Bearer $TOKEN" > changes.json
jq --slurpfile changes changes.json '
  ([ $changes[0].networks.added[] | tostring ] + [ $changes[0].markets.added[].scope ]) as $held
  | (.networks, .markets, .expectedDigests) |= with_entries(select(.key | IN($held[])))
' c3-api/registry/seed/production.json > seed.json
```

and send `seed.json` the same way. What it leaves out stays switched off, and
is described after the bring-up
([REGISTRY_RUNBOOK.md](../../REGISTRY_RUNBOOK.md#describing-a-new-market)).

A key the draft holds under another Comet than the companion names is not
cut, since the draft does hold the key; step 2 of the runbook finds it. Its
decisions were made for the other Comet, and the request refuses them, so take
its document and its expectation out too:

```sh
jq 'del(.markets["1/usdt"], .expectedDigests["1/usdt"])' seed.json > seed.next.json && mv seed.next.json seed.json
```

## Changing it

By hand, in a pull request, as code is changed: nothing generates the file
any more ([Where it came from](#where-it-came-from)). A value here is a
decision the environment will serve, so the pull request says why it
changes. An environment that is already up does not read the file again:
there, the same decision is made in a held draft with the overlay routes.

- Every document is complete, in the form the overlay parsers store it: keys
  in their order and lists sorted by address, as `GET …/overlay` answers. So
  an environment's overlays diff with the file line by line.
- `expectedDigests` names every document, in the file's order, with `null`.
- `production.comets.json` names the Comet of every market, in the file's
  order.
- A deployment the source adds: add its document and its Comet, and its
  network's document if its chain is new. Or leave it out: the draft keeps it
  switched off, and it is described after the bring-up.
- A deployment the source renames or drops: rename or remove its document,
  its expectation and its Comet, or the whole file is refused.
- A key the source gives another Comet: its decisions were made for the old
  one. Decide its document again for the new Comet and change its entry in
  `production.comets.json`, or remove its document, its expectation and its
  Comet. Never change only its `creationBlock`.
- `creationBlock` is the block the Comet proxy was deployed in, the
  explorer's "Contract Creation". The request refuses a block one later as
  well as one earlier.

[`tests/lib/registry/seed.test.ts`](../../tests/lib/registry/seed.test.ts)
holds the file to the first three, and to every check validation makes of
the file's decisions, run over its markets built as an import builds them,
on facts that fail no check. It reads the file as the route reads a body —
its keys, its reason, how each document is keyed and how many there are —
and refuses a price exception that has expired, as the request does.
[`tests/e2e/registry/seed-overlays.test.ts`](../../tests/e2e/registry/seed-overlays.test.ts)
sends the file as it is, so a file larger than the route takes fails there.
What the source lists is step 2 of the runbook's to check, and the chain the
request's.

## Why each value is what it is

Every value is one the API acted on before the registry, taken from where it
was decided then. The static constants below are `lib/well-known/contracts`
as the file was frozen from them, at `56d75ff`: their Comets, and the feeds
only those named, have been removed since.

| Field | Where it comes from |
|---|---|
| `displayName`, `slug`, `isInstitutional`, `baseAsset.displayName` | What the frontend lists the market as, copied from `woof-software/webb3-frontend@98c38cd16937206f3fbad59205343e4c9cf9d165` `src/helpers/markets.ts`, the only place they existed. It shows a WETH market as ETH, because it wraps the native token for the user — but Ronin's WETH market as WETH; bridged USDC as USDC.e on Polygon and Arbitrum, and as USDbC on Base; and Tether as it was renamed, USDT0 on Polygon and USD₮0 on Arbitrum. The institutional USDC market shares its label with `1/usdc`, so it has the slug `usdc-institutional`, and is listed in the institutional section |
| `contractName`, `creationBlock` | The Comet's display name and creation block in the static constants (`lib/well-known/contracts`) |
| `status` | `enabled`: every market here was served |
| `isDefault` | `1/usdc` alone, the market the application opens |
| `capabilities.transactionHistory` | The markets whose history was served, which `transaction-history-items-handler.ts` listed by hand: `1/usdc`, `1/weth`, `1/usdt`, `1/institutional_usdc`, `10/usdc`, `10/usdt`, `10/weth`, `137/usdc`, `8453/usdc`, `8453/usdbc`, `8453/weth`, `42161/usdc` and `42161/usdc.e`. No other market had reachable history |
| `capabilities.rewards`, `capabilities.accountRewards` | On, but on Scroll and Ronin, which the rewards computations skipped by name because no reward feed answers there, and on `1/institutional_usdc` (below) |
| `collateralValueQuote` | The unit the Comet's base token feed answers in, read from its `description()` on chain: `base` for every WETH market and mainnet wstETH ("Constant price feed") and for mainnet WBTC ("WBTC / BTC"), `usd` for the rest. The constants are wrong about it both ways: they put mainnet WBTC on the BTC / USD feed, and give AERO and USDe a USD feed although both markets' own feeds answer in USD |
| `baseAsset.usdPriceFeedAddress` | On a market quoted in its base asset, the feed that turns that asset into USD: the `usdPriceFeed` the constants carry beside the base feed, or the feed the rewards APR computations converted the market through. A market quoted in USD carries none |
| `baseAsset.isWrappedNative` | The base asset is the chain's wrapped native token: WETH on Ethereum and its L2s, WPOL, WMNT, WRON |
| `rewardPriceFeed` | The COMP feed the constants name for the market. Its quote is `usd`, but `base` where the feed's `description()` reads COMP / ETH: the WETH markets of Ethereum and Linea. Decimals cannot tell them apart — mainnet's COMP / ETH answers with 18, Linea's with 8, as COMP / USD does. None where rewards are off |
| A network's `displayName` | Its name as the frontend shows it |
| `assetDisplayOverrides`, `unwrappedCollateralAssets` | How the frontend shows a network's assets, and the collateral a user may supply unwrapped for the bulker to wrap: copied from the same frontend commit's `src/constants/chains.ts`, the only place they existed. Nothing in the API reads them; the registry serves them so the frontend stops deciding them on its own. A display address of zero shows a wrapped native token as the chain's own |
| `priceExceptions` | The feeds `asset-price.ts` refused to read, each with the provenance it was added with. None expires |

Where a value departs from those rules, or they need saying for one market:

| Scope | Field | Value | Why |
|---|---|---|---|
| `1/institutional_usdc` | `capabilities.rewards`, `capabilities.accountRewards`, `rewardPriceFeed` | `false`, `false`, `null` | Its rewards contract answers the zero address for the market's reward token, and both tracking speeds are zero, though the constants declare COMP rewards for it — only to keep one CometRewards for the network |
| `1/wbtc` | `baseAsset.usdPriceFeedAddress` | `0xf4030086522a5beea4988f8ca5b36dbc97bee88c` | WBTC / USD, which the rewards APR computations converted the market through |
| `1/weth` | `baseAsset.usdPriceFeedAddress` | `0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419` | The `usdPriceFeed` the constants carry beside the base feed |
| `1/wsteth` | `baseAsset.usdPriceFeedAddress` | `0x164b276057258d81941e97b0a900d4c7b358bce0` | The same |
| `10/weth` | `baseAsset.usdPriceFeedAddress` | `0x13e3ee699d1909e989722e753853ae30b17e08c5` | The same |
| `130/weth` | `baseAsset.usdPriceFeedAddress` | `0xe8d9fbc10e00ecc9f0694617075fdaf657a76fb2` | The same |
| `2020/weth` | `baseAsset.usdPriceFeedAddress` | `0x5d173813b4505701e79e654b36a95e6c1fad4448` | The same |
| `5000/usde` | `baseAsset.usdPriceFeedAddress` | `null` | The rewards APR computations converted it through cUSDev3 / USD, `0xc49e06b50fca57751155da78803dca691afcdb22`, but its own feeds already answer in USD, so it is quoted in USD and carries none |
| `8453/aero` | `baseAsset.usdPriceFeedAddress` | `null` | The constants carry the `usdPriceFeed` `0x4ec5970fc728c5f65ba413992cd5ff6fd70fcff0`, but its own feeds already answer in USD, so it is quoted in USD and carries none |
| `8453/weth` | `baseAsset.usdPriceFeedAddress` | `0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70` | The `usdPriceFeed` the constants carry beside the base feed |
| `42161/weth` | `baseAsset.usdPriceFeedAddress` | `0x639fe6ab55c921f74e7fac1ee960c0b6293ba612` | The same |
| `59144/weth` | `baseAsset.usdPriceFeedAddress` | `0x3c6cd9cc7c7a4c2cf5a82734cd249d7d593354da` | The same |
| Ronin (2020) | `assetDisplayOverrides`, WRON's `displayAddress` | `0x0000000000000000000000000000000000000000` | The frontend keeps WRON's own address, but shows WRON as RON and supplies it as the native token, which is what the zero address says |
| Mantle (5000) | `assetDisplayOverrides`, WETH's `displayAddress` | `0xdeaddeaddeaddeaddeaddeaddeaddeaddead1111` | The frontend keeps the zero address, which marks a chain's own token, but Mantle's own token is MNT and the frontend only renames WETH to ETH, so WETH keeps its own address |

## Where it came from

Frozen on 2026-10-20, offline, from the proposal `src/registry/bootstrap.ts`
made at dev `56d75ffc2ba36d83c5ca0454c24defa8fdcd133a` — what its route
answered under `bundle` — for a first import of develop's markets: the 31
that `GET /market/all-networks/all-contracts/summary` listed on develop that
day, without its two test markets, `1/usdc-test-collateral-revert` and
`1/usdc-test-base-revert`, which no other source has. The proposal's digest
was `4897101575bb1d21`, and it left nothing to decide.

From that bundle, the file differs in three ways, none of which changes a
decision: every document is as the overlay parsers return it, which reorders
the lists of five network documents (1, 137, 5000, 42161 and 534352) and
changes no overlay digest; `reason` is fixed text, where the proposal named
its source and commit, and its digest left the reason out; and
`expectedDigests` is `null` for every document. It departs from the proposal
in no decision.

The script that froze it is kept outside the repository; the pull request
that checked the file in gives its command. It builds the file from that
proposal, so it runs only on a tree that has `src/registry/bootstrap.ts`. It
last ran at `fb34295`, the commit that checked the file in, and gave this
file byte for byte. At that commit,
`tests/lib/registry/seed-from-bootstrap.test.ts` held the file to the
proposal after parsing. `bootstrap.ts` and the proposal routes were removed
after that commit, so the file is now changed by hand
([Changing it](#changing-it)).

Develop's summary serves the 29 markets with the same labels: 174 of 174
values — display name, base asset name, wrapped native, slug, default,
institutional — are equal. One decision is known to differ from develop's
overlays: develop quotes `59144/weth`'s reward feed in `usd`, which it
inherited from before the proposal quoted it in the base asset, and the file
says `base`, which is right
([REGISTRY_RUNBOOK.md](../../REGISTRY_RUNBOOK.md#when-something-goes-wrong),
Linea WETH's reward price).
