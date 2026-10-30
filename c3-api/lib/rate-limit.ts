/*
 * the subset of the Cloudflare Workers Rate Limiting binding that we use
 */
interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

const HexGroup       = /^[0-9a-f]{1,4}$/;
const DottedIpv4Tail = /\d{1,3}(\.\d{1,3}){3}$/;

/*
 * Returns the rate-limit key for a client address. An IPv4 address is its
 * own key. An IPv6 client is normally assigned a whole /64 and can rotate
 * through the addresses in it, so an IPv6 address is keyed on its /64
 * prefix. This deliberately puts clients that share a /64 in one bucket,
 * as clients behind one IPv4 NAT already are. Addresses in ::/64
 * (loopback, IPv4-mapped) and anything that does not parse as IPv6 are
 * kept whole.
 */
function key(ip: string): string {
  if (!ip.includes(':')) {
    return ip;
  }
  // a dotted IPv4 tail fills the last two groups, which are outside the /64
  const [ head, tail, ...rest ] = ip.toLowerCase().replace(DottedIpv4Tail, '0:0').split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const missing    = 8 - headGroups.length - tailGroups.length;
  const groups = tail === undefined
    ? headGroups
    : [ ...headGroups, ...Array(Math.max(0, missing)).fill('0'), ...tailGroups ];
  if (rest.length > 0 || groups.length !== 8 || !groups.every(group => HexGroup.test(group))) {
    return ip;
  }
  const prefix = groups.slice(0, 4).map(group => parseInt(group, 16).toString(16));
  if (prefix.every(group => group === '0')) {
    return ip;
  }
  return `${prefix.join(':')}::/64`;
}

/*
 * Returns true when the client behind `request` is over the limit.
 * Cloudflare sets CF-Connecting-IP on every request at the edge. A request
 * without it (tests, or a Worker calling through a service binding without
 * forwarding the header) is counted under one shared 'unknown' key.
 *
 * The check fails open. If the binding is unbound or throws, the request
 * is served, because an outage of the limiter must not take the API down
 * with it. The zone's WAF rate limiting rule is the second layer for that
 * case.
 */
async function isLimited(
  limiter: Limiter | undefined,
  request: Request,
): Promise<boolean> {
  if (limiter === undefined) {
    return false;
  }
  try {
    const { success } = await limiter.limit({
      key: key(request.headers.get('CF-Connecting-IP') ?? 'unknown'),
    });
    return !success;
  } catch (e: unknown) {
    console.error('rate limiter unavailable, serving request', e);
    return false;
  }
}

export {
  Limiter,
  key,
  isLimited,
};
