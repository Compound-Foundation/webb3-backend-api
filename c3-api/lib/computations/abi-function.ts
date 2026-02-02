import * as Eth      from '../eth-constants.js';
import * as Json     from '../json-types.js';
import * as Debug    from '../debug-log.js';
import * as Fallible from '../fallible/fallible.js';

import * as Key     from '../symbolic/key.js';
import * as Redex   from '../symbolic/redex.js';
import * as Index   from '../symbolic/index.js';
import * as Compute from '../symbolic/computation.js';

import * as KnownNetwork from '../well-known/networks/network.js';

import type { Expand, OrDefault } from '../type-utilities.js';

import * as evm from './evm.js';

// specification

type Base = {
  depends: [ evm.EthCall ];
  expects: {
    apiHost:     string,
    nodeHost:    string,
    nodeKey:     string,
    network:     KnownNetwork.Name,
    contract:    Eth.Contract,
    blockNumber: Eth.BlockNumber,
  };
};

interface SpecBase extends Compute.Spec {
  depends: Compute.Spec | Base['depends'][number];
  expects: Key.Struct & Base['expects'];
}

type Spec<Spec extends {
  name: string,
  depends?: Compute.Spec[],
  expects?: Key.Struct,
  returns?: Json.Representable,
} = any> = (
  unknown extends Spec ? SpecBase : Compute.Spec<{
    name: Spec['name'],
    depends: [ ...OrDefault<Spec['depends'], []>, ...Base['depends'] ],
    expects: OrDefault<Spec['expects'], {}> & Base['expects'],
    returns: OrDefault<Spec['returns'], AbiResult>,
  }>
);

export { Spec };

// implementation

interface Options<
    Spec   extends SpecBase,
    Return extends Compute.Base.Returns<Spec, Spec['depends']> = unknown
  >
  extends Compute.Base.Options<Spec, Return, Spec['expects'], Implementation<Spec, Return>>
{
  /* parser, signature, and parameters enable a shorthand using a generic
   * compute method that (a) gets a coder (b) pulls parameters (c) invokes
   * ethCall (d) parses the result.
   */
  parser: (result: AbiResult, context: Spec['expects']) => Return,
  signature: Eth.ReadableFunctionSignature,
  parameters?: (context: Spec['expects']) => readonly [ ...ParameterIn<Spec>[] ],
  // or, you can write a custom compute and do it yourself
  compute?: (this: Implementation<Spec, Return>, context: Spec['expects'], debug: Debug.Logger) => Return;
}

interface Implementation<
    Spec   extends SpecBase,
    Return extends Compute.Base.Returns<Spec, Spec['depends']> = unknown
  >
  extends Compute.Implementation<Spec, Return>
{
  coder: ReturnType<typeof getCoder>,
  parser: Options<Spec, Return>['parser'],
  parameters: (context: Spec['expects']) => readonly ParameterOut<Spec>[],
}

function Functor<Spec extends SpecBase>({}: {}) {
  const factories = Redex.Factories<Spec['depends']>();
  return {
    ...factories,
    implement<Return extends Compute.Returns<Spec>>(
      {
        parser,
        version,
        signature,
        compute    = makeDefaultCompute<Spec, Return>(factories),
        key        = Key.toKey,
        index      = Index.Nothing,
        parameters = () => [],
      }: Options<Spec, Return>
    ): (Implementation<Spec, Return>) {
      return {
        key,
        index,
        parser,
        version,
        parameters: wrapStrings(parameters),
        coder: getCoder(signature),
        async compute(context, debug) {
          return Fallible.Outcome.OrJust.ensureWrapped(
            await compute.call(this, context, debug)
          );
        },
      };
    },
  };
}

export {
  Options,
  Functor,
  Implementation,
};

// implementation helpers
type ParameterIn<Spec extends SpecBase> = (
  string | number | boolean | ParameterOut<Spec>
);

type ParameterOut<Spec extends SpecBase> = Expand<(
  Redex.Redex<Spec['depends'], string>
)>;

function wrapStrings<Spec extends SpecBase>
  (parameters: Exclude<Options<Spec>['parameters'], undefined>)
  : Implementation<Spec>['parameters']
{
  return context => parameters(context).map(item => (
    !Redex.cast<Spec['depends'], string>(item)
      ? { [Redex.Type]: true, body: [ [], ([]) => item.toString() ] }
      : item
  ));
}

function makeDefaultCompute<
    Spec   extends SpecBase,
    Return extends Compute.Returns<Spec>,
  >
  (factories: Redex.Factories<Spec['depends']>)
  : Required<Options<Spec, Return>>['compute']
{
  return function genericAbiFunctionCompute(context, debug) {
    return <Return>factories.join<readonly ParameterOut<any>[]>([
      this.parameters(context),
      ([ ...callArgs ]) => {
        if (debug.enabled({ scope: 'ethcall' })) {
          const signature = this.coder.signature;
          debug.log(`invoking ${signature}\n\twith args: [${callArgs}]`);
        }
        const { blockNumber, contract, apiHost, nodeHost, nodeKey, network } = context;
        const data = this.coder.encode(callArgs);
        return factories.pipe<Redex.LookupObject<evm.EthCall>>([
          { ethCall: { apiHost, nodeHost, nodeKey, network, contract, blockNumber, data } },
          ({ ethCall: abiResult }) => {
            return this.parser(this.coder.decode(abiResult), context);
          },
        ]);
      }
    ]);
  }
}

// general abi function utilities

import { BytesLike } from '@ethersproject/bytes';
import { Interface, FunctionFragment } from '@ethersproject/abi';


function getCoder(signature: Eth.ReadableFunctionSignature) {
  const iface = new Interface([signature]);
  const frag = iface.fragments[0] as FunctionFragment;
  return {
    signature,
    encode: (args: readonly string[]) => iface.encodeFunctionData(frag, args),
    decode: (data: BytesLike) => iface.decodeFunctionResult(frag, data),
  };
}

type AbiResult = (
  // a readonly array with readonly properties; return type from ethers
  & (readonly any[])
  & ({ readonly [k: string]: any })
);

export {
  AbiResult,
  getCoder,
};
