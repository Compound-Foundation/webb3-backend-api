import type * as Hex from './hex.js';

/*
 * An Address is a 20-byte hash, encoded as 40 hexadecimal digits.
 *
 * NOTE: an address may have an EIP-55 mixed-case checksum encoded in its
 * letter casings. It is potential future work to validate checksums
 * and/or expose functionality for checksum-agnostic comparisons, etc.
 */
type HexAddress = Hex.String;
function isAddress(address: string): address is HexAddress {
  return /0x[0-9a-fA-F]{40}/.test(address);
}

export type {
  HexAddress,
  HexAddress as Hex, // Address.Hex
};

export {
  isAddress,
  isAddress as is, // Address.is
};
