/**
 * Add a transferable to a message's transfer list exactly once.
 *
 * A typed-array graph frequently contains several views over the same
 * ArrayBuffer. Posting that buffer more than once is rejected by the
 * structured-clone algorithm, so deduplication belongs at the point where
 * serializers build the list rather than at individual call sites.
 *
 * The dedup state is derived from the list's current contents on every call
 * instead of being cached: transfer lists are short, and a cache keyed by
 * list identity would go stale when the list is cleared and reused
 * (`list.length = 0`), silently skipping a buffer that was already added and
 * leaving it untransferred.
 */
export function addTransferable(
  transferables: Transferable[] | undefined,
  value: Transferable,
): void {
  if (!transferables) {
    return;
  }

  if (!transferables.includes(value)) {
    transferables.push(value);
  }
}
