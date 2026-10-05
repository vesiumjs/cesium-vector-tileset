/** A cooperative wall-clock budget for main-thread tile work. */
export class FrameBudget {
  private readonly deadline: number;

  constructor(budgetMs: number) {
    this.deadline = performance.now() + budgetMs;
  }

  /** Whether the frame's heavy-work allowance is spent. */
  get exhausted(): boolean {
    return performance.now() >= this.deadline;
  }
}

/** A budget that never exhausts: synchronous callers and unit tests. */
export const UNBOUNDED_BUDGET: { readonly exhausted: boolean } = {
  get exhausted(): boolean {
    return false;
  },
};

export type Budget = FrameBudget | typeof UNBOUNDED_BUDGET;

/** Bound line instance/paint setup alongside the line renderer's vertex caps. */
export const MAX_LINE_INSTANCES = 512;
/** Shared by source preparation, Native first updates, building and paint. */
export const TILE_WORK_BUDGET_MS = 12;
export const MAX_TILE_COMMITS = 4;
