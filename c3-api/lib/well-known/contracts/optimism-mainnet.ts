import {
  ERC20,
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

const COMP = ERC20('COMP', <const>{
  aliases: ['default'],
  description: 'Compound Governance Token',
  decimals: 18,
  // location
  network: 'optimism-mainnet',
  address: '0x7e7d4467112689329f7E06571eD0E8CbAd4910eE',
  block: {
    number: 116849392,
    timestamp: 1709297561,
  },
});

const WETH = ERC20('WETH', <const>{
  aliases: ['weth-default'],
  description: 'Wrapped Ether',
  decimals: 18,
  // location
  network: 'optimism-mainnet',
  address: '0x4200000000000000000000000000000000000006',
  block: {
    number: 0,
    timestamp: 1610639500,
  },
});

const erc20s = <const>([
  WETH, COMP
]);

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'optimism-mainnet',
  address: '0x3C30B5a5A04656565686f800481580Ac4E7ed178',
  block: {
    number: 118406267,
    timestamp: 1712411311
  },
});

const CometFactory = UntypedContract('CometFactory', <const>{
  network: 'optimism-mainnet',
  address: '0xFa454dE61b317b6535A0C462267208E8FdB89f45',
  block: {
    number: 118406272,
    timestamp: 1712411321
  },
});

const Comet_Rewards = UntypedContract('CometRewards', <const>{
  network: 'optimism-mainnet',
  address: '0x443EA0340cb75a160F31A440722dec7b5bc3C2E9',
  block: {
    number: 118406283,
    timestamp: 1712411343
  },
});

const Bulker = UntypedContract('Bulker', <const>{
  aliases: ['01-usdc', 'cUSDCv3', '01-usdt', 'cUSDTv3', '01-weth', 'cWETHv3'],
  network: 'optimism-mainnet',
  address: '0xcb3643CC8294B23171272845473dEc49739d4Ba3',
  block: {
    number: 118406301,
    timestamp: 1712411379
  },
});

const markets = <const>([
  CometAdmin, Comet_Rewards, CometFactory, Bulker,
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'optimism-mainnet',
  address: '0x84E93EC6170ED630f5ebD89A1AAE72d4F63f2713',
  block: {
    number: 118406281,
    timestamp: 1712411339
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', <const>{
  aliases: [ 'default' ],
  network: 'optimism-mainnet',
  address: '0xC3a73A70d1577CD5B02da0bA91C0Afc8fA434DAF',
  block: {
    number: 118406258,
    timestamp: 1712411293
  },
});
const LocalTimelock = UntypedContract('Timelock', <const>{
  aliases: [ 'default' ],
  network: 'optimism-mainnet',
  address: '0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07',
  block: {
    number: 118406261,
    timestamp: 1712411299
  },
});
const misc = <const>([Configurator, BridgeReceiver, LocalTimelock]);

const contractData = [
  ...erc20s,
  ...markets,
  ...misc,
] as const;

export const wellKnown = StaticWellKnownContracts(contractData);
