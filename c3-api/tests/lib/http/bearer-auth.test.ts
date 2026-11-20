import t from 'tap';

import { sha256 } from '../../../lib/hash.js';
import { ROLES, allows, authenticateAdmin, refuseRole } from '../../../src/http/bearer-auth.js';
import type { Credential, Role } from '../../../src/http/bearer-auth.js';
import { ApiError, failureResponse } from '../../../src/http/errors.js';

/*
 * The tokens as an operator lists them for an environment: who holds each,
 * the SHA-256 of the token, its role and its expiry. A list the worker cannot
 * read is refused as the environment's fault before a token is read: a 401
 * would send the operator after the token instead (REGISTRY_RUNBOOK.md, The
 * admin tokens).
 */
const TOKEN = 'registry-admin-token-for-tests';
const HASH  = await sha256(TOKEN);

type Settings = Parameters<typeof authenticateAdmin>[1];

// an environment with a list of tokens, given as the entries it holds
function listing(entries: unknown[]): Settings {
  return { COMET_REGISTRY_ADMIN_TOKENS: JSON.stringify(entries) };
}

async function entry(name: string, token: string, role: Role, notAfter: string | null = null) {
  return { name, sha256: await sha256(token), role, notAfter };
}

// an environment whose one token is TOKEN, an admin's
const ADMIN = listing([ { name: 'alice', sha256: HASH, role: 'admin', notAfter: null } ]);

async function outcomeOf(settings: Settings, headers: Record<string, string>, now?: number): Promise<Credential | ApiError> {
  try {
    return await authenticateAdmin(new Request('https://api.test.local/registry/v1/admin/status', { headers }), settings, now);
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
}

async function refusalOf(settings: Settings, token?: string, now?: number): Promise<ApiError | null> {
  return refusalWith(settings, token === undefined ? {} : { 'Authorization': `Bearer ${token}` }, now);
}

async function refusalWith(settings: Settings, headers: Record<string, string>, now?: number): Promise<ApiError | null> {
  const outcome = await outcomeOf(settings, headers, now);
  return outcome instanceof ApiError ? outcome : null;
}

async function credentialOf(settings: Settings, token: string, now?: number): Promise<Credential | ApiError> {
  return outcomeOf(settings, { 'Authorization': `Bearer ${token}` }, now);
}

/*
 * No list, a blank one or an empty one is no token at all: the
 * administrative API is closed to whatever a request sends, and asks for no
 * token, since none would be taken.
 */
t.test('an environment without a token is closed', async t => {
  const closed: Array<[ string, Settings ]> = [
    [ 'no list',              {} ],
    [ 'a blank list',         { COMET_REGISTRY_ADMIN_TOKENS: '' } ],
    [ 'a list of whitespace', { COMET_REGISTRY_ADMIN_TOKENS: ' \n' } ],
    [ 'an empty list',        listing([]) ],
  ];
  for (const [ what, settings ] of closed) {
    for (const token of [ TOKEN, undefined ]) {
      const refused = await refusalOf(settings, token);
      t.match(refused, { status: 403, code: 'FORBIDDEN', message: 'the administrative API is not configured in this environment' },
        `${what} is no token at all, ${token === undefined ? 'to a request without a token' : 'to a token'}`);
      t.same(refused?.headers, {}, 'and asks for none');
    }
  }
});

/*
 * What the check cannot tell: the token is 64 hex digits too
 * (`openssl rand -hex 32`), so one listed in place of its hash is taken for a
 * hash, and no token matches it.
 */
t.test('a token listed in place of its hash matches no token, itself included', async t => {
  const token = 'ab'.repeat(32);
  t.match(await refusalOf(listing([ { name: 'alice', sha256: token, role: 'admin', notAfter: null } ]), token),
    { status: 401, code: 'UNAUTHORIZED' });
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
    t.equal(await refusalWith(ADMIN, { 'Authorization': header }), null, `the token is accepted ${what}`);
  }
  for (const [ header, what ] of [
    [ `Bearer ${TOKEN} garbage`, 'a word after the token' ],
    [ `Bearer ${TOKEN} ${TOKEN}`, 'the token twice' ],
    [ `Bearer\t${TOKEN}`, 'a tab after the scheme' ],
    [ `Bearer${TOKEN}`, 'no space after the scheme' ],
  ] as const) {
    t.match(await refusalWith(ADMIN, { 'Authorization': header }), {
      status:  401,
      code:    'UNAUTHORIZED',
      message: 'a bearer token is required',
      headers: { 'WWW-Authenticate': 'Bearer' },
    }, `${what} is refused as no token`);
  }
});

t.test('a token of the list is taken under its holder\'s name, with its role', async t => {
  const settings = listing([
    await entry('alice', 'alice-token', 'admin'),
    { ...await entry('olga', 'olga-token', 'operator', '2099-01-01T00:00:00Z'), sha256: (await sha256('olga-token')).toUpperCase() },
    await entry('status-monitor', 'monitor-token', 'monitor'),
  ]);
  t.match(await credentialOf(settings, 'alice-token'), { name: 'alice', role: 'admin', fingerprint: /^[0-9a-f]{16}$/ });
  t.match(await credentialOf(settings, 'olga-token'), { name: 'olga', role: 'operator' }, 'a digest in capitals is the same digest');
  t.match(await credentialOf(settings, 'monitor-token'), { name: 'status-monitor', role: 'monitor' });
  t.match(await refusalOf(settings, 'nobody-token'), {
    status:  401,
    message: 'the bearer token is not valid',
    headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
  }, 'and a token it does not list is refused');
});

/*
 * A list the worker cannot read refuses every request, whatever it sends,
 * rather than taking the entries it can, and asks for no token, since the
 * fault is the environment's. The answer names the setting alone, to whoever
 * asks; what is wrong, by entry and field, is for the log, and no value is
 * either.
 */
t.test('a list the worker cannot read closes the administrative API to every token', async t => {
  const alice = await entry('alice', 'alice-token', 'admin');
  const named = (fields: Record<string, unknown>) => [ { ...alice, ...fields } ];
  const lists: Array<[ string, unknown, string ]> = [
    [ 'not JSON',                      '[{"name": "alice"', 'COMET_REGISTRY_ADMIN_TOKENS is not JSON' ],
    [ 'an object',                     { alice },           'COMET_REGISTRY_ADMIN_TOKENS is not a list' ],
    [ 'more than fifty entries',       Array.from({ length: 51 }, (_, index) => ({ ...alice, sha256: index.toString(16).padStart(64, '0') })),
      'COMET_REGISTRY_ADMIN_TOKENS lists more than 50 tokens' ],
    [ 'an entry that is a string',     [ 'alice' ],         'COMET_REGISTRY_ADMIN_TOKENS[0] is not an object' ],
    [ 'an entry that is null',         [ null ],            'COMET_REGISTRY_ADMIN_TOKENS[0] is not an object' ],
    [ 'an entry that is a list',       [ [ alice ] ],       'COMET_REGISTRY_ADMIN_TOKENS[0] is not an object' ],
    [ 'no notAfter',                   [ { name: 'alice', sha256: alice.sha256, role: 'admin' } ],
      'COMET_REGISTRY_ADMIN_TOKENS[0] must have exactly name, sha256, role and notAfter' ],
    [ 'a misspelt notAfter',           [ { name: 'alice', sha256: alice.sha256, role: 'admin', notafter: null } ],
      'COMET_REGISTRY_ADMIN_TOKENS[0] must have exactly name, sha256, role and notAfter' ],
    [ 'a key besides',                 named({ comment: 'x' }), 'COMET_REGISTRY_ADMIN_TOKENS[0] must have exactly name, sha256, role and notAfter' ],
    [ 'a name in capitals',            named({ name: 'Alice' }), 'COMET_REGISTRY_ADMIN_TOKENS[0].name must be' ],
    [ 'a name with a colon',           named({ name: 'registry-cron:test' }), 'COMET_REGISTRY_ADMIN_TOKENS[0].name must be' ],
    [ 'an empty name',                 named({ name: '' }), 'COMET_REGISTRY_ADMIN_TOKENS[0].name must be' ],
    [ 'a name of 65 characters',       named({ name: 'a'.repeat(65) }), 'COMET_REGISTRY_ADMIN_TOKENS[0].name must be' ],
    [ 'a digest cut short',            named({ sha256: alice.sha256.slice(1) }), 'COMET_REGISTRY_ADMIN_TOKENS[0].sha256 must be 64 hex digits' ],
    [ 'a digest as shasum prints it',  named({ sha256: `${alice.sha256}  -` }), 'COMET_REGISTRY_ADMIN_TOKENS[0].sha256 must be 64 hex digits' ],
    [ 'a digest as openssl prints it', named({ sha256: `${alice.sha256} *stdin` }), 'COMET_REGISTRY_ADMIN_TOKENS[0].sha256 must be 64 hex digits' ],
    [ 'a digest with a line break',    named({ sha256: `${alice.sha256}\n` }), 'COMET_REGISTRY_ADMIN_TOKENS[0].sha256 must be 64 hex digits' ],
    [ 'a role there is not',           named({ role: 'root' }),
      'COMET_REGISTRY_ADMIN_TOKENS[0].role must be one of monitor, reader, operator, admin' ],
    [ 'a role in capitals',            named({ role: 'Admin' }),
      'COMET_REGISTRY_ADMIN_TOKENS[0].role must be one of monitor, reader, operator, admin' ],
    [ 'a date without a time',         named({ notAfter: '2027-05-01' }), 'COMET_REGISTRY_ADMIN_TOKENS[0].notAfter must be null or an instant in UTC' ],
    [ 'an instant in another zone',    named({ notAfter: '2027-05-01T00:00:00+02:00' }), 'COMET_REGISTRY_ADMIN_TOKENS[0].notAfter must be null or an instant in UTC' ],
    [ 'February 30th',                 named({ notAfter: '2027-02-30T00:00:00Z' }), 'COMET_REGISTRY_ADMIN_TOKENS[0].notAfter must be null or an instant in UTC' ],
    [ 'April 31st',                    named({ notAfter: '2027-04-31T00:00:00Z' }), 'COMET_REGISTRY_ADMIN_TOKENS[0].notAfter must be null or an instant in UTC' ],
    [ 'the hour 24',                   named({ notAfter: '2027-05-01T24:00:00Z' }), 'COMET_REGISTRY_ADMIN_TOKENS[0].notAfter must be null or an instant in UTC' ],
    [ 'a tenth of a second',           named({ notAfter: '2027-05-01T00:00:00.5Z' }), 'COMET_REGISTRY_ADMIN_TOKENS[0].notAfter must be null or an instant in UTC' ],
    [ 'milliseconds since the epoch',  named({ notAfter: 1830297600000 }), 'COMET_REGISTRY_ADMIN_TOKENS[0].notAfter must be null or an instant in UTC' ],
    [ 'a missing expiry as a string',  named({ notAfter: 'null' }), 'COMET_REGISTRY_ADMIN_TOKENS[0].notAfter must be null or an instant in UTC' ],
    [ 'a token listed twice',          [ alice, { ...alice, name: 'bob', role: 'reader' } ], 'COMET_REGISTRY_ADMIN_TOKENS[1] names the same token as [0]' ],
    [ 'a good entry before a bad one', [ alice, { ...alice, name: 'Bob' } ], 'COMET_REGISTRY_ADMIN_TOKENS[1].name must be' ],
  ];
  for (const [ what, list, problem ] of lists) {
    const settings = { COMET_REGISTRY_ADMIN_TOKENS: typeof(list) === 'string' ? list : JSON.stringify(list) };
    for (const [ token, whose ] of [ [ 'alice-token', 'a token the list names' ], [ undefined, 'a request without a token' ] ] as const) {
      const refused = await refusalOf(settings, token);
      t.match(refused, {
        status:  403,
        code:    'FORBIDDEN',
        message: 'the administrative API is misconfigured in this environment: COMET_REGISTRY_ADMIN_TOKENS is malformed',
        headers: {},
      }, `${what} refuses ${whose}`);
      t.ok((refused?.logged?.problem as string | undefined)?.startsWith(problem), `and the log says what is wrong: ${problem}`);
      const said = JSON.stringify([ refused?.message, refused?.logged ]);
      t.notOk([ 'Alice', 'Bob', 'registry-cron:test', 'comment', alice.sha256.slice(1, 17) ].some(value => said.includes(value)),
        'never with a value of the list');
    }
  }
});

/*
 * A secret is a string. wrangler.toml [vars] can give a setting as a list or
 * as a number instead, and the worker answers that as the environment's
 * fault, as it answers a string it cannot read, rather than failing on it.
 */
t.test('a list that is not a string is refused as the environment\'s fault', async t => {
  const alice = await entry('alice', 'alice-token', 'admin');
  for (const [ what, value ] of [ [ 'a TOML array', [ alice ] ], [ 'a number', 42 ] ] as const) {
    const refused = await refusalOf({ COMET_REGISTRY_ADMIN_TOKENS: value } as unknown as Settings, 'alice-token');
    t.match(refused, {
      status:  403,
      code:    'FORBIDDEN',
      message: 'the administrative API is misconfigured in this environment: COMET_REGISTRY_ADMIN_TOKENS is malformed',
    }, `a list given as ${what} refuses every token`);
    t.same(refused?.logged, { problem: 'COMET_REGISTRY_ADMIN_TOKENS is not a string' }, 'and the log says why');
  }
});

t.test('an instant in UTC, with milliseconds or without, that the calendar has is taken', async t => {
  for (const notAfter of [ '2027-05-01T00:00:00Z', '2027-05-01T00:00:00.000Z', '2028-02-29T23:59:59.999Z' ]) {
    t.match(await credentialOf(listing([ await entry('alice', 'alice-token', 'admin', notAfter) ]), 'alice-token', Date.parse('2027-01-01T00:00:00Z')),
      { name: 'alice' }, notAfter);
  }
});

/*
 * A token is taken up to and including its notAfter. Past it, it is refused
 * as a wrong token is, with the same challenge, but says that it has expired
 * so its holder knows to use the token that replaced it; whose it was is for
 * the log alone.
 */
t.test('a token is taken until its notAfter, and refused as expired after it', async t => {
  const notAfter = '2027-05-01T00:00:00Z';
  const settings = listing([ await entry('olga', 'olga-token', 'operator', notAfter) ]);
  const last     = Date.parse(notAfter);

  t.match(await credentialOf(settings, 'olga-token', last), { name: 'olga', role: 'operator' }, 'at its notAfter it is taken');
  const expired = await refusalOf(settings, 'olga-token', last + 1);
  t.match(expired, {
    status:  401,
    code:    'UNAUTHORIZED',
    message: 'the bearer token has expired',
    headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"' },
  }, 'a millisecond later it has expired');
  t.same(expired?.logged, { name: 'olga' }, 'and the log names whose it was');
  t.same(expired?.details, undefined, 'which the answer does not');

  const unknown = await refusalOf(settings, 'another-token', last + 1);
  t.same(expired?.headers, unknown?.headers, 'an expired token is challenged as an unknown one is');
  t.same(unknown?.logged, undefined, 'and an unknown token names nobody');
});

/*
 * Rotating: the holder is given a second token under the same name, and the
 * first a notAfter. Both are taken until then, as the same holder.
 */
t.test('two tokens under one name are one holder\'s, each taken until it expires', async t => {
  const settings = listing([
    await entry('olga', 'olga-old-token', 'operator', '2027-05-01T00:00:00Z'),
    await entry('olga', 'olga-new-token', 'operator'),
  ]);
  const during = Date.parse('2027-04-30T00:00:00Z');
  const after  = Date.parse('2027-05-02T00:00:00Z');

  t.match(await credentialOf(settings, 'olga-old-token', during), { name: 'olga' }, 'while they overlap the old token is taken');
  t.match(await credentialOf(settings, 'olga-new-token', during), { name: 'olga' }, 'and so is the new one, under the same name');
  t.match(await refusalOf(settings, 'olga-old-token', after), { status: 401, message: 'the bearer token has expired' },
    'after the overlap the old one has expired');
  t.match(await credentialOf(settings, 'olga-new-token', after), { name: 'olga' }, 'and the new one goes on');

  const old = await credentialOf(settings, 'olga-old-token', during) as Credential;
  const replacement = await credentialOf(settings, 'olga-new-token', during) as Credential;
  t.not(old.fingerprint, replacement.fingerprint, 'each token has budgets of its own');
});

t.test('roles nest: each takes every route the roles before it take', async t => {
  t.same(ROLES, [ 'monitor', 'reader', 'operator', 'admin' ]);
  t.same(ROLES.filter(required => allows('monitor', required)), [ 'monitor' ]);
  t.same(ROLES.filter(required => allows('reader', required)), [ 'monitor', 'reader' ]);
  t.same(ROLES.filter(required => allows('operator', required)), [ 'monitor', 'reader', 'operator' ]);
  t.same(ROLES.filter(required => allows('admin', required)), [ 'monitor', 'reader', 'operator', 'admin' ]);
});

/*
 * A valid token on a route its role does not reach is RFC 6750's
 * insufficient_scope: a 403 that says which role the route needs. The line
 * logged about it, under its request id, says whose token it was, and never
 * the token or anything of its digest.
 */
t.test('a token below the role a route needs is refused for its scope, and logged by name', async t => {
  const credential: Credential = { fingerprint: '0123456789abcdef', name: 'olga', role: 'operator' };
  const refused = refuseRole(credential, 'admin');
  t.match(refused, {
    status:  403,
    code:    'FORBIDDEN',
    message: 'the token olga has the role operator, and this route needs admin',
    headers: { 'WWW-Authenticate': 'Bearer error="insufficient_scope"' },
  });
  t.same(refused.details, { role: 'operator', requiredRole: 'admin' }, 'the answer says which role it needs');

  const warnings: unknown[][] = [];
  const response = failureResponse(refused, refused, {
    requestId: 'request-1',
    pathname:  '/registry/v1/admin/versions/v/activate',
    label:     'registry route',
    debug:     { error: () => undefined, warn: (...parameters: unknown[]) => warnings.push(parameters) },
  });
  t.equal(response.status, 403);
  t.same(warnings, [ [ 'registry route refused', {
    requestId:    'request-1',
    pathname:     '/registry/v1/admin/versions/v/activate',
    status:       403,
    code:         'FORBIDDEN',
    name:         'olga',
    role:         'operator',
    requiredRole: 'admin',
  } ] ], 'and the log line says whose token it was, and nothing of the token');
  t.notMatch(JSON.stringify(await response.json()), /0123456789abcdef/, 'nor does the answer');
});
