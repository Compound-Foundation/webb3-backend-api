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
  network: 'arbitrum-goerli',
  address: '0x8FB1E3fC51F3b789dED7557E680551d93Ea9d892',
  block: {
    number: 11749,
  },
});

const LINK = ERC20('LINK', <const>{
  description: 'LINK',
  decimals: 18,
  network: 'arbitrum-goerli',
  address: '0xbb7303602bE1B9149B097aAFb094ffce1860E532',
  block: {
    number: 17074744,
  },
});

const WBTC = ERC20('WBTC', <const>{
  description: 'Wrapped BTC',
  decimals: 8,
  network: 'arbitrum-goerli',
  address: '0x22d5e2dE578677791f6c90e0110Ec629be9d5Fb5',
  block: {
    number: 17076280,
  },
});

const WETH = ERC20('WETH', <const>{
  aliases: ['default'],
  description: 'Wrapped Ether',
  decimals: 18,
  network: 'arbitrum-goerli',
  address: '0xe39Ab88f8A4777030A534146A9Ca3B52bd5D43A3',
  block: {
    number: 16,
  },
});

const COMP = ERC20('COMP', <const>{
  aliases: ['default'],
  description: 'Compound Governance Token',
  decimals: 18,
  network: 'arbitrum-goerli',
  address: '0xf03370d2aCf26Dde26389B66498B7c293038F5aF',
  block: {
    number: 481514,
  },
});

const erc20s = <const>([USDC, LINK, COMP, WBTC, WETH]);

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'arbitrum-goerli',
  address: '0x82329247d14851ef744700bbd2dD974a06Ea2a21',
  block: {
    number: 17712828,
  },
});

const CometFactory = UntypedContract('CometFactory', <const>{
  network: 'arbitrum-goerli',
  address: '0x0818165C053D325985d87F4b8646b3062C72C385',
  block: {
    number: 17712841,
  },
});

const Comet_01usdc_Rewards = UntypedContract('cUSDCv3Rewards', <const>{
  displayName: 'cUSDCv3Rewards',
  network: 'arbitrum-goerli',
  address: '0x8DA65F8E3Aa22A498211fc4204C498ae9050DAE4',
  block: {
    number: 17712866,
  },
});

const USDC_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: 'arbitrum-goerli',
  address: '0x1692Bdd32F31b831caAc1b0c9fAF68613682813b',
  block: {
    number: 384584,
  },
});

// It's goerli, use USDC price feed for COMP
const COMP_USD_priceFeed = PriceFeed(<const>{
  aliases: ['COMP-USD'],
  decimals: 8,
  network: 'arbitrum-goerli',
  address: '0x1692Bdd32F31b831caAc1b0c9fAF68613682813b',
  block: {
    number: 384584,
  },
});

const Comet_01usdc = Comet(<const>{
  // The naming overlaps with our cUSDCv3 goerli market, but
  // it's fine to display, since cross-chain will always
  // explicitly mention they're bridged to the new chain.
  displayName: 'cUSDCv3',
  aliases: ['01-usdc', 'cUSDCv3'],
  base: {
    asset: USDC,
    priceFeed: USDC_USD_priceFeed,
  },
  rewards: {
    asset: COMP,
    contract: Comet_01usdc_Rewards,
    priceFeed: COMP_USD_priceFeed,
  },
  network: 'arbitrum-goerli',
  address: '0x1d573274E19174260c5aCE3f2251598959d24456',
  block: {
    number: 17712850,
  },
});

const Bulker_01usdc = UntypedContract('Bulker', {
  aliases: ['01-usdc', 'cUSDCv3'],
  network: 'arbitrum-goerli',
  address: '0x987350Af5a17b6DdafeB95E6e329c178f44841d7',
  block: {
    number: 17712905,
  },
});

const market01usdc = <const>([
  CometAdmin, Comet_01usdc_Rewards, CometFactory, Bulker_01usdc,
  COMP_USD_priceFeed, USDC_USD_priceFeed, Comet_01usdc,
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'arbitrum-goerli',
  address: '0x1Ead344570F0f0a0cD86d95d8adDC7855C8723Fb',
  block: {
    number: 17712858,
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', {
  aliases: ['default'],
  network: 'arbitrum-goerli',
  address: '0xAC9fC1a9532BC92a9f33eD4c6Ce4A7a54930F376',
  block: {
    number: 17712808,
  },
});
const LocalTimelock = UntypedContract('Timelock', {
  aliases: ['default'],
  network: 'arbitrum-goerli',
  address: '0x20b0b48521771FeFeB02f1714D3Db8E776D989ee',
  block: {
    number: 17712817,
  },
});
const misc = <const>([Configurator, BridgeReceiver, LocalTimelock]);


const contractData = [
  ...erc20s,
  ...market01usdc,
  ...misc,
  // everything else...
] as const;

export const wellKnown = StaticWellKnownContracts(contractData);
