// Common function signatures of actions that may be suggested
// in governance proposals
export const commonGovernanceActionSignatures = [
  'setPauseGuardian(address,address)',
  'setBaseTokenPriceFeed(address,address)',
  'setExtensionDelegate(address,address)',
  'setSupplyKink(address,uint64)',
  'setSupplyPerYearInterestRateSlopeLow(address,uint64)',
  'setSupplyPerYearInterestRateSlopeHigh(address,uint64)',
  'setSupplyPerYearInterestRateBase(address,uint64)',
  'setBorrowKink(address,uint64)',
  'setBorrowPerYearInterestRateSlopeLow(address,uint64)',
  'setBorrowPerYearInterestRateSlopeHigh(address,uint64)',
  'setBorrowPerYearInterestRateBase(address,uint64)',
  'setStoreFrontPriceFactor(address,uint64)',
  'setBaseTrackingSupplySpeed(address,uint64)',
  'setBaseTrackingBorrowSpeed(address,uint64)',
  'setBaseMinForRewards(address,uint104)',
  'setBaseBorrowMin(address,uint104)',
  'setTargetReserves(address,uint104)',
  'updateAssetPriceFeed(address,address,address)',
  'updateAssetBorrowCollateralFactor(address,address,uint64)',
  'updateAssetLiquidateCollateralFactor(address,address,uint64)',
  'updateAssetLiquidationFactor(address,address,uint64)',
  'updateAssetSupplyCap(address,address,uint128)',
  'deployAndUpgradeTo(address,address)',
  '_setCollateralFactor(address,uint256)',
  '_setMarketBorrowCaps(address[],uint256[])',

  // Polygon Bridge Functions
  'sendMessageToChild(address,bytes)',

  // Arbitrum Bridge Functions
  'createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,bytes)',

  // V2 Functions (Comptroller)
  '_setCompSpeeds(address[],uint256[],uint256[])',

  // ERC-20 transfers
  'transfer(address,uint256)',
  'transferFrom(address,address,uint256)',
];


export const setConfigurationFunctionArgTypes = [
  'address cometProxy',
  'tuple(address governor, address pauseGuardian, address baseToken, address baseTokenPriceFeed, address extensionDelegate, uint64 supplyKink, uint64 supplyPerYearInterestRateSlopeLow, uint64 supplyPerYearInterestRateSlopeHigh, uint64 supplyPerYearInterestRateBase, uint64 borrowKink, uint64 borrowPerYearInterestRateSlopeLow, uint64 borrowPerYearInterestRateSlopeHigh, uint64 borrowPerYearInterestRateBase, uint64 storeFrontPriceFactor, uint64 trackingIndexScale, uint64 baseTrackingSupplySpeed, uint64 baseTrackingBorrowSpeed, uint104 baseMinForRewards, uint104 baseBorrowMin, uint104 targetReserves, tuple(address asset, address priceFeed, uint8 decimals, uint64 borrowCollateralFactor, uint64 liquidateCollateralFactor, uint64 liquidationFactor, uint128 supplyCap)[] assetConfigs) newConfiguration'
];
