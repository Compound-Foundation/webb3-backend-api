import {
  Comet,
  ERC20,
  PriceFeed,
  PseudoToken,
  StaticWellKnownContracts,
  UntypedContract,
} from './utils.js';

// ETH
const ETH = PseudoToken('ETH', <const>{
  description: 'Sepolia Eth',
  decimals: 18,
  // location
  network: 'ethereum-sepolia',
  address: '0x0000000000000000000000000000000000000000',
  block: {
    number:    0,
    timestamp: 0,
  },
});

// COMP
const COMP = ERC20('COMP', <const>{
  aliases: [ 'default' ],
  description: 'Compound Governance Token',
  decimals: 18,
  // location
  network: 'ethereum-sepolia',
  address: '0xA6c8D1c55951e8AC44a0EaA959Be5Fd21cc07531',
  block: {
    number: 5343429,
    timestamp: 1708639920,
  },
});

const USDC = ERC20('USDC', <const>{
  description: 'USD Coin',
  decimals: 6,
  // location
  network: 'ethereum-sepolia',
  address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
  block: {
    number: 4848135,
    timestamp: 1702060548,
  },
});

const WETH = ERC20('WETH', <const>{
  aliases: [ 'weth-default' ],
  description: 'Wrapped Ether',
  decimals: 18,
  // location
  network: 'ethereum-sepolia',
  address: '0x2D5ee574e710219a521449679A4A7f2B43f046ad',
  block: {
    number: 5343444,
    timestamp: 1708640148,
  },
});

// PriceFeed
const COMP_USD_priceFeedMock = PriceFeed(<const>{
  decimals: 8,
  // location
  aliases: [ 'COMP-USD' ], // ['PriceFeed']['COMP-USD']
  network: 'ethereum-sepolia',
  address: '0x619db7F74C0061E2917D1D57f834D9D24C5529dA',
  block: {
    number: 5342756,
    timestamp: 1708630860,
  },
});

const CometRewards = UntypedContract('CometRewards', <const>{
  aliases: [ 'Compoundv3Rewards' ],
  network: 'ethereum-sepolia',
  address: '0x8bF5b658bdF0388E8b482ED51B14aef58f90abfD',
  block: {
    number: 7593002,
    timestamp: 1708640256,
  },
})

const USDC_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  // location
  aliases: [ 'USDC-USD' ], // ['PriceFeed']['USDC-USD']
  network: 'ethereum-sepolia',
  address: '0xA2F78ab2355fe2f984D808B5CeE7FD0A93D5270E',
  block: {
    number: 2681563,
    timestamp: 1673636136,
  },
});

const Comet_01usdc = Comet(<const>{
    // location
    aliases: [ '01-usdc', 'cUSDCv3' ],
    network: 'ethereum-sepolia',
    address: '0xAec1F48e02Cfb822Be958B68C7957156EB3F0b6e',
    block: {
      number:    5343452,
      timestamp: 1722297600,
    },
    //
    base: {
      asset:     USDC,
      priceFeed: USDC_USD_priceFeed,
    },
    rewards: {
      asset:     COMP,
      contract:  CometRewards,
      priceFeed: COMP_USD_priceFeedMock,
    },
})


const market01usdc = <const>([
   CometRewards, COMP_USD_priceFeedMock, USDC_USD_priceFeed, Comet_01usdc
]);

const WETH_Constant_priceFeed = PriceFeed(<const>{
  decimals: 8,
  // location
  network: 'ethereum-sepolia',
  address: '0x7C4d60297f1c460567b84ceCAcD8ad3bA0292667',
  block: {
    number: 5397319,
    timestamp: 1709334516,
  },
});


const WETH_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: 'ethereum-sepolia',
  address: '0x694AA1769357215DE4FAC081bf1f309aDC325306',
  block: {
    number: 2675467,
    timestamp: 1673559876,
  },
});

const COMP_ETH_priceFeedMock = PriceFeed(<const>{
  decimals: 18,
  // location
  network: 'ethereum-sepolia',
  address: '0x1B39Ee86Ec5979ba5C322b826B3ECb8C79991699',
  block: {
    number: 10640564,
    timestamp: 1597174495, 
  },
});

const Comet_01weth = Comet(<const>{
  // location
  aliases: [ '01-weth', 'cWETHv3' ],
  network: 'ethereum-sepolia',
  address: '0x2943ac1216979aD8dB76D9147F64E61adc126e96',
  block: {
    number:    5397323,
    timestamp: 1709334564,
  },
  //
  base: {
    asset:     WETH,
    priceFeed: WETH_Constant_priceFeed,
    usdPriceFeed: WETH_USD_priceFeed,
  },
  rewards: {
    asset:     COMP,
    contract:  CometRewards,
    priceFeed: COMP_ETH_priceFeedMock,
  },
});

const market01weth = <const>([
  CometRewards,
  WETH_Constant_priceFeed, COMP_USD_priceFeedMock, Comet_01weth
]);

export const wellKnown = StaticWellKnownContracts([
  ETH,
  COMP,
  ...market01usdc,
  ...market01weth,
]);
