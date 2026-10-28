# Webb3 Backend Api

Workspace that contains both projects used to power the backend api for the
Webb3 frontend application. Please see each project for additional readme instructions.

## Requirements

- Node.js 22 or newer. Wrangler 4 requires it, and both workers declare it in `engines.node`.

## Lockfiles

| Lockfile | Covers | Consumed by |
|---|---|---|
| `package-lock.json` | shared workspace libraries under `c3-api/lib` and `c3-api/tests/util/mock` | the `preinstall` script of both workers (`npm install-clean --workspaces`), which also runs during `npm ci` in both test workflows, and the root `npm audit` step in CI |
| `c3-api/package-lock.json` | the c3-api worker, including Wrangler and the test runner | `npm install`, `npm test`, the `deploy:*` and `d1:migrate:*` scripts, the c3-api test workflow (`npm ci`), and the c3-api `npm audit` step in CI |
| `node-provider-proxy/package-lock.json` | the node-provider-proxy worker | `npm install`, `npm run build`, the `deploy:*` scripts, the proxy test workflow (`npm ci`), and the proxy `npm audit` step in CI |

Deployments run through each worker's `deploy:*` scripts. CI runs the dependency audits; the c3-api build, every c3-api test that needs neither a node provider nor the R2 test dumps (`npm run test:offline`), the D1 migration checks and the dry-run bundles; and the node-provider-proxy build and tests, all on Node.js 22.
