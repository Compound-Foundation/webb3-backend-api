/*
 * A Hex value is a string of hexadecimal digits prefixed by `0x`.
 */
type Hex = `0x${string}`;
function isHex(value: string): value is Hex {
  return /0x[0-9a-fA-F]+/.test(value);
}

/*
 * TODO(jordan): handle if value.length > 66...
 */
function pad32(value: Hex): Hex {
  return `0x${value.slice(2).padStart(64, '0')}`;
}

function fromNumber(n: number): Hex {
  return `0x${n.toString(16)}`;
}

export type {
  Hex,
  Hex as String, // Hex.String
};

export {
  isHex,
  pad32,
  fromNumber,
  isHex as is, // Hex.is
};
