import type { Test } from 'tap';

type Level = 'error' | 'warn' | 'log';

/*
 * What the console is given at `levels` for the length of a test, in place of
 * writing it: a line a call, its arguments as String writes them, joined by a
 * space. With `prefixed`, each line starts with its level (`warn: …`), so the
 * levels can share one list and still be told apart.
 */
function consoleLines(t: Test, levels: Level[], { prefixed = false }: { prefixed?: boolean } = {}): string[] {
  const lines: string[] = [];
  for (const level of levels) {
    t.capture(console, level, (...parameters: unknown[]) => {
      const line = parameters.map(String).join(' ');
      lines.push(prefixed ? `${level}: ${line}` : line);
    });
  }
  return lines;
}

export { consoleLines };
