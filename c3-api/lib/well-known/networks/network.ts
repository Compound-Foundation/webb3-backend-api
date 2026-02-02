import * as Fallible from 'fallible';

/*
 * A Network is identified uniquely by its EIP-155 Chain Id, 'chainId'.
 *
 * A Network is uniquely and fully named by a combination of its 'chain,'
 *   the commonplace name of the blockchain which the network deploys, and
 *   its 'network,' the name of this particular deployment of the chain.
 *
 * Either of (a) chain id or (b) canonical name (chain & network) can be
 *   used to refer to a well-known network.
 *
 * Unrepresented by this solution:
 *   - multiple 'main'nets: arbitrum one vs. nova, for instance
 *     - similarly: polygon PoS vs. zkEVM vs. Miden (?)
 *   - "layer" or hierarchy: L1 vs L2 vs L3+ (supernet etc.)
 *     - more exactly: avax subnets / polygon supernets / OP superchain
 *     - for example: Base is part of the OP post-Bedrock superchain
 *     - however, OP rolls up to Eth. So... Eth > OP > Base? Is it a tree?
 *   - technology: optimistic rollup? zk-rollup? PoS? PoW? ...?
 *     - technology can vary over forks; maybe too complex for metadata?
 *     - EVM modifications; e.g. Arbitrum extensions, omissions, etc.
 *
 * Examples:
 *  chainId   chain      network
 *  -------------------------------
 *  1         ethereum   mainnet
 *  5         ethereum   goerli
 *  11155111  ethereum   sepolia
 *  137       polygon    mainnet
 *  80001     polygon    mumbai
 *  10        optimism   mainnet
 *  420       optimism   goerli
 *  8453      base       mainnet
 *  84531     base       goerli
 *  43114     avalanche  c-chain, mainnet
 *  42161     arbitrum   one, mainnet
 *  534352    scroll     mainnet
 *  5000      mantle     mainnet
 *  59144     linea      mainnet
 *  130       unichain   mainnet
 *  2020      ronin      mainnet
 *
 */
const networks = <const>([
  { chainId: 1,        chain: 'ethereum', network: 'mainnet' },
  { chainId: 11155111, chain: 'ethereum', network: 'sepolia' },
  { chainId: 137,      chain: 'polygon',  network: 'mainnet' },
  { chainId: 80001,    chain: 'polygon',  network: 'mumbai'  },
  { chainId: 42161,    chain: 'arbitrum', network: 'mainnet' },
  { chainId: 421613,   chain: 'arbitrum', network: 'goerli'  },
  { chainId: 10,       chain: 'optimism', network: 'mainnet' },
  { chainId: 420,      chain: 'optimism', network: 'goerli'  },
  { chainId: 84531,    chain: 'base',     network: 'goerli'  },
  { chainId: 84532,    chain: 'base',     network: 'sepolia' },
  { chainId: 8453,     chain: 'base',     network: 'mainnet' },
  { chainId: 59140,    chain: 'linea',    network: 'goerli'  },
  { chainId: 534352,   chain: 'scroll',   network: 'mainnet' },
  { chainId: 5000,     chain: 'mantle',   network: 'mainnet' },
  { chainId: 59144,    chain: 'linea',    network: 'mainnet' },
  { chainId: 130,      chain: 'unichain', network: 'mainnet' },
  { chainId: 2020,     chain: 'ronin',    network: 'mainnet' },
]);

/*
 * Network is the union of all well-known networks.
 * Chain   is the union of all chains of well-known networks.
 * Name    is the union of all canonical names of well-known networks.
 */
type Network = (typeof networks)[number];
type Chain   = Network['chain'];
type Name    = {[C in Chain]: `${C}-${Networks_On<C>['network']}`}[Chain];

type Networks_On<C extends Chain> = Extract<Network, { chain: C }>;

/*
 * castName narrows the type of an arbitrary string to network name.
 */
function castName(candidate: string): candidate is Name {
  return !!networks.find(({ chain, network }) => {
    return candidate === `${chain}-${network}`;
  });
}

/*
 * TODO(jordan): consider whether this is robust long-term. Will every
 * chain have one and only one 'production' network? Will it always be
 * correct to call it 'mainnet'? (No, probably not.)
 */
function isNameOfTestnet(name: Name): boolean {
  return !name.endsWith('mainnet');
}

/*
 * canonicalNameOf(network) returns the canonical name for a well-known
 * network given the corresponding network object.
 */
function canonicalNameOf({ chain, network }: Network): Name {
  return `${chain}-${network}` as Name;
}

/*
 * A Network can be looked up by its alias, chainId, or both.
 * If both are specified, a matching network must satisfy both -- a
 *   partial match will result in lookup failure.
 */
type Lookup = (
  | { name: string }
  | { chainId: number }
  | { name: string, chainId: number }
);
function lookup(lookup: Lookup) {
  const result = networks.find(({ chainId, chain, network }) => {
    return (!('name'    in lookup) || lookup.name    === `${chain}-${network}`)
        && (!('chainId' in lookup) || lookup.chainId === chainId)
  });
  if (!result) {
    return Fallible.Outcome.Of.Failure({
      lookup,
      message: `network lookup did not match any known network`,
    });
  }
  return result;
}

/*
 * canonicalizeAlias cheaply / hackily converts legacy aliases for
 * ethereum networks to their canonical full names.
 */
function canonicalizeAlias(alias: string): string {
  if (alias ===  'sepolia') return `ethereum-sepolia`;
  if (alias === 'mainnet') return `ethereum-mainnet`;
  return alias;
}

/**
 * Get the network names of all known networks
 * @param includeTestnets
 * @returns
 */
function getNames({ includeTestnets } = { includeTestnets: false }): Name[] {
  let allNetworks = networks
    .map(canonicalNameOf);

  if (!includeTestnets) {
    allNetworks = allNetworks.filter(name => !isNameOfTestnet(name));
  }

  return allNetworks;
}

/*
 * import * as KnownNetwork from 'well-known/networks/network.js';
 *
 * KnownNetwork.castName('ethereum-notvalid');    // false
 * KnownNetwork.isTestnetName('ethereum-goerli'); // true
 * KnownNetwork.canonicalizeAlias('mainnet');     // 'ethereum-mainnet'
 *
 * KnownNetwork.lookup({ alias: 'ethereum-mainnet' });
 * // -> KnownNetwork.Object | Fallible.Failure<{...}>
 *
 * KnownNetwork.parse(`ethereum-mainnet`);
 * // -> KnownNetwork.Object | Fallible.Failure<{...}>
 *
 * let n: KnownNetwork.Name;  // 'ethereum-mainnet' | ...
 * let c: KnownNetwork.Chain; // 'ethereum' | 'polygon' | ...
 * let l: KnownNetwork.Lookup; // { alias: Name } | { id: number } | ...
 * let o: KnownNetwork.Object; // { id: 1, chain: 'ethereum', ... } | ...
 */

export type {
  Name,
  Chain,
  Lookup,
  Network as Object,
};

export {
  lookup,
  networks,
  castName,
  isNameOfTestnet,
  canonicalNameOf,
  canonicalizeAlias,
  getNames,
};
