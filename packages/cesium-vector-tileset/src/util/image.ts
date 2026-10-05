import type { Color } from '@maplibre/maplibre-gl-style-spec';
import type { TransferRegistry } from '../worker/transfer-registry';
import { ensureError } from './errors';

export interface Size {
  width: number;
  height: number;
}

interface Point2D {
  x: number;
  y: number;
}

interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

function createImage<T extends Partial<ImageDataLike>>(image: T, {
  width,
  height,
}: Size, channels: number, data?: Uint8Array | Uint8ClampedArray) {
  if (!data) {
    data = new Uint8Array(width * height * channels);
  }
  else if (data instanceof Uint8ClampedArray) {
    data = new Uint8Array(data.buffer);
  }
  else if (data.length !== width * height * channels) {
    throw new RangeError(`mismatched image size. expected: ${data.length} but got: ${width * height * channels}`);
  }
  image.width = width;
  image.height = height;
  image.data = data;
  return image as T & ImageDataLike;
}

function resizeImage(image: ImageDataLike, {
  width,
  height,
}: Size, channels: number) {
  if (width === image.width && height === image.height) {
    return;
  }

  const newImage = createImage({}, { width, height }, channels);

  copyImage(image, newImage, { x: 0, y: 0 }, { x: 0, y: 0 }, {
    width: Math.min(image.width, width),
    height: Math.min(image.height, height),
  }, channels);

  image.width = width;
  image.height = height;
  image.data = newImage.data;
}

function copyImage(srcImg: ImageDataLike, dstImg: ImageDataLike, srcPt: Point2D, dstPt: Point2D, size: Size, channels: number) {
  if (size.width === 0 || size.height === 0) {
    return dstImg;
  }

  if (size.width > srcImg.width
    || size.height > srcImg.height
    || srcPt.x > srcImg.width - size.width
    || srcPt.y > srcImg.height - size.height) {
    throw new RangeError('out of range source coordinates for image copy');
  }

  if (size.width > dstImg.width
    || size.height > dstImg.height
    || dstPt.x > dstImg.width - size.width
    || dstPt.y > dstImg.height - size.height) {
    throw new RangeError('out of range destination coordinates for image copy');
  }

  const srcData = srcImg.data;
  const dstData = dstImg.data;

  if (srcData === dstData)
    throw new Error('srcData equals dstData, so image is already copied');

  for (let y = 0; y < size.height; y++) {
    const srcOffset = ((srcPt.y + y) * srcImg.width + srcPt.x) * channels;
    const dstOffset = ((dstPt.y + y) * dstImg.width + dstPt.x) * channels;
    for (let i = 0; i < size.width * channels; i++) {
      dstData[dstOffset + i] = srcData[srcOffset + i];
    }
  }
  return dstImg;
}

/**
 * An image with alpha color value
 */
export class AlphaImage {
  width: number;
  height: number;
  data: Uint8Array;

  constructor(size: Size, data?: Uint8Array | Uint8ClampedArray) {
    const image = createImage(this, size, 1, data);
    this.width = image.width;
    this.height = image.height;
    this.data = image.data;
  }

  resize(size: Size): void {
    resizeImage(this, size, 1);
  }

  clone(): AlphaImage {
    return new AlphaImage({ width: this.width, height: this.height }, new Uint8Array(this.data));
  }

  static copy(srcImg: AlphaImage, dstImg: AlphaImage, srcPt: Point2D, dstPt: Point2D, size: Size): void {
    copyImage(srcImg, dstImg, srcPt, dstPt, size, 1);
  }
}

/**
 * An object to store image data not premultiplied, because ImageData is not premultiplied.
 * Premultiplication is applied in JS before uploading to a texture.
 */
export class RGBAImage {
  width: number;
  height: number;

  /**
   * data must be a Uint8Array instead of Uint8ClampedArray because texImage2D does not support Uint8ClampedArray in all browsers.
   */
  data: Uint8Array;

  constructor(size: Size, data?: Uint8Array | Uint8ClampedArray) {
    const image = createImage(this, size, 4, data);
    this.width = image.width;
    this.height = image.height;
    this.data = image.data;
  }

  resize(size: Size): void {
    resizeImage(this, size, 4);
  }

  replace(data: Uint8Array | Uint8ClampedArray, copy?: boolean): void {
    if (copy) {
      this.data.set(data);
    }
    else if (data instanceof Uint8ClampedArray) {
      this.data = new Uint8Array(data.buffer);
    }
    else {
      this.data = data;
    }
  }

  clone(): RGBAImage {
    return new RGBAImage({ width: this.width, height: this.height }, new Uint8Array(this.data));
  }

  static copy(srcImg: RGBAImage | ImageData, dstImg: RGBAImage, srcPt: Point2D, dstPt: Point2D, size: Size): void {
    copyImage(srcImg, dstImg, srcPt, dstPt, size, 4);
  }

  setPixel(row: number, col: number, value: Color): void {
    const rLocation = (row * this.width + col) * 4;
    this.data[rLocation + 0] = Math.round(value.r * 255 / value.a);
    this.data[rLocation + 1] = Math.round(value.g * 255 / value.a);
    this.data[rLocation + 2] = Math.round(value.b * 255 / value.a);
    this.data[rLocation + 3] = Math.round(value.a * 255);
  }
}

/** Returns a copy of RGBA data with premultiplied alpha. */
export function premultiplyAlpha(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    out[i + 0] = Math.round(data[i + 0] * a / 255);
    out[i + 1] = Math.round(data[i + 1] * a / 255);
    out[i + 2] = Math.round(data[i + 2] * a / 255);
    out[i + 3] = a;
  }
  return out;
}

export function registerImageTransfers(registry: TransferRegistry): void {
  registry.register('AlphaImage', AlphaImage);
  registry.register('RGBAImage', RGBAImage);
}

export function isImageBitmap(image: unknown): image is ImageBitmap {
  return typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;
}

/**
 * Converts an ArrayBuffer to an ImageBitmap.
 *
 * Used mostly for testing purposes only, because mocking libs don't know how to work with ArrayBuffers, but work
 * perfectly fine with ImageBitmaps. Might also be used for environments (other than testing) not supporting
 * ArrayBuffers.
 *
 * @param data - Data to convert
 * @param options - The options to use when creating the ImageBitmap.
 * @returns - A  promise resolved when the conversion is finished
 */
export async function arrayBufferToImageBitmap(data: ArrayBuffer, options?: ImageBitmapOptions): Promise<ImageBitmap> {
  if (data.byteLength === 0) {
    return createImageBitmap(new ImageData(1, 1), options);
  }
  const blob: Blob = new Blob([new Uint8Array(data)], { type: 'image/png' });
  try {
    return createImageBitmap(blob, options);
  }
  catch (e) {
    throw new Error(`Could not load image because of ${ensureError(e).message}. Please make sure to use a supported image type such as PNG or JPEG. Note that SVGs are not supported.`);
  }
}

const transparentPngUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQYV2NgAAIAAAUAAarVyFEAAAAASUVORK5CYII=';

/**
 * Converts an ArrayBuffer to an HTMLImageElement.
 *
 * Used mostly for testing purposes only, because mocking libs don't know how to work with ArrayBuffers, but work
 * perfectly fine with ImageBitmaps. Might also be used for environments (other than testing) not supporting
 * ArrayBuffers.
 *
 * @param data - Data to convert
 * @returns - A promise resolved when the conversion is finished
 */
export function arrayBufferToImage(data: ArrayBuffer): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img: HTMLImageElement = new Image();
    img.onload = () => {
      resolve(img);
      URL.revokeObjectURL(img.src);
      // prevent image dataURI memory leak in Safari;
      // but don't free the image immediately because it might be uploaded in the next frame
      img.onload = null;
      window.requestAnimationFrame(() => img.src = transparentPngUrl);
    };
    img.onerror = () => reject(new Error('Could not load image. Please make sure to use a supported image type such as PNG or JPEG. Note that SVGs are not supported.'));
    const blob: Blob = new Blob([new Uint8Array(data)], { type: 'image/png' });
    img.src = data.byteLength ? URL.createObjectURL(blob) : transparentPngUrl;
  });
}
