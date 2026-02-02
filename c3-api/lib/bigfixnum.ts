import {
  BigNumber,
  BigNumberish,
  BigNumberJson,
  formatFixed,
} from './bignumber.js';

import type * as Json from './json-types.js';

class BigFixnum {
  value:       BigNumber;
  decimals:    number;
  multiplier?: BigNumber; // NOTE(jordan): only kept around for debugging

  static from(parameters: BigFixnumish) {
    const value = BigNumber.from(parameters.value);
    if ('multiplier' in parameters) {
      const multiplier = BigNumber.from(parameters.multiplier);
      return new BigFixnum({ value, multiplier });
    } else if ('decimals' in parameters) {
      return new BigFixnum({ value, decimals: parameters.decimals });
    } else {
      return new BigFixnum({ value, decimals: 0 });
    }
  }

  static JsonReviver: Json.Reviver<BigFixnum> = {
    accept: isRevivable,
    revive: BigFixnum.from,
  };

  toJSON(): BigFixnumJson {
    return {
      type: 'BigFixnum',
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
    return new BigFixnum({
      value: scaledValue,
      decimals: this.decimals + delta,
    });
  }

  lt(other: BigFixnum): boolean {
    const decimals = Math.max(this.decimals, other.decimals);
    const left  =  this.scaleToDecimals(decimals);
    const right = other.scaleToDecimals(decimals);
    return left.value.lt(right.value);
  }

  gt(other: BigFixnum): boolean {
    const decimals = Math.max(this.decimals, other.decimals);
    const left  =  this.scaleToDecimals(decimals);
    const right = other.scaleToDecimals(decimals);
    return left.value.gt(right.value);
  }

  eq(other: BigFixnum): boolean {
    const decimals = Math.max(this.decimals, other.decimals);
    const left  =  this.scaleToDecimals(decimals);
    const right = other.scaleToDecimals(decimals);
    return left.value.eq(right.value);
  }

  lte(other: BigFixnum): boolean {
    return this.eq(other) || this.lt(other);
  }

  gte(other: BigFixnum): boolean {
    return this.eq(other) || this.gt(other);
  }

  add(other: BigFixnum): BigFixnum {
    const decimals = Math.max(this.decimals, other.decimals);
    const left  =  this.scaleToDecimals(decimals);
    const right = other.scaleToDecimals(decimals);
    return new BigFixnum({ value: left.value.add(right.value), decimals });
  }

  sub(other: BigFixnum): BigFixnum {
    const decimals = Math.max(this.decimals, other.decimals);
    const left  =  this.scaleToDecimals(decimals);
    const right = other.scaleToDecimals(decimals);
    return new BigFixnum({ value: left.value.sub(right.value), decimals });
  }

  mul(other: BigFixnum): BigFixnum {
    return new BigFixnum({
      value:    this.value.mul(other.value),
      decimals: this.decimals + other.decimals,
    });
  }

  div(other: BigFixnum): BigFixnum {
    const morePrecise = this.scaleToDecimals(this.decimals + other.decimals);
    return new BigFixnum({
      value: morePrecise.value.div(other.value),
      decimals: morePrecise.decimals - other.decimals,
    });
  }

  private constructor(
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

type BigFixnumJson = {
  type: 'BigFixnum',
  value: BigNumberJson,
  decimals: number,
};

type BigFixnumish = {
  value: (
    | BigNumber
    | BigNumberish
    | BigNumberJson
  ),
  decimals?: number,
  multiplier?: BigNumberish,
};

function isRevivable(value: any): boolean {
  return typeof value === 'object'
    && value !== null
    && 'decimals' in value && typeof(value.decimals) === 'number'
    && 'type'     in value && (false
      || value.type === 'BigFixnum'
      || value.type === 'ScaledBigNumber'
    )
    && 'value'    in value && (false
      || BigNumber.JsonReviver.accept(value.value)
      || BigNumber.isBigNumber(value.value)
    )
  ;
}

export {
  BigFixnum,
  BigFixnumish,
  BigFixnumJson,
  isRevivable,
};
