type Value = (
  | string
  | number
  | boolean
  | null
  | Value[]
  | ArrayLike<Value>
  | Object
);

type Object = { [K in keyof any]: Value }

interface Stringifiable {
  toJSON(): Value;
}

type Representable = (
  | string
  | number
  | boolean
  | null
  | Stringifiable
  | Representable[]
  | ArrayLike<Representable>
  | { [K in keyof any]: Representable }
);

interface Reviver<T = unknown> {
  accept(value: any): boolean;
  revive(value: any): T;
}

function isStringifiable(target: any): target is Stringifiable {
  return target !== null
      && typeof(target) === 'object'
      && typeof(target['toJSON']) === 'function';
}

function isArrayLike<T>(value: T): value is Extract<T, ArrayLike<any>> {
  return value !== null
      && typeof(value) === 'object'
      && 'length' in value
      && typeof(value['length']) === 'number'
      && Object.keys(value).every(k => /length|\d+/.test(k));
}

function from(value: Representable): Value {
  return walk(value, from);
}

function revive(value: Representable, revivers: Reviver[]): unknown {
  for (const reviver of revivers) {
    if (reviver.accept(value)) {
      return reviver.revive(value);
    }
  }
  return walk(value, node => revive(node, revivers));
}

function parse(source: string, revivers: Reviver[]): unknown {
  return JSON.parse(source, (_key, value) => {
    for (const reviver of revivers) {
      if (reviver.accept(value)) {
        return reviver.revive(value);
      }
    }
    return value;
  });
}

function walk(value: Representable, fn: (_: Representable) => any) {
  // object may customize its json representation with toJSON
  if (isStringifiable(value)) {
    return value.toJSON();
  }
  // if the value is null or another non-aggregate value, just return it
  if (value === null || (typeof(value) !== 'object')) {
    return value;
  }
  // if the object is an array, convert every item to json
  if (isArrayLike(value)) {
    return Array.from(value).map(item => fn(item));
  }
  // if it's a non-array object, convert every property to json
  const object: any = {};
  for (const key of Object.keys(value)) {
    object[key] = fn(value[key]);
  }
  return object;
}

export { from, revive, parse };

export type {
  Value,
  Reviver,
  Stringifiable,
  Representable,
  Object,
};
