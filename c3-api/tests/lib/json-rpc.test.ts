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
  // check that responses are ordered and parsed exactly as expected
  for (const expected of expectedResponses) {
    const response = responses.find(({ id }) => id === expected.id);
    t.strictSame(response, expected);
  }
});
