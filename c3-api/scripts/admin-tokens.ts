import { readFileSync } from 'node:fs';

import { listedTokens } from '../src/http/bearer-auth.js';
import { ApiError } from '../src/http/errors.js';

/*
 * Reads a file of admin tokens as the worker reads COMET_REGISTRY_ADMIN_TOKENS
 * (src/http/bearer-auth.ts), and prints it as the one line the secret takes.
 * A list the worker would refuse, and so close the administrative API to
 * every token, is refused here first, with the problem the worker would log,
 * and nothing is printed: step 4 of "The admin tokens" in REGISTRY_RUNBOOK.md
 * puts the list only once this has printed it.
 *
 *   npx tsc -p tsconfig.scripts.json && node dist/scripts/admin-tokens.js <file>
 *
 * The file is the list as its owner wrote it, over as many lines as they
 * like. A blank one is refused: a blank secret is no list, which nobody puts
 * by way of a file. A byte order mark before it is dropped, as editors add
 * one and the line printed has none.
 */
function refuse(problem: string): never {
  console.error(problem);
  process.exit(1);
}

const [ path, ...rest ] = process.argv.slice(2);
if (path === undefined || rest.length > 0) {
  console.error('usage: node dist/scripts/admin-tokens.js <file of the token list>');
  process.exit(2);
}

let text: string;
try {
  text = readFileSync(path, 'utf8');
} catch (error) {
  refuse(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
}
if (text.charCodeAt(0) === 0xfeff) {
  text = text.slice(1);
}
if (text.trim().length === 0) {
  refuse(`${path} is empty`);
}

try {
  if (listedTokens(text).length === 0) {
    console.error(`${path} lists no token: once it is put, the administrative API refuses every request`);
  }
} catch (error) {
  if (error instanceof ApiError) {
    refuse(String(error.logged?.['problem'] ?? error.message));
  }
  throw error;
}

process.stdout.write(`${JSON.stringify(JSON.parse(text))}\n`);
