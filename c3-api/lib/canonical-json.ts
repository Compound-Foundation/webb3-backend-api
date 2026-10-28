/*
 * JSON with object keys in a fixed order.
 *
 * A digest of a value must depend on what the value says, not on the order in
 * which the code that built it happened to assign properties: the same
 * snapshot is built by the importer and read back from rows, and both must
 * hash to the same checksum.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof(value) === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([ , entry ]) => entry !== undefined)
      .sort(([ left ], [ right ]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([ key, entry ]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export { canonicalJson };
