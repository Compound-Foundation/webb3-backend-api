import {
  ERC20,
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

const COMP = ERC20('COMP', <const>{
  aliases: ['default'],
  description: 'Compound Governance Token',
  decimals: 18,
  network: 'base-mainnet',
  address: '0x9e1028F5F1D5eDE59748FFceE5532509976840E0',
  block: {
    number: 1716352,
    timestamp: 1690222051,
  },
});

const WETH = ERC20('WETH', <const>{
  aliases: ['default', 'weth-default'],
  description: 'Wrapped Ether',
  decimals: 18,
  network: 'base-mainnet',
  address: '0x4200000000000000000000000000000000000006',
  block: {
    number: 0,
    timestamp: 1_686_789_347,
  },
});

const erc20s = [WETH, COMP] as const;

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'base-mainnet',
  address: '0xbdE8F31D2DdDA895264e27DD990faB3DC87b372d',
  block: {
    number: 2197578,
    timestamp: 1691184503,
  },
});

const CometFactory = UntypedContract('CometFactory', <const>{
  network: 'base-mainnet',
  address: '0x27C348936400791b7350d80Fb81Bc61Ad68dF4AE',
  block: {
    number: 2197583,
    timestamp: 1691184513,
  },
});

const CometRewards = UntypedContract('CometRewards', <const>{
  network: 'base-mainnet',
  address: '0x123964802e6ABabBE1Bc9547D72Ef1B69B00A6b1',
  block: {
    number: 2197596,
    timestamp: 1691184539,
  },
});

const Bulker = UntypedContract('Bulker', {
  aliases: [ '01-usdbc', 'cUSDbCv3', '01-weth', 'cWETHv3', '01-usds', 'cUSDSv3' ],
  network: 'base-mainnet',
  address: '0x78D0677032A35c63D142a48A2037048871212a8C',
  block: {
    number: 2197618,
    timestamp: 1691184583,
  },
});

const markets = <const>([
  Bulker,
  CometAdmin, CometRewards, CometFactory,
]);

const L2CrossDomainMessenger = UntypedContract('L2CrossDomainMessenger', {
  aliases: ['default'],
  network: 'base-mainnet',
  address: '0x4200000000000000000000000000000000000007',
  block: {
    number: 0,
    timestamp: 1_686_789_347,
  },
});

const L2StandardBridge = UntypedContract('L2StandardBridge', {
  aliases: ['default'],
  network: 'base-mainnet',
  address: '0x4200000000000000000000000000000000000010',
  block: {
    number: 0,
    timestamp: 1_686_789_347,
  },
});

const BridgeReceiver = UntypedContract('BridgeReceiver', {
  aliases: ['default'],
  network: 'base-mainnet',
  address: '0x18281dfC4d00905DA1aaA6731414EABa843c468A',
  block: {
    number: 2197570,
    timestamp: 1691184487,
  },
});

const Configurator = UntypedContract('Configurator', <const>{
  network: 'base-mainnet',
  address: '0x45939657d1CA34A8FA39A924B71D28Fe8431e581',
  block: {
    number: 2197594,
    timestamp: 1691184535,
  },
});

const LocalTimelock = UntypedContract('Timelock', {
  aliases: ['default'],
  network: 'base-mainnet',
  address: '0xCC3E7c85Bb0EE4f09380e041fee95a0caeDD4a02',
  block: {
    number: 2197572,
    timestamp: 1691184491,
  },
});

const contractData = [
  ...erc20s,
  ...markets,
  L2StandardBridge,
  L2CrossDomainMessenger,
  BridgeReceiver,
  LocalTimelock,
  Configurator,
] as const;

export const wellKnown = StaticWellKnownContracts(contractData);
