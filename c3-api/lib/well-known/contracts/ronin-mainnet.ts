import {
  Comet,
  ERC20,
  PriceFeed,
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

const AXS = ERC20('AXS', <const>{
  description: 'Axie Infinity Shard',
  decimals: 18,
  network: 'ronin-mainnet',
  address: '0x97a9107c1793bc407d6f527b77e7fff4d812bece',
  block: {
    number: 2670084,
    timestamp: 1619582027
  },
});
const USDC = ERC20('USDC', <const>{
  aliases: [ 'default' ],
  description: 'USDC',
  decimals: 6,
  network: 'ronin-mainnet',
  address: '0x0b7007c13325c48911f73a2dad5fa5dcbf808adc',
  block: {
    number: 7741826,
    timestamp: 1634797706
  },
});
const WETH = ERC20('WETH', <const>{
  description: 'WETH',
  decimals: 18,
  network: 'ronin-mainnet',
  address: '0xc99a6a985ed2cac1ef41640596c5a5f9f4e19ef5',
  block: {
    number: 777,
    timestamp: 1611574105
  },
});
const WRON = ERC20('WRON', <const>{
  description: 'Wrapped RON',
  decimals: 18,
  network: 'ronin-mainnet',
  address: '0xe514d9deb7966c8be0ca922de8a064264ea6bcd4',
  block: {
    number: 7860890,
    timestamp: 1635154920
  },
});

const erc20s = <const>([ AXS, USDC, WETH, WRON ]);

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'ronin-mainnet',
  address: '0xfa64a82a3d13d4c05d5133e53b2ebb8a0fa9c3f6',
  block: {
    number: 43343864,
    timestamp: 1741884169
  },
});

const Comet_Rewards = UntypedContract('CometRewards', <const>{
  network: 'ronin-mainnet',
  address: '0x31CdEe8609Bc15fD33cc525f101B70a81b2B1E59',
  block: {
    number: 43343882,
    timestamp: 1741884223
  },
});

const WETH_USD_priceFeed = PriceFeed(<const>{
  aliases: ['WETH-USD'],
  decimals: 8,
  network: 'ronin-mainnet',
  address: '0x662Fdb0E7D95d89CD3458E4A3506296E48BB1F44',
  block: {
    number: 41700642,
    timestamp: 1736952996,
  },
});

const WETH_ETH_priceFeedConstant = PriceFeed(<const>{
  decimals: 8,
  network: 'ronin-mainnet',
  address: '0x8ac2b57d15c84755a3333ad68025d2496ae3bebd',
  block: {
    number: 42950608,
    timestamp: 1740703836,
  },
});

//TODO: Need price feed, using WETH-USD for now
const COMP_USD_priceFeed = PriceFeed(<const>{
  aliases: ['COMP-USD'],
  decimals: 8,
  network: 'ronin-mainnet',
  address: '0x662fdb0e7d95d89cd3458e4a3506296e48bb1f44',
  block: {
    number: 41700642,
    timestamp: 1736952996
  },
});

const RON_USD_priceFeed = PriceFeed(<const>{
  aliases: ['RON-USD', 'WRON-USD'],
  decimals: 8,
  network: 'ronin-mainnet',
  address: '0x0b6074f21488b95945989e513efea070096d931d',
  block: {
    number: 41701029,
    timestamp: 1736954157,
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
    asset: USDC, //TODO: There is no COMP, USDC for now???
    priceFeed: COMP_USD_priceFeed,
    contract: Comet_Rewards,
  },
  network: 'ronin-mainnet',
  address: '0x4006eD4097Ee51c09A04c3B0951D28CCf19e6DFE',
  block: {
    number: 43343876,
    timestamp: 1741884205,
  },
});

const Comet_01wron = Comet(<const>{
  displayName: 'cWRONv3',
  aliases: [ '01-wron', 'cWRONv3' ],
  base: {
    asset: WRON,
    priceFeed: RON_USD_priceFeed,
  },
  rewards: {
    asset: USDC, //TODO: There is no COMP, USDC for now???
    priceFeed: COMP_USD_priceFeed,
    contract: Comet_Rewards,
  },
  network: 'ronin-mainnet',
  address: '0xc0afdbd1ceb621ef576ba969ce9d4cef78dbc0c0',
  block: {
    number: 44084652,
    timestamp: 1744106923,
  },
});

const Bulker = UntypedContract('Bulker', <const>{
  network: 'ronin-mainnet',
  address: '0x840281FaD56DD88afba052B7F18Be2A65796Ecc6',
  block: {
    number: 43343900,
    timestamp: 1741884277
  },
});

const market01weth = <const>([
  CometAdmin, Comet_Rewards, Bulker,
  WETH_USD_priceFeed, WETH_ETH_priceFeedConstant, COMP_USD_priceFeed,
  RON_USD_priceFeed, Comet_01weth, Comet_01wron,
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'ronin-mainnet',
  address: '0x966c72F456FC248D458784EF3E0b6d042be115F2',
  block: {
    number: 43343880,
    timestamp: 1741884217
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', <const>{
  aliases: [ 'default' ],
  network: 'ronin-mainnet',
  address: '0x2c7EfA766338D33B9192dB1fB5D170Bdc03ef3F9',
  block: {
    number: 43343519,
    timestamp: 1741883134
  },
});
const LocalTimelock = UntypedContract('Timelock', <const>{
  aliases: [ 'default' ],
  network: 'ronin-mainnet',
  address: '0xbbb0ebd903fafbb8fff58b922fd0cd85e251ac2c',
  block: {
    number: 43343859,
    timestamp: 1741884154
  },
});
const misc = <const>([Configurator, BridgeReceiver, LocalTimelock ]);

const contractData = [
  ...erc20s,
  ...market01weth,
  ...misc,
  // everything else...
] as const;

export const wellKnown = StaticWellKnownContracts(contractData);