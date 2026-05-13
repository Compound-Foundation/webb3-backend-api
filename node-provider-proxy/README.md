# Infura Worker

CloudFlare worker to proxy JSON-RPC requests needed for the v3 App.

## Important Notes
- Batch JSON-RPC requests are not supported (since cost calculations for batch is difficult)
- When inspecting an RPC request, we currently only filter on the first element, if `params` is an array.

## Getting Started

First, install any dependencies:

```sh
yarn install
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


## Running Locally

To start a local server for the Web3 Worker, run:

```
yarn start
```

## Testing

To test the Web3 Worker, run:

```sh
yarn test
```
