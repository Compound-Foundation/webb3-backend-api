import {
  Comet,
  ERC20,
  PriceFeed,
  UntypedContract,
  StaticWellKnownContracts,
} from './utils.js';

const USDe = ERC20('USDe', <const>{
  aliases: [ 'default' ],
  description: 'USDe',
  decimals: 18,
  network: 'mantle-mainnet',
  address: '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34',
  block: {
    number: 59988676,
    timestamp: 1709926643
  },
});
const mETH = ERC20('mETH', <const>{
  description: 'mETH',
  decimals: 18,
  network: 'mantle-mainnet',
  address: '0xcDA86A272531e8640cD7F1a92c01839911B90bb0',
  block: {
    number: 22293073,
    timestamp: 1700538657
  },
});
const WETH = ERC20('WETH', <const>{
  description: 'Wrapped Ether',
  decimals: 18,
  network: 'mantle-mainnet',
  address: '0xdEAddEaDdeadDEadDEADDEAddEADDEAddead1111',
  block: {
    number: 0,
    timestamp: 1688314886
  },
});
const FBTC = ERC20('FBTC', <const>{
  description: 'FunctionBTC',
  decimals: 8,
  network: 'mantle-mainnet',
  address: '0xC96dE26018A54D51c097160568752c4E3BD6C364',
  block: {
    number: 64456136,
    timestamp: 1717042584
  },
});
const COMP = ERC20('COMP', <const>{
  description: 'Compound Governance Token',
  decimals: 18,
  network: 'mantle-mainnet',
  address: '0x52b7D8851d6CcBC6342ba0855Be65f7B82A3F17f',
  block: {
    number: 69950680,
    timestamp: 1728031672
  },
});

const erc20s = <const>([ USDe, mETH, COMP, FBTC, WETH ]);

const CometAdmin = UntypedContract('CometAdmin', <const>{
  network: 'mantle-mainnet',
  address: '0xe268B436E75648aa0639e2088fa803feA517a0c7',
  block: {
    number: 70789037,
    timestamp: 1729708386
  },
});

const CometFactory = UntypedContract('CometFactory', <const>{
  network: 'mantle-mainnet',
  address: '0x5a1d1C89Da75Bc957BBF9ED61b4B0AdEe0553285',
  block: {
    number: 70789044,
    timestamp: 1729708400
  },
});

const Comet_01usde_Rewards = UntypedContract('cUSDev3Rewards', <const>{
  displayName: 'cUSDev3Rewards',
  network: 'mantle-mainnet',
  address: '0xCd83CbBFCE149d141A5171C3D6a0F0fCCeE225Ab',
  block: {
    number: 70789062,
    timestamp: 1729708436
  },
});

const USDe_USD_priceFeed = PriceFeed(<const>{
  aliases: ['cUSDev3-USD'],
  decimals: 18,
  network: 'mantle-mainnet',
  address: '0xc49E06B50FCA57751155DA78803DCa691AfcDB22',
  block: {
    number: 70142928,
    timestamp: 1728416168
  },
});

const COMP_USD_priceFeed = PriceFeed(<const>{
  aliases: ['COMP-USD'],
  decimals: 8,
  network: 'mantle-mainnet',
  address: '0x0cd478875450BcdC75E16FF6084aF3a4782610b9',
  block: {
    number: 73249502,
    timestamp: 1734629647
  },
});

const Comet_01usde = Comet(<const>{
  displayName: 'cUSDev3',
  aliases: [ '01-usde', 'cUSDev3' ],
  base: {
    asset:     USDe,
    priceFeed: USDe_USD_priceFeed,
  },
  rewards: {
    asset:    COMP,
    contract: Comet_01usde_Rewards,
    priceFeed: COMP_USD_priceFeed,
  },
  network: 'mantle-mainnet',
  address: '0x606174f62cd968d8e684c645080fa694c1D7786E',
  block: {
    number: 70789050,
    timestamp: 1729708412
  },
});

const Bulker_01usde = UntypedContract('Bulker', <const>{
  aliases: ['01-usde', 'cUSDev3'],
  network: 'mantle-mainnet',
  address: '0x67DFCa85CcEEFA2C5B1dB4DEe3BEa716A28B9baa',
  block: {
    number: 70789089,
    timestamp: 1729708490
  },
});

const market01usde = <const>([
  CometAdmin, Comet_01usde_Rewards, CometFactory, Bulker_01usde,
  USDe_USD_priceFeed, COMP_USD_priceFeed, Comet_01usde,
]);

const Configurator = UntypedContract('Configurator', <const>{
  network: 'mantle-mainnet',
  address: '0xb77Cd4cD000957283D8BAf53cD782ECf029cF7DB',
  block: {
    number: 70789059,
    timestamp: 1729708430
  },
});
const BridgeReceiver = UntypedContract('BridgeReceiver', <const>{
  aliases: [ 'default' ],
  network: 'mantle-mainnet',
  address: '0xc91EcA15747E73d6dd7f616C49dAFF37b9F1B604',
  block: {
    number: 70789028,
    timestamp: 1729708368
  },
});
const LocalTimelock = UntypedContract('Timelock', <const>{
  aliases: [ 'default' ],
  network: 'mantle-mainnet',
  address: '0x16C7B5C1b10489F4B111af11de2Bd607c9728107',
  block: {
    number: 70789032,
    timestamp: 1729708376
  },
});
const misc = <const>([Configurator, BridgeReceiver, LocalTimelock ]);

const contractData = [
  ...erc20s,
  ...market01usde,
  ...misc,
  // everything else...
] as const;

export const wellKnown = StaticWellKnownContracts(contractData);