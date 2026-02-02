import {
  Comet,
  ERC20,
  CTokenv2,
  PriceFeed,
  PseudoToken,
  UntypedContract,
  StaticWellKnownContracts,
} from "./utils.js";

// ETH
const ETH = PseudoToken("ETH", <const>{
  description: "Ether",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x0000000000000000000000000000000000000000",
  block: {
    number: 0,
    timestamp: 0,
  },
});

const eth = <const>[ETH];

// ERC-20s
const ZRX = ERC20("ZRX", <const>{
  description: "0x",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0xe41d2489571d322189246dafa5ebde1f4699f498",
  block: {
    number: 4145415,
    timestamp: 1502476756,
  },
});
const DAI = ERC20("DAI", <const>{
  description: "DAI",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x6b175474e89094c44da98b954eedeac495271d0f",
  block: {
    number: 8928158,
    timestamp: 1573672677,
  },
});
const BAT = ERC20("BAT", <const>{
  description: "Basic Attention Token",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x0d8775f648430679a709e98d2b0cb6250d2887ef",
  block: {
    number: 3788558,
    timestamp: 1496083510,
  },
});
const SAI = ERC20("SAI", <const>{
  description: "Sai (Legacy Dai)",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
  block: {
    number: 4752008,
    timestamp: 1513566638,
  },
});
const REP = ERC20("REP", <const>{
  description: "Augur",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x1985365e9f78359a9b6ad760e32412f4a445e862",
  block: {
    number: 5926311,
    timestamp: 1531037764,
  },
});
const UNI = ERC20("UNI", <const>{
  description: "Uniswap",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984",
  block: {
    number: 10861674,
    timestamp: 1600107086,
  },
});
const YFI = ERC20("YFI", <const>{
  description: "yearn.finance",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x0bc529c00c6401aef6d220be8c6ea1667f6ad93e",
  block: {
    number: 10475744,
    timestamp: 1594972885,
  },
});
const MKR = ERC20("MKR", <const>{
  description: "Maker",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2",
  block: {
    number: 4620855,
    timestamp: 1511634257,
  },
});
const FEI = ERC20("FEI", <const>{
  description: "Fei USD",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x956f47f50a910163d8bf957cf5846d573e7f87ca",
  block: {
    number: 12125705,
    timestamp: 1616909037,
  },
});
const KNC = ERC20("KNC", <const>{
  // location
  description: "Kyber Network Crystal",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0xdd974d5c2e2928dea5f71b9825b8b646686bd200",
  block: {
    number: 4264898,
    timestamp: 1505194399,
  },
});
const COMP = ERC20("COMP", <const>{
  aliases: ["default"],
  description: "Compound Governance Token",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0xc00e94cb662c3520282e6f5717214004a7f26888",
  block: {
    number: 9601359,
    timestamp: 1583280535,
  },
});
const WBTC = ERC20("WBTC", <const>{
  description: "Wrapped BTC",
  decimals: 8,
  // location
  network: "ethereum-mainnet",
  address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
  block: {
    number: 6766284,
    timestamp: 1543095952,
  },
});
const cbBTC = ERC20("cbBTC", <const>{
  description: "Coinbase Wrapped BTC",
  decimals: 8,
  // location
  network: "ethereum-mainnet",
  address: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf",
  block: {
    number: 20570548,
    timestamp: 1724165531,
  },
});
const USDC = ERC20("USDC", <const>{
  description: "USD Coin",
  decimals: 6,
  // location
  network: "ethereum-mainnet",
  address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  block: {
    number: 6082465,
    timestamp: 1533324504,
  },
});
const USDT = ERC20("USDT", <const>{
  description: "USDT",
  decimals: 6,
  // location
  network: "ethereum-mainnet",
  address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
  block: {
    number: 4634748,
    timestamp: 1511829681,
  },
});
const AAVE = ERC20("AAVE", <const>{
  description: "Aave Token",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9",
  block: {
    number: 10926829,
    timestamp: 1600970788,
  },
});
const LINK = ERC20("LINK", <const>{
  description: "ChainLink Token",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x514910771af9ca656af840dff83e8264ecf986ca",
  block: {
    number: 4281611,
    timestamp: 1505597189,
  },
});
const TUSD = ERC20("TUSD", <const>{
  description: "TrueUSD",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x0000000000085d4780b73119b644ae5ecd22b376",
  block: {
    number: 6988184,
    timestamp: 1546294558,
  },
});
const USDP = ERC20("USDP", <const>{
  description: "Pax Dollar",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x8e870d67f660d95d5be530380d0ec0bd388289e1",
  block: {
    number: 6294931,
    timestamp: 1536420623,
  },
});
const WETH = ERC20("WETH", <const>{
  aliases: ["weth-default"],
  description: "Wrapped Ether",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  block: {
    number: 4719568,
    timestamp: 1513077455,
  },
});
const SUSHI = ERC20("SUSHI", <const>{
  description: "SushiToken",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x6b3595068778dd592e39a122f4f5a5cf09c90fe2",
  block: {
    number: 10736094,
    timestamp: 1598444887,
  },
});
const stETH = ERC20("stETH", <const>{
  description: "Lido Staked ETH (stETH)",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
  block: {
    number: 11473216,
    timestamp: 1608242396,
  },
});
const USDe = ERC20("USDe", <const>{
  description: "Ethena USDe",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x4c9edd5852cd905f086c759e8383e09bff1e68b3",
  block: {
    number: 18571358,
    timestamp: 1699979555,
  },
});
const tBTC = ERC20("tBTC", <const>{
  description: "tBTC v2",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x18084fba666a33d37592fa2633fd49a74dd93a88",
  block: {
    number: 13042356,
    timestamp: 1629198727,
  },
});
const USDS = ERC20("USDS", <const>{
  description: "USDS Stablecoin",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0xdC035D45d973E3EC169d2276DDab16f1e407384F",
  block: {
    number: 20663730,
    timestamp: 1725290327,
  },
});
const LBTC = ERC20("LBTC", <const>{
  description: "Lombard Staked BTC",
  decimals: 8,
  // location
  network: "ethereum-mainnet",
  address: "0x8236a87084f8b84306f72007f36f2618a5634494",
  block: {
    number: 19888667,
    timestamp: 1715936519,
  },
});
const pumpBTC = ERC20("pumpBTC", <const>{
  description: "pumpBTC",
  decimals: 8,
  // location
  network: "ethereum-mainnet",
  address: "0xf469fbd2abcd6b9de8e169d128226c0fc90a012e",
  block: {
    number: 20205105,
    timestamp: 1719757775,
  },
});

const erc20s = <const>[
  ZRX,
  DAI,
  BAT,
  SAI,
  REP,
  UNI,
  YFI,
  MKR,
  FEI,
  KNC,
  COMP,
  WBTC,
  cbBTC,
  USDC,
  USDT,
  AAVE,
  LINK,
  TUSD,
  USDP,
  WETH,
  SUSHI,
  stETH,
  USDe,
  tBTC,
  USDS,
  LBTC,
  pumpBTC,
];

// cTokens
const cZRX = CTokenv2("cZRX", <const>{
  description: "Compound 0x",
  decimals: 8,
  underlying: ZRX,
  // location
  network: "ethereum-mainnet",
  address: "0xb3319f5d18bc0d84dd1b4825dcde5d5f7266d407",
  block: {
    number: 7710733,
    timestamp: 1557192054,
  },
});
const cDAI = CTokenv2("cDAI", <const>{
  aliases: ["default"],
  description: "Compound Dai",
  decimals: 8,
  underlying: DAI,
  // location
  network: "ethereum-mainnet",
  address: "0x5d3a536e4d6dbd6114cc1ead35777bab948e3643",
  block: {
    number: 8983575,
    timestamp: 1574471013,
  },
});
const cBAT = CTokenv2("cBAT", <const>{
  description: "Compound Basic Attention Token",
  decimals: 8,
  underlying: BAT,
  // location
  network: "ethereum-mainnet",
  address: "0x6c8c6b02e7b2be14d4fa6022dfd6d75921d90e4e",
  block: {
    number: 7710735,
    timestamp: 1557192085,
  },
});
const cSAI = CTokenv2("cSAI", <const>{
  description: "Compound Sai",
  decimals: 8,
  underlying: SAI,
  // location
  network: "ethereum-mainnet",
  address: "0xf5dce57282a584d2746faf1593d3121fcac444dc",
  block: {
    number: 7710752,
    timestamp: 1557192252,
  },
});
const cREP = CTokenv2("cREP", <const>{
  description: "Compound Augur",
  decimals: 8,
  underlying: REP,
  // location
  network: "ethereum-mainnet",
  address: "0x158079ee67fce2f58472a96584a73c7ab9ac95c1",
  block: {
    number: 7710755,
    timestamp: 1557192288,
  },
});
const cUNI = CTokenv2("cUNI", <const>{
  description: "Compound Uniswap",
  decimals: 8,
  underlying: UNI,
  // location
  network: "ethereum-mainnet",
  address: "0x35a18000230da775cac24873d00ff85bccded550",
  block: {
    number: 10921410,
    timestamp: 1600898747,
  },
});
const cETH = CTokenv2("cETH", <const>{
  description: "Compound Ether",
  decimals: 8,
  underlying: ETH,
  // location
  network: "ethereum-mainnet",
  address: "0x4ddc2d193948926d02f9b1fe9e1daa0718270ed5",
  block: {
    number: 7710758,
    timestamp: 1557192318,
  },
});
const cYFI = CTokenv2("cYFI", <const>{
  description: "Compound yearn.finance",
  decimals: 8,
  underlying: YFI,
  // location
  network: "ethereum-mainnet",
  address: "0x80a2ae356fc9ef4305676f7a3e2ed04e12c33946",
  block: {
    number: 12848198,
    timestamp: 1626578345,
  },
});
const cMKR = CTokenv2("cMKR", <const>{
  description: "Compound Maker",
  decimals: 8,
  underlying: MKR,
  // location
  network: "ethereum-mainnet",
  address: "0x95b4ef2869ebd94beb4eee400a99824bf5dc325b",
  block: {
    number: 12836064,
    timestamp: 1626413417,
  },
});
const cFEI = CTokenv2("cFEI", <const>{
  description: "Compound Fei USD",
  decimals: 8,
  underlying: FEI,
  network: "ethereum-mainnet",
  address: "0x7713dd9ca933848f6819f38b8352d9a15ea73f67",
  block: {
    number: 13227624,
    timestamp: 1631672795,
  },
});
const cCOMP = CTokenv2("cCOMP", <const>{
  description: "Compound Collateral",
  decimals: 8,
  underlying: COMP,
  // location
  network: "ethereum-mainnet",
  address: "0x70e36f6bf80a52b3b46b3af8e106cc0ed743e8e4",
  block: {
    number: 10960099,
    timestamp: 1601419265,
  },
});
const cWBTC = CTokenv2("cWBTC", <const>{
  description: "Compound Wrapped BTC",
  decimals: 8,
  underlying: WBTC,
  // location
  network: "ethereum-mainnet",
  address: "0xc11b1268c1a384e55c48c2391d8d480264a3a7f4",
  block: {
    number: 8163813,
    timestamp: 1563306457,
  },
});
const cUSDC = CTokenv2("cUSDC", <const>{
  aliases: ["default"],
  description: "Compound USD Coin",
  decimals: 8,
  underlying: USDC,
  // location
  network: "ethereum-mainnet",
  address: "0x39aa39c021dfbae8fac545936693ac917d5e7563",
  block: {
    number: 7710760,
    timestamp: 1557192331,
  },
});
const cUSDT = CTokenv2("cUSDT", <const>{
  aliases: ["default"],
  description: "Compound USDT",
  decimals: 8,
  underlying: USDT,
  // location
  network: "ethereum-mainnet",
  address: "0xf650c3d88d12db855b8bf7d11be6c55a4e07dcc9",
  block: {
    number: 9879363,
    timestamp: 1586985186,
  },
});
const cAAVE = CTokenv2("cAAVE", <const>{
  description: "Compound Aave Token",
  decimals: 8,
  underlying: AAVE,
  // location
  network: "ethereum-mainnet",
  address: "0xe65cdb6479bac1e22340e4e755fae7e509ecd06c",
  block: {
    number: 12848198,
    timestamp: 1626578345,
  },
});
const cLINK = CTokenv2("cLINK", <const>{
  description: "Compound ChainLink Token",
  network: "ethereum-mainnet",
  address: "0xface851a4921ce59e912d19329929ce6da6eb0c7",
  block: {
    number: 12286030,
    timestamp: 1619041102,
  },
  decimals: 8,
  underlying: LINK,
});
const cTUSD = CTokenv2("cTUSD", <const>{
  description: "Compound TrueUSD",
  decimals: 8,
  underlying: TUSD,
  // location
  network: "ethereum-mainnet",
  address: "0x12392f67bdf24fae0af363c24ac620a2f67dad86",
  block: {
    number: 11008385,
    timestamp: 1602071129,
  },
});
const cUSDP = CTokenv2("cUSDP", {
  description: "Compound Pax Dollar",
  decimals: 8,
  underlying: USDP,
  // location
  network: "ethereum-mainnet",
  address: "0x041171993284df560249b57358f931d9eb7b925d",
  block: {
    number: 13258119,
    timestamp: 1632080577,
  },
});
const cSUSHI = CTokenv2("cSUSHI", <const>{
  description: "Compound Sushi Token",
  decimals: 8,
  underlying: SUSHI,
  // location
  network: "ethereum-mainnet",
  address: "0x4b0181102a0112a2ef11abee5563bb4a3176c9d7",
  block: {
    number: 12848166,
    timestamp: 1626577979,
  },
});
const cWBTC2 = CTokenv2("cWBTC2", <const>{
  description: "Compound Wrapped BTC",
  decimals: 8,
  underlying: WBTC,
  // location
  network: "ethereum-mainnet",
  address: "0xccf4429db6322d5c611ee964527d42e5d685dd6a",
  block: {
    number: 12038653,
    timestamp: 1615751087,
  },
});

export const ctokenv2s = <const>[
  cZRX,
  cDAI,
  cBAT,
  cSAI,
  cREP,
  cUNI,
  cETH,
  cYFI,
  cMKR,
  cFEI,
  cCOMP,
  cWBTC,
  cUSDC,
  cUSDT,
  cAAVE,
  cLINK,
  cTUSD,
  cUSDP,
  cSUSHI,
  cWBTC2,
];

// delegates
const cDAIDelegate = UntypedContract("cDAIDelegate", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xbb8be4772faa655c255309afc3c5207aa7b896fd",
  block: {
    number: 9122579,
    timestamp: 1576619881,
  },
});
const cYFIDelegate = UntypedContract("cYFIDelegate", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xa035b9e130f2b1aedc733eefb1c67ba4c503491f",
  block: {
    number: 12654137,
    timestamp: 1623962163,
  },
});
const cMKRDelegate = UntypedContract("cMKRDelegate", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xa035b9e130f2b1aedc733eefb1c67ba4c503491f",
  block: {
    number: 12654137,
    timestamp: 1623962163,
  },
});
const cFEIDelegate = UntypedContract("cFEIDelegate", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xa035b9e130f2b1aedc733eefb1c67ba4c503491f",
  block: {
    number: 12654137,
    timestamp: 1623962163,
  },
});
const cCOMPDelegate = UntypedContract("cCOMPDelegate", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x338f7e5d19d9953b76dd81446b142c2d9fe03482",
  block: {
    number: 10921397,
    timestamp: 1600898502,
  },
});
const cUSDTDelegate = UntypedContract("cUSDTDelegate", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x976aa93ca5aaa569109f4267589c619a097f001d",
  block: {
    number: 9879348,
    timestamp: 1586985049,
  },
});
const cAAVEDelegate = UntypedContract("cAAVEDelegate", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xa035b9e130f2b1aedc733eefb1c67ba4c503491f",
  block: {
    number: 12654137,
    timestamp: 1623962163,
  },
});
const cLINKDelegate = UntypedContract("cLINKDelegate", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x24aa720906378bb8364228bddb8cabbc1f6fe1ba",
  block: {
    number: 11960638,
    timestamp: 1614711986,
  },
});
const cTUSDDelegate = UntypedContract("cTUSDDelegate", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xce526fa199d2f772abbc5b40b3284cdab1b8e6de",
  block: {
    number: 11008130,
    timestamp: 1602067556,
  },
});
const cUSDPDelegate = UntypedContract("cUSDPDelegate", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xa035b9e130f2b1aedc733eefb1c67ba4c503491f",
  block: {
    number: 12654137,
    timestamp: 1623962163,
  },
});
const cSUSHIDelegate = UntypedContract("cSUSHIDelegate", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xa035b9e130f2b1aedc733eefb1c67ba4c503491f",
  block: {
    number: 12654137,
    timestamp: 1623962163,
  },
});
const cWBTC2Delegate = UntypedContract("cWBTC2Delegate", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x24aa720906378bb8364228bddb8cabbc1f6fe1ba",
  block: {
    number: 11960638,
    timestamp: 1614711986,
  },
});

const ctokenv2Delegates = <const>[
  cDAIDelegate,
  cYFIDelegate,
  cMKRDelegate,
  cFEIDelegate,
  cCOMPDelegate,
  cUSDTDelegate,
  cAAVEDelegate,
  cLINKDelegate,
  cTUSDDelegate,
  cUSDPDelegate,
  cSUSHIDelegate,
  cWBTC2Delegate,
];

// lido (staked)
const wstETH = ERC20("wstETH", <const>{
  description: "Lido Wrapped Staked ETH",
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
  block: {
    number: 11888477,
    timestamp: 1613752640,
  },
});

const cbETH = ERC20("cbETH", <const>{
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0xbe9895146f7af43049ca1c1ae358b0541ea49704",
  block: {
    number: 14133762,
    timestamp: 1643901537,
  },
});

const wrappedStakedTokens = <const>[wstETH, cbETH];

// KelpDAO (re-staked)
const rsETH = ERC20("rsETH", <const>{
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7",
  block: {
    number: 18758282,
    timestamp: 1702241207,
  },
});

// Etherfi Wrapped eETH (re-staked)
const weETH = ERC20("weETH", <const>{
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee",
  block: {
    number: 17664336,
    timestamp: 1689005159,
  },
});

// Staked ETH
const osETH = ERC20("osETH", <const>{
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0xf1C9acDc66974dFB6dEcB12aA385b9cD01190E38",
  block: {
    number: 18470087,
    timestamp: 1698755027,
  },
});

// Renzo ETH
const ezETH = ERC20("ezETH", <const>{
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0xbf5495Efe5DB9ce00f80364C8B423567e58d2110",
  block: {
    number: 18722779,
    timestamp: 1701811163,
  },
});

const liquideRestakedTokens = <const>[rsETH, weETH, osETH, ezETH];

// comet
const CometAdmin = UntypedContract("CometAdmin", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x1ec63b5883c3481134fd50d5daebc83ecd2e8779",
  block: {
    number: 15331582,
    timestamp: 1660368851,
  },
});
const CometFactory = UntypedContract("CometFactory", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x1c1853bc7c6bff0d276da53972c0b1a066db1ae7",
  block: {
    number: 15331584,
    timestamp: 1660368888,
  },
});
const CometFactory1 = UntypedContract("CometFactory", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xa7F7De6cCad4D83d81676717053883337aC2c1b4",
  block: {
    number: 15819814,
    timestamp: 1666637087,
  },
});
const CometRewards = UntypedContract("CometRewards", <const>{
  aliases: ["default"],
  displayName: "Compoundv3Rewards",
  // location
  network: "ethereum-mainnet",
  address: "0x1b0e765f6224c21223aea2af16c1c46e38885a40",
  block: {
    number: 15331591,
    timestamp: 1660369007,
  },
});

const COMP_USD_priceFeed = PriceFeed(<const>{
  aliases: ["COMP-USD"],
  decimals: 8,
  // location
  network: "ethereum-mainnet",
  address: "0xdbd020CAeF83eFd542f4De03e3cF0C28A4428bd5",
  block: {
    number: 10705616,
    timestamp: 1598040169, // 2020-08-21
  },
});

const COMP_ETH_priceFeed = PriceFeed(<const>{
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x1B39Ee86Ec5979ba5C322b826B3ECb8C79991699",
  block: {
    number: 10640564,
    timestamp: 1597174495, // 2020-08-11
  },
});

const USDC_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  // location
  network: "ethereum-mainnet",
  address: "0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6",
  block: {
    number: 11869355,
    timestamp: 1613455478,
  },
});

const Comet_01usdc = Comet(<const>{
  displayName: "cUSDCv3",
  aliases: ["01-usdc", "cUSDCv3"],
  base: {
    asset: USDC,
    priceFeed: USDC_USD_priceFeed,
  },
  rewards: {
    asset: COMP,
    contract: CometRewards,
    priceFeed: COMP_USD_priceFeed,
  },
  // location
  network: "ethereum-mainnet",
  address: "0xc3d688b66703497daa19211eedff47f25384cdc3",
  block: {
    number: 15331586,
    timestamp: 1660368917,
  },
});

const Bulker_01usdc = UntypedContract("Bulker", {
  aliases: ["01-usdc", "cUSDCv3"],
  network: "ethereum-mainnet",
  address: "0x74a81F84268744a40FEBc48f8b812a1f188D80C3",
  block: {
    number: 15404870,
    timestamp: 1661397539,
  },
});

const market01usdc = <const>[
  CometAdmin,
  CometRewards,
  CometFactory,
  CometFactory1,
  COMP_USD_priceFeed,
  USDC_USD_priceFeed,
  Comet_01usdc,
  Bulker_01usdc,
];

const WETH_Constant_priceFeed = PriceFeed(<const>{
  decimals: 8,
  // location
  network: "ethereum-mainnet",
  address: "0xd72ac1bce9177cfe7aeb5d0516a38c88a64ce0ab",
  block: {
    number: 16400683,
    timestamp: 1673646779,
  },
});

const WETH_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: "ethereum-mainnet",
  address: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419",
  block: {
    number: 10606501,
    timestamp: 1596720671,
  },
});

const Comet_01weth = Comet(<const>{
  // location
  aliases: ["01-weth", "cWETHv3"],
  network: "ethereum-mainnet",
  address: "0xa17581a9e3356d9a858b789d68b4d866e593ae94",
  block: {
    number: 16400710,
    timestamp: 1673647103,
  },
  //
  base: {
    asset: WETH,
    priceFeed: WETH_Constant_priceFeed,
    usdPriceFeed: WETH_USD_priceFeed,
  },
  rewards: {
    asset: COMP,
    contract: CometRewards,
    priceFeed: COMP_ETH_priceFeed,
  },
});

const Bulker_01weth = UntypedContract("Bulker", {
  aliases: ["01-weth", "cWETHv3", "01-usdt", "cUSDTv3", "01-usds", "cUSDSv3"],
  network: "ethereum-mainnet",
  address: "0xa397a8C2086C554B531c02E29f3291c9704B00c7",
  block: {
    number: 16400713,
    timestamp: 1673675939,
  },
});

const market01weth = <const>[
  CometRewards,
  WETH_Constant_priceFeed,
  COMP_USD_priceFeed,
  Comet_01weth,
  Bulker_01weth,
];

const USDT_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: "ethereum-mainnet",
  address: "0x3E7d1eAB13ad0104d2750B8863b489D65364e32D",
  block: {
    number: 11870289,
    timestamp: 1613511055,
  },
});

const Comet_01usdt = Comet(<const>{
  displayName: "cUSDTv3",
  aliases: ["01-usdt", "cUSDTv3"],
  base: {
    asset: USDT,
    priceFeed: USDT_USD_priceFeed,
  },
  rewards: {
    asset: COMP,
    contract: CometRewards,
    priceFeed: COMP_USD_priceFeed,
  },
  network: "ethereum-mainnet",
  address: "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840",
  block: {
    number: 20190637,
    timestamp: 1719583139,
  },
});

const market01usdt = <const>[USDT_USD_priceFeed, Comet_01usdt];

const wstETH_Constant_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: "ethereum-mainnet",
  address: "0x72e9B6F907365d76C6192aD49C0C5ba356b7Fa48",
  block: {
    number: 20683526,
    timestamp: 1725528971,
  },
});

const wstETH_USD_priceFeed = PriceFeed(<const>{
  aliases: ['wstETH-USD'],
  decimals: 8,
  network: "ethereum-mainnet",
  address: "0x164b276057258d81941e97B0a900D4C7B358bCe0",
  block: {
    number: 20613834,
    timestamp: 1724688179,
  },
});

const COMP_wstETH_priceFeed = PriceFeed(<const>{
  decimals: 18,
  // location
  network: "ethereum-mainnet",
  address: "0x39b44c5d7469f50E9500A2de36d9e3DbB6f9278e",
  block: {
    number: 20814076,
    timestamp: 1727104079,
  },
});

const Comet_01wstEth = Comet(<const>{
  // location
  displayName: 'cwstETHv3',
  aliases: ["01-wstETH", "cwstETHv3"],
  network: "ethereum-mainnet",
  address: "0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3",
  block: {
    number: 20683535,
    timestamp: 1725529079,
  },
  //
  base: {
    asset: wstETH,
    priceFeed: wstETH_Constant_priceFeed,
    usdPriceFeed: wstETH_USD_priceFeed,
  },
  rewards: {
    asset: COMP,
    contract: CometRewards,
    priceFeed: COMP_USD_priceFeed,
  },
});

const Bulker_01wstEth = UntypedContract("Bulker", {
  aliases: ["01-wstETH", "cwstETHv3"],
  network: "ethereum-mainnet",
  address: "0x2c776041CCFe903071AF44aa147368a9c8EEA518",
  block: {
    number: 20683537,
    timestamp: 1725529103,
  },
});

const market01wstETH = <const>[
  wstETH_Constant_priceFeed,
  wstETH_USD_priceFeed,
  COMP_wstETH_priceFeed,
  Comet_01wstEth,
  Bulker_01wstEth,
];

const USDS_USD_priceFeed = PriceFeed(<const>{
  decimals: 8,
  network: "ethereum-mainnet",
  address: "0xff30586cd0f29ed462364c7e81375fc0c71219b1",
  block: {
    number: 20792695,
    timestamp: 1726846079,
  },
});

const Comet_01usds = Comet(<const>{
  displayName: "cUSDSv3",
  aliases: ["01-usds", "cUSDSv3"],
  base: {
    asset: USDS,
    priceFeed: USDS_USD_priceFeed,
  },
  rewards: {
    asset: COMP,
    contract: CometRewards,
    priceFeed: COMP_USD_priceFeed,
  },
  network: "ethereum-mainnet",
  address: "0x5D409e56D886231aDAf00c8775665AD0f9897b56",
  block: {
    number: 20987551,
    timestamp: 1729195427,
  },
});

const market01usds = <const>[USDS_USD_priceFeed, Comet_01usds];

const BTC_USD_priceFeed = PriceFeed(<const>{
  aliases: ['WBTC-USD'],
  decimals: 8,
  network: "ethereum-mainnet",
  address: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c",
  block: {
    number: 10606501,
    timestamp: 1596720671,
  },
});

const Comet_01wbtc = Comet(<const>{
  displayName: "cWBTCv3",
  aliases: ["01-wbtc", "cWBTCv3"],
  base: {
    asset: WBTC,
    priceFeed: BTC_USD_priceFeed,
  },
  rewards: {
    asset: COMP,
    contract: CometRewards,
    priceFeed: COMP_USD_priceFeed,
  },
  network: "ethereum-mainnet",
  address: "0xe85dc543813b8c2cfeaac371517b925a166a9293",
  block: {
    number: 21820087,
    timestamp: 1739238359,
  },
});

const market01wbtc = <const>[BTC_USD_priceFeed, Comet_01wbtc];

// governance
const Timelock = UntypedContract("Timelock", <const>{
  aliases: ["default"],
  // location
  network: "ethereum-mainnet",
  address: "0x6d903f6003cca6255d85cca4d3b5e5146dc33925",
  block: {
    number: 8722895,
    timestamp: 1570830762,
  },
});
const GovernorAlpha = UntypedContract("GovernorAlpha", <const>{
  aliases: ["default"],
  // location
  network: "ethereum-mainnet",
  address: "0xc0dA01a04C3f3E0be433606045bB7017A7323E38",
  block: {
    number: 9601459,
    timestamp: 1583281990,
  },
});
const GovernorBravo = UntypedContract("GovernorBravo", <const>{
  aliases: ["default"],
  // location
  network: "ethereum-mainnet",
  address: "0xc0Da02939E1441F497fd74F78cE7Decb17B66529",
  block: {
    number: 12006099,
    timestamp: 1615316879,
  },
});
const CrowdProposalFactory = UntypedContract("CrowdProposalFactory", <const>{
  aliases: ["default"],
  // location
  network: "ethereum-mainnet",
  address: "0x54a06047087927d9b0fb21c1cf0ebd792764ddb8",
  block: {
    number: 12137801,
    timestamp: 1617069393,
  },
});
const CommunityMultiSig = UntypedContract("CommunityMultiSig", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xbbf3f1421D886E9b2c5D716B5192aC998af2012c",
  block: {
    number: 10569629,
    timestamp: 1596228536,
  },
});

const governance = <const>[
  Timelock,
  GovernorAlpha,
  GovernorBravo,
  CrowdProposalFactory,
  CommunityMultiSig,
];

// proposal contracts
const Proposal_20_IRM = UntypedContract("Proposal_20_IRM", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xfb564da37b41b2f6b6edcc3e56fbf523bd9f2012",
  block: {
    number: 10609555,
    timestamp: 1596761174,
  },
});
const Proposal_23_IRM = UntypedContract("Proposal_23_IRM", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xd8ec56013ea119e7181d231e5048f90fbbe753c0",
  block: {
    number: 10810554,
    timestamp: 1599428702,
  },
});
const Proposal_26_IRM = UntypedContract("Proposal_26_IRM", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xd88b94128ff2b8cf2d7886cd1c1e46757418ca2a",
  block: {
    number: 11015612,
    timestamp: 1602169425,
  },
});
const Proposal_27_IRM = UntypedContract("Proposal_27_IRM", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xd956188795ca6f4a74092ddca33e0ea4ca3a1395",
  block: {
    number: 10941481,
    timestamp: 1601167204,
  },
});
const Proposal_122_IRM = UntypedContract("Proposal_122_IRM", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xf9583618169920c544ec89795a346f487cb5a227",
  block: {
    number: 15460993,
    timestamp: 1662146857,
  },
});
const Proposal72PriceFeed = UntypedContract("Proposal72PriceFeed", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x046728da7cb8272284238bd3e47909823d63a58d",
  block: {
    number: 13545034,
    timestamp: 1635958318,
  },
});
const Proposal87PriceFeed = UntypedContract("Proposal87PriceFeed", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x65c816077c29b557bee980ae3cc2dce80204a0c5",
  block: {
    number: 14225844,
    timestamp: 1645130486,
  },
});

const proposal = <const>[
  Proposal_20_IRM,
  Proposal_23_IRM,
  Proposal_26_IRM,
  Proposal_27_IRM,
  Proposal_122_IRM,
  Proposal72PriceFeed,
  Proposal87PriceFeed,
];

// price
const PriceData = UntypedContract("PriceData", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xc629c26dced4277419cde234012f8160a0278a79",
  block: {
    number: 10551018,
    timestamp: 1595979521,
  },
});
const SomeKindaPriceFeed = UntypedContract("PriceFeed", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x9b8eb8b3d6e2e0db36f41455185fef7049a35cae",
  block: {
    number: 10551058,
    timestamp: 1595980079,
  },
});
const PriceFeed2 = UntypedContract("PriceFeed2", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x922018674c12a7f0d394ebeef9b58f186cde13c1",
  block: {
    number: 10921522,
    timestamp: 1600900455,
  },
});
const PriceFeed3 = UntypedContract("PriceFeed3", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x4007b71e01424b2314c020fb0344b03a7c499e1a",
  block: {
    number: 12110639,
    timestamp: 1616708466,
  },
});
const PriceFeed4 = UntypedContract("PriceFeed4", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x841616a5cba946cf415efe8a326a621a794d0f97",
  block: {
    number: 12547650,
    timestamp: 1622538399,
  },
});
const PriceFeed5 = UntypedContract("PriceFeed5", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x6d2299c48a8dd07a872fdd0f8233924872ad1071",
  block: {
    number: 12864414,
    timestamp: 1626797240,
  },
});
const PriceOracle = UntypedContract("PriceOracle", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x02557a5e05defeffd4cae6d83ea3d173b272c904",
  block: {
    number: 6747538,
    timestamp: 1542831178,
  },
});
const PriceOracleProxy = UntypedContract("PriceOracleProxy", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xddc46a3b076aec7ab3fc37420a8edd2959764ec4",
  block: {
    number: 9879366,
    timestamp: 1586985212,
  },
});

const price = <const>[
  // TODO(jordan): wtf are these contracts?
  PriceData,
  SomeKindaPriceFeed,
  PriceFeed2,
  PriceFeed3,
  PriceFeed4,
  PriceFeed5,
  PriceOracle,
  PriceOracleProxy,
];

// comptroller
const Comptroller = UntypedContract("Comptroller", <const>{
  // location
  aliases: ["Unitroller"],
  network: "ethereum-mainnet",
  address: "0x3d9819210a31b4961b30ef54be2aed79b9c9cd3b",
  block: {
    number: 7710671,
    timestamp: 1557191237,
  },
});
const StdComptroller = UntypedContract("StdComptroller", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x62f18c451af964197341d3c86d27e98c41bb8fcc",
  block: {
    number: 7710672,
    timestamp: 1557191252,
  },
});
const StdComptrollerG2 = UntypedContract("StdComptrollerG2", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xf592ef673057a451c49c9433e278c5d59b56132c",
  block: {
    number: 8722898,
    timestamp: 1570830798,
  },
});
const StdComptrollerG3 = UntypedContract("StdComptrollerG3", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x9d0a0443ff4bb04391655b8cd205683d9fa75550",
  block: {
    number: 10228864,
    timestamp: 1591669810,
  },
});
const StdComptrollerG4 = UntypedContract("StdComptrollerG4", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xaf601cbff871d0be62d18f79c31e387c76fa0374",
  block: {
    number: 10348750,
    timestamp: 1593273543,
  },
});
const StdComptroller_2_6 = UntypedContract("StdComptroller_2_6", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x97bd4cc841fc999194174cd1803c543247a014fe",
  block: {
    number: 9652268,
    timestamp: 1583956781,
  },
});

const comptroller = <const>[
  StdComptroller,
  StdComptroller_2_6,
  StdComptrollerG2,
  StdComptrollerG3,
  StdComptrollerG4,
  Comptroller,
];

// irms
const Base0bps_Slope2000bps = UntypedContract("Base0bps_Slope2000bps", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xc64c4cba055efa614ce01f4bad8a9f519c4f8fab",
  block: {
    number: 7710727,
    timestamp: 1557191897,
  },
});
const Base200bps_Slope1000bps = UntypedContract("Base200bps_Slope1000bps", <
  const
>{
  // location
  network: "ethereum-mainnet",
  address: "0x0c3f8df27e1a00b47653fde878d68d35f00714c0",
  block: {
    number: 9321474,
    timestamp: 1579564723,
  },
});
const Base200bps_Slope3000bps = UntypedContract("Base200bps_Slope3000bps", <
  const
>{
  // location
  network: "ethereum-mainnet",
  address: "0xbae04cbf96391086dc643e842b517734e214d698",
  block: {
    number: 7710728,
    timestamp: 1557191925,
  },
});
const Base200bps_Slope222bps_Kink90_Jump40 = UntypedContract(
  "Base200bps_Slope222bps_Kink90_Jump40",
  <const>{
    // location
    network: "ethereum-mainnet",
    address: "0x5562024784cc914069d67d89a28e3201bf7b57e7",
    block: {
      number: 8983555,
      timestamp: 1574470765,
    },
  },
);
const Base200bps_Slope2000bps_Jump20000bps_Kink90 = UntypedContract(
  "Base200bps_Slope2000bps_Jump20000bps_Kink90",
  <const>{
    // location
    network: "ethereum-mainnet",
    address: "0x6bc8fe27d0c7207733656595e73c0d5cf7afae36",
    block: {
      number: 9879332,
      timestamp: 1586984720,
    },
  },
);
const Base500bps_Slope1200bps = UntypedContract("Base500bps_Slope1200bps", <
  const
>{
  // location
  network: "ethereum-mainnet",
  address: "0xa1046abfc2598f48c44fb320d281d3f3c0733c9a",
  block: {
    number: 7710726,
    timestamp: 1557191888,
  },
});
const Base500bps_Slope1500bps = UntypedContract("Base500bps_Slope1500bps", <
  const
>{
  // location
  network: "ethereum-mainnet",
  address: "0xd928c8ead620bb316d2cefe3caf81dc2dec6ff63",
  block: {
    number: 8182678,
    timestamp: 1563561099,
  },
});
const wbtc2_irm = UntypedContract("wbtc2_irm", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xf2e5db36b0682f2cd6bc805c3a4236194e01f4d5",
  block: {
    number: 11998859,
    timestamp: 1615220246,
  },
});

const irms = <const>[
  wbtc2_irm,
  Base0bps_Slope2000bps,
  Base200bps_Slope1000bps,
  Base200bps_Slope3000bps,
  Base200bps_Slope222bps_Kink90_Jump40,
  Base200bps_Slope2000bps_Jump20000bps_Kink90,
  Base500bps_Slope1200bps,
  Base500bps_Slope1500bps,
];

// dynamic supply rate models (?)
const DSR_Updateable = UntypedContract("DSR_Updateable", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xfed941d39905b23d6faf02c8301d40bd4834e27f",
  block: {
    number: 10504587,
    timestamp: 1595358825,
  },
});
const DSR_Kink_9000bps_Jump_12000bps_AssumedRF_500bps = UntypedContract(
  "DSR_Kink_9000bps_Jump_12000bps_AssumedRF_500bps",
  <const>{
    // location
    network: "ethereum-mainnet",
    address: "0xec163986cc9a6593d6addcbff5509430d348030f",
    block: {
      number: 9122577,
      timestamp: 1576619842,
    },
  },
);
const DSR_Kink_9000bps_Jump_12000bps_AssumedRF_20000bps = UntypedContract(
  "DSR_Kink_9000bps_Jump_12000bps_AssumedRF_20000bps",
  <const>{
    // location
    network: "ethereum-mainnet",
    address: "0x000000007675b5e1da008f037a0800b309e0c493",
    block: {
      number: 9955628,
      timestamp: 1588005505,
    },
  },
);

const dsrs = <const>[
  DSR_Updateable,
  DSR_Kink_9000bps_Jump_12000bps_AssumedRF_500bps,
  DSR_Kink_9000bps_Jump_12000bps_AssumedRF_20000bps,
];

// uniswap
const Uniswap = UntypedContract("Uniswap", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
  block: {
    number: 10000835,
    timestamp: 1588610042,
  },
});
const Pair_ETH_ZRX = UntypedContract("Pair_ETH_ZRX", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xc6f348dd3b91a56d117ec0071c1e9b83c0996de4",
  block: {
    number: 10091644,
    timestamp: 1589827255,
  },
});
const Pair_DAI_ETH = UntypedContract("Pair_DAI_ETH", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xa478c2975ab1ea89e8196811f51a7b7ade33eb11",
  block: {
    number: 10042267,
    timestamp: 1589164213,
  },
});
const Pair_BAT_ETH = UntypedContract("Pair_BAT_ETH", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xb6909b960dbbe7392d405429eb2b3649752b4838",
  block: {
    number: 10061933,
    timestamp: 1589427894,
  },
});
const Pair_REP_ETH = UntypedContract("Pair_REP_ETH", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xec2d2240d02a8cf63c3fa0b7d2c5a3169a319496",
  block: {
    number: 10092189,
    timestamp: 1589834690,
  },
});
const Pair_ETH_KNC = UntypedContract("Pair_ETH_KNC", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xf49c43ae0faf37217bdcb00df478cf793edd6687",
  block: {
    number: 10091947,
    timestamp: 1589831556,
  },
});
const Pair_COMP_ETH = UntypedContract("Pair_COMP_ETH", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xcffdded873554f362ac02f8fb1f02e5ada10516f",
  block: {
    number: 10272054,
    timestamp: 1592246823,
  },
});
const Pair_WBTC_ETH = UntypedContract("Pair_WBTC_ETH", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xbb2b8038a1640196fbe3e38816f3e67cba72d940",
  block: {
    number: 10091097,
    timestamp: 1589819777,
  },
});
const Pair_LINK_ETH = UntypedContract("Pair_LINK_ETH", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xa2107fa5b38d9bbd2c461d6edf11b11a50f6b974",
  block: {
    number: 10091428,
    timestamp: 1589824102,
  },
});
const Pair_ETH_USDC = UntypedContract("Pair_ETH_USDC", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc",
  block: {
    number: 10008355,
    timestamp: 1588710145,
  },
});

const uniswap = <const>[
  Uniswap,
  Pair_ETH_ZRX,
  Pair_DAI_ETH,
  Pair_BAT_ETH,
  Pair_REP_ETH,
  Pair_ETH_KNC,
  Pair_COMP_ETH,
  Pair_WBTC_ETH,
  Pair_LINK_ETH,
  Pair_ETH_USDC,
];

// misc
const Reservoir = UntypedContract("Reservoir", <const>{
  aliases: ["default"],
  // location
  network: "ethereum-mainnet",
  address: "0x2775b1c75658be0f640272ccb8c72ac986009e38",
  block: {
    number: 10229427,
    timestamp: 1591677405,
  },
});
const Maximillion = UntypedContract("Maximillion", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0xf859a1ad94bcf445a406b892ef0d3082f4174088",
  block: {
    number: 7710775,
    timestamp: 1557192565,
  },
});
const CompoundLens = UntypedContract("CompoundLens", <const>{
  aliases: ["default"],
  // location
  network: "ethereum-mainnet",
  address: "0xdCbDb7306c6Ff46f77B349188dC18cEd9DF30299",
  block: {
    number: 13468648,
    timestamp: 1634922479,
  },
});
const Configurator = UntypedContract("Configurator", <const>{
  // location
  network: "ethereum-mainnet",
  address: "0x316f9708bb98af7da9c68c1c3b5e79039cd336e3",
  block: {
    number: 15331590,
    timestamp: 1660368984,
  },
});
const ENSResolver = UntypedContract("ENSResolver", {
  // location
  aliases: ["ens-resolver"],
  network: "ethereum-mainnet",
  address: "0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41",
  block: {
    number: 9412610,
    timestamp: 1580772980,
  },
});
const ENSRegistry = UntypedContract("ENSRegistry", {
  // location
  network: "ethereum-mainnet",
  address: "0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e",
  block: {
    number: 9380380,
    timestamp: 1580344632,
  },
});
const FxRoot = UntypedContract("FxRoot", {
  aliases: ["default"],
  network: "ethereum-mainnet",
  address: "0xfe5e5D361b2ad62c541bAb87C45a0B9B018389a2",
  block: {
    number: 11673349,
    timestamp: 1610894890,
  },
});
const PolygonErc20Predicate = UntypedContract("PolygonErc20Predicate", {
  aliases: ["default"],
  network: "ethereum-mainnet",
  address: "0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf",
  block: {
    number: 10735445,
    timestamp: 1598436664,
  },
});
const PolygonBridge = UntypedContract("PolygonBridge", {
  aliases: ["default"],
  network: "ethereum-mainnet",
  address: "0xA0c68C638235ee32657e8f720a23ceC1bFc77C77",
  block: {
    number: 10735437,
    timestamp: 1598436547,
  },
});
const ArbitrumInbox = UntypedContract("ArbitrumInbox", {
  aliases: ["default"],
  network: "ethereum-mainnet",
  address: "0x4Dbd4fc535Ac27206064B68FfCf827b0A60BAB3f",
  block: {
    number: 12525700,
    timestamp: 1622243344,
  },
});
const ArbitrumCustomUSDCGateway = UntypedContract("ArbitrumCustomUSDCGateway", {
  aliases: ["default"],
  network: "ethereum-mainnet",
  address: "0xcEe284F754E854890e311e3280b767F80797180d",
  block: {
    number: 12647126,
    timestamp: 1623867835,
  },
});
const ArbitrumERC20Gateway = UntypedContract("ArbitrumERC20Gateway", {
  aliases: ["default"],
  network: "ethereum-mainnet",
  address: "0xa3A7B6F88361F48403514059F1F16C8E78d60EeC",
  block: {
    number: 12640867,
    timestamp: 1623784100,
  },
});
const ArbitrumGatewayRouter = UntypedContract("ArbitrumGatewayRouter", {
  aliases: ["default"],
  network: "ethereum-mainnet",
  address: "0x72Ce9c846789fdB6fC1f34aC4AD25Dd9ef7031ef",
  block: {
    number: 12640865,
    timestamp: 1623784095,
  },
});

// Defi Saver contracts
const DFSProxyRegistry = UntypedContract("DFSProxyRegistry", <const>{
  aliases: ["default"],
  network: "ethereum-mainnet",
  address: "0x29474FdaC7142f9aB7773B8e38264FA15E3805ed",
  block: {
    number: 11594375,
    timestamp: 1609848314,
  },
});

// Compound Migrator contracts
const CompoundMigratorV2 = UntypedContract("CompoundMigrator", <const>{
  aliases: ["default", "V2"],
  network: "ethereum-mainnet",
  address: "0x3b6f1FE07CDAB8A43f39C3b99Ba8FF26e28DB8b4",
  block: {
    number: 16116420,
    timestamp: 1670216999,
  },
});

const CompoundMigratorV1 = UntypedContract("CompoundMigrator", <const>{
  aliases: ["V1"],
  network: "ethereum-mainnet",
  address: "0x1dD398C2c7fAee61eBB522c434e9f83cf3A9196b",
  block: {
    number: 15749484,
    timestamp: 1665788315,
  },
});

// Base bridge contracts
const BaseL1CrossDomainMessenger = UntypedContract(
  "BaseL1CrossDomainMessenger",
  {
    aliases: ["default"],
    network: "ethereum-mainnet",
    address: "0x866E82a600A1414e583f7F13623F1aC5d58b0Afa",
    block: {
      number: 17482143,
      timestamp: 1687657895,
    },
  },
);

const BaseL1StandardBridge = UntypedContract("BaseL1StandardBridge", {
  aliases: ["default"],
  network: "ethereum-mainnet",
  address: "0x3154Cf16ccdb4C6d922629664174b904d80F2C35",
  block: {
    number: 17482143,
    timestamp: 1687657895,
  },
});

// Circle CCTP contract
const CCTPTokenMessenger = UntypedContract("CCTPTokenMessenger", {
  aliases: ["default"],
  network: "ethereum-mainnet",
  address: "0xbd3fa81b58ba92a82136038b25adec7066af3155",
  block: {
    number: 16730029,
    timestamp: 1677628295,
  },
});

const misc = <const>[
  ...irms,
  ...dsrs,
  ...price,
  ...uniswap,
  ...proposal,
  ...comptroller,
  Reservoir,
  Maximillion,
  CompoundLens,
  Configurator,
  ENSResolver,
  ENSRegistry,
  FxRoot,
  PolygonErc20Predicate,
  PolygonBridge,
  ArbitrumInbox,
  ArbitrumCustomUSDCGateway,
  ArbitrumERC20Gateway,
  ArbitrumGatewayRouter,
  // DefiSaver
  DFSProxyRegistry,
  // Migrators
  CompoundMigratorV1,
  CompoundMigratorV2,
  // Base bridge contracts
  BaseL1CrossDomainMessenger,
  BaseL1StandardBridge,
  // Circle CCTP contract
  CCTPTokenMessenger,
];

const contractData = [
  ...eth,
  ...erc20s,
  ...ctokenv2s,
  ...ctokenv2Delegates,
  ...wrappedStakedTokens,
  ...liquideRestakedTokens,
  ...governance,
  ...market01usdc,
  ...market01weth,
  ...market01usdt,
  ...market01wstETH,
  ...market01usds,
  ...market01wbtc,
  // everything else...
  ...misc,
] as const;

// @ts-ignore
export const wellKnown = StaticWellKnownContracts(contractData);
