import { Interface } from '@ethersproject/abi';

import { keccak256 } from '../hash.js';
import { BigNumber } from '../bignumber.js';
import * as Fallible from '../fallible/fallible.js';

import * as Hex from './hex.js';

import type * as Type from '../type-utilities.js';
import type * as Address from './address.js';

// TODO(jordan): support anonymous modifier?
/*
 * EventSignature represents a solidity event declaration string.
 */
type EventSignature = (
  | `event ${string}(${string})`
);

/*
 * EventDescriptor is the runtime type for a parsed event declaration.
 */
type EventDescriptor = {
  name: string;
  parameters: ParameterDescriptor[];
};

/*
 * ParameterDescriptor is the runtime type for a parsed event
 * parameter declaration.
 */
type ParameterDescriptor = {
  name: number | string; // unnamed parameters are named by their index
  type: string;
  indexed: boolean;
  runtimeType?: any;
};

/*
 * ParseSignature<Signature>
 * Parses the names and parameters out of event signatures in Signature.
 */
type ParseSignature<Signature> = (
  EventSignature extends Signature
    ? EventDescriptor
  : Signature extends `event ${infer Name}(${infer Params})`
    ? { name: Name, parameters: ParseParametersString<Params> }
  : never
);

/*
 * parseSignature<Signature>(signature: Signature)
 *
 * Parses the name and parameters out of a solidity event signature;
 * returns a Fallible in case of failure.
 */
function parseSignature
  <Signature extends EventSignature>
  (signature: Signature)
{
  const match = /event\s+(\w+)\s*\(([^()]*)\)/.exec(signature);
  if (match == null) {
    return Fallible.Outcome.Of.Failure({
      message: 'invalid signature',
      signature,
    });
  }
  const [ _source, name, rawParameters ] = match;
  const parameters = parseParametersString<Signature>(rawParameters);
  if (Fallible.isFailure(parameters)) {
    return parameters;
  }
  return { name, parameters } as ParseSignature<Signature>;
}

type ParseSignatureList<SignatureList> = (
    SignatureList extends [] ? []
  : SignatureList extends [ EventSignature, ...(infer Rest) ]
    ? [ ParseSignature<SignatureList[0]>, ...ParseSignatureList<Rest> ]
  : SignatureList extends EventSignature[]
    ? ParseSignature<SignatureList[number]>[]
  : never
);

function parseSignatureList
  <SignatureList extends EventSignature[]>
  (signatures: SignatureList)
{
  const results = signatures.map(parseSignature);
  type Result  = (typeof results)[number];
  type Failure = Extract<Result, Fallible.Outcome.Of.Failure<any>>;
  const failures = results.filter(r => Fallible.isFailure(r)) as Failure[];
  if (failures.length > 0) {
    return Fallible.Outcome.Of.Failure({
      failures,
      message: 'some signature(s) failed to parse',
    });
  }
  return results as ParseSignatureList<SignatureList>;
}

/*
 * isEventDescriptor(target)
 *
 * Type-guard for checking if an object is an EventDescriptor.
 */
function isEventDescriptor(target: unknown): target is EventDescriptor {
  return typeof(target) === 'object'
      && target !== null
      && ('name'       in target) && (typeof(target['name']) === 'string')
      && ('parameters' in target) && (Array.isArray(target['parameters']))
      && (target['parameters'].every(isParameterDescriptor))
  ;
}

/*
 * ParseParametersString<string>
 * Tokenizes the string then wraps ParseTokenizedEventParameters.
 */
type ParseParametersString<ParametersString extends string> = (
  ParseTokenizedParameters<
    Type.String.Tokenize<{ Delimiter: ',' }, ParametersString>
  >
);

// TODO?(jordan): handle unnamed paramters
// NOTE(jordan): parameters must be `Compress`ed (see type-utilities.ts)
/*
 * ParseTokenizedParameters<Params extends any[]>
 *
 * Given parameters split into tokens, one token per parameter -- parse
 * these into prarameter descriptions tracking the name, type, runtime
 * type, and whether the parameter is indexed in logs.
 */
type ParseTokenizedParameters<Params extends any[]> = (
    Params extends [] ? []
  : Params extends [ `${infer TypeName} ${infer Name}`, ...infer Rest ]
    ? [
        {
          name: Name extends `indexed ${infer N}` ? N : Name,
          type: TypeName,
          indexed: Name extends `indexed ${string}` ? true : false,
          runtimeType: ConvertType<TypeName>,
        },
        ...ParseTokenizedParameters<Rest>
      ]
  : never
);

/*
 * parseParametersString<Signature>(parameters: string)
 *
 * Parses the parameters tuple from a solidity event signature; returns a
 * Fallible in case of failure.
 */
function parseParametersString
  <Signature extends EventSignature>
  (parametersString: string)
{
  // if the event has no parameters, return the empty array
  if (parametersString.length === 0) {
    return [];
  }
  // otherwise, tokenize on ',' and then parse
  const rawTokens = parametersString.split(',');
  const results = rawTokens.map((rawSource, parameterIndex) => {
    const source = rawSource.trim();
    const tokens = source.split(/\s+/g).filter(t => t.length > 0);
    // type [indexed] name
    if (!(tokens.length > 0 && tokens.length <= 3)) {
      return Fallible.Outcome.Of.Failure({
        source,
        message: `parameter string needs 1-3 tokens delimited by spaces, got ${tokens.length}`,
      });
    }
    // parse type
    const typeName = tokens[0];
    const matchedType = TypeTable.find(([ matcher, _type ]) => {
      return typeName.match(matcher) != null;
    });
    if (matchedType == null) {
      return Fallible.Outcome.Of.Failure({
        source,
        message: 'parameter type (token at index 0) not recognized',
        parameterType: typeName,
      });
    }
    // check for the indexed modifier at the next token
    const expectIndexed = tokens.length === 3;
    const indexed = expectIndexed && (tokens[1] === 'indexed');
    if (expectIndexed && !indexed) {
      return Fallible.Outcome.Of.Failure({
        source,
        message: `expected 'indexed', got ${tokens[1]}`,
      });
    }
    // compute the index where the parameter name would be, if any
    const nameIndex = Number(indexed) + 1;
    // a parameter is named if and only if the nameIndex is in bounds
    const named = nameIndex < tokens.length;
    // if there is no name, use the numeric parameter index instead
    const name = named ? tokens[nameIndex] : parameterIndex;
    return { name, type: typeName, indexed };
  });
  type Result  = (typeof results)[number];
  type Failure = Extract<Result, Fallible.Outcome.Of.Failure<any>>;
  const failures = results.filter(r => Fallible.isFailure(r)) as Failure[];
  if (failures.length > 0) {
    return Fallible.Outcome.Of.Failure({
      message: 'some parameters failed to parse',
      failures: failures.map(Fallible.unwrap),
    });
  }
  return results as ParseSignature<Signature>['parameters'];
}

/*
 * isParameterDescriptor(target)
 *
 * Type-guard for checking if an object is an ParameterDescriptor.
 */
function isParameterDescriptor(target: unknown): target is ParameterDescriptor {
  return typeof(target) === 'object'
      && target !== null
      && ('name'       in target) && (typeof(target['name'])       === 'string')
      && ('type'       in target) && (typeof(target['type'])       === 'string')
      && ('indexed'    in target) && (typeof(target['indexed'])    === 'boolean')
      && (!!TypeTable.find(([ matcher ]) => (target['type'] as string).match(matcher)))
  ;
}

/*
 * ConvertType<string> converts the string declaration of the event
 * parameter type into the type that will be parsed at runtime.
 *
 * TODO?(jordan): this is not exhaustive, we may wish to extend later.
 * see: https://docs.soliditylang.org/en/latest/abi-spec.html#types
 */
type ConvertType<T extends string> = (
    T extends `${infer Item}[]`                 ? ConvertType<Item>[]
  : T extends `bool`                            ? boolean
  : T extends `string`                          ? string
  : T extends `bytes${number|''}`               ? Hex.String
  : T extends `address${''|` payable`}`         ? Address.Hex
  : T extends `${'u'|''}int${8|16|24|32|40|48}` ? number
  : T extends `${'u'|''}int${number|''}`        ? BigNumber
  : never
);

const TypeTable = <const>([
  [ 'bool',                       'boolean'   ],
  [ 'string',                     'string'    ],
  [ /bytes\n*/,                   'Hex'       ],
  [ /address(?:\s+payable)*/,     'Address'   ],
  [ /u*int(?:8|16|24|32|40|48)/,  'number'    ],
  [ /u*int/,                      'BigNumber' ],
]);

/*
 * Signature_ForEvent<EventDescriptor>
 *
 * constructs the event signature string type for an event descriptor.
 */
type Signature_ForEvent<Event extends EventDescriptor> = (
  `event ${Event['name']}(${Signature_ForParametersList<Event['parameters']>})`
);

/*
 * Signature_ForParametersList<ParameterDescriptor[]>
 *
 * constructs the comma-separated parameters signature string type for a
 * tuple of ParameterDescriptor[].
 */
type Signature_ForParametersList<
  Params,
  Signature extends string = ``,
  Comma     extends string = (Params extends [ any ] ? '' : ', '),
> = (
  // recursive case: if there's a parameter, add it to the accumulator
  Params extends [ ParameterDescriptor, ...infer Rest ]
    ? Signature_ForParametersList<
        Rest,
        `${Signature}${Signature_ForParameter<Params[0]>}${Comma}`
      >
  // base case: empty parameters array, return accumulator
  : Params extends [] ? Signature
  // if Params is not a valid tuple of ParameterDescriptor... never.
  : never
);

/*
 * Signature_ForParameter<ParameterDescriptor>
 *
 * constructs the parameter signature string type for an
 * ParameterDescriptor.
 */
type Signature_ForParameter<Parameter extends ParameterDescriptor> = (
  Type.String.Compress<`
    ${Parameter['type']}
    ${Parameter['indexed'] extends true ? ' indexed' : ''}
    ${Parameter['name']}
  `>
);

/*
 * toSignature<Event extends EventDescriptor>(descriptor: Event)
 *
 * constructs the solidity event signature for an event descriptor, with
 * one space between individual tokens.
 *
 * parseSignature is the inverse of toSignature, but not vice versa:
 *    parseSignature(toSignature(X)) === X [always]
 *    toSignature(parseSignature(Y)) !== Y [except in some cases]
 */
function toSignature
  <Event extends EventDescriptor>
  ({ name, parameters }: Event)
  : Signature_ForEvent<Event>
{
  const parametersSignature = <Signature_ForParametersList<Event['parameters']>>(
    parameters.map(({ name, type, indexed }) => {
      return `${type}${indexed ? ' indexed' : ''} ${name}`;
    })
    .join(', ')
  );
  return `event ${name}(${parametersSignature})`;
}

/*
 * An event topic string has the format:
 *    {name}({canonical type 1},{canonical type 2},...)
 *
 * note that there are no spaces.
 * note that there are no parameter names, only canonical type names.
 * note that, unlike a signature, the string does not start with 'event'.
 *
 * The 0x-prefixed hexadecimal-encoded keccak256 hash of a topic string is
 * the selector to use in topics[0] of a topic filter for eth_getLogs.
 *
 * In other words, given an event descriptor, the selector for a topic
 * filter is:
 *    `0x${keccak256(events.toTopicString(descriptor))}`
 *
 * where keccak256 produces a hexadecimal string with no '0x' prefix, as
 * in lib/hash.ts.
 *
 * see: https://docs.soliditylang.org/en/latest/abi-spec.html#events
 * see: https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_newfilter
 */
function toTopicString(event: EventDescriptor): string {
  const types = event.parameters.map(({ type }) => canonicalize(type));
  return `${event.name}(${types.join(',')})`;
}

/*
 * canonicalize converts solidity shorthand types, or ABI incompatible
 * types, to their "canonical type" for representation in the EVM.
 *
 * NOTE: currently only supports uint and int conversion to [u]int256.
 * TODO?: contract, function, address payable, struct, ... others?
 *
 * see: https://docs.soliditylang.org/en/latest/abi-spec.html#types
 */
function canonicalize(type: string): string {
  if (type === 'uint[]') return 'uint256[]';
  if (type ===  'int[]') return  'int256[]';
  if (type ===   'uint') return 'uint256';
  if (type ===    'int') return  'int256';
  return type;
}

/*
 * Event Log Parsing.
 *
 * Given signatures, or parsed descriptors, parse the corresponding logs.
 */
type Log = {
  data: string, // hex-encoded log arguments
  address: string, // hex of address
  removed: boolean, // whether the event was removed in a chain reorg
  logIndex: string, // hex of index
  blockHash: string, // 32 byte hash (keccak)
  blockNumber: string, // hex of block number
  transactionIndex: string, // hex of index
  transactionHash: string, // 32 byte hash (keccak)
  topics: (
    | [ string ] // hash of signature
    | [ string, string ] // ... and up to three
    | [ string, string, string ] // ... indexed
    | [ string, string, string, string ] // ... event arguments.
  ),
};

/*
 * Filter
 *
 * Event logs can be filtered by up to four indexed arguments. Anonymous
 * events can index four parameters; named events are indexed by the name
 * signature and by up to three parameters.
 *
 * Filters specify values to match for each indexed argument.
 *
 * cf: https://ethereum.org/en/developers/docs/apis/json-rpc/#eth_newfilter
 * cf: https://docs.ethers.org/v5/concepts/events/#events--filters
 */
type Condition = (
  | '*'      // anything
  | string   // exactly this
  | string[] // any of these
);

type Filter = (
  | [ Condition ] // hash of signature (or value of argument if anonymous)
  | [ Condition, Condition ] // ... and up to three more
  | [ Condition, Condition, Condition ] // ... indexed
  | [ Condition, Condition, Condition, Condition ] // ... event arguments
);

type ConditionEVM = (
  | null
  | Hex.String
  | Hex.String[]
);

type FilterEVM = ConditionEVM[];

function encodeFilter(filter: Filter): FilterEVM {
  return filter.map(condition => {
    if (condition === '*') {
      return null;
    }
    if (typeof(condition) === 'string') {
      if (!Hex.is(condition)) {
        throw new Error(`condition value is not a hex string`);
      }
      return Hex.pad32(condition);
    }
    return condition.map(value => {
      if (!Hex.is(value)) {
        throw new Error(`disjoint condition item is not a hex string`);
      }
      return Hex.pad32(value);
    });
  });
}

/*
 * An event Coder is initialized with a list of event signatures or
 * descriptors. It is then able to encode topic filters and decode event
 * logs for any of those events.
 */
class Coder<Descriptors extends EventDescriptor[]> {
  public topics: {
    [Name in Descriptors[number]['name']]: Hex.String;
  };

  private _interface: Interface;
  private constructor(public descriptors: Descriptors) {
    this._interface = new Interface(descriptors.map(toSignature));
    this.topics = Object.fromEntries(descriptors.map(descriptor => {
      const topicHash = keccak256(toTopicString(descriptor));
      return [ descriptor.name, `0x${topicHash}` ];
    })) as (Coder<Descriptors>['topics']);
  }

  static fromDescriptors
    <Descriptors extends EventDescriptor[]>
    (descriptors: Descriptors)
  {
    return new Coder(descriptors);
  }

  static fromSignatures
    <SignatureList extends EventSignature[]>
    (signatures: SignatureList)
    : Coder<ParseSignatureList<SignatureList>>
  {
    return new Coder(Fallible.must(parseSignatureList(signatures)));
  }

  decode(log: Log): ParseLog<Descriptors[number]> {
    const { name, args, topic } = this._interface.parseLog(log);
    return { name, topic, body: args } as any;
  }
}

/*
 * ParseLog<EventDescriptor>
 *
 * Given an event descriptor (or union type thereof), parse out the
 * payload type for an event log corresponding to that event.
 *
 * The basic shape of a parsed log will be: { name, topic, body }
 */
type ParseLog<Event extends EventDescriptor> = (
  Event extends never ? never : {
    name: Event['name'],
    topic: string,
    body: {
      [Name in Event['parameters'][number]['name']]: (
        Parameter_For<Event, Event['name'], Name>['runtimeType']
      );
    }
  }
);

/*
 * Parameter_For<Descriptors, Name>
 *
 * A simple lookup type for extracting the parameters field of the event
 * descriptor in the type Descriptors having the name given by Name.
 */
type Parameter_For<
  Descriptor    extends EventDescriptor,
  EventName     extends EventDescriptor['name']     = any,
  ParameterName extends ParameterDescriptor['name'] = any,
> = (
  Extract<
    /* Get event descriptors with names in EventName,
     *   then get their 'parameters' arrays and select all of them.
     */
    Extract<Descriptor, { name: EventName }>['parameters'][number],
    // Extract from those parameters ones with names in ParameterName.
    { name: ParameterName }
  >
);

export type {
  Log,
  Filter,
  ParseLog,
  ParseSignature,
  EventSignature  as Signature,  // i.e. Event.Signature
  EventDescriptor as Descriptor, // i.e. Event.Descriptor
};

export {
  Coder,
  encodeFilter,
  // formatters
  toSignature,
  toTopicString,
  // parsers
  parseSignature,
  // type-guards
  isEventDescriptor as isDescriptor,
};
