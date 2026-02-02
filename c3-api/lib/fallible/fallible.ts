/*
 * A Fallible is an operation that may fail.
 * A Fallible.Outcome represents the success or failure of an operation.
 *
 * Outcome is similar to Result<T, E> from Rust.
 *
 * type MyOutcome = Outcome<{
 *   Success: MySuccessResult,
 *   Failure: MyFailureResult,
 * }>
 */
type Outcome<Configuration extends {
  Success: any,
  Failure: any,
}> = Outcome.Generic<
  Configuration['Success'],
  Configuration['Failure']
>;

/*
 * module namespace for `Fallible.Outcome`s
 */
namespace Outcome {
  /*
   * Outcome.Generic          -> types all possible outcomes
   * Outcome.Generic<S>       -> types any outcome that can succeed with S
   * Outcome.Generic<any, F>  -> types any outcome that can fail    with F
   * Outcome.Generic<S, F>    -> types a fully-instantiated Outcome type
   *
   * particularly useful as `extends` constraints in generics.
   */
  export type Generic<Success = any, Failure = any> = (
    | Outcome.Of.Success<Success>
    | Outcome.Of.Failure<Failure>
  );
  /*
   * shorthand
   * Outcome.Of<S, F> <=> Outcome<{ Success: S, Failure: F }>
   */
  export type Of<Success, Failure> = Outcome.Generic<Success, Failure>;
  /*
   * parallel type and value constructors for Outcome cases
   *
   * Outcome.Of.Success<S> -> success case type for Outcome.Of<S, any>
   * Outcome.Of.Failure<F> -> failure case type for Outcome.Of<any, F>
   *
   * Outcome.Of.Success(s) -> success case for Outcome.Of<(typeof s), any>
   * Outcome.Of.Failure(f) -> failure case for Outcome.Of<any, (typeof f)>
   */
  export namespace Of {
    export type Success<Success> = ([ true,  Success ]);
    export type Failure<Failure> = ([ false, Failure ]);
    export const Success = <S>(value: S): Success<S> => [ true,  value ];
    export const Failure = <F>(value: F): Failure<F> => [ false, value ];
  }
  /*
   * Outcome.Unwrap types unwraps the Success and Failure types from the
   * different outcome cases.
   */
  export namespace Unwrap {
    /*
     * Outcome.Unwrap.Success<O extends Outcome<S     >> -> S
     */
    export type Success<Outcome extends Outcome.Generic> = (
      Outcome.Extract.Success<Outcome>[1]
    );
    /*
     * Outcome.Unwrap.Failure<O extends Outcome<any, F>> -> F
     */
    export type Failure<Outcome extends Outcome.Generic> = (
      Outcome.Extract.Failure<Outcome>[1]
    );
  }
  /*
   * Outcome.Extract selects individual cases out of an Outcome, namely the
   * wrapped up Success and Failure cases.
   */
  export namespace Extract {
    /*
     * Outcome.Extract.Success<O extends Outcome<S, F>> -> Outcome.Of.Success<S>
     */
    export type Success<Outcome extends Outcome.Generic> = (
      Extract<Outcome, [ true, any ]>
    );
    /*
     * Outcome.Extract.Failure<O extends Outcome<S, F>> -> Outcome.Of.Failure<F>
     */
    export type Failure<Outcome extends Outcome.Generic> = (
      Extract<Outcome, [ false, any ]>
    );
  }
  /*
   * Type guards narrow an outcome to success or failure within if-blocks.
   */
  /*
   * isSuccess(outcome) narrows an outcome to its success case.
   *
   * for example:
   *   if (isSuccess(outcome)) { // outcome is Outcome.Of<S, F>
   *     outcome // outcome is Outcome.Of.Success<S>
   *   } else {
   *     outcome // outcome is Outcome.Of.Failure<F>
   *   }
   */
  export function isSuccess<Outcome extends Outcome.Generic>
    (outcome: Outcome)
    : outcome is Outcome.Extract.Success<Outcome>
  {
    return outcome[0] === true;
  }
  /*
   * isFailure(outcome) narrows an outcome to its failure case.
   * (Dual of isSuccess(outcome))
   *
   */
  export function isFailure<Outcome extends Outcome.Generic>
    (outcome: Outcome)
    : outcome is Outcome.Extract.Failure<Outcome>
  {
    return !isSuccess(outcome);
  }
  /*
   * An Outcome.OrJust<T> is either "just" T or an Outcome.Of<T, any>.
   *
   * An OrJust can also also optionally express the failure type of the
   * outcome:
   *
   * Outcome.OrJust<T, F> is either "just" T or an Outcome.Of<T, F>.
   *
   * Using OrJust as a return type allows us to write functions that
   * cannot fail as Fallibles without them needing to wrap their results
   * in a Fallible.Outcome. It also allows those functions to be gradually
   * refactored to express their failures with Fallible.Outcomes in the
   * future, because in reality functions that "cannot fail" eventually
   * realize that they do fail.
   */
  export type OrJust<Success, Failure = any> = (
    OrJust.Generic<Success, Failure>
  );
  export namespace OrJust {
    export type Generic<Success = any, Failure = any> = (
      | Success
      | Outcome.Of<Success, Failure>
    );
    /*
     * OrJust.As converts an OrJust into generic and specific cases of
     * Outcome.
     */
    export namespace As {
      /*
       * OrJust.As.Outcome<OrJust<S, F>> -> Outcome.Of<S, F>
       */
      export type Outcome<Just extends OrJust.Generic> = (
        Extract<Just, Outcome.Generic>
      );
      /*
       * OrJust.As.Success<OrJust<S, F>> -> Outcome.Of.Success<S>
       */
      export type Success<Just extends OrJust.Generic> = (
        Outcome.Extract.Success<As.Outcome<Just>>
      );
      /*
       * OrJust.As.Failure<OrJust<S, F>> -> Outcome.Of.Failure<F>
       */
      export type Failure<Just extends OrJust.Generic> = (
        Outcome.Extract.Failure<As.Outcome<Just>>
      );
    }
    /*
     * OrJust.Unwrap unwraps the Success and Failure types from the
     * encapsulated Outcome.
     */
    export namespace Unwrap {
      /*
       * OrJust.Unwrap.Failure<OrJust<S, F>> -> F
       */
      export type Failure<Just extends OrJust.Generic> = (
        Outcome.Unwrap.Failure<OrJust.As.Outcome<Just>>
      );
      /*
       * OrJust.Unwrap.Success<OrJust<S, F>> -> S
       */
      export type Success<Just extends OrJust.Generic> = (
        Just extends Outcome.Generic
          ? Outcome.Unwrap.Success<Just>
          : Exclude<Just, Outcome.Generic>
      );
    }
    /*
     * Type guards narrow an OrJust<Success, Failure> to an
     * Outcome<Success, Failure> or just a Success within if-blocks.
     */
    /*
     * isOutcome(orJust) determines whether an OrJust is an Outcome and
     * not 'just' a success.
     *
     * isOutcome<OrJust<Success, Failure>>(orJust) narrows an OrJust to
     * its Outcome<Success, Failure> case when it is not 'just' a Success.
     */
    export function isOutcome<Just extends OrJust.Generic>(value: Just)
      : value is OrJust.As.Outcome<Just>
    {
      return (true
        && value instanceof Array
        && value.length === 2
        && (typeof value[0]) === 'boolean'
      );
    }
    /*
     * ensureWrapped makes sure an OrJust of 'just' a Success is wrapped
     * in an Outcome.Of<Success>.
     */
    export function ensureWrapped<Just extends OrJust.Generic>
      (value: Just)
      : OrJust.As.Outcome<Just>
    {
      if (OrJust.isOutcome(value)) {
        return value;
      } else {
        // FIXME(jordan): is this a bad cast?
        return Outcome.Of.Success(value) as OrJust.As.Outcome<Just>;
      }
    }
  }
}

/* Fallible.isSuccess(outcome)
 *
 * Narrows any type extending Outcome.OrJust<S, F> to its S or
 * Outcome.Of.Success<S>, depending on the input parameter type.
 */
function isSuccess<Out  extends Outcome.Generic>(value: Out)
  : value is Outcome.Extract.Success<Out>;
function isSuccess<Just extends Outcome.OrJust.Generic>(value: Just)
  : value is (
    | Outcome.OrJust.As.Success<Just>
    | Outcome.OrJust.Unwrap.Success<Just>
  )
function isSuccess(value: any): boolean {
  return !Outcome.OrJust.isOutcome(value) || Outcome.isSuccess(value);
}

/*
 * Fallible.isFailure(outcome)
 *
 * Narrows any type extending Outcome.OrJust<S, F> to an
 * Outcome.Of.Failure<F>.
 */
function isFailure<Just extends Outcome.OrJust.Generic>(value: Just)
  : value is Outcome.OrJust.As.Failure<Just>
{
  return Outcome.OrJust.isOutcome(value) && Outcome.isFailure(value);
}

/*
 * Fallible.must(outcome)
 * unwraps Success value or throws if failed.
 */
function must<Just extends Outcome.OrJust.Generic>
  (just: Just)
  : Outcome.OrJust.Unwrap.Success<Just>
{
  const outcome = Outcome.OrJust.ensureWrapped(just);
  if (outcome[0]) {
    return outcome[1];
  }
  throw Object.assign(
    new Error(`Fallible.must(..): outcome was unexpected failure!`),
    { argument: just },
  );
}

/*
 * Fallible.unwrap(outcome)
 * unwraps payload of either Success or Failure.
 */
function unwrap<Just extends Outcome.OrJust.Generic>
  (just: Just)
  : Just extends Outcome.Generic ? Just[1] : Just
{
  return Outcome.OrJust.ensureWrapped(just)[1];
}

export {
  must,
  unwrap,
  Outcome,
  isSuccess,
  isFailure,
};
