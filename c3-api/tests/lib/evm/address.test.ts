import t from 'tap';

import { defaultAbiCoder } from '@ethersproject/abi';

import * as Eth from '../../../lib/eth-constants.js';
import * as Address from '../../../lib/evm/address.js';
import { BigFixnum } from '../../../lib/bigfixnum.js';
import { isAddress as isRegistryAddress } from '../../../lib/model/comet-registry.js';
import { contractForLocation, describeContractCallForHumans } from '../../../lib/well-known/contracts/utils.js';

const LOWER  = '0x420f253087044b8bcf028dd89f8fe83ba6275e84';
const SUMMED = '0x420f253087044b8BCf028dd89F8fe83Ba6275E84';

/*
 * An address is `0x` and 40 hex digits, in any case, and nothing else. It is
 * what the account routes take, and what the market contract of a URL, an
 * address in history's markets[] and one in comp/accounts?addresses= are
 * checked against. Before, the check took any value that held an address
 * somewhere, so junk around one went on to the registry, the node, or Tally.
 */
const VERDICTS: Array<[ string, boolean, string ]> = [
  [ LOWER,                                true,  'a lowercase address' ],
  [ SUMMED,                               true,  'a checksummed one' ],
  [ `0x${LOWER.slice(2).toUpperCase()}`,  true,  'one in uppercase' ],
  [ SUMMED.replace('0x420f', '0x420F'),   true,  'one whose checksum is wrong, which is not verified' ],
  [ `0x${'0'.repeat(40)}`,                true,  'the zero address' ],
  [ '',                                   false, 'nothing' ],
  [ '0x',                                 false, 'the prefix alone' ],
  [ '0x123',                              false, 'a short value' ],
  [ LOWER.slice(0, -1),                   false, '39 hex digits' ],
  [ `${LOWER}0`,                          false, '41 hex digits' ],
  [ `0X${LOWER.slice(2)}`,                false, 'a capital X' ],
  [ LOWER.slice(2),                       false, 'no prefix' ],
  [ `x${LOWER}`,                          false, 'an address with junk before it' ],
  [ `${LOWER}junk`,                       false, 'an address with junk after it' ],
  [ ` ${LOWER}`,                          false, 'an address after a space' ],
  [ `${LOWER} `,                          false, 'an address before a space' ],
  [ `${LOWER}\n`,                         false, 'an address before a newline, which $ does not let through' ],
  [ `%20${LOWER}`,                        false, 'an address after a space as a URL encodes it' ],
  [ `0x${'ab'.repeat(32)}`,               false, 'a 32-byte hash' ],
  [ `0x${'g'.repeat(40)}`,                false, '40 characters that are not hex digits' ],
  [ `0x${'\uff11'.repeat(40)}`,           false, '40 fullwidth digits' ],
  [ `${LOWER}${'a'.repeat(3958)}`,        false, '4,000 characters that start with an address' ],
];

t.test('an address is 0x and 40 hex digits, in any case, and nothing else', async t => {
  for (const [ value, verdict, what ] of VERDICTS) {
    t.equal(Eth.parseAddress(value), verdict, `${what} is ${verdict ? '' : 'not '}an address`);
    t.equal(isRegistryAddress(value), verdict, 'as the registry judges it too');
  }
  t.equal(Eth.parseAddress, Address.isAddress, 'Eth.parseAddress is that check');
  t.equal(Address.is, Address.isAddress, 'and so is Address.is, which the transactions of a block are read with');
});

const MAINNET  = 'ethereum-mainnet';
const TIMELOCK = (Eth.wellKnownContractsByNetwork[MAINNET] as any)['Timelock']['default'].address as string;

// the title of an action of the Timelock, which is a call to `signature` with `values`
function titleOf(signature: string, types: string[], values: unknown[]): string {
  return describeContractCallForHumans(
    contractForLocation({ network: MAINNET, address: TIMELOCK as never }, Eth.wellKnownContractsByNetwork as never) as never,
    signature, defaultAbiCoder.encode(types, values), BigFixnum.from({ value: 0 }), Eth.wellKnownContractsByNetwork as never,
  ).title;
}

/*
 * A call to a function no title names is written out with its arguments, and
 * a string argument that holds an address is quoted: an address, and also a
 * bytes32 or a string with one in it. The check the routes take an address
 * with does not decide that, so such a title reads as it did, byte for byte.
 * A call to a function a title names reads as it did too when its arguments
 * are of the types that title expects; one with another type where the title
 * expects an address, such as `_setPriceOracle(bytes32)`, can be titled
 * otherwise than before.
 */
t.test('a title formatted by default quotes an argument that holds an address, as it did', async t => {
  const HASH = `0x${'ab'.repeat(32)}`;
  t.ok(titleOf('setHash(bytes32)', [ 'bytes32' ], [ HASH ]).endsWith(`.setHash("${HASH}")`), 'a 32-byte value is quoted');
  t.ok(titleOf('note(string)', [ 'string' ], [ `see ${LOWER}` ]).endsWith(`.note("see ${LOWER}")`),
    'and so is a string with an address in it');
  t.ok(titleOf('setGuardian(address)', [ 'address' ], [ LOWER ]).endsWith(`.setGuardian("${SUMMED}")`),
    'and an address, as the call data decodes it');
  t.ok(titleOf('note(string)', [ 'string' ], [ 'a note' ]).endsWith('.note(a note)'), 'while a string without one is not');

  t.equal(titleOf('_setPriceOracle(address)', [ 'address' ], [ LOWER ]), `Set new price oracle to  ${SUMMED}`,
    'and a call a title names, with an address where the title expects one, is named as it was');
});
