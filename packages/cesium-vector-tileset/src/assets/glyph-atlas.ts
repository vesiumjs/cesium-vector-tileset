import type { GlyphMetrics } from '../style/style-glyph';
import type { GetGlyphsResponse } from '../worker/messages';
import type { TransferRegistry } from '../worker/transfer-registry';

import potpack from 'potpack';
import { AlphaImage } from '../util/image';

const padding = 1;

/**
 * A rectangle type with position, width and height.
 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The glyph's position
 */
export interface GlyphPosition {
  rect: Rect;
  metrics: GlyphMetrics;
}

/**
 * The glyphs' positions
 */
export interface GlyphPositions {
  [stack: string]: Record<number, GlyphPosition>;
}

export class GlyphAtlas {
  image: AlphaImage;
  positions: GlyphPositions;

  constructor(stacks: GetGlyphsResponse) {
    const positions: GlyphPositions = {};
    const bins: Rect[] = [];

    for (const stack in stacks) {
      const glyphs = stacks[stack];
      const stackPositions: Record<number, GlyphPosition> = {};
      positions[stack] = stackPositions;

      for (const id in glyphs) {
        const src = glyphs[+id];
        if (!src || src.bitmap.width === 0 || src.bitmap.height === 0)
          continue;

        const bin = {
          x: 0,
          y: 0,
          w: src.bitmap.width + 2 * padding,
          h: src.bitmap.height + 2 * padding,
        };
        bins.push(bin);
        stackPositions[id] = { rect: bin, metrics: src.metrics };
      }
    }

    const { w, h } = potpack(bins);
    const image = new AlphaImage({ width: w || 1, height: h || 1 });

    for (const stack in stacks) {
      const glyphs = stacks[stack];

      for (const id in glyphs) {
        const src = glyphs[+id];
        if (!src || src.bitmap.width === 0 || src.bitmap.height === 0)
          continue;
        const bin = positions[stack][id].rect;
        AlphaImage.copy(src.bitmap, image, { x: 0, y: 0 }, { x: bin.x + padding, y: bin.y + padding }, src.bitmap);
      }
    }

    this.image = image;
    this.positions = positions;
  }
}

export function registerGlyphAtlasTransfers(registry: TransferRegistry): void {
  registry.register('GlyphAtlas', GlyphAtlas);
}
