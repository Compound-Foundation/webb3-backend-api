import './deps-hacks/shim/node-self.js';

import { inspect }          from 'node:util';
import * as streamInto      from 'node:stream/consumers';
import { strict as assert } from 'node:assert';

import * as Debug from './deps-hacks/debug-log.js';

import type * as Json from './deps-hacks/json-types.js';
import type * as Type from './deps-hacks/type-utilities.js';

/*
 * Types
 */

type Fetch = typeof self.fetch;
type NodeFetch = typeof globalThis.fetch;
// Minimal structural shape so any test-framework Test (e.g. tap's) is
// accepted; satisfy() only ever calls t.ok(...).
type Test  = { ok(...args: any[]): any };

interface MockFetch extends Fetch, NodeFetch {
  // debug logger scoped to 'fetch'
  debug: Debug.Logger;
  // runtime fetch should be cached on the mock object
  fetch: Fetch;
  // pending allows us to detect a trailing expect() without a returns()
  pending: boolean;
  // inflight allows us to put a mutex on mock calls
  inflight: boolean;
  // mock configuration options allow for customizable behavior
  options: Options;
  // expects is an ordered list of expected fetches with mocked results
  expects: [ Expectation, Returns ][];
  // unexpected is a list of unexpected requests, in case error was caught
  unexpected: Request[];
  // satisfy returns true iff all expectations have been satisfied
  satisfy(t?: Test): boolean;
  // expect adds an expectation to the set of mocked calls
  expect(url?: string, init?: ExpectationInit): ChainExpect;
};

interface Options {
  // if passthrough is true, unexpected fetch calls will be performed
  passthrough: boolean;
}

interface ChainExpect {
  returns(response: Response): MockFetch;
  returns(...args: ConstructorParameters<typeof Response>): MockFetch;
  returns(make: (request: Request) => ResponseLike): MockFetch;
};

interface ExpectationInit extends Omit<Expectation, 'headers' | 'method' | 'used'> {
  method?:  string;
  headers?: HeadersInit;
}

interface Expectation {
  used:     boolean;
  method:   string;
  url?:     string;
  body?:    BodyInit | boolean | null | { type: 'json', value: Json.Value };
  headers?: [ key: string, value: string ][];
}

type Returns = (
  | ResponseLike
  | ((request: Request) => ResponseLike)
);

type ResponseLike = (
  Type.MaybeAsync<(
    | Response
    | ConstructorParameters<typeof Response>
  )>
);

function Expectation(url?: string, init: ExpectationInit = {}): Expectation {
  // expect 'GET' by default, just like fetch
  const expectation: Expectation = {
    used: false,
    method: init.method ?? 'GET',
  };
  // if a particular url is expected, normalize it
  if (typeof(url) !== 'undefined') {
    expectation.url = new URL(url).toString();
  }
  // if particular headers are expected, normalize and arrayify
  if ('headers' in init) {
    expectation.headers = Array.from(new Headers(init.headers ?? []));
  }
  // if a particular body is expected, add it to the expectation
  if ('body' in init) {
    expectation.body = init.body;
  }
  return expectation;
}

/*
 * Implementation
 */

// cache the 'true' fetch implementation
const fetchInternal = self.fetch;

// defaults for mock configuration options
const defaults: Options = {
  passthrough: false, // do not passthrough unexpected fetches
};

const makeMock: ((options: Partial<Options>) => MockFetch) = options => {
  const context = {
    expect,
    satisfy,
    debug: Debug.MakeLogger([ 'fetch' ]).configure(process.env),
    expects: [],
    unexpected: [],
    pending: false,
    inflight: false,
    options: { ...defaults, ...options },
    get fetch() { return fetchInternal },
  };
  return Object.assign(
    mockableFetch.bind(context),
    context,
  ) as unknown as MockFetch;
};

async function mockableFetch(
  this: {
    debug:      Debug.Logger,
    fetch:      Fetch,
    options:    Options,
    pending:    boolean,
    inflight:   boolean,
    expects:    MockFetch['expects'],
    unexpected: MockFetch['unexpected'],
  },
  ...args: Parameters<Fetch>
): ReturnType<Fetch> {
  // detect dangling .expect() that never got a .returns()
  if (this.pending) {
    throw new Error(
      `MockFetch: an expectation is pending!`
      + ` Did you forget to call .returns(...)?`
    );
  }
  // construct a request from the arguments for fetch
  const request = new Request(...args);
  // wait for no existing mock calls to be in-flight
  let waits = 0;
  while (this.inflight && waits < 10) {
    waits++;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  this.inflight = true;
  // attempt to find a matching expectation
  let matchIndex = -1;
  for (let index = 0; index < this.expects.length; index++) {
    try {
      if (await matchesExpectation(request, this.expects[index][0], this.debug)) {
        this.expects[index][0].used = true;
        matchIndex = index;
        break;
      }
    } catch {}
  }
  // if no expectation matches this request...
  if (matchIndex === -1) {
    // if the passthrough option is configured, fetch the request
    if (this.options.passthrough) {
      this.debug.log(`MockFetch: passing through unexpected request`);
      this.unexpected.push(request.clone());
      this.inflight = false;
      return this.fetch(request);
    }
    // otherwise, error out (this is the default behavior)
    const errorMessage = `MockFetch: did not expect request`;
    this.debug.error(errorMessage, {
      request,
      expects: (
        this.expects
          .filter(([{ used }]) => !used)
          .map(([ expected ]) => expected)
      ),
    });
    this.unexpected.push(request.clone());
    throw new Error(errorMessage);
  }
  // otherwise, compute the expected Response
  let [ _, returns ] = this.expects[matchIndex];
  if (typeof(returns) === 'function') {
    returns = returns(request);
  }
  const  result = await returns;
  this.inflight = false;
  return result instanceof Response ? result : new Response(...result);
}

function expect(
  this: MockFetch,
  url?: string,
  init: ExpectationInit = {},
): ChainExpect {
  const mockContext = this;
  // until we receive a returns call, MockFetch should error informatively
  this.pending = true;
  return {
    returns(expected, ...rest) {
      // handle ConstructorParameters<typeof Response> case
      if (true
        && !(expected instanceof Response) // not just a Response
        && typeof(expected) !== 'function' // not (Request) => ResponseLike
      ) {
        expected = new Response(expected, ...rest as any[]);
      }
      mockContext.expects.push([ Expectation(url, init), expected ]);
      // we are no longer in a pending state waiting for a returns call
      mockContext.pending = false;
      return mockContext;
    }
  };
}

function satisfy(this: MockFetch, t?: Test) {
  const unexpectedOk = this.options.passthrough;
  const unsatisfied = this.expects.filter(([{ used }]) => !used);
  if (!!t) {
    // Throw rather than call t.ok(): these run inside afterEach hooks, and tap
    // 18+ rejects assertions made on the test after its promise resolves
    // ("test assertion after Promise resolution"). A thrown AssertionError
    // fails the hook (and thus the test) cleanly.
    assert.ok(
      unsatisfied.length === 0,
      `not all ${this.expects.length} expected fetch() calls were made`
    );
    if (!unexpectedOk) {
      assert.ok(
        this.unexpected.length === 0,
        `${this.unexpected.length} unexpected fetch() calls were made`
      );
    }
  }
  return (unsatisfied.length === 0)
      && (unexpectedOk || this.unexpected.length === 0);
}

async function matchesExpectation(
  request: Request,
  expected: Expectation,
  debug: Debug.Logger,
): Promise<boolean> {
  // if the expectation has been used, don't try to match it
  if (expected.used) {
    return false;
  }
  // if a particular url is expected, it MUST match exactly
  if ('url' in expected && expected.url !== request.url) return false;
  // if particular headers are expected...
  if ('headers' in expected) {
    // ... every header MUST have an exact match in the request
    const matches = expected.headers.every(([ key, value ]) => {
      return request.headers.has(key)
          && request.headers.get(key) === value;
    });
    // NOTE: additional headers are allowed
    // TODO?: add an option to disallow unexpected headers?
    if (!matches) return false;
  }
  // if a particular body is expected...
  if ('body' in expected) {
    // ... and if the expected body is boolean...
    if (typeof(expected.body) === 'boolean') {
      // ... true means the request body MUST NOT be null
      if (expected.body === true)  return request.body !== null;
      // ... false means the request body MUST be null
      if (expected.body === false) return request.body === null;
    // ... and if it is expected to be null...
    } else if (expected.body === null) {
      // request body MUST also be null
      if (request.body !== null) return false;
    // ... and if the expected body is a non-null object...
    } else {
      // request body MUST NOT be null
      if (request.body === null) return false;
      // ... and if it expects a ReadableStream...
      if (expected.body instanceof ReadableStream) {
        // ... the streams MUST be byte-for-byte equal
        // TODO?(jordan): actually do a streaming chunkwise comparison?
        const actual = await streamInto.buffer(request.body  as any);
        const wanted = await streamInto.buffer(expected.body as any);
        if (!wanted.equals(Uint8Array.from(actual))) return false;
      // ... and if it expects an ArrayBuffer...
      } else if (expected.body instanceof ArrayBuffer) {
        // ... the array buffers MUST be byte-for-byte equal
        const actual = await streamInto.buffer(request.body as any);
        const wanted = Buffer.from(expected.body);
        if (!wanted.equals(Uint8Array.from(actual))) return false;
      // ... and if it expects a Blob...
      } else if (expected.body instanceof Blob) {
        // ... the blob MUST be byte-for-byte equal to the request
        const blob = expected.body;
        const actual = await streamInto.buffer(request.body  as any);
        const wanted = await streamInto.buffer(blob.stream() as any);
        if (!wanted.equals(Uint8Array.from(actual))) return false;
      // ... and if it expects a body of certain URLSearchParams...
      } else if (expected.body instanceof URLSearchParams) {
        const requestText   = await streamInto.text(request.body as any);
        const requestSearch = new URLSearchParams(requestText);
        // ... all expected URLSearchParams MUST be present and equal
        const expectedEntries = Array.from(expected.body.entries());
        const matches = expectedEntries.every(([ key, value ]) => {
          return requestSearch.has(key)
              && requestSearch.get(key) === value;
        });
        // NOTE: additional unexpected search params are allowed
        // TODO?: add an option to disallow unexpected search params?
        if (!matches) return false;
      // ... and if it expects a body of certain FormData...
      } else if (expected.body instanceof FormData) {
        const requestFormData = await request.formData();
        // ... all expected FormData properties MUST be present and equal
        // NOTE: additional unexpected FormData properties are allowed
        // TODO?: add an option to disallow unexpected form data props?
        for (const [ key, value ] of expected.body.entries()) {
          // key MUST be present
          if (!requestFormData.has(key)) return false;
          const requestValue = requestFormData.get(key);
          // if expected value is string...
          if (typeof(value) === 'string') {
            // ... request value MUST be string ...
            if (!(typeof(requestValue) === 'string')) return false;
            // ... and MUST exactly equal
            if (requestValue !== value) return false;
          // ... otherwise, expected value is File...
          } else {
            // ... request value MUST be File...
            if (!(requestValue instanceof File)) return false;
            // ... and MUST be string-equal
            const actual = await value.text();
            const wanted = await requestValue.text();
            if (actual !== wanted) return false;
          }
        }
      // ... and if it expects a string...
      } else if (typeof(expected.body) === 'string') {
        // ... the string MUST match exactly
        const requestText = await streamInto.text(request.body as any);
        return expected.body === requestText;
      // ... and if it expects a JSON match...
      } else if (expected.body.type === 'json') {
        // ... the request body MUST be JSON
        const actual = await streamInto.json(request.body as any);
        // ... and it MUST deeply equal the expected body JSON value
        try {
          assert.deepEqual(actual, expected.body.value);
        } catch (assertionError) {
          // NOTE: thanks to assert/strict, this will print a diff.
          debug.warn(`MockFetch: JSON body did not match expectation`, assertionError);
          return false;
        }
      } else {
        const body = inspect(expected.body);
        throw new Error(`unhandled match for expected.body: ${body}`);
      }
    }
  }
  // method is REQUIRED and MUST match exactly
  return expected.method === request.method;
}

export default makeMock;

export type {
  Fetch,
  Options,
  MockFetch,
  ChainExpect,
};
