import * as abiFunction from '../abi-function.js';

type Symbol = abiFunction.Spec<{
  name: 'symbol';
  expects: {};
  returns: string;
}>;

const { implement } = abiFunction.Functor<Symbol>({});
const symbol = implement({
  version: 1,
  signature: `function symbol() view returns (string memory)`,
  parser: ([ symbol ]) => symbol,
});

export { Symbol, symbol };
