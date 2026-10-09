// See https://stackoverflow.com/questions/49401866/all-possible-keys-of-an-union-type
type KeysOfUnion<T> = T extends T ? keyof T : never;

/**
 * Given an object and a number of properties as strings, return version
 * of that object with only those properties.
 *
 * @param src - the object
 * @param properties - an array of property names chosen
 * to appear on the resulting object.
 * @returns object with limited properties.
 * @example
 * ```ts
 * let foo = { name: 'Charlie', age: 10 };
 * let justName = pick(foo, ['name']); // justName = { name: 'Charlie' }
 * ```
 */
export function pick<T extends object>(src: T, properties: Array<KeysOfUnion<T>>): Partial<T> {
  const result: Partial<T> = {};
  for (const k of properties) {
    if (k in src) {
      result[k] = src[k];
    }
  }
  return result;
}

/**
 * Create an object by mapping all the values of an existing object while
 * preserving their keys.
 * @param input - the object to iterate over
 * @param iterator - the function to call with each value, key and the input object
 * @param context - an optional object used as `this` inside `iterator`
 * @returns a new object with the same keys and mapped values
 */
export function mapObject<T extends object, U>(this: unknown, input: T, iterator: (value: T[keyof T], key: string, input: T) => U, context?: unknown): Record<string, U> {
  const output: Record<string, U> = {};
  for (const key in input) {
    output[key] = iterator.call(context || this, input[key], key, input);
  }
  return output;
}

/**
 * Create an object by filtering out values of an existing object.
 * @param input - the object to iterate over
 * @param iterator - the function used to test each value, key and the input object
 * @param context - an optional object used as `this` inside `iterator`
 * @returns a partial copy of `input` containing only the entries for which `iterator` returned `true`
 */
export function filterObject<T extends object>(this: unknown, input: T, iterator: (value: T[keyof T], key: string, input: T) => boolean, context?: unknown): Partial<T> {
  const output: Partial<T> = {};
  for (const key in input) {
    if (iterator.call(context || this, input[key], key, input)) {
      output[key] = input[key];
    }
  }
  return output;
}

export function deepEqual(a?: unknown, b?: unknown): boolean {
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length)
      return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i]))
        return false;
    }
    return true;
  }
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const objectA = a as Record<string, unknown>;
    const objectB = b as Record<string, unknown>;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length)
      return false;
    for (const key in a) {
      if (!deepEqual(objectA[key], objectB[key]))
        return false;
    }
    return true;
  }
  return a === b;
}

/**
 * Deeply clones arrays and plain objects.
 */
export function clone<T>(input: T): T {
  if (Array.isArray(input))
    return input.map(item => clone(item)) as T;
  if (typeof input === 'object' && input !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      result[key] = clone(value);
    }
    return result as T;
  }
  return input;
}

/**
 * A helper to allow require exactly one one property
 */
export type ExactlyOne<T, Keys extends keyof T = keyof T> = {
  [K in Keys]: Required<Pick<T, K>> & { [P in Exclude<Keys, K>]?: never }
}[Keys];
