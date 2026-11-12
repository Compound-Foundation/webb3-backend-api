import type { Test } from 'tap';

import { Interface, defaultAbiCoder, type FunctionFragment } from '@ethersproject/abi';
import { BigNumber } from '@ethersproject/bignumber';

import type { RegistrySnapshotV1 } from '../../lib/model/comet-registry.js';

/*
 * A node provider for the reads of Comet markets, answering from a registry
 * snapshot at one latest block. What a Comet is made of is answered as the
 * snapshot describes it: its collaterals, by asset index; its base asset's
 * feed; its tokens' symbols. Of its values, a market holds one unit of every
 * collateral, its totals are accrued at the latest block, and every other
 * value is 1.0 at eight decimals, a price among them, and so is what an
 * account holds and is owed, in the token the snapshot says the market pays.
 * A block is answered by its number: the latest block as given, and one below
 * it as many seconds older as it is blocks below it. `script` changes what
 * one read answers — a value, a revert, an error of the node, or a failure of
 * the call — or what a block read does.
 *
 * It is the one fake node of the Comet reads, so a read the computations
 * start to make is added here once. A read it does not know fails the test,
 * rather than being answered with a value nobody chose.
 *
 * It is a fetch: a test serves it in place of the global one, or puts it
 * behind the node proxy's service binding.
 */
const COMET = new Interface([
  'function numAssets() view returns (uint8)',
  'function getAssetInfo(uint8) view returns (tuple(uint8 offset, address asset, address priceFeed, uint64 scale, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap))',
  'function baseTokenPriceFeed() view returns (address)',
  'function getPrice(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function totalBorrow() view returns (uint256)',
  'function getUtilization() returns (uint256)',
  'function getSupplyRate(uint) returns (uint)',
  'function getBorrowRate(uint) returns (uint)',
  // the rate model an APR is computed from (#23)
  'function supplyKink() returns (uint)',
  'function supplyPerSecondInterestRateBase() returns (uint)',
  'function supplyPerSecondInterestRateSlopeLow() returns (uint)',
  'function supplyPerSecondInterestRateSlopeHigh() returns (uint)',
  'function borrowKink() returns (uint)',
  'function borrowPerSecondInterestRateBase() returns (uint)',
  'function borrowPerSecondInterestRateSlopeLow() returns (uint)',
  'function borrowPerSecondInterestRateSlopeHigh() returns (uint)',
  'function totalsCollateral(address) view returns (uint128)',
  'function symbol() view returns (string)',
  // the rewards of a market
  'function baseBorrowMin() view returns (uint)',
  'function baseMinForRewards() view returns (uint256)',
  'function baseTrackingSupplySpeed() view returns (uint256)',
  'function baseTrackingBorrowSpeed() view returns (uint256)',
  'function trackingIndexScale() view returns (uint256)',
  'function totalsBasic() view returns (tuple(uint64 baseSupplyIndex, uint64 baseBorrowIndex, uint64 trackingSupplyIndex, uint64 trackingBorrowIndex, uint104 totalSupplyBase, uint104 totalBorrowBase, uint40 lastAccrualTime, uint8 pauseFlags))',
  // the rewards of an account: its balances, what it is owed, and the reward configs of its markets, read through Sleuth
  'function balanceOf(address) view returns (uint256)',
  'function borrowBalanceOf(address) view returns (uint256)',
  'function getRewardOwed(address,address) returns (address,uint256)',
  'function query(bytes,bytes) view returns (bytes)',
]);

type Block = { number: number, timestamp: number };
type Call  = { id: number, method: string, params: any[] };
// a call to a Comet, or to a token, at the block it reads, with its argument where it takes one: an asset's index, a feed or a token
type Read  = { network: string, comet: string, name: string, argument?: string | undefined, block: number };
// what the node answers instead of the result of a call
type NodeError = { code: number, message: string, data?: string };

type NodeScript = {
  // 'revert' and 'fail' stand for the errors of a call that reverts and of one the node could not serve
  answer?: (read: Read) => unknown[] | NodeError | 'revert' | 'fail' | undefined,
  // what a read of a block answers in place of it: another block, null, as a node answers for a block it does not have, or an error
  block?:  (reference: number | 'latest') => Block | null | 'fail' | undefined,
};

type FakeNode = {
  fetch:    (input: string | Request, init?: RequestInit) => Promise<Response>,
  requests: Array<{ network: string, calls: Call[] }>,
};

const REVERTED: NodeError = { code: 3, message: 'execution reverted', data: '0x' };
const FAILED:   NodeError = { code: -32000, message: 'missing trie node' };

function fakeNode(snapshot: RegistrySnapshotV1, latest: Block, script: NodeScript = {}): FakeNode {
  const markets = new Map(snapshot.networks.flatMap(network => network.markets.map(entry => (
    [ entry.contracts.comet!.toLowerCase(), entry ] as const
  ))));
  const symbols = new Map(snapshot.networks.flatMap(network => network.markets.flatMap(entry => (
    entry.collateralAssets.map(asset => [ asset.token.address.toLowerCase(), asset.token.symbol ] as const)
  ))));
  const requests: FakeNode['requests'] = [];

  const answer = (network: string, { id, method, params }: Call) => {
    if (method === 'eth_getBlockByNumber') {
      const reference = params[0] === 'latest' ? 'latest' : Number.parseInt(params[0], 16);
      const scripted  = script.block?.(reference);
      const block     = scripted !== undefined ? scripted : reference === 'latest' ? latest : blockAt(latest, reference);
      return block === 'fail'
        ? { jsonrpc: '2.0', id, error: { code: -32000, message: 'header not found' } }
        : block === null
        ? { jsonrpc: '2.0', id, result: null }
        : { jsonrpc: '2.0', id, result: { number: `0x${block.number.toString(16)}`, timestamp: `0x${block.timestamp.toString(16)}`, transactions: [] } };
    }
    const [ { to, data }, tag ] = params;
    const contract = to.toLowerCase();
    const fragment = COMET.getFunction(data.slice(0, 10)) as FunctionFragment;
    const argument: string | undefined = COMET.decodeFunctionData(fragment, data)[0]?.toString().toLowerCase();
    const scripted = script.answer?.({ network, comet: contract, name: fragment.name, argument, block: Number.parseInt(tag, 16) });
    if (scripted !== undefined && !Array.isArray(scripted)) {
      return { jsonrpc: '2.0', id, error: scripted === 'revert' ? REVERTED : scripted === 'fail' ? FAILED : scripted };
    }
    const entry  = markets.get(contract);
    const values = scripted ?? ((): unknown[] => {
      switch (fragment.name) {
        case 'numAssets':          return [ entry!.collateralAssets.length ];
        case 'getAssetInfo': {
          const asset = entry!.collateralAssets.find(candidate => String(candidate.assetIndex) === argument)!;
          return [ [ asset.assetIndex, asset.token.address, asset.priceFeed.address, BigNumber.from(10).pow(asset.token.decimals), 0, 0, 0, 0 ] ];
        }
        case 'baseTokenPriceFeed': return [ entry!.baseAsset.priceFeed.address ];
        case 'symbol':             return [ symbols.get(contract) ?? 'TKN' ];
        case 'totalsCollateral': {
          const asset = entry!.collateralAssets.find(candidate => candidate.token.address === argument)!;
          return [ BigNumber.from(10).pow(asset.token.decimals) ];
        }
        case 'totalsBasic': {
          const [ index, base ] = [ BigNumber.from(10).pow(15), BigNumber.from(10).pow(12) ];
          return [ [ index, index, 0, 0, base, base, latest.timestamp, 0 ] ];
        }
        // a market pays the token the snapshot describes: what one Comet owes, and the config of each Comet a Sleuth query names
        case 'getRewardOwed':      return [ markets.get(argument!)!.rewardAsset!.token.address, BigNumber.from(10).pow(8) ];
        case 'query': {
          const [ , codedArgs ] = COMET.decodeFunctionData(fragment, data);
          const [ , comets ] = defaultAbiCoder.decode([ 'address', 'address[]' ], `0x${(codedArgs as string).slice(10)}`);
          return [ defaultAbiCoder.encode([ 'tuple(address token, uint64 rescaleFactor, bool shouldUpscale)[]' ], [
            (comets as string[]).map(comet => [ markets.get(comet.toLowerCase())!.rewardAsset!.token.address, 1, false ]),
          ]) ];
        }
        default:                   return [ BigNumber.from(10).pow(8) ];
      }
    })();
    return { jsonrpc: '2.0', id, result: COMET.encodeFunctionResult(fragment, values) };
  };

  const fetch = async (input: string | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    const network = new URL(request.url).pathname.split('/')[1]!;
    const body = await request.json() as Call | Call[];
    const calls = body instanceof Array ? body : [ body ];
    requests.push({ network, calls });
    const responses = calls.map(call => answer(network, call));
    return new Response(JSON.stringify(body instanceof Array ? responses : responses[0]));
  };
  return { fetch, requests };
}

// the block of a number at or below the latest, as the node answers it: a second older for every block below the latest
function blockAt(latest: Block, number: number): Block {
  return { number, timestamp: latest.timestamp - (latest.number - number) };
}

// puts `node` in place of the global fetch for the length of a test
function serve(t: Test, node: FakeNode): void {
  t.capture(globalThis, 'fetch', node.fetch);
}

// what a node was asked: the blocks it read by number, in the order it read them, and the contracts it was called on
const headerReads = (node: FakeNode) => node.requests.flatMap(request => request.calls
  .filter(call => call.method === 'eth_getBlockByNumber' && call.params[0] !== 'latest')
  .map(call => Number.parseInt(call.params[0], 16)));
const asked       = (node: FakeNode) => new Set<string>(node.requests.flatMap(request => request.calls
  .filter(call => call.method !== 'eth_getBlockByNumber')
  .map(call => call.params[0].to.toLowerCase())));

export type { Block, Call, FakeNode, NodeError, NodeScript, Read };
export { COMET, asked, blockAt, fakeNode, headerReads, serve };
