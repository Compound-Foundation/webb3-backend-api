import type * as Hex from './hex.js';

/*
 * Various EVM hashes are 32-bytes encoded as 64 hexadecimal digits.
 * - Block hash
 * - Transaction hash
 * - Any arbitrary keccak256 hash
 */
type HexHash = Hex.String;
function isHash(hash: string): hash is HexHash {
  return /0x[0-9a-fA-F]{64}/.test(hash);
}

export type {
  HexHash as Hex,  // Hash.Hex
  HexHash as Hash, // import { Hash } from './evm/hash.js';
};

export {
  isHash,
  isHash as is, // Hash.is
};
