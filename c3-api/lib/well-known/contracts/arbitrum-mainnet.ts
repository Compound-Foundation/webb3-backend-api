import {
  ERC20,
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

const USDCe = ERC20('USDC.e', <const>{
  description: 'Bridged USD Coin',
  decimals: 6,
  network: 'arbitrum-mainnet',
  address: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
  block: {
    number: 2609,
    timestamp: 1623868379,
  },
});

const COMP = ERC20('COMP', <const>{
  aliases: ['default'],
  description: 'Compound Governance Token',
  decimals: 18,
  network: 'arbitrum-mainnet',
  address: '0x354A6dA3fcde098F8389cad84b0182725c6C91dE',
  block: {
    number: 199738,
    timestamp: 1627937552,
  },
});

const erc20s = <const>([
  USDCe, COMP,
]);

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'arbitrum-mainnet',
  address: '0xD10b40fF1D92e2267D099Da3509253D9Da4D715e',
  block: {
    number: 87335147,
    timestamp: 1683235187,
  },
});

const CometFactory = UntypedContract('CometFactory', <const>{
  network: 'arbitrum-mainnet',
  address: '0xe2AA5194E45B043AfdD6E98F467c0B1c13484ae9',
  block: {
    number: 87335169,
    timestamp: 1683235193,
  },
});

const CometRewards = UntypedContract('CometRewards', <const>{
  network: 'arbitrum-mainnet',
  address: '0x88730d254A2f7e6AC8388c3198aFd694bA9f7fae',
  block: {
    number: 87335253,
    timestamp: 1683235215,
  },
});

const Bulker_01usdc = UntypedContract('Bulker', {
  aliases: ['01-usdc', 'cUSDCv3', '01-weth', 'cWETHv3', '01-usdt', 'cUSDTv3'],
  network: 'arbitrum-mainnet',
  address: '0xbdE8F31D2DdDA895264e27DD990faB3DC87b372d',
  block: {
    number: 87335347,
    timestamp: 1683235239,
  },
});

const markets = <const>([
  CometAdmin, CometRewards, CometFactory, Bulker_01usdc,
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'arbitrum-mainnet',
  address: '0xb21b06D71c75973babdE35b49fFDAc3F82Ad3775',
  block: {
    number: 87335242,
    timestamp: 1683235212,
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', {
  aliases: ['default'],
  network: 'arbitrum-mainnet',
  address: '0x42480C37B249e33aABaf4c22B20235656bd38068',
  block: {
    number: 87335111,
    timestamp: 1683235178,
  },
});
const LocalTimelock = UntypedContract('Timelock', {
  aliases: ['default'],
  network: 'arbitrum-mainnet',
  address: '0x3fB4d38ea7EC20D91917c09591490Eeda38Cf88A',
  block: {
    number: 87335128,
    timestamp: 1683235182,
  },
});
const misc = <const>([Configurator, BridgeReceiver, LocalTimelock]);


const contractData = [
  ...erc20s,
  ...markets,
  ...misc,
  // everything else...
] as const;

export const wellKnown = StaticWellKnownContracts(contractData);
