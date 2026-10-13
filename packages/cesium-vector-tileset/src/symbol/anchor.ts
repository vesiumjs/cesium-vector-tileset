import type { TransferRegistry } from '../worker/transfer-registry';

import Point from '@mapbox/point-geometry';

export class Anchor extends Point {
  segment?: number;

  constructor(x: number, y: number, segment?: number) {
    super(x, y);
    if (segment !== undefined) {
      this.segment = segment;
    }
  }

  clone(): Anchor {
    return new Anchor(this.x, this.y, this.segment);
  }
}

export function registerAnchorTransfers(registry: TransferRegistry): void {
  registry.register('Anchor', Anchor);
}
