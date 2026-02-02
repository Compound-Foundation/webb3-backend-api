import {
  ERC20,
  Comet,
  PriceFeed,
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

const COMP = ERC20('COMP', <const>{
  aliases: ['default'],
  description: 'Compound Governance Token',
  decimals: 18,
  network: 'linea-goerli',
  address: '0xaB3134Fa5EDfB3Dc64Aa790E8Bb6448117d18fe9',
  block: {
    number: 958208,
    timestamp: 1_687_271_334,
  },
});

const COMP_USD_priceFeed= PriceFeed(<const>{
  aliases: [ 'COMP-USD' ],
  decimals: 8,
  address: '0x68169ED3fbea61ee3C1631B5C696CAc10c147232',
  network: 'linea-goerli',
  block: {
    number: 929378,
    timestamp: 1_686_923_330,
  },
});

const USDC = ERC20('USDC', <const>{
  aliases: ['default'],
  description: 'USD Coin',
  decimals: 6,
  // location
  network: 'linea-goerli',
  address: '0xf56dc6695cF1f5c364eDEbC7Dc7077ac9B586068',
  block: {
    number: 562610,
    timestamp: 1_682_511_286,
  },
});

const USDC_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  // location
  network: 'linea-goerli',
  address: '0xcb81fffa91cd5f3436318d25057c1d5df8e23f95',
  block: {
    number: 800711,
    timestamp: 1_685_373_438,
  },
});

const CometRewards = UntypedContract('CometRewards', <const>{
  aliases: ['default'],
  displayName: 'Compoundv3Rewards',
  // location
  network: 'linea-goerli',
  address: '0x44411C605eb7e009cad03f3847cfbbFCF8895130',
  block: {
    number: 928262,
    timestamp: 1_686_909_938,
  },
});

const L2TokenBridge = UntypedContract('L2TokenBridge', {
  aliases: ['default'],
  network: 'linea-goerli',
  address: '0xB191E3d98074f92584E5205B99c3F17fB2068927',
  block: {
    number: -1,
    timestamp: 0,
  },
});

const L2MessageService = UntypedContract('L2MessageService', {
  aliases: ['default'],
  network: 'linea-goerli',
  address: '0xC499a572640B64eA1C8c194c43Bc3E19940719dC',
  block: {
    number: -1,
    timestamp: 0,
  },
});

const BridgeReceiver = UntypedContract('BridgeReceiver', {
  aliases: ['default'],
  network: 'linea-goerli',
  address: '0x06F066A9C0633507EAc640D89442C77748C3a2a8',
  block: {
    number: 928253,
    timestamp: 1_686_909_830,
  },
});

const Bulker_01usdc = UntypedContract('Bulker', <const>{
  address: '0xad6729C101691A63F7d1e4CcbaD04bC8c6818a22',
  network: 'linea-goerli',
  block: {
    number: -1,
    timestamp: 0,
  },
});

const Comet_01usdc = Comet(<const>{
  aliases: [ '01-usdc', 'cUSDCv3' ],
  // location
  network: 'linea-goerli',
  address: '0xa84b24A43ba1890A165f94Ad13d0196E5fD1023a',
  block: {
    number: 928259,
    timestamp: 1_686_909_902,
  },
  //
  base: {
    asset: USDC,
    priceFeed: USDC_USD_priceFeed,
  },
  rewards: {
    asset: COMP,
    contract: CometRewards,
    priceFeed: COMP_USD_priceFeed,
  },
});

export const wellKnown = StaticWellKnownContracts([
  COMP,
  USDC,
  CometRewards,
  Comet_01usdc,
  Bulker_01usdc,
  L2TokenBridge,
  BridgeReceiver,
  L2MessageService,
  COMP_USD_priceFeed,
  USDC_USD_priceFeed,
]);
