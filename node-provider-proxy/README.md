# Infura Worker

CloudFlare worker to proxy JSON-RPC requests needed for the v3 App.

## Important Notes
- A batch of JSON-RPC calls goes to the provider in pieces of at most 100 calls, and a batch of one call as that call alone. When the provider fails some pieces and answers the others, and `retryIndividualFailedRpcs` or `retryWithActiveFallback` is on, the answers are kept and only the calls of the failed pieces are asked of the next provider. With both settings off, on a network with no other provider, or when the next provider fails those calls too, the batch is answered `503` with `Retry-After`, as a request that fails whole is.
- When inspecting an RPC request, we currently only filter on the first element, if `params` is an array.

## Getting Started

First, install dependencies with Node.js 22 or newer:

```sh
npm install
```

## Configuration

The provider keys are secrets, and never go into `wrangler.toml`: its `[vars]` keep a placeholder for each (`ALCHEMY_XXX`, `QUICK_NODE_XXX`), and a key left at its placeholder fails its network.

- Locally, they go in `.dev.vars` next to `wrangler.toml`, which git ignores: copy `.dev.vars.example` to `.dev.vars` and set one `NAME=value` per line. `npm start` reads it, and a value there takes the place of the placeholder of the same name.
- A deployed worker takes each as a secret: `npx wrangler secret put <NAME> --env <environment>`, or `npx wrangler secret put <NAME> -c woof.wrangler.toml` for the Woof deployment.

The keys, as `src/providers.ts` reads them:

- `alchemyEthMainnet`, `alchemyArbMainnet`, `alchemyPolygonMainnet`, `alchemyBaseMainnet`, `alchemyScrollMainnet`, `alchemyOptMainnet`, `alchemyMantleMainnet`, `alchemyLineaMainnet`, `alchemyUnichainMainnet` and `alchemyRoninMainnet` - the Alchemy key of each network. Alchemy serves every network, and the testnet names are served from `alchemyEthMainnet`.
- `quicknodeEthMainnet` and `quicknodeEthMainnetSubdomain` - the QuickNode key, and the subdomain of the endpoint it belongs to, for Ethereum mainnet alone: the provider it falls back to when Alchemy fails.

Every provider secret named in `src/providers.ts` must be set. Without one, every request is answered `500 unexpected error`, and the worker's log names the missing secret.

Two more settings restrict who may use the proxy:

- `allowedAppKey` - Optional application key for the proxy to check for on all proxied requests. The proxy has the url format of `http://hostname/{network}/{optional_appkey}`; an empty key accepts any.
- `allowedHosts` - Optional hostnames array to check for on all proxied requests. Can be used to aid in checking the origination of a proxy request comes from a known source.

`allowedHosts` and `[vars.settings]` are not secrets, and stay in `wrangler.toml`: `.dev.vars` holds strings only.


## Running Locally

To start a local server for the Web3 Worker, run:

```
npm start
```

A local run of c3-api reads the chain through this one, bound by the name of
its default environment, `node-provider-proxy-local` (c3-api's README,
Getting Started). Beside it, start the proxy on a port of its own, since
c3-api takes 8787:

```
npm start -- --port 8788
```

## Testing

To test the Web3 Worker, run:

```sh
npm test
```

The tests run on the compiled output, so build first; `npm run build` builds and then runs them. CI builds and tests the proxy on every push that changes it, the shared libraries under `c3-api/lib`, the fetch mock its tests use, or what those compile with: `c3-api/tsconfig.json` and the shim under `c3-api/shim`.
