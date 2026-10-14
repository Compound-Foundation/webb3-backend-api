function camelToSnake(camel: string) {
  return Array.from(camel.matchAll(/[A-Z]?[a-z]+|[A-Z]/g))
    .map(([ part ]) => part.toLowerCase())
    .join('_');
}

function snakeifyCamelObject(target: { [field: string]: any }) {
  let result = {} as any;
  for (let [ camelKey, value ] of Object.entries(target)) {
    result[camelToSnake(camelKey)] = value;
  }
  return result;
}

/*
 * The same at every depth: the keys of every plain object the target holds,
 * in another object or in an array, are renamed too. Any other value is kept
 * as it is, an instance of a class too: renamed field by field, a BigNumber
 * would no longer be one.
 */
function snakeifyCamelObjectDeep(target: { [field: string]: any }) {
  let result = {} as any;
  for (let [ camelKey, value ] of Object.entries(target)) {
    result[camelToSnake(camelKey)] = snakeifyDeep(value);
  }
  return result;
}

function snakeifyDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(snakeifyDeep);
  }
  return isPlainObject(value) ? snakeifyCamelObjectDeep(value) : value;
}

function isPlainObject(value: unknown): value is { [field: string]: unknown } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export {
  camelToSnake,
  snakeifyCamelObject,
  snakeifyCamelObjectDeep,
};
