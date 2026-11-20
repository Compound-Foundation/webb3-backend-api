import {
  ERC20,
  PriceFeed,
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

const USDCe = ERC20('USDC.e', <const>{
  description: 'Bridged USD Coin',
  decimals: 6,
  network: 'arbitrum-mainnet',
  address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
  block: {
    number: 2609,
    timestamp: 1623868379,
  },
});

const USDC = ERC20('USDC', <const>{
  description: 'USD Coin',
  decimals: 6,
  network: 'arbitrum-mainnet',
  address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  block: {
    number: 34266938,
    timestamp: 1667248932,
  },
});

const ARB = ERC20('ARB', <const>{
  description: 'Arbitrum',
  decimals: 18,
  network: 'arbitrum-mainnet',
  address: '0x912CE59144191C1204E64559FE8253a0e49E6548',
  block: {
    number: 70398215,
    timestamp: 1678968508,
  },
});

const GMX = ERC20('GMX', <const>{
  description: 'GMX',
  decimals: 18,
  network: 'arbitrum-mainnet',
  address: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
  block: {
    number: 147903,
    timestamp: 1626958493,
  },
});

const WBTC = ERC20('WBTC', <const>{
  description: 'Wrapped BTC',
  decimals: 8,
  network: 'arbitrum-mainnet',
  address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
  block: {
    number: 2591,
    timestamp: 1626459469,
  },
});

const WETH = ERC20('WETH', <const>{
  aliases: ['default'],
  description: 'Wrapped Ether',
  decimals: 18,
  network: 'arbitrum-mainnet',
  address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  block: {
    number: 55,
    timestamp: 1622346702,
  },
});

const COMP = ERC20('COMP', <const>{
  aliases: ['default'],
  description: 'Compound Governance Token',
  decimals: 18,
  network: 'arbitrum-mainnet',
  address: '0x354A6dA3fcde098F8389cad84b0182725c6C91dE',
  block: {
    number: 199738,
    timestamp: 1627937552,
  },
});

const weETH = ERC20('weETH', <const>{
  description: 'Wrapped eETH',
  decimals: 18,
  network: 'arbitrum-mainnet',
  address: '0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe',
  block: {
    number: 156547814,
    timestamp: 1701625072,
  },
});

const rETH = ERC20('rETH', <const>{
  description: 'Rocket Pool ETH',
  decimals: 18,
  network: 'arbitrum-mainnet',
  address: '0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8',
  block: {
    number: 3141009,
    timestamp: 1637303351,
  },
});

const wstETH = ERC20('wstETH', <const>{
  description: 'Lido Wrapped Staked ETH',
  decimals: 18,
  network: 'arbitrum-mainnet',
  address: '0x5979D7b546E38E414F7E9822514be443A4800529',
  block: {
    number: 19364208,
    timestamp: 1659608815,
  },
});

const USDT = ERC20('USDT', <const>{
  description: 'Tether',
  decimals: 6,
  // location
  network: 'arbitrum-mainnet',
  address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
  block: {
    number: 0,
    timestamp: 1610639500,
  },
});

const erc20s = <const>([
  USDC, USDCe, COMP, WBTC, WETH, 
  ARB, GMX, weETH, rETH, wstETH, USDT
]);

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'arbitrum-mainnet',
  address: '0xD10b40fF1D92e2267D099Da3509253D9Da4D715e',
  block: {
    number: 87335147,
    timestamp: 1683235187,
  },
});

const CometFactory = UntypedContract('CometFactory', <const>{
  network: 'arbitrum-mainnet',
  address: '0xe2AA5194E45B043AfdD6E98F467c0B1c13484ae9',
  block: {
    number: 87335169,
    timestamp: 1683235193,
  },
});

const CometRewards = UntypedContract('CometRewards', <const>{
  network: 'arbitrum-mainnet',
  address: '0x88730d254A2f7e6AC8388c3198aFd694bA9f7fae',
  block: {
    number: 87335253,
    timestamp: 1683235215,
  },
});

const USDC_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: 'arbitrum-mainnet',
  address: '0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3',
  block: {
    number: 101256,
    timestamp: 1626128765,
  },
});

const WETH_USD_priceFeed = PriceFeed(<const>{
  aliases: ['WETH-USD'],
  decimals: 8,
  network: 'arbitrum-mainnet',
  address: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612',
  block: {
    number: 219385893,
    timestamp: 1717772568,
  },
});

const WETH_ETH_priceFeedConstant = PriceFeed(<const>{
  decimals: 8,
  network: 'arbitrum-mainnet',
  address: '0xdB7EdFa090061D9367CbEAF6bE16ECbDE596676C',
  block: {
    number: 219385869,
    timestamp: 1717772562,
  },
});

const COMP_USD_priceFeed = PriceFeed(<const>{
  aliases: ['COMP-USD'],
  decimals: 8,
  network: 'arbitrum-mainnet',
  address: '0xe7C53FFd03Eb6ceF7d208bC4C13446c76d1E5884',
  block: {
    number: 15435721,
    timestamp: 1655934115,
  },
});

const Bulker_01usdc = UntypedContract('Bulker', {
  aliases: ['01-usdc', 'cUSDCv3', '01-weth', 'cWETHv3', '01-usdt', 'cUSDTv3'],
  network: 'arbitrum-mainnet',
  address: '0xbdE8F31D2DdDA895264e27DD990faB3DC87b372d',
  block: {
    number: 87335347,
    timestamp: 1683235239,
  },
});

const markets = <const>([
  CometAdmin, CometRewards, CometFactory, Bulker_01usdc,
  COMP_USD_priceFeed, USDC_USD_priceFeed,
  WETH_USD_priceFeed, WETH_ETH_priceFeedConstant
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'arbitrum-mainnet',
  address: '0xb21b06D71c75973babdE35b49fFDAc3F82Ad3775',
  block: {
    number: 87335242,
    timestamp: 1683235212,
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', {
  aliases: ['default'],
  network: 'arbitrum-mainnet',
  address: '0x42480C37B249e33aABaf4c22B20235656bd38068',
  block: {
    number: 87335111,
    timestamp: 1683235178,
  },
});
const LocalTimelock = UntypedContract('Timelock', {
  aliases: ['default'],
  network: 'arbitrum-mainnet',
  address: '0x3fB4d38ea7EC20D91917c09591490Eeda38Cf88A',
  block: {
    number: 87335128,
    timestamp: 1683235182,
  },
});
const misc = <const>([Configurator, BridgeReceiver, LocalTimelock]);


const contractData = [
  ...erc20s,
  ...markets,
  ...misc,
  // everything else...
] as const;

export const wellKnown = StaticWellKnownContracts(contractData);
