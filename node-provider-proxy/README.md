# Infura Worker

CloudFlare worker to proxy JSON-RPC requests needed for the v3 App.

## Important Notes
- Batch JSON-RPC requests are not supported (since cost calculations for batch is difficult)
- When inspecting an RPC request, we currently only filter on the first element, if `params` is an array.

## Getting Started

First, install any dependencies:

```sh
npm install
```

## Configuration

The node provider proxy requires several items to be configured in order to function properly. The items are configured in (`wrangler.toml`) and are used when running the proxy locally. It is recommended to configure all of the items as Cloudflare secretes in your Cloudflare worker deployment after you have deployed your proxy as a worker to Cloudflare..

Each of the secrets vars have the following descriptions:

- `allowedAppKey` - Optional application key for the proxy to check for on all proxied requests. The proxy has the url format of `http://hostname/{network}/{optional_appkey}`. 
- `allowedHosts` - Optional hostnames array to check for on all proxied requests. Can be used to aid in checking the origination of a proxy request comes from a known source.
- `alchemyXXXMainnet` - Alchemy RPC Key - The proxy relies on Alchemy as the sole provider for rpc traffic.
- `infuraKey` - Infura RPC Key (configurable) - The proxy can be configured to use quicknode for rpc traffic.
- `quicknodeXXXMainnet` - Quicknode RPC Keys (configurable) - The proxy can be configured to use quicknode for rpc traffic.
- `quicknodeXXXMainnetSubdomain` - Quicknode RPC Subdomian (configurable) - Used in conjuction with a Quicknode RPC keys.


## Error Monitoring

The proxy reports errors and traces to the Sentry project
[`webb3-node-provider-proxy-server`](https://compound-foundation.sentry.io/projects/webb3-node-provider-proxy-server/).
`SENTRY_DSN` and `SENTRY_ENVIRONMENT` in `wrangler.toml` turn reporting on for
each environment, and [`src/sentry.ts`](./src/sentry.ts) holds the SDK options.
It samples every trace locally and 10% in production, leaves out client IP
addresses and HTTP bodies, and replaces the app key and every provider secret
with `[Filtered]` in everything it sends. Requests to node providers carry no
Sentry trace headers.

The `npm run deploy:*` scripts deploy through
[`../scripts/deploy-with-sentry.sh`](../scripts/deploy-with-sentry.sh), which
tags the release with the git commit and uploads source maps so stack traces
show the TypeScript source. Set `SENTRY_AUTH_TOKEN` to a Sentry organization
auth token before deploying; never commit it.

## Running Locally

To start a local server for the Web3 Worker, run:

```
npm start
```

## Testing

To test the Web3 Worker, run:

```sh
npm test
```
