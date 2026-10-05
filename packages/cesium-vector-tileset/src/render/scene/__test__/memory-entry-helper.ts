import type { MemoryBudgetVisitor } from '../gpu-memory-budget';

/** Materialize a report only when a test needs to inspect its entries. */
export function memoryEntries(renderer: { visitMemoryEntries: (visit: MemoryBudgetVisitor) => void }): Array<{ key: string; bytes: number; pinned?: boolean }> {
  const entries: Array<{ key: string; bytes: number; pinned?: boolean }> = [];
  renderer.visitMemoryEntries((key, bytes, pinned) => {
    entries.push(pinned === undefined ? { key, bytes } : { key, bytes, pinned });
  });
  return entries;
}
