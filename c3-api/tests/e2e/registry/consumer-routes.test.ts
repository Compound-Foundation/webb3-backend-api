import t, { Test } from 'tap';

import { createHash } from 'node:crypto';

import { defaultAbiCoder } from '@ethersproject/abi';

import C3Api, { Env } from '../../../entrypoint.js';

import * as Eth from '../../../lib/eth-constants.js';
import type { RegistrySnapshotV1 } from '../../../lib/model/comet-registry.js';
import type * as KnownNetwork from '../../../lib/well-known/networks/network.js';

import { streamEventsOf } from '../../../src/transaction-history-handler/transaction-history-items-handler.js';

import { MemoryKv, refusingKv } from '../../util/kv.js';
import * as mock from '../../util/mock/mock.js';
import { makeTestEnv } from '../../util/test-env.js';
import { activeRegistryDatabase } from '../../util/registry-database.js';
import { fixtureCatalog, loadRegistrySnapshotFixture } from '../../util/registry-fixture.js';

import '../../../shim/node-self.js';

/*
 * What the legacy routes do about the registry, before any chain request is
 * made: which version answered, what happens when there is none, and what a
 * market address means now that the version decides it.
 *
 * Nothing here reaches the network. Every request leaves through a fetch
 * mock that refuses whatever a test did not say it expects, and the node
 * provider answers a route that resolved its market as a node that is down
 * does: what it took to get that far is what is tested, and what the route
 * answers a node that failed it with. Everything past resolution lives in the
 * market and transaction-history suites.
 */
const MAINNET = 'ethereum-mainnet';
const USDC    = '0xc3d688b66703497daa19211eedff47f25384cdc3';
const UNKNOWN = '0x1111111111111111111111111111111111111111';

declare var fetch: mock.Fetch;
const fetchBefore = globalThis.fetch;
t.beforeEach(() => {
  globalThis.fetch = mock.fetch({});
});
t.afterEach(t => {
  fetch.satisfy(t);
});
t.teardown(() => {
  globalThis.fetch = fetchBefore;
});

function envWith(overrides: Partial<Env> = {}): Env {
  return makeTestEnv({ MEMORY_CACHE_SEED: 'registry-consumer-routes', ...overrides });
}

async function get(env: Env, path: string): Promise<Response> {
  return C3Api.fetch(new Request(`https://api.test.local${path}`), env);
}

/*
 * The next request to the node provider of `network`, the one a route makes
 * once it has resolved a market there, is answered as by a node that is down:
 * as the node provider proxy answers when no provider served the calls, with
 * the seconds to wait before asking again.
 */
function nodeDown(env: Env, network: KnownNetwork.Name): void {
  fetch.expect(Eth.nodeEndpoint(env.NODE_PROXY_HOST, env.NODE_PROXY_KEY, network), { method: 'POST' })
    .returns('upstream error', { status: 503, headers: { 'Retry-After': '5' } });
}

type Call = { id: number, method: string };

/*
 * A node in place of the mock for the length of `run`, which answers each call
 * of every request as `answer` says, however many requests the route makes,
 * and reports the URLs it was asked at.
 */
async function answering(
  answer: (call: Call) => object,
  run: () => Promise<Response>,
): Promise<{ response: Response, asked: string[] }> {
  const mocked = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    asked.push(request.url);
    const calls = await request.json() as Call[];
    return new Response(JSON.stringify(calls.map(call => ({ jsonrpc: '2.0', id: call.id, ...answer(call) }))));
  }) as typeof globalThis.fetch;
  try {
    return { response: await run(), asked };
  } finally {
    globalThis.fetch = mocked;
  }
}

function captureErrors(t: Test): string[] {
  const lines: string[] = [];
  const error = console.error;
  console.error = (...parameters: unknown[]) => { lines.push(parameters.map(String).join(' ')); };
  t.teardown(() => { console.error = error; });
  return lines;
}

function captureWarnings(t: Test): string[] {
  const lines: string[] = [];
  const warn = console.warn;
  console.warn = (...parameters: unknown[]) => { lines.push(parameters.map(String).join(' ')); };
  t.teardown(() => { console.warn = warn; });
  return lines;
}

type Envelope = { error: { code: string, message: string, requestId: string, details?: Record<string, unknown> } };

// an error answer is the envelope every route answers with, as JSON
async function envelopeOf(t: Test, response: Response): Promise<Envelope['error']> {
  t.match(response.headers.get('content-type'), /^application\/json/, 'the error is JSON');
  const body = await response.json() as Envelope;
  t.match(body.error.requestId, /^[0-9a-f-]{36}$/, 'with a request id to correlate with the logs');
  return body.error;
}

t.test('a market route says which version answered it', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const env    = envWith({ APP_DB: registry.db });
  const errors = captureErrors(t);

  nodeDown(env, MAINNET);
  const response = await get(env, `/market/${MAINNET}/${USDC}/summary`);

  t.equal(response.headers.get('x-registry-version'), registry.versionId,
    'every response whose content depends on the registry names the version');
  t.equal(response.headers.get('x-registry-checksum'), registry.snapshot.registryVersion.checksum);
  t.equal(response.status, 503, 'a market of the active version resolves, and goes on to read the chain of its network');
  t.match(errors.join('\n'), /JSON-RPC request failed: HTTP 503/, 'where only the node that is down fails it');
  t.equal((await envelopeOf(t, response)).code, 'UPSTREAM_UNAVAILABLE', 'as a node provider that did not answer');
  t.equal(response.headers.get('retry-after'), '5', 'which may be asked again after as long as the proxy said');
});

t.test('an address the active version does not describe is not a market', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const env = envWith({ APP_DB: registry.db });

  const unknown = await get(env, `/market/${MAINNET}/${UNKNOWN}/summary`);
  t.equal(unknown.status, 400, 'an address no version describes is refused');
  t.match(await unknown.text(), /Contract address not known/);

  const otherNetwork = await get(env, `/market/polygon-mainnet/${USDC}/summary`);
  t.equal(otherNetwork.status, 400, 'and so is a market addressed on the wrong network');
});

/*
 * A market the version gives no rewards has nothing to value them with: its
 * reward feed is a placeholder at the zero address. The rewards summary says
 * so before it would read that feed, rather than failing on it.
 */
t.test('the rewards summary of a market without rewards says so', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const env = envWith({ APP_DB: registry.db });

  const scroll   = registry.snapshot.networks.find(network => network.chainId === 534352)!.markets[0]!;
  t.equal(scroll.capabilities.rewards, false, 'the fixture\'s Scroll market has no rewards');

  const response = await get(env, `/market/scroll-mainnet/${scroll.contracts.comet}/rewards/summary`);
  t.equal(response.status, 404, 'its rewards summary is not found');
  const error = await envelopeOf(t, response);
  t.same([ error.code, error.message ], [ 'REWARDS_NOT_AVAILABLE', 'Rewards are not available for this market' ],
    'with a code a client can act on');
  t.equal(response.headers.get('x-registry-version'), registry.versionId, 'and the version that decided it');

  const errors = captureErrors(t);
  nodeDown(env, MAINNET);
  const rewarded = await get(env, `/market/${MAINNET}/${USDC}/rewards/summary`);
  t.equal(rewarded.status, 503, 'a market with rewards is not refused: its summary goes on to read the chain');
  t.match(errors.join('\n'), /JSON-RPC request failed: HTTP 503/, 'where only the node that is down fails it');
  t.equal((await envelopeOf(t, rewarded)).code, 'UPSTREAM_UNAVAILABLE');
  t.equal(rewarded.headers.get('retry-after'), '5');
});

/*
 * A node provider that did not serve a market route fails it with a 503,
 * however it failed: answering with an error status, as above, not being
 * reached at all, breaking off its answer, or answering a call with an error
 * that is not a revert — which is how the proxy masks a provider's own
 * failure. A call the contract reverted is its answer, and where a value was
 * needed it is a fault: a 500. So is a route that spent the subrequests its
 * invocation is given, since the node was never asked.
 */
t.test('a node provider that did not serve a market route is a 503, and a revert is not', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const env      = envWith({ APP_DB: registry.db });
  const endpoint = Eth.nodeEndpoint(env.NODE_PROXY_HOST, env.NODE_PROXY_KEY, MAINNET);
  const summary  = `/market/${MAINNET}/${USDC}/summary`;
  const errors   = captureErrors(t);
  const failed   = () => errors.at(-1) ?? '';

  fetch.expect(endpoint, { method: 'POST' }).returns(() => Promise.reject(new TypeError('fetch failed')));
  const unreachable = await get(env, summary);
  t.equal(unreachable.status, 503, 'a node provider the worker cannot reach');
  t.equal((await envelopeOf(t, unreachable)).code, 'UPSTREAM_UNAVAILABLE');
  t.equal(unreachable.headers.get('retry-after'), null, 'which asked for no wait, since nothing answered');
  t.match(failed(), /JSON-RPC request failed: fetch failed/);

  fetch.expect(endpoint, { method: 'POST' }).returns(() => new Response(
    new ReadableStream({ pull(controller) { controller.error(new TypeError('terminated')); } }),
    { status: 503, headers: { 'Retry-After': '5' } },
  ));
  const cut = await get(env, summary);
  t.equal(cut.status, 503, 'a node provider whose answer breaks off');
  t.equal((await envelopeOf(t, cut)).code, 'UPSTREAM_UNAVAILABLE');
  t.equal(cut.headers.get('retry-after'), '5', 'with the wait its status line asked for');
  t.match(failed(), /JSON-RPC request failed: terminated/);

  const block  = { result: { number: '0x1c9c380', timestamp: '0x6a8e5f00', transactions: [] } };
  const latest = (otherwise: object) => (call: Call) => call.method === 'eth_getBlockByNumber' ? block : otherwise;

  const masked = await answering(() => ({ error: { code: -32000, message: 'upstream error' } }), () => get(env, summary));
  t.equal(masked.response.status, 503, 'a node provider that answers each call with its masked failure');
  t.equal((await envelopeOf(t, masked.response)).code, 'UPSTREAM_UNAVAILABLE');
  t.match(failed(), /eth_getBlockByNumber: call error: .*upstream error/, 'the first of which is the latest block');

  const behind = await answering(latest({ error: { code: -32000, message: 'header not found' } }), () => get(env, summary));
  t.equal(behind.response.status, 503, 'and one that answers the latest block, but not the reads at it');
  t.equal((await envelopeOf(t, behind.response)).code, 'UPSTREAM_UNAVAILABLE');
  t.match(failed(), /ethCall: call error: .*header not found/);

  const reverted = await answering(latest({ error: { code: 3, message: 'execution reverted', data: '0x' } }), () => get(env, summary));
  t.equal(reverted.response.status, 500, 'while reads the contract reverted fail the summary as a fault');
  t.equal((await envelopeOf(t, reverted.response)).code, 'INTERNAL');
  t.match(failed(), /ethCall: call error: \{"code":3,"message":"execution reverted"\}/, 'the revert of a read that is not a price');

  fetch.expect(endpoint, { method: 'POST' }).returns(() => Promise.reject(new Error('Too many subrequests.')));
  const spent = await get(env, summary);
  t.equal(spent.status, 500, 'and a route past the subrequests of its invocation fails as its own fault');
  t.equal((await envelopeOf(t, spent)).code, 'INTERNAL');
  t.match(failed(), /Error: Too many subrequests\./, 'which the log names, not a node that did not answer');
  t.notMatch(failed(), /NotServed/);

  t.same([ ...new Set([ ...masked.asked, ...behind.asked, ...reverted.asked ]) ], [ endpoint ],
    'and the route asked nothing but the node provider of its network');
});

/*
 * After the cutover there is no static market list to fall back to. A request
 * that needs the registry fails while the rest of the API keeps working,
 * rather than quietly answering from a list nobody activated.
 */
t.test('without an active version the market and account routes fail explicitly', async t => {
  // a validated version nobody activated: the registry has nothing to serve
  const registry = await activeRegistryDatabase({ activate: false });
  t.teardown(() => registry.dispose());
  const env = envWith({ APP_DB: registry.db });

  for (const path of [
    `/market/${MAINNET}/${USDC}/summary`,
    `/market/all-networks/all-contracts/summary`,
    `/account/${USDC}/rewards`,
    `/account/${USDC}/transaction_history`,
  ]) {
    const response = await get(env, path);
    t.equal(response.status, 503, `${path} reports the registry as unavailable`);
    const error = await envelopeOf(t, response);
    t.equal(error.code, 'REGISTRY_NOT_ACTIVE', 'in the envelope the registry routes answer with, and the same code');
    t.equal(response.headers.get('x-registry-version'), null, 'and no version, because none answered');
  }

  // blocknative's estimates, in gwei, by the confidence the route labels them with
  fetch.expect(Eth.mainnetGasPriceEndpoint).returns(JSON.stringify({
    blockPrices: [ {
      estimatedPrices: [
        { confidence: 99, price: 40 },
        { confidence: 95, price: 30 },
        { confidence: 90, price: 25 },
        { confidence: 80, price: 20 },
      ],
    } ],
  }));
  const gasPrice = await get(env, '/legacy/mainnet/gas-price');
  t.equal(gasPrice.status, 200, 'a route that needs no registry is unaffected');
  t.same(await gasPrice.json(), {
    fastest:  { value: '40000000000' },
    fast:     { value: '30000000000' },
    average:  { value: '25000000000' },
    safe_low: { value: '20000000000' },
  }, 'and answers what it was given');

  /*
   * A path that names no market endpoint is the client's mistake whatever
   * the registry holds, so it is answered without reading the registry, and
   * so is a cursor of a form the history never hands out.
   */
  const mistyped = await get(env, `/market/${MAINNET}/${USDC}/sumary`);
  t.equal(mistyped.status, 400, 'a mistyped endpoint is a 400 even with nothing active');
  t.match(await mistyped.text(), /Not a valid market API endpoint/);

  const malformed = await get(env, `/account/${USDC}/transaction_history?cursor=..`);
  t.same([ malformed.status, await malformed.text() ], [ 400, 'Cursor is invalid' ],
    'and so is a cursor of another form than the history hands out');
});

/*
 * Transaction history is read from one range of logs covering a market and
 * the rewards contract its claims are emitted by, so a market that names no
 * rewards contract has no stream. Such a market must not be filterable: the
 * empty page it would answer with is indistinguishable from a market nobody
 * has used, which is the failure the registry is supposed to remove.
 */
t.test('a market no stream reads is not addressable in the history filter', async t => {
  const fixture: RegistrySnapshotV1 = loadRegistrySnapshotFixture();
  const snapshot: RegistrySnapshotV1 = {
    ...fixture,
    networks: fixture.networks.map(network => network.chainId !== 1 ? network : {
      ...network,
      markets: network.markets.map(market => market.deploymentKey !== 'weth' ? market : {
        ...market,
        contracts: { ...market.contracts, rewards: null },
      }),
    }),
  };

  const registry = await activeRegistryDatabase({ snapshot });
  t.teardown(() => registry.dispose());
  const env = envWith({ APP_DB: registry.db });

  const account = '0x420f253087044b8BCf028dd89F8fe83Ba6275E84';
  const weth    = '0xa17581a9e3356d9a858b789d68b4d866e593ae94';
  const refused = await get(env, `/account/${account}/transaction_history?markets[]=1_${weth}`);
  t.equal(refused.status, 400, 'the market is refused rather than answered with nothing');
  t.match(await refused.text(), /Invalid market address/);

  /*
   * The same market with its rewards contract intact is addressable; that
   * path reads logs, so it is exercised where a node provider is configured
   * rather than here.
   */
  const unknown = await get(env, `/account/${account}/transaction_history?markets[]=1_${UNKNOWN}`);
  t.equal(unknown.status, 400, 'as is an address the version does not describe at all');
});

/*
 * A cursor as the history names one, the hex SHA-256 of what it holds: here,
 * of what a test says the cursor is.
 */
function cursorId(about: string): string {
  return createHash('sha256').update(about).digest('hex');
}

/*
 * A cursor belongs to one version: its stream keys and block anchors describe
 * that version's markets. Reading a page against another version would mix
 * two descriptions of the same addresses, so the client is told to start over.
 */
t.test('a transaction history cursor from another version is refused', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());

  const cursor = cursorId('a cursor from another version');
  const seed   = {
    [cursor]: {
      registryVersionId: '00000000-0000-4000-8000-00000000dead',
      profilesByAddress: {},
      filter:  { markets: [], actions: [], initiatedBy: [], contractAddresses: [], networks: [] },
      streamEvents: [],
      cursors: {},
    },
  };

  const response = await get(
    envWith({ APP_DB: registry.db, kv_mainnet: MemoryKv({ seed }) }),
    `/account/0x420f253087044b8BCf028dd89F8fe83Ba6275E84/transaction_history?cursor=${cursor}`,
  );

  t.equal(response.status, 409);
  const error = await envelopeOf(t, response);
  t.equal(error.code, 'REGISTRY_VERSION_CHANGED', 'with the code that tells the client to restart pagination');
  t.same(error.details, {
    cursorRegistryVersionId: '00000000-0000-4000-8000-00000000dead',
    registryVersionId:       registry.versionId,
  }, 'naming the version the cursor held, and the version that is active now');
  t.equal(response.headers.get('x-registry-version'), registry.versionId);
});

/*
 * What a cursor holds are positions in the logs of the streams it reads, and
 * they stay true for as long as the version that answers reads the same
 * streams: a rollback, or a re-import of the same markets, must not end
 * every pagination in flight.
 */
t.test('a cursor from another version that reads the same streams carries on', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());

  const cursor = cursorId('a cursor from an identical version');
  const seed   = {
    [cursor]: {
      registryVersionId: '00000000-0000-4000-8000-0000000000aa',
      profilesByAddress: {},
      // a filter this request does not repeat, which is the first thing checked after the version
      filter:  { markets: [ `1_${USDC}` ], actions: [], initiatedBy: [], contractAddresses: [], networks: [] },
      streamEvents: streamEventsOf(fixtureCatalog(registry.snapshot)),
      cursors: {},
    },
  };

  const response = await get(
    envWith({ APP_DB: registry.db, kv_mainnet: MemoryKv({ seed }) }),
    `/account/0x420f253087044b8BCf028dd89F8fe83Ba6275E84/transaction_history?cursor=${cursor}`,
  );
  t.not(response.status, 409, 'the cursor is not refused for the version it was issued against');
  t.equal(response.status, 400, 'it is read, and refused only for the filter the request changed');
  t.match(await response.text(), /different markets filter/);
});

/*
 * A cursor issued before the registry names no version, and keeps its
 * positions by network rather than by stream. Whatever it reads, a version
 * ends it as it ends a cursor of another version, and the client starts
 * over. Nor is one that an earlier release upgraded compared on the networks
 * it had any more: it is a cursor of the version it was upgraded against.
 */
t.test('a cursor issued before the registry is ended, as one of another version is', async t => {
  const fixture: RegistrySnapshotV1 = loadRegistrySnapshotFixture();
  // a version that also serves history on Base, which a cursor of mainnet alone never read
  const snapshot: RegistrySnapshotV1 = {
    ...fixture,
    networks: fixture.networks.map(network => network.chainId !== 8453 ? network : {
      ...network,
      markets: network.markets.map(market => ({
        ...market,
        capabilities: { ...market.capabilities, transactionHistory: true },
      })),
    }),
  };
  const registry = await activeRegistryDatabase({ snapshot });
  t.teardown(() => registry.dispose());

  const streams = streamEventsOf(fixtureCatalog(registry.snapshot));
  t.same([ ...new Set(streams.map(stream => stream.network)) ].sort(), [ 'base-mainnet', MAINNET ],
    'the version reads history on two networks');
  const mainnet = streams.filter(stream => stream.network === MAINNET);

  // a page of every market as the history kept it before the registry: without a version, and by network
  const legacy = {
    profilesByAddress: {},
    filter:            { markets: [], actions: [], initiatedBy: [], contractAddresses: [], networks: [] },
    streamEvents:      streams,
    cursors:           Object.fromEntries(streams.map(stream => [
      stream.network,
      { ...stream, blockNumber: 19_000_000, transactionHash: '0xabc' },
    ])),
  };
  const payload = (overrides: Record<string, unknown>) => ({
    registryVersionId: '00000000-0000-4000-8000-0000000000bb',
    profilesByAddress: {},
    // a filter this request does not repeat, which is the first thing checked after the version
    filter:  { markets: [ `1_${USDC}` ], actions: [], initiatedBy: [], contractAddresses: [], networks: [] },
    streamEvents: mainnet,
    cursors: {},
    ...overrides,
  });
  const cursors = {
    legacy:        cursorId('a cursor issued before the registry'),
    upgraded:      cursorId('a cursor an earlier release upgraded'),
    ofTheRegistry: cursorId('a cursor of a version without Base'),
    changed:       cursorId('a cursor upgraded, of other streams'),
  };
  const seed = {
    [cursors.legacy]:        legacy,
    [cursors.upgraded]:      payload({ upgraded: true }),
    [cursors.ofTheRegistry]: payload({}),
    [cursors.changed]:       payload({
      upgraded:     true,
      streamEvents: mainnet.map(stream => ({ ...stream, marketContractAddresses: stream.marketContractAddresses.slice(1) })),
    }),
  };
  const env  = envWith({ APP_DB: registry.db, kv_mainnet: MemoryKv({ seed }) });
  const page = (cursor: string) => get(env, `/account/0x420f253087044b8BCf028dd89F8fe83Ba6275E84/transaction_history?cursor=${cursor}`);

  const ended = await page(cursors.legacy);
  t.equal(ended.status, 409, 'a cursor issued before the registry is ended, though it reads the streams the version reads');
  const error = await envelopeOf(t, ended);
  t.equal(error.code, 'REGISTRY_VERSION_CHANGED', 'with the code that tells the client to restart pagination');
  t.same(error.details, {
    cursorRegistryVersionId: null,
    registryVersionId:       registry.versionId,
  }, 'naming no version for the cursor, and the version that is active now');

  t.equal((await page(cursors.upgraded)).status, 409,
    'one an earlier release upgraded is ended by a version that reads a stream it does not');
  t.equal((await page(cursors.ofTheRegistry)).status, 409, 'as a cursor the registry issued for a version without Base is');
  t.equal((await page(cursors.changed)).status, 409, 'and as one that reads other streams on its networks is');
});

/*
 * The history names a cursor by the hex SHA-256 of what it holds, and hands
 * out no other. A value of any other form is no cursor: it is invalid as one
 * KV does not hold is, and KV is not asked for it, since workerd refuses some
 * such keys outright — '', '.' and '..' — and the request would fail with
 * that instead.
 */
t.test('a cursor of another form than the history hands out is invalid, without asking KV', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());

  // KV as workerd has it, refusing a key it cannot take, and the keys it was asked for
  const asked: unknown[] = [];
  const kv = refusingKv(MemoryKv({}), (_method, [ key ]) => {
    asked.push(key);
    return key === '' ? 'Key name cannot be empty.'
      : key === '.' || key === '..' ? `"${key}" is not allowed as a key name.`
      : false;
  });
  const env  = envWith({ APP_DB: registry.db, kv_mainnet: kv });
  const page = (cursor: string) => get(env,
    `/account/0x420f253087044b8BCf028dd89F8fe83Ba6275E84/transaction_history?cursor=${encodeURIComponent(cursor)}`);

  const issued = cursorId('a cursor nobody was given');
  for (const [ cursor, what ] of [
    [ '', 'an empty cursor' ],
    [ '.', '"."' ],
    [ '..', '".."' ],
    [ 'f'.repeat(513), 'a cursor longer than KV takes' ],
    [ issued.toUpperCase(), 'one in upper case' ],
    [ issued.slice(1), 'one a digit short' ],
    [ `${issued}0`, 'one a digit long' ],
    [ 'cursor-of-another-form', 'and a name' ],
  ] as const) {
    const response = await page(cursor);
    t.same([ response.status, await response.text() ], [ 400, 'Cursor is invalid' ], `${what} is invalid`);
  }
  t.same(asked, [], 'and KV was asked for none of them');

  const unknown = await page(issued);
  t.same([ unknown.status, await unknown.text() ], [ 400, 'Cursor is invalid' ],
    'while a cursor of the form the history hands out is invalid when KV does not hold it');
  t.same(asked, [ issued ], 'which KV was asked for');
});

/*
 * Cursors are kept in the namespace history is cached in, but nothing
 * computes one again. A computed value KV cannot read is a miss; a cursor KV
 * cannot read is a failure the client may retry, not a cursor never issued.
 */
t.test('a cursor KV cannot read fails the request, and is not called invalid', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const errors = captureErrors(t);

  const response = await get(
    envWith({ APP_DB: registry.db, kv_mainnet: refusingKv(MemoryKv({}), method => method === 'get') }),
    `/account/0x420f253087044b8BCf028dd89F8fe83Ba6275E84/transaction_history?cursor=${'ab'.repeat(32)}`,
  );

  t.equal(response.status, 500);
  t.equal((await envelopeOf(t, response)).code, 'INTERNAL');
  t.match(errors.join('\n'), /KV GET failed: 503 Service Unavailable/, 'and the log has what KV answered');
});

/*
 * A node on which an account has no history: no logs, and no DeFi Saver
 * proxy (getAllProxies answers the zero address and no other).
 */
function noHistory(call: Call): object {
  switch (call.method) {
    case 'eth_getBlockByNumber': return { result: { number: '0x1c9c380', timestamp: '0x6a8e5f00', transactions: [] } };
    case 'eth_getLogs':          return { result: [] };
    default:                     return { result: defaultAbiCoder.encode([ 'address', 'address[]' ], [ Eth.NullAddress, [] ]) };
  }
}

/*
 * A cursor's id is the digest of what it holds, and names no account: the
 * same page asked twice, or the first pages of two accounts without history
 * at one block, keep one cursor. KV takes one write a second to a key, and
 * the write it refuses with 429 is of the cursor it took a moment before.
 */
t.test('a page whose cursor KV has just kept is answered, though KV refuses to write it again', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const warnings = captureWarnings(t);

  // these pages are asked within a second, so KV takes one write of a key
  const kv      = MemoryKv({});
  const written = new Set<unknown>();
  const env     = envWith({ APP_DB: registry.db, kv_mainnet: refusingKv(kv, (method, [ key ]) => {
    if (method !== 'put') {
      return false;
    }
    const again = written.has(key);
    written.add(key);
    return again;
  }) });

  const account = '0x420f253087044b8BCf028dd89F8fe83Ba6275E84';
  const another = '0x2000000000000000000000000000000000000002';
  const cursors: string[] = [];
  for (const asking of [ account, account, another ]) {
    const { response } = await answering(noHistory, () => get(env, `/account/${asking}/transaction_history`));
    t.equal(response.status, 200, `a first page of ${asking} is answered`);
    cursors.push((await response.json() as { cursor: string }).cursor);
  }
  const [ cursor ] = cursors;
  t.same(cursors, [ cursor, cursor, cursor ], 'with the one cursor every page of them is at');
  t.ok(await kv.get(cursor!), 'which KV keeps');
  t.same(warnings, [ 1, 2 ].map(() => `history cursor written twice in a second: KV PUT failed: 429 Too Many Requests: ${cursor}`),
    'and the log says each time KV refused to write it again');
});

/*
 * While KV does not answer, no cursor can be kept or read, and every page of
 * history fails. A first page fails only after it has been read in full from
 * the chain, as every route is read while its cache is refused: its cursor is
 * written last.
 */
t.test('a page whose cursor KV cannot keep fails, rather than hand out one no page can read', async t => {
  const registry = await activeRegistryDatabase();
  t.teardown(() => registry.dispose());
  const errors   = captureErrors(t);
  const warnings = captureWarnings(t);

  // KV not answering refuses a write as it refuses a read, with 503
  const env = envWith({ APP_DB: registry.db, kv_mainnet: refusingKv(MemoryKv({}), method => (
    method === 'put' ? 'KV PUT failed: 503 Service Unavailable' : true
  )) });

  const { response } = await answering(noHistory, () => get(env, '/account/0x420f253087044b8BCf028dd89F8fe83Ba6275E84/transaction_history'));
  t.equal(response.status, 500);
  t.equal((await envelopeOf(t, response)).code, 'INTERNAL');
  t.match(errors.join('\n'), /KV PUT failed: 503 Service Unavailable/, 'and the log has what KV answered');
  t.match(warnings.join('\n'), /computation cache unreadable/, 'once the page was read without the cache');
});
