/**
 * A listener method used as a callback to events
 */
export type Listener = (event: Event) => void;

type Listeners = Partial<Record<string, Listener[]>>;

function _addEventListener(type: string, listener: Listener, listenerList: Listeners): void {
  const listenerExists = listenerList[type]?.includes(listener);
  if (!listenerExists) {
    listenerList[type] ||= [];
    listenerList[type]?.push(listener);
  }
}

function _removeEventListener(type: string, listener: Listener, listenerList?: Listeners): void {
  const listeners = listenerList?.[type];
  if (listeners) {
    const index = listeners.indexOf(listener);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
  }
}

/**
 * The event class
 */
export class Event {
  readonly type: string;
  /**
   * The object that fired the event. Set when the event is fired, and narrowed to a more
   * specific type (e.g. `Map`, `Marker`) by the event subclasses.
   */
  target?: unknown;

  constructor(type: string, data: unknown = {}) {
    if (typeof data === 'object' && data !== null) {
      Object.assign(this, data);
    }
    this.type = type;
  }
}

interface ErrorLike {
  message: string;
}

/**
 * An error event
 */
export class ErrorEvent extends Event {
  error: Error;

  constructor(error: ErrorLike, data: unknown = {}) {
    const properties = typeof data === 'object' && data !== null ? data : {};
    const exception = error instanceof Error ? error : new Error(error.message);
    super('error', { ...properties, error: exception });
    this.error = exception;
  }
}

/**
 * Methods mixed in to other classes for event capabilities.
 *
 * @group Event Related
 */
export abstract class Evented<EventType extends { [K in keyof EventType]: Event } = Record<string, Event>> {
  _listeners?: Listeners;
  _oneTimeListeners?: Listeners;
  _eventedParent?: Evented;
  _eventedParentData?: unknown | (() => unknown);

  /**
   * Adds a listener to a specified event type.
   *
   * @param type - The event type to add a listen for.
   * @param listener - The function to be called when the event is fired.
   * The listener function is called with the data object passed to `fire`,
   * extended with `target` and `type` properties.
   */
  on<T extends keyof EventType>(type: T, listener: (event: EventType[T]) => void): Subscription {
    this._listeners ||= {};
    _addEventListener(type as string, listener as Listener, this._listeners);

    return {
      unsubscribe: () => {
        this.off(type, listener);
      },
    };
  }

  /**
   * Removes a previously registered event listener.
   *
   * @param type - The event type to remove listeners for.
   * @param listener - The listener function to remove.
   */
  off<T extends keyof EventType>(type: T, listener: (event: EventType[T]) => void): this {
    _removeEventListener(type as string, listener as Listener, this._listeners);
    _removeEventListener(type as string, listener as Listener, this._oneTimeListeners);

    return this;
  }

  /**
   * Adds a listener that will be called only once to a specified event type.
   *
   * The listener will be called first time the event fires after the listener is registered.
   *
   * @param type - The event type to listen for.
   * @returns a promise that resolves with the event
   */
  once<T extends keyof EventType>(type: T): Promise<EventType[T]>;
  /**
   * Adds a listener that will be called only once to a specified event type.
   *
   * The listener will be called first time the event fires after the listener is registered.
   *
   * @param type - The event type to listen for.
   * @param listener - The function to be called when the event is fired the first time.
   * @returns `this` when a listener is provided
   */
  once<T extends keyof EventType>(type: T, listener: (event: EventType[T]) => void): this;
  once<T extends keyof EventType>(type: T, listener?: (event: EventType[T]) => void): this | Promise<EventType[T]> {
    if (!listener) {
      return new Promise(resolve => this.once(type, resolve));
    }
    this._oneTimeListeners ||= {};
    _addEventListener(type as string, listener as Listener, this._oneTimeListeners);

    return this;
  }

  fire(event: Event): this {
    const type = event.type;

    if (this.listens(type)) {
      event.target = this;

      // make sure adding or removing listeners inside other listeners won't cause an infinite loop
      const listeners = this._listeners?.[type]?.slice() ?? [];
      for (const listener of listeners) {
        listener.call(this, event);
      }

      const oneTimeListeners = this._oneTimeListeners?.[type]?.slice() ?? [];
      for (const listener of oneTimeListeners) {
        _removeEventListener(type, listener, this._oneTimeListeners);
        listener.call(this, event);
      }

      const parent = this._eventedParent;
      if (parent) {
        const parentData = typeof this._eventedParentData === 'function' ? this._eventedParentData() : this._eventedParentData;
        if (typeof parentData === 'object' && parentData !== null) {
          Object.assign(event, parentData);
        }
        parent.fire(event);
      }

      // To ensure that no error events are dropped, print them to the
      // console if they have no listeners.
    }
    else if (event instanceof ErrorEvent) {
      console.error(event.error);
    }

    return this;
  }

  /**
   * Returns a true if this instance of Evented or any forwardeed instances of Evented have a listener for the specified type.
   *
   * @param type - The event type
   * @returns `true` if there is at least one registered listener for specified event type, `false` otherwise
   */
  listens(type: string): boolean {
    const listeners = this._listeners?.[type];
    const oneTimeListeners = this._oneTimeListeners?.[type];
    return (listeners !== undefined && listeners.length > 0)
      || (oneTimeListeners !== undefined && oneTimeListeners.length > 0)
      || (this._eventedParent?.listens(type) ?? false);
  }

  /**
   * Bubble all events fired by this instance of Evented to this parent instance of Evented.
   */
  setEventedParent(parent?: Evented | null, data?: unknown | (() => unknown)): this {
    this._eventedParent = parent ?? undefined;
    this._eventedParentData = data;

    return this;
  }
}

/**
 * Allows to unsubscribe from events without the need to store the method reference.
 */
export interface Subscription {
  /**
   * Unsubscribes from the event.
   */
  unsubscribe: () => void;
}

export interface Subscriber {
  addEventListener: typeof window.addEventListener;
  removeEventListener: typeof window.removeEventListener;
}

/**
 * This method is used in order to register an event listener using a lambda function.
 * The return value will allow unsubscribing from the event, without the need to store the method reference.
 * @param target - The target
 * @param message - The message
 * @param listener - The listener
 * @param options - The options
 * @returns a subscription object that can be used to unsubscribe from the event
 */
export function subscribe<T extends globalThis.Event>(target: Subscriber, message: keyof WindowEventMap, listener: (event: T) => void, options: boolean | AddEventListenerOptions): Subscription {
  target.addEventListener(message, listener as EventListener, options);
  return {
    unsubscribe: () => {
      target.removeEventListener(message, listener as EventListener, options);
    },
  };
}
