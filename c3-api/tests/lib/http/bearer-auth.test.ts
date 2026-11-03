import t from 'tap';

import { sha256 } from '../../../lib/hash.js';
import { authenticateAdmin } from '../../../src/http/bearer-auth.js';
import { ApiError } from '../../../src/http/errors.js';

/*
 * The token hash as an operator puts it into an environment. It is read as
 * hex in either case, without the whitespace around it. Any other value
 * matches no token, so it is refused as the environment's fault before a
 * token is read: a 401 would send the operator after the token instead
 * (REGISTRY_RUNBOOK.md, The admin token).
 */
const TOKEN = 'registry-admin-token-for-tests';
const HASH  = await sha256(TOKEN);

async function refusalOf(tokenHash: string | undefined, token?: string): Promise<ApiError | null> {
  return refusalWith(tokenHash, token === undefined ? {} : { 'Authorization': `Bearer ${token}` });
}

async function refusalWith(tokenHash: string | undefined, headers: Record<string, string>): Promise<ApiError | null> {
  try {
    await authenticateAdmin(new Request('https://api.test.local/registry/v1/admin/status', { headers }), tokenHash);
    return null;
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
}

t.test('a hash is read in either case, without the whitespace around it', async t => {
  t.equal(await refusalOf(`  ${HASH}\n`, TOKEN), null, 'whitespace around it is dropped');
  t.equal(await refusalOf(HASH.toUpperCase(), TOKEN), null, 'and the hash in capitals is the same hash');
  t.match(await refusalOf(`  ${HASH}\n`, 'another-token'), { status: 401, code: 'UNAUTHORIZED' },
    'which another token still does not match');
});

t.test('a value that is no hash is refused as the environment\'s fault, whatever the request sends', async t => {
  const values: Array<[ string, string ]> = [
    [ 'the line openssl dgst -r prints', `${HASH} *stdin` ],
    [ 'the line shasum prints', `${HASH}  -` ],
    [ 'a hash cut short', HASH.slice(0, -1) ],
  ];
  for (const [ name, value ] of values) {
    for (const token of [ TOKEN, undefined ]) {
      const refused = await refusalOf(value, token);
      t.match(refused, {
        status:  403,
        code:    'FORBIDDEN',
        message: /misconfigured in this environment: COMET_REGISTRY_ADMIN_TOKEN_HASH is not 64 hex digits$/,
      }, `${name}, ${token === undefined ? 'to a request without a token' : 'to the right token'}`);
      t.same(refused?.headers, {}, 'and asks for no token');
    }
  }
});

t.test('an environment without a hash is closed', async t => {
  for (const value of [ undefined, '', ' \n' ]) {
    t.match(await refusalOf(value, TOKEN), { status: 403, code: 'FORBIDDEN', message: /is not configured in this environment$/ },
      value === undefined ? 'no value' : `${JSON.stringify(value)}, which is blank`);
  }
});

/*
 * What the check cannot tell: the token is 64 hex digits too
 * (`openssl rand -hex 32`), so one stored in place of its hash is taken for a
 * hash, and no token matches it.
 */
t.test('a token stored in place of its hash matches no token, itself included', async t => {
  const token = 'ab'.repeat(32);
  t.match(await refusalOf(token, token), { status: 401, code: 'UNAUTHORIZED' });
});

/*
 * The header as RFC 6750 writes it: the scheme in any case, one space or
 * more, and the token. Anything after the token is not a part to ignore: the
 * header is refused as one that carries no token.
 */
t.test('the token is the one word after the scheme and its spaces', async t => {
  for (const [ header, what ] of [
    [ `Bearer  ${TOKEN}`, 'after two spaces' ],
    [ `bEaReR ${TOKEN}`, 'after the scheme in any case' ],
    [ ` Bearer ${TOKEN} `, 'with whitespace around the header' ],
  ] as const) {
    t.equal(await refusalWith(HASH, { 'Authorization': header }), null, `the token is accepted ${what}`);
  }
  for (const [ header, what ] of [
    [ `Bearer ${TOKEN} garbage`, 'a word after the token' ],
    [ `Bearer ${TOKEN} ${TOKEN}`, 'the token twice' ],
    [ `Bearer\t${TOKEN}`, 'a tab after the scheme' ],
    [ `Bearer${TOKEN}`, 'no space after the scheme' ],
  ] as const) {
    t.match(await refusalWith(HASH, { 'Authorization': header }), {
      status:  401,
      code:    'UNAUTHORIZED',
      message: 'a bearer token is required',
      headers: { 'WWW-Authenticate': 'Bearer' },
    }, `${what} is refused as no token`);
  }
});
