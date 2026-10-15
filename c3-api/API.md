# Endpoints

## The market registry

Markets, tokens, and price feeds come from one activated registry version.
Every response whose content depends on it carries the version that answered:

```
X-Registry-Version:  8f1e0f3c-3b7a-4e8f-9a1b-1f0f0b9a2c44
X-Registry-Checksum: 1bd74ebe00d845e0fa5e648b22a2c39e60d9a62bf6c58190320fa01cd9a26a4a
```

Endpoints that resolve a market answer `503` with the code
`REGISTRY_NOT_ACTIVE` when no version is active, and `400` for an address the
active version does not describe. The registry's own endpoints are documented
under [Registry v1](#registry-v1).

When the database cannot be reached, a response may instead be computed from
the version that was active the last time it could. It then carries its age
in seconds and is not cacheable:

```
X-Registry-Stale: 137
Cache-Control:    no-store
```

A client that must not act on an older version refuses such a response; one
that only reads can use it. How long that is allowed is per environment, and
a `503` with the code `UPSTREAM_UNAVAILABLE` is the answer once the window has
passed. These endpoints and the registry's own fail the same way.

Testnets are not served: the registry imports mainnets only. A request that
names one is answered `400` in the [envelope](#errors), with the code
`TESTNET_NOT_SERVED` and a message naming what named it, rather than with
nothing or with mainnet data. It is refused before the registry is read, so
it is answered so while no version is active, or the database cannot be
reached, too:

- a testnet as the `{network}` of a market route, such as
  `/market/sepolia/all/summary`;
- `testnets=include` on a route over every network
  (`/market/all-networks/all-contracts/…`) or on `/account/{address}/rewards`;
- a testnet market in the `markets[]` of the transaction history.

```json
{ "error": { "code": "TESTNET_NOT_SERVED", "message": "testnets are not served: ethereum-sepolia", "requestId": "4f6c1a2e-…" } }
```

Any other value of `testnets` leaves them out, as it always has.

## Errors

An error is answered as JSON in one envelope, whichever endpoint answers it:

```json
{ "error": { "code": "REGISTRY_NOT_ACTIVE", "message": "No active registry snapshot is available", "requestId": "4f6c1a2e-…" } }
```

`code` is what a client branches on, `message` is for a person, and
`requestId` names the request in the worker's log: quote it when you report
one. Every `5xx`, `401` and `403` answer is logged under it, and so is the
outcome of every import an administrative sync runs; any other answer says
all there is to say about it, and is not logged. `details`, when present,
says more about the failure, such as the version a cursor was issued
against. A path no endpoint matches is a `404` with the code `NOT_FOUND` —
but one of four segments or more outside `/registry/v1/` is taken by the
pattern of the market and governance endpoints,
`/{resource}/{network}/{contract}/{endpoint}`, and answered as a malformed
parameter of theirs is (below), with a `400` such as `Error: Bad network …`
or `Error: Not a valid resource API`.

Outside the registry, a request a node provider did not serve is a `503`
with the code `UPSTREAM_UNAVAILABLE`: the node provider proxy failed it or
could not be reached, or answered a call with an error that is not a revert,
such as a rate limit. It can succeed later — after the seconds `Retry-After`
names, when the proxy said, which a browser can read. A call the contract
reverted is its answer instead: a price read reports it as a
[status](#market-status), and any other call that reverts fails the request
with a `500`. The registry's endpoints say how they answer either under
[Registry v1](#registry-v1).

A `500` is answered with the code `INTERNAL` and the message `the request
could not be completed`, never with what failed — a database error, or what
an upstream API such as Tally answered: that is in the log, under the
`requestId`. A request with a malformed parameter is the exception to the
envelope: the market, governance and account endpoints still answer it with
a `400` and a short message, as they always have — a line of plain text, or
`{"error": "…"}` from some market endpoints.

## Market status

Every price is read through its feed's `latestRoundData`, which reverts once
Chainlink retires the feed. So every market a market route answers — the
summaries, their history, the rewards routes and `/account/{address}/rewards`
— carries a `status`:

- `success`: everything was read.
- `partially` (summaries and history only): the base asset was priced, and at
  least one collateral was not — its feed reverted, or the Comet holds
  another asset at its index than the registry version describes. The totals
  leave that collateral out, and `collaterals` says which it was.
- `error`: the base asset could not be priced, or — for the rewards routes —
  a price the rewards are valued in: the reward token's, the base asset's, or
  the USD price a base-quoted reward is converted with. `/summary` still
  reports every field that does not need a price that failed — the section
  on `/summary` below says which — and its `total_collateral_value` leaves
  out a collateral that could not be priced, as in `partially`. Elsewhere —
  on the other routes, and on each such day of a history — only what
  identifies the market is reported, with the node's message:

```json
{ "chain_id": 1, "comet": { "address": "0xe85d…9293" }, "status": "error", "message": "execution reverted" }
```

`/market/{network}/{address}/rewards/summary` names no market in its answer,
so its `error` is `{ "status": "error", "message": … }` alone.

A summary lists every collateral with its own status:

```json
"status": "partially",
"collaterals": [
  { "address": "0xc00e…6888", "symbol": "COMP",  "status": "success" },
  { "address": "0x57f5…7812", "symbol": "wUSDM", "status": "error", "message": "execution reverted" }
]
```

A history reports this per day, with the day's `date` and `timestamp`. A
market is read in full again once a registry version that says how to price
the feed is active.

A market whose `creationBlock` in the active version is past the latest
block of its chain is `error` too, on every market route and on
`/account/{address}/rewards`, asked for alone or among others, and in a
history on every day. None of its values can be read, since every index of
a market starts at its creation block, and the other markets are answered
as usual. The message names the block:

```json
{ "chain_id": 1, "comet": { "address": "0x3Afd…0840" }, "status": "error", "message": "creationBlock 33400000 is past the latest block, 23400000" }
```

`/summary` answers it with what the registry version says of the market as
well, as it answers every market, since none of that is read: the rewards
contract and the bulker in `comet`, and the market's keys and labels after
it ([Market registry fields](#market-registry-fields)):

```json
{ "chain_id": 1, "comet": { "address": "0x3Afd…0840", "rewards": "0x1B0e…5a40", "bulker": "0xa397…00c7" }, "deployment_key": "usdt", "display_name": "USDT", "base_asset_name": "Tether", "is_wrapped_native": false, "is_default": false, "is_institutional": false, "status": "error", "message": "creationBlock 33400000 is past the latest block, 23400000" }
```

Writing an overlay refuses such a block, but a version can hold one that
write never checked — inherited by an import from an overlay written before
it did, say. The market is answered so until a version with the right block
is active, or until the chain reaches the block. From then on it is read
again, but its history repeats the day of that block for every day before
it, so the block still needs correcting.

Only these report a status this way: a node that does not answer still fails
the whole request, with `503 UPSTREAM_UNAVAILABLE`, and so does any other call
that reverts, with `500 INTERNAL` ([Errors](#errors)).

```json
{ "address": "0x1f98…f984", "symbol": "UNI", "status": "error", "message": "asset 3 of the Comet is 0x…, not the UNI the registry version describes" }
```

## Market labels

The rewards routes — `/market/all-networks/all-contracts/rewards/dapp-data`
and `/account/{address}/rewards` — name each market by the labels the registry
gives it: `base_asset.symbol` is the market's label and
`base_asset.description` its base asset's name — `ETH` and `Ether` for a WETH
market, `USDC.e` (`USDbC` on Base) and `USD Coin (Bridged)` for bridged USDC,
`USD₮0` where Tether renamed its token:

```json
{ "chain_id": 1, "comet": { "address": "0xa175…ae94" }, "base_asset": { "symbol": "ETH", "description": "Ether", … }, … }
```

`/summary` answers the same two labels as `display_name` and
`base_asset_name` ([Market registry fields](#market-registry-fields)), but
names each collateral by the token's own on-chain symbol (`WETH`). The
history does too, except where the network renames a token in place: bridged
USDC is `USDC.e` there, although its `symbol()` answers `USDC`. One token can
therefore appear under two names across the API, so match a market by
`chain_id` and `comet.address`, never by its symbol.

## Market registry fields

`/summary` answers, beside what it read of each market, what the active
registry version says of it, as `/registry/v1/active` serves the market.
`comet` names the market's Comet (`address`), then its rewards contract
(`rewards`) and its bulker (`bulker`): the market's `contracts.rewards` and
`contracts.bulker`. The rest comes right after `comet`, before `status`:

- `deployment_key` (`deploymentKey`): the market's key in the version, unique
  within its chain; with `chain_id` it names the market, such as `usdc`
- `display_name` (`displayName`): its label, such as `USDC`, `ETH` for a
  WETH market, or `USDC.e` — what the rewards routes answer as
  `base_asset.symbol`
- `base_asset_name` (`baseAsset.displayName`): its base asset's name, such
  as `USD Coin` or `Ether` — their `base_asset.description`
- `is_wrapped_native` (`baseAsset.isWrappedNative`): whether its base token
  wraps the chain's own token, as WETH does
- `slug`: the key the website links the market by, where the version gives
  one; without one the website links it by its label, so two markets of a
  network with the same label are told apart by a slug
- `is_default` (`isDefault`): whether it is the market the website opens
  first
- `is_institutional` (`isInstitutional`): whether the website lists it in
  its institutional section

```json
{ "chain_id": 1, "comet": { "address": "0xc3d6…cdc3", "rewards": "0x1B0e…5a40", "bulker": "0xa397…00c7" }, "deployment_key": "usdc", "display_name": "USDC", "base_asset_name": "USD Coin", "is_wrapped_native": false, "is_default": true, "is_institutional": false, "status": "success", … }
```

Each address is checksummed, as `address` is, where `/registry/v1/active`
writes it lowercase. What the version has none of — a rewards contract, a
bulker or a slug, which `/registry/v1/active` answers as `null` — is left
out. None of it is read, so every market has it whatever its `status`, one
the chain has not reached too ([Market status](#market-status)), and a
version that changes it is answered as soon as it is active.

Everywhere else `comet` is the Comet's `address` alone. The rewards routes
answer the rewards contract as `comet_rewards.address`, and the two labels
as `base_asset.symbol` and `base_asset.description`
([Market labels](#market-labels)). A day of a history answers none of it,
and `/market/{network}/{address}/rewards/summary` names no market.

## Pagination

Many endpoints are paginated for convenience. If an endpoint is paginated,
responses will include a `pagination_summary` about the returned page.

Clients can control pagination using query parameters:
- `page_size`   - [optional] - [default if not specified: 100]
- `page_number` - [optional] - [default 1]

Clients can navigate to the next page of a response by adding a
querystring like `?page_number=${response.page_number + 1}` to an
endpoint and `GET`ting it again.

## `/market/{network}/{address}/summary`
### description:

Point-in-time summary at the current block of various market statistics:
- Total collateral, supply and borrow value, in the unit the market's price
  feeds answer in: USD, or the base asset for a market quoted in it, such as
  ETH for a WETH market
- Borrow APR
- Supply APR
- Utilization, as the Comet answers it: a fraction scaled by 10^18
- The base asset's price in USD (`base_usd_price`)
- The base asset's price in the unit the market's price feeds answer in
  (`base_price`): what `total_supply_value` and `total_borrow_value` are
  valued at, so either divided by it is an amount of the base asset. It is
  `1.0` through a constant feed, as on a WETH or wstETH market, and WBTC in
  BTC on the WBTC market (`0.9984988`, say), whose feeds answer in BTC and
  whose `base_usd_price` is the price of BTC. On a market quoted in USD it is
  the same number as `base_usd_price` while both are read through one feed
  (below), but a total is still divided by `base_price`. It is written as
  `base_usd_price` is, and not rounded
- What the active registry version says of the market: its rewards contract
  and its bulker beside its Comet, in `comet`, and its keys and labels — see
  [Market registry fields](#market-registry-fields)
- What could be priced: `status`, and `collaterals` with each collateral's
  own status — see [Market status](#market-status)

The collaterals are those the active registry version describes for the
market, in the order the Comet numbers them, and named as the version names
them: a collateral the Comet listed after the version was imported is left
out until a version describes it, and the registry's chain check raises it
meanwhile ([REGISTRY_RUNBOOK.md](./REGISTRY_RUNBOOK.md#a-market-that-changed-on-chain)).
Where the Comet now holds another asset at a collateral's index, that
collateral is `error`, and its `message` names the asset the Comet holds
there. Each is priced through the feed the Comet reads for it at the block
summarized. A history lists instead the collaterals its Comet listed on each
day, named by their token's `symbol()`.

The base asset has two prices: its price in the market's unit,
`base_price`, through the base feed the Comet names, which values
`total_borrow_value` and `total_supply_value`; and its price in USD,
`base_usd_price`, through the feed the registry version names for it — on a
market quoted in USD, that same base feed while the version agrees with the
chain, so both fail together. The market is `error` where either could not
be read, with the node's message for the first where it failed, otherwise
for the second, and still reports every field that does not need a price
that failed: it leaves out `base_price`, `total_borrow_value` and
`total_supply_value` where the first failed, and `base_usd_price` where the
second did. The totals stay in the market's unit: on a market quoted in its
base asset they are in the unit its feeds answer in — ETH, wstETH or
BTC — and without `base_usd_price` nothing here converts them to USD. `total_collateral_value` leaves out each
collateral that is `error`, as in `partially`. A USDC market whose base
feed reverts, and which the version gives no rewards contract or bulker:

```json
{
  "chain_id": 1,
  "comet": { "address": "0xbc37…cCe8" },
  "deployment_key": "usdc-test-base-revert",
  "display_name": "USDC-br",
  "base_asset_name": "USD Coin",
  "is_wrapped_native": false,
  "slug": "usdc-test-base-revert",
  "is_default": false,
  "is_institutional": false,
  "status": "error",
  "message": "execution reverted",
  "borrow_apr": "0.014999999976144",
  "supply_apr": "0.0",
  "total_collateral_value": "0.0",
  "utilization": "0",
  "collateral_asset_symbols": [ "USDT", "WETH" ],
  "collaterals": [
    { "address": "0xdAC17F958D2ee523a2206206994597C13D831ec7", "symbol": "USDT", "status": "success" },
    { "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "symbol": "WETH", "status": "success" }
  ]
}
```

```sh
$ curl 'localhost:8787/market/mainnet/0xc3d688B66703497DAA19211EEdff47f25384cdc3/summary'
```
```json
{
  "chain_id": 1,
  "comet": {
    "address": "0xc3d688B66703497DAA19211EEdff47f25384cdc3",
    "rewards": "0x1B0e765F6224C21223AeA2af16c1C46E38885a40",
    "bulker": "0xa397a8C2086C554B531c02E29f3291c9704B00c7"
  },
  "deployment_key": "usdc",
  "display_name": "USDC",
  "base_asset_name": "USD Coin",
  "is_wrapped_native": false,
  "is_default": true,
  "is_institutional": false,
  "status": "success",
  "borrow_apr": "0.024456245200128",
  "supply_apr": "0.008780799134304",
  "total_borrow_value": "291934.56378333468",
  "total_supply_value": "802511.31504732864",
  "total_collateral_value": "736406.32667881067597418742582842",
  "utilization": "363775913612426560",
  "base_usd_price": "0.99996",
  "base_price": "0.99996",
  "collateral_asset_symbols": [ "COMP", "WBTC", "WETH", "UNI", "LINK" ],
  "collaterals": [
    { "address": "0xc00e94Cb662C3520282E6f5717214004A7f26888", "symbol": "COMP", "status": "success" },
    { "address": "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", "symbol": "WBTC", "status": "success" },
    { "address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "symbol": "WETH", "status": "success" },
    { "address": "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", "symbol": "UNI",  "status": "success" },
    { "address": "0x514910771AF9Ca656af840dff83E8264EcF986CA", "symbol": "LINK", "status": "success" }
  ]
}
```

## `/market/{network}/{address}/historical/summary`
### description:

30 days of historical `/summary`s — two in stage, and one in a local run —
one block sampled per day, oldest first, up to the most recent day sampled.
Each day carries its `date` and `timestamp`, and the fields of the summary
but `base_price` and what the registry version says of the market
([Market registry fields](#market-registry-fields)): its `comet` is the
Comet's `address` alone.

A day whose base asset could not be priced reports only what identifies the
market, with the node's message ([Market status](#market-status)).

```sh
$ curl 'localhost:8787/market/mainnet/0xc3d688B66703497DAA19211EEdff47f25384cdc3/historical/summary'
```
```json
[
  {
    "chain_id": 1,
    "comet": {
      "address": "0xc3d688b66703497daa19211eedff47f25384cdc3"
    },
    "status": "success",
    "borrow_apr": "0.014999999976144",
    "supply_apr": "0.0",
    "total_borrow_value": "0.0",
    "total_supply_value": "0.0",
    "total_collateral_value": "0.0",
    "utilization": "0",
    "base_usd_price": "1.0",
    "collateral_asset_symbols": [ "COMP", "WBTC", "WETH", "UNI", "LINK" ],
    "collaterals": [
      { "address": "0xc00e94Cb662C3520282E6f5717214004A7f26888", "symbol": "COMP", "status": "success" },
      ...
    ],
    "timestamp": 1660504680,
    "date": "2022-08-14"
  },
  ...,
  {
    "chain_id": 1,
    "comet": {
      "address": "0xc3d688b66703497daa19211eedff47f25384cdc3"
    },
    "status": "success",
    "borrow_apr": "0.024456245200128",
    "supply_apr": "0.008780799134304",
    ...,
    "timestamp": 1663006848,
    "date": "2022-09-12"
  }
]
```

Every day reads the base asset's USD price from the feed the active version
names: a day before that feed was deployed — before governance moved the
market to it, say — answers `error` ([Market status](#market-status)). A
collateral the version remaps to another feed (`deprecated_price_remap`) is
read from that feed, and where it does not answer — on a day before it was
deployed — from the feed its Comet named that day; the collateral is
`error`, and the day `partially`, only when neither answers.

A market whose creation block is past the latest block has no day to
sample ([Market status](#market-status)). It reports the same days as the
other markets of its network, each as its `error` with the day's `date` and
`timestamp`:

```json
{ "chain_id": 1, "comet": { "address": "0x3Afd…0840" }, "status": "error", "message": "creationBlock 33400000 is past the latest block, 23400000", "timestamp": 1758012347, "date": "2025-09-16" }
```

## `/market/{network}/{address}/rewards/summary`
### description:

Point-in-time summary at the most-recently-sampled block (which may not be
the 'latest' block per se) of rewards rates and APRs for a v3 market.

A market the active registry version gives no rewards — the Scroll and Ronin
markets, and a Comet with no rewards configured, such as mainnet ciUSDCv3 —
answers `404` rather than a summary, because there is no reward price to
value its rewards with:

```json
{ "error": { "code": "REWARDS_NOT_AVAILABLE", "message": "Rewards are not available for this market", "requestId": "4f6c1a2e-…" } }
```

`/market/{network}/{address}/rewards/dapp-data` lists the markets whose
rewards can be valued and leaves the others out, so for such a market it
answers an empty list rather than `404`.

```sh
$ curl 'localhost:8787/market/mainnet/0xc3d688B66703497DAA19211EEdff47f25384cdc3/rewards/summary'
```
```json
{
  "status": "success",
  "supply_rewards_apr": "0.01753045422122093652885",
  "borrow_rewards_apr": "0",
  "supply_rewards_rate_per_second": "0.000011574074074",
  "borrow_rewards_rate_per_second": "0.001145833333333"
}
```

## `/governance/{network}/all/proposals`
### description:

Aggregate of all governance proposals across Governors alpha and bravo.

Query parameters:
- Pagination: `page_size`, `page_number`
- `proposal_ids=123,124,...` [optional] - filter proposals to only those
  having one of the given ids, separated by commas in one parameter.

```sh
$ curl 'localhost:8787/governance/mainnet/all/proposals'
```
```json
{
  "proposals": [{
    "eta": 0,
    "title": "Risk Parameter Updates for 3 Compound V2 Assets",
    "proposer": {
      "image_url": "https://profile.compound.finance/1I3iRJq3n4aVeBhYcyL7bhxUpZOHZL-9R/nzKJc1EDRNNO87PtFH0XxQdObjdeQ14LUpiupTgcz2U=",
      "account_url": "http://gauntlet.network",
      "display_name": "Gauntlet",
      "address": "0x683a4f9915d6216f73d6df50151725036bd26c02"
    },
    "end_block": 16555597,
    "start_block": 16535887,
    "description": "## Simple Summary\n\nA proposal to adjust three (3) risk parameters (collateral factor & borrow cap) across three (3) Compound V2 assets. [... elided for example ...]",
    "id": 147,
    "for_votes": "320010.010736308276631616",
    "against_votes": "0.0",
    "actions": [
      {
        "data": "{long hexadecimal abi-encoded calldata string}",
        "value": "0.0",
        "title": "[Comptroller](https://etherscan.io/address/0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b)._setMarketBorrowCaps([\"[cYFI](https://etherscan.io/address/0x80a2ae356fc9ef4305676f7a3e2ed04e12c33946)\"], [30000000000000000000])",
        "target": "0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B",
        "signature": "_setMarketBorrowCaps(address[],uint256[])"
      },
      ...
    ],
    "states": [
      {
        "state": "pending",
        "start_time": 1675119155,
        "end_time": 1675277981,
        "transaction_hash": "0x2aa0c68b2f434610189d69fb8e2bdc0ac4cfd7a913f48ed0c6b7ea5d798b572c"
      },
      {
        "state": "active",
        "start_time": 1675277687,
        "end_time": 1675515881
      }
    ]
  }, ...],
  "pagination_summary": {
    "page_size": 100,
    "page_number": 1,
    "total_pages": 2,
    "total_entries": 147
  }
}
```

## `/governance/{network}/all/proposal_vote_receipts`
### description:

Aggregate of proposal vote receipts across Governors alpha and bravo. Must
be filtered by at least one of account (by address) or proposal (by id).

Query parameters:
- Pagination: `page_size`, `page_number`
- One of `account` or `proposal_id` is _required_
- `account` - voter account address for which to retrieve vote receipts
- `proposal_id` - proposal id for which to retrieve vote receipts
- `support` - `true` or `false` - [optional] - [default undefined]
  - `true` filters receipts to votes `For`;
  - `false` filters receipts to votes `Against`;
  - `undefined` returns receipts regardless of vote direction
- `with_proposal_data` - `true` or `false` - [optional] - [default false]
  - `true` populates the `"proposal"` field of the response
  - `false` sets the `"proposal"` field to `null` (this is the default)

Proposal:

```sh
$ curl 'localhost:8787/governance/mainnet/all/proposal_vote_receipts?proposal_id=147`
```
```json
{
  "proposal_vote_receipts": [
    {
      "proposal_id": 147,
      "proposal": null,
      "voter": {
        "image_url": "https://profile.compound.finance/1LFz91R1wl7kkYjjVFQ9uvB2h0jWPqb00/GtDl1nWWOiGk4SNbZ1+eEpNPU+8v6Nz/uVEVPWTMRhc=",
        "account_url": null,
        "display_name": "Robert Leshner",
        "address": "0x88fb3d509fc49b515bfeb04e23f53ba339563981"
      },
      "support": null,
      "votes": "186754.192640718136614743"
    },
    {
      "proposal_id": 147,
      "proposal": null,
      "voter": {
        "image_url": "https://profile.compound.finance/1vxjBH3ddZtM_p_Bi1TpcHvsaYP67nz7M/A+8p1Wj7ZbWuVMYfaR+IIkqZxvHcS9Y4rczaZiU/7eE=",
        "account_url": "https://twitter.com/MonetSupply",
        "display_name": "MonetSupply",
        "address": "0x8d07d225a769b7af3a923481e1fdf49180e6a265"
      },
      "support": true,
      "votes": "70005.238935992282967464"
    },
    ...
  ],
  "pagination_summary": {
    "page_size": 100,
    "page_number": 1,
    "total_pages": 1,
    "total_entries": 23
  }
}
```

Account:

```sh
$ curl 'localhost:8787/governance/mainnet/all/proposal_vote_receipts?account=0x8169522c2c57883e8ef80c498aab7820da539806`
```
```
{
  "proposal_vote_receipts": [
    {
      "proposal_id": 146,
      "proposal": null,
      "voter": {
        "image_url": "https://profile.compound.finance/19mpm2y_kPC8HdbzW50ercV93JE7Tnx_2/j3OputhhpMt8atjfg1M/pvLwYbAnQNqG1kf7bgxq6Ao=",
        "account_url": "https://twitter.com/justHGH",
        "display_name": "Geoffrey Hayes",
        "address": "0x8169522c2c57883e8ef80c498aab7820da539806"
      },
      "support": true,
      "votes": "101000.024654469732833014"
    },
    {
      "proposal_id": 129,
      "proposal": null,
      "voter": {
        "image_url": "https://profile.compound.finance/19mpm2y_kPC8HdbzW50ercV93JE7Tnx_2/j3OputhhpMt8atjfg1M/pvLwYbAnQNqG1kf7bgxq6Ao=",
        "account_url": "https://twitter.com/justHGH",
        "display_name": "Geoffrey Hayes",
        "address": "0x8169522c2c57883e8ef80c498aab7820da539806"
      },
      "support": true,
      "votes": "101000.024654469732833014"
    },
    ...
  ],
  "pagination_summary": {
    "page_size": 100,
    "page_number": 1,
    "total_pages": 1,
    "total_entries": 27
  }
}
```

## `/governance/{network}/comp/accounts`
### description:

Aggregate of COMP-holder account addresses that participate in governance,
ordered by their delegated voting power (not by their actual COMP
balance).

Query parameters:
- Pagination:
  - `page_size` [default 5]
  - `page_number`
  - `addresses` - account addresses to filter down to from all accounts

```sh
$ curl 'localhost:8787/governance/mainnet/comp/accounts'
```
```json
{
  "accounts": [
  {
    "address": "0xea6C3Db2e7FCA00Ea9d7211a03e83f568Fc13BF7",
    "display_name": "Polychain Capital",
    "image_url": "https://static.tally.xyz/7b888910-fdfb-40af-84b1-09847c6054b2_400x400.jpg",
    "account_url": null,
    "balance": "0.11499365783869876",
    "votes": "330977.3351898968",
    "vote_weight": "330977.3351898968",
    "rank": 1,
    "proposals_voted": 39,
    "total_delegates": 160
    },
    {
    "address": "0x61258f12C459984F32b83C86A6Cc10aa339396dE",
    "display_name": "Bain Capital Ventures",
    "image_url": "https://static.tally.xyz/ec86fb34-7b21-4288-966f-37ace859bd9d_400x400.jpg",
    "account_url": null,
    "balance": "0",
    "votes": "256766.59314398907",
    "vote_weight": "256766.59314398907",
    "rank": 2,
    "proposals_voted": 4,
    "total_delegates": 60
    },
    {
    "address": "0x9AA835Bc7b8cE13B9B0C9764A52FbF71AC62cCF1",
    "display_name": "a16z",
    "image_url": "https://static.tally.xyz/c8cb82c3-dc7d-4abb-8944-681fb9367df0_400x400.jpg",
    "account_url": null,
    "balance": "0",
    "votes": "256018.63638743947",
    "vote_weight": "256018.63638743947",
    "rank": 3,
    "proposals_voted": 36,
    "total_delegates": 306
    },
    {
    "address": "0x8169522c2C57883E8EF80C498aAB7820dA539806",
    "display_name": "Geoffrey Hayes",
    "image_url": "https://static.tally.xyz/b561b1a4-f258-418f-9dab-c80220d7d7ab_400x400.jpg",
    "account_url": null,
    "balance": "0",
    "votes": "101000.02465446974",
    "vote_weight": "101000.02465446974",
    "rank": 4,
    "proposals_voted": 17,
    "total_delegates": 17
    },
    {
    "address": "0x8d07D225a769b7Af3A923481E1FdF49180e6A265",
    "display_name": "MonetSupply",
    "image_url": "https://static.tally.xyz/4d829585-3f22-4042-a21c-c14bec45e81a_400x400.jpg",
    "account_url": null,
    "balance": "0",
    "votes": "70002.9378630117",
    "vote_weight": "70002.9378630117",
    "rank": 5,
    "proposals_voted": 79,
    "total_delegates": 25
    }
  ]
}
```

## `/governance/{network}/comp/history`
### description:

High level metadata for COMP governance, including the COMP (governance token)
remaining to distributed, the number of votes delegated with COMP, the number
of addresses with votes, and the number of proposals created so far (to be voted on).

NOTE: `comp_remaining` is calculated as the sum of COMP balances across Timelock,
Comptroller and Reservior, which is slightly different from the corresponding field
`total_comp_allocated` in the equivalent V2 endpoint. This is OK as discussed in
https://discord.com/channels/402910780124561410/796451735803002900/1070420107429421076

```sh
$ curl 'localhost:8787/governance/mainnet/comp/history'
```

```json
{
  "votes_delegated": "2649756.603949650754462612",
  "voting_addresses": 4824,
  "proposals_created": 147,
  "comp_remaining": "2481940.263123554206402576",
}
```

## `/governance/{network}/comp/distribution`
### description:

High level data around COMP distribution, including the rate that COMP is
being distributed daily and the remaining COMP left to be distributed.
Also includes COMP distribution data per cToken market.

```sh
$ curl 'localhost:8787/governance/mainnet/comp/distribution'
```
```json
{
  "comp_rate": "0.176",
  "daily_comp": "1267.20",
  "markets": [
    {
      "address": "0xb3319f5d18bc0d84dd1b4825dcde5d5f7266d407",
      "symbol": "cZRX",
      "underlying_address": "0xe41d2489571d322189246dafa5ebde1f4699f498",
      "underlying_name": "0x",
      "underlying_symbol": "ZRX",
      "supplier_daily_comp": "0.00",
      "borrower_daily_comp": "0.00",
    },
    {
      "address": "0x5d3a536e4d6dbd6114cc1ead35777bab948e3643",
      "symbol": "cDAI",
      "underlying_address": "0x6b175474e89094c44da98b954eedeac495271d0f",
      "underlying_name": "DAI",
      "underlying_symbol": "DAI",
      "supplier_daily_comp": "241.20",
      "borrower_daily_comp": "241.20",
    },
    ...
  ]
}
```

## `/legacy/mainnet/ctokens`
### description:

Retreive Compound V2 CTokens data

```sh
$ curl 'localhost:8787/legacy/mainnet/ctokens'
```
```json
{
   "cToken":[
      {
         "name":"Compound 0x",
         "underlying_name":"0x",
         "symbol":"cZRX",
         "underlying_symbol":"ZRX",
         "token_address":"0xb3319f5d18bc0d84dd1b4825dcde5d5f7266d407",
         "underlying_address":"0xe41d2489571d322189246dafa5ebde1f4699f498",
         "borrow_rate":"0.04409829738476745",
         "supply_rate":"0.0019605539072082845",
         "borrow_cap":"1000000.0",
         "collateral_factor":"0.65",
         "comp_borrow_apy":"0",
         "comp_supply_apy":"0",
         "exchange_rate":"0.0206015410768160280046446513",
         "reserve_factor":"0.25",
         "reserves":"1788100.867423172906350829",
         "total_borrows":"464884.6338852752485902",
         "total_supply":"372902485.32525833",
         "underlying_price":"0.249232",
         "total_supply_value":"1914691.41028132422080528337928",
         "total_borrow_value":"115864.1270724949207566327264"
      },
      ...
   ]
}
```

## `/legacy/mainnet/gas-price`
### description:

Retreive gas prices for Ethereum mainnet.

```sh
$ curl 'localhost:8787/legacy/mainnet/gas-price'
```
```json
{
   "fastest":{
      "value":"23000000000"
   },
   "fast":{
      "value":"23000000000"
   },
   "average":{
      "value":"23000000000"
   },
   "safe_low":{
      "value":"23000000000"
   }
}
```

## `/account/{account_address}/transaction_history`
### description:

Retrieves comet transaction history for a given account address.

Query parameters:
- `limit` (optional): number of max items to retrieve. Default and max is 15.
- `markets[]` (optional): array of markets filter to be included in the response. Default is every market whose history the active version serves. A market of a testnet is refused with `TESTNET_NOT_SERVED` ([The market registry](#the-market-registry)). (e.g. filter only Ethereum cUSDCv3 market `markets[]=1_0xc3d688B66703497DAA19211EEdff47f25384cdc3`)
- `actions[]` (optional): array of actions to filter transactions by. Default is all actions. (e.g. filter only borrow actions `actions[]=Borrow`)
- `cursor` (optional): The first response (with no cursor parameter) will return with a cursor value, to pass that cursor value will allow request to get more transaction history further in the past.

A cursor holds a position in the logs of each market it reads. It stays
valid across registry versions that read the same markets — a rollback, a new
import of the same source, a market given a new label — and each page names
the version that answered it. A version that reads other markets ends it, as
every version ends a cursor issued before the registry, whatever that one
reads: the request answers `409`, and the client restarts pagination without
a cursor. `cursorRegistryVersionId` names the version the cursor was issued
against, and is `null` for a cursor issued before the registry:

```json
{
  "error": {
    "code": "REGISTRY_VERSION_CHANGED",
    "message": "the markets of the registry changed; restart pagination without a cursor",
    "requestId": "4f6c1a2e-...",
    "details": {
      "cursorRegistryVersionId": "8f1e0f3c-...",
      "registryVersionId": "b2c4d6e8-..."
    }
  }
}
```

A value that is not a cursor this API handed out is a `400` with the text
`Cursor is invalid`.

```sh
$ curl 'localhost:8787/account/0xcfc50541c3dEaf725ce738EF87Ace2Ad778Ba0C5/transaction_history?limit=30&actions[]=Borrow&markets[]=1_0xc3d688B66703497DAA19211EEdff47f25384cdc3'
```
```json
{
  "done": true,
  "cursor": "6e6069b3ebd443fef9538aa8f22ffc087e5429264f8dce214c7bda1efc5817cc",
  "item_count": 12,
  "item_limit": 15,
  "items": [
    {
      "transaction_hash": "0x0b10edd47ea1611a701579f0c4541da188c0c341b08808079d5f730c68e27234",
      "timestamp": 1678499891,
      "network": {
        "chain_id": 1,
        "alias": "mainnet"
      },
      "initiated_by": {
        "image_url": null,
        "account_url": null,
        "display_name": null,
        "address": "0xcfc50541c3deaf725ce738ef87ace2ad778ba0c5"
      },
      "item_type": "Bulk",
      "actions": [
        {
          "action_type": "Borrow",
          "event_type": "Withdraw",
          "contract": {
            "address": "0xc3d688b66703497daa19211eedff47f25384cdc3"
          },
          "token": {
            "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            "symbol": "USDC"
          },
          "amount": "500000.0"
        }
      ]
    },
    {
      "transaction_hash": "0x26c71588d841fb9826b4ffe0326b899bcf592453b7082d05094bd059f0e72595",
      "timestamp": 1678491743,
      "network": {
        "chain_id": 1,
        "alias": "mainnet"
      },
      "initiated_by": {
        "image_url": null,
        "account_url": null,
        "display_name": null,
        "address": "0xcfc50541c3deaf725ce738ef87ace2ad778ba0c5"
      },
      "item_type": "Unit",
      "actions": [
        {
          "action_type": "Borrow",
          "event_type": "Withdraw",
          "contract": {
            "address": "0xc3d688b66703497daa19211eedff47f25384cdc3"
          },
          "token": {
            "address": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
            "symbol": "USDC"
          },
          "amount": "1440000.0"
        }
      ]
    }
    ...
  ]
}
```

# Registry v1

Everything under `/registry/v1` is answered by the registry, including its
errors, which use the [envelope](#errors) every endpoint uses:

```json
{ "error": { "code": "CONFLICT", "message": "...", "requestId": "...", "details": { "code": "SYNC_ALREADY_RUNNING" } } }
```

`error.code` is the kind of answer: `BAD_REQUEST` (400), `UNAUTHORIZED`
(401), `FORBIDDEN` (403), `NOT_FOUND` (404), `METHOD_NOT_ALLOWED` (405),
`CONFLICT` (409), `PAYLOAD_TOO_LARGE` (413), `UNPROCESSABLE` (422),
`RATE_LIMITED` (429), `REGISTRY_NOT_ACTIVE` (503), `UPSTREAM_UNAVAILABLE` (503)
and `INTERNAL` (500); the market endpoints add `REWARDS_NOT_AVAILABLE` (404),
`REGISTRY_VERSION_CHANGED` (409) and `TESTNET_NOT_SERVED` (400), described
with them. A failure the registry names more precisely — an import, a chain
read, an overlay — carries its own code in `details.code`, such as
`SYNC_ALREADY_RUNNING` or `OVERLAY_FEED_UNREADABLE`, under the kind of answer
it is; a monitor matches `details.code` for those. Besides
`REGISTRY_NOT_ACTIVE`, only a source or a node provider that did not answer,
and a database that could not be reached, are a `503`, here as on every
endpoint ([Errors](#errors)): those are the answers worth trying again.

Public reads are cacheable and carry `ETag`, `X-Registry-Version` and
`X-Registry-Checksum`, which a browser can read, and answer `304` to an
`If-None-Match` that names what they would send. The tags are compared
weakly, as RFC 9110 has it: `W/"…"`, which is what a browser sends back for a
response Cloudflare compressed, names the same as the tag itself; `*` names
any; and a list of tags names what any tag in it names. A header that is none
of those is answered with the body, and so is every request while an answer
comes from the cache because the database cannot be reached. They answer
`503 REGISTRY_NOT_ACTIVE` when no version is active, and
`503 UPSTREAM_UNAVAILABLE` when the database cannot be reached and no older
version may be served instead. A path is matched with or without a trailing
slash.

A `{chain_id}` is written in decimal without a leading zero — `1`, never
`01`, `0x1`, `1e0` or `1.0` — in every path that takes one and in the keys of
`PUT …/overlays`, and is at most 9007199254740991; anything else is `400`,
so that one resource has one URL.

Administrative routes require `Authorization: Bearer <token>` — a `401` names
the scheme in `WWW-Authenticate` — and answer no CORS headers at all. An
environment without a token hash it can use — none at all, or a value that is
not 64 hex digits — answers every administrative request `403 FORBIDDEN`,
whatever token it carries, and the message says which. Every administrative
request is rate limited twice, reads as well as commands:

- First, before its token is checked or its path is matched, by the address
  it comes from: 60 a minute for each address — for each /64 of an IPv6
  one, since a client can send from any address of its /64. Guessing a token,
  or a path, costs as much as a request with the right one, and once an
  address has spent its budget the right token is refused from it as well.
- Then, once it is authenticated, by its token: 30 a minute for each token
  and each family of routes. Every read shares one budget, so a monitor
  polling the status spends it with an operator who holds the same token, and
  each kind of command has one of its own.

Past either budget the answer is `429` `RATE_LIMITED`, saying in
`Retry-After` how many seconds to wait, and in its message which budget ran
out: `too many administrative requests from this address`, or
`too many <family> requests with this token`.

A command's body is at most 64 KiB — 512 KiB for `PUT …/overlays` — and a
larger one is refused with `413`. A `reason`, wherever a command takes one, is
at most 1,000 characters, and a longer one is refused with `400`.

## `/registry/v1/active`
### description:

The whole activated snapshot: networks, their markets, and the presentation
and price-exception data an application needs to render them. This is the
bootstrap read; everything below serves parts of the same version.

A `disabled` market is part of the version but is served by no public read,
and a network whose every market is disabled is not listed at all: a chain
the source has just added arrives that way, under its canonical name and
with nothing about it reviewed, until a version decides to offer it.

```sh
$ curl 'localhost:8787/registry/v1/active'
```

## `/registry/v1/networks`
### description:

The networks of the active version that serve a market, without their
markets.

## `/registry/v1/networks/{chain_id}/markets`
### description:

The markets of one chain that are not `disabled`, in the same order the
snapshot lists them. A chain the active version does not list answers `404`.

## `/registry/v1/networks/{chain_id}/markets/{comet_address}`
### description:

One market, addressed by its Comet. A `disabled` market answers `404`; a
`deprecated` one is served, because positions and history in it must stay
reachable.

## `/registry/v1/versions/{version_id}`
### description:

A validated version by id, so a session that pinned one can refetch exactly
what it pinned even after another version was activated. It is the same
representation as `/registry/v1/active` for the same version, with the same
`ETag`, and a client that sends it back is answered `304` without the
version being read again.

## `POST /registry/v1/admin/sync`
### description:

Starts or continues an import. `sourceCommitSha` pins an explicit commit,
`forceNewAttempt` rebuilds an attempt, and `holdForReview` leaves the
candidate open once no root is left to attempt, so a market the source added
can be reviewed before the version validates (a run that gave roots up leaves
a draft that cannot validate, as below); each of the three is a decision
rather than routine scheduling, requires a `reason`, and is acted on when it
is sent — the daily discovery interval and the retry rules below apply only
to a request with none of them. A `reason` without one of the three is refused
with `400`: a routine sync has no decision to keep it with. The first import
of an environment is held regardless. `markets` bounds how many markets this
request imports, from 1 to 50, and defaults to 50. Answers with the run, the
version it is importing into, and `heldForReview`: `202` while the import has
work left for a later request (`running`), and `200` when this request is the
whole answer — the import `completed`, or there was nothing to do (`idle`).
`idle` says why in `reason`: discovery is not due, since the source is checked
once per interval, or the commit's candidate is held or was rejected, as
below. A held or rejected candidate is named in `registryVersionId`; discovery
that is not due names none, even when the hourly job has imported a commit
within the interval — `GET /registry/v1/admin/status` lists what it made under
`candidates`: a held draft, such as an environment's first, under `importing`,
and a version waiting to be switched on under `validated`.

A request that does read the source, and finds its commit — the one the
tracked ref names, or its `sourceCommitSha` — already imported as a version
that validated, imports nothing and starts no run, unless it carries
`forceNewAttempt`. It answers `200` `completed` with `outcome` `no_change`,
`syncRunId` `null`, that version in `registryVersionId`, and `reason`
`the commit is already imported`. While a newer draft of that commit is open
— one forced and held for review over that version, say — the answer is
`idle` instead, naming the draft, as above. Only `outcome` `imported` says
that the request's run produced a version, so a script that acts on a new
version branches on `outcome`, not on `status`.

Discovery does not import a commit again by itself once its newest attempt
imported every root and still ended invalid: the same source, chain and
decisions would fail the same way. It answers `idle`, naming that attempt in
`registryVersionId`, and `GET /registry/v1/admin/status` names the commit;
a request with `forceNewAttempt`, or a new commit on the tracked ref,
imports it. An attempt that ended invalid because some of its roots never
imported is tried again — an interval after it started, then two intervals
after the next one started, four, and at most eight — and until then the
answer is `idle`, with the time it is tried again in `reason`.

An import is resumable, and one request does not have to finish it. A request
that leaves work behind answers `running` with how far the run has got:

```json
{ "status": "running", "processed": 23, "expected": 29, "completed": 23, "outstanding": 6 }
```

`expected` is how many roots the commit has, `completed` how many are
imported, and `outstanding` how many are still to attempt — a root whose read
failed goes back into the pool and is attempted again by the next request, so
the count of markets one request processes varies. Send the same request with
an empty body until the answer says `completed`.

With `markets` left at its default, one request has the budget for the whole
source of today: its 29 markets take about 230 of the 10,000 subrequests a
Worker invocation has on the Workers Paid plan. Such a request answered
`running` was cut short, most often by a source or a node provider that did
not answer, or not in time, and the next request continues where it stopped.

A root gets five attempts, after which it is abandoned and the candidate
cannot validate. Those attempts are for the root being wrong. A request that
imports some markets and then loses the node provider, or runs out of what a
Worker is given in one invocation, fails the rest without spending their
attempts: that failure is about the invocation, not about them. An invocation
that imports nothing at all does spend them, so a source or a chain that
answers for nothing ends the run instead of holding it open forever. A root
the database fails under — restarted to update its code, say, or overloaded —
records `the database did not answer`, and a later request attempts it again.
It spends its attempt whether or not the request has imported a root, unless
D1 says the connection to it was lost or a statement ran out of its time or
CPU: such an attempt is given back once the request has imported a root, as
for the node provider. An
invocation stopped outright while it imports a root — by a deploy, or past
the time or CPU a Worker is given — writes nothing more, and spends that
root's attempt: the invocation that takes the run over records it as failed,
as `the invocation importing this root did not finish`.

A commit, an attempt and the decision to hold a candidate all belong to the
run that was created with them, so a request that would continue an existing
run and carries `sourceCommitSha`, `forceNewAttempt` or `holdForReview` is
refused with `409`, `details.code` `SYNC_ALREADY_RUNNING`, rather than
silently ignoring them. The same answer is given, before the source is asked
anything, to a request sent while another invocation holds the run's lease:
send it again once that invocation has finished its part. An invocation that
fails gives the lease back as it fails, unless the database is still not
answering when it tries; the worker then logs `registry lease not released`,
with the run's id. Such a lease, like that of an invocation stopped outright —
by a deploy, or past the time or CPU a Worker is given — is held until it runs
out (`COMET_SYNC_LEASE_SECONDS`, 15 minutes by default), and the answer is the
same although nothing is importing.

A held candidate is validated too, so its diagnostics can be read, but keeps
its `importing` status: `checksFailed` says how many of its checks failed, and
is `0` for one that would validate as it stands. A candidate is held once no
root is left to attempt, whether or not the run gave roots up. One that did —
a first import, say, that lost the node provider — answers with `completed`
below `expected`, and `reason` says how many it gave up: the candidate cannot
validate without them. A candidate another invocation is importing into is
not one held for review. An overlay written to a candidate while its import
is checking it stops that check rather than being decided by it: the answer
is `running`, and the next request checks the candidate as it then is.

When the import fails, the answer says whether trying again can help. A
request the registry refuses answers with the status its code maps to, and
the code in `details.code`: a `sourceCommitSha` the tracked ref cannot reach
is `422` with `SOURCE_COMMIT_UNREACHABLE`, and so is a source that answered
with something the import cannot use, such as a tree too large to list
(`SOURCE_TREE_TRUNCATED`) or a file past its size limit
(`SOURCE_CONTENT_TOO_LARGE`): it would answer the same way again. A candidate
that failed its checks is `422` with `syncRunId` and `registryVersionId` in
`details`, to read its validation by. A database that did not answer is
`503`, and so is GitHub not answering while the import looks for the commit
— the ref, its tree, or whether the ref reaches a `sourceCommitSha` — with
`SOURCE_REQUEST_FAILED`: both are worth trying again. So is one of those
requests that has not answered within 20 seconds, and GitHub refusing one
over its rate limit, whose message says until when. Such a request can be
sent again at once — after that time, for a rate limit — unless the database
was still not answering when the invocation tried to give its run back (see
above). One with `sourceCommitSha`, `forceNewAttempt` or `holdForReview` may
have started its run before it failed: sent again as it was, it is refused
with `409`, and an empty body continues the run. A market whose own reads
fail — its root from GitHub, or the chain through the node provider proxy,
which is given 30 seconds a batch — does not fail the request: its root
records why (`SOURCE_REQUEST_FAILED`, `CHAIN_REQUEST_FAILED`), the request
goes on with the next market, and a later request attempts the root again,
within its five attempts.
A setting of the environment the import does not take is `422` with
`SOURCE_CONFIGURATION_INVALID`, naming it. Anything else is a fault — most
often a database without the migrations the release needs — and answers
`500 INTERNAL` with a `requestId`; the worker logs it whole as
`registry sync failed unexpectedly`.

An invocation that fails while it holds the run keeps why as the run's
`lastError`, which `GET /registry/v1/admin/status` shows under
`sync.lastRun`, unless what failed was a service that did not answer. A run
that every invocation fails on the same way before it imports a root — on a
decision the active version stores that a later release no longer takes,
say — spends no attempt and never ends by itself. Every sync answers with
that failure: `400` with `OVERLAY_INVALID` and a message that names the
version rather than a root, for a stored decision, and `500 INTERNAL` for a
fault, whose `lastError` is `an unexpected error interrupted the import`.
`POST /registry/v1/admin/sync-runs/{sync_run_id}/cancel` ends such a run.

## `GET /registry/v1/admin/status`
### description:

Whether the registry is healthy, in one answer: the active version and who
switched it on, whether its bytes are cached (`cache.snapshotCached`) and the
cache could be read at all (`cache.readable`), when the source was last
checked, the last import run, the candidates still open, and the registry
settings the environment sets to something they do not take
(`configuration.invalid`, by name). A database that cannot be reached answers
`503 UPSTREAM_UNAVAILABLE`, which a monitor tells apart from a fault, a `500`.
A daily check of the source that finds nothing to import starts no run: it
moves `sync.upstreamCheckedAt` alone, and `sync.lastRun` stays the last
import.

`chainCheck` is the last time the hourly job held a version against the chain:
`checkedAt` is the hour of the invocation that did, and `versionId` names the
version. Once a day, at the first hourly invocation of the day (UTC) —
whatever the import finds, an unchanged commit included, and whether that
invocation or an administrative sync checked the source — it reads again what
an import reads from each served market's Comet: the feed of its base asset,
and each collateral asset with the feed that prices it. The status reports
what that check found and asks the chain nothing itself:

- `drifts` lists each fact the chain now answers otherwise, with the network,
  the market (`chainId/deploymentKey`) and its Comet, the asset — the base
  asset, or a collateral by its index, with its token and symbol — the
  `field` (`priceFeed`, or `token` for a collateral the chain added, removed
  or replaced at that index), what the version stores (`stored`), what the
  chain answers (`current`), and when the chain last answered it so
  (`seenAt`).
- `unreadable` lists the networks whose chain did not answer, with why.
  Nothing new is known about them: a drift found there before stays in
  `drifts`, with the `seenAt` of the last read that found it, and nothing
  else is raised for them. They are read again at the next hourly invocation.

A version switched on is checked at the next hourly invocation, within the
hour. Until then `chainCheck` is still the check of the version before it,
under that version's `versionId`, and its drifts stay raised. `chainCheck` is
`null` until a version has been checked. Nothing is changed or switched on
because of it.

Each version under `candidates.validated` carries `unserved`: the markets of
the active version whose Comet it serves under no key of the same chain, by
their keys in the active version, or `[]`.

`alerts` is that state reduced to the conditions worth acting on, so a monitor
can check that it is empty without knowing the registry's rules:

| Alert | Means |
|---|---|
| `configuration-invalid` | a registry setting is set to something it does not take — a number that is not a whole number in its range, or a repository or ref that names no source; `configuration.invalid` names each. The import refuses to start while one of its own is invalid, and a read takes the default in its place |
| `no-active-version` | nothing is activated, so every market route answers `503` |
| `candidate-awaiting-review` | a draft is held for review and no import is running: somebody has to review it and validate it, or discard it |
| `candidate-awaiting-activation` | a version newer than any ever switched on validated, and is waiting to be — what the scheduled import produces for a new commit; `candidates.validated` lists it. It holds until a version at least that new is switched on |
| `candidate-drops-markets` | a version `candidates.validated` lists would stop serving a market the active version serves: its `unserved` names each, by its key in the active version — a deployment the source dropped, renamed to a key nobody has reviewed, or whose key it gave to another Comet, or a market a review switched off. Nothing holds such a version back, and it can be switched on; `GET /registry/v1/admin/versions/{version_id}/changes` says where each Comet went (`markets.unserved`). It holds until a version at least that new is switched on |
| `commit-rejected` | the newest version imported every root of its commit and is invalid, so discovery no longer imports that commit by itself; `sync.rejectedCommit` names it. It holds until a newer version exists — a forced attempt, or a new commit |
| `chain-drift` | the version on stores a price feed or a collateral asset its market's Comet no longer answers with: governance changed the market on chain after the import, and the source did not move; `chainCheck.drifts` names each. It holds until a check of the version on finds it agrees with the chain — a version imported again with `forceNewAttempt`, which reads the chain anew, switched on, and checked at the next hourly invocation — or the chain changes back. A version switched on is taken to drift as the one before it did until it has been checked, and a network the check could not read keeps the drifts last found there |
| `last-sync-failed` | the most recent import run ended `failed`, and `sync.lastRun.lastError` says how: `validation failed` is a draft that failed its checks, which `GET /registry/v1/admin/versions/{version_id}` lists for the version `sync.lastRun.registryVersionId` names, and `cancelled by <actor>: <reason>` a run somebody cancelled. A root that fails does not fail the run, and neither do the checks of a run held for review: it completes, its draft left open |
| `sync-failing` | the import that is running keeps failing: the last root it attempted failed, or an invocation has failed since before attempting one, and the roots left failed have spent two attempts or more between them — two roots once, or one root twice. One failure raises nothing, and neither does an attempt given back because the invocation had imported a market before it lost GitHub, the node provider or its connection to the database. An attempt whose invocation was stopped in the middle of it — a deploy, or a Worker past its time or CPU — has failed too, once that invocation's lease has run out. Each attempt moves the run, so attempts that fail never leave it stalled. It ends once no root is left to attempt, each imported or given up after five attempts, and one that gave roots up then ends `failed`, its draft unable to validate without them, unless it is held for review: then it completes, its draft left open. An invocation that fails before it attempts a root moves nothing: a run every invocation fails on that way is `sync-stalled` as well |
| `sync-stalled` | a run says it is running, no invocation holds its lease — given back by an invocation that left work behind or failed, or run out — and none of its roots has moved for two hours, by when two hourly invocations should have continued it |
| `sync-overdue` | the source has not been checked for more than twice the configured interval |
| `snapshot-not-cached` | the active version's bytes are not in the cache, so every cold isolate hydrates it from D1 again |
| `cache-unreadable` | the KV namespace did not answer at all: there is no cache, and no fallback if the database fails next |

```sh
$ curl -s "$API/registry/v1/admin/status" -H "Authorization: Bearer $TOKEN" | jq
```
```json
{
  "environment": "stage",
  "checkedAt": "2026-09-23T09:12:41.004Z",
  "configuration": { "invalid": [] },
  "active": {
    "versionId": "d9698ddd-ab86-46bc-a412-c71df7d20414",
    "checksum": "1bd74ebe00d845e0fa5e648b22a2c39e60d9a62bf6c58190320fa01cd9a26a4a",
    "activatedAt": "2026-09-21T18:44:02.881Z",
    "activatedBy": "registry-admin:stage",
    "ageSeconds": 138518
  },
  "cache": { "snapshotCached": true, "pointerAgeSeconds": 412, "readable": true },
  "sync": {
    "lastRun": {
      "id": "0d0b3c4e-1d5c-4f0e-9d0a-2a2f2a9f0b61",
      "registryVersionId": "d9698ddd-ab86-46bc-a412-c71df7d20414",
      "status": "completed", "outcome": "imported",
      "startedAt": "2026-09-20T22:00:01.117Z", "completedAt": "2026-09-21T12:00:09.528Z",
      "ageSeconds": 162751, "failedCount": 0, "expectedCount": 29, "completedCount": 29,
      "lastError": null, "leaseExpiresAt": null
    },
    "upstreamCheckedAt": "2026-09-23T00:00:02.315Z",
    "upstreamAgeSeconds": 33159,
    "intervalSeconds": 86400,
    "rejectedCommit": null
  },
  "candidates": { "importing": [], "validated": [], "invalid": 0 },
  "chainCheck": {
    "versionId": "d9698ddd-ab86-46bc-a412-c71df7d20414",
    "checkedAt": "2026-09-23T00:00:00.000Z",
    "ageSeconds": 33161,
    "drifts": [],
    "unreadable": []
  },
  "alerts": []
}
```

A drift, as `chainCheck.drifts` names it:

```json
{
  "chainId": 130,
  "network": "unichain-mainnet",
  "market": "130/weth",
  "comet": "0x6c987dde50db1dcdd32cd4175778c2a291978e2a",
  "asset": { "role": "collateral", "assetIndex": 5, "token": "0xc3eacf0612346366db554c991d7858716db09f58", "symbol": "rsETH" },
  "field": "priceFeed",
  "stored": "0x0090a563c4832e4e519f5f054483519b1a83c8c3",
  "current": "0x3fb418b74ec30bc3e940221f58a04e16afc6378b",
  "seenAt": "2026-09-23T00:00:00.000Z"
}
```

## `GET /registry/v1/admin/sync-runs/{sync_run_id}`
### description:

One import run and its per-root checkpoints, including why a root failed and
when the run becomes resumable. `requestedBy` is who started the run —
`registry-admin:<environment>`, or the `COMET_REGISTRY_ADMIN_ACTOR` the
environment sets, for an administrative sync, and `registry-cron:<environment>`
for the hourly job — and `reason` the reason its request gave, if any.
`triggerKind` is `manual` for a run a request started with
`sourceCommitSha`, `forceNewAttempt` or `holdForReview`, and `scheduled` for
any other: the hourly job's, and one an administrative sync with none of the
three started because discovery was due — `requestedBy` tells those two
apart.

`lastError` is the latest failure the run recorded: an attempt at a root
that failed, or an invocation that failed outside its attempts at roots on
something other than a service that did not answer. An attempt at a root
that succeeds clears it, and a run that completes with every root imported
has none; one that gave roots up keeps the latest. A run that ended `failed`
says why: `validation failed`, or `cancelled by <actor>: <reason>`.

## `POST /registry/v1/admin/sync-runs/{sync_run_id}/cancel`
### description:

Ends a run that no invocation can finish. A run that every invocation fails
on the same way before it imports a root spends no attempt, so it never ends
by itself; the hourly job and every sync request take it up and fail on it
again, and a sync with `forceNewAttempt` is refused while it is running. Its
`lastError` says why.

Takes `{"reason": "…"}` and nothing else, and spends from the same budget
as `POST /registry/v1/admin/sync`. Only a run nobody holds is cancelled: a
run whose lease is live is `409` until the lease has run out — the message
says when — since the invocation that holds it may be importing into it, and
so is a run that has already ended. An unknown id is `404`, and a missing
`reason` is `400`.

Answers with the run as `GET /registry/v1/admin/sync-runs/{sync_run_id}`
does: `failed`, with `lastError` `cancelled by <actor>: <reason>` and
`completedAt` set. A root still `processing`, which an invocation that was
stopped left behind, fails as `the invocation importing this root did not
finish`; the others keep their status and attempts.

The run's draft stays `importing`, so the status raises `last-sync-failed`
and `candidate-awaiting-review`, and discovery leaves its commit alone as
one held for review. Fix what failed the run, then send
`POST /registry/v1/admin/sync` with `forceNewAttempt`: a new attempt of the
commit the tracked ref names now. If that is still the run's commit —
`sourceCommitSha` in the cancel's answer — the attempt closes the draft once
it succeeds. If the ref has moved on since the run started, the attempt
imports the newer commit and leaves the run's draft open, as every draft of
an older commit is left, since reviews do not carry across commits: validate
that draft — `registryVersionId` in the cancel's answer — to close it (one
that is missing roots ends `invalid`), or, to keep what was reviewed on it,
send that `sourceCommitSha` with `forceNewAttempt` instead. Cancelling fixes
nothing by itself — a decision the active version stores, which a release no
longer takes, fails the new attempt the same way until a release reads it
again.

## `GET /registry/v1/admin/versions`
### description:

Every version, newest first, with the active one named. This is how an
operator finds the id of the draft they are working on, or of the version to
roll back to.

Query parameters:
- `status` — [optional] — `importing`, `validated` or `invalid`
- `limit` — [optional] — [default 20, max 100]
- `before` — [optional] — a version id: the page starts after that version

It is a summary per version, never a snapshot: what each was built from and
what became of it. The markets of one version are read by its id.

`createdBy` is who asked for the import that created the version, as its run
records them in `requestedBy`: the operator for a version an administrative
sync created — `registry-admin:<environment>`, or the
`COMET_REGISTRY_ADMIN_ACTOR` the environment sets — whatever its request
asked for, and `registry-cron:<environment>` for one the hourly job created.
Why a sync was asked for is kept with its run:
`GET /registry/v1/admin/sync-runs/{sync_run_id}` answers `requestedBy` and
`reason`, and the sync's own answer names the run as `syncRunId`.

A listing longer than `limit` is read a page at a time. `next` is the id to
pass as `before` for the page after this one, and `null` on the last page; a
`before` that names no version is `404`.

Once a newer attempt of a commit succeeds — validates, or is held for review
with every root imported — the commit's older attempts still `importing` are
closed as `invalid`; discovery closes leftovers older than the commit's newest
successful attempt. The reason is one failed check,
`superseded-by-newer-attempt`, added to the draft's latest validation attempt,
whose `details` name the replacing attempt. Drafts of other commits are not
closed this way: reviews do not carry across commits, so such a draft stays
open until it is validated.

```sh
$ curl -s "$API/registry/v1/admin/versions?status=importing" -H "Authorization: Bearer $TOKEN" | jq
```
```json
{
  "activeVersionId": "d9698ddd-ab86-46bc-a412-c71df7d20414",
  "next": null,
  "versions": [
    {
      "id": "c0d77dad-b30e-495f-95aa-a9f457b39174",
      "status": "importing",
      "attempt": 2,
      "isActive": false,
      "sourceRepository": "compound-foundation/comet",
      "sourceCommitSha": "a34d9b571c833b5d77f052ab8e2dbdbe10df726d",
      "snapshotChecksum": null,
      "createdAt": "2026-09-23T08:12:44.019Z",
      "validatedAt": null,
      "createdBy": "registry-admin:stage"
    }
  ]
}
```

## `GET /registry/v1/admin/versions/{version_id}`
### description:

A version with its validation summary and activation history.

## `POST /registry/v1/admin/versions/{version_id}/validate`
### description:

Re-runs validation over a candidate and records the result. A validation
that ran answers `200` with what it decided: `version.status` is `validated`,
or `invalid` with the checks that decided it in `summary`. A version that is
already decided, either way, answers the same again with `changed: false`.

It answers `409` only when it could not run: while the candidate's import is
still running, or when an overlay was written to the candidate while it was
being checked — the checks would describe rows it no longer holds, so none of
them is recorded; validate it again.

```json
{ "version": { "id": "c0d77dad-…", "status": "invalid", "checksum": null }, "changed": true, "summary": { "attempt": 1, "passed": 41, "failed": 1, "checks": [ … ] } }
```

It takes no body. Validation decides nothing: it checks the stored candidate
and records every check it ran, exactly as the scheduled import does
unattended. The decision a person makes about a version, with its reason, is
the activation.

## `POST /registry/v1/admin/versions/{version_id}/activate`
### description:

Makes a validated version the one the API serves. Requires a `reason`, which
is stored with the audit event. Activating the version that is already active
changes nothing.

`expectedActiveVersionId` — [optional] — the version the move is decided
against, or `null` when nothing is on yet. When it is no longer the version
that is on, the move is refused with `409` naming the one that is, instead of
silently undoing a move somebody else made in the meantime. A move whose
target is already on changes nothing, whatever it expected.

```json
{ "reason": "switch on the new commit", "expectedActiveVersionId": "d9698ddd-ab86-46bc-a412-c71df7d20414" }
```

## `POST /registry/v1/admin/versions/{version_id}/rollback`
### description:

The same move in the other direction, recorded as a rollback, and taking the
same `expectedActiveVersionId`.

## `PUT /registry/v1/admin/versions/{version_id}/networks/{chain_id}/overlay`
### description:

Replaces the reviewed overlay of one network: display names, asset display
overrides, unwrapped collateral assets, and price exceptions. An overlay is a
complete document; a missing key is a missing decision, not a default.

The body is the document as `overlay`, the `reason` its audit event is
stored with, and — optionally — `expectedDigest`, described below. Any other
property is refused with `400`:

```json
{
  "reason": "describe Base",
  "overlay": { "displayName": "Base", "assetDisplayOverrides": [], "unwrappedCollateralAssets": [], "priceExceptions": [] },
  "expectedDigest": null
}
```

The overlay is applied to the rows the import wrote, and a network reviewed
this way stops being listed as unreviewed. A chain the candidate has not
imported yet answers `404`: the import writes every network it reaches, so
the answer is to let it continue.

A feed the overlay introduces — a remap's replacement feed — is read on the
chain for its decimals, unless the version already knows it on that chain.
A feed the chain answers for, but not with decimals — the read reverts, or
there is no contract at that address on that chain, which is what a feed of
another chain usually is — is refused with `422` and `details.code`
`OVERLAY_FEED_UNREADABLE`, naming the feed: the document has to change. A
node provider that did not answer is `503`, worth trying again.

A price exception's `expiresAt` is `null`, or an RFC 3339 timestamp with its
offset, such as `2027-01-01T00:00:00Z`; it is stored as the UTC instant it
names. A date without a time or an offset is refused with `400`, and so is an
expiry already past, which would apply to nothing — unless the network already
holds that exception exactly as sent: the overlay is replaced whole, so an
exception that has expired since it was written is sent again with every other
change to the network, and is kept.

The answer names the overlay the scope now holds by its `digest`.
`expectedDigest` — [optional] — is the digest of the overlay the document was
decided against, as the `GET` below answers it, or `null` for a scope nobody
has reviewed: when the scope holds another one, the document is refused with
`409` rather than silently undoing a change made since. A write that another
write to the same candidate lands in the middle of is refused with `409` too;
read again and resend.

```json
{ "versionId": "d9698ddd-ab86-46bc-a412-c71df7d20414", "changed": true, "overlayEventId": "0d0f3f7e-...", "digest": "5f0c...", "snapshotChecksum": null }
```

The `409` of a stale `expectedDigest` names the digest the scope holds now —
`null` for one nobody has reviewed — in `details.current`, under the scope's
type and key: `network 1` here, `market 1/usdc` on the market route. The key
after the type is the `scope` the scope's `GET` answers: read the scope again
there, redo the change on what it answers, and send that with its `digest`.

```json
{ "error": { "code": "CONFLICT", "message": "the overlay of network 1 is no longer the one this was decided against; read it again", "requestId": "8419...", "details": { "current": { "network 1": "1cd5..." } } } }
```

## `GET /registry/v1/admin/versions/{version_id}/networks/{chain_id}/overlay`
### description:

The overlay a network of the version holds, in the form the `PUT` above
takes. A network overlay is replaced whole, so a change to it starts here
rather than from what the active version serves, which lacks whatever the
draft has added since: read it, change what is different in its `overlay`,
and send that back as the `overlay` of the `PUT` body with a reason and the
answer's `digest` as `expectedDigest`. A remap names its replacement as
`replacementPriceFeedAddress`, and an exception that has expired since it was
written is answered as it is held, which the `PUT` keeps. A network nobody
has reviewed answers with the provisional overlay its import wrote,
`reviewed: false` and `digest: null`, and a chain the version has not
imported answers `404`.

```json
{
  "versionId": "d9698ddd-ab86-46bc-a412-c71df7d20414",
  "scope": "1",
  "reviewed": true,
  "digest": "41c0e3c58b9a2d7f6e1b4a0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e",
  "overlay": {
    "displayName": "Ethereum",
    "assetDisplayOverrides": [ { "tokenAddress": "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "displayAddress": "0x0000000000000000000000000000000000000000", "symbol": "ETH", "name": "Ether" } ],
    "unwrappedCollateralAssets": [],
    "priceExceptions": [
      { "kind": "zero_price", "priceFeedAddress": "0xe3a409ed15cd53afdefdd191ad945cec528a2496", "provenance": "Deprecated wUSDM / USD feed (cUSDTv3 collateral wUSDM) reverts", "expiresAt": null }
    ]
  }
}
```

## `PUT /registry/v1/admin/versions/{version_id}/markets/{chain_id}/{deployment_key}/overlay`
### description:

The same for one market: its display name, status, capabilities, quote unit,
USD feed, and reward feed. A market the import wrote without a review is
disabled until this is applied to it, and
`GET /registry/v1/admin/versions/{version_id}` lists what is still
unreviewed. It takes the same body, with the market's document as
`overlay`, answers the market's `digest` and takes `expectedDigest` exactly
as the network route does, and reads the feeds it introduces — the USD feed
and the reward feed — the same way. A `rewardPriceFeed` on a market whose
rewards contract names no reward token is refused with `409`.

A `creationBlock` the document changes is held against the chain, unless it
is `0`: it must be the block the market's Comet was deployed in — the Comet
has code at that block and none at the block before it — and not past the
chain's latest block. Every index of the market starts there. One past the
latest block leaves none of the market's values to read, and the market
routes and `/account/{address}/rewards` answer it as `error` until the chain
reaches it ([Market status](#market-status)); one before the deployment
fails the history routes that read the market, those over all networks among
them, while the market is younger than the days they report. A block the
chain contradicts is refused with `422` and `details.code`
`OVERLAY_CREATION_BLOCK_WRONG`, whose message names the block and says
whether it is before the deployment, after it, or past the latest block, and
nothing is written; a node provider that did not answer is `503`, worth
trying again. A document that keeps the block the version holds reads nothing
of the chain for it, and a market switched off is held to the same rule, so
switching it on later keeps a block that was checked.

It also states how the frontend lists the market. `displayName` is its label,
`slug` — lowercase letters, digits, dots and hyphens, or `null` — is what the
frontend addresses it by where the label is shared with another market of
the same network, and `isInstitutional` lists it in the institutional section.
Within a network, no two markets that are not disabled may answer to the same
`slug`, or to the same label where they have none; validation refuses a
version where they do, and a slug another market of the network keeps is
refused with `409`. So is `isDefault: true` while another market of the
version is the default: the default moves with both markets in one
`PUT …/overlays`, each decided against the `digest` its `GET` answered
(`expectedDigests`).

## `GET /registry/v1/admin/versions/{version_id}/markets/{chain_id}/{deployment_key}/overlay`
### description:

The overlay a market of the version carries, in the form the `PUT` above
takes: read it, change what is different in its `overlay`, and send that
back as the `overlay` of the `PUT` body with a reason — and with the
answer's `digest` as `expectedDigest`, so a change somebody made in between
is not undone. The answer itself is not a body the `PUT` takes: sent back
whole, its other properties are refused with `400`. The overlay of a similar
market is where describing a new one starts. A market nobody has reviewed
answers with the provisional decisions its import wrote, `reviewed: false`
and `digest: null`.

```json
{
  "versionId": "d9698ddd-ab86-46bc-a412-c71df7d20414",
  "scope": "8453/usdc",
  "reviewed": true,
  "digest": "9b2f1c6d0e3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c",
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

## `PUT /registry/v1/admin/versions/{version_id}/overlays`
### description:

Many overlays in one request: the way a new environment is reviewed, where
every network and market the first import wrote needs its decisions at once.
`GET /versions/{version_id}/proposal` answers with exactly this body under
`bundle`.

Network overlays are keyed by chain id and market overlays by
`chainId/deploymentKey`, the chain id written as a path writes it (`1`, never
`01`), which is how the proposal's bundle writes it; each is the same
complete document the one-scope routes take, decided the same way, and
`reason` is stored with every audit event the request records. Up to 100
overlays, in a body of up to 512 KiB.

The request is applied all at once or not at all. Every document is parsed
and every network and market it names is found before anything is written,
and the writes are one D1 transaction: a document the parser refuses answers
`400` naming it, and scopes the candidate has not imported answer `404`
naming all of them, with nothing written in either case. A request may move
the default market or a slug between the markets it names, or swap two slugs,
in whatever order it names them. Only an importing candidate is
writable (`409` otherwise), and a request that another write to the
candidate lands in the middle of is refused with `409`, with nothing
written: what it decided was decided against what it read.

```json
{
  "reason": "bootstrap: derived from the static constants against Compound-Foundation/comet@a34d9b571c83",
  "networks": { "1": { "displayName": "Ethereum", "assetDisplayOverrides": [], "unwrappedCollateralAssets": [], "priceExceptions": [] } },
  "markets":  { "1/usdc": { "displayName": "USDC", "contractName": "cUSDCv3", "...": "..." } }
}
```

`expectedDigests` — [optional] — is `expectedDigest` for a directory: keyed as
the documents are, by chain id for a network and by `chainId/deploymentKey`
for a market, the digest of the overlay each was decided against, as the
`GET` of its scope answers it, or `null` for a scope nobody has reviewed. A
request where any scope holds another overlay is refused with `409`, and
nothing is written. Its `details.current` names each such scope as the
one-document routes do, with the digest it holds now: the scope's type, then
the key the request names it by (`"market 1/usdc"`). Read each of them again
through its `GET`, redo the change, and send the digests read. A document it
names nothing for is written whatever its scope holds; a key that names no
document of the request, or a value that is not a digest, is refused with
`400`. The default or a slug moving between two markets is read from both and
sent back this way:

```json
{
  "reason": "open the WETH market by default",
  "markets": {
    "1/usdc": { "displayName": "USDC", "isDefault": false, "...": "..." },
    "1/weth": { "displayName": "ETH", "isDefault": true, "...": "..." }
  },
  "expectedDigests": { "1/usdc": "9b2f...", "1/weth": "e7a4..." }
}
```

The answer says what each document changed — the networks first, by chain
id, then the markets in the order the request named them — and what the
candidate still has unreviewed. A document identical to
what is stored changes nothing and records no event, so sending the same
directory again is safe.

```json
{
  "versionId": "d9698ddd-ab86-46bc-a412-c71df7d20414",
  "changed": true,
  "snapshotChecksum": null,
  "documents": [
    { "scopeType": "network", "scopeKey": "1",      "changed": true,  "overlayEventId": "0d0f3f7e-...", "digest": "41c0..." },
    { "scopeType": "market",  "scopeKey": "1/usdc", "changed": true,  "overlayEventId": "5b1c2a90-...", "digest": "9b2f..." },
    { "scopeType": "market",  "scopeKey": "1/weth", "changed": false, "overlayEventId": null,           "digest": "e7a4..." }
  ],
  "unreviewed": { "networks": [], "markets": [] }
}
```

## `GET /registry/v1/admin/versions/{version_id}/proposal`
### `GET /registry/v1/admin/versions/{version_id}/proposal/review`
### description:

What the release serving the request proposes as the first review of a
version: for every market the version imported that the static constants
describe, the decisions the API already acts on, and for every network, its
name, presentation and price exceptions. A market the constants do not
describe is not proposed; it is listed under `needsDecision`, and stays
switched off until it is described with the market overlay route.

The proposal is for an environment's first version only. Once any version
has been activated, the decisions live in the registry and every draft
inherits them, so applying the constants' values over a draft would undo
what was reviewed since: the proposal routes, `apply` included, answer
`409` from then on, and a draft is reviewed with the overlay routes.

`/proposal` answers with the proposal as data: its `digest`, what it leaves
undecided, and under `bundle` the body `PUT /versions/{version_id}/overlays`
takes. `/proposal/review` answers with the same proposal as a document to read
(`text/markdown`), naming the digest to apply it by. Neither changes anything.

```json
{
  "versionId": "d9698ddd-ab86-46bc-a412-c71df7d20414",
  "digest": "3f9a1c0e7b2d4a61",
  "needsDecision": [],
  "bundle": { "reason": "bootstrap: derived from the static constants against Compound-Foundation/comet@a34d9b571c83", "networks": { "...": "..." }, "markets": { "...": "..." } }
}
```

## `POST /registry/v1/admin/versions/{version_id}/proposal/apply`
### description:

Applies the proposal by its digest: `{"reason": "...", "digest": "<16 hex>"}`.
The proposal is built again and written only if it still has that digest, so
what is applied is exactly what was read; one that changed since — another
release, another version — answers `409` with its current digest in
`details`. The write is the one `PUT /versions/{version_id}/overlays` makes,
all of it or none, and answers the same way, with the `digest` beside it.
Only an importing version is writable.

## `GET /registry/v1/admin/shadow`
### `GET /registry/v1/admin/versions/{version_id}/shadow`
### description:

What the active version — or a validated candidate, before activating it —
says against what the static constants in the Worker still say. `agrees` is
the one flag a check can read; `differences` names every field the two answer
differently, and `onlyInStatic` / `onlyInRegistry` the markets only one of
them describes.

`disabledInRegistry` names the markets the constants describe and the
version holds but switches off. They are neither a difference nor a gap — an
operator decided not to serve them — so `agrees` does not count them, and a
disabled market's fields are not compared: its known differences leave
`differences` with it. A market listed here that is meant to be served is a
review to fix, however few differences the report shows.

```json
{
  "agrees": false,
  "shadow": {
    "versionId": "8f1e0f3c-3b7a-4e8f-9a1b-1f0f0b9a2c44",
    "checksum": "1bd74ebe...",
    "networks": [ "ethereum-mainnet", "polygon-mainnet", "..." ],
    "staticMarkets": 29,
    "registryMarkets": 29,
    "onlyInStatic": [],
    "onlyInRegistry": [],
    "disabledInRegistry": [],
    "differences": [
      {
        "scope": "1/wbtc",
        "field": "baseAsset.priceFeed",
        "static": "0xf4030086522a5beea4988f8ca5b36dbc97bee88c",
        "registry": "0xfdfd9c85ad200c506cf9e21f1fd8dd01932fbb23"
      }
    ]
  }
}
```

## `GET /registry/v1/admin/versions/{version_id}/changes`
### description:

What a version changes against the version that is on: the networks and
markets it adds or drops, and every fact and decision of the others that
differs. It is what to read before switching a newer version on, where the
shadow comparison only measures against the static constants.

It answers for a candidate that is still importing as well, because that is
when a market the source has added is described: such a market is listed
under `markets.added` whole, with everything its import read from the source
and the chain, and `reviewed: false` until someone describes it. With no
version on, `comparedWith` is `null` and everything is added.

`markets.removed` lists the keys the version no longer has; `markets.unserved`
says what users of the version on lose. It names every Comet the version on
serves that this version serves under no key of the same chain: a deployment
the source dropped, one it renamed to a key nobody has reviewed yet, one whose
key it gave to another Comet, and one a review switched off. Each is named by
the `scope` the version on serves it under, with its `comet` and `now`: the
`scope` and `status` this version holds it under — always `disabled` — or
`null` where it holds it nowhere. So a Comet renamed and reviewed under its new
key is `removed` and `added` but not `unserved`, while a key given to another
Comet is not `removed`: the old Comet is `unserved`, and the new one is that
key's `contracts.comet` under `changed`, imported as a market nobody has
reviewed, with none of the old Comet's decisions.

A change is one field on a flattened path, with both answers. Lists are
compared by position with their length beside them, so a collateral the
source adds reads as a longer list and one more entry.

```json
{
  "versionId": "0b7c2e7a-1d5e-4f39-8c55-6f7b1c4f2a10",
  "status": "importing",
  "comparedWith": "d9698ddd-ab86-46bc-a412-c71df7d20414",
  "networks": { "added": [], "removed": [], "changed": [] },
  "markets": {
    "added": [
      { "scope": "8453/usdt", "reviewed": false, "market": { "deploymentKey": "usdt", "status": "disabled", "...": "..." } }
    ],
    "removed": [ "1/wbtc" ],
    "changed": [
      {
        "scope": "42161/usdc",
        "field": "baseAsset.priceFeed.address",
        "before": "0x50834f3163758fcc1df9973b6e91f0f0f0434ad3",
        "after": "0x880d36763bb470cd395b7d6c76b50446fa70ace5"
      }
    ],
    "unserved": [
      { "scope": "1/wbtc", "comet": "0xe85dc543813b8c2cfeaac371517b925a166a9293", "now": null }
    ]
  }
}
```
