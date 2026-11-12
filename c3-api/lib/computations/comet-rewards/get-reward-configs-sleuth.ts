import { FunctionFragment, Interface, JsonFragment } from '@ethersproject/abi';

import * as Eth from '../../eth-constants.js';
import * as Perspective from '../../perspective.js';

import { getSleuthContract, SleuthQuery } from '../sleuth/sleuth-query.js';
import GetRewardConfigsQuery from '../sleuth/out/GetRewardConfigs.sol/GetRewardConfigs.json' with { type: "json" };

import * as Index   from '../../symbolic/index.js';
import * as Compute from '../../symbolic/computation.js';

import { Comet, StandaloneContract } from '../../well-known/contracts/types.js';
import * as KnownNetwork from '../../well-known/networks/network.js';

type RewardConfigSleuth = {
  cometAddress: Eth.Address,
  rewardConfig: {
    rewardToken: Eth.Address,
    rescaleFactor: number,
    shouldUpscale: boolean,
  }
}

type GetRewardConfigsSleuth = Compute.Spec<{
  name: 'getRewardConfigsSleuth',
  depends: [SleuthQuery],
  expects: {
    apiHost: string,
    nodeHost: string,
    nodeKey: string,
    network: KnownNetwork.Name,
    block: Eth.Block,
    cometMarkets: Eth.Contract<StandaloneContract<Comet>>[],
  },
  returns: RewardConfigSleuth[],
}>;

const { implement, pipe, value } = Compute.Functor<GetRewardConfigsSleuth>({});
const getRewardConfigsSleuth = implement({
  version: 1,
  index: Index.NumericRange.on<{
    network: KnownNetwork.Name,
    block: Eth.Block,
    cometMarkets: Eth.Contract<StandaloneContract<Comet>>[],
  }>({
    end:    ({ block }) => block.number,
    start: ({ cometMarkets }) => {
      const contracts = cometMarkets;
      // Find the earliest creation across all contracts
      const earliestCreation = contracts.reduce((earliest, contract) => {
        if (contract.creation.block.number < earliest.block.number) {
          return contract.creation;
        } else {
          return earliest;
        }
      }, contracts[0].creation);
      return earliestCreation.block.number;
    },
    stride: ({ network, block }) => {
      const estimatedBlocksPerSecond = (
        1 / Eth.estimateSecondsTakenForBlock(network, block)
      );
      return Math.round(estimatedBlocksPerSecond * 60 * 60); // 1 Hour cache
    },
    numericPerspective: Perspective.on<{ block: Eth.Block }>().make({
      reveal: ({ block: { number } }) => number,
      impose: (reference, number) => ({ ...reference, block: { number } }),
    }),
  }),
  compute({ apiHost, nodeHost, nodeKey, cometMarkets, network, block }) {
    if (cometMarkets.length === 0) {
      return [];
    }

    const query = compiledQuery(GetRewardConfigsQuery);
    const sleuthContract = getSleuthContract(network);

    // I believe we should only ever have 1 CometReward per chain
    // meaning it's probably safe to just get the first one?
    // (If we do introduce separate reward contracts per Comet on
    // the same network, then choosing 1st won't work.)
    const cometRewardAddress = cometMarkets[0].rewards.contract.address;
    const cometAddresses = cometMarkets.map((comet) => comet.address);

    const iface = new Interface([query.fn]);
    const queryArgs = [cometRewardAddress, cometAddresses];
    const encodedArgs = iface.encodeFunctionData(query.fn.name, queryArgs);

    return pipe([
      { sleuthQuery: {
          queryBytecode: query.bytecode,
          codedArgs: encodedArgs,
          apiHost,
          nodeHost,
          nodeKey,
          network,
          blockNumber: block.number,
          contract: sleuthContract
        },
      },
      async ({sleuthQuery}) => {
        let decodedResult;
        if(sleuthQuery === '0x') {
          throw new Error(`GetRewardConfigsSleuth: Slueth query result was 0x on network: ${network}`);
        } else {
          decodedResult = await iface.decodeFunctionResult(query.fn, sleuthQuery);
          if (Array.isArray(decodedResult) && decodedResult.length === 1) {
            decodedResult = decodedResult[0] as RewardConfigSleuth[];
          }
        }
        const mappedResult = decodedResult.map((decodedRewardConfig, index) => {
          return {
            cometAddress: cometMarkets[index].address,
            rewardConfig: {
              rewardToken: decodedRewardConfig.token,
              rescaleFactor: decodedRewardConfig.rescaleFactor,
              shouldUpscale: decodedRewardConfig.shouldUpscale,
            }
          }
        });

        return value(mappedResult);
      },
    ]);
  },
});

/*
 * The query the Sleuth contract runs is GetRewardConfigs.json under
 * ../sleuth/out, a forge build of the query in ../sleuth/GetRewardConfigs.sol.
 * The worker reads its creation bytecode and the ABI of its query function
 * from the committed file, as Sleuth.querySol of @compound-finance/sleuth did.
 * It never compiles Solidity. To change the query, rebuild the file on a
 * developer machine with forge, or with solc in the same shape. Its metadata
 * names the compiler and the settings. The .sol here is not byte for byte the
 * source that the metadata hashes. So a rebuild from it changes the bytecode
 * even when the query stays the same, and with it the calldata and the cache
 * keys of sleuthQuery.
 */
function compiledQuery(
  { abi, bytecode }: { abi: readonly JsonFragment[], bytecode: { object: string } },
): { bytecode: string, fn: FunctionFragment } {
  const fn = abi.find(({ type, name }) => type === 'function' && name === 'query');
  if (fn === undefined) {
    throw new Error('GetRewardConfigsSleuth: the compiled query has no query function');
  }
  return { bytecode: bytecode.object, fn: FunctionFragment.from(fn) };
}

export { GetRewardConfigsSleuth, getRewardConfigsSleuth };
