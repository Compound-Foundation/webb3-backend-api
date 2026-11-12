import {
  ERC20,
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

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

const erc20s = [ COMP ] as const;

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