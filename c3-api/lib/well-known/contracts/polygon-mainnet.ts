import {
  ERC20,
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

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

const erc20s = [ COMP ] as const;

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
