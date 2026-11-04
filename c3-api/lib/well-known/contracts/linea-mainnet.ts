import {
  ERC20,
  PriceFeed,
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

const USDC = ERC20('USDC', <const>{
  aliases: [ 'default' ],
  description: 'USDC',
  decimals: 6,
  network: 'linea-mainnet',
  address: '0x176211869cA2b568f2A7D4EE941E073a821EE1ff',
  block: {
    number: 117878,
    timestamp: 1691084270
  },
});
const WETH = ERC20('WETH', <const>{
  description: 'WETH',
  decimals: 18,
  network: 'linea-mainnet',
  address: '0xe5D7C2a44FfDDf6b295A15c148167daaAf5Cf34f',
  block: {
    number: 624,
    timestamp: 1689349594
  },
});
const wstETH = ERC20('wstETH', <const>{
  description: 'Lido Wrapped Staked ETH',
  decimals: 18,
  network: 'linea-mainnet',
  address: '0xB5beDd42000b71FddE22D3eE8a79Bd49A568fC8F',
  block: {
    number: 34113,
    timestamp: 1691099231
  },
});
const WBTC = ERC20('WBTC', <const>{
  description: 'Wrapped BTC',
  decimals: 8,
  network: 'linea-mainnet',
  address: '0x3aAB2285ddcDdaD8edf438C1bAB47e1a9D05a9b4',
  block: {
    number: 116725,
    timestamp: 1691070334
  },
});
const COMP = ERC20('COMP', <const>{
  description: 'Compound Governance Token',
  decimals: 18,
  network: 'linea-mainnet',
  address: '0x0ECE76334Fb560f2b1a49A60e38Cf726B02203f0',
  block: {
    number: 116736,
    timestamp: 1691070466
  },
});

const erc20s = <const>([ USDC, WETH, wstETH, WBTC, COMP ]);

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'linea-mainnet',
  address: '0x4b5DeE60531a72C1264319Ec6A22678a4D0C8118',
  block: {
    number: 15197659,
    timestamp: 1738189720
  },
});

const Comet_Rewards = UntypedContract('CometRewards', <const>{
  network: 'linea-mainnet',
  address: '0x2c7118c4C88B9841FCF839074c26Ae8f035f2921',
  block: {
    number: 15197779,
    timestamp: 1738189994
  },
});

const USDC_USD_priceFeed = PriceFeed(<const>{
  aliases: ['USDC-USD'],
  decimals: 8,
  network: 'linea-mainnet',
  address: '0xAADAa473C1bDF7317ec07c915680Af29DeBfdCb5',
  block: {
    number: 609567,
    timestamp: 1697019836,
  },
});

const COMP_USD_priceFeed = PriceFeed(<const>{
  aliases: ['COMP-USD'],
  decimals: 8,
  network: 'linea-mainnet',
  address: '0xc0068A2F7e4847DF9C3A34B27CCc07b7e15e0458',
  block: {
    number: 609567,
    timestamp: 1697019836
  },
});

const WETH_ETH_priceFeedConstant = PriceFeed(<const>{
  decimals: 8,
  network: 'linea-mainnet',
  address: '0xc4A9fFF2152fe11FBB40F059100ce1271a330C51',
  block: {
    number: 20600879,
    timestamp: 1717772562,
  },
});

const WETH_USD_priceFeed = PriceFeed(<const>{
  aliases: ['WETH-USD'],
  decimals: 8,
  network: 'linea-mainnet',
  address: '0x3c6Cd9Cc7c7a4c2Cf5a82734CD249D7D593354dA',
  block: {
    number: 602781,
    timestamp: 1751722386
  },
});

const Bulker = UntypedContract('Bulker', <const>{
  network: 'linea-mainnet',
  address: '0x023ee795361B28cDbB94e302983578486A0A5f1B',
  block: {
    number: 15197845,
    timestamp: 1738190148
  },
});

const market01usdc = <const>([
  CometAdmin, Comet_Rewards, Bulker,
  USDC_USD_priceFeed, COMP_USD_priceFeed, WETH_ETH_priceFeedConstant,
  WETH_USD_priceFeed,
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'linea-mainnet',
  address: '0x970FfD8E335B8fa4cd5c869c7caC3a90671d5Dc3',
  block: {
    number: 15197724,
    timestamp: 1738189869
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', <const>{
  aliases: [ 'default' ],
  network: 'linea-mainnet',
  address: '0x1F71901daf98d70B4BAF40DE080321e5C2676856',
  block: {
    number: 15197553,
    timestamp: 1738189471
  },
});
const LocalTimelock = UntypedContract('Timelock', <const>{
  aliases: [ 'default' ],
  network: 'linea-mainnet',
  address: '0x4A900f81dEdA753bbBab12453b3775D5f26df6F3',
  block: {
    number: 15197555,
    timestamp: 1738189475
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