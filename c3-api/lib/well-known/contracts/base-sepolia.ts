import {
  ERC20,
  PriceFeed,
  StaticWellKnownContracts,
} from './utils.js';

const USDC = ERC20('USDC', <const>{
  description: 'USD Coin',
  decimals: 6,
  network: 'base-sepolia',
  address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  block: {
    number: 31_521_31 ,
    timestamp: 1_702_072_550,
  },
});

const COMP = ERC20('COMP', <const>{
  aliases: ['default'],
  description: 'Compound Governance Token',
  decimals: 18,
  network: 'base-sepolia',
  address: '0x2f535da74048c0874400f0371Fba20DF983A56e2',
  block: {
    number: 7514112 ,
    timestamp: 1710796512,
  },
});

const COMP_USD_priceFeedMock = PriceFeed(<const>{
  aliases: ['COMP-USD'],
  decimals: 8,
  network: 'base-sepolia',
  address: '0x9123612E1791817ed4bFfC4b57CA8aA1E4bCdBaa',
  block: {
    number: 7992015,
    timestamp: 1711752318,
  },
});

const contractData = [USDC, COMP, COMP_USD_priceFeedMock] as const;
export const wellKnown = StaticWellKnownContracts(contractData);
