import t, { Test } from 'tap';
import { MemoryKv } from '../util/kv.js';
import C3Api, { Env } from '../../entrypoint.js';
import { STAGE_ACCESS_HEADER } from '../../src/stage-access.js';
import '../../shim/node-self.js';

const STAGE_KEY = 'stage-access-key-for-tests';

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
  const env = makeEnv({ STAGE_ACCESS_KEY: STAGE_KEY });
  const response = await C3Api.fetch(request(), env);
  assertForbidden(t, response);
  t.equal(await response.text(), 'forbidden', 'rejection body holds no API data');
});

t.test(`stage rejects a request with a wrong access key`, async t => {
  const env = makeEnv({ STAGE_ACCESS_KEY: STAGE_KEY });
  for (const wrongKey of [ '', 'wrong', `${STAGE_KEY}x`, STAGE_KEY.slice(0, -1) ]) {
    const response = await C3Api.fetch(request({ [STAGE_ACCESS_HEADER]: wrongKey }), env);
    assertForbidden(t, response);
  }
});

t.test(`stage accepts a request with the access key`, async t => {
  const env = makeEnv({ STAGE_ACCESS_KEY: STAGE_KEY });
  const response = await C3Api.fetch(request({ [STAGE_ACCESS_HEADER]: STAGE_KEY }), env);
  t.equal(response.status, 404, 'request reaches the router');
});

t.test(`stage without a configured access key rejects every request`, async t => {
  for (const configuredKey of [ undefined, '' ]) {
    const env = configuredKey === undefined
      ? makeEnv({})
      : makeEnv({ STAGE_ACCESS_KEY: configuredKey });
    for (const presentedKey of [ undefined, '', 'anything' ]) {
      const headers: Record<string, string> = presentedKey === undefined
        ? {}
        : { [STAGE_ACCESS_HEADER]: presentedKey };
      assertForbidden(t, await C3Api.fetch(request(headers), env));
    }
  }
});

t.test(`unknown or missing environments are gated`, async t => {
  for (const environment of [ 'jordan-stage', 'Production', '', undefined ]) {
    const env = makeEnv({ ENVIRONMENT: environment as string, STAGE_ACCESS_KEY: STAGE_KEY });
    assertForbidden(t, await C3Api.fetch(request(), env));
  }
});

t.test(`production, local and test are not gated`, async t => {
  for (const environment of [ 'production', 'local', 'test' ]) {
    const env = makeEnv({ ENVIRONMENT: environment });
    const response = await C3Api.fetch(request(), env);
    t.equal(response.status, 404, `${environment} request reaches the router`);
  }
});

t.test(`stage answers a CORS preflight without the access key`, async t => {
  const env = makeEnv({ STAGE_ACCESS_KEY: STAGE_KEY });
  const preflight = new Request(`http://test.local/legacy/mainnet/gas-price`, {
    method: 'OPTIONS',
  });
  const response = await C3Api.fetch(preflight, env);
  t.equal(response.status, 204, 'preflight returns 204');
  t.equal(await response.text(), '', 'preflight body is empty');
});
