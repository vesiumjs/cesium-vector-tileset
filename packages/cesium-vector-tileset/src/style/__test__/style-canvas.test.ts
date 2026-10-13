import type { TilesetStyleSpecification } from '../../../index';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CesiumVectorTileset } from '../../../index';

const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
  [-1, 1],
  [1, 1],
  [1, -1],
  [-1, -1],
];

function createCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 16;
  return canvas;
}

function canvasStyle(canvas: string | HTMLCanvasElement): TilesetStyleSpecification {
  return {
    version: 8,
    sources: { pixels: { type: 'canvas', canvas, coordinates, animate: false } },
    layers: [{ id: 'pixels', type: 'raster', source: 'pixels' }],
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('declarative Canvas styles', () => {
  it('preserves Canvas elements and replaces an element at unchanged geographical corners', async () => {
    const original = createCanvas();
    const replacement = createCanvas();
    const tileset = new CesiumVectorTileset({ style: canvasStyle(original) });
    try {
      await tileset.whenReady();
      const source = tileset.styleSpec.sources.pixels;
      expect(source.type).toBe('canvas');
      if (source.type !== 'canvas')
        throw new Error('Canvas source was not retained');
      expect(source.canvas).toBe(original);

      tileset.setStyle(canvasStyle(replacement));
      const replaced = tileset.styleSpec.sources.pixels;
      if (replaced.type !== 'canvas')
        throw new Error('Canvas source was not retained');
      expect(replaced.canvas).toBe(replacement);
      expect(replaced.coordinates).toEqual(coordinates);
      expect(source.canvas).toBe(original);
      expect(() => tileset.setStyle(canvasStyle(replacement))).not.toThrow();
    }
    finally {
      tileset.destroy();
    }
  });

  it('loads a declarative Canvas element id from a stylesheet URL', async () => {
    const canvas = createCanvas();
    canvas.id = 'canvas-pixels';
    document.body.append(canvas);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => canvasStyle(canvas.id) }));
    const tileset = await CesiumVectorTileset.fromUrl('https://example.com/style.json');
    try {
      expect(tileset.styleSpec.sources.pixels).toEqual({ type: 'canvas', canvas: canvas.id, coordinates, animate: false });
    }
    finally {
      tileset.destroy();
    }
  });

  it.each([
    { change: { animate: 0 }, message: /animate.*boolean expected/ },
    { change: { coordinates: coordinates.slice(0, 3) }, message: /coordinates.*length 4/ },
    { change: { unexpected: true }, message: /unknown property "unexpected"/ },
    { change: { canvas: 42 }, message: /canvas.*string or HTMLCanvasElement expected/ },
  ])('rejects invalid Canvas source fields from JSON: $change', async ({ change, message }) => {
    const canvas = createCanvas();
    canvas.id = 'canvas-pixels';
    document.body.append(canvas);
    const specification = canvasStyle(canvas.id);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ...specification, sources: { pixels: { ...specification.sources.pixels, ...change } } }),
    }));
    await expect(CesiumVectorTileset.fromUrl('https://example.com/style.json')).rejects.toThrow(message);
  });
});
