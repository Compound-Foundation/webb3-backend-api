import t from 'tap';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256 } from '../../lib/hash.js';

/*
 * The check step 4 of "The admin tokens" (REGISTRY_RUNBOOK.md) runs before it
 * puts a list: a list the worker would take is printed on one line, and one
 * it would refuse, which would close the administrative API to every token,
 * is refused with the problem the worker would log, and nothing printed, so
 * the step puts nothing.
 */
// the compiled check beside the compiled test, given to fileURLToPath as a string: the worker's URL type is not Node's
const SCRIPT    = fileURLToPath(new URL('../../scripts/admin-tokens.js', import.meta.url).href);
const directory = mkdtempSync(join(tmpdir(), 'admin-tokens-'));
t.teardown(() => rmSync(directory, { recursive: true, force: true }));

function check(name: string, text?: string): { status: number | null, stdout: string, stderr: string, path: string } {
  const path = join(directory, name);
  if (text !== undefined) {
    writeFileSync(path, text);
  }
  const { status, stdout, stderr } = spawnSync(process.execPath, [ SCRIPT, path ], { encoding: 'utf8' });
  return { status, stdout, stderr, path };
}

const alice = await sha256('alice-token');
const olga  = await sha256('olga-token');
const head  = `"name": "alice", "sha256": "${alice}", "role": "admin"`;
const LIST  = `[\n  { ${head}, "notAfter": null },\n  { "name": "olga", "sha256": "${olga}", "role": "operator", "notAfter": "2027-05-01T00:00:00Z" }\n]\n`;

t.test('a list the worker takes is printed on one line', async t => {
  const line = `${JSON.stringify(JSON.parse(LIST))}\n`;
  for (const [ what, text ] of [ [ 'as its owner writes it', LIST ], [ 'after a byte order mark', `\u{feff}${LIST}` ] ] as const) {
    const { status, stdout, stderr } = check(`taken-${what.length}.json`, text);
    t.equal(status, 0, `a list ${what} is taken`);
    t.equal(stdout, line, 'and printed as one line');
    t.equal(stderr, '', 'with nothing said');
  }

  const empty = check('empty-list.json', '[]\n');
  t.equal(empty.status, 0, 'an empty list is taken');
  t.equal(empty.stdout, '[]\n', 'and printed');
  t.match(empty.stderr, /lists no token: once it is put, the administrative API refuses every request/, 'with a word on what it does');
});

t.test('a list the worker refuses is refused, with its problem, and nothing is printed', async t => {
  const files: Array<[ string, string, string ]> = [
    [ 'a field named twice',         `[{ ${head}, "notAfter": "2027-05-01T00:00:00Z", "notAfter": null }]`, 'COMET_REGISTRY_ADMIN_TOKENS[0] names notAfter twice' ],
    [ 'a second list after the first', `[]\n${LIST}`,                                                    'COMET_REGISTRY_ADMIN_TOKENS is not JSON' ],
    [ 'a hash as shasum prints it',  `[{ "name": "alice", "sha256": "${alice}  -", "role": "admin", "notAfter": null }]`,
      'COMET_REGISTRY_ADMIN_TOKENS[0].sha256 must be 64 hex digits' ],
    [ 'a hash not yet filled in',    `[{ "name": "olga", "sha256": "<her token's hash>", "role": "operator", "notAfter": null }]`,
      'COMET_REGISTRY_ADMIN_TOKENS[0].sha256 must be 64 hex digits' ],
    [ 'NaN for an expiry',           `[{ ${head}, "notAfter": NaN }]`,                                   'COMET_REGISTRY_ADMIN_TOKENS is not JSON' ],
    [ 'a field besides the four',    `[{ ${head}, "notAfter": null, "comment": "x" }]`,
      'COMET_REGISTRY_ADMIN_TOKENS[0] must have exactly name, sha256, role and notAfter' ],
    [ 'a rotation with no cutoff',   `[{ ${head}, "notAfter": null }, { "name": "alice", "sha256": "${'b'.repeat(64)}", "role": "admin", "notAfter": null }]`,
      'COMET_REGISTRY_ADMIN_TOKENS[1] and [0] are two tokens of alice that last more than 30 days: give the one being replaced a notAfter within 30 days' ],
    [ 'a rotation whose cutoff is far off', `[{ ${head}, "notAfter": "9999-12-31T23:59:59Z" }, { "name": "alice", "sha256": "${'b'.repeat(64)}", "role": "admin", "notAfter": null }]`,
      'COMET_REGISTRY_ADMIN_TOKENS[1] and [0] are two tokens of alice that last more than 30 days: give the one being replaced a notAfter within 30 days' ],
  ];
  for (const [ what, text, problem ] of files) {
    const { status, stdout, stderr } = check(`refused-${files.findIndex(([ other ]) => other === what)}.json`, text);
    t.equal(status, 1, `${what} is refused`);
    t.equal(stdout, '', 'and nothing is printed');
    t.equal(stderr, `${problem}\n`, `with the problem: ${problem}`);
  }

  const blank = check('blank.json', ' \n');
  t.equal(blank.status, 1, 'a blank file is refused');
  t.equal(blank.stdout, '', 'and nothing is printed');
  t.equal(blank.stderr, `${blank.path} is empty\n`, 'as empty');

  const missing = check('missing.json');
  t.equal(missing.status, 1, 'a file that is not there is refused');
  t.equal(missing.stdout, '', 'and nothing is printed');
  t.ok(missing.stderr.startsWith(`cannot read ${missing.path}: `), 'as one it cannot read');
});

t.test('the check takes one file', async t => {
  for (const args of [ [], [ 'a.json', 'b.json' ] ]) {
    const { status, stdout, stderr } = spawnSync(process.execPath, [ SCRIPT, ...args ], { encoding: 'utf8' });
    t.equal(status, 2, `${args.length} files is a usage error`);
    t.equal(stdout, '', 'and prints nothing');
    t.match(stderr, /^usage: node dist\/scripts\/admin-tokens\.js <file of the token list>/, 'but how to use it');
  }
});
