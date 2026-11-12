import { BigFixnum }    from '../../bigfixnum.js';
import * as Eth         from '../../eth-constants.js';
import * as Key         from '../../symbolic/key.js';
import * as abiFunction from '../abi-function.js';
import { throttle }     from '../../throttle.js';

/*
 * A price as a Comet reads it, or why it could not be read.
 *
 * Comet.getPrice calls latestRoundData on the feed and reverts with it, so a
 * feed Chainlink retired reverts every read of that price. The read answers
 * the revert instead of failing, so a summary can report the price it could
 * not read beside the ones it could. A node that does not answer still fails.
 */
type PriceError = { status: 'error', message: string };
type PriceRead  = { status: 'success', price: BigFixnum } | PriceError;

type GetPrice = abiFunction.Spec<{
  name: 'getPrice',
  expects: {
    priceFeed: {
      address: Eth.Address,
      decimals: number,
    },
    // a read whose revert the caller reports, or answers another way (asset-price.ts, base-price.ts)
    unreported?: true,
  },
  returns: PriceRead,
}>;

/*
 * When this isolate reports each feed that reverts, by network and feed.
 *
 * A retired feed is an expected degradation — the summary reports the price
 * it could not read beside the ones it could — so the line is a warning. It
 * is read by every market that prices with it, at every block a summary
 * reads, and a line for each would bury everything else in the log: one a
 * minute per feed still names it for as long as it reverts, which is what an
 * operator looks for and what an alert matches.
 */
const due = throttle(60_000);

function reportRevert(message: string, feed: Eth.Address, comet: Eth.Address, network: string, blockNumber: unknown): void {
  if (!due(`${network}:${feed.toLowerCase()}`)) {
    return;
  }
  console.warn(`price feed reverted: ${feed} read by ${comet} on ${network} at block ${blockNumber}: ${message}`);
}

const { implement } = abiFunction.Functor<GetPrice>({});
const getPrice = implement({
  // 1: a feed that reverts is answered, not thrown
  version: 1,
  signature: `function getPrice(address) view returns (uint256)`,
  key(name, { priceFeed, ...context }) {
    return Key.toKey(name, { priceFeed: priceFeed.address, ...context });
  },
  parameters: ({ priceFeed }) => [ priceFeed.address ],
  parser: ([ u256 ], { priceFeed: { decimals } }) => ({
    status: 'success',
    price:  BigFixnum.from({ decimals, value: u256 }),
  }),
  reverted: ({ message }, { priceFeed, contract, network, blockNumber, unreported }) => {
    if (unreported !== true) {
      reportRevert(message, priceFeed.address, contract.address, network, blockNumber);
    }
    return { status: 'error', message };
  },
});

export { GetPrice, PriceError, PriceRead, getPrice, reportRevert };
