import { BigNumber }    from '@ethersproject/bignumber';

import * as Eth         from '../../eth-constants.js';
import * as abiFunction from '../abi-function.js';

/*
 * What a Comet holds beyond what it owes, in the token's own units. Of its
 * base asset, that is what it holds and has lent less what its suppliers are
 * owed, which is signed: a market can owe its suppliers more than that. Of a
 * collateral asset, it is what the Comet holds beyond what its accounts
 * supplied.
 *
 * Both calls read the token's balanceOf, and the second subtracts what the
 * accounts supplied from it. A revert there is the state of the token —
 * paused, upgraded, without code, or holding less than was supplied — and
 * not a fault of the Comet, so it is an answer rather than a failure: one
 * token must not fail the summary of every network with it.
 */
type Reserves = abiFunction.Spec<{
  name: 'reserves',
  returns: BigNumber | null,
}>;

type CollateralReserves = abiFunction.Spec<{
  name: 'collateralReserves',
  expects: { asset: Eth.Address },
  returns: BigNumber | null,
}>;

/*
 * When this isolate last reported each of those reverts, by network, Comet
 * and call. As for a feed that reverts (get-price.ts), a line a minute names
 * each for as long as it reverts, rather than a line for every summary that
 * reads it. The prefix is its own: the runbook alerts on the feed's.
 */
const reported = new Map<string, number>();

const REPORT_EVERY_MS = 60_000;

function reportRevert(call: string, message: string, comet: Eth.Address, network: string, blockNumber: Eth.BlockNumber): void {
  const key  = `${network}:${comet.toLowerCase()}:${call}`;
  const at   = Date.now();
  const last = reported.get(key);
  if (last !== undefined && at - last < REPORT_EVERY_MS) {
    return;
  }
  reported.set(key, at);
  console.warn(`reserves reverted: ${call} of ${comet} on ${network} at block ${blockNumber}: ${message}`);
}

const reserves = abiFunction.Functor<Reserves>({}).implement<BigNumber | null>({
  version: 1,
  signature: `function getReserves() view returns (int256)`,
  parser: ([ i256 ]) => BigNumber.from(i256),
  reverted: ({ message }, { contract, network, blockNumber }) => {
    reportRevert('getReserves()', message, contract.address, network, blockNumber);
    return null;
  },
});

const collateralReserves = abiFunction.Functor<CollateralReserves>({}).implement<BigNumber | null>({
  version: 1,
  signature: `function getCollateralReserves(address) view returns (uint256)`,
  parameters: ({ asset }) => [ asset ],
  parser: ([ u256 ]) => BigNumber.from(u256),
  reverted: ({ message }, { asset, contract, network, blockNumber }) => {
    reportRevert(`getCollateralReserves(${asset})`, message, contract.address, network, blockNumber);
    return null;
  },
});

export { CollateralReserves, Reserves, collateralReserves, reserves };
