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
  network: 'optimism-goerli',
  // Our self deployed OP contract address for testnet
  address: '0x32719c5e2e35909C8f42167315445e349e749E05',
  block: {
    number: 7612424,
    timestamp: 1680652916,
  },
});

const COMP = ERC20('COMP', <const>{
  aliases: ['default'],
  description: 'Compound Governance Token',
  decimals: 18,
  // location
  network: 'optimism-goerli',
  address: '0x6AF3cb766D6cd37449bfD321D961A61B0515c1BC',
  block: {
    number: 6712919,
    timestamp: 1678853906,
  },
});

const WBTC = ERC20('WBTC', <const>{
  description: 'Wrapped BTC',
  decimals: 8,
  // location
  network: 'optimism-goerli',
  address: '0xe0a592353e81a94Db6E3226fD4A99F881751776a',
  block: {
    number: 659420,
    timestamp: 1661514437,
  },
});

// WETH
const WETH = ERC20('WETH', <const>{
  aliases: ['weth-default'],
  description: 'Wrapped Ether',
  decimals: 18,
  // location
  network: 'optimism-goerli',
  address: '0x4200000000000000000000000000000000000006',
  block: {
    number: 0,
    timestamp: 0,
  },
});

const USDC = ERC20('USDC', <const>{
  description: 'USD Coin',
  decimals: 6,
  // location
  network: 'optimism-goerli',
  address: '0x7E07E15D2a87A24492740D16f5bdF58c16db0c4E',
  block: {
    number: 1241514,
    timestamp: 1663604707,
  },
});

const erc20s = <const>([
  WETH, COMP, WBTC, USDC, OP,
]);

const CometRewards = UntypedContract('CometRewards', <const>{
  // location
  aliases: ['Compoundv3Rewards'],
  network: 'optimism-goerli',
  address: '0xBE60803049CA4Aea3B75E4238d664aEbcdDd0773',
  block: {
    number: 7612476,
    timestamp: 1680653020,
  },
});


// TODO: Need a mock price feed
// Currently it's just a USDC pricefeed for COMP-USD
const COMP_USD_priceFeedMock = PriceFeed(<const>{
  decimals: 8,
  // location
  aliases: ['COMP-USD'], // ['PriceFeed']['COMP-USD']
  network: 'optimism-goerli',
  address: '0x2636B223652d388721A0ED2861792DA9062D8C73',
  block: {
    number: 347268,
    timestamp: 1660251568,
  },
});

const USDC_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  // location
  aliases: ['USDC-USD'], // ['PriceFeed']['USDC-USD']
  network: 'optimism-goerli',
  address: '0x2636B223652d388721A0ED2861792DA9062D8C73',
  block: {
    number: 347268,
    timestamp: 1660251568,
  },
});

const Comet_01usdc = Comet(<const>{
  // location
  aliases: ['01-usdc', 'cUSDCv3'],
  network: 'optimism-goerli',
  address: '0xb8F2f9C84ceD7bBCcc1Db6FB7bb1F19A9a4adfF4',
  block: {
    number: 7612463,
    timestamp: 1680652994,
  },
  //
  base: {
    asset: USDC,
    priceFeed: USDC_USD_priceFeed,
  },
  rewards: {
    asset: COMP,
    contract: CometRewards,
    priceFeed: COMP_USD_priceFeedMock,
  },
});

const Bulker_01usdc = UntypedContract('Bulker', {
  aliases: ['01-usdc', 'cUSDCv3'],
  network: 'optimism-goerli',
  address: '0x0b8Ca0E02a5E80036AD46036d642fd6B6f8f842B',
  block: {
    number: 7612509,
    timestamp: 1680653086,
  },
});

const market01usdc = <const>([
  CometRewards,
  USDC_USD_priceFeed, COMP_USD_priceFeedMock, Comet_01usdc, Bulker_01usdc
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'optimism-goerli',
  address: '0x7C4d60297f1c460567b84ceCAcD8ad3bA0292667',
  block: {
    number: 7612471,
    timestamp: 1680653010,
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', {
  aliases: ['default'],
  network: 'optimism-goerli',
  address: '0x45a7F0bF7D7bb2875921FD4d55346b1878Cf291F',
  block: {
    number: 7612427,
    timestamp: 1680652922,
  },
});
const LocalTimelock = UntypedContract('Timelock', {
  aliases: ['default'],
  network: 'optimism-goerli',
  address: '0x4C8011724f2ece7B6ce4B13C90Fe5036c9E1Eb2d',
  block: {
    number: 7612435,
    timestamp: 1680652938,
  },
});
const misc = <const>([Configurator, BridgeReceiver, LocalTimelock]);


const contractData = <const>([
  ...erc20s,
  ...market01usdc,
  ...misc,
]);

export const wellKnown = StaticWellKnownContracts(contractData);
