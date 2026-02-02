# Compound III API

A serverless worker for building cacheable incremental computations over
historical blockchain data.

An API is exposed for querying computations against deployed v3 markets,
used by the Compound III frontend. See [./API.md](./API.md).

# Getting Started

Install dependencies:
```sh
npm install
```


Run a local auto-reloading development build of the worker:
```sh
npm start
```

Hit an endpoint:
```
curl 'http://localhost:8787/market/{network}/{contract}/summary'
```

Substituting a [well-known address](./lib/eth-constants.ts) to a Comet
market contract for `{contract}` and a network (e.g. mainnet) for
`{network}`.

See [API.md](./API.md) for documentation of routes with examples.

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
deployed:

- Ethereum mainnet, [maybe: sepolia]
- Polygon mainnet, mumbai
- Optimism mainnet, goerli
- Arbitrum mainnet (one), goerli (goerli-rollup)

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
well-known ERC-20, Comet, PriceFeed, and other contracts on that network
are described.

Usually, a new network will need, at minimum, `PriceFeed`s for the base
asset and for bridged `COMP`; ERC-20s for the base asset, for bridged
`COMP`, and for every supported collateral asset on every configured
deployment of Comet; and one `Comet` contract for each deployed market on
that network.

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
[entrypoint](./entrypoint.ts). The entrypoint configures a simple
[router](./src/market-router.ts) with a set of
[handlers](./src/market-handlers/v1.ts). The router either fails the
request (typically with a 4xx error because the URI path is malformed), or
passes it to a handler, which invokes the symbolic computation engine to
produce a response.

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
