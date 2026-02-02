import t from 'tap';
import * as streamInto from 'node:stream/consumers';
import { MemoryKv } from '../../util/kv.js';
import C3Api, { Env } from '../../../entrypoint.js';
import '../../../shim/node-self.js';

t.test(`/legacy/mainnet/gas-price response format looks reasonable`, async t => {
  const testEnv: Env = {
    'TALLY_API_KEY': 'test',
    'V3_API_HOST': 'test',
    'NODE_PROXY_HOST': 'test',
    'NODE_PROXY_KEY': 'test',
    'ENVIRONMENT': 'test',
    'MEMORY_CACHE_SEED': 'market',
    'kv_testnet':  MemoryKv({}),
    'kv_mainnet': MemoryKv({}),
  };
  const request  = new Request(`http://test.local/legacy/mainnet/gas-price`);
  const response = await C3Api.fetch(request, testEnv);
  t.ok(response.body);
  const responseJson = await streamInto.json(response.body! as any);

  const {
    fastest,
    fast,
    average,
    safe_low,
  } = responseJson as any;

  t.ok(/^\d+$/.test(fastest.value));
  t.ok(/^\d+$/.test(fast.value));
  t.ok(/^\d+$/.test(average.value));
  t.ok(/^\d+$/.test(safe_low.value));

  t.end();
});
