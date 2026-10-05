import { isImageBitmap } from '../util/image';
import { addTransferable } from './transferables';

interface SerializedObject {
  [key: string]: Serialized;
}

export type Serialized = null | undefined | boolean | number | string | Date | RegExp | ArrayBuffer | ArrayBufferView | ImageData | ImageBitmap | Blob | Map<unknown, unknown> | Set<unknown> | Serialized[] | SerializedObject;

interface TransferConstructor {
  new (...args: any[]): any;
  serialize?: (input: any, transferables?: Transferable[]) => SerializedObject;
  deserialize?: (input: any) => unknown;
}

interface RegisterOptions<T> {
  omit?: readonly (keyof T)[];
  shallow?: readonly (keyof T)[];
  serialize?: (input: T) => Record<string, unknown>;
  restore?: (input: T) => void;
}

interface Registration {
  name: string;
  constructor: TransferConstructor;
  omit: readonly string[];
  shallow: readonly string[];
  serialize?: (input: any) => Record<string, unknown>;
  restore?: (input: any) => void;
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer || Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

/** Class codecs belong to an channel, without modifying shared constructors. */
export class TransferRegistry {
  private readonly registrations = new Map<string, Registration>();
  private readonly constructors = new WeakMap<object, Registration>();

  register<T>(name: string, constructor: new (...args: any[]) => T, options: RegisterOptions<T> = {}): void {
    if (this.registrations.has(name) || this.constructors.has(constructor)) {
      throw new Error(`${name} is already registered.`);
    }
    const registration: Registration = {
      name,
      constructor: constructor as TransferConstructor,
      omit: options.omit as readonly string[] ?? [],
      shallow: options.shallow as readonly string[] ?? [],
      serialize: options.serialize,
      restore: options.restore,
    };
    this.registrations.set(name, registration);
    this.constructors.set(constructor, registration);
  }

  hasConstructor(constructor: object): boolean {
    return this.constructors.has(constructor);
  }

  private registrationFor(input: object): Registration | undefined {
    // Generated aliases inherit a layout codec; preserve its wire identity.
    let constructor: object | null = input.constructor;
    while (constructor) {
      const registration = this.constructors.get(constructor);
      if (registration) {
        return registration;
      }
      constructor = Object.getPrototypeOf(constructor);
    }
    return undefined;
  }

  private isBuiltin(input: unknown): boolean {
    if (input === null || input === undefined || typeof input !== 'object') {
      return typeof input !== 'function' && typeof input !== 'symbol' && typeof input !== 'bigint';
    }
    const registration = this.registrationFor(input);
    if (registration && registration.name !== 'Object') {
      return false;
    }
    return input instanceof Date || input instanceof RegExp || input instanceof Blob
      || input instanceof Map || input instanceof Set || input instanceof Error
      || Object.prototype.toString.call(input) === '[object DOMException]'
      || isArrayBuffer(input) || isImageBitmap(input) || ArrayBuffer.isView(input)
      || (typeof ImageData !== 'undefined' && input instanceof ImageData);
  }

  serialize(input: unknown, transferables?: Transferable[]): Serialized {
    if (Array.isArray(input)) {
      return input.map(value => this.serialize(value, transferables));
    }
    if (this.isBuiltin(input)) {
      if (isArrayBuffer(input) || isImageBitmap(input)) {
        addTransferable(transferables, input);
      }
      else if (ArrayBuffer.isView(input)) {
        addTransferable(transferables, input.buffer as Transferable);
      }
      else if (typeof ImageData !== 'undefined' && input instanceof ImageData) {
        addTransferable(transferables, input.data.buffer);
      }
      return input as Serialized;
    }
    if (input === null || typeof input !== 'object') {
      throw new TypeError(`can't serialize object of type ${typeof input}`);
    }
    const registration = this.registrationFor(input);
    if (!registration) {
      throw new Error(`can't serialize object of unregistered class ${input.constructor.name}`);
    }
    const properties = registration.constructor.serialize?.(input, transferables) ?? {};
    if (!registration.constructor.serialize) {
      const inputProperties = (registration.serialize?.(input) ?? input) as Record<string, unknown>;
      for (const key in inputProperties) {
        if (!Object.hasOwn(inputProperties, key)) {
          continue;
        }
        const value = inputProperties[key];
        if (value !== undefined && !registration.omit.includes(key)) {
          properties[key] = registration.shallow.includes(key) ? value as Serialized : this.serialize(value, transferables);
        }
      }
      if (input instanceof Error) {
        properties.message = input.message;
      }
    }
    if (Object.hasOwn(properties, '$name')) {
      throw new Error('$name property is reserved for worker serialization logic.');
    }
    if (registration.name !== 'Object') {
      properties.$name = registration.name;
    }
    return properties;
  }

  /**
   * Consume an channel-owned structured-clone payload, restoring its objects in
   * place. Callers must not reuse the serialized input after deserialization.
   */
  deserialize(input: Serialized): unknown {
    if (Array.isArray(input)) {
      const length = input.length;
      for (let index = 0; index < length; index++) {
        if (index in input) {
          input[index] = this.deserialize(input[index]) as Serialized;
        }
      }
      return input;
    }
    if (this.isBuiltin(input)) {
      return input;
    }
    if (input === null || typeof input !== 'object') {
      throw new TypeError(`can't deserialize object of type ${typeof input}`);
    }
    const name = (input as SerializedObject).$name ?? 'Object';
    const registration = typeof name === 'string' ? this.registrations.get(name) : undefined;
    if (!registration) {
      throw new Error(`can't deserialize unregistered class ${name}`);
    }
    if (registration.constructor.deserialize) {
      return registration.constructor.deserialize(input);
    }
    const properties = input as Record<string, unknown>;
    for (const key in properties) {
      if (Object.hasOwn(properties, key) && key !== '$name' && !registration.shallow.includes(key)) {
        properties[key] = this.deserialize(properties[key] as Serialized);
      }
    }
    delete properties.$name;
    if (registration.name !== 'Object') {
      Object.setPrototypeOf(properties, registration.constructor.prototype);
    }
    registration.restore?.(properties);
    return properties;
  }
}
