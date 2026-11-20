import {
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'ronin-mainnet',
  address: '0xfa64a82a3d13d4c05d5133e53b2ebb8a0fa9c3f6',
  block: {
    number: 43343864,
    timestamp: 1741884169
  },
});

const Comet_Rewards = UntypedContract('CometRewards', <const>{
  network: 'ronin-mainnet',
  address: '0x31CdEe8609Bc15fD33cc525f101B70a81b2B1E59',
  block: {
    number: 43343882,
    timestamp: 1741884223
  },
});

const Bulker = UntypedContract('Bulker', <const>{
  network: 'ronin-mainnet',
  address: '0x840281FaD56DD88afba052B7F18Be2A65796Ecc6',
  block: {
    number: 43343900,
    timestamp: 1741884277
  },
});

const market01weth = <const>([
  CometAdmin, Comet_Rewards, Bulker,
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'ronin-mainnet',
  address: '0x966c72F456FC248D458784EF3E0b6d042be115F2',
  block: {
    number: 43343880,
    timestamp: 1741884217
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', <const>{
  aliases: [ 'default' ],
  network: 'ronin-mainnet',
  address: '0x2c7EfA766338D33B9192dB1fB5D170Bdc03ef3F9',
  block: {
    number: 43343519,
    timestamp: 1741883134
  },
});
const LocalTimelock = UntypedContract('Timelock', <const>{
  aliases: [ 'default' ],
  network: 'ronin-mainnet',
  address: '0xbbb0ebd903fafbb8fff58b922fd0cd85e251ac2c',
  block: {
    number: 43343859,
    timestamp: 1741884154
  },
});
const misc = <const>([Configurator, BridgeReceiver, LocalTimelock ]);

const contractData = [
  ...market01weth,
  ...misc,
  // everything else...
] as const;

export const wellKnown = StaticWellKnownContracts(contractData);