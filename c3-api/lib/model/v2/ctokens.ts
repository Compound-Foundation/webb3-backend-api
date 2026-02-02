import * as Eth from '../../eth-constants.js';

type CTokenFormattedData = {
  symbol: string;
  underlying_symbol: string;
  token_address: Eth.Address;
  underlying_address: Eth.Address;
  borrow_rate: string;
  supply_rate: string;
  borrow_cap: string;
  collateral_factor: string;
  comp_borrow_apy: string;
  comp_supply_apy: string;
  exchange_rate: string;
  reserve_factor: string;
  reserves: string;
  total_borrows: string;
  total_supply: string;
  underlying_price: string;
  total_supply_value: string;
  total_borrow_value: string;
};

// Expected output of the CompoundLens' cTokenMetadata(address) function.
const CTokenMetadataStruct = `(
  address cToken,
  uint exchangeRateCurrent,
  uint supplyRatePerBlock,
  uint borrowRatePerBlock,
  uint reserveFactorMantissa,
  uint totalBorrows,
  uint totalReserves,
  uint totalSupply,
  uint totalCash,
  bool isListed,
  uint collateralFactorMantissa,
  address underlyingAssetAddress,
  uint cTokenDecimals,
  uint underlyingDecimals,
  uint compSupplySpeed,
  uint compBorrowSpeed,
  uint borrowCap
)`;

// Expected output of the CompoundLens' cTokenUnderlyingPrice(address) function.
const CTokenUnderlyingPriceStruct = `(
  address cToken,
  uint underlyingPrice
)`;

export {
  CTokenMetadataStruct,
  CTokenUnderlyingPriceStruct,
}

export type {
  CTokenFormattedData,
}
