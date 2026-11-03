import t from 'tap';

import C3Api from '../../../entrypoint.js';

import type { RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';

import { consoleLines } from '../../util/console.js';
import { fakeNode, serve } from '../../util/fake-node.js';
import { makeTestEnv } from '../../util/test-env.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { activateSeeded, loadRegistrySnapshotFixture, seedCandidate } from '../../util/registry-fixture.js';

import '../../../shim/node-self.js';

const LATEST  = { number: 30_000_000, timestamp: 1_790_000_000 };
const USDC    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const ACCOUNT = '0x420f253087044b8BCf028dd89F8fe83Ba6275E84';

type Entry = { status: string, comet: { address: string }, base_asset: { symbol: string, description: string } };

/*
 * An account's rewards are cached for five minutes of blocks, with the labels
 * of each market's rewards in them. A version that only relabels a market
 * keeps its market digest, and so every computation that reads no label; an
 * answer computed after it is activated names that version, and so must name
 * the market as that version does, within the same five minutes too.
 */
t.test('an account\'s rewards name a market as the version that answers them does', async t => {
  consoleLines(t, [ 'warn' ]);
  const fixture  = loadRegistrySnapshotFixture();
  const registry = await activeRegistryDatabase({ snapshot: fixture });
  t.teardown(() => registry.dispose());
  const env = makeTestEnv({ APP_DB: registry.db, MEMORY_CACHE_SEED: `account-rewards-labels: ${t.fullname}` });
  const get = (path: string) => C3Api.fetch(new Request(`https://api.test.local${path}`), env);
  serve(t, fakeNode(fixture, LATEST));

  const usdcOf = async (response: Response) => {
    const entries = await response.json() as Entry[];
    const { status, base_asset: { symbol, description } } = entries.find(entry => entry.comet.address.toLowerCase() === USDC)!;
    return { status, symbol, description };
  };

  const before = await get(`/account/${ACCOUNT}/rewards`);
  t.equal(before.status, 200, 'the rewards of the account are answered');
  t.equal(before.headers.get('x-registry-version'), registry.versionId, 'by the active version');
  t.same(await usdcOf(before), { status: 'success', symbol: 'USDC', description: 'USD Coin' }, 'which names the market so');

  const relabelled: RegistrySnapshotV1 = {
    ...fixture,
    networks: fixture.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      markets: network.markets.map(market => market.deploymentKey !== 'usdc' ? market : {
        ...market,
        displayName: 'USDC (main)',
        baseAsset:   { ...market.baseAsset, displayName: 'Circle USD' },
      }),
    }),
  };
  const { versionId } = await seedCandidate(registry.db, relabelled, { versionId: '00000000-0000-4000-8000-0000000000cc', attempt: 2 });
  await activateSeeded(registry.db, versionId);

  const after = await get(`/account/${ACCOUNT}/rewards`);
  t.equal(after.status, 200, 'at the same latest block');
  t.equal(after.headers.get('x-registry-version'), versionId, 'the answer names the version that relabels the market');
  t.same(await usdcOf(after), { status: 'success', symbol: 'USDC (main)', description: 'Circle USD' },
    'and names the market as that version does');
});
