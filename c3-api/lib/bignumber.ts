import { BigNumber as BigNumberBase } from '@ethersproject/bignumber';

import type * as Json from './json-types.js';

type BigNumberJson = {
  type: 'BigNumber',
  hex: string,
};

function isRevivable(value: any): boolean {
  return typeof value === 'object'
      && value !== null
      && 'type' in value
      && value.type === 'BigNumber'
      && /0x[A-Fa-f0-9]+/.test(value.hex)
}

class BigNumber extends BigNumberBase {
  static JsonReviver: Json.Reviver<BigNumber> = {
    accept: isRevivable,
    revive: BigNumber.from,
  };
}

export {
  BigNumber,
  BigNumberJson,
  isRevivable,
};

export {
  formatFixed,
  BigNumberish,
} from '@ethersproject/bignumber';
