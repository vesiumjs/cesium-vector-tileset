import type { TransferRegistry } from '../worker/transfer-registry';

import Point from '@mapbox/point-geometry';

export class Anchor extends Point {
  // Point's declaration exposes an `angle()` method, while MapLibre's Anchor
  // stores the line angle as data. Keep the runtime field used by the source
  // model without narrowing it against Point's incompatible declaration.
  angle: any;
  segment?: number;

  constructor(x: number, y: number, angle: number, segment?: number) {
    super(x, y);
    this.angle = angle;
    if (segment !== undefined) {
      this.segment = segment;
    }
  }

  clone(): Anchor {
    return new Anchor(this.x, this.y, this.angle, this.segment);
  }
}

export function registerAnchorTransfers(registry: TransferRegistry): void {
  registry.register('Anchor', Anchor);
}
