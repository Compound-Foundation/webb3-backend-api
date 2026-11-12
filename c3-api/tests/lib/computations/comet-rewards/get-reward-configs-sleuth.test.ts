import t from 'tap';
import { defaultAbiCoder } from '@ethersproject/abi';

import * as Eth from '../../../../lib/eth-constants.js';
import * as Flags from '../../../../lib/flags.js';
import * as Fallible from '../../../../lib/fallible/fallible.js';
import { sha256 } from '../../../../lib/hash.js';
import { BigNumber } from '../../../../lib/bignumber.js';
import { BigFixnum } from '../../../../lib/bigfixnum.js';
import * as Evaluator from '../../../../lib/symbolic/evaluator.js';
import { MemoryCache } from '../../../../lib/symbolic/cache.js';
import * as KnownNetwork from '../../../../lib/well-known/networks/network.js';
import * as evm from '../../../../lib/computations/evm.js';
import * as sleuthQuery from '../../../../lib/computations/sleuth/sleuth-query.js';
import * as cometRewards from '../../../../lib/computations/comet-rewards.js';
import * as mock from '../../../util/mock/mock.js';

import '../../../../shim/node-self.js';

type Market = cometRewards.GetRewardConfigsSleuth['expects']['cometMarkets'][number];

// what the query reads of a market: its address, its creation block, and
// the CometRewards contract of its network
function market(network: KnownNetwork.Name, address: string, created: number, rewards: string): Market {
  return {
    network,
    address,
    creation: { block: { number: created } },
    rewards: { contract: { network, address: rewards } },
  } as Market;
}

/*
 * getRewardConfigsSleuth sends the compiled query and its arguments to the
 * Sleuth contract in one eth_call. The sha256 of that calldata is pinned
 * here, as the worker built it from Sleuth.querySol of
 * @compound-finance/sleuth 1.0.1-alpha8, before it read the compiled query
 * itself. The same calldata keeps the cached results of ethCall and
 * sleuthQuery valid, so no version has to move.
 */
const cases = [
  {
    network: 'ethereum-mainnet',
    sleuth: '0xc6a613fdac3465d250df7ff3cc21bec86eb8a372',
    block: { number: 21_000_000 },
    markets: [
      market('ethereum-mainnet', '0xc3d688b66703497daa19211eedff47f25384cdc3', 15_331_586, '0x1b0e765f6224c21223aea2af16c1c46e38885a40'),
      market('ethereum-mainnet', '0xa17581a9e3356d9a858b789d68b4d866e593ae94', 16_400_710, '0x1b0e765f6224c21223aea2af16c1c46e38885a40'),
    ],
    calldata: 'a05f28de2a4ad343cf52b2cd12a784245b2f6be2257e8066bf3c0cedbb982970',
  },
  {
    network: 'mantle-mainnet',
    sleuth: '0x1C31c10691Ba7728A04C2bAa2ac02E663a87466F',
    block: { number: 80_000_000 },
    markets: [
      market('mantle-mainnet', '0x606174f62cd968d8e684c645080fa694c1D7786E', 70_789_050, '0xCd83CbBFCE149d141A5171C3D6a0F0fCCeE225Ab'),
    ],
    calldata: '15b3ec5f69a54d21365719d1149331f4f2ac8bb10a89549265705263b1dc0694',
  },
] as const;

// what CometRewards answers for every market here
const COMP = '0xc00e94Cb662C3520282E6f5717214004A7f26888';
const RESCALE_FACTOR = 1_000_000_000_000;

const fetch = mock.fetch({ passthrough: false });
t.before(() => {
  const originalFetch = global.fetch;
  global.fetch = fetch;
  t.teardown(() => { global.fetch = originalFetch; });
});

for (const { network, sleuth, block, markets, calldata } of cases) {
  t.test(`the reward configs of ${network} are read with the calldata Sleuth was sent before`, async t => {
    const context = Fallible.must(cometRewards.getRewardConfigsSleuth.index.project({
      apiHost: 'https://api.example.test',
      nodeHost: 'node.example.test',
      nodeKey: 'test',
      network,
      block,
      cometMarkets: [ ...markets ],
    }));

    // Sleuth answers with the bytes the query returns
    const answer = defaultAbiCoder.encode([ 'bytes' ], [
      defaultAbiCoder.encode(
        [ 'tuple(address token, uint64 rescaleFactor, bool shouldUpscale)[]' ],
        [ markets.map(() => [ COMP, RESCALE_FACTOR, true ]) ],
      ),
    ]);
    const calls: { method: string, params: [ { to: string, data: string }, string ] }[] = [];
    fetch.expect(Eth.nodeEndpoint(context.nodeHost, context.nodeKey, network), { method: 'POST' })
      .returns(async request => {
        const batch = JSON.parse(await request.text());
        calls.push(...batch);
        return new Response(JSON.stringify(batch.map(({ id }: { id: number }) => ({ jsonrpc: '2.0', id, result: answer }))));
      });

    const cache = new MemoryCache({}, [ BigNumber.JsonReviver, BigFixnum.JsonReviver ]);
    const { pull1, evaluate } = Evaluator.instantiate<cometRewards.GetRewardConfigsSleuth>(
      { ...evm, ...sleuthQuery, ...cometRewards },
      { cache, flags: Flags.defaults({}) },
    );
    const configs = await evaluate(pull1({ getRewardConfigsSleuth: context }));
    fetch.satisfy(t);

    t.equal(calls.length, 1, 'one call reads the configs of every market');
    const [ { method, params: [ { to, data }, tag ] } ] = calls;
    t.equal(method, 'eth_call', 'an eth_call');
    t.equal(to, sleuth, 'to the Sleuth contract of the network');
    t.equal(tag, `0x${context.block.number.toString(16)}`, 'at the block of the projected context');
    t.equal(await sha256(data), calldata, 'with the calldata pinned above');

    t.same(
      configs.map(({ cometAddress, rewardConfig: { rewardToken, rescaleFactor, shouldUpscale } }) => (
        [ cometAddress, rewardToken, String(rescaleFactor), shouldUpscale ]
      )),
      markets.map(({ address }) => [ address, COMP, String(RESCALE_FACTOR), true ]),
      'and the answer is read as the config of each market in turn',
    );
  });
}
