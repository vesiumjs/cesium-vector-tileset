import type { Evented } from '../util/evented';
import type { WorkerDispatcher } from '../worker/dispatcher';
import { ErrorEvent } from '../util/evented';

import { SourceDataEvent } from '../util/events';
import { ImageSource } from './image-source';

/**
 * Canvas source options for the tileset style's sources.
 */
export interface CanvasSourceSpecification {
  /**
   * Source type. Must be `"canvas"`.
   */
  type: 'canvas';
  /**
   * Four geographical coordinates denoting where to place the corners of the canvas, specified in `[longitude, latitude]` pairs.
   */
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  /**
   * Whether the canvas source is animated. If the canvas is static (i.e. pixels do not need to be re-read on every frame), `animate` should be set to `false` to improve performance.
   * @defaultValue true
   */
  animate?: boolean;
  /**
   * Canvas source from which to read pixels. Can be a string representing the ID of the canvas element, or the `HTMLCanvasElement` itself.
   */
  canvas: string | HTMLCanvasElement;
}

/**
 * Places HTML canvas pixels at four geographical corners; see CanvasSourceSpecification.
 * Configure the canvas source in the tileset style's sources and apply changes with CesiumVectorTileset.setStyle.
 * Animated sources refresh their pixels each frame; use animate: false for a static canvas.
 *
 * @internal
 */
export class CanvasSource extends ImageSource {
  declare options: CanvasSourceSpecification;
  animate: boolean;
  canvas?: HTMLCanvasElement;
  width = 0;
  height = 0;
  /**
   * Enables animation and requests rendering of changing canvas pixels.
   */
  play = (): void => {
    this._playing = true;
    this.style?.triggerRepaint?.();
  };

  /**
   * Disables animation while retaining the current canvas image.
   */
  pause = (): void => {
    if (this._playing) {
      this.prepare();
      this._playing = false;
    }
  };

  _playing = false;

  /**
   * @internal
   */
  constructor(id: string, options: CanvasSourceSpecification, dispatcher: WorkerDispatcher, eventedParent: Evented) {
    super(id, options, dispatcher, eventedParent);
    this.type = 'canvas';

    this.options = options;
    this.animate = options.animate !== undefined ? options.animate : true;
  }

  async load(): Promise<void> {
    this._loaded = true;
    const canvas = this.canvas ?? this._getCanvas();
    if (!canvas) {
      this._loaded = false;
      this.fire(new ErrorEvent(new Error(`Canvas source "${this.id}" could not find its canvas element.`)));
      return;
    }
    this.canvas = canvas;
    this.width = canvas.width;
    this.height = canvas.height;

    if (this._hasInvalidDimensions()) {
      this.fire(new ErrorEvent(new Error('Canvas dimensions cannot be less than or equal to zero.')));
      return;
    }

    this.finishLoading();
  }

  /**
   * Returns the HTML `canvas` element.
   *
   * @returns The HTML `canvas` element.
   */
  getCanvas(): HTMLCanvasElement {
    const canvas = this.canvas;
    if (!canvas) {
      throw new Error(`Canvas source "${this.id}" has not been loaded.`);
    }
    return canvas;
  }

  onAdd(): void {
    this.load();
    if (this.animate)
      this.play();
  }

  onRemove(): void {
    this.pause();
  }

  prepare(): void {
    const canvas = this.canvas;
    if (!canvas)
      return;

    if (canvas.width !== this.width) {
      this.width = canvas.width;
    }
    if (canvas.height !== this.height) {
      this.height = canvas.height;
    }

    if (this._hasInvalidDimensions())
      return;

    if (Object.keys(this.tiles).length === 0)
      return; // not enough data for current position

    let newTilesLoaded = false;
    for (const w in this.tiles) {
      const tile = this.tiles[w];
      if (tile.state !== 'loaded') {
        tile.state = 'loaded';
        tile.textureData = canvas;
        newTilesLoaded = true;
      }
    }

    if (newTilesLoaded) {
      this.fire(new SourceDataEvent('data', { sourceDataType: 'idle', sourceId: this.id }));
    }
  }

  serialize(): CanvasSourceSpecification {
    return {
      type: 'canvas',
      animate: this.animate,
      canvas: this.options.canvas,
      coordinates: this.coordinates,
    };
  }

  hasTransition(): boolean {
    return this._playing;
  }

  /**
   * @internal
   */
  private _hasInvalidDimensions(): boolean {
    const canvas = this.canvas;
    if (!canvas)
      return true;

    for (const x of [canvas.width, canvas.height]) {
      if (Number.isNaN(x) || x <= 0)
        return true;
    }
    return false;
  }

  /**
   * @internal
   */
  private _getCanvas(): HTMLCanvasElement | undefined {
    const configuredCanvas = this.options.canvas;
    if (configuredCanvas instanceof HTMLCanvasElement) {
      return configuredCanvas;
    }
    const element = document.getElementById(configuredCanvas);
    return element instanceof HTMLCanvasElement ? element : undefined;
  }
}
