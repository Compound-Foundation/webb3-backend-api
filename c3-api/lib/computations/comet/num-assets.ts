import { BigNumber }    from '@ethersproject/bignumber';
import * as abiFunction from '../abi-function.js';

type NumAssets = abiFunction.Spec<{
  name: 'numAssets',
  returns: number,
}>;

const { implement } = abiFunction.Functor<NumAssets>({});
const numAssets = implement({
  version: 0, // NOTE(jordan): 0 is "no version;" FIXME: migrate
  signature: `function numAssets() view returns (uint8)`,
  parser: ([ u8 ]) => BigNumber.from(u8).toNumber(),
});

export { NumAssets, numAssets };
