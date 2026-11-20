import { readdirSync } from 'node:fs';

/*
 * The worker's TypeScript sources, lib/ and src/, by their paths from the
 * c3-api directory tests run from, for a test that says something is done in
 * one place only. A build left among them, in a dist directory, is not one.
 */
function sourceFiles(): string[] {
  return [ 'lib', 'src' ].flatMap(root => (readdirSync(root, { recursive: true }) as string[])
    .filter(path => path.endsWith('.ts') && !path.split('/').includes('dist'))
    .map(path => `${root}/${path}`));
}

export { sourceFiles };
