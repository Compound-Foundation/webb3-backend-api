import * as abiFunction from '../abi-function.js';

/*
 * Transaction history calls decimals() only on a token no registry version
 * describes, which it meets where a market listed a collateral, or started
 * paying a reward token, after the version's import: every token a version
 * describes has its decimals there. A Comet takes no collateral, and
 * CometRewards no reward token, that does not answer it.
 */
type Erc20Decimals = abiFunction.Spec<{
  name: 'erc20Decimals',
  returns: number,
}>;

const { implement } = abiFunction.Functor<Erc20Decimals>({});
const erc20Decimals = implement({
  version: 1,
  signature: `function decimals() view returns (uint8)`,
  parser: ([ decimals ]) => Number(decimals),
});

export { Erc20Decimals, erc20Decimals };
