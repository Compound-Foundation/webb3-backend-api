import {
  Comet,
  ERC20,
  PriceFeed,
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

const OP = ERC20('OP', <const>{
  description: 'OP',
  decimals: 18,
  // location
  network: 'optimism-mainnet',
  address: '0x4200000000000000000000000000000000000042',
  block: {
    number: 6490467,
    timestamp: 1650979836,
  },
});

const COMP = ERC20('COMP', <const>{
  aliases: ['default'],
  description: 'Compound Governance Token',
  decimals: 18,
  // location
  network: 'optimism-mainnet',
  address: '0x7e7d4467112689329f7E06571eD0E8CbAd4910eE',
  block: {
    number: 116849392,
    timestamp: 1709297561,
  },
});

const WBTC = ERC20('WBTC', <const>{
  description: 'Wrapped BTC',
  decimals: 8,
  // location
  network: 'optimism-mainnet',
  address: '0x68f180fcCe6836688e9084f035309E29Bf0A2095',
  block: {
    number: 0,
    timestamp: 1610639500,
  },
});

const WETH = ERC20('WETH', <const>{
  aliases: ['weth-default'],
  description: 'Wrapped Ether',
  decimals: 18,
  // location
  network: 'optimism-mainnet',
  address: '0x4200000000000000000000000000000000000006',
  block: {
    number: 0,
    timestamp: 1610639500,
  },
});

const USDC = ERC20('USDC', <const>{
  description: 'USD Coin',
  decimals: 6,
  // location
  network: 'optimism-mainnet',
  address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
  block: {
    number: 38198364,
    timestamp: 1668453318,
  },
});

const USDT = ERC20('USDT', <const>{
  description: 'Tether',
  decimals: 6,
  // location
  network: 'optimism-mainnet',
  address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
  block: {
    number: 0,
    timestamp: 1610639500,
  },
});

const wstETH = ERC20('wstETH', <const>{
  description: 'Lido Wrapped Staked ETH',
  decimals: 18,
  network: 'optimism-mainnet',
  address: '0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb',
  block: {
    number: 17831118,
    timestamp: 1659687832,
  },
});

const rETH = ERC20('rETH', <const>{
  description: 'Rocket Pool ETH',
  decimals: 18,
  network: 'optimism-mainnet',
  address: '0x9Bcef72be871e61ED4fBbc7630889beE758eb81D',
  block: {
    number: 113681,
    timestamp: 1637032878,
  },
});

const erc20s = <const>([
  WETH, COMP, WBTC, USDC, USDT, OP, wstETH, rETH
]);

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'optimism-mainnet',
  address: '0x3C30B5a5A04656565686f800481580Ac4E7ed178',
  block: {
    number: 118406267,
    timestamp: 1712411311
  },
});

const CometFactory = UntypedContract('CometFactory', <const>{
  network: 'optimism-mainnet',
  address: '0xFa454dE61b317b6535A0C462267208E8FdB89f45',
  block: {
    number: 118406272,
    timestamp: 1712411321
  },
});

const Comet_Rewards = UntypedContract('CometRewards', <const>{
  network: 'optimism-mainnet',
  address: '0x443EA0340cb75a160F31A440722dec7b5bc3C2E9',
  block: {
    number: 118406283,
    timestamp: 1712411343
  },
});

const USDC_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: 'optimism-mainnet',
  address: '0x16a9FA2FDa030272Ce99B29CF780dFA30361E0f3',
  block: {
    number: 2771613,
    timestamp: 1643059882
  },
});

const USDT_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: 'optimism-mainnet',
  address: '0xECef79E109e997bCA29c1c0897ec9d7b03647F5E',
  block: {
    number: 2771389,
    timestamp: 1643059494
  },
});

const COMP_USD_priceFeed = PriceFeed(<const>{
  aliases: ['COMP-USD'],
  decimals: 8,
  network: 'optimism-mainnet',
  address: '0xe1011160d78a80E2eEBD60C228EEf7af4Dfcd4d7',
  block: {
    number: 106877497,
    timestamp: 1689353771
  },
});

const WETH_ETH_priceFeedConstant = PriceFeed(<const>{
  decimals: 8,
  network: 'optimism-mainnet',
  address: '0x0be923b1716115d742E35Fa359d415598c50510F',
  block: {
    number: 122730199,
    timestamp: 1721059175,
  },
});

const WETH_USD_priceFeed = PriceFeed(<const>{
  aliases: ['WETH-USD'],
  decimals: 8,
  network: 'optimism-mainnet',
  address: '0x13e3Ee699D1909E989722E753853AE30b17e08c5',
  block: {
    number: 2014119,
    timestamp: 1641488614,
  },
});

const Comet_01usdc = Comet(<const>{
  // The naming overlaps with our cUSDCv3 mainnet market, but
  // it's fine to display, since cross-chain will always
  // explicitly mention they're bridged to the new chain.
  displayName: 'cUSDCv3',
  aliases: [ '01-usdc', 'cUSDCv3' ],
  base: {
    asset:     USDC,
    priceFeed: USDC_USD_priceFeed,
  },
  rewards: {
    asset:    COMP,
    contract: Comet_Rewards,
    priceFeed: COMP_USD_priceFeed,
  },
  network: 'optimism-mainnet',
  address: '0x2e44e174f7D53F0212823acC11C01A11d58c5bCB',
  block: {
    number: 118406276,
    timestamp: 1712411329
  },
});

const Comet_01usdt = Comet(<const>{
  displayName: 'cUSDTv3',
  aliases: [ '01-usdt', 'cUSDTv3' ],
  base: {
    asset:     USDT,
    priceFeed: USDT_USD_priceFeed,
  },
  rewards: {
    asset:    COMP,
    contract: Comet_Rewards,
    priceFeed: COMP_USD_priceFeed,
  },
  network: 'optimism-mainnet',
  address: '0x995E394b8B2437aC8Ce61Ee0bC610D617962B214',
  block: {
    number: 120295564,
    timestamp: 1716189905
  },
});

const Comet_01weth = Comet(<const>{
  displayName: 'cWETHv3',
  aliases: [ '01-weth', 'cWETHv3' ],
  base: {
    asset: WETH,
    priceFeed: WETH_ETH_priceFeedConstant,
    usdPriceFeed: WETH_USD_priceFeed,
  },
  rewards: {
    asset: COMP,
    priceFeed: COMP_USD_priceFeed,
    contract: Comet_Rewards,
  },
  network: 'optimism-mainnet',
  address: '0xE36A30D249f7761327fd973001A32010b521b6Fd',
  block: {
    number: 122730232,
    timestamp: 1721059241,
  },
});

const Bulker = UntypedContract('Bulker', <const>{
  aliases: ['01-usdc', 'cUSDCv3', '01-usdt', 'cUSDTv3', '01-weth', 'cWETHv3'],
  network: 'optimism-mainnet',
  address: '0xcb3643CC8294B23171272845473dEc49739d4Ba3',
  block: {
    number: 118406301,
    timestamp: 1712411379
  },
});

const markets = <const>([
  CometAdmin, Comet_Rewards, CometFactory, Bulker,
  USDC_USD_priceFeed, USDT_USD_priceFeed,
  Comet_01usdc, Comet_01usdt, COMP_USD_priceFeed,
  WETH_ETH_priceFeedConstant, WETH_USD_priceFeed, Comet_01weth
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'optimism-mainnet',
  address: '0x84E93EC6170ED630f5ebD89A1AAE72d4F63f2713',
  block: {
    number: 118406281,
    timestamp: 1712411339
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', <const>{
  aliases: [ 'default' ],
  network: 'optimism-mainnet',
  address: '0xC3a73A70d1577CD5B02da0bA91C0Afc8fA434DAF',
  block: {
    number: 118406258,
    timestamp: 1712411293
  },
});
const LocalTimelock = UntypedContract('Timelock', <const>{
  aliases: [ 'default' ],
  network: 'optimism-mainnet',
  address: '0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07',
  block: {
    number: 118406261,
    timestamp: 1712411299
  },
});
const misc = <const>([Configurator, BridgeReceiver, LocalTimelock]);

const contractData = [
  ...erc20s,
  ...markets,
  ...misc,
] as const;

export const wellKnown = StaticWellKnownContracts(contractData);
