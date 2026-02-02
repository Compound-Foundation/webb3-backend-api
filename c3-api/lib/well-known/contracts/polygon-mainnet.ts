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
  network: 'polygon-mainnet',
  address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  block: {
    number: 5013591,
  },
});
const WBTC = ERC20('WBTC', <const>{
  description: 'Wrapped BTC',
  decimals: 8,
  network: 'polygon-mainnet',
  address: '0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6',
  block: {
    number: 4196820,
  },
});
const WETH = ERC20('WETH', <const>{
  aliases: [ 'default' ],
  description: 'Wrapped Ether',
  decimals: 18,
  network: 'polygon-mainnet',
  address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
  block: {
    number: 3678215,
  },
});
const COMP = ERC20('COMP', <const>{
  aliases: [ 'default' ],
  description: 'Compound Governance Token',
  decimals: 18,
  network: 'polygon-mainnet',
  address: '0x8505b9d2254A7Ae468c0E9dd10Ccea3A837aef5c',
  block: {
    number: 4196299,
  },
});
const WMATIC = ERC20('WMATIC', <const>{
  aliases: [ 'default' ],
  description: 'Wrapped Matic',
  decimals: 18,
  network: 'polygon-mainnet',
  address: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
  block: {
    number: 4931456,
  },
});

const MATICX = ERC20('MATICX', <const>{
  aliases: [ 'default' ],
  description: 'Stader MaticX',
  decimals: 18,
  network: 'polygon-mainnet',
  address: '0xfa68FB4628DFF1028CFEc22b4162FCcd0d45efb6',
  block: {
    number: 27403468 ,
  },
});

const USDT = ERC20('USDT', <const>{
  description: 'Tether',
  decimals: 6,
  network: 'polygon-mainnet',
  address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  block: {
    number: 4196335,
    timestamp: 1599512847,
  },
});

const STMATIC = ERC20('STMATIC', <const>{
  aliases: [ 'default' ],
  description: 'Stader Matic',
  decimals: 18,
  network: 'polygon-mainnet',
  address: '0x3A58a54C066FdC0f2D55FC9C89F0415C92eBf3C4',
  block: {
    number: 25330572 ,
  },
});

const erc20s = <const>([ USDC, COMP, WBTC, WETH, WMATIC, MATICX, USDT, STMATIC ]);

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'polygon-mainnet',
  address: '0xd712ACe4ca490D4F3E92992Ecf3DE12251b975F9',
  block: {
    number: 39412283,
  },
});

const CometFactory = UntypedContract('CometFactory', <const>{
  network: 'polygon-mainnet',
  address: '0x2F9E3953b2Ef89fA265f2a32ed9F80D00229125B',
  block: {
    number: 39412355,
  },
});

const Comet_Rewards = UntypedContract('cUSDCv3Rewards', <const>{
  displayName: 'cUSDCv3Rewards',
  network: 'polygon-mainnet',
  address: '0x45939657d1CA34A8FA39A924B71D28Fe8431e581',
  block: {
    number: 39412423,
  },
});

const USDC_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: 'polygon-mainnet',
  address: '0xfE4A8cc5b5B2366C1B58Bea3858e81843581b2F7',
  block: {
    number: 6275360,
  },
});

const COMP_USD_priceFeed = PriceFeed(<const>{
  aliases: ['COMP-USD'],
  decimals: 8,
  network: 'polygon-mainnet',
  address: '0x2A8758b7257102461BC958279054e372C2b1bDE6',
  block: {
    number: 16646407,
  },
});

const USDT_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: 'polygon-mainnet',
  address: '0x0A6513e40db6EB1b165753AD52E80663aeA50545',
  block: {
    number: 6275356,
    timestamp: 1603802811
  },
});

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
    contract: Comet_Rewards,
    priceFeed: COMP_USD_priceFeed,
  },
  network: 'polygon-mainnet',
  address: '0xF25212E676D1F7F89Cd72fFEe66158f541246445',
  block: {
    number: 39412367,
  },
});

const Comet_01usdt = Comet(<const>{
  displayName: 'cUSDTv3',
  aliases: [ '01-usdt', 'cUSDTv3' ],
  base: {
    asset:     USDT,
    priceFeed: USDT_USD_priceFeed,
  },
  rewards: {
    asset:    COMP,
    contract: Comet_Rewards,
    priceFeed: COMP_USD_priceFeed,
  },
  network: 'polygon-mainnet',
  address: '0xaeB318360f27748Acb200CE616E389A6C9409a07',
  block: {
    number: 58479907,
    timestamp: 1719081789
  },
});

const Bulker = UntypedContract('Bulker', {
  aliases: ['01-usdc', 'cUSDCv3', '01-usdt', 'cUSDTv3'],
  network: 'polygon-mainnet',
  address: '0x59e242D352ae13166B4987aE5c990C232f7f7CD6',
  block: {
    number: 39413698,
  },
});

const markets = <const>([
  CometAdmin, Comet_Rewards, CometFactory, Bulker,
  COMP_USD_priceFeed, USDC_USD_priceFeed, USDT_USD_priceFeed,
  Comet_01usdc, Comet_01usdt
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'polygon-mainnet',
  address: '0x83E0F742cAcBE66349E3701B171eE2487a26e738',
  block: {
    number: 39412378,
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', {
  aliases: [ 'default' ],
  network: 'polygon-mainnet',
  address: '0x18281dfC4d00905DA1aaA6731414EABa843c468A',
  block: {
    number: 39412241,
  },
});
const LocalTimelock = UntypedContract('Timelock', {
  aliases: [ 'default' ],
  network: 'polygon-mainnet',
  address: '0xCC3E7c85Bb0EE4f09380e041fee95a0caeDD4a02',
  block: {
    number: 39412247,
  },
});
const misc = <const>([Configurator, BridgeReceiver, LocalTimelock ]);


const contractData = [
  ...erc20s,
  ...markets,
  ...misc,
  // everything else...
] as const;

export const wellKnown = StaticWellKnownContracts(contractData);
