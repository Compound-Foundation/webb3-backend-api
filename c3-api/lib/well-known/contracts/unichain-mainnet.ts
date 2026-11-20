import {
  ERC20,
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

const COMP = ERC20('COMP', <const>{
  description: 'Compound Governance Token',
  decimals: 18,
  network: 'unichain-mainnet',
  address: '0xdf78e4f0a8279942ca68046476919a90f2288656',
  block: {
    number: 7962080,
    timestamp: 1738710439
  },
});

const erc20s = [ COMP ] as const;

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'unichain-mainnet',
  address: '0xaeB318360f27748Acb200CE616E389A6C9409a07',
  block: {
    number: 9170472,
    timestamp: 1739890031
  },
});

const Comet_Rewards = UntypedContract('CometRewards', <const>{
  network: 'unichain-mainnet',
  address: '0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486',
  block: {
    number: 9170510,
    timestamp: 1739918869
  },
});

const Bulker = UntypedContract('Bulker', <const>{
  network: 'unichain-mainnet',
  address: '0x58EbB8Db8b4FdF2dCbbB16E04c2F5b952963B514',
  block: {
    number: 9170546,
    timestamp: 1739890105
  },
});

const market01usdc = <const>([
  CometAdmin, Comet_Rewards, Bulker,
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'unichain-mainnet',
  address: '0x8df378453Ff9dEFFa513367CDF9b3B53726303e9',
  block: {
    number: 9170506,
    timestamp: 1739890065
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', <const>{
  aliases: [ 'default' ],
  network: 'unichain-mainnet',
  address: '0x4b5DeE60531a72C1264319Ec6A22678a4D0C8118',
  block: {
    number: 9170459,
    timestamp: 1739890018
  },
});
const LocalTimelock = UntypedContract('Timelock', <const>{
  aliases: [ 'default' ],
  network: 'unichain-mainnet',
  address: '0x2F4eAF29dfeeF4654bD091F7112926E108eF4Ed0',
  block: {
    number: 9170463,
    timestamp: 1739890022
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