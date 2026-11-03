import t, { Test } from 'tap';
import { readFileSync } from 'node:fs';
import { MemoryKv } from '../util/kv.js';
import C3Api, { Env } from '../../entrypoint.js';
import {
  STAGE_ACCESS_HEADER,
  UNGATED_ENVIRONMENTS,
  MINIMUM_KEY_LENGTH,
} from '../../src/stage-access.js';
import '../../shim/node-self.js';

const STAGE_ACCESS_KEY_VALUE = 'stage-access-key-for-tests-0123456789abcdef';

function makeEnv(overrides: Partial<Env>): Env {
  return {
    'TALLY_API_KEY': 'test',
    'V3_API_HOST': 'test',
    'NODE_PROXY_HOST': 'test',
    'NODE_PROXY_KEY': 'test',
    'ENVIRONMENT': 'stage',
    'MEMORY_CACHE_SEED': 'stage-access',
    'kv_testnet':  MemoryKv({}),
    'kv_mainnet': MemoryKv({}),
    ...overrides,
  };
}

/*
 * An unknown path resolves to a deterministic 404 from the router without
 * any network calls, so a 404 shows that the request passed the gate.
 */
function request(headers: Record<string, string> = {}): Request {
  return new Request(`http://test.local/not-a-real-endpoint`, { headers });
}

function assertForbidden(t: Test, response: Response) {
  t.equal(response.status, 403, 'request is rejected with 403');
  t.equal(
    response.headers.get('X-Content-Type-Options'),
    'nosniff',
    'rejection carries the security headers',
  );
}

t.test(`stage rejects a request without the access key`, async t => {
  const env = makeEnv({ STAGE_ACCESS_KEY: STAGE_ACCESS_KEY_VALUE });
  const response = await C3Api.fetch(request(), env);
  assertForbidden(t, response);
  t.equal(await response.text(), 'forbidden', 'rejection body holds no API data');
});

t.test(`stage rejects a request with a wrong access key`, async t => {
  const env = makeEnv({ STAGE_ACCESS_KEY: STAGE_ACCESS_KEY_VALUE });
  for (const wrongKey of [ '', 'wrong', `${STAGE_ACCESS_KEY_VALUE}x`, STAGE_ACCESS_KEY_VALUE.slice(0, -1) ]) {
    const response = await C3Api.fetch(request({ [STAGE_ACCESS_HEADER]: wrongKey }), env);
    assertForbidden(t, response);
  }
});

t.test(`stage accepts a request with the access key`, async t => {
  const env = makeEnv({ STAGE_ACCESS_KEY: STAGE_ACCESS_KEY_VALUE });
  const response = await C3Api.fetch(request({ [STAGE_ACCESS_HEADER]: STAGE_ACCESS_KEY_VALUE }), env);
  t.equal(response.status, 404, 'request reaches the router');
});

t.test(`stage without a configured access key rejects every request`, async t => {
  const shortKey = 'k'.repeat(MINIMUM_KEY_LENGTH - 1);
  for (const configuredKey of [ undefined, '', shortKey ]) {
    const env = configuredKey === undefined
      ? makeEnv({})
      : makeEnv({ STAGE_ACCESS_KEY: configuredKey });
    for (const presentedKey of [ undefined, '', 'anything', shortKey ]) {
      const headers: Record<string, string> = presentedKey === undefined
        ? {}
        : { [STAGE_ACCESS_HEADER]: presentedKey };
      assertForbidden(t, await C3Api.fetch(request(headers), env));
    }
  }
});

t.test(`unknown or missing environments are gated`, async t => {
  for (const environment of [ 'jordan-stage', 'Production', '', undefined ]) {
    const env = makeEnv({ ENVIRONMENT: environment as string, STAGE_ACCESS_KEY: STAGE_ACCESS_KEY_VALUE });
    assertForbidden(t, await C3Api.fetch(request(), env));
  }
});

t.test(`production, local and test are not gated`, async t => {
  for (const environment of [ 'production', 'local', 'test' ]) {
    for (const env of [
      makeEnv({ ENVIRONMENT: environment }),
      makeEnv({ ENVIRONMENT: environment, STAGE_ACCESS_KEY: STAGE_ACCESS_KEY_VALUE }),
    ]) {
      const response = await C3Api.fetch(request(), env);
      t.equal(response.status, 404, `${environment} request reaches the router`);
    }
  }
});

/*
 * A KV namespace and a node provider binding that count every use and fail,
 * so a test can tell whether a request did any work before it was answered.
 */
function makeCountingResources() {
  const uses = { kv: 0, nodeProvider: 0, fetch: 0 };
  const kv = new Proxy({}, {
    get: () => async () => {
      uses.kv++;
      throw new Error('kv used');
    },
  }) as KVNamespace;
  const nodeProvider = {
    fetch: async () => {
      uses.nodeProvider++;
      throw new Error('node provider used');
    },
  } as unknown as { fetch: typeof self.fetch };
  return { uses, kv, nodeProvider };
}

t.test(`stage rejects a data route before touching KV or RPC`, async t => {
  const originalFetch = globalThis.fetch;
  t.teardown(() => { globalThis.fetch = originalFetch; });

  const dataRoute = `http://test.local/market/mainnet/0xc3d688B66703497DAA19211EEdff47f25384cdc3/summary`;
  for (const [ presentedKey, expectWork ] of [
    [ undefined, false ],
    [ 'wrong', false ],
    // control: the same request with the key does reach KV or RPC, which
    // shows that this test can detect work done for a request
    [ STAGE_ACCESS_KEY_VALUE, true ],
  ] as const) {
    const { uses, kv, nodeProvider } = makeCountingResources();
    globalThis.fetch = async () => {
      uses.fetch++;
      throw new Error('network used');
    };
    const env = makeEnv({
      STAGE_ACCESS_KEY: STAGE_ACCESS_KEY_VALUE,
      MEMORY_CACHE_SEED: `stage-access-work-${presentedKey ?? 'none'}`,
      NODE_PROXY_HOST: 'node-provider.test',
      kv_mainnet: kv,
      kv_testnet: kv,
      node_provider_proxy: nodeProvider,
      URL_SERVICE_BINDING_OVERRIDES: [
        { host: 'node-provider.test', binding: 'node_provider_proxy' },
      ],
    });
    const headers: Record<string, string> = presentedKey === undefined
      ? {}
      : { [STAGE_ACCESS_HEADER]: presentedKey };
    const response = await C3Api.fetch(new Request(dataRoute, { headers }), env);
    const work = uses.kv + uses.nodeProvider + uses.fetch;
    if (expectWork) {
      t.not(response.status, 403, 'request with the key passes the gate');
      t.ok(work > 0, 'request with the key reaches KV or RPC');
    } else {
      assertForbidden(t, response);
      t.equal(work, 0, `rejected request (key: ${presentedKey}) does no KV or RPC work`);
    }
  }
});

t.test(`stage answers a CORS preflight without the access key`, async t => {
  const env = makeEnv({ STAGE_ACCESS_KEY: STAGE_ACCESS_KEY_VALUE });
  const preflight = new Request(`http://test.local/legacy/mainnet/gas-price`, {
    method: 'OPTIONS',
  });
  const response = await C3Api.fetch(preflight, env);
  t.equal(response.status, 204, 'preflight returns 204');
  t.equal(await response.text(), '', 'preflight body is empty');
});

/*
 * Reads ENVIRONMENT from each [vars] and [env.<name>.vars] table. The tables
 * in wrangler.toml are flat key = "value" lines, so a line scan suffices.
 */
function readDeployedEnvironments(): Map<string, string> {
  const toml = readFileSync(new URL('../../../wrangler.toml', import.meta.url), 'utf8');
  const environments = new Map<string, string>();
  let table: string | null = null;
  for (const line of toml.split('\n')) {
    const header = line.match(/^\[(?:env\.([\w-]+)\.)?vars\]\s*$/);
    if (header !== null) {
      table = header[1] ?? 'default';
      continue;
    }
    if (line.startsWith('[')) {
      table = null;
      continue;
    }
    const value = line.match(/^ENVIRONMENT\s*=\s*"([^"]*)"/);
    if (table !== null && value !== null) {
      environments.set(table, value[1]!);
    }
  }
  return environments;
}

t.test(`wrangler.toml gates every deployment except production`, async t => {
  const environments = readDeployedEnvironments();
  t.equal(environments.get('production'), 'production', 'production deploys as production');
  t.equal(environments.get('stage'), 'stage', 'stage deploys as stage');
  for (const [ table, environment ] of environments) {
    if (table === 'production' || table === 'default') {
      continue;
    }
    t.notOk(
      UNGATED_ENVIRONMENTS.includes(environment),
      `[env.${table}] sets a gated ENVIRONMENT (${environment})`,
    );
  }
});
