import * as Fallible from '../fallible/fallible.js';

import * as Hex from './hex.js';

type HexTimestamp = Hex.String;
type EpochSeconds = number;

/*
 * seconds resolution epoch timestamps encode to hexadecimal strings
 */
function encode(timestamp: EpochSeconds): HexTimestamp {
  return Hex.fromNumber(timestamp);
}

/*
 * hexadecimal timestamps decode into seconds resolution epoch times
 */
function decode(encoded: HexTimestamp): EpochSeconds {
  return parseInt(encoded, 16);
}

/*
 * toDateString materializes the YYYY-MM-DD date string for a seconds
 * resolution epoch timestamp
 */
function toDateString(timestamp: EpochSeconds): string {
  const date = new Date(timestamp * 1000);
  return date.toISOString().split('T')[0];
}

/*
 * hexadecimal strings and integer numbers can be cast to coerce them into
 * hex-encoded timestamps and seconds resolution epoch timestamps,
 * respectively.
 */
function cast(value: number): value is EpochSeconds;
function cast(value: string): value is HexTimestamp;
function cast(value: any) {
  return (typeof(value) === 'number' && ((value | 0) === value))
      || (typeof(value) === 'string' && Hex.is(value));
}

/*
 * a seconds resolution epoch timestamp can be parsed from any string that
 * casts successfully to a hexadecimal number and can therefore be decoded
 * as a timestamp.
 */
function parse(value: string) {
  if (cast(value)) {
    return decode(value);
  }
  return Fallible.Outcome.Of.Failure({
    value,
    error: 'cannot parse Timestamp from string',
  });
}

export type {
  HexTimestamp,
  EpochSeconds,
  HexTimestamp as Hex,
};

export {
  cast,
  parse,
  encode,
  decode,
  toDateString,
};
