import * as Eth        from '../../eth-constants.js';
import * as governance from '../../model/governance.js';
import * as Index      from '../../symbolic/index.js';
import * as Compute    from '../../symbolic/computation.js';

import type * as evm from '../evm.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

type DelegateTransfers = Compute.Recurrence.Spec<{
  name: 'delegateTransfers',
  basis: {
    network: Extract<KnownNetwork.Name, `ethereum-${'mainnet'}`>,
    contract: Eth.Contract,
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
  returns: governance.DelegatesMapping,
}>;

const {
  implement,
  fromPrevious,
  pipe1,
} = Compute.Recurrence.Functor<DelegateTransfers>({});

const delegateTransfers = implement({
  version: 1,
  index: Index.BlockNumberRange<DelegateTransfers['expects']>({
    start: ({ contract: { creation } }) => creation.block.number,
    // index every 50,000th block (per ~7 days)
    // the stride can't be set too high or else the node api will
    // error out when there's too many logs to fetch.
    stride: 50_000,
  }),
  origin: ({}) => ({}),
  compute({ apiHost, nodeHost, nodeKey, blockNumber, network, contract: { address }}, debug) {
    return fromPrevious(previous => pipe1([
      {
        ethGetLogs: {
          apiHost,
          nodeHost,
          nodeKey,
          network,
          addresses:  [ address ],
          blockRange: [ previous.cursor.blockNumber, blockNumber ],
          filter:     [ coders.topics.DelegateChanged ],
        }
      },
      rawLogs => {
        const delegatesMapping = {...previous.value};
        for (const log of rawLogs) {
          if (log.removed) continue;
          const decoded = coders.decode(log);
          switch (decoded.name) {
            case 'DelegateChanged': {
              const delegator = decoded.body.delegator.toLowerCase();
              const newDelegate = decoded.body.toDelegate.toLowerCase();
              if (!Eth.parseAddress(delegator)) {
                debug.log(`UNHANDLED: delegator address is not valid! ${delegator}`);
                continue;
              }
              if (!Eth.parseAddress(newDelegate)) {
                debug.log(`UNHANDLED: new delegate address is not valid! ${newDelegate}`);
                continue;
              }
              delegatesMapping[delegator] = newDelegate;
              break;
            }
            default: {
              throw new Error(`unrecognized event: ${(decoded as any).name}`);
            }
          }
        }
        return delegatesMapping;
      },
    ]));
  },
});


const coders = Eth.Event.Coder.fromSignatures([
  governance.delegateTransfer.events.DelegateChanged,
]);

export {
  DelegateTransfers,
  delegateTransfers,
}
