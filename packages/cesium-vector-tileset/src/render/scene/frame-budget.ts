/** A cooperative wall-clock budget for main-thread tile work. */
export class FrameBudget {
  private readonly deadline: number;

  /** Reuse a physical frame deadline instead of allocating more time. */
  static until(deadline: number): FrameBudget {
    return new FrameBudget(0, deadline);
  }

  constructor(budgetMs: number, deadline = performance.now() + budgetMs) {
    this.deadline = deadline;
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

export interface Budget {
  readonly exhausted: boolean;
  /** Scene-selected cooperative admission, consumable by one heavy work unit. */
  takeMinimumProgress?: () => boolean;
}

/** Bound line instance/paint setup alongside the line renderer's vertex caps. */
export const MAX_LINE_INSTANCES = 512;
export const MAX_TILE_COMMITS = 4;
