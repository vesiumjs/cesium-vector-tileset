import type { StyleImage } from '../style/style-image';
import type { GetImagesResponse } from '../worker/messages';
import { renderStyleImage } from '../style/style-image';
import { warnOnce } from '../util/errors';
import { ErrorEvent, Evented } from '../util/evented';

import { StyleImageMissingEvent } from '../util/events';
import { RGBAImage } from '../util/image';

export type MissingImageRequestHandler = (id: string) => void | Promise<void>;

interface ImageRequestor {
  ids: string[];
  promiseResolve: (value: GetImagesResponse | PromiseLike<GetImagesResponse>) => void;
}

/**
 * StyleImages does two things:
 *
 * 1. Tracks requests for icon images from tile workers and sends responses when the requests are fulfilled.
 * 2. Rerenders renderable images once per frame.
 *
 * Pattern atlases are built per worker tile by ImageAtlas. StyleImages therefore only owns image state and
 * image callbacks; it does not duplicate the worker-side atlas implementation.
 */
export class StyleImages extends Evented {
  images: Record<string, StyleImage>;
  updatedImages: Record<string, boolean>;
  /** Monotonic revision used by atlases to avoid rescanning unchanged updates. */
  imageUpdateRevision = 0;
  /** Image ids whose render callbacks have run in the current frame. */
  callbackDispatchedThisFrame = new Set<string>();
  loaded: boolean;
  /**
   * This is used to track requests for images that are not yet available. When the image is loaded,
   * the requestors will be notified.
   */
  requestors: ImageRequestor[];

  missingImageResolver?: MissingImageRequestHandler;

  constructor() {
    super();
    this.images = {};
    this.updatedImages = {};
    this.imageUpdateRevision = 0;
    this.callbackDispatchedThisFrame.clear();
    this.loaded = false;
    this.requestors = [];
  }

  destroy(): void {
    // Remove all images.
    for (const id of Object.keys(this.images)) {
      this.removeImage(id);
    }

    this.updatedImages = {};
    this.callbackDispatchedThisFrame.clear();
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  setLoaded(loaded: boolean): void {
    if (this.loaded === loaded) {
      return;
    }

    this.loaded = loaded;

    if (loaded) {
      for (const { ids, promiseResolve } of this.requestors) {
        promiseResolve(this._getImagesForIds(ids));
      }
      this.requestors = [];
    }
  }

  getImage(id: string): StyleImage {
    const image = this.images[id];
    // Extract sprite image data on demand
    if (image && !image.data && image.spriteData) {
      const spriteData = image.spriteData;
      image.data = new RGBAImage({
        width: spriteData.width,
        height: spriteData.height,
      }, spriteData.context.getImageData(
        spriteData.x,
        spriteData.y,
        spriteData.width,
        spriteData.height,
      ).data);
      image.spriteData = undefined;
    }

    return image;
  }

  addImage(id: string, image: StyleImage): void {
    if (this.images[id])
      throw new Error(`Image id ${id} already exist, use updateImage instead`);
    if (this._validate(id, image)) {
      image.version = ++this.imageUpdateRevision;
      this.images[id] = image;
    }
  }

  _validate(id: string, image: StyleImage): boolean {
    let valid = true;
    const data = image.data || image.spriteData;
    if (!this._validateStretch(image.stretchX, data?.width)) {
      this.fire(new ErrorEvent(new Error(`Image "${id}" has invalid "stretchX" value`)));
      valid = false;
    }
    if (!this._validateStretch(image.stretchY, data?.height)) {
      this.fire(new ErrorEvent(new Error(`Image "${id}" has invalid "stretchY" value`)));
      valid = false;
    }
    if (!this._validateContent(image, image.content)) {
      this.fire(new ErrorEvent(new Error(`Image "${id}" has invalid "content" value`)));
      valid = false;
    }
    return valid;
  }

  _validateStretch(stretch?: Array<[number, number]>, size?: number): boolean {
    if (!stretch)
      return true;
    if (size === undefined)
      return false;
    let last = 0;
    for (const part of stretch) {
      if (part[0] < last || part[1] < part[0] || size < part[1])
        return false;
      last = part[1];
    }
    return true;
  }

  _validateContent(image: StyleImage, content?: [number, number, number, number]): boolean {
    if (!content)
      return true;
    if (content.length !== 4)
      return false;
    const imageData = image.spriteData ?? image.data;
    if (!imageData)
      return false;
    const { width, height } = imageData;
    if (content[0] < 0 || width < content[0])
      return false;
    if (content[1] < 0 || height < content[1])
      return false;
    if (content[2] < 0 || width < content[2])
      return false;
    if (content[3] < 0 || height < content[3])
      return false;
    if (content[2] < content[0])
      return false;
    return content[3] >= content[1];
  }

  updateImage(id: string, image: StyleImage, validate: boolean = true): void {
    const oldImage = this.getImage(id);
    if (validate && (oldImage.data.width !== image.data.width || oldImage.data.height !== image.data.height)) {
      throw new Error(`size mismatch between old image (${oldImage.data.width}x${oldImage.data.height}) and new image (${image.data.width}x${image.data.height}).`);
    }
    image.version = ++this.imageUpdateRevision;
    this.images[id] = image;
    this.updatedImages[id] = true;
  }

  removeImage(id: string): void {
    const image = this.images[id];
    delete this.images[id];
    delete this.updatedImages[id];

    if (image.userImage?.onRemove) {
      image.userImage.onRemove();
    }
  }

  listImages(): string[] {
    return Object.keys(this.images);
  }

  setMissingImageResolver(resolver?: MissingImageRequestHandler | null): void {
    this.missingImageResolver = resolver ?? undefined;
  }

  getImages(ids: string[]): Promise<GetImagesResponse> {
    return new Promise<GetImagesResponse>((resolve) => {
      // If the sprite has been loaded, or if all the icon dependencies are already present
      // (i.e. if they've been added via runtime styling), then notify the requestor immediately.
      // Otherwise, delay notification until the sprite is loaded. At that point, if any of the
      // dependencies are still unavailable, we'll just assume they are permanently missing.
      let hasAllDependencies = true;
      if (!this.isLoaded()) {
        for (const id of ids) {
          if (!this.images[id]) {
            hasAllDependencies = false;
          }
        }
      }
      if (this.isLoaded() || hasAllDependencies) {
        resolve(this._getImagesForIds(ids));
      }
      else {
        this.requestors.push({ ids, promiseResolve: resolve });
      }
    });
  }

  async _getImagesForIds(ids: string[]): Promise<GetImagesResponse> {
    const unresolvedIds = new Set(ids.filter(id => !this.getImage(id)));
    const resolver = this.missingImageResolver;

    if (resolver) {
      await Promise.all(Array.from(unresolvedIds, id => resolver(id)));
    }

    const response: GetImagesResponse = {};

    for (const id of ids) {
      const image = this.getImage(id);

      if (image) {
        unresolvedIds.delete(id);
        // Clone the image so that our own copy of its ArrayBuffer doesn't get transferred.
        response[id] = {
          data: image.data.clone(),
          pixelRatio: image.pixelRatio,
          sdf: image.sdf,
          version: image.version,
          stretchX: image.stretchX,
          stretchY: image.stretchY,
          content: image.content,
          textFitWidth: image.textFitWidth,
          textFitHeight: image.textFitHeight,
          hasRenderCallback: Boolean(image.userImage?.render),
        };
      }
    }

    for (const id of unresolvedIds) {
      this.fire(new StyleImageMissingEvent({ id }));
      warnOnce(`Image "${id}" could not be loaded. Please make sure you have added the image before it is needed with map.addImage(), resolved it with map.setMissingStyleImageResolver(), or included it in a "sprite" property in your style.`);
    }

    return response;
  }

  beginFrame(): void {
    this.callbackDispatchedThisFrame.clear();
  }

  dispatchRenderCallbacks(ids: string[]): void {
    for (const id of ids) {
      // the callback for the image was already dispatched for a different frame
      if (this.callbackDispatchedThisFrame.has(id))
        continue;
      this.callbackDispatchedThisFrame.add(id);

      const image = this.getImage(id);
      if (!image) {
        warnOnce(`Image with ID: "${id}" was not found`);
        continue;
      }

      const updated = renderStyleImage(image);
      if (updated) {
        this.updateImage(id, image);
      }
    }
  }
}
