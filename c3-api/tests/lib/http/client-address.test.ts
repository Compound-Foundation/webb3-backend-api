import t from 'tap';

import { clientOf } from '../../../src/http/client-address.js';

/*
 * The client an administrative request is counted as. An IPv4 address is one
 * client; an IPv6 address stands for its /64, the subnet one client is given,
 * however it is written; and anything that is no address is counted as it is
 * written, as every request without one shares a single budget.
 */
t.test('an IPv4 address is a client of its own', async t => {
  t.equal(clientOf('198.51.100.7'), '198.51.100.7');
  t.not(clientOf('198.51.100.8'), clientOf('198.51.100.7'), 'and the next address is another');
});

t.test('an IPv6 address stands for its /64, however it is written', async t => {
  const client = clientOf('2001:db8:1:2::1');
  t.equal(client, '2001:db8:1:2::/64');
  for (const address of [
    '2001:db8:1:2::46',
    '2001:db8:1:2:ffff:ffff:ffff:ffff',
    '2001:0DB8:0001:0002:0000:0000:0000:0001',
    '2001:db8:1:2:0:0:0:1',
    '2001:db8:1:2::198.51.100.7',
  ]) {
    t.equal(clientOf(address), client, `${address} is the same client`);
  }
  for (const address of [ '2001:db8:1:3::1', '2001:db8::1', '2001:db9:1:2::1' ]) {
    t.not(clientOf(address), client, `${address}, in another /64, is another`);
  }
  t.equal(clientOf('::1'), '0:0:0:0::/64', 'and the shortest forms are read too');
  t.equal(clientOf('2001:db8:1:2::'), client);
});

t.test('an IPv4 address written as IPv6 is that IPv4 client', async t => {
  t.equal(clientOf('::ffff:198.51.100.7'), '198.51.100.7');
  t.equal(clientOf('0:0:0:0:0:ffff:c633:6407'), '198.51.100.7', 'in hex groups too');
  t.not(clientOf('::ffff:198.51.100.8'), clientOf('::ffff:198.51.100.7'), 'so its neighbour is another client');
});

t.test('text that is no address is counted as it is written', async t => {
  for (const text of [
    'not an address',
    '2001:db8::1::2',
    '2001:db8:1:2:3:4:5:6:7',
    '2001:db8:1:2:3:4:5:6::',
    '2001:db8::12345',
    '2001:db8::1.2.3.256',
    '1.2.3.4::1',
    'fe80::1%eth0',
    ':1:2:3:4:5:6:7',
  ]) {
    t.equal(clientOf(text), text, `${text} is not read as an address`);
  }
});
