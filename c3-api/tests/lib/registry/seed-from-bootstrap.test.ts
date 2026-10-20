import t from 'tap';

import * as Fallible from '../../../lib/fallible/fallible.js';
import type { NetworkV1 } from '../../../lib/model/comet-registry.js';
import { parseMarketKey } from '../../../lib/model/comet-registry.js';
import * as KnownNetwork from '../../../lib/well-known/networks/network.js';

import { bundleOf, digestOf, proposalFor } from '../../../src/registry/bootstrap.js';
import { parseMarketOverlay, parseNetworkOverlay } from '../../../src/registry/overlay.js';

import { readSeed, readSeedComets } from '../../util/registry-seed.js';

/*
 * While the proposal exists: the seed is what this tree proposes for a first
 * import of the seed's own markets. They are compared parsed, because the
 * file is in the order the parsers store and the proposal is not. Of a
 * candidate's market the proposal reads only its Comet, so the companion
 * stands in for the candidate.
 */

// the digest of the proposal the seed was frozen from, which registry/seed/README.md names
const FROZEN_FROM = '4897101575bb1d21';

/*
 * Where the file decides otherwise than the proposal, by document and field,
 * and why: a decision an environment made after its bring-up that the file
 * keeps. Each field named here has to differ from the proposal, and no other.
 */
const DEPARTURES: Record<string, Record<string, string>> = {};

type Fields = Record<string, unknown>;

function without(document: Fields, fields: string[]): Fields {
  return Object.fromEntries(Object.entries(document).filter(([ field ]) => !fields.includes(field)));
}

t.test('the seed is the proposal for its own markets', async t => {
  const seed    = readSeed();
  const byChain = new Map<number, { key: string, chainId: number, markets: Array<{ deploymentKey: string, contracts: { comet: string } }> }>();
  for (const [ key, comet ] of Object.entries(readSeedComets())) {
    const market  = parseMarketKey(key)!;
    const chainId = Number(market.chainId);
    const known   = Fallible.must(KnownNetwork.lookup({ chainId }));
    const network = byChain.get(chainId) ?? { key: `${known.chain}-${known.network}`, chainId, markets: [] };
    network.markets.push({ deploymentKey: market.deploymentKey, contracts: { comet } });
    byChain.set(chainId, network);
  }
  // the source names only the bundle's reason, which the file replaces
  const generated = proposalFor([ ...byChain.values() ] as unknown as NetworkV1[], { repository: 'compound-foundation/comet', commit: '0'.repeat(40) });
  t.same(generated.notes.filter(note => note.open), [], 'nothing is left to decide');
  t.equal(await digestOf(generated), FROZEN_FROM, 'and it is the proposal the seed was frozen from');

  const bundle = bundleOf(generated);
  t.same(Object.keys(bundle.networks), Object.keys(seed.networks), 'a document for every network of the seed');
  t.same(Object.keys(bundle.markets), Object.keys(seed.markets), 'and for every market, in its order');

  const documents: Array<{ key: string, proposed: Fields, held: Fields }> = [
    ...Object.entries(bundle.networks).map(([ key, overlay ]) => ({ key, proposed: parseNetworkOverlay(overlay), held: seed.networks[key] as Fields })),
    ...Object.entries(bundle.markets).map(([ key, overlay ]) => ({ key, proposed: parseMarketOverlay(overlay), held: seed.markets[key] as Fields })),
  ];
  for (const { key, proposed, held } of documents) {
    const departures = DEPARTURES[key] ?? {};
    for (const [ field, reason ] of Object.entries(departures)) {
      t.notSame(held[field], proposed[field], `${key} ${field} departs from the proposal: ${reason}`);
    }
    t.same(without(held, Object.keys(departures)), without(proposed, Object.keys(departures)), `${key} is what the proposal decides`);
  }
  t.same(Object.keys(DEPARTURES).filter(key => !documents.some(document => document.key === key)), [], 'every departure names a document of the seed');
});
