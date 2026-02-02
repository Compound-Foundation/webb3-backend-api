import * as Eth      from '../../eth-constants.js';
import * as abiFunction from '../abi-function.js';
import * as v2 from '../../model/v2.js';

import * as Index from '../../symbolic/index.js';

import type {
  CTokenv2,
  StandaloneContract,
} from '../../well-known/contracts/types.js';

import { BigNumber } from '../../bignumber.js';
import { BigNumber as BigNumberBase } from '@ethersproject/bignumber';


type CTokenMetadata = abiFunction.Spec<{
  name: 'cTokenMetadata',
  expects: {
    cTokenContract:  Eth.Contract<StandaloneContract<CTokenv2>>,
  },
  returns: {
    cToken: Eth.Address;
    exchangeRateCurrent: BigNumber;
    supplyRatePerBlock: BigNumber;
    borrowRatePerBlock: BigNumber;
    reserveFactorMantissa: BigNumber;
    totalBorrows: BigNumber;
    totalReserves: BigNumber;
    totalSupply: BigNumber;
    totalCash: BigNumber;
    isListed: boolean;
    collateralFactorMantissa: BigNumber;
    underlyingAssetAddress: BigNumber;
    cTokenDecimals: BigNumber;
    underlyingDecimals: BigNumber;
    compSupplySpeed: BigNumber;
    compBorrowSpeed: BigNumber;
    borrowCap: BigNumber;
  },
}>;

const { implement } = abiFunction.Functor<CTokenMetadata>({});

const cTokenMetadata = implement({
  version: 1,
  index: Index.Everything, // TODO: HourlyBlockIndex
  signature: `function cTokenMetadata(address) returns (${v2.ctokens.CTokenMetadataStruct})`,
  parameters: ({ cTokenContract }) => [ cTokenContract.address ],
  parser: ([ val ]) => mapBigNumbersInObject(val),
});

// Ethers parses the data as an array with keys oddly.
// It's useable, but in order to cache it, we need to
// convert it to an actual JS object and also update
// to use our internal, revivable BigNumber library when applicable.
function mapBigNumbersInObject(obj: any[]): any {
  const newObj: {[key: string]: any} = {};
  for (const key in obj) {
    if (Number.isNaN(parseInt(key))) {
      if (BigNumberBase.isBigNumber(obj[key])) {
        newObj[key] = BigNumber.from(obj[key]);
      }
      else {
        newObj[key] = obj[key];
      }
    }
  }
  return newObj;
}

export { CTokenMetadata, cTokenMetadata };
