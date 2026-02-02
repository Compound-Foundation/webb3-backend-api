/*
 * OrDefault<T, Default> substitutes Default for T if T is unknown, any,
 * or undefined.
 *
 * Useful in type constructors where fields may be optional and should
 * fall back to a default type. For example:
 *    type Widget<W extends { hidden?: boolean }> = {
 *      hidden: OrDefault<W['hidden'], false>,
 *    };
 *
 * If the property `Widget['hidden']` is not given, it will default to the
 * literal boolean type `false`.
 */
type OrDefault<T, Default extends T> = (
  unknown extends T ? Default : T extends undefined ? Default : T
);

/*
 * Expand<T> tricks the compiler into expanding types wrapped in other
 * types when it would otherwise choose to leave them wrapped.
 *
 * In other words, if you have an Opaque<T> then Expand<Opaque<T>> _may_
 * cause the compiler to recursively evaluate the Opaque modifier
 * resulting in a more concrete type.
 */
type Expand<T> = T extends any ? T : never;

/*
 * MaybeAsync<T> optionally wraps T in a Promise. Invert with Awaited<T>.
 */
type MaybeAsync<T> = Promise<T> | T;

/*
 * Enumerate effectively clones a mapped type by re-enumerating all of its
 * fields, preserving their optionality, readonly-ness, etc.
 */
type Enumerate<T> = (
    T extends any[]  ? T // don't enumerate array methods
  : T extends object ? Expand<{ [K in keyof T]: T[K] }>
  : T
);

/*
 * Merge collapses an intersection of mapped types into one mapped type.
 *
 * If any member of the intersection is not a mapped type -- that is, if
 * `Enumerate<T> extends T` is not satisfied -- Merge does nothing.
 */
type Merge<T> = Enumerate<T> extends T ? Enumerate<T> : T;

/*
 * HasKey<Key extends keyof any>
 *
 * A simple constraint type to be used on the right-hand-side of a
 * conditional `extends` clause, which checks whether the left-hand-side
 * type has any value for the key given by Key.
 *
 * For example:
 *    { x: number } extends HasKey<'x'> ? 1 : 0 ==> 1
 *    { y: string } extends HasKey<'x'> ? 1 : 0 ==> 0
 */
type HasKey<Key extends keyof any> = {
  [_ in Key]: any;
};

/*
 * Optional<T, K> returns T modified so that fields [k in K] are optional.
 */
type Optional<
  T,
  Keys extends keyof T,
  /* NOTE(jordan): by evaluating O and X (`optionals` and `excludes`) up
   * front as generics, rather then evaluating the `Extract` and `Exclude`
   * in the body of the rewrite rule, we are able to preserve the existing
   * optionality and readonly-ness of fields of T, without accidentally
   * losing or overriding. (Type system hack. Not semantically meaningful)
   */
  O extends keyof T = Extract<keyof T, Keys>,
  X extends keyof T = Exclude<keyof T, Keys>,
> = Merge<(
  & { [K in O]?: T[K] | undefined }
  & { [K in X]:  T[K] }
)>;

/*
 * Required<T, K> returns T modified so that fields [k in K] are required.
 */
type Required<
  T,
  Keys extends keyof T,
  /* NOTE(jordan): by evaluating R and X (`requireds` and `excludes`) up
   * front as generics, rather then evaluating the `Extract` and `Exclude`
   * in the body of the rewrite rule, we are able to preserve the existing
   * optionality and readonly-ness of fields of T, without accidentally
   * losing or overriding. (Type system hack. Not semantically meaningful)
   */
  R extends keyof T = Extract<keyof T, Keys>,
  X extends keyof T = Exclude<keyof T, Keys>,
> = Merge<(
  & { [K in R]-?: T[K] }
  & { [K in X]:   T[K] }
)>;

/*
 * String literal manipulation types.
 */
namespace String {
  /*
   * LTrim, RTrim, Trim: trim spaces on {either,both} sides of a string S.
   */
  export type LTrim<S> = S extends `${' ' | '\n'}${infer SR}` ? LTrim<SR> : S;
  export type RTrim<S> = S extends `${infer SL}${' ' | '\n'}` ? RTrim<SL> : S;
  export type Trim<S> = LTrim<RTrim<S>>;
  /*
   * Compress<S> compresses all sequences of spaces into single spaces.
   * For example:
   *    Compress<`  apple    orange banana   `>  →  `apple orange banana`
   */
  export type Compress<S> = (
    Trim<S> extends `${infer L} ${infer R}` ? `${Compress<L>} ${Compress<R>}` : Trim<S>
  );
  /*
   * Tokenize<{ Delimiter }, S> splits a string literal S on Delimiter and
   * then compresses the resulting tokens.
   *
   * For example:
   *    type Source = ` x,  y, z`; // note the spaces
   *    Tokenize<{ Delimiter: ',' }, Source>  →  [ `x`, `y`, `z` ]
   */
  export type Tokenize<
    Config extends { Delimiter: string },
    Source extends string,
  > = (
    Source extends `${infer Token}${Config['Delimiter']}${infer Rest}`
      ? [ Compress<Token>, ...Tokenize<Config, Rest> ]
      : [ Compress<Source> ]
  );
}

/*
 * Primitive types are neither aggregates nor functions.
 */
type Primitive = (
  | null
  | bigint
  | number
  | string
  | symbol
  | boolean
  | undefined
);

/*
 * Aggregate<T = any> types are objects, arrays, array-likes, or tuples
 * containing of elements of type T or nested aggregates of type T.
 *
 * Aggregate<Primitive> is roughly equivalent to a 'plain old data' type.
 */
type Aggregate<T = any> = (
  | { [x: keyof any]: (T | Aggregate<T>) } // object
  |         ArrayLike<(T | Aggregate<T>)>  // arrays-if-you-squint
  |          readonly (T | Aggregate<T>)[] // tuples
  |                   (T | Aggregate<T>)[] // normal arrays
);

/*
 * Struct<T> types are objects (not arrays, tuples, or array-likes)
 * containing elements of type T or nested Aggregates of type T.
 *
 * Struct<Primitive> is roughly equivalent to a C-like struct type that
 * permits nested structures, arrays, tuples, and array-likes.
 */
type Struct<T = any> = Exclude<Aggregate<T>, (ArrayLike<any> | any[])>;

/*
 * NonFunction is the type encompassing all non-function types.
 */
type NonFunction = (Primitive | Aggregate<Primitive>);

/*
 * fnWrap simplifies the normalization of interfaces that permit fields
 * which are optionally functions by wrapping instances of the return type
 * of a given function type F in a thunk that casts to F.
 *
 * fnWrap is capable of inferring F in contexts where the expected type is
 * contextually relevant. For example:
 *    interface Formatter { value(key: string): string }
 *    class Example implements Formatter {
 *      constructor(public value: Formatter['value']) {}
 *      static from(formatAs: string | Formatter['value']) {
 *        return new Example(fnWrap(formatAs));
 *      }
 *    }
 */
function fnWrap<F extends (..._: any[]) => any>(v: ReturnType<F>|F): F {
  if (typeof(v) !== 'function') return <F>(() => v);
  return v;
}

export {
  fnWrap,
};

export type {
  Merge,
  Expand,
  HasKey,
  String,
  Struct,
  Optional,
  Required,
  Aggregate,
  OrDefault,
  Primitive,
  MaybeAsync,
  NonFunction,
};
