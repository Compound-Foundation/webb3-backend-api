import {
  ERC20,
  PriceFeed,
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

const COMP = ERC20('COMP', <const>{
  aliases: ['default'],
  description: 'Compound Governance Token',
  decimals: 18,
  network: 'base-mainnet',
  address: '0x9e1028F5F1D5eDE59748FFceE5532509976840E0',
  block: {
    number: 1716352,
    timestamp: 1690222051,
  },
});

const USDbC = ERC20('USDbC', <const>{
  description: 'USD Coin',
  decimals: 6,
  network: 'base-mainnet',
  address: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA',
  block: {
    number: 2062407,
    timestamp: 1690914161,
  },
});

const USDC = ERC20('USDC', <const>{
  description: 'USD Coin',
  decimals: 6,
  network: 'base-mainnet',
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  block: {
    number: 2797221,
    timestamp: 1692383789,
  },
});

const cbETH = ERC20('cbETH', <const>{
  description: 'Coinbase Wrapped Ether',
  decimals: 18,
  network: 'base-mainnet',
  address: '0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22',
  block: {
    number: 1600576,
    timestamp: 1689990499,
    },
});

const WETH = ERC20('WETH', <const>{
  aliases: ['default', 'weth-default'],
  description: 'Wrapped Ether',
  decimals: 18,
  network: 'base-mainnet',
  address: '0x4200000000000000000000000000000000000006',
  block: {
    number: 0,
    timestamp: 1_686_789_347,
  },
});

const cbBTC = ERC20('cbBTC', <const>{
  description: 'Coinbase Wrapped BTC',
  decimals: 18,
  network: 'base-mainnet',
  address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
  block: {
    number: 18688094,
    timestamp: 1724165535,
    },
});

const wstETH = ERC20('wstETH', <const>{
  description: 'Lido Wrapped Staked ETH',
  decimals: 18,
  network: 'base-mainnet',
  address: '0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452',
  block: {
    number: 4572990,
    timestamp: 1695935327,
  },
});

const AERO = ERC20('AERO', <const>{
  description: 'Aerodrome',
  decimals: 18,
  network: 'base-mainnet',
  address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
  block: {
    number: 3200550,
    timestamp: 1693190447,
  },
});

const USDS = ERC20('USDS', <const>{
  description: 'USDS Stablecoin',
  decimals: 18,
  network: 'base-mainnet',
  address: '0x820C137fa70C8691f0e44Dc420a5e53c168921Dc',
  block: {
    number: 20884784,
    timestamp: 1728558915,
  },
});

const erc20s = <const>([USDbC, USDC, cbETH, WETH, COMP, cbBTC, wstETH, AERO, USDS]);

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'base-mainnet',
  address: '0xbdE8F31D2DdDA895264e27DD990faB3DC87b372d',
  block: {
    number: 2197578,
    timestamp: 1691184503,
  },
});

const CometFactory = UntypedContract('CometFactory', <const>{
  network: 'base-mainnet',
  address: '0x27C348936400791b7350d80Fb81Bc61Ad68dF4AE',
  block: {
    number: 2197583,
    timestamp: 1691184513,
  },
});

const CometRewards = UntypedContract('CometRewards', <const>{
  network: 'base-mainnet',
  address: '0x123964802e6ABabBE1Bc9547D72Ef1B69B00A6b1',
  block: {
    number: 2197596,
    timestamp: 1691184539,
  },
});

const WETH_USD_priceFeed = PriceFeed(<const>{
  aliases: ['WETH-USD'],
  decimals: 8,
  network: 'base-mainnet',
  address: '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70',
  block: {
    number: 2092862,
    timestamp: 1690975071,
  },
});

const WETH_ETH_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: 'base-mainnet',
  address: '0x9f485610E26B9c0140439f88Dc0C7742903Bd1CF',
  block: {
    number: 2495258,
    timestamp: 1691779863,
  },
});

const cbETH_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: 'base-mainnet',
  address: '0x4687670f5f01716fAA382E2356C103BaD776752C',
  block: {
    number: 2197575,
    timestamp: 1691184497,
  },
});

const COMP_USD_priceFeed = PriceFeed(<const>{
  aliases: ['COMP-USD'],
  decimals: 8,
  network: 'base-mainnet',
  address: '0x9DDa783DE64A9d1A60c49ca761EbE528C35BA428',
  block: {
    number: 2095426,
    timestamp: 1690980199,
  },
});

const AERO_USD_priceFeed = PriceFeed(<const>{
  aliases: ['AERO-USD'],
  decimals: 8,
  network: 'base-mainnet',
  address: '0x4EC5970fC728C5f65ba413992CD5fF6FD70fcfF0',
  block: {
    number: 12730252,
    timestamp: 1712249851,
  },
});

const USDS_USD_priceFeed = PriceFeed(<const>{
  aliases: ['USDS-USD'],
  decimals: 8,
  network: 'base-mainnet',
  address: '0x2330aaE3bca5F05169d5f4597964D44522F62930',
  block: {
    number: 23311104,
    timestamp: 1733411555,
  },
});

const Bulker = UntypedContract('Bulker', {
  aliases: [ '01-usdbc', 'cUSDbCv3', '01-weth', 'cWETHv3', '01-usds', 'cUSDSv3' ],
  network: 'base-mainnet',
  address: '0x78D0677032A35c63D142a48A2037048871212a8C',
  block: {
    number: 2197618,
    timestamp: 1691184583,
  },
});

const markets = <const>([
  Bulker,
  CometAdmin, CometRewards, CometFactory,
  WETH_USD_priceFeed, COMP_USD_priceFeed, cbETH_USD_priceFeed,
  WETH_ETH_priceFeed, AERO_USD_priceFeed, USDS_USD_priceFeed,
]);

const L2CrossDomainMessenger = UntypedContract('L2CrossDomainMessenger', {
  aliases: ['default'],
  network: 'base-mainnet',
  address: '0x4200000000000000000000000000000000000007',
  block: {
    number: 0,
    timestamp: 1_686_789_347,
  },
});

const L2StandardBridge = UntypedContract('L2StandardBridge', {
  aliases: ['default'],
  network: 'base-mainnet',
  address: '0x4200000000000000000000000000000000000010',
  block: {
    number: 0,
    timestamp: 1_686_789_347,
  },
});

const BridgeReceiver = UntypedContract('BridgeReceiver', {
  aliases: ['default'],
  network: 'base-mainnet',
  address: '0x18281dfC4d00905DA1aaA6731414EABa843c468A',
  block: {
    number: 2197570,
    timestamp: 1691184487,
  },
});

const Configurator = UntypedContract('Configurator', <const>{
  network: 'base-mainnet',
  address: '0x45939657d1CA34A8FA39A924B71D28Fe8431e581',
  block: {
    number: 2197594,
    timestamp: 1691184535,
  },
});

const LocalTimelock = UntypedContract('Timelock', {
  aliases: ['default'],
  network: 'base-mainnet',
  address: '0xCC3E7c85Bb0EE4f09380e041fee95a0caeDD4a02',
  block: {
    number: 2197572,
    timestamp: 1691184491,
  },
});

const contractData = [
  ...erc20s,
  ...markets,
  L2StandardBridge,
  L2CrossDomainMessenger,
  BridgeReceiver,
  LocalTimelock,
  Configurator,
] as const;

export const wellKnown = StaticWellKnownContracts(contractData);
