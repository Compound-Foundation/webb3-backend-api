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
  network: 'polygon-mumbai',
  address: '0xDB3cB4f2688daAB3BFf59C24cC42D4B6285828e9',
  block: {
    number: 31855504,
  },
});
const DAI = ERC20('DAI', <const>{
  description: 'DAI',
  decimals: 18,
  network: 'polygon-mumbai',
  address: '0x4DAFE12E1293D889221B1980672FE260Ac9dDd28',
  block: {
    number: 31855523,
  },
});
const WBTC = ERC20('WBTC', <const>{
  description: 'Wrapped BTC',
  decimals: 8,
  network: 'polygon-mumbai',
  address: '0x4B5A0F4E00bC0d6F16A593Cae27338972614E713',
  block: {
    number: 31855514,
  },
});
const WETH = ERC20('WETH', <const>{
  aliases: [ 'default' ],
  description: 'Wrapped Ether',
  decimals: 18,
  network: 'polygon-mumbai',
  address: '0xE1e67212B1A4BF629Bdf828e08A3745307537ccE',
  block: {
    number: 31855518,
  },
});
const WMATIC = ERC20('WMATIC', <const>{
  aliases: [ 'default' ],
  description: 'Wrapped Matic',
  decimals: 18,
  network: 'polygon-mumbai',
  address: '0xfec23a9E1DBA805ADCF55E0338Bf5E03488FC7Fb',
  block: {
    number: 31855521,
  },
});

// TODO(kevin): Not actually the bridged COMP token
// but temporarily adding here to avoid type errors.
const COMP = ERC20('COMP', <const>{
  aliases: [ 'default' ],
  description: 'Compound Governance Token',
  decimals: 18,
  network: 'polygon-mumbai',
  address: '0xfec23a9E1DBA805ADCF55E0338Bf5E03488FC7Fb',
  block: {
    number: 31855521,
  },
});

const erc20s = <const>([USDC, COMP, DAI, WBTC, WETH, WMATIC]);

// comet
const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'polygon-mumbai',
  address: '0xfE14E3BdCADDe7ccD3c8EeE3CcC11e3FC8184E47',
  block: {
    number: 31855525,
  },
});
const CometFactory = UntypedContract('CometFactory', <const>{
  network: 'polygon-mumbai',
  address: '0x9F7Ac7A36902414Dd4D280E79C5B10162882F0Ba',
  block: {
    number: 31855531,
  },
});
const Comet_01usdc_Rewards = UntypedContract('cUSDCv3Rewards', <const>{
  displayName: 'cUSDCv3Rewards',
  network: 'polygon-mumbai',
  address: '0x0785f2AC0dCBEDEE4b8D62c25A34098E9A0dF4bB',
  block: {
    number: 31855549,
  },
});

const USDC_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: 'polygon-mumbai',
  address: '0x572dDec9087154dC5dfBB1546Bb62713147e0Ab0',
  block: {
    number: 3782912,
  },
});

const COMP_USD_priceFeed = PriceFeed(<const>{
  aliases: [ 'COMP-USD' ],
  decimals: 8,
  network: 'polygon-mumbai',
  address: '0x572dDec9087154dC5dfBB1546Bb62713147e0Ab0',
  block: {
    number: 3782912,
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
  // TODO: This should be the bridged COMP contract,
  // but we don't know it yet since rewards is not tested/set up on mumbai.
  rewards: {
    asset:    USDC,
    contract: Comet_01usdc_Rewards,
    priceFeed: USDC_USD_priceFeed,
  },
  network: 'polygon-mumbai',
  address: '0xF09F0369aB0a875254fB565E52226c88f10Bc839',
  block: {
    number: 31855537,
    timestamp: 1675883303,
  },
});

const market01usdc = <const>([
  CometAdmin, Comet_01usdc_Rewards, CometFactory,
  USDC_USD_priceFeed, COMP_USD_priceFeed, Comet_01usdc,
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'polygon-mumbai',
  address: '0x64550801B8bf3BF4D8792d46D8903F82e2EC95A9',
  block: {
    number: 31855546,
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', {
  aliases: [ 'default' ],
  network: 'polygon-mumbai',
  address: '0xe195d2cBf7f20E40Cf701a9fA3F01fE89bA5a1da',
  block: {
    number: 31855485,
  },
});
const LocalTimelock = UntypedContract('Timelock', {
  aliases: [ 'default' ],
  network: 'polygon-mumbai',
  address: '0x90b1f90Ed6477d5Ee1Ff14Bef670266DaE9eEb92',
  block: {
    number: 31855488,
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
