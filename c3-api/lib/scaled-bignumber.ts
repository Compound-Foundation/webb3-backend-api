import {
  BigNumber,
  BigNumberish,
  BigNumberJson,
  formatFixed,
} from './bignumber.js';

import * as Json from './json-types.js';

type ScaledBigNumberJson = {
  type: 'ScaledBigNumber',
  value: BigNumberJson,
  decimals: number,
};

function isRevivable(value: any): boolean {
  return typeof value === 'object'
    && 'type'     in value && value.type === 'ScaledBigNumber'
    && 'decimals' in value && typeof(value.decimals) === 'number'
    && 'value'    in value && (false
      || BigNumber.JsonReviver.accept(value.value)
      || BigNumber.isBigNumber(value.value)
    )
  ;
}

type ScaledBigNumberIsh = {
  value: (
    | BigNumberish
    | BigNumberJson
  ),
  decimals?: number,
  multiplier?: BigNumberish,
};

class ScaledBigNumber {
  value: BigNumber;
  multiplier?: BigNumber;
  decimals: number;

  static from(parameters: ScaledBigNumberIsh) {
    const value = BigNumber.from(parameters.value);
    if ('multiplier' in parameters) {
      const multiplier = BigNumber.from(parameters.multiplier);
      return new ScaledBigNumber({ value, multiplier });
    } else if ('decimals' in parameters) {
      return new ScaledBigNumber({ value, decimals: parameters.decimals });
    } else {
      return new ScaledBigNumber({ value, decimals: 0 });
    }
  }

  static JsonReviver: Json.Reviver<ScaledBigNumber> = {
    accept: isRevivable,
    revive: ScaledBigNumber.from,
  };

  toJSON(): ScaledBigNumberJson {
    return {
      type: 'ScaledBigNumber',
      value: this.value.toJSON(),
      decimals: this.decimals,
    };
  }

  key() {
    return this.toString();
  }

  toString() {
    return formatFixed(this.value, this.decimals);
  }

  scaleToDecimals(decimals: number) {
    return this.shiftDecimalPoint(decimals - this.decimals);
  }

  shiftDecimalPoint(delta: number) {
    if (delta === 0) {
      return this;
    }
    const scale = BigNumber.from(10).pow(Math.abs(delta));
    const scaledValue = (
      delta > 0
        ? this.value.mul(scale)
        : this.value.div(scale)
    );
    return new ScaledBigNumber({
      value: scaledValue,
      decimals: this.decimals + delta,
    });
  }

  add(other: ScaledBigNumber): ScaledBigNumber {
    const decimals = Math.max(this.decimals, other.decimals);
    const left = this.scaleToDecimals(decimals);
    const right = other.scaleToDecimals(decimals);
    return new ScaledBigNumber({ value: left.value.add(right.value), decimals });
  }

  mul(other: ScaledBigNumber): ScaledBigNumber {
    return new ScaledBigNumber({
      value: this.value.mul(other.value),
      decimals: this.decimals + other.decimals,
    });
  }

  div(other: ScaledBigNumber): ScaledBigNumber {
    const morePrecise = this.scaleToDecimals(this.decimals + other.decimals);
    return new ScaledBigNumber({
      value: morePrecise.value.div(other.value),
      decimals: morePrecise.decimals - other.decimals,
    });
  }

  constructor(
    { value, ...parameters }: (
      | { value: BigNumber, multiplier: BigNumber }
      | { value: BigNumber, decimals: number }
    )
  ) {
    this.value = value;
    if ('multiplier' in parameters) {
      this.multiplier = parameters.multiplier;
      this.decimals = this.multiplier.toString().length - 1;
    } else {
      this.decimals = parameters.decimals;
    }
  }
}

export default ScaledBigNumber;

export {
  ScaledBigNumber,
  ScaledBigNumberIsh,
  ScaledBigNumberJson,
  isRevivable,
};
