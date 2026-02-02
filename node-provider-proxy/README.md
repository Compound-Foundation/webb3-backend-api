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
- `infuraKey` - Infura RPC Key. The proxy relies on Infura as the primary provider for server most rpc traffic across networks (but not all networks).
- `alchemyXXXMainnet` - Alchemy RPC Keys. The proxy relies on Alchemy as a secondary provider for rpc traffic and only for certain networks.
- `quicknodeXXXMainnet` - Quicknode RPC Keys. The proxy relies on Quicknode as provider for rpc traffic that isn't suppored by Infura.
- `quicknodeXXXMainnetSubdomain` - Quicknode RPC Subdomian. Used in conjuction with a Quicknode RPC key.


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
