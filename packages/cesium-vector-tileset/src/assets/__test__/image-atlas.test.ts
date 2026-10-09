import type { StyleImage } from '../../style/style-image';
import { describe, expect, it, vi } from 'vitest';
import { patternAtlasKey } from '../../render/pattern/pattern-renderer';
import { RGBAImage } from '../../util/image';
import { ImageAtlas } from '../image-atlas';
import { SharedAtlasTextures } from '../shared-atlas-textures';
import { StyleImages } from '../style-images';

const colors = [
  [255, 0, 0, 255],
  [0, 255, 0, 255],
  [0, 0, 255, 255],
  [0, 255, 255, 255],
  [255, 0, 255, 255],
  [255, 255, 0, 255],
];
const wrappedColors = [
  [5, 3, 4, 5, 3],
  [2, 0, 1, 2, 0],
  [5, 3, 4, 5, 3],
  [2, 0, 1, 2, 0],
];

function image(pixels = colors): StyleImage {
  return {
    data: new RGBAImage({ width: 3, height: 2 }, Uint8Array.from(pixels.flat())),
    pixelRatio: 1,
    sdf: false,
    version: 0,
  };
}

function pixel(atlas: ImageAtlas, x: number, y: number): number[] {
  const offset = (y * atlas.image.width + x) * 4;
  return Array.from(atlas.image.data.subarray(offset, offset + 4));
}

function patternPixels(atlas: ImageAtlas): number[][][] {
  const { x, y } = atlas.patternPositions.repeat.paddedRect;
  return Array.from({ length: 4 }, (_, row) => Array.from({ length: 5 }, (_, column) => pixel(atlas, x + column, y + row)));
}

describe('pattern image atlas', () => {
  it('shares unchanged tile sprites and replaces a retained resource after removing and readding its image id', () => {
    const images = new StyleImages();
    const shared = new SharedAtlasTextures();
    try {
      images.addImage('repeat', image());
      const original = new ImageAtlas({}, { repeat: images.getImage('repeat') });
      const originalKey = patternAtlasKey(original);
      const firstCanvas = document.createElement('canvas');
      const firstSupplier = vi.fn(() => firstCanvas);
      shared.canvas(originalKey, original.image.width, original.image.height, firstSupplier);
      shared.retain(originalKey);

      const sameSpriteTile = new ImageAtlas({}, { repeat: images.getImage('repeat') });
      const sameSpriteKey = patternAtlasKey(sameSpriteTile);
      const duplicateSupplier = vi.fn(() => document.createElement('canvas'));
      expect(shared.canvas(sameSpriteKey, sameSpriteTile.image.width, sameSpriteTile.image.height, duplicateSupplier)).toBe(firstCanvas);
      expect(sameSpriteKey).toBe(originalKey);
      expect(duplicateSupplier).not.toHaveBeenCalled();

      images.removeImage('repeat');
      images.addImage('repeat', image([...colors].reverse()));
      const replacement = new ImageAtlas({}, { repeat: images.getImage('repeat') });
      expect(pixel(original, ...original.patternPositions.repeat.tl)).toEqual([255, 0, 0, 255]);
      expect(pixel(replacement, ...replacement.patternPositions.repeat.tl)).toEqual([255, 255, 0, 255]);
      const replacementKey = patternAtlasKey(replacement);
      const replacementCanvas = document.createElement('canvas');
      const replacementSupplier = vi.fn(() => replacementCanvas);
      expect(shared.canvas(replacementKey, replacement.image.width, replacement.image.height, replacementSupplier)).toBe(replacementCanvas);
      expect(replacementKey).not.toBe(originalKey);
      expect(firstSupplier).toHaveBeenCalledOnce();
      expect(replacementSupplier).toHaveBeenCalledOnce();
      expect(shared.size).toBe(2);
    }
    finally {
      images.destroy();
      shared.clear();
    }
  });

  it('updates the complete repeat border while leaving icon padding transparent', () => {
    const original = image();
    const images = new StyleImages();
    images.addImage('repeat', original);
    const atlas = new ImageAtlas({ repeat: original }, { repeat: original });
    images.addImage('other', image());
    const latestVersion = images.getImage('other').version!;
    const replacementColors = [
      [10, 20, 30, 40],
      [50, 60, 70, 80],
      [90, 100, 110, 120],
      [130, 140, 150, 160],
      [170, 180, 190, 200],
      [210, 220, 230, 240],
    ];
    images.updateImage('repeat', { ...image(replacementColors), pixelRatio: 2 });
    expect(images.getImage('repeat').version).toBeGreaterThan(latestVersion);
    expect(images.updatedImages).toEqual({ repeat: true });
    atlas.patchUpdatedImages(images);

    expect(patternPixels(atlas)).toEqual(wrappedColors.map(row => row.map(index => replacementColors[index])));
    expect(atlas.patternPositions.repeat.displaySize).toEqual([1.5, 1]);
    const icon = atlas.iconPositions.repeat;
    expect(pixel(atlas, icon.tl[0], icon.tl[1])).toEqual(replacementColors[0]);
    expect(pixel(atlas, icon.paddedRect.x, icon.paddedRect.y)).toEqual([0, 0, 0, 0]);
    expect(pixel(atlas, icon.tl[0], icon.paddedRect.y)).toEqual([0, 0, 0, 0]);
    images.destroy();
  });
});
