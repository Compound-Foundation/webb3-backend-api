import t from 'tap';
import * as streamInto from 'node:stream/consumers';

import { makeTestEnv } from '../../../../util/test-env.js';

import { catalogOf } from '../../../../../src/registry/catalog.js';
import * as KnownNetwork from '../../../../../lib/well-known/networks/network.js';
import * as Debug    from '../../../../../lib/debug-log.js';
import * as Flags    from '../../../../../lib/flags.js';
import * as Eth   from '../../../../../lib/eth-constants.js';

import C3Api, { Env } from '../../../../../entrypoint.js';

import { setupTestEnvVars } from '../../../../util/setupTestEnvVars.js';
import { activeRegistryDatabase } from '../../../../util/registry-database.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../../../../shim/node-self.js';

const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const testDebug = debug.scope('test');
testDebug.log({ flags });

const { apiHost, nodeHost, nodeKey } = setupTestEnvVars();

const CUSDCV3 = '0xc3d688b66703497daa19211eedff47f25384cdc3';

/*
 * TODO?(jordan): refactor this into a real dump test.
 */

/*
 * Markets, tokens, and feeds come from the activated registry, so this test
 * seeds one: the frozen snapshot fixture, activated in a D1 database of its
 * own. Nothing here resolves a market from the static constants any more.
 */
t.test(`/market/.../summary response format looks reasonable`, async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());

  const testEnv: Env = makeTestEnv({
    'V3_API_HOST': apiHost,
    'NODE_PROXY_HOST': nodeHost,
    'NODE_PROXY_KEY': nodeKey,
    'MEMORY_CACHE_SEED': 'market',
    APP_DB: registry.db,
  });
  const network: KnownNetwork.Name = 'ethereum-mainnet';
  const contract = catalogOf(registry.snapshot).marketAt(network, CUSDCV3)!.comet;
  const request  = new Request(`https://${nodeHost}/market/${network}/${contract.address}/summary`);

  const response = await C3Api.fetch(request, testEnv);
  t.ok(response.body);
  // non-null assert (!) is safe because of the t.ok(response.body) above.
  const responseJson = await streamInto.json(response.body! as any);
  /*                         ^^^^^^^^^^
   * Node.js has an original built-in concept of 'streams' which predates
   * the WebStreams standard used by Cloudflare workers (and other modern
   * JavaScript-based runtimes). The 'node:stream/consumers' library
   * (imported as 'streamInto' here) is a set of blessed hacks from the
   * standard library that bridges the gap between them.
   */

  // check basic formatting of the summary response
  const {
    chain_id,
    comet,
    borrow_apr,
    supply_apr,
    total_borrow_value,
    total_supply_value,
    total_collateral_value,
    utilization,
  } = responseJson as any;

  t.ok(typeof chain_id === 'number');
  t.ok(Eth.parseAddress(comet.address));
  t.ok(/^\d+\.\d+$/.test(borrow_apr));
  t.ok(/^\d+\.\d+$/.test(supply_apr));
  t.ok(/^\d+\.\d+$/.test(total_borrow_value));
  t.ok(/^\d+\.\d+$/.test(total_supply_value));
  t.ok(/^\d+\.\d+$/.test(total_collateral_value));
  t.ok(BigInt(utilization) >= BigInt(0));

  t.end();
});