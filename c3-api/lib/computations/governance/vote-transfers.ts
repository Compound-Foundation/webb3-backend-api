import * as Eth      from '../../eth-constants.js';
import * as Index    from '../../symbolic/index.js';
import * as Compute  from '../../symbolic/computation.js';
import { BigFixnum } from '../../bigfixnum.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

import * as governance from '../../model/governance.js';

import type * as evm from '../evm.js';

import type {
  ERC20,
  StandaloneContract,
} from '../../well-known/contracts/types.js';

type VoteTransfers = Compute.Recurrence.Spec<{
  name: 'voteTransfers',
  basis: {
    network: Extract<KnownNetwork.Name, `ethereum-${'mainnet'}`>,
    contract: Eth.Contract<StandaloneContract<ERC20>>,
    maxTransferHistoryCount: number,
  },
  cursor: {
    blockNumber: Eth.BlockNumber,
  },
  depends: [ evm.EthGetLogs, evm.EthGetBlock ],
  expects: {
    apiHost: string,
    nodeHost: string,
    nodeKey: string
  },
  returns: governance.VoteTransfersByAddress,
}>;

const {
  pipe1,
  implement,
  fromPrevious,
} = Compute.Recurrence.Functor<VoteTransfers>({});

const voteTransfers = implement({
  version: 1,
  index: Index.BlockNumberRange<VoteTransfers['expects']>({
    start: ({ contract: { creation } }) => creation.block.number,
    /*
     * index every 50,000th block (per ~7 days)
     * the stride can't be set too high or else the node api will
     * error out when there's too many logs to fetch.
     */
    stride: 50_000,
  }),
  origin: ({}) => ({}),
  compute({ apiHost, nodeHost, nodeKey, blockNumber, network, maxTransferHistoryCount, contract }) {
    return fromPrevious(previous => pipe1([
      {
        ethGetLogs: {
          apiHost,
          nodeHost,
          nodeKey,
          network,
          addresses:  [ contract.address ],
          blockRange: [ previous.cursor.blockNumber, blockNumber ],
          filter:     [ coders.topics.DelegateVotesChanged ],
        }
      },
      rawLogs => {
        const voteTransfersByAddress = {...previous.value};
        for (const log of rawLogs) {
          if (log.removed) continue;
          const decoded = coders.decode(log);
          switch (decoded.name) {
            case 'DelegateVotesChanged': {
              // FIXME: cast
              const address = decoded.body.delegate.toLowerCase() as Eth.Address;
              const netVotesChanged = BigFixnum.from({
                value: decoded.body.newBalance.sub(decoded.body.previousBalance),
                decimals: contract.decimals,
              });
              const newTransferEvent: governance.voteTransfer.VoteTransferEvent = {
                netVotesChanged,
                newBalance: BigFixnum.from({
                  value: decoded.body.newBalance,
                  decimals: contract.decimals,
                }),
                transactionHash: log.transactionHash,
                blockNumber: parseInt(log.blockNumber, 16),
              };
              if (!(address in voteTransfersByAddress)) {
                voteTransfersByAddress[address] = [];
              }
              /*
               * NOTE(jordan): this emulation of a circular buffer is not
               * very efficient, but perhaps slightly better with 1
               * shallow array copy (i.e. slice) instead of 2+ copies.
               */
              const oldTransfers = voteTransfersByAddress[address];
              const updatedTransfers = [ newTransferEvent ];
              updatedTransfers.push(...(
                oldTransfers.slice(0, maxTransferHistoryCount - 1)
              ));
              voteTransfersByAddress[address] = updatedTransfers;
              break;
            }
            default: {
              throw new Error(`unrecognized event: ${(decoded as any).name}`);
            }
          }
        }
        return voteTransfersByAddress;
      },
    ]));
  },
});

const coders = Eth.Event.Coder.fromSignatures([
  governance.voteTransfer.events.DelegateVotesChanged,
]);

export {
  VoteTransfers,
  voteTransfers,
}
