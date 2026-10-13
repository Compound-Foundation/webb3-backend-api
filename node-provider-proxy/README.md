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

- `allowedAppKey` - Optional application key for the proxy to check for on all proxied requests. The proxy has the url format of `http://hostname/{network}/{optional_appkey}`. This is a Worker secret, not a `wrangler.toml` var. See [Application key](#application-key).
- `allowedHosts` - Optional hostnames array to check for on all proxied requests. Can be used to aid in checking the origination of a proxy request comes from a known source. Any client can forge the `Origin` header, so this does not authenticate callers.
- `alchemyXXXMainnet` - Alchemy RPC Key - The proxy relies on Alchemy as the sole provider for rpc traffic.
- `infuraKey` - Infura RPC Key (configurable) - The proxy can be configured to use quicknode for rpc traffic.
- `quicknodeXXXMainnet` - Quicknode RPC Keys (configurable) - The proxy can be configured to use quicknode for rpc traffic.
- `quicknodeXXXMainnetSubdomain` - Quicknode RPC Subdomian (configurable) - Used in conjuction with a Quicknode RPC keys.


## Access control

Each production environment protects the RPC provider quota in a different way, because its callers differ.

| Environment | Hostname | Callers | Control |
|---|---|---|---|
| `production-v3-api` | `node-provider-v3-api.compound.xyz` | c3-api (`v3-api` and `v3-api-stage`), through a service binding | `allowedAppKey` secret, `rateLimiter` binding for callers of the public hostname |
| `production-v3-app` | `node-provider-v3-app.compound.xyz` | Browsers on the v3 app | `rateLimiter` binding, `allowedHosts` |
| `production-v2` | `node-provider-v2.compound.xyz` | Browsers on the v2 app | `rateLimiter` binding, `allowedHosts` |

Browsers cannot keep a key secret, so the browser-facing environments limit each client IP instead.

### Application key

When `allowedAppKey` is set, the proxy rejects with `401` any request whose second path segment is not exactly that key. When it is not set, the proxy does not check keys. A key must be at least 20 characters of letters, numbers, `-` and `_`.

c3-api sends its `NODE_PROXY_KEY` secret as that path segment. Both c3-api environments call `production-v3-api`, so `NODE_PROXY_KEY` on c3-api `production` and `stage` must equal `allowedAppKey` on `production-v3-api`.

To enable the key for the first time, set c3-api's key before the proxy's. Otherwise c3-api requests fail with `401`.

```sh
KEY=$(openssl rand -hex 32)
# 1. c3-api sends the key, which the proxy still ignores
(cd ../c3-api && echo "$KEY" | npx wrangler secret put NODE_PROXY_KEY --env production)
(cd ../c3-api && echo "$KEY" | npx wrangler secret put NODE_PROXY_KEY --env stage)
# 2. the proxy enforces the key
echo "$KEY" | npx wrangler secret put allowedAppKey --env production-v3-api
```

To rotate the key, turn enforcement off while c3-api changes over, so that c3-api never sends a key the proxy rejects:

```sh
NEW_KEY=$(openssl rand -hex 32)
npx wrangler secret delete allowedAppKey --env production-v3-api
(cd ../c3-api && echo "$NEW_KEY" | npx wrangler secret put NODE_PROXY_KEY --env production)
(cd ../c3-api && echo "$NEW_KEY" | npx wrangler secret put NODE_PROXY_KEY --env stage)
echo "$NEW_KEY" | npx wrangler secret put allowedAppKey --env production-v3-api
```

The proxy accepts anyone's requests between the first and last commands. If the old key has leaked, skip the `secret delete`, put the new `allowedAppKey` first, and then update both c3-api secrets. The leaked key stops working at once, but c3-api gets `401` until its secrets are updated.

Do not add `allowedAppKey` to `[vars]` in `wrangler.toml`: Cloudflare rejects a deploy whose var has the same name as an existing secret. To require a key when running locally, put `allowedAppKey = "<key>"` in `.dev.vars`.

### Rate limit

Each production environment binds a [Workers rate limiter](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) as `rateLimiter`: 60 JSON-RPC calls per 60 seconds for each client. A batch counts once for each call in it. Over the limit the proxy responds `429` with `Retry-After: 60`. `OPTIONS` preflight requests are not counted.

The client is the `cf-connecting-ip` header, which Cloudflare sets on every request from the internet. IPv6 clients are counted by their /64 prefix, because one host usually holds a whole /64. Requests from other Workers over a service binding, such as c3-api's, have no `cf-connecting-ip` and are not limited. Requests made while the limiter is failing are not limited either.

Cloudflare counts the limit separately in each of its locations, and the count is eventually consistent, so a client can exceed it briefly. Clients behind one shared IPv4 address, such as a carrier-grade NAT, share one limit. The `namespace_id` of each binding must be unique in the Cloudflare account.

When `rateLimitLogOnly` is `true`, the proxy serves requests over the limit and logs `rate limit exceeded (log only)` for each one. `production-v3-app` and `production-v2` start in this mode. To check how often real users would be refused, run `npx wrangler tail --env production-v3-app --search "rate limit exceeded"` while the apps are busy. Then set `rateLimitLogOnly = false` and deploy.

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
