import * as Fallible from 'fallible';

import type * as Json from './deps-hacks/json-types.js';

interface FallibleFetch<Failure> {
  (...args: Parameters<typeof self.fetch>): (
    Promise<Fallible.Outcome.OrJust<Response, Failure>>
  )
}

type BuiltinFetch = typeof self.fetch;
type FetchImplementation<FetchFailure = any> = (
  | BuiltinFetch
  | FallibleFetch<FetchFailure>
);

type _Module = typeof import('./json-rpc.js');
interface JsonRpcModule<FetchFailure> extends _Module {
  post     (..._: Parameters      <typeof post>): Promise<Fallible.Outcome.OrJust<JsonRpcResponse,   FetchFailure>>;
  postBatch(..._: Parameters <typeof postBatch>): Promise<Fallible.Outcome.OrJust<JsonRpcResponse[], FetchFailure>>;
}

/*
 * module instantiation with custom default fetch implementation, custom
 * default headers (to be added to the required JSON content headers).
 */
function configure<FetchFailure>({
  fetch:   defaultFetch   = globalThis.fetch,
  headers: defaultHeaders = {},
}: {
  fetch?:   FetchImplementation<FetchFailure>,
  headers?: { [name: string]: string },
})
  : JsonRpcModule<FetchFailure>
{
  return {
    configure,
    formatError,
    expectBatch,
    expectRequest,
    expectResponse,
    expectJsonBody,
    expectJsonIsRequestBody,
    expectJsonIsResponseBody,
    // JSON-RPC methods
    post({ call, endpoint, fetch = defaultFetch, headers = defaultHeaders }) {
      return post({ call, endpoint, fetch, headers });
    },
    postBatch({ calls, endpoint, fetch = defaultFetch, headers = defaultHeaders }) {
      return postBatch({ calls, endpoint, fetch, headers });
    },
    // Request preparation methods
    preparePost({ call, endpoint, headers = defaultHeaders }) {
      return preparePost({ call, endpoint, headers });
    },
    preparePostBatch({ calls, endpoint, headers = defaultHeaders }) {
      return preparePostBatch({ calls, endpoint, headers });
    },
  };
}

/*
 * every JSON-RPC request and response has the same header, which declares
 * the version of the JSON-RPC protocol and the id number of the request
 * (in case of batching).
 */
type JsonRpcHeader = {
  jsonrpc: '2.0',
  id:      number | string,
};

/*
 * a JSON-RPC call invokes a method by name with an array of arguments.
 */
type Call = {
  method: string,
  params: any[],
  id?:    string | number;
};

// TODO(jordan): support checking well-known error codes?
// https://www.jsonrpc.org/specification#error_object
/*
 * a JSON-RPC error is identified by a code. It MUST include a string
 * message, and it MAY include arbitrary additional data.
 */
type JsonRpcError<Data = unknown> = {
  code:    number,
  message: string,
  data?:   Data,
};

/*
 * a request is just a header and a single call.
 */
type JsonRpcRequest = (JsonRpcHeader & Call);

/*
 * a response is a header matching a request, with exactly one of 'result'
 * or 'error' as the remaining field.
 */
type JsonRpcResponse<Result = Json.Value> = JsonRpcHeader & {
  result?: Result,
  error?:  JsonRpcError<any>,
};

/*
 * JSON-RPC requests must specify 'application/json' for their
 * Content-Type and for their Accept headers, so that the server knows how
 * to parse the request and knows to respond in JSON.
 */
const jsonContentHeaders = {
  'Accept':       'application/json',
  'Content-Type': 'application/json',
};

/*
 * postBatch sends a batch of JSON-RPC calls to an endpoint via HTTP POST.
 *
 * The resulting array of `JsonRpcResponse`s is ordered by the index of
 * the corresponding call from the source batch.
 *
 * The Promise rejects if the batch response is not an array of valid
 * JSON-RPC response objects, or not enough responses are returned.
 */
async function postBatch({ calls, fetch = globalThis.fetch, ...rpcParameters }: {
  calls:    Call[] | JsonRpcRequest[],
  endpoint: string,
  fetch?:   FetchImplementation,
  headers?: { [key: string]: string },
})
  : Promise<Fallible.Outcome.OrJust<JsonRpcResponse[]>>
{
  const payloads: JsonRpcRequest[] = prepareCalls(calls);
  const outcome = await fetch(preparePostBatch({
    calls: payloads,
    ...rpcParameters,
  }));
  if (Fallible.isFailure(outcome)) {
    return outcome;
  }
  return expectBatch(payloads, Fallible.unwrap(outcome));
}

/*
 * post sends a single JSON-RPC call to an endpoint via HTTP POST.
 *
 * The call's id will default to 0 if one is not provided.
 *
 * The Promise rejects if the JSON-RPC response object is not valid.
 */
async function post({ fetch = globalThis.fetch, ...rpcParameters }: {
  call:     Call | JsonRpcRequest,
  endpoint: string,
  fetch?:   FetchImplementation,
  headers?: { [key: string]: string },
})
  : Promise<Fallible.Outcome.OrJust<JsonRpcResponse>>
{
  const request  = preparePost(rpcParameters);
  const outcome  = await fetch(request);
  if (Fallible.isFailure(outcome)) {
    return outcome;
  }
  const response = await expectResponse(Fallible.unwrap(outcome));
  if (response instanceof Array) {
    throw new Error(`invariant violated! single POST returned batch ?!`);
  }
  return response;
}

/*
 * preparePostBatch creates a JSON-RPC batch POST Request to an endpoint.
 *
 * Useful in test to construct Requests to pass into a handler.
 */
function preparePostBatch({ endpoint, calls, headers = {} }: {
  calls:    Call[] | JsonRpcRequest[],
  endpoint: string,
  headers?: { [key: string]: string },
})
  : Request
{
  return new Request(endpoint, {
    method: 'POST',
    body: JSON.stringify(prepareCalls(calls)),
    headers: { ...jsonContentHeaders, ...headers },
  });
}

/*
 * preparePost creates a JSON-RPC unit POST Request to an endpoint.
 *
 * Useful in test to construct Requests to pass into a handler.
 */
function preparePost({ endpoint, call, headers = {} }: {
  call:     Call | JsonRpcRequest,
  endpoint: string,
  headers?: { [key: string]: string },
})
  : Request
{
  return new Request(endpoint, {
    method: 'POST',
    body: JSON.stringify({ id: 0, jsonrpc: '2.0', ...call }),
    headers: { ...jsonContentHeaders, ...headers },
  });
}

/*
 * prepareCalls normalizes Call and JsonRpcRequest objects into an array
 * of JsonRpcRequest, asserting that they must have unique `id's.
 */
function prepareCalls(calls: Call[] | JsonRpcRequest[]): JsonRpcRequest[] {
  const raw = calls.map((call, index): JsonRpcRequest => ({
    jsonrpc: '2.0',
    id:      index,
    ...call
  }));
  // assert every id unique, the JSON-RPC spec does not handle id re-use
  let bad = raw.find(({ id }, offset) => {
    for (let i = offset + 1; i < raw.length; i++) {
      if (raw[i].id === id) {
        return id; // bail on the first non-unique id
      }
    }
  });
  if (bad != null) {
    throw new Error(`id=${bad.id} is not unique, behavior undefined`);
  }
  return raw;
}

/*
 * assert that a given HTTP Response object is a JSON-RPC Batch Response.
 *
 * TODO(jordan): convert to Fallible
 */
async function expectBatch(
  batch:        JsonRpcRequest[],
  httpResponse: Response,
)
  : Promise<JsonRpcResponse[]>
{
  // expect the httpResponse body to be valid JSON
  const responses = await expectJsonBody(httpResponse);
  // bail if the parsed JSON of the HTTP response is not an array
  if (!(responses instanceof Array)) {
    throw InvalidResponse(`Invalid JSON-RPC batch response: not an array`, responses);
  }
  // bail if any item from the batch is missing a response
  if (!(responses.length === batch.length)) {
    throw new Error(
      `Invalid JSON-RPC batch response:`
      + ` only ${responses.length} responses out of ${batch.length} calls`
    );
  }
  // Check that every response is a valid JSON-RPC Response object
  // https://www.jsonrpc.org/specification#response_object
  responses.forEach(response => {
    // validate the response json is a valid JSON-RPC Response object
    expectJsonIsResponseBody(response);
    // given that the response is valid, it MUST be in the batch
    let prefix = `Invalid JSON-RPC response`;
    if (!(batch.find(({ id }) => id === response.id))) {
      throw new Error(`${prefix}: id=${response.id} not in source batch`);
    }
  });
  return responses;
}

/*
 * assert that a given HTTP Request object contains JSON-RPC requests.
 *
 * it may contain one request as the body, or an array of requests in the
 * case of a batch JSON-RPC.
 *
 * expectRequest will normalize the resulting JSON-RPC request body into
 * an array.
 */
async function expectRequest(httpRequest: Request)
  : Promise<JsonRpcRequest | JsonRpcRequest[]>
{
  const requestBody = await expectJsonBody(httpRequest);
  if (requestBody instanceof Array) {
    return prepareCalls(requestBody.map(it => expectJsonIsRequestBody(it)));
  } else {
    return expectJsonIsRequestBody(requestBody);
  }
}

/*
 * assert that a given HTTP Response object is a JSON-RPC Response.
 *
 * TODO(jordan): convert to Fallible
 */
async function expectResponse(httpResponse: Response)
  : Promise<JsonRpcResponse | JsonRpcResponse[]>
{
  const responseBody = await expectJsonBody(httpResponse);
  if (responseBody instanceof Array) {
    return responseBody.map(it => expectJsonIsResponseBody(it));
  } else {
    return expectJsonIsResponseBody(responseBody);
  }
}

/*
 * assert that a given JSON object is a valid JSON-RPC Request object.
 *
 * TODO(jordan): convert to Fallible
 */
function expectJsonIsRequestBody(requestBody: object)
  : JsonRpcRequest
{
  let prefix = `Invalid JSON-RPC request`;
  // response MUST be a non-null object
  if (!(typeof(requestBody) === 'object' && requestBody !== null)) {
    throw new Error(`${prefix}: request body is not a non-null object`);
  }
  // jsonrpc is REQUIRED
  if (!('jsonrpc' in requestBody)) {
    throw new Error(`${prefix}: missing jsonrpc version`);
  }
  // jsonrpc MUST be '2.0'
  if (requestBody.jsonrpc !== '2.0') {
    const version = requestBody.jsonrpc;
    throw new Error(`${prefix}: jsonrpc version ${version} != 2.0`);
  }
  // id is REQUIRED  [ string, number, null ]
  if (!('id' in requestBody)) {
    throw new Error(`${prefix}: missing id`);
  }
  // NOTE(jordan): now that we know id exists, add it to the prefix
  prefix += ` with id=${requestBody.id}`;
  // method is REQUIRED
  if (!('method' in requestBody)) {
    throw new Error(`${prefix}: request has no method`);
  }
  // method MUST be a string
  if (!(typeof(requestBody.method) === 'string')) {
    throw new Error(`${prefix}: request method is not a valid string`);
  }
  // params MAY BE omitted
  if ('params' in requestBody) {
    // params if provided MUST be an array
    /* NOTE that strictly speaking, spec allows by-position AND by-name
     * params, where by-position is Array and by-name is a generic record.
     * However, the overwhelming preference seems to be by-position.
     */
    if (!(true
      && (typeof(requestBody.params) === 'object')
      && requestBody.params !== null
      && requestBody.params instanceof Array
    )) {
      throw new Error(`${prefix}: request params is not an array`);
    }
  }
  return requestBody as JsonRpcRequest;
}

/*
 * assert that a given JSON object is a valid JSON-RPC Response object.
 *
 * TODO(jordan): convert to Fallible
 */
function expectJsonIsResponseBody(body: object)
  : JsonRpcResponse
{
  // response MUST be a non-null object
  if (!(typeof(body) === 'object' && body !== null)) {
    throw InvalidResponse(`response body is not a non-null object`, body);
  }
  // jsonrpc is REQUIRED
  if (!('jsonrpc' in body)) {
    throw InvalidResponse(`missing jsonrpc version`, body);
  }
  // jsonrpc MUST be '2.0'
  if (body.jsonrpc !== '2.0') {
    const version = body.jsonrpc;
    throw InvalidResponse(`jsonrpc version ${version} != 2.0`, body);
  }
  // id is REQUIRED
  if (!('id' in body)) {
    throw InvalidResponse(`missing id`, body);
  }
  // NOTE(jordan): now that we know id exists, add it to the prefix
  let id = `id=${body.id}`;
  // either the result member or error member MUST be included...
  if (!(('result' in body) || ('error' in body))) {
    throw InvalidResponse(`[${id}] response has no result or error`, body);
  }
  // ... but both members MUST NOT be included
  if (('result' in body) && ('error' in body)) {
    throw InvalidResponse(`[${id}] result and error are both present`, body);
  }
  // id MUST be null and error is REQUIRED if request id not parseable
  // TODO(jordan): error.code should also be well-known code -32600 ?
  if ((body.id === null) && !('error' in body)) {
    throw InvalidResponse(`[${id}] but error field is missing`, body);
  }
  // error is REQUIRED on error
  if ('error' in body) {
    // error MUST be an object
    if (typeof(body.error) !== 'object') {
      throw InvalidResponse(`[${id}] error is not an object`, body);
    }
    // error MUST NOT be null
    if (body.error === null) {
      throw InvalidResponse(`[${id}] error is present, but null`, body);
    }
    // error.code is REQUIRED
    if (!('code' in body.error)) {
      throw InvalidResponse(`[${id}] error code is missing`, body);
    }
    // error.code MUST be an integer
    if ((body.error.code as any | 0) !== body.error.code) {
      throw InvalidResponse(`[${id}] error code is not an integer`, body);
    }
    // error.message is REQUIRED
    if (!('message' in body.error)) {
      throw InvalidResponse(`[${id}] error message is missing`, body);
    }
    // error.message MUST be a string
    if (!(typeof(body.error.message) === 'string')) {
      throw InvalidResponse(`[${id}] error message is not a string`, body);
    }
  }
  // given that we did not throw an Error, we can return a valid response
  return body as JsonRpcResponse;
}

/*
 * assert that a given HTTP Response object has a valid JSON body.
 *
 * TODO(jordan): convert to Fallible
 */
async function expectJsonBody(httpMessage: Request | Response)
  : Promise<object>
{
  // bail if the parsed JSON of the HTTP response is not an array
  const responseText = await httpMessage.text();
  let json; try { json = JSON.parse(responseText) }
  catch {
    /*
     * TODO(jordan): use debug logger instance
     */
    console.warn(`Invalid JSON-RPC response: not JSON`, {
      url:        httpMessage.url,
      text:       responseText,
      status:     (httpMessage instanceof Response) ? httpMessage.status     : '',
      statusText: (httpMessage instanceof Response) ? httpMessage.statusText : '',
    });
    throw InvalidResponse(`not JSON`, responseText);
  }
  return json;
}

function InvalidResponse(message: string, cause: object|string) {
  return new Error(`Invalid JSON-RPC response: ${message}`, { cause });
}

/*
 * format JSON-RPC errors into a common string encoding.
 */
function formatError(error: JsonRpcError) {
  return `jsonRpc error: code=${error.code} msg=${error.message}`;
}

export {
  configure,
  // JSON-RPC methods
  post,
  postBatch,
  formatError,
  // Request preparation methods
  preparePost,
  preparePostBatch,
  // validation logic for Response objects
  expectBatch,
  expectRequest,
  expectResponse,
  // validation logic for JSON objects
  expectJsonBody,
  expectJsonIsRequestBody,
  expectJsonIsResponseBody,
};

export type {
  Call,
  FallibleFetch,
  JsonRpcError    as Error,
  JsonRpcRequest  as Request,
  JsonRpcResponse as Response,
};
