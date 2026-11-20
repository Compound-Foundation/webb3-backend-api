/*
 * GitHub as the importer reads the Comet repository through it
 * (src/registry/source/github.ts): the tracked ref, main, names `commit`,
 * whose tree lists `roots`, each answered with its content. A root without
 * content is listed and never answered, and nothing but GitHub answers at
 * all: a request for either fails as a fetch that could not connect.
 * `faults` says what GitHub gets wrong: the status it answers the ref with,
 * and a tree it says it truncated. `onCommit` runs before the ref is
 * answered, for a test that does something meanwhile.
 *
 * It is a fetch, as the importer takes one; a test that runs the worker's own
 * fetch puts it in place of the global one, alone or beside a chain.
 */
type SourceRoot = { path: string, sha: string, content?: string };

type Faults = { commits?: number, truncated?: boolean };

type FakeSource = {
  fetch:    (input: Request | string, init?: RequestInit) => Promise<Response>,
  // the URLs it was asked for, in order
  requests: string[],
};

// whether the source reads `url`: one of GitHub's API or of its raw content
function isSourceUrl(url: string): boolean {
  return url.startsWith('https://api.github.com/') || url.startsWith('https://raw.githubusercontent.com/');
}

function fakeSource(
  { commit, roots = [], faults = {}, onCommit }: {
    commit:    string,
    roots?:    SourceRoot[],
    faults?:   Faults,
    onCommit?: () => Promise<unknown>,
  },
): FakeSource {
  const requests: string[] = [];
  const fetch = async (input: Request | string) => {
    const url = typeof(input) === 'string' ? input : input.url;
    requests.push(url);
    if (!isSourceUrl(url)) {
      throw new TypeError('fetch failed');
    }
    if (url.endsWith('/commits/main')) {
      await onCommit?.();
      return faults.commits === undefined ? new Response(commit) : new Response('bad gateway', { status: faults.commits });
    }
    if (url.includes('/git/trees/')) {
      return new Response(JSON.stringify({
        truncated: faults.truncated === true,
        // a root without content is listed at a size it could have
        tree: roots.map(root => ({ path: root.path, type: 'blob', sha: root.sha, size: root.content?.length ?? 100 })),
      }));
    }
    const root = roots.find(candidate => url.endsWith(candidate.path));
    if (root === undefined) {
      return new Response('not found', { status: 404 });
    }
    if (root.content === undefined) {
      throw new TypeError('fetch failed');
    }
    return new Response(root.content);
  };
  return { fetch, requests };
}

export type { FakeSource, Faults, SourceRoot };
export { fakeSource, isSourceUrl };
