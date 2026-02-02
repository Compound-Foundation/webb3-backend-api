import fetch      from './lib/request-counting-fetch.js';
import Quota      from './lib/quota.js';
import * as Flags from './lib/flags.js';
import * as Debug from './lib/debug-log.js';

import { route }      from './src/router.js';
import * as Evaluator from './src/evaluator.js';

import * as v2           from './lib/computations/v2.js';
import * as evm          from './lib/computations/evm.js';
import * as comet        from './lib/computations/comet.js';
import * as market       from './lib/computations/market.js';
import * as rewards      from './lib/computations/rewards.js';
import * as account      from './lib/computations/account.js';
import * as defisaver    from './lib/computations/defisaver.js';
import * as governance   from './lib/computations/governance.js';
import * as cometRewards from './lib/computations/comet-rewards.js';
import * as sleuthQuery  from './lib/computations/sleuth/sleuth-query.js';

/*
 * worker-to-worker service bindings configured in wrangler.toml must be
 * added here as optional fields pointing to service binding objects
 */
interface ServiceBindings {
  node_provider_proxy?: { fetch: (typeof self.fetch) }
}

interface Env extends Flags.Env, ServiceBindings {
  kv_mainnet:   KVNamespace,
  kv_testnet:   KVNamespace,
  ENVIRONMENT:  string,
  /*
   * seed for memory cache, useful for testing where we need independent
   * memory caches for each test suite
   */
  MEMORY_CACHE_SEED: string,
  TALLY_API_KEY: string,
  BLOCK_NATIVE_API_KEY?: string,
  V3_API_HOST: string,
  NODE_PROXY_HOST: string,
  NODE_PROXY_KEY: string,

  /*
   * for worker-to-worker requests we need to override fetch() requests to
   * the corresponding URL to instead invoke the service binding directly
   */
  URL_SERVICE_BINDING_OVERRIDES?: Array<{
    host:    string,
    binding: (keyof ServiceBindings),
  }>,
  // debug configuration
  DEBUG?:       string,
  DEBUG_DEPTH?: string,
  DEBUG_LEVEL?: string,
  // quota configuration
  QUOTA_SUBREQUESTS?: number;
  QUOTA_CACHE_OPERATIONS?: number;
}

export { Env, ServiceBindings };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET',
        },
      });
    }
    const quota = Quota.initialize({
      // cache resources: 1000 ops, regardless of reads or writes
      ops:    env.QUOTA_CACHE_OPERATIONS ?? Infinity,
      reads:  env.QUOTA_CACHE_OPERATIONS ?? Infinity,
      writes: env.QUOTA_CACHE_OPERATIONS ?? Infinity,
      // http resources: 1000 subrequests via fetch(..)
      subrequests: env.QUOTA_SUBREQUESTS ?? Infinity,
    });
    fetch.configure(env, quota);
    fetch.resetCount();
    const debug = Debug.MakeLogger([]).configure(env);
    const flags = Flags.parse(env);
    const context: Evaluator.Context = { env, debug, flags };
    const response = await route(
      request,
      context,
      Evaluator.preInstantiate(quota, context, {
        ...evm.applyIndexBias(
          Flags.defaults(flags).ethComputationIndexBias,
          evm
        ),
        ...v2,
        ...comet,
        ...market,
        ...account,
        ...rewards,
        ...defisaver,
        ...governance,
        ...cometRewards,
        ...sleuthQuery,
      }),
    );
    response.headers.set('Access-Control-Allow-Origin', '*');
    return response;
  },
};
