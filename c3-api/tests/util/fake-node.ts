import type { Test } from 'tap';

import { Interface, type FunctionFragment } from '@ethersproject/abi';
import { BigNumber } from '@ethersproject/bignumber';

import type { RegistrySnapshotV1 } from '../../lib/model/comet-registry.js';

/*
 * A node provider for the reads of Comet markets, answering from a registry
 * snapshot at one latest block. What a Comet is made of is answered as the
 * snapshot describes it: its collaterals, by asset index; its base asset's
 * feed; its tokens' symbols. Of its values, a market holds one unit of every
 * collateral, its totals are accrued at the latest block, and every other
 * value is 1.0 at eight decimals, a price among them. `script` changes what
 * one read answers — a value, a revert, an error of the node, or a failure of
 * the call — and can hold a request back, for a while or for good.
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
  'function totalsCollateral(address) view returns (uint128)',
  'function symbol() view returns (string)',
  // the rewards of a market
  'function baseBorrowMin() view returns (uint)',
  'function baseMinForRewards() view returns (uint256)',
  'function baseTrackingSupplySpeed() view returns (uint256)',
  'function baseTrackingBorrowSpeed() view returns (uint256)',
  'function trackingIndexScale() view returns (uint256)',
  'function totalsBasic() view returns (tuple(uint64 baseSupplyIndex, uint64 baseBorrowIndex, uint64 trackingSupplyIndex, uint64 trackingBorrowIndex, uint104 totalSupplyBase, uint104 totalBorrowBase, uint40 lastAccrualTime, uint8 pauseFlags))',
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
  block?:  () => Block | 'fail',
  // what a request waits for before it is answered; 'forever' never answers it
  hold?:   (request: { network: string, calls: Call[] }) => Promise<unknown> | 'forever' | undefined,
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
      const block = script.block?.() ?? latest;
      return block === 'fail'
        ? { jsonrpc: '2.0', id, error: { code: -32000, message: 'header not found' } }
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
    const hold = script.hold?.({ network, calls });
    if (hold === 'forever') {
      return new Promise<Response>(() => {});
    }
    await hold;
    const responses = calls.map(call => answer(network, call));
    return new Response(JSON.stringify(body instanceof Array ? responses : responses[0]));
  };
  return { fetch, requests };
}

// puts `node` in place of the global fetch for the length of a test
function serve(t: Test, node: FakeNode): void {
  t.capture(globalThis, 'fetch', node.fetch);
}

const isBlockRead = (request: { calls: Call[] }) => request.calls[0]!.method === 'eth_getBlockByNumber';

// what a node was asked: its latest-block reads, the batches of everything else, and the contracts it was called on
const blockReads = (node: FakeNode) => node.requests.filter(isBlockRead);
const batches    = (node: FakeNode) => node.requests.filter(request => !isBlockRead(request));
const asked      = (node: FakeNode) => new Set<string>(node.requests.flatMap(request => request.calls
  .filter(call => call.method !== 'eth_getBlockByNumber')
  .map(call => call.params[0].to.toLowerCase())));

export type { Block, Call, FakeNode, NodeError, NodeScript, Read };
export { COMET, asked, batches, blockReads, fakeNode, serve };
