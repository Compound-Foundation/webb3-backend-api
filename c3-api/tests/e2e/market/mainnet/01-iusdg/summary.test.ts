import t from 'tap';
import * as streamInto from 'node:stream/consumers';

import { MemoryKv } from '../../../../util/kv.js';

import { wellKnownContractsByNetwork } from '../../../../../lib/eth-constants.js';
import * as KnownNetwork from '../../../../../lib/well-known/networks/network.js';
import * as Debug    from '../../../../../lib/debug-log.js';
import * as Flags    from '../../../../../lib/flags.js';
import * as Eth   from '../../../../../lib/eth-constants.js';

import C3Api, { Env } from '../../../../../entrypoint.js';

import { setupTestEnvVars } from '../../../../util/setupTestEnvVars.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../../../../shim/node-self.js';

const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const testDebug = debug.scope('test');
testDebug.log({ flags });

const { apiHost, nodeHost, nodeKey } = setupTestEnvVars();

/*
 * ciUSDGv3 is newly deployed and nearly empty, which is the point of covering
 * it separately from 01-usdc and 01-iusdc: it exercises the low/zero-liquidity path through
 * the summary computation, where the reward APR computations short-circuit on
 * totalSupplyBase.lte(baseMinForRewards) rather than dividing by a zero supply.
 *
 * Assertions are on shape, not on values. The market is live and its balances
 * change; hardcoding today's zeros would turn the first deposit into a test
 * failure.
 *
 * NOTE: like the other e2e market tests, this one hits live node providers and
 * requires V3_API_HOST / NODE_PROXY_HOST / NODE_PROXY_KEY in the environment.
 */
t.test(`/market/.../summary response format looks reasonable for a near-empty market`, async t => {
  const testEnv: Env = {
    'TALLY_API_KEY': 'test',
    'V3_API_HOST': apiHost,
    'NODE_PROXY_HOST': nodeHost,
    'NODE_PROXY_KEY': nodeKey,
    'ENVIRONMENT': 'test',
    'MEMORY_CACHE_SEED': 'market',
    'kv_testnet':  MemoryKv({}),
    'kv_mainnet': MemoryKv({}),
  };
  const network: KnownNetwork.Name = 'ethereum-mainnet';
  const contract = wellKnownContractsByNetwork[network]['Comet']['ciUSDGv3'];
  const request  = new Request(`https://${nodeHost}/market/${network}/${contract.address}/summary`);

  const response = await C3Api.fetch(request, testEnv);
  t.ok(response.body);
  // non-null assert (!) is safe because of the t.ok(response.body) above.
  const responseJson = await streamInto.json(response.body! as any);

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

  t.equal(chain_id, 1, 'reports ethereum mainnet');
  t.ok(Eth.parseAddress(comet.address), 'comet address parses');
  t.equal(
    comet.address.toLowerCase(),
    contract.address.toLowerCase(),
    'echoes back the requested comet'
  );

  /*
   * Interest APRs are rate-model outputs and are well-formed even at zero
   * utilization.
   */
  t.ok(/^\d+\.\d+$/.test(borrow_apr), 'borrow_apr is a decimal string');
  t.ok(/^\d+\.\d+$/.test(supply_apr), 'supply_apr is a decimal string');

  t.ok(/^\d+\.\d+$/.test(total_borrow_value), 'total_borrow_value is a decimal string');
  t.ok(/^\d+\.\d+$/.test(total_supply_value), 'total_supply_value is a decimal string');
  t.ok(/^\d+\.\d+$/.test(total_collateral_value), 'total_collateral_value is a decimal string');
  t.ok(BigInt(utilization) >= BigInt(0), 'utilization is non-negative');

  t.end();
});
