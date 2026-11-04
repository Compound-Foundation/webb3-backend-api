/*
 * The client a request is counted as, from the address Cloudflare saw it come
 * from (`CF-Connecting-IP`).
 *
 * An IPv4 address is one client. An IPv6 client is given a whole /64 — a
 * subnet of 2^64 addresses, any of which it can send from — so an IPv6
 * address stands for its /64: counted per address, a client that sent every
 * request from another address of its subnet would never spend a budget. An
 * IPv4 address written as IPv6 (`::ffff:198.51.100.7`) is that IPv4 client.
 * Text that is no address is counted as it is written.
 */
function clientOf(address: string): string {
  if (!address.includes(':')) {
    return address;
  }
  const groups = ipv6GroupsOf(address);
  if (groups === null) {
    return address;
  }
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return [ groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff ].join('.');
  }
  return `${groups.slice(0, 4).map(group => group.toString(16)).join(':')}::/64`;
}

/*
 * The eight 16-bit groups of an IPv6 address, in any of the ways RFC 4291
 * writes one: groups of up to four hex digits in either case, `::` for one
 * or more groups of zeros, and an IPv4 address in place of the last two.
 * Null for anything else.
 */
function ipv6GroupsOf(address: string): number[] | null {
  const halves = address.split('::');
  if (halves.length > 2) {
    return null;
  }
  const head = groupsOf(halves[0], halves.length === 1);
  const tail = halves.length === 1 ? [] : groupsOf(halves[1], true);
  if (head === null || tail === null) {
    return null;
  }
  // `::` stands for at least one group, and without it the address writes all eight
  const zeros = 8 - head.length - tail.length;
  if (halves.length === 1 ? zeros !== 0 : zeros < 1) {
    return null;
  }
  return [ ...head, ...new Array<number>(zeros).fill(0), ...tail ];
}

// the groups one side of a `::` writes; only the last side may end in an IPv4 address
function groupsOf(text: string, last: boolean): number[] | null {
  if (text === '') {
    return [];
  }
  const pieces = text.split(':');
  const groups: number[] = [];
  for (const [ index, piece ] of pieces.entries()) {
    if (last && index === pieces.length - 1 && piece.includes('.')) {
      const octets = piece.split('.');
      if (octets.length !== 4 || octets.some(octet => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) {
        return null;
      }
      const [ a, b, c, d ] = octets.map(Number);
      groups.push(a * 256 + b, c * 256 + d);
    } else if (/^[0-9a-f]{1,4}$/i.test(piece)) {
      groups.push(parseInt(piece, 16));
    } else {
      return null;
    }
  }
  return groups;
}

export { clientOf };
