import type { StyleImage, TextFit } from '../style/style-image';
import type { GetImagesResponse } from '../worker/messages';

import type { TransferRegistry } from '../worker/transfer-registry';
import type { Rect } from './glyph-atlas';
import type { StyleImages } from './style-images';
import potpack from 'potpack';
import { RGBAImage } from '../util/image';

const IMAGE_PADDING: number = 1;
export { IMAGE_PADDING };

export class ImagePosition {
  paddedRect: Rect;
  pixelRatio: number;
  version?: number;
  stretchY?: Array<[number, number]>;
  stretchX?: Array<[number, number]>;
  content?: [number, number, number, number];
  textFitWidth?: TextFit;
  textFitHeight?: TextFit;

  constructor(paddedRect: Rect, {
    pixelRatio,
    version,
    stretchX,
    stretchY,
    content,
    textFitWidth,
    textFitHeight,
  }: StyleImage) {
    this.paddedRect = paddedRect;
    this.pixelRatio = pixelRatio;
    this.stretchX = stretchX;
    this.stretchY = stretchY;
    this.content = content;
    this.version = version;
    this.textFitWidth = textFitWidth;
    this.textFitHeight = textFitHeight;
  }

  get tl(): [number, number] {
    return [
      this.paddedRect.x + IMAGE_PADDING,
      this.paddedRect.y + IMAGE_PADDING,
    ];
  }

  get br(): [number, number] {
    return [
      this.paddedRect.x + this.paddedRect.w - IMAGE_PADDING,
      this.paddedRect.y + this.paddedRect.h - IMAGE_PADDING,
    ];
  }

  get tlbr(): [number, number, number, number] {
    const [tlX, tlY] = this.tl;
    const [brX, brY] = this.br;
    return [tlX, tlY, brX, brY];
  }

  get displaySize(): [number, number] {
    return [
      (this.paddedRect.w - IMAGE_PADDING * 2) / this.pixelRatio,
      (this.paddedRect.h - IMAGE_PADDING * 2) / this.pixelRatio,
    ];
  }
}

/** A linear sample at a repeat boundary also reads the opposite corner. */
function copyPatternImage(source: RGBAImage, target: RGBAImage, position: ImagePosition): void {
  const [x, y] = position.tl;
  const { width, height } = source;
  RGBAImage.copy(source, target, { x: 0, y: 0 }, { x, y }, source);
  RGBAImage.copy(source, target, { x: 0, y: height - 1 }, { x, y: y - 1 }, { width, height: 1 });
  RGBAImage.copy(source, target, { x: 0, y: 0 }, { x, y: y + height }, { width, height: 1 });
  RGBAImage.copy(source, target, { x: width - 1, y: 0 }, { x: x - 1, y }, { width: 1, height });
  RGBAImage.copy(source, target, { x: 0, y: 0 }, { x: x + width, y }, { width: 1, height });
  RGBAImage.copy(source, target, { x: width - 1, y: height - 1 }, { x: x - 1, y: y - 1 }, { width: 1, height: 1 });
  RGBAImage.copy(source, target, { x: 0, y: height - 1 }, { x: x + width, y: y - 1 }, { width: 1, height: 1 });
  RGBAImage.copy(source, target, { x: width - 1, y: 0 }, { x: x - 1, y: y + height }, { width: 1, height: 1 });
  RGBAImage.copy(source, target, { x: 0, y: 0 }, { x: x + width, y: y + height }, { width: 1, height: 1 });
}

/**
 * A class holding all the images
 */
export class ImageAtlas {
  image: RGBAImage;
  iconPositions: Record<string, ImagePosition>;
  patternPositions: Record<string, ImagePosition>;
  haveRenderCallbacks: string[];
  /** Monotonic version for runtime image patches applied to this atlas. */
  revision = 0;
  /**
   * StyleImages revision covered by the last patch pass.
   */
  private _imageUpdateRevision = -1;

  constructor(icons: GetImagesResponse, patterns: GetImagesResponse) {
    const iconPositions: Record<string, ImagePosition> = {};
    const patternPositions: Record<string, ImagePosition> = {};
    this.haveRenderCallbacks = [];

    const bins: Rect[] = [];

    this.addImages(icons, iconPositions, bins);
    this.addImages(patterns, patternPositions, bins);

    const { w, h } = potpack(bins);
    const image = new RGBAImage({ width: w || 1, height: h || 1 });

    for (const id in icons) {
      const src = icons[id];
      const bin = iconPositions[id].paddedRect;
      RGBAImage.copy(src.data, image, { x: 0, y: 0 }, { x: bin.x + IMAGE_PADDING, y: bin.y + IMAGE_PADDING }, src.data);
    }

    for (const id in patterns) {
      copyPatternImage(patterns[id].data, image, patternPositions[id]);
    }

    this.image = image;
    this.iconPositions = iconPositions;
    this.patternPositions = patternPositions;
  }

  addImages(images: Record<string, StyleImage>, positions: Record<string, ImagePosition>, bins: Rect[]): void {
    for (const id in images) {
      const src = images[id];
      const bin = {
        x: 0,
        y: 0,
        w: src.data.width + 2 * IMAGE_PADDING,
        h: src.data.height + 2 * IMAGE_PADDING,
      };
      bins.push(bin);
      positions[id] = new ImagePosition(bin, src);

      if (src.hasRenderCallback) {
        this.haveRenderCallbacks.push(id);
      }
    }
  }

  patchUpdatedImages(images: StyleImages): void {
    images.dispatchRenderCallbacks(this.haveRenderCallbacks);
    if (this._imageUpdateRevision === images.imageUpdateRevision) {
      return;
    }
    let changed = false;
    for (const name in images.updatedImages) {
      changed = this.patchUpdatedImage(this.iconPositions[name], images.getImage(name), false) || changed;
      changed = this.patchUpdatedImage(this.patternPositions[name], images.getImage(name), true) || changed;
    }
    if (changed) {
      this.revision++;
    }
    this._imageUpdateRevision = images.imageUpdateRevision;
  }

  patchUpdatedImage(position: ImagePosition | undefined, image: StyleImage, pattern: boolean): boolean {
    if (!position || !image)
      return false;

    if (position.version === image.version)
      return false;

    position.version = image.version;
    // Runtime image updates may keep the bitmap dimensions but change the
    // device-pixel ratio. Pattern display size is derived from this metadata,
    // so retain the updated value alongside the copied pixels.
    position.pixelRatio = image.pixelRatio;
    if (pattern) {
      copyPatternImage(image.data, this.image, position);
    }
    else {
      const [x, y] = position.tl;
      RGBAImage.copy(image.data, this.image, { x: 0, y: 0 }, { x, y }, image.data);
    }
    return true;
  }
}

export function registerImageAtlasTransfers(registry: TransferRegistry): void {
  registry.register('ImagePosition', ImagePosition);
  registry.register('ImageAtlas', ImageAtlas);
}
