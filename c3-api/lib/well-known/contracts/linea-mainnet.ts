import {
  ERC20,
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

const COMP = ERC20('COMP', <const>{
  description: 'Compound Governance Token',
  decimals: 18,
  network: 'linea-mainnet',
  address: '0x0ECE76334Fb560f2b1a49A60e38Cf726B02203f0',
  block: {
    number: 116736,
    timestamp: 1691070466
  },
});

const erc20s = [ COMP ] as const;

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'linea-mainnet',
  address: '0x4b5DeE60531a72C1264319Ec6A22678a4D0C8118',
  block: {
    number: 15197659,
    timestamp: 1738189720
  },
});

const Comet_Rewards = UntypedContract('CometRewards', <const>{
  network: 'linea-mainnet',
  address: '0x2c7118c4C88B9841FCF839074c26Ae8f035f2921',
  block: {
    number: 15197779,
    timestamp: 1738189994
  },
});

const Bulker = UntypedContract('Bulker', <const>{
  network: 'linea-mainnet',
  address: '0x023ee795361B28cDbB94e302983578486A0A5f1B',
  block: {
    number: 15197845,
    timestamp: 1738190148
  },
});

const market01usdc = <const>([
  CometAdmin, Comet_Rewards, Bulker,
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'linea-mainnet',
  address: '0x970FfD8E335B8fa4cd5c869c7caC3a90671d5Dc3',
  block: {
    number: 15197724,
    timestamp: 1738189869
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', <const>{
  aliases: [ 'default' ],
  network: 'linea-mainnet',
  address: '0x1F71901daf98d70B4BAF40DE080321e5C2676856',
  block: {
    number: 15197553,
    timestamp: 1738189471
  },
});
const LocalTimelock = UntypedContract('Timelock', <const>{
  aliases: [ 'default' ],
  network: 'linea-mainnet',
  address: '0x4A900f81dEdA753bbBab12453b3775D5f26df6F3',
  block: {
    number: 15197555,
    timestamp: 1738189475
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