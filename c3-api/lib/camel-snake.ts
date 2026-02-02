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

export {
  camelToSnake,
  snakeifyCamelObject,
};
