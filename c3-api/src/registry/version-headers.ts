/*
 * How a response names the registry version it was computed from.
 *
 * One builder, because these two headers are the contract a client uses to
 * tell two answers apart, and they are set from three places: the registry's
 * own reads, failed ones included, an activation result, and every legacy
 * route that resolved a market. Renaming or adding to the pair must not mean
 * finding every copy.
 */
type VersionRef = {
  id:       string,
  checksum: string,
};

function registryHeaders({ id, checksum }: VersionRef): Record<string, string> {
  return {
    'X-Registry-Version':  id,
    'X-Registry-Checksum': checksum,
  };
}

export type { VersionRef };
export { registryHeaders };
