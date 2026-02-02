import t from "tap";
import * as streamInto from "node:stream/consumers";

import { MemoryKv } from "../../../../util/kv.js";
import * as Debug from "../../../../../lib/debug-log.js";
import * as Flags from "../../../../../lib/flags.js";
import * as Eth from "../../../../../lib/eth-constants.js";

import C3Api, { Env } from "../../../../../entrypoint.js";

import { setupTestEnvVars } from '../../../../util/setupTestEnvVars.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import "../../../../../shim/node-self.js";

const flags = Flags.parseWithDefaults(process.env);
const debug = Debug.MakeLogger([]).configure(process.env);

const testDebug = debug.scope("test");
testDebug.log({ flags });

const { apiHost, nodeHost, nodeKey } = setupTestEnvVars();

t.test(`/market/all-networks/all-contracts/summary`, async (t) => {
  const testEnv: Env = Object.assign(
    {
      TALLY_API_KEY: "test",
      V3_API_HOST: apiHost,
      NODE_PROXY_HOST: nodeHost,
      NODE_PROXY_KEY: nodeKey,
      ENVIRONMENT: "test",
      MEMORY_CACHE_SEED: "market",
      kv_testnet: MemoryKv({}),
      kv_mainnet: MemoryKv({}),
    },
    process.env
  );
  const request = new Request(
    `http://${nodeHost}/market/all-networks/all-contracts/summary`
  );
  const response = await C3Api.fetch(request, testEnv);
  t.ok(response.body);
  // non-null assert (!) is safe because of the t.ok(response.body) above.
  const responseJson = (await streamInto.json(response.body! as any)) as any[];
  /*                         ^^^^^^^^^^
   * Node.js has an original built-in concept of 'streams' which predates
   * the WebStreams standard used by Cloudflare workers (and other modern
   * JavaScript-based runtimes). The 'node:stream/consumers' library
   * (imported as 'streamInto' here) is a set of blessed hacks from the
   * standard library that bridges the gap between them.
   */

  t.ok(Array.isArray(responseJson));

  responseJson.forEach((entry) => {
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
    } = entry;

    t.ok(typeof chain_id === "number");
    t.ok(Eth.parseAddress(comet.address));
    t.ok(/^\d+\.\d+$/.test(borrow_apr));
    t.ok(/^\d+\.\d+$/.test(supply_apr));
    t.ok(/^\d+\.\d+$/.test(total_borrow_value));
    t.ok(/^\d+\.\d+$/.test(total_supply_value));
    t.ok(/^\d+\.\d+$/.test(total_collateral_value));
    t.ok(BigInt(utilization) >= BigInt(0));
  });

  t.end();
});
