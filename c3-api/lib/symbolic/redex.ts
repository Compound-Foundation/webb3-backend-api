import * as Compute from './computation.js';
import type * as Type from '../type-utilities.js';

type LookupTuple<
  Scope extends Compute.Spec,
  Name  extends Scope['name'] = Scope['name'],
> = (
  UnsafeLookupTuple<Scope, Name>
);

type UnsafeLookupTuple<Scope extends Compute.Spec, Name> = (
  readonly [ Name, Extract<Scope, { name: Name }>['expects'] ]
);

type ResolvedLookupTuple<
  Scope extends Compute.Spec,
  Name  extends Scope['name'] = Scope['name'],
> = (
  readonly [ Name, Extract<Scope, { name: Name }>['returns'] ]
);

type ResolveLookupTuple<
  Scope  extends Compute.Spec,
  Lookup extends LookupTuple<Scope>,
> = (
  ResolvedLookupTuple<Scope, Lookup[0]>
);

type ResolveLookupTuples<
  Scope extends Compute.Spec,
  Lookups, // extends readonly _LookupIn<Scope>[]
> = (
  Lookups extends readonly []
    ? []
  : Lookups extends readonly [ LookupTuple<Scope>, ...infer Rest ]
    ? [ ResolveLookupTuple<Scope, Lookups[0]>, ...ResolveLookupTuples<Scope, Rest> ]
  : Lookups extends readonly (LookupTuple<Scope>)[]
    ? (ResolveLookupTuple<Scope, Lookups[number]>)[]
  : never
);

type ResolvedLookupTupleResults<
  Scope extends Compute.Spec,
  Resolveds, // extends readonly _ResolvedLookup<Scope, any>
> = (
  Resolveds extends readonly []
    ? []
  : Resolveds extends readonly [ ResolvedLookupTuple<Scope>, ...infer Rest ]
    ? [ Resolveds[0][1], ...ResolvedLookupTupleResults<Scope, Rest> ]
  : Resolveds extends readonly (ResolvedLookupTuple<Scope>)[]
    ? (Resolveds[number][1])[]
  : never
);

type LookupResults<
  Scope   extends Compute.Spec,
  Lookups extends readonly LookupTuple<Scope>[]
> = (
  ResolvedLookupTupleResults<Scope, ResolveLookupTuples<Scope, Lookups>>
);

type LookupObject<Scope extends Compute.Spec> = {
  [Name in Scope['name']]?: Extract<Scope, { name: Name }>['expects']
};

type _LookupObjectResult<
  Scope  extends Compute.Spec,
  Lookup extends LookupObject<Scope>,
> = {
  [Name in keyof Lookup]-?: Extract<Scope, { name: Name }>['returns']
};

const RedexType = Symbol('RedexType');
type RedexType = typeof RedexType;

type Redex<Scope extends Compute.Spec, Return = unknown> = {
  [RedexType]: true,
  body: [
    readonly [ ...(LookupTuple<Scope, any> | Redex<Scope>)[] ],
    (results: any) => Type.MaybeAsync<(Return | Redex<Scope, Return>)>
  ]
};

type Returns<Rx, Else = never> = (
  Rx extends Redex<any, infer Return>
    ? Returns<Return, Return>
    : Else
);

type TupleReturns<Rxs> = (
  Rxs extends readonly []
    ? []
  : Rxs extends readonly [{ body: [ any, (_: any) => any ] }, ...infer Rest ]
    ? [ Returns<Rxs[0]>, ...TupleReturns<Rest> ]
  : Rxs extends readonly ({ body: [ any, (_: any) => any ] })[]
    ? (Returns<Rxs[number]>)[]
  : never
);

type Of<Body extends Redex<any>['body']> = {
  [RedexType]: true,
  body: Body,
};

function Of<Body extends Redex<any>['body']>(body: Body): Of<Body> {
  return { [RedexType]: true, body };
}

function castRedex<
    Scope extends Compute.Spec = Compute.Spec,
    Return = unknown,
  >
  (target: any)
  : target is Redex<Scope, Return>
{
  return typeof target === 'object'
      && target !== null
      && RedexType in target
    ;
}

type Values<O> = O[keyof O];

interface Factories<Scope extends Compute.Spec> {
  value<Value>
    (value: Value)
    : Of<[ [], () => Value ]>;
  pull_<L extends readonly LookupTuple<Scope>[]>
    (lookup: L)
    : Of<[ L, (_: ResolveLookupTuples<Scope, L>) => ResolveLookupTuples<Scope, L> ]>;
  pipe_<L extends readonly LookupTuple<Scope>[], Return = unknown>
    (body: [ L, (_: LookupResults<Scope, L>) => Return ])
    : Of<[  L, (_: ResolveLookupTuples<Scope, L>) => Return ]>;
  split<Dependencies extends readonly Redex<Scope>[]>
    (dependencies: Dependencies)
    : Of<[ Dependencies, (results: TupleReturns<Dependencies>) => TupleReturns<Dependencies> ]>;
  join<Dependencies extends readonly Redex<Scope>[], Return = unknown>
    (body: [ Dependencies, (results: TupleReturns<Dependencies>) => Return ])
    : Of<[  Dependencies, (results: TupleReturns<Dependencies>) => Return ]>;
  /*
   * compatibility: object-based lookups
   */
  pull<L extends LookupObject<Scope>>
    (lookup: L)
    : Of<[
      UnsafeLookupTuple<Scope, keyof L>[],
      (_: ResolveLookupTuples<Scope, UnsafeLookupTuple<Scope, keyof L>[]>) => (
        _LookupObjectResult<Scope, L>
      )
    ]>;
  pipe<L extends LookupObject<Scope>, Return = unknown>
    (body: [ L, (_: _LookupObjectResult<Scope, L>) => Return ])
    : Of<[
      UnsafeLookupTuple<Scope, keyof L>[],
      (_: ResolveLookupTuples<Scope, UnsafeLookupTuple<Scope, keyof L>[]>) => Return
    ]>;
  /*
   * compatibility: object-based lookup-1s
   */
  pull1<L extends LookupObject<Scope>>
    (lookup: L)
    : Of<[
      UnsafeLookupTuple<Scope, keyof L>[],
      (_: ResolveLookupTuples<Scope, UnsafeLookupTuple<Scope, keyof L>[]>) => Values<_LookupObjectResult<Scope, L>>
    ]>;
  pipe1<L extends LookupObject<Scope>, Return = unknown>
    (body: [ L, (_: Values<_LookupObjectResult<Scope, L>>) => Return ])
    : Of<[
      UnsafeLookupTuple<Scope, keyof L>[],
      (_: ResolveLookupTuples<Scope, UnsafeLookupTuple<Scope, keyof L>[]>) => Return
    ]>;
}

function Factories<Scope extends Compute.Spec>(): Factories<Scope> {
  return {
    join:  body    => Of(body),
    value: value   => Of([ [], () => value ]),
    split: deps    => Of([ deps,     ( results) => results  ]) ,
    pull_: lookups => Of([ lookups,  (resolved) => resolved ]) ,
    pipe_: body    => Of([ body[0],  (resolved) => body[1](resolved.map(([ _, result ]) => result) as any) ]),
    // compatibility: object-based lookups
    pull:  lookObj => Of([ Object.entries(lookObj) as any, Object.fromEntries ]),
    pipe:  body    => Of([ Object.entries(body[0]) as any, (resolved) => body[1](Object.fromEntries(resolved) as any) ]),
    // compatibility: object-based lookup-1s
    pull1: lookObj => Of([ Object.entries(lookObj) as any, (resolved) => resolved[0][1] ]),
    pipe1: body    => Of([ Object.entries(body[0]) as any, (resolved) => body[1](resolved[0][1]) ]),
  };
}

export {
  Of,
  Redex,
  Returns,
  Factories,
  TupleReturns,
  LookupObject,
  castRedex   as cast,
  RedexType   as Type,
  LookupTuple         as Lookup,
  ResolvedLookupTuple as ResolvedLookup,
};
