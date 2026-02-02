/*
 * fixZeroes is a helper that normalizes the formatting of leading and
 * trailing zeroes in v2 API fields. In particular,
 *    - values without '.' are suffixed with '.0';  eg. '0'        -> '0.0'
 *    - insignificant trailing '0's are trimmed;    eg. '132.7000' -> '132.7'
 *    - trailing '.' is suffixed with '0';          eg. '5.'       -> '5.0'
 */
function fixZeroes(value: string) {
  // turn plain integers into decimals.
  if (!value.includes('.')) {
    return `${value}.0`
  }

  return (
    value
      .replace(/0+$/, '')   // strip trailing '0's from decimals ...
      .replace(/\.$/, '.0') // ... but end whole numbers with '.0' not '.'
  );
}

export {
  fixZeroes,
}
