/**
 * Ensures that a value is an `Error` instance.
 * If the value is already an `Error`, it is returned as-is.
 * Otherwise, a new `Error` is created from its string representation.
 */
export function ensureError(e: unknown): Error {
  if (e instanceof Error)
    return e;
  return new Error(typeof e === 'string' ? e : String(e));
}

/**
 * A type guard that narrows an unknown value to an object carrying an HTTP `status` code,
 * e.g. the `AJAXError` thrown by the network stack.
 */
export function hasHttpStatus(error: unknown): error is Error & { status: number } {
  return typeof error === 'object' && error !== null && 'status' in error;
}

/**
 * Print a warning message to the console and ensure duplicate warning messages
 * are not printed.
 */
const warnOnceHistory: { [key: string]: boolean } = {};

export function warnOnce(message: string): void {
  if (!warnOnceHistory[message]) {
    // console isn't defined in some WebWorkers, see #2558
    if (typeof console !== 'undefined')
      console.warn(message);
    warnOnceHistory[message] = true;
  }
}
