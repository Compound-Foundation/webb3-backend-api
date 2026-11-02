import t from 'tap';
import * as Fallible from '../../lib/fallible/fallible.js';

/* tests are running in node.js, so we need to shim in the 'self' object
 * that workers scripts depend upon.
 */
import '../../shim/node-self.js';

import * as JsonRpc from '../../lib/json-rpc/json-rpc.js';
let jsonRpc = JsonRpc;

import * as mock from '../util/mock/mock.js';
declare var fetch: mock.Fetch;

// before each test, replace the global fetch object with a fresh mock.
t.beforeEach(() => {
  globalThis.fetch = mock.fetch({});
  jsonRpc = JsonRpc.configure({ fetch: globalThis.fetch });
});
// after each test, assert that all expected fetch() calls were made.
t.afterEach((t) => fetch.satisfy(t));

t.test('simple example RPC: mock_checkHealth (unwrapped single-item batch)', async t => {
  // configure the test endpoint and the mock_checkHealth call
  const endpoint = 'https://test.local/rpc';
  const call: JsonRpc.Call = { method: 'mock_checkHealth', params: [] };
  // we expect a single mock_checkHealth request with 'call' for its body
  const expectedRequests: JsonRpc.Request[] = [
    { jsonrpc: '2.0', id: 0, ...call },
  ];
  // we expect a single mock_checkHealth call response of id=0 result='ok'
  const expectedResponses: JsonRpc.Response[] = [
    { jsonrpc: '2.0', id: 0, result: 'ok' },
  ];
  // mock fetch postBatch({...})
  fetch.expect(endpoint, {
      method: 'POST', // request.method MUST be 'POST'
      body: {         // request.body MUST match expected jsonRpc.Requests
        type: 'json',
        value: expectedRequests,
      },
    })
    .returns(JSON.stringify(expectedResponses));
  // mock fetch post({...})
  fetch.expect(endpoint, {
      method: 'POST', // request.method MUST be 'POST'
      body: {         // request.body MUST match expected jsonRpc.Requests
        type: 'json',
        value: expectedRequests[0],
      },
    })
    .returns(JSON.stringify(expectedResponses[0]));
  // perform the postBatch
  const responses = await jsonRpc.postBatch({ endpoint, calls: [ call ] });
  // check that responses are exactly as expected
  t.strictSame(responses, expectedResponses, `responds id=0 result='ok'`);
  // property: jsonRpc.post equals jsonRpc.postBatch of single-item batch
  t.strictSame(
    responses[0],
    await jsonRpc.post({ endpoint, call }),
    `jsonRpc.post is equivalent to jsonRpc.postBatch of single-item batch`
  );
});

t.test('postBatch responses may be out of order', async t => {
  // configure the test endpoint and the made-up calls
  const endpoint = 'https://test.local/rpc';
  const calls: JsonRpc.Call[] = [
    { method: `mock_42`,    params: [] },
    { method: `mock_100`,   params: [] },
    { method: `mock_hello`, params: [] },
    { method: `mock_true`,  params: [] },
  ];
  // configure expected requests
  const expectedRequests: JsonRpc.Request[] = calls.map((call, id) => {
    return { jsonrpc: '2.0', id, ...call };
  });
  // configure expected responses
  const expectedResponses: JsonRpc.Response[] = [
    { jsonrpc: '2.0', id: 0, result:      42 },
    { jsonrpc: '2.0', id: 1, result:     100 },
    { jsonrpc: '2.0', id: 2, result: 'hello' },
    { jsonrpc: '2.0', id: 3, result:    true },
  ];
  // mock fetch
  fetch.expect(endpoint, {
      method: 'POST', // request.method MUST be 'POST'
      body: {         // request.body MUST match expected jsonRpc.Requests
        type: 'json',
        value: expectedRequests,
      },
    })
    // return expected responses out of order
    .returns(JSON.stringify([
      expectedResponses[1],
      expectedResponses[0],
      expectedResponses[3],
      expectedResponses[2],
    ]));
  // perform the postBatch
  const responses = Fallible.must(await jsonRpc.postBatch({ endpoint, calls }));
  // check that responses are put back in the order of their calls, so a
  // caller can read them by index
  t.strictSame(responses, expectedResponses);
});

t.test('a revert is told apart from a node that could not serve the call', async t => {
  const reverts: JsonRpc.Error[] = [
    { code: 3,      message: 'execution reverted', data: '0x' },
    { code: -32000, message: 'execution reverted' },
    { code: -32000, message: 'Execution reverted: BadPrice' },
    { code: -32015, message: 'VM execution error.', data: 'revert' },
  ];
  for (const error of reverts) {
    t.ok(jsonRpc.isExecutionReverted(error), JSON.stringify(error));
  }
  const failures: JsonRpc.Error[] = [
    { code: -32000, message: 'header not found' },
    { code: -32000, message: 'upstream error' },
    { code: -32015, message: 'VM execution error.', data: 'out of gas' },
    { code: 429,    message: 'rate limited' },
  ];
  for (const error of failures) {
    t.notOk(jsonRpc.isExecutionReverted(error), JSON.stringify(error));
  }
});

/*
 * fetch gives a response the URL it was fetched from; the mock does not, so a
 * node's answer is given it here.
 */
function answerFrom(request: Request, ...response: ConstructorParameters<typeof Response>): Response {
  return Object.defineProperty(new Response(...response), 'url', { value: request.url });
}

function captureConsole(t: { teardown: (fn: () => void) => void }): string[] {
  const lines: string[] = [];
  for (const level of [ 'log', 'warn', 'error' ] as const) {
    const write = console[level];
    console[level] = (...parameters: unknown[]) => { lines.push(parameters.map(String).join(' ')); };
    t.teardown(() => { console[level] = write; });
  }
  return lines;
}

/*
 * The node proxy answers a request it could not serve with a status and a
 * line of text. The failure says which status, and carries where it came from
 * only as far as a log may show it: the proxy's key is a segment of the URL.
 * The library writes nothing itself, so the caller's logger decides where the
 * failure goes, whatever DEBUG says.
 *
 * It is a request the node did not serve, with how long the proxy asked to
 * wait before the next one, so a route can pass that on.
 */
t.test('a request the node fails is told by its status, without its key or its answer', async t => {
  const written  = captureConsole(t);
  const endpoint = 'https://node-provider.test.local/ethereum-mainnet/node-proxy-key';
  const call: JsonRpc.Call = { method: 'eth_blockNumber', params: [] };
  for (const [ status, text, headers, retryAfter ] of [
    [ 503, 'upstream error',     { 'Retry-After': '5' }, 5    ],
    [ 401, 'key not authorized', {},                     null ],
  ] as const) {
    fetch.expect(endpoint, { method: 'POST' }).returns(request => answerFrom(request, text, { status, headers }));
    const failure = await jsonRpc.postBatch({ endpoint, calls: [ call ] }).then(() => null, (error: Error) => error);
    t.equal(failure?.message, `JSON-RPC request failed: HTTP ${status}`);
    t.ok(JsonRpc.isNotServed(failure), 'as a request the node did not serve');
    t.same(
      [ (failure as JsonRpc.NotServed).status, (failure as JsonRpc.NotServed).retryAfter ],
      [ status, retryAfter ],
      'with the status it answered, and the seconds it asked to wait, if it said',
    );
    t.strictSame(failure?.cause, {
      url:        'https://node-provider.test.local/ethereum-mainnet/…',
      status,
      statusText: '',
    }, 'the failure carries the origin, the network and the status');
  }
  // a single call reads its answer the same way
  fetch.expect(endpoint, { method: 'POST' }).returns(request => answerFrom(request, 'upstream error', { status: 503 }));
  await t.rejects(jsonRpc.post({ endpoint, call }), { message: 'JSON-RPC request failed: HTTP 503' });
  t.strictSame(written, [], 'and nothing is written to the console');
});

t.test('an answer that is not JSON fails without its body', async t => {
  const written  = captureConsole(t);
  const endpoint = 'https://node-provider.test.local/ethereum-mainnet/node-proxy-key';
  fetch.expect(endpoint, { method: 'POST' })
    .returns(request => answerFrom(request, '<html>an error page</html>', { status: 200 }));
  const failure = await jsonRpc.post({ endpoint, call: { method: 'eth_blockNumber', params: [] } })
    .then(() => null, (error: Error) => error);
  t.equal(failure?.message, 'Invalid JSON-RPC response: not JSON');
  t.notOk(JsonRpc.isNotServed(failure), 'an answer that cannot be read, not a request the node did not serve');
  t.strictSame(failure?.cause, {
    url:        'https://node-provider.test.local/ethereum-mainnet/…',
    status:     200,
    statusText: '',
  });
  t.strictSame(written, [], 'and nothing is written to the console');
});

/*
 * A node that could not be reached did not serve the request either. The
 * failure says how the fetch failed, and has what failed as its cause.
 */
t.test('a fetch that fails is a request the node did not serve', async t => {
  const endpoint = 'https://node-provider.test.local/ethereum-mainnet/node-proxy-key';
  const call: JsonRpc.Call = { method: 'eth_blockNumber', params: [] };
  const refused     = new TypeError('fetch failed');
  const unreachable = JsonRpc.configure({ fetch: async () => { throw refused; } });
  for (const [ send, what ] of [
    [ () => unreachable.postBatch({ endpoint, calls: [ call ] }), 'a batch' ],
    [ () => unreachable.post({ endpoint, call }),                 'a single call' ],
  ] as const) {
    const failure = await send().then(() => null, (error: Error) => error);
    t.ok(JsonRpc.isNotServed(failure), `${what} the node did not serve`);
    t.equal(failure?.message, 'JSON-RPC request failed: fetch failed', 'saying how the fetch failed');
    t.equal(failure?.cause, refused, 'with what failed as its cause');
    t.same([ (failure as JsonRpc.NotServed).status, (failure as JsonRpc.NotServed).retryAfter ], [ null, null ],
      'and no status or wait, since nothing answered');
  }
});

/*
 * The Worker's limit on the subrequests of one invocation fails a fetch too,
 * but the node was never asked. That is the caller's excess, and it stays the
 * error it is, which a route answers as its own fault.
 */
t.test('a fetch past the subrequest limit is not a node that failed', async t => {
  const endpoint = 'https://node-provider.test.local/ethereum-mainnet/node-proxy-key';
  const call: JsonRpc.Call = { method: 'eth_blockNumber', params: [] };
  const exceeded = new Error('Too many subrequests.');
  const spent    = JsonRpc.configure({ fetch: async () => { throw exceeded; } });
  for (const [ send, what ] of [
    [ () => spent.postBatch({ endpoint, calls: [ call ] }), 'a batch' ],
    [ () => spent.post({ endpoint, call }),                 'a single call' ],
  ] as const) {
    const failure = await send().then(() => null, (error: Error) => error);
    t.equal(failure, exceeded, `${what} fails with the limit itself`);
    t.notOk(JsonRpc.isNotServed(failure), 'not as a request the node did not serve');
  }
});

/*
 * An answer that breaks off after its headers — the connection lost while
 * the body was read — was not served either, whatever status it began with.
 * One that began with an error status keeps it, and the wait it asked for.
 */
t.test('an answer that breaks off is a request the node did not serve', async t => {
  const endpoint = 'https://node-provider.test.local/ethereum-mainnet/node-proxy-key';
  const call: JsonRpc.Call = { method: 'eth_blockNumber', params: [] };
  const lost = new TypeError('terminated');
  for (const [ status, headers, began ] of [
    [ 200, {},                     [ null, null ] ],
    [ 503, { 'Retry-After': '5' }, [ 503,  5    ] ],
  ] as const) {
    const cut = JsonRpc.configure({
      fetch: async () => new Response(new ReadableStream({ pull(controller) { controller.error(lost); } }), { status, headers }),
    });
    for (const [ send, what ] of [
      [ () => cut.postBatch({ endpoint, calls: [ call ] }), 'a batch' ],
      [ () => cut.post({ endpoint, call }),                 'a single call' ],
    ] as const) {
      const failure = await send().then(() => null, (error: Error) => error);
      t.ok(JsonRpc.isNotServed(failure), `${what} answered ${status} and cut off`);
      t.equal(failure?.message, 'JSON-RPC request failed: terminated', 'saying how the answer failed');
      t.equal(failure?.cause, lost, 'with what failed as its cause');
      t.same([ (failure as JsonRpc.NotServed).status, (failure as JsonRpc.NotServed).retryAfter ], began,
        'and the status and wait it began with, when the status was an error');
    }
  }
});

/*
 * An error status is the node's answer only with a JSON-RPC body. JSON of
 * another kind — an error object of the server's own, or one JSON-RPC error
 * for a whole batch — answers none of the calls, so the request was not
 * served. With a status that is not an error, the same body is an answer
 * that could not be used.
 */
t.test('an error status with JSON that answers no call is a request the node did not serve', async t => {
  const endpoint = 'https://node-provider.test.local/ethereum-mainnet/node-proxy-key';
  const call: JsonRpc.Call = { method: 'eth_blockNumber', params: [] };
  const ownError   = { error: 'upstream error' };
  const batchError = { jsonrpc: '2.0', id: null, error: { code: -32005, message: 'request rate exceeded' } };
  for (const [ status, body, headers, began ] of [
    [ 503, ownError,   { 'Retry-After': '5' }, [ 503, 5    ] ],
    [ 429, batchError, {},                     [ 429, null ] ],
  ] as const) {
    fetch.expect(endpoint, { method: 'POST' }).returns(JSON.stringify(body), { status, headers });
    const failure = await jsonRpc.postBatch({ endpoint, calls: [ call ] }).then(() => null, (error: Error) => error);
    t.ok(JsonRpc.isNotServed(failure), `${status} with ${JSON.stringify(body)}`);
    t.equal(failure?.message, `JSON-RPC request failed: HTTP ${status}`, 'told by its status, as an answer that is not JSON is');
    t.same([ (failure as JsonRpc.NotServed).status, (failure as JsonRpc.NotServed).retryAfter ], began);
    t.match((failure?.cause as Error | undefined)?.message, /^Invalid JSON-RPC response/, 'with why it answers nothing as its cause');
  }
  // a single call reads its answer the same way
  fetch.expect(endpoint, { method: 'POST' }).returns(JSON.stringify(ownError), { status: 503 });
  const single = await jsonRpc.post({ endpoint, call }).then(() => null, (error: Error) => error);
  t.ok(JsonRpc.isNotServed(single), 'a single call');
  t.equal(single?.message, 'JSON-RPC request failed: HTTP 503');

  fetch.expect(endpoint, { method: 'POST' }).returns(JSON.stringify(ownError), { status: 200 });
  const unusable = await jsonRpc.postBatch({ endpoint, calls: [ call ] }).then(() => null, (error: Error) => error);
  t.notOk(JsonRpc.isNotServed(unusable), 'while the same body with a 200 is an answer that cannot be used');
  t.match(unusable?.message, /^Invalid JSON-RPC response/);
});

/*
 * A JSON-RPC error can come with an error status. It is still the node's
 * answer to the call, which the node provider proxy retries or masks call by
 * call; failing the request for it would fail every other call with it.
 */
t.test('a JSON-RPC error answered with an error status is the answer', async t => {
  const endpoint = 'https://test.local/rpc';
  const calls: JsonRpc.Call[] = [ { method: 'eth_blockNumber', params: [] }, { method: 'eth_chainId', params: [] } ];
  const rateLimited = { code: 429, message: 'Your app has exceeded its compute units per second capacity.' };
  const answers: JsonRpc.Response[] = [
    { jsonrpc: '2.0', id: 0, result: '0x10' },
    { jsonrpc: '2.0', id: 1, error: rateLimited },
  ];
  fetch.expect(endpoint, { method: 'POST' }).returns(JSON.stringify(answers), { status: 429 });
  t.strictSame(Fallible.must(await jsonRpc.postBatch({ endpoint, calls })), answers, 'answered, not a request it did not serve');
});

/*
 * A provider's URL has its key where the node proxy has the network, or in
 * its query: QuickNode leads its path with the token, Alchemy and Infura
 * follow a version with the key, and Goldsky passes it as a parameter.
 */
t.test('a provider URL is told by its origin alone', async t => {
  const urls = [
    [ 'https://endpoint-name.quiknode.pro/0123456789abcdef0123456789abcdef01234567/', 'https://endpoint-name.quiknode.pro' ],
    [ 'https://eth-mainnet.g.alchemy.com/v2/alchemy-key',                            'https://eth-mainnet.g.alchemy.com'  ],
    [ 'https://mainnet.infura.io/v3/infura-key',                                     'https://mainnet.infura.io'          ],
    [ 'https://edge.goldsky.com/standard/evm/1?secret=goldsky-key',                  'https://edge.goldsky.com'           ],
  ] as const;
  for (const [ endpoint, origin ] of urls) {
    fetch.expect(endpoint, { method: 'POST' }).returns(request => answerFrom(request, 'bad gateway', { status: 502 }));
    const failure = await jsonRpc.post({ endpoint, call: { method: 'eth_blockNumber', params: [] } })
      .then(() => null, (error: Error) => error);
    t.equal((failure?.cause as { url?: string } | undefined)?.url, origin, endpoint);
  }
});
