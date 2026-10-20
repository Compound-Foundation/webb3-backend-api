import t from 'tap';

import * as Debug from '../../lib/debug-log.js';
import * as Flags from '../../lib/flags.js';

import { route } from '../../src/router.js';

import { activeRegistryDatabase } from '../util/registry-database.js';
import { makeTestEnv } from '../util/test-env.js';

import '../../shim/node-self.js';

/*
 * Which storage a market route evaluates in. Testnet data is kept apart from
 * mainnet data, and testnets are not served: a route over every network that
 * asks to include them — `testnets=include` — is refused before anything is
 * evaluated, and every other one evaluates in the mainnet storage. No query
 * string moves a request off the cache every other request fills.
 *
 * The historical summary, the latest summary and the rewards data each
 * decide it themselves, by that rule.
 */
const USDC = '0xc3d688b66703497daa19211eedff47f25384cdc3';

t.test('a market route evaluates in the mainnet storage, and a request for testnets in none', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());

  // the failure each route answers with here is logged; nothing here is about it
  const error = console.error;
  console.error = () => {};
  t.teardown(() => { console.error = error; });

  // the storage each evaluator was made for; an evaluator that is asked anything fails, as there is no node
  const environments: string[] = [];
  const instantiate = ((networkEnv: string) => {
    environments.push(networkEnv);
    const unanswered = () => { throw new Error('there is no node in this test'); };
    return { evaluate: unanswered, pull1: () => null, pipe1: () => null, split: () => null, value: () => null };
  }) as unknown as Parameters<typeof route>[2];
  const context = {
    env:   makeTestEnv({ DEBUG: '', MEMORY_CACHE_SEED: 'network-environment', APP_DB: registry.db }),
    debug: Debug.MakeLogger([]).configure({ DEBUG: '' }),
    flags: Flags.parseWithDefaults({}),
  };
  const storageOf = async (path: string): Promise<string[]> => {
    environments.length = 0;
    await route(new Request(`https://api.test.local${path}`), context, instantiate);
    return [ ...environments ];
  };

  for (const endpoint of [ 'historical/summary', 'summary', 'rewards/dapp-data' ]) {
    const everyNetwork = `/market/all-networks/all-contracts/${endpoint}`;
    t.same(await storageOf(everyNetwork), [ 'mainnet' ], `${endpoint}: every network, testnets left out`);
    t.same(await storageOf(`${everyNetwork}?testnets=include`), [],
      `${endpoint}: every network with its testnets is refused, and evaluates nothing`);
    t.same(await storageOf(`${everyNetwork}?testnets=exclude`), [ 'mainnet' ], `${endpoint}: testnets excluded`);
    t.same(await storageOf(`${everyNetwork}?testnets=yes`), [ 'mainnet' ],
      `${endpoint}: a value other than include leaves them out, as the handlers read it`);
    t.same(await storageOf(`${everyNetwork}?testnet=include`), [ 'mainnet' ],
      `${endpoint}: and a parameter of another name moves nothing`);
    t.same(await storageOf(`/market/ethereum-mainnet/${USDC}/${endpoint}?testnets=include`), [ 'mainnet' ],
      `${endpoint}: one network is evaluated in the storage of that network`);
  }
});
