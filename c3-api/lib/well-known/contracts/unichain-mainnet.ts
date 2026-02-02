import {
  Comet,
  ERC20,
  PriceFeed,
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

const COMP = ERC20('COMP', <const>{
  description: 'Compound Governance Token',
  decimals: 18,
  network: 'unichain-mainnet',
  address: '0xdf78e4f0a8279942ca68046476919a90f2288656',
  block: {
    number: 7962080,
    timestamp: 1738710439
  },
});
const USDC = ERC20('USDC', <const>{
  aliases: [ 'default' ],
  description: 'USDC',
  decimals: 6,
  network: 'unichain-mainnet',
  address: '0x078D782b760474a361dDA0AF3839290b0EF57AD6',
  block: {
    number: 98792,
    timestamp: 1730847151
  },
});
const UNI = ERC20('UNI', <const>{
  description: 'Uniswap',
  decimals: 18,
  network: 'unichain-mainnet',
  address: '0x8f187aa05619a017077f5308904739877ce9ea21',
  block: {
    number: 7941965,
    timestamp: 1738690324
  },
});
const WETH = ERC20('WETH', <const>{
  description: 'WETH',
  decimals: 18,
  network: 'unichain-mainnet',
  address: '0x4200000000000000000000000000000000000006',
  block: {
    number: 0,
    timestamp: 1730748359
  },
});

const weETH = ERC20('weETH', <const>{
  description: 'Wrapped eETH',
  decimals: 18,
  network: 'unichain-mainnet',
  address: '0x7DCC39B4d1C53CB31e1aBc0e358b43987FEF80f7',
  block: {
    number: 8541891,
    timestamp: 1739261450
  },
});

const wstETH = ERC20('wstETH', <const>{
  description: 'Wrapped stETH',
  decimals: 18,
  network: 'unichain-mainnet',
  address: '0xc02fE7317D4eb8753a02c35fe019786854A92001',
  block: {
    number: 8771279,
    timestamp: 1739490838
  },
});

const ezETH = ERC20('ezETH', <const>{
  description: 'Renzo Restaked ETH',
  decimals: 18,
  network: 'unichain-mainnet',
  address: '0x2416092f143378750bb29b79eD961ab195CcEea5',
  block: {
    number: 8102915,
    timestamp: 1738822474
  },
});

const WBTC = ERC20('WBTC', <const>{
  description: 'Wrapped BTC',
  decimals: 8,
  network: 'unichain-mainnet',
  address: '0x927B51f251480a681271180DA4de28D44EC4AfB8',
  block: {
    number: 7962162,
    timestamp: 1738681721
  },
});

const erc20s = <const>([ COMP, USDC, UNI, WETH, weETH, wstETH, ezETH, WBTC ]);

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'unichain-mainnet',
  address: '0xaeB318360f27748Acb200CE616E389A6C9409a07',
  block: {
    number: 9170472,
    timestamp: 1739890031
  },
});

const Comet_Rewards = UntypedContract('CometRewards', <const>{
  network: 'unichain-mainnet',
  address: '0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486',
  block: {
    number: 9170510,
    timestamp: 1739918869
  },
});

const USDC_USD_priceFeed = PriceFeed(<const>{
  aliases: ['cUSDC-USD'],
  decimals: 8,
  network: 'unichain-mainnet',
  address: '0x1F71901daf98d70B4BAF40DE080321e5C2676856',
  block: {
    number: 9170443,
    timestamp: 1739890002,
  },
});

const COMP_USD_priceFeed = PriceFeed(<const>{
  aliases: ['COMP-USD'],
  decimals: 8,
  network: 'unichain-mainnet',
  address: '0xb81131B6368b3F0a83af09dB4E39Ac23DA96C2Db',
  block: {
    number: 10689692,
    timestamp: 1741409251
  },
});

const Comet_01usdc = Comet(<const>{
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
  network: 'unichain-mainnet',
  address: '0x2c7118c4C88B9841FCF839074c26Ae8f035f2921',
  block: {
    number: 9170496,
    timestamp: 1739890055
  },
});

const ETH_Constant_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: 'unichain-mainnet',
  address: '0x3C30B5a5A04656565686f800481580Ac4E7ed178',
  block: {
    number: 15416439,
    timestamp: 1746139598,
  },
});

const ETH_USD_priceFeed = PriceFeed(<const>{
  aliases: ['WETH-USD'],
  decimals: 8,
  network: 'unichain-mainnet',
  address: '0xe8D9FbC10e00ecc9f0694617075fDAF657a76FB2',
  block: {
    number: 8433246,
    timestamp: 1739152805,
  },
});

const Comet_01weth = Comet(<const>{
  displayName: 'cWETHv3',
  aliases: ['01-weth', 'cWETHv3'],
  base: {
    asset: WETH,
    priceFeed: ETH_Constant_priceFeed,
    usdPriceFeed: ETH_USD_priceFeed,
  },
  rewards: {
    asset: COMP,
    contract: Comet_Rewards,
    priceFeed: COMP_USD_priceFeed,
  },
  network: "unichain-mainnet",
  address: "0x6C987dDE50dB1dcDd32Cd4175778C2a291978E2a",
  block: {
    number: 15416769,
    timestamp: 1746139928,
  },
});

const Bulker = UntypedContract('Bulker', <const>{
  network: 'unichain-mainnet',
  address: '0x58EbB8Db8b4FdF2dCbbB16E04c2F5b952963B514',
  block: {
    number: 9170546,
    timestamp: 1739890105
  },
});

const market01usdc = <const>([
  CometAdmin, Comet_Rewards, Bulker,
  USDC_USD_priceFeed, COMP_USD_priceFeed, Comet_01usdc,
  ETH_USD_priceFeed, Comet_01weth
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'unichain-mainnet',
  address: '0x8df378453Ff9dEFFa513367CDF9b3B53726303e9',
  block: {
    number: 9170506,
    timestamp: 1739890065
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', <const>{
  aliases: [ 'default' ],
  network: 'unichain-mainnet',
  address: '0x4b5DeE60531a72C1264319Ec6A22678a4D0C8118',
  block: {
    number: 9170459,
    timestamp: 1739890018
  },
});
const LocalTimelock = UntypedContract('Timelock', <const>{
  aliases: [ 'default' ],
  network: 'unichain-mainnet',
  address: '0x2F4eAF29dfeeF4654bD091F7112926E108eF4Ed0',
  block: {
    number: 9170463,
    timestamp: 1739890022
  },
});
const misc = <const>([Configurator, BridgeReceiver, LocalTimelock ]);

const contractData = [
  ...erc20s,
  ...market01usdc,
  ...misc,
  // everything else...
] as const;

export const wellKnown = StaticWellKnownContracts(contractData);