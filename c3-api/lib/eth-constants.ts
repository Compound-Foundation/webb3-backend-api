import * as Fallible from './fallible/fallible.js';

import * as KnownNetwork     from './well-known/networks/network.js';

import { wellKnown as sepoliaContracts }        from './well-known/contracts/ethereum-sepolia.js';
import { wellKnown as mainnetContracts }        from './well-known/contracts/ethereum-mainnet.js';
import { wellKnown as mumbaiContracts  }        from './well-known/contracts/polygon-mumbai.js';
import { wellKnown as polygonContracts }        from './well-known/contracts/polygon-mainnet.js';
import { wellKnown as arbitrumContracts }       from './well-known/contracts/arbitrum-mainnet.js';
import { wellKnown as baseGoerliContracts }     from './well-known/contracts/base-goerli.js';
import { wellKnown as baseSepoliaContracts }    from './well-known/contracts/base-sepolia.js';
import { wellKnown as baseMainnetContracts }    from './well-known/contracts/base-mainnet.js';
import { wellKnown as lineaGoerliContracts }    from './well-known/contracts/linea-goerli.js';
import { wellKnown as arbitrumGoerliContracts } from './well-known/contracts/arbitrum-goerli.js';
import { wellKnown as optimismContracts } from './well-known/contracts/optimism-mainnet.js';
import { wellKnown as optimismGoerliContracts } from './well-known/contracts/optimism-goerli.js';
import { wellKnown as scrollContracts } from './well-known/contracts/scroll-mainnet.js';
import { wellKnown as mantleContracts } from './well-known/contracts/mantle-mainnet.js';
import { wellKnown as lineaContracts } from './well-known/contracts/linea-mainnet.js';
import { wellKnown as unichainContracts } from './well-known/contracts/unichain-mainnet.js';
import { wellKnown as roninContracts } from './well-known/contracts/ronin-mainnet.js';

import * as Hex       from './evm/hex.js';
import * as Hash      from './evm/hash.js';
import * as Address   from './evm/address.js';
import * as Timestamp from './evm/timestamp.js';

import type * as Type from './type-utilities.js';
import { HexAddress } from './evm/address.js';

const wellKnownContractsByNetwork = {
  ...sepoliaContracts,
  ...mainnetContracts,
  ...mumbaiContracts,
  ...polygonContracts,
  ...arbitrumContracts,
  ...arbitrumGoerliContracts,
  ...optimismContracts,
  ...optimismGoerliContracts,
  ...baseGoerliContracts,
  ...baseMainnetContracts,
  ...lineaGoerliContracts,
  ...scrollContracts,
  ...baseSepoliaContracts,
  ...mantleContracts,
  ...lineaContracts,
  ...unichainContracts,
  ...roninContracts,
} as const;

const NullAddress = `0x0000000000000000000000000000000000000000` as const;

type ReadableFunctionSignature = (
  | `function ${string}(${string}) returns (${string})`
  | `function ${string}(${string}) view returns (${string})`
);

/*
* DefiSaver's bot address
* A address the DefiSaver uses as a bot to send transactions
*/
const DefiSaverBotAddresses: { [name in KnownNetwork.Name]: HexAddress } = {
  'ethereum-mainnet': '0xAAa2d728b6C9B3007B580d0f4c159C76dA783B50',
  'ethereum-sepolia': NullAddress,
  'polygon-mainnet': NullAddress,
  'polygon-mumbai': NullAddress,
  'arbitrum-mainnet': NullAddress,
  'arbitrum-goerli': NullAddress,
  'optimism-mainnet': NullAddress,
  'optimism-goerli': NullAddress,
  'base-goerli': NullAddress,
  'base-mainnet': NullAddress,
  'linea-goerli': NullAddress,
  'scroll-mainnet': NullAddress,
  'base-sepolia': NullAddress,
  'mantle-mainnet': NullAddress,
  'linea-mainnet': NullAddress,
  'unichain-mainnet': NullAddress,
  'ronin-mainnet': NullAddress,
};

function nodeEndpoint(nodeHost:string, nodeKey:string, network: KnownNetwork.Name) {
  return `https://${nodeHost}/${network}/${nodeKey}`;
}

const mainnetGasPriceEndpoint = `https://api.blocknative.com/gasprices/blockprices`;
const governanceTallyQueryEndpoint = `https://api.tally.xyz/query`;

/*
 * cf. https://ethereum.org/en/history/
 * cf. https://etherscan.io/chart/blocktime
 *
 * cross-referencing significant ethereum historical events with average
 * block time changes, largely ignoring time spikes caused by various
 * network congestion conditions throughout...
 *
 * NOTE: MUST be ordered by descending block number.
 *
 * NOTE: MUST specify an average block time estimate for the genesis
 * block, block 0, as the last element of each list.
 *
 * reference: https://dune.com/queries/2457705/4040699
 * using 7 day trailing averages indexed by daily middle block number
 */
const pepemania = [ 16_700_000, 17_030_000, 17_130_000 ];
const merge     = 15_537_394;
const glacier   =  9_200_000;
const homestead =  1_150_000;
const estimatedAverageBlockTimeStepChanges: ({
  [N in KnownNetwork.Name]: [ ...[ number, number ][], [ 0, number ] ];
}) = {
  'ethereum-mainnet': [
    [ 17_230_000,   12.20 ],
    [ pepemania[2], 12.15 ], // and yet...
    [ pepemania[1], 12.27 ], // congestion still...
    [ pepemania[0], 12.15 ], // breaks things
    [ merge,        12.08 ], // slots set at 12s; but some slots are empty
    [ glacier,      13.80 ],
    [ homestead,    14.00 ],
    [ 0,            18.00 ],
  ],
  'ethereum-sepolia': [
    [ 0, 13.50 ], // NOTE: completely made up
  ],
  'polygon-mainnet': [
    [ 43_458_000, 3.300 ],
    [ 43_450_000, 2.573 ],
    [ 43_430_000, 2.373 ],
    [ 43_000_000, 2.352 ],
    [ 42_200_000, 2.190 ],
    [ 41_000_000, 2.237 ],
    [ 40_000_000, 2.296 ],
    [ 39_500_000, 2.299 ],
    [ 39_000_000, 2.258 ],
    [ 38_500_000, 2.200 ],
    [ 0,          2.100 ],
  ],
  'polygon-mumbai': [
    [ 0,  4.00 ],
  ],
  'arbitrum-mainnet': [
    [ 85_000_000, 0.254 ],
    [ 75_000_000, 0.253 ],
    [ 34_000_000, 0.300 ],
    [ 0,          1.000 ],
  ],
  'arbitrum-goerli':  [
    [ 0,  0.798 ],
  ],
  'optimism-mainnet': [
    [ 0, 2.000 ],
  ],
  'optimism-goerli': [
    [ 0, 2.000 ],
  ],
  'base-goerli': [
    [ 0, 2.000 ],
  ],
  'base-sepolia': [
    [ 0, 2.000 ],
  ],
  'base-mainnet': [
    [ 0, 2.000 ],
  ],
  'linea-goerli': [
    [ 0, 2.000 ],
  ],
  'scroll-mainnet': [
    [ 0, 2.000 ],
  ],
  'mantle-mainnet': [
    [ 0, 2.000 ],
  ],
  'linea-mainnet': [
    [ 0, 2.000 ],
  ],
  'unichain-mainnet': [
    [ 0, 1.000 ],
  ],
  'ronin-mainnet': [
    [ 0, 3.000 ],
  ],
};

/*
 * cf. https://etherscan.io/block/{N}
 * cf. https://polygonscan.io/block/{N}
 * cf. https://goerli.etherscan.io/block/{N}
 * cf. https://mumbai.polygonscan.io/block/{N}
 *
 * NOTE that etherscan timestamps are formatted in non-standard format:
 *    "MMM-DD-YYYY HH:MM:SS Mr +TZ"
 *  e.g:
 *    "Mar-14-2016 06:49:53 PM +UTC"
 *
 * therefore `Date.parse(...)` will not correctly interpret those dates
 * without conversion first to ISO-8601. However, neither will it fail to
 * produce a result -- the result will just be garbage. So, when you are
 * adding new well-known timestamp snapshots for a network, please concern
 * yourself with the careful conversion of etherscan date-time strings
 * into ISO-8601 date-time strings before attempting to derive the
 * corresponding seconds-resolution timestamp.
 *
 * NOTE: MUST be ordered by descending block number.
 *
 * NOTE: MUST specify a well-known timestamp snapshot for the genesis
 * block, block 0, as the last element of each list.
 */
const wellKnownTimestampSnapshots: ({
  [N in KnownNetwork.Name]: [ ...[ number, number ][], [ 0, number ] ];
}) = {
  'ethereum-mainnet': [
    [ 17_395_960,   1_685_744_387 ], // 2023-06-02T22:19:47Z
    [ 17_200_000,   1_683_357_287 ], // 2023-05-06T07:14:47Z
    [ pepemania[2], 1_682_507_279 ], // 2023-04-26T11:07:59Z
    [ pepemania[1], 1_681_278_983 ], // 2023-04-12T05:56:23Z
    [ pepemania[0], 1_677_263_687 ], // 2023-02-24T18:34:47Z
    [ merge,        1_663_224_179 ], // 2022-09-15T06:42:59Z
    [ glacier,      1_577_953_849 ], // 2020-01-02T08:30:49Z
    [ homestead,    1_457_981_393 ], // 2016-03-14T18:49:53Z
    [ 0,            1_438_270_573 ], // 2015-07-30T15:36:13Z
  ],
  'ethereum-sepolia': [
    [ 0, 1_438_269_973 ], // 2015-07-30T15:26:13Z
  ],
  'polygon-mainnet': [
    [ 42_000_000, 1_682_555_297 ], // 2023-04-27T00:28:17Z
    [ 41_055_500, 1_680_436_333 ], // 2023-04-02T11:52:13Z
    [ 39_300_000, 1_676_417_976 ], // 2023-02-14T23:39:36Z
    [ 39_000_000, 1_675_735_039 ], // 2023-02-07T01:57:19Z
    [ 0,          1_590_824_836 ], // 2020-05-30T07:47:16Z
  ],
  'polygon-mumbai': [
    [ 0, 1_590_824_836 ], // 2020-05-30T07:47:16Z
  ],
  'arbitrum-goerli': [
    [ 0, 1_622_240_000 ], // 2021-05-28T22:13:20Z
  ],
  'arbitrum-mainnet': [
    [ 84_000_000, 1_682_389_455 ], // 2023-04-25T02:24:15Z
    [ 0,          1_622_240_000 ], // 2021-05-28T22:13:20Z
  ],
  'optimism-mainnet': [
    [ 0, 1_610_639_500 ], // 2021-01-14T15:51:40Z
  ],
  'optimism-goerli': [
    [ 0, 1_610_639_500 ], // 2021-01-14T15:51:40Z
  ],
  'base-goerli': [
    [ 0, 1_675_193_616 ], // 2023-01-31T19:33:36Z
  ],
  'base-sepolia': [
    [ 0, 1_695_768_288 ], // 2023-09-25T22:44:48Z
  ],
  'base-mainnet': [
    [ 0, 1_686_789_347 ], // 2023-06-15T00:35:47Z
  ],
  'linea-goerli': [
    [ 0, 1_686_789_347 ], // FIXME: this is faked
  ],
  'scroll-mainnet': [
    [ 0, 1_696_917_600 ], // 2023-10-10T06:00:00Z
  ],
  'mantle-mainnet': [
    [ 0, 1_688_314_886 ], // 2023-07-02T16:21:26.000Z
  ],
  'linea-mainnet': [
    [ 0, 1_688_649_300 ], // 2023-07-06T13:15:00.000Z
  ],
  'unichain-mainnet': [
    [ 0, 1_730_719_559 ], // 2024-11-04T11:25:59.000Z
  ],
  'ronin-mainnet': [
    [ 0, 1_611_571_777 ], // 2021-01-25T10:49:37.000Z
  ]
};

/*
 * TODO
 */
function estimateSecondsTakenForBlock(network: KnownNetwork.Name, block: Block)
  : Timestamp.EpochSeconds
{
  const precedingStepChange = (
    estimatedAverageBlockTimeStepChanges[network]
      .find(([ forkBlock ]) => block.number > forkBlock)
  );
  if (!precedingStepChange) {
    throw new Error(
      `invariant violated: no estimated average block time available`
      + ` for block at height ${block.number} on ${network}`
    );
  }
  return precedingStepChange[1]; // [ point, estimatedBlockTime ][1]
}

/*
 * TODO
 */
function estimateBlockTimestamp(network: KnownNetwork.Name, block: Block)
  : Timestamp.EpochSeconds
{
  const precedingTimestampSnapshot = (
    wellKnownTimestampSnapshots[network]
      .find(([ forkBlock ]) => block.number >= forkBlock)
  );
  if (!precedingTimestampSnapshot) {
    throw new Error(
      `invariant violated: no preceding timestamp available`
      + ` for block at height ${block.number} on ${network}`
    );
  }
  const [ startBlockNumber, startTimestamp ] = precedingTimestampSnapshot;
  const estimatedBlockTime = (
    estimateSecondsTakenForBlock(network, { number: block.number })
  );
  const blockDistance = (block.number - startBlockNumber);
  return Math.floor(startTimestamp + (estimatedBlockTime * blockDistance));
}

/*
 * TODO
 */
function estimateBlockTimestampRelative(
  network: KnownNetwork.Name,
  block: Block,
  reference: Block.WithTimestamp,
)
  : Timestamp.EpochSeconds
{
  let precedingIndex = estimatedAverageBlockTimeStepChanges[network].findIndex(([ blockNumber ]) => block.number > blockNumber);
  let anchor = precedingIndex > 0
    ? estimatedAverageBlockTimeStepChanges[network][precedingIndex - 1]
    : estimatedAverageBlockTimeStepChanges[network][precedingIndex];
  //
  const distanceToReference = Math.abs(block.number - reference.number);
  const distanceToAnchor = Math.abs(block.number - anchor[0]);
  //
  const estimatedBlockTime = distanceToAnchor < distanceToReference
    ? anchor[1]
    : estimateSecondsTakenForBlock(network, reference);
  const { timestamp: startTimestamp } = reference;
  //
  const blockDistance = (block.number - reference.number);
  return Math.floor(startTimestamp + (estimatedBlockTime * blockDistance));
}

type BlockNumber = number;
type BlockReference = BlockNumber | 'latest';
const BlockReference = {
  encode(reference: BlockReference): string {
    if (typeof(reference) === 'number') {
      return `0x${reference.toString(16)}`;
    } else {
      return reference;
    }
  },
  decode(encoded: Hex.String | 'latest'): BlockReference {
    if (Hex.is(encoded)) {
      return parseInt(encoded, 16);
    } else {
      return encoded;
    }
  },
  parse(value: string): Fallible.Outcome.OrJust<BlockReference> {
    if (value === 'latest') {
      return value;
    } else if (/\d+/.test(value)) {
      return parseInt(value);
    } else if (/0x[a-fA-F0-9]+/.test(value)) {
      return parseInt(value, 16);
    } else {
      return Fallible.Outcome.Of.Failure({
        value,
        error: 'invalid BlockReference',
      });
    }
  },
};

/*
 * block objects with type enhancement via type-guards, parametric types
 */
type Block = {
  number: number;
  //
  date?: string;
  timestamp?: number;
};

namespace Block {
  export type WithTimestamp<B extends Block = Block> = (
    Type.Merge<B & { timestamp: number }>
  );
  export type WithTransactionDetails<B extends Block = Block> = (
    Type.Merge<(B & { transactions: Transaction[] })>
  );
}

const Block = {
  hasTimestamp<B extends Block>(block: B): block is Block.WithTimestamp<B> {
    return 'timestamp' in block
        && typeof(block.timestamp) === 'number';
  },
  hasTransactionDetails<B extends Block>(block: B): block is Block.WithTransactionDetails<B> {
    return 'transactions' in block
        && Array.isArray(block.transactions)
        && block.transactions.every(parseTransaction);
  },
};

/*
 * TODO(jordan): model the rest of the transaction type.
 * All we need for now is 'to', 'from', and 'hash'.
 */
type Transaction = {
  to:   Address.Hex | null, // for contract creation, it's null
  from: Address.Hex,        // Address (20-byte hash)
  hash: Hash.Hex,           // TransactionHash (32-byte hash)
};

function parseTransaction(value: any): value is Transaction {
  return (typeof(value) === 'object') && (value !== null)
      && ('to'   in value)
      && ('from' in value) && (typeof(value.from)  === 'string')
      && ('hash' in value) && (typeof(value.hash)  === 'string')
      && ((value.to === null) || Address.is(value.to))
      && Address.is(value.from)
      && Hash.is(value.hash)
  ;
}

export type {
  BlockNumber,
  Transaction,
  ReadableFunctionSignature,
};

// awkwardly recreate the Eth.Timestamp namespace-shadowing alias
type Timestamp = Timestamp.EpochSeconds;

export {
  // models
  Block,
  Timestamp,
  NullAddress,
  BlockReference,
  //
  nodeEndpoint,
  parseTransaction,
  mainnetGasPriceEndpoint,
  wellKnownContractsByNetwork,
  //
  DefiSaverBotAddresses,
  estimateBlockTimestamp,
  estimateSecondsTakenForBlock,
  estimateBlockTimestampRelative,
  governanceTallyQueryEndpoint,
};

/*
 * re-exports
 */
export { Contract } from './well-known/contracts/utils.js';

export {
  Hex    as BlockHash,
  Hex    as TransactionHash,
  isHash as isTransactionHash,
} from './evm/hash.js';

// export * as Address from './evm/address.js';
export {
  Hex       as Address,
  isAddress as parseAddress,
} from './evm/address.js';

export * as Hex   from './evm/hex.js';
export * as Hash  from './evm/hash.js';
export * as Event from './evm/event.js';
