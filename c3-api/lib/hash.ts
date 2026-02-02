import sha3 from 'js-sha3';

/*
 * We need an instance of TextEncoder, but there's no apparent reason to
 * have more than one. The methods are not stateful. So we have one for
 * the entire module.
 */
const encoder = new TextEncoder();

/*
 * Generally, we might expect WebCrypto digests to be faster than a Keccak
 * hash implemented in pure JavaScript. Where the choice is available and
 * we need a quick hash function, we would therefore prefer sha256 from
 * the WebCrypto digest suite over keccak256. (SHA-3 and Keccak are not
 * available in WebCrypto, as of yet. Hence, SHA-256.)
 */
async function sha256(source: string): Promise<string> {
  const utf8Bytes   = encoder.encode(source);
  const digestBytes = await crypto.subtle.digest('SHA-256', utf8Bytes);
  return Buffer.from(digestBytes).toString('hex');
}

/*
 * Sometimes, we need a keccak256 hash - usualle for the purpose of
 * encoding values for the EVM. In such cases, we can still leverage
 * modern Web API's TextEncoder for encoding a string into utf-8 bytes,
 * which -- like choosing to use WebCrypto where possible -- we might
 * expect to be faster than the pure JavaScript encoder inside of js-sha3.
 */
function keccak256(source: string): string {
  const utf8Bytes   = encoder.encode(source);
  const digestBytes = sha3.keccak256.arrayBuffer(utf8Bytes);
  return Buffer.from(digestBytes).toString('hex');
}

export {
  sha256,
  keccak256,
};
