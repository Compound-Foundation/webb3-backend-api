import {
  Comet,
  ERC20,
  PriceFeed,
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

const USDC = ERC20('USDC', <const>{
  description: 'USD Coin',
  decimals: 6,
  network: 'scroll-mainnet',
  address: '0x06eFdBFf2a14a7c8E15944D1F4A48F9F95F663A4',
  block: {
    number: 37,
    timestamp: 1696919085
  },
});
const wstETH = ERC20('wstETH', <const>{
  description: 'Lido Wrapped Staked ETH',
  decimals: 18,
  network: 'scroll-mainnet',
  address: '0xf610A9dfB7C89644979b4A0f27063E9e7d7Cda32',
  block: {
    number: 136,
    timestamp: 1696920347
  },
});
const WETH = ERC20('WETH', <const>{
  aliases: [ 'default' ],
  description: 'Wrapped Ether',
  decimals: 18,
  network: 'scroll-mainnet',
  address: '0x5300000000000000000000000000000000000004',
  block: {
    number: 0,
    timestamp: 1696917600
  },
});
const COMP = ERC20('COMP', <const>{
  aliases: [ 'default' ],
  description: 'Compound Governance Token',
  decimals: 18,
  network: 'scroll-mainnet',
  address: '0x643e160a3C3E2B7eae198f0beB1BfD2441450e86',
  block: {
    number: 2751523,
    timestamp: 1706149860
  },
});

const erc20s = <const>([ USDC, COMP, wstETH, WETH ]);

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'scroll-mainnet',
  address: '0x87A27b91f4130a25E9634d23A5B8E05e342bac50',
  block: {
    number: 3397664,
    timestamp: 1708117180
  },
});

const CometFactory = UntypedContract('CometFactory', <const>{
  network: 'scroll-mainnet',
  address: '0x85Bfa13eB2BC22A742Ca552566131d31677Bd41e',
  block: {
    number: 3397668,
    timestamp: 1708117192
  },
});

const Comet_01usdc_Rewards = UntypedContract('cUSDCv3Rewards', <const>{
  displayName: 'cUSDCv3Rewards',
  network: 'scroll-mainnet',
  address: '0x70167D30964cbFDc315ECAe02441Af747bE0c5Ee',
  block: {
    number: 3397682,
    timestamp: 1708117234
  },
});

const USDC_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: 'scroll-mainnet',
  address: '0x43d12Fb3AfCAd5347fA764EeAB105478337b7200',
  block: {
    number: 308880,
    timestamp: 1698312294
  },
});

// TODO: There is no COMP PF on Scroll
// const COMP_USD_priceFeed = PriceFeed(<const>{
//   aliases: ['COMP-USD'],
//   decimals: 8,
//   network: 'scroll-mainnet',
//   address: '0x2A8758b7257102461BC958279054e372C2b1bDE6',
//   block: {
//     number: 4481000,
//   },
// });

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
    contract: Comet_01usdc_Rewards,
    priceFeed: USDC_USD_priceFeed, // TODO: Change to COMP price feed
  },
  network: 'scroll-mainnet',
  address: '0xB2f97c1Bd3bf02f5e74d13f02E3e26F93D77CE44',
  block: {
    number: 3397674,
    timestamp: 1708117210
  },
});

const Bulker_01usdc = UntypedContract('Bulker', <const>{
  aliases: ['01-usdc', 'cUSDCv3'],
  network: 'scroll-mainnet',
  address: '0x53C6D04e3EC7031105bAeA05B36cBc3C987C56fA',
  block: {
    number: 3397701,
    timestamp: 1708117291
  },
});

const market01usdc = <const>([
  CometAdmin, Comet_01usdc_Rewards, CometFactory, Bulker_01usdc,
  USDC_USD_priceFeed, Comet_01usdc, /*COMP_USD_priceFeed, */
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'scroll-mainnet',
  address: '0xECAB0bEEa3e5DEa0c35d3E69468EAC20098032D7',
  block: {
    number: 3397679,
    timestamp: 1708117225
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', <const>{
  aliases: [ 'default' ],
  network: 'scroll-mainnet',
  address: '0xC6bf5A64896D679Cf89843DbeC6c0f5d3C9b610D',
  block: {
    number: 3397656,
    timestamp: 1708117156
  },
});
const LocalTimelock = UntypedContract('Timelock', <const>{
  aliases: [ 'default' ],
  network: 'scroll-mainnet',
  address: '0xF6013e80E9e6AC211Cc031ad1CE98B3Aa20b73E4',
  block: {
    number: 3397658,
    timestamp: 1708117162
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