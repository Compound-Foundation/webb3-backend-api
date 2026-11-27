import type { Env } from '../../entrypoint.js';
import { sha256Hex } from '../../lib/hash.js';

import { ApiError } from './errors.js';

/*
 * Bearer authentication for the administrative registry routes.
 *
 * The worker stores only the SHA-256 of each admin token, so a leaked
 * configuration does not hand over a token itself, and the comparison is
 * fixed-time: comparing digests with === would leak, through timing, how much
 * of a guess was correct.
 */
function equalsFixedTime(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/*
 * A 401 names the scheme that would be accepted, as RFC 9110 requires of it,
 * and says when the token that was presented is the problem (RFC 6750): a
 * client is told what to send rather than only that it was refused.
 */
function unauthorized(message: string, challenge: string, logged?: Record<string, unknown>): ApiError {
  return new ApiError('UNAUTHORIZED', message, undefined, { 'WWW-Authenticate': challenge }, logged);
}

/*
 * The credentials as RFC 6750 writes them: the scheme, in any case, one space
 * or more, and the token, with nothing after it. Headers.get has already
 * dropped the whitespace around the value.
 */
const BEARER = /^bearer +(\S+)$/i;

function bearerToken(request: Request): string {
  const match = BEARER.exec(request.headers.get('authorization') ?? '');
  if (match === null) {
    throw unauthorized(`a bearer token is required`, 'Bearer');
  }
  return match[1]!;
}

/*
 * What a token may do. A role may call everything the one before it may, so
 * the order is the nesting: the status alone, then every administrative
 * read, then imports and overlay writes, then validating a version and
 * switching versions on and off.
 */
const ROLES = [ 'monitor', 'reader', 'operator', 'admin' ] as const;

type Role = (typeof ROLES)[number];

function isRole(value: unknown): value is Role {
  return (ROLES as readonly unknown[]).includes(value);
}

function allows(held: Role, required: Role): boolean {
  return ROLES.indexOf(held) >= ROLES.indexOf(required);
}

/*
 * What an authenticated request is charged and recorded as. `fingerprint` is
 * a short prefix of the token's digest: it identifies the credential for rate
 * limiting without being the token, or enough of its digest to be one.
 * `name` is who holds the token, which the audit records as the actor, and
 * `role` what it may do.
 */
type Credential = {
  fingerprint: string,
  name:        string,
  role:        Role,
};

const FINGERPRINT_LENGTH = 16;

/*
 * A token the environment takes: who holds it, its digest, what it may do,
 * and the last instant it is taken at, in milliseconds, or null for one that
 * does not expire.
 */
type Token = {
  name:     string,
  sha256:   string,
  role:     Role,
  notAfter: number | null,
};

type AdminSettings = Pick<Env, 'COMET_REGISTRY_ADMIN_TOKENS'>;

const TOKENS        = 'COMET_REGISTRY_ADMIN_TOKENS';
const MISCONFIGURED = `the administrative API is misconfigured in this environment`;

/*
 * A list the worker cannot read refuses every administrative request rather
 * than taking the entries it can: a typo must not quietly drop an expiry, or
 * keep a token somebody meant to change. Anyone may ask, so the answer names
 * the setting alone; the line logged under its request id names the entry and
 * what is wrong with it, and never a value.
 */
function malformed(problem: string): ApiError {
  return new ApiError('FORBIDDEN', `${MISCONFIGURED}: ${TOKENS} is malformed`, undefined, {}, { problem });
}

/*
 * A name is who holds a token, recorded as the actor of everything the token
 * does. It is lowercase, so a holder has one spelling, and it has no `:`, so
 * no name reads as the one the worker records by itself,
 * `registry-cron:<environment>`. It may repeat: a holder rotating a token
 * holds two for a while, under one name.
 */
const NAME   = /^[a-z0-9][a-z0-9._@-]{0,63}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/*
 * The last instant a token is taken at, in UTC. `Date.parse` moves a date
 * the calendar does not have — 2027-02-30 to March 2nd, 24:00 to the next
 * day — so an instant is taken only when it reads back as it was written: a
 * typo cannot lengthen a token's life by days.
 */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

function instantOf(value: string): number | null {
  const time = Date.parse(value);
  if (!INSTANT.test(value) || Number.isNaN(time)) {
    return null;
  }
  return new Date(time).toISOString() === (value.includes('.') ? value : value.replace('Z', '.000Z')) ? time : null;
}

/*
 * The list is one secret, and Cloudflare stores at most 5 KB in one. An
 * entry takes 120 bytes or more, so a secret holds about thirty as names and
 * expiries are usually written, and never more than forty-two. The bound is
 * above that, so it refuses no list Cloudflare stored, and it bounds what a
 * request compares where nothing else does: a local .dev.vars.
 */
const MAX_TOKENS = 50;

function tokenOf(entry: unknown, at: string): Token {
  if (typeof(entry) !== 'object' || entry === null || Array.isArray(entry)) {
    throw malformed(`${at} is not an object`);
  }
  // exactly these, so a misspelt notAfter is refused rather than read as a token that never expires
  if (Object.keys(entry).sort().join(',') !== 'name,notAfter,role,sha256') {
    throw malformed(`${at} must have exactly name, sha256, role and notAfter`);
  }
  const { name, sha256, role, notAfter } = entry as Record<string, unknown>;
  if (typeof(name) !== 'string' || !NAME.test(name)) {
    throw malformed(`${at}.name must be 1 to 64 lowercase letters, digits, '.', '_', '@' or '-', the first a letter or a digit`);
  }
  if (typeof(sha256) !== 'string' || !DIGEST.test(sha256.toLowerCase())) {
    throw malformed(`${at}.sha256 must be 64 hex digits`);
  }
  if (!isRole(role)) {
    throw malformed(`${at}.role must be one of ${ROLES.join(', ')}`);
  }
  const expiry = typeof(notAfter) === 'string' ? instantOf(notAfter) : null;
  if (notAfter !== null && expiry === null) {
    throw malformed(`${at}.notAfter must be null or an instant in UTC, such as 2027-05-01T00:00:00Z`);
  }
  return { name, sha256: sha256.toLowerCase(), role, notAfter: expiry };
}

// the fields of an entry, which a problem may name; any other name is the list's own text, which the log never repeats
const FIELDS: readonly string[] = [ 'name', 'sha256', 'role', 'notAfter' ];

/*
 * JSON.parse keeps the last of two fields of one name, so an entry that
 * names `notAfter` twice would be read by the last of them, and a trailing
 * `"notAfter": null` would cancel an expiry; one that names `role` twice
 * would be read by its last role. Neither says a word. So the text of a list
 * JSON.parse took is read again, for a field named twice in one object, at
 * any depth. A name is compared as JSON.parse reads it, so a letter written
 * as an escape hides no repeat. Each object's names are its own: the four
 * fields every entry has are no repeat across entries.
 *
 * The text is JSON, so a string ends at the first quote no backslash
 * escapes, and a string is a field's name where a colon follows it.
 */
function repeatedField(text: string): string | undefined {
  // for each object or list open at this point, the names of the object's fields so far, or null for a list
  const open: Array<Set<string> | null> = [];
  let entry = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at];
    if (char === '{') {
      open.push(new Set());
    } else if (char === '[') {
      open.push(null);
    } else if (char === '}' || char === ']') {
      open.pop();
    } else if (char === ',' && open.length === 1) {
      entry++;
    } else if (char === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1;
      }
      let next = end + 1;
      while (next < text.length && ' \t\n\r'.includes(text[next]!)) {
        next++;
      }
      const names = open[open.length - 1];
      if (names && text[next] === ':') {
        const name = JSON.parse(text.slice(at, end + 1)) as string;
        if (names.has(name)) {
          return `${TOKENS}[${entry}] names ${open.length === 2 && FIELDS.includes(name) ? name : 'a field'} twice`;
        }
        names.add(name);
      }
      at = end;
    }
  }
  return undefined;
}

/*
 * How long a rotation may keep the token it replaces: of two tokens of one
 * name, one must stop within this many days, counted from now. The list
 * cannot say which of them is the old token, so step 3 of "The admin tokens"
 * prints both of the holder's entries, the new one marked. Step 4 holds a
 * list to this limit before the list is put, by the clock of the machine that
 * puts it; the worker takes a day more, by its own, so the two clocks never
 * disagree on a list the check let through.
 */
const ROTATION_DAYS = 30;
const WORKER_ROTATION_DAYS = ROTATION_DAYS + 1;

/*
 * The tokens of COMET_REGISTRY_ADMIN_TOKENS, a JSON list of
 * `{ name, sha256, role, notAfter }`, or none while it is unset or blank. A
 * secret is a string; a list or a number, which only wrangler.toml [vars]
 * can give, is a list the worker cannot read. Whether one of a name's two
 * tokens stops soon enough is counted from now, so a list taken once stays
 * taken.
 */
function listedTokens(value: unknown, now: number = Date.now(), rotationDays: number = WORKER_ROTATION_DAYS): Token[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (typeof(value) !== 'string') {
    throw malformed(`${TOKENS} is not a string`);
  }
  if (value.trim().length === 0) {
    return [];
  }
  let list: unknown;
  try {
    list = JSON.parse(value);
  } catch {
    throw malformed(`${TOKENS} is not JSON`);
  }
  if (!Array.isArray(list)) {
    throw malformed(`${TOKENS} is not a list`);
  }
  const repeated = repeatedField(value);
  if (repeated !== undefined) {
    throw malformed(repeated);
  }
  if (list.length > MAX_TOKENS) {
    throw malformed(`${TOKENS} lists more than ${MAX_TOKENS} tokens`);
  }
  const tokens: Token[] = [];
  for (const [ index, entry ] of list.entries()) {
    const token = tokenOf(entry, `${TOKENS}[${index}]`);
    // a token has one holder and one role, or the audit could not say who used it
    const first = tokens.findIndex(other => other.sha256 === token.sha256);
    if (first >= 0) {
      throw malformed(`${TOKENS}[${index}] names the same token as [${first}]`);
    }
    // a name has a second token only while its holder rotates, and one of the two stops within rotationDays
    const lasting = (listed: Token) => listed.notAfter === null || listed.notAfter > now + rotationDays * 86_400_000;
    const open = lasting(token) ? tokens.findIndex(other => other.name === token.name && lasting(other)) : -1;
    if (open >= 0) {
      throw malformed(`${TOKENS}[${index}] and [${open}] are two tokens of ${token.name} that last more than ${rotationDays} days: give the one being replaced a notAfter within ${ROTATION_DAYS} days`);
    }
    tokens.push(token);
  }
  return tokens;
}

/*
 * Verifies the request against the tokens the environment lists. An
 * environment that lists none — no list, a blank one or `[]` — refuses every
 * administrative request rather than defaulting to open: an unconfigured
 * admin API is a closed one. The configuration is read before the request,
 * so a misconfigured environment answers the same whatever a request sends.
 */
async function authenticateAdmin(request: Request, settings: AdminSettings, now: number = Date.now()): Promise<Credential> {
  const tokens = listedTokens(settings.COMET_REGISTRY_ADMIN_TOKENS, now);
  if (tokens.length === 0) {
    throw new ApiError('FORBIDDEN', `the administrative API is not configured in this environment`);
  }
  const presented = await sha256Hex(bearerToken(request));
  // every entry is compared, a match or not, so the time taken says nothing of which one matched
  let matched: Token | null = null;
  for (const token of tokens) {
    if (equalsFixedTime(presented, token.sha256)) {
      matched = token;
    }
  }
  if (matched === null) {
    throw unauthorized(`the bearer token is not valid`, 'Bearer error="invalid_token"');
  }
  /*
   * An expired token is refused as a wrong one is, but says so, and its
   * holder knows to use the token that replaced it. Whose it was goes to the
   * log alone: an old token still in use may be one that leaked.
   */
  if (matched.notAfter !== null && now > matched.notAfter) {
    throw unauthorized(`the bearer token has expired`, 'Bearer error="invalid_token"', { name: matched.name });
  }
  return { fingerprint: presented.slice(0, FINGERPRINT_LENGTH), name: matched.name, role: matched.role };
}

/*
 * A valid token, on a route its role does not reach: RFC 6750's
 * insufficient_scope, which is a 403. The answer, and the line logged about
 * it, say whose token it was and which role the route needs.
 */
function refuseRole(credential: Credential, required: Role): ApiError {
  return new ApiError(
    'FORBIDDEN',
    `the token ${credential.name} has the role ${credential.role}, and this route needs ${required}`,
    { role: credential.role, requiredRole: required },
    { 'WWW-Authenticate': 'Bearer error="insufficient_scope"' },
    { name: credential.name, role: credential.role, requiredRole: required },
  );
}

export type { Credential, Role };
export { ROLES, ROTATION_DAYS, allows, authenticateAdmin, listedTokens, refuseRole, sha256Hex };
