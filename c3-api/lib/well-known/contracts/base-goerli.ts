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
  network: 'base-goerli',
  address: '0x31D3A7711a74b4Ec970F50c3eaf1ee47ba803A95',
  block: {
    number: 1510841,
    timestamp: 1678215298,
  },
});
const cbETH = ERC20('cbETH', <const>{
  description: 'Coinbase Wrapped Ether',
  decimals: 18,
  network: 'base-goerli',
  address: '0x7c6b91D9Be155A6Db01f749217d76fF02A7227F2',
  block: {
    number: 320911,
    timestamp: 1675835438,
  },
});
const WETH = ERC20('WETH', <const>{
  aliases: ['default', 'weth-default'],
  description: 'Wrapped Ether',
  decimals: 18,
  network: 'base-goerli',
  address: '0x4200000000000000000000000000000000000006',
  block: {
    number: 0,
    timestamp: 1675193616,
  },
});
const COMP = ERC20('COMP', <const>{
  aliases: ['default'],
  description: 'Compound Governance Token',
  decimals: 18,
  network: 'base-goerli',
  address: '0xA29b548056c3fD0f68BAd9d4829EC4E66f22f796',
  block: {
    number: 4488761,
    timestamp: 1684171138,
  },
});

const erc20s = <const>([USDC, cbETH, WETH, COMP]);

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'base-goerli',
  address: '0x2a176755195c43B40A89b3A6507524F2A61E4de6',
  block: {
    number: 5225794,
    timestamp: 1685645204,
  },
});

const CometFactory = UntypedContract('CometFactory', <const>{
  network: 'base-goerli',
  address: '0xAC9fC1a9532BC92a9f33eD4c6Ce4A7a54930F376',
  block: {
    number: 5225805,
    timestamp: 1685645226,
  },
});

const CometRewards = UntypedContract('CometRewards', <const>{
  aliases: ['default'],
  displayName: 'Compoundv3Rewards',
  // location
  network: 'base-goerli',
  address: '0x0818165C053D325985d87F4b8646b3062C72C385',
  block: {
    number: 5225832,
    timestamp: 1685645280,
  },
});

const USDC_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: 'base-goerli',
  address: '0xb85765935B4d9Ab6f841c9a00690Da5F34368bc0',
  block: {
    number: 1252330,
    timestamp: 1677698276,
  },
});

// Base Goerli missing COMP_USD price feed, using USDC price feed instead
const COMP_USD_priceFeedMock = PriceFeed(<const>{
  aliases: ['COMP-USD'],
  decimals: 8,
  network: 'base-goerli',
  address: '0xb85765935B4d9Ab6f841c9a00690Da5F34368bc0',
  block: {
    number: 1252330,
    timestamp: 1677698276,
  },
});

const Comet_01usdc = Comet(<const>{
  // The naming overlaps with our cUSDCv3 mainnet market, but
  // it's fine to display, since cross-chain will always
  // explicitly mention they're bridged to the new chain.
  displayName: 'cUSDCv3',
  aliases: ['01-usdc', 'cUSDCv3'],
  base: {
    asset: USDC,
    priceFeed: USDC_USD_priceFeed,
  },
  rewards: {
    asset: COMP,
    contract: CometRewards,
    priceFeed: COMP_USD_priceFeedMock,
  },
  network: 'base-goerli',
  address: '0xe78Fc55c884704F9485EDa042fb91BfE16fD55c1',
  block: {
    number: 5225816,
    timestamp: 1685645248,
  },
});

const Bulker_01usdc = UntypedContract('Bulker', {
  aliases: ['01-usdc', 'cUSDCv3'],
  network: 'base-goerli',
  address: '0x684108D64Ac3BdE77c617bDEbDBC9afaE6562676',
  block: {
    number: 5225876,
    timestamp: 1685645368,
  },
});

const market01usdc = <const>([
  CometAdmin, CometRewards, CometFactory, Bulker_01usdc,
  USDC_USD_priceFeed, Comet_01usdc,
]);

const WETH_Constant_priceFeed = PriceFeed(<const>{
  decimals: 8,
  // location
  network: 'base-goerli',
  address: '0x22738A450dDA849BedDFcA219739a5d72dfB3Ec6',
  block: {
    number: 5394592,
    timestamp: 1685982800,
  },
});

const WETH_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: 'base-goerli',
  address: '0xcD2A119bD1F7DF95d706DE6F2057fDD45A0503E2',
  block: {
    number: 1250810,
    timestamp: 1677695236,
  },
});

const Comet_01weth = Comet(<const>{
  // location
  aliases: ['01-weth', 'cWETHv3'],
  network: 'base-goerli',
  address: '0xED94f3052638620fE226a9661ead6a39C2a265bE',
  block: {
    number: 5394626,
    timestamp: 1685982868,
  },
  //
  base: {
    asset: WETH,
    priceFeed: WETH_Constant_priceFeed,
    usdPriceFeed: WETH_USD_priceFeed,
  },
  rewards: {
    asset: COMP,
    contract: CometRewards,
    priceFeed: COMP_USD_priceFeedMock,
  },
});

const Bulker_01weth = UntypedContract('Bulker', {
  aliases: ['01-weth', 'cWETHv3'],
  network: 'base-goerli',
  address: '0x684108D64Ac3BdE77c617bDEbDBC9afaE6562676',
  block: {
    number: 5225876,
    timestamp: 1685645368,
  },
});

const market01weth = <const>([
  CometRewards,
  WETH_Constant_priceFeed, COMP_USD_priceFeedMock, Comet_01weth, Bulker_01weth
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'base-goerli',
  address: '0xB1C86B6f4BA3c997dAC601671418F6B026aaA5b2',
  block: {
    number: 5225827,
    timestamp: 1685645270,
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', {
  aliases: ['default'],
  network: 'base-goerli',
  address: '0xdf983449591838C8660cAd7cE08C65b030A43bbE',
  block: {
    number: 5225779,
    timestamp: 1685645174,
  },
});
const LocalTimelock = UntypedContract('Timelock', {
  aliases: ['default'],
  network: 'base-goerli',
  address: '0x1eAa9321305492934D1ee01851f4B28F1fC79b0a',
  block: {
    number: 5225784,
    timestamp: 1685645184,
  },
});
const L2CrossDomainMessenger = UntypedContract('L2CrossDomainMessenger', {
  aliases: ['default'],
  network: 'base-goerli',
  address: '0x4200000000000000000000000000000000000007',
  block: {
    number: 0,
    timestamp: 1675193616,
  },
});
const L2StandardBridge = UntypedContract('L2StandardBridge', {
  aliases: ['default'],
  network: 'base-goerli',
  address: '0x4200000000000000000000000000000000000010',
  block: {
    number: 0,
    timestamp: 1675193616,
  },
});
const misc = <const>([Configurator, BridgeReceiver, LocalTimelock, L2CrossDomainMessenger, L2StandardBridge]);


const contractData = [
  ...erc20s,
  ...market01usdc,
  ...market01weth,
  ...misc,
  // everything else...
] as const;

export const wellKnown = StaticWellKnownContracts(contractData);
