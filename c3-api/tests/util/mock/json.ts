import type * as Json  from './deps-hacks/json-types.js';
import type * as fetch from './fetch.js';

function expectPost(
  fetch:                 fetch.MockFetch,
  url:                   string,
  [ request, response ]: [ Json.Value, Json.Representable ],
) {
  fetch.expect(url, {
    method: 'POST',
    body: {
      type: 'json',
      value: request,
    },
  })
    .returns(JSON.stringify(response));
}

export { expectPost };
