import type * as Hex from './hex.js';

/*
 * An Address is a 20-byte hash, encoded as 40 hexadecimal digits.
 *
 * isAddress takes an address and nothing else: `0x`, with a lowercase x, and
 * 40 hex digits, with nothing before or after them. A value that only holds
 * one, such as an address with more characters around it, a 32-byte hash or
 * calldata, is not an address. The letters may be in either case, and an
 * EIP-55 checksum in their casing is not verified, so a caller that keys
 * anything by an address lowercases it first, as the account routes do.
 */
type HexAddress = Hex.String;
function isAddress(address: string): address is HexAddress {
  return /^0x[0-9a-fA-F]{40}$/.test(address);
}

export type {
  HexAddress,
  HexAddress as Hex, // Address.Hex
};

export {
  isAddress,
  isAddress as is, // Address.is
};
