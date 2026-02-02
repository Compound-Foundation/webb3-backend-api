import type * as Eth  from '../../eth-constants.js';
import type * as Type from '../../type-utilities.js';

import * as KnownNetwork from '../../well-known/networks/network.js';

/*
 * A TypedContract marks a contract with a Symbol type tag property which
 * permits runtime representations of contract data to cheaply check
 * derived types.
 *
 * In effect, a TypedContract is shorthand for "a contract satisfying a
 * well-known named set of interfaces" -- for example, ERC-20.
 *
 * NOTE that an instance of a TypedContract MAY satisfy more interfaces
 * than required by the type shorthand. To safely and correctly determine
 * whether a contract satisfies a given interface, the ABI must be matched
 * against the interface description directly; one MUST NOT assume that a
 * TypedContract instance is fully described only by the assumed type. A
 * contract instance can satisfy ONLY ONE TypedContract at any given time.
 * It is an optimization that should be used carefully and sparingly.
 */
const ContractTypeTag = Symbol('contract type');
type  ContractTypeTag = typeof ContractTypeTag;
interface TypedContract {
  [ContractTypeTag]: string;
}

/*
 *
 */
interface ContractNamed {
  canonicalName: string;
}

interface DescriptionMetadata {
  description?: string | unknown;
  /*
   * Sometimes the canonical name is not the desired name for display. For
   * example, 'Comet' would prefer for the 01-usdc deployment to display
   * as 'cUSDCv3', which is obviously less ambiguous than 'Comet',
   * since we expect 'Comet' to be deployed many times per network.
   */
  displayName?: string | unknown;
}

/*
 *
 */
interface ContractLocation extends DescriptionMetadata {
  network: KnownNetwork.Name;
  address: Eth.Address;
  creation: {
    block: Pick<Eth.Block, 'number'>;
  };
  aliases?: readonly string[];
}

namespace ContractLocation {
  export type WithCreationBlockTimestamp<
    Location extends ContractLocation = ContractLocation,
  > = Type.Merge<(Location & {
    creation: {
      // adds timestamp to the required set of Block properties
      block: Required<Pick<Eth.Block, 'number' | 'timestamp'>>;
    };
  })>;
}

/*
 * hasCreationTimestamp is an example of a type-guard which validates the
 * availability of some additional ContractLocation creation block
 * metadata; namely, the creation block timestamp.
 */
function hasCreationTimestamp<Location extends ContractLocation>
  (location: Location)
  : location is ContractLocation.WithCreationBlockTimestamp<Location>
{
  return 'timestamp' in location.creation.block
      && typeof ((location.creation.block as any).timestamp) === 'number'
  ;
}

/*
 *
 */
interface ContractAbi {
  events:    { [eventName:    string]: Eth.Event.Signature           };
  functions: { [functionName: string]: Eth.ReadableFunctionSignature };
}

/*
 *
 */
interface ContractNamedInterface
  extends ContractNamed, ContractAbi
{}

/*
 *
 */
type StandaloneContract<Subtype = unknown> = (
  & Type.Required<ContractLocation, 'aliases'>
  & { selectedAlias?: string }
  & ContractNamedInterface
  & Subtype
);

type StandaloneContractFrom<
  Name    extends string,
  Options extends CommonOptions & SubtypeOptions,
  Subtype = unknown,
  SubtypeOptions = {},
> = Type.Merge<(
  // named
  & {
    canonicalName: Name,
    displayName: Options['displayName'],
    description: Options['description'],
  }
  // subtype additions
  & { selectedAlias?: Type.OrDefault<Options['aliases'], readonly []>[number] }
  & Omit<Subtype, keyof StandaloneContract | keyof SubtypeOptions>
  & Pick<Options, keyof SubtypeOptions>
  // location
  & {
    aliases: Type.OrDefault<Options['aliases'], readonly []>,
    network: Options['network'],
    address: Options['address'],
    creation: {
      block: Options['block'],
    },
  }
  // abi
  & {
    events:    Type.OrDefault<Options['events'],    {}>,
    functions: Type.OrDefault<Options['functions'], {}>,
  }
)>;

/*
 * ContractMethods contains convenience methods for formatting contracts.
 */
interface ContractMethods {
  key(): string;
};

/*
 * A Contract wraps a StandaloneContract with runtime methods.
 */
type Contract<
  Description
    extends StandaloneContract
          = StandaloneContract
> = (
  & Description
  & ContractMethods
);

/*
 * instantiate constructs a ContractObject for a given StandaloneContract.
 */
function instantiate<Description extends StandaloneContract>
  (description: Description & Partial<ContractMethods>)
  : Contract<Description>
{
  return {
    key() { return this.address },
    ...description,
  };
}

/*
 *
 */
interface CommonOptions
  extends Partial<ContractAbi>
        , Partial<DescriptionMetadata>
        , Omit<ContractLocation, 'creation'>
        , Omit<ContractNamed, 'canonicalName'>
{
  block: {
    number:     Eth.BlockNumber;
    timestamp?: Eth.Timestamp;
  };
}

/*
 *
 */
interface UntypedContract extends ContractNamedInterface {}
function UntypedContract<
    Name    extends string,
    Options extends CommonOptions,
  >
  (
    canonicalName: Name,
    {
      block,
      events,
      aliases,
      functions,
      description,
      displayName,
      ...options
    }: Options,
  )
  : Contract<StandaloneContractFrom<Name, Options>>
{
  return instantiate({
    description,
    displayName,
    canonicalName,
    creation: { block },
    aliases:   (aliases   ?? [] as const) as any, // safe
    events:    (events    ?? [] as const) as any, // safe
    functions: (functions ?? [] as const) as any, // safe
    ...options,
  });
}

/*
 *
 */
interface ERC20 extends TypedContract, ContractNamedInterface {
  [ContractTypeTag]: ERC20.Tag;
  decimals: number;
  symbol: string;
}
function ERC20<
    Name    extends string,
    Options extends CommonOptions & ERC20.Options
  >
  (canonicalName: Name, options: Options)
  : Contract<StandaloneContractFrom<Name, Options, ERC20, ERC20.Options>>
{
  return Object.assign(UntypedContract(canonicalName, options), {
    [ContractTypeTag]: ERC20.tag,
    decimals: options.decimals,
    symbol: canonicalName,
  });
}
namespace ERC20 {
  export const tag = 'ERC-20 token' as const;
  export type  Tag = typeof tag;
  export type Options = {
    decimals: number;
  };
  export function is(candidate: any): candidate is ERC20 {
    return ContractTypeTag in candidate
        && candidate[ContractTypeTag] === ERC20.tag
    ;
  }
}

/*
 *
 */
interface CTokenv2 extends TypedContract, ContractNamedInterface {
  [ContractTypeTag]: CTokenv2.Tag;
  decimals: number;
  underlying: StandaloneContract<ERC20> | TokenLike;
}
function CTokenv2<
    Name    extends string,
    Options extends CommonOptions & CTokenv2.Options
  >
  (canonicalName: Name, options: Options)
  : Contract<StandaloneContractFrom<Name, Options, CTokenv2, CTokenv2.Options>>
{
  return Object.assign(UntypedContract(canonicalName, options), {
    [ContractTypeTag]: CTokenv2.tag,
    decimals:   options.decimals,
    underlying: options.underlying,
  });
}
namespace CTokenv2 {
  export const tag = 'CTokenv2' as const;
  export type  Tag = typeof tag;
  export type Options = {
    decimals:   number;
    underlying: CTokenv2['underlying'];
  };
  export function is(candidate: any): candidate is CTokenv2 {
    return ContractTypeTag in candidate
        && candidate[ContractTypeTag] === CTokenv2.tag
    ;
  }
}

/*
 *
 */
interface Comet extends TypedContract, ContractNamedInterface {
  [ContractTypeTag]: Comet.Tag;
  base: {
    // FIXME: Contract<StandaloneContract<...>> is gnarly
    asset:     Contract<StandaloneContract<ERC20>>;
    priceFeed: Contract<StandaloneContract<PriceFeed>>;
    /**
     * The base asset price feed of comet contracts reports 
     * a price in native token terms for native token markets.
     * This additional price feed allows us to get USD prices on 
     * every market
     */
    usdPriceFeed?: Contract<StandaloneContract<PriceFeed>>;
  };
  rewards: {
    // FIXME: Contract<StandaloneContract<...>> is gnarly
    asset:     Contract<StandaloneContract<ERC20>>;
    contract:  Contract<StandaloneContract>;
    priceFeed: Contract<StandaloneContract<PriceFeed>>;
  };
}
function Comet<
    Options extends Type.Required<CommonOptions, 'aliases'> & Comet.Options
  >
  (options: Options)
  : Contract<StandaloneContractFrom<Comet.Tag, Options, Comet, Comet.Options>>
{
  return Object.assign(UntypedContract(Comet.tag, options), {
    [ContractTypeTag]: Comet.tag,
    base:    options.base,
    rewards: options.rewards,
  });
}
namespace Comet {
  export const tag = 'Comet' as const;
  export type  Tag = typeof tag;
  export type Options = {
    base:    Comet['base'];
    rewards: Comet['rewards'];
  };
  export function is(candidate: any): candidate is Comet {
    return typeof(candidate) === 'object'
        && ContractTypeTag in candidate
        && candidate[ContractTypeTag] === Comet.tag
    ;
  }
}

/*
 *
 */
interface PriceFeed
  extends TypedContract, ContractNamedInterface
{
  [ContractTypeTag]: PriceFeed.Tag;
  decimals: number;
}
function PriceFeed<
    Options extends CommonOptions & PriceFeed.Options
  >
  (options: Options)
  : Contract<StandaloneContractFrom<PriceFeed.Tag, Options, PriceFeed, PriceFeed.Options>>
{
  return Object.assign(UntypedContract(PriceFeed.tag, options), {
    [ContractTypeTag]: PriceFeed.tag,
    decimals: options.decimals,
  });
}
namespace PriceFeed {
  export const tag = 'PriceFeed' as const;
  export type  Tag = typeof tag;
  export type Options = {
    decimals: PriceFeed['decimals'];
  };
  export function is(candidate: any): candidate is PriceFeed {
    return 'decimals' in candidate
        && typeof(candidate['decimals']) === 'number'
      ;
  }
}

/*
 *
 */
interface TokenLike
  extends ContractNamedInterface
{
  decimals: number;
}
namespace TokenLike {
  export function is(candidate: any): candidate is TokenLike {
    return !!candidate && 'decimals' in candidate
        && typeof(candidate['decimals']) === 'number'
      ;
  }
}

/*
 * Hack for ETH.
 */
function PseudoToken<
    Name    extends string,
    Options extends CommonOptions & ERC20.Options,
  >
  (canonicalName: Name, options: Options)
  : Contract<StandaloneContractFrom<Name, Options, TokenLike, ERC20.Options>>
{
  return Object.assign(UntypedContract(canonicalName, options), {
    decimals: options.decimals,
  });
}

export {
  Contract,
  //
  Comet,
  ERC20,
  CTokenv2,
  PriceFeed,
  TokenLike,
  PseudoToken,
  UntypedContract,
  //
  StandaloneContract,
  //
  ContractTypeTag,
  //
  ContractAbi,
  ContractNamed,
  ContractLocation,
  ContractNamedInterface,
  //
  hasCreationTimestamp,
};
