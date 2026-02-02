import * as Quota    from './quota.js';
import * as Debug    from './debug-log.js';
import * as Fallible from './fallible/fallible.js';

import type { Env, ServiceBindings } from '../entrypoint.js';

interface RequestCountingFetch {
  quota: Quota.default<{ subrequests: number }>;
  debug: Debug.Logger;
  count: number;
  services:  ServiceBindings;
  overrides: { host: string, binding: (keyof ServiceBindings) }[];
  resetCount(): void;
  configure(env: Env, quota: Quota.default<Subrequests>): void;
  (...parameters: Parameters<typeof self.fetch>): Promise<
    | Response
    | Fallible.Outcome.Of.Failure<InsufficientQuota>
  >;
}

const fetch: RequestCountingFetch = Object.assign(
  async (...parameters: Parameters<typeof self.fetch>) => {
    const request = new Request(...parameters);
    fetch.count++;
    if (fetch.debug.enabled()) {
      const formattedCount = fetch.count.toString().padStart(4, '0');
      fetch.debug.log(`fetch[${formattedCount}]: ${request.url}`);
    }
    // if the environment contains a service binding url override, use it
    const url = new URL(request.url);
    const override = fetch.overrides.find(({ host }) => host === url.hostname);
    if (override != null) {
      /*
       * If we found a service binding url override, but the binding
       * cannot be found in services, the request fails with a 500 error.
       */
      if (!(override.binding in fetch.services)) {
        const bodyText = (
          `fetch failed: no service binding exists for requested override`
            + `${JSON.stringify(override)}`
        );
        fetch.debug.error(bodyText, { services: fetch.services });
        return new Response(bodyText, { status: 500 });
      }
      // otherwise, we forward the request to the service binding worker
      fetch.debug.log(`service binding override triggered`, override);
      return fetch.services[override.binding]!.fetch(request);
    } else {
      if (fetch.quota.has({ subrequests: 1 })) {
        // this is a normal fetch: no service binding url override requested
        const response = await self.fetch(request);
        // any response causes an allocated subrequest to be consumed
        fetch.quota.consume({ subrequests: 1 })
        return response;
      } else {
        return Fallible.Outcome.Of.Failure({
          type: FailureTypes.InsufficientQuota,
          error: new Error(`fetch(..): bailing out; request quota exhausted`),
          details: {
            quota: {
              requested: { subrequests: 1 },
              resources: fetch.quota.resources,
              allocated: fetch.quota.allocated,
            },
          },
        });
      }
    }
  },
  {
    quota: Quota.default.initialize({ subrequests: Infinity }),
    debug: Debug.MakeLogger([ 'fetch' ]),
    count: 0,
    services:  [] as RequestCountingFetch['services'],
    overrides: [] as RequestCountingFetch['overrides'],
    resetCount() {
      this.count = 0;
    },
    configure(env: Env, quota: Quota.default<Subrequests>) {
      this.quota = quota;
      this.debug.configure(env);
      this.overrides = env.URL_SERVICE_BINDING_OVERRIDES ?? [];
      for (const override of this.overrides) {
        if (override.binding in env) {
          this.services[override.binding] = env[override.binding]!;
        }
      }
    },
  },
);

/*
 * Quota resources and failures
 */
interface Subrequests extends Quota.ResourceAmounts {
  subrequests: number;
}

const FailureTypes = {
  InsufficientQuota: `Fetch.InsufficientQuota` as const,
};

interface InsufficientQuota
  extends Quota.InsufficientQuota<Subrequests>
{
  type: typeof FailureTypes.InsufficientQuota,
}

export default fetch;

export type {
  InsufficientQuota,
};
