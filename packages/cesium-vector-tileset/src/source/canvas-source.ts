import type { Evented } from '../util/evented';
import type { WorkerDispatcher } from '../worker/dispatcher';
import { ValidationError } from '@maplibre/maplibre-gl-style-spec';
import { ErrorEvent } from '../util/evented';

import { SourceDataEvent } from '../util/events';
import { ImageSource } from './image-source';

/**
 * Options to add a canvas source type to the map.
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
  canvas?: string | HTMLCanvasElement;
}

/**
 * A data source containing the contents of an HTML canvas. See {@link CanvasSourceSpecification} for detailed documentation of options.
 *
 * @group Sources
 *
 * @example
 * ```ts
 * // add to map
 * map.addSource('some id', {
 *    type: 'canvas',
 *    canvas: 'idOfMyHTMLCanvas',
 *    animate: true,
 *    coordinates: [
 *        [-76.54, 39.18],
 *        [-76.52, 39.18],
 *        [-76.52, 39.17],
 *        [-76.54, 39.17]
 *    ]
 * });
 *
 * // update
 * let mySource = map.getSource('some id');
 * mySource.setCoordinates([
 *     [-76.54335737228394, 39.18579907229748],
 *     [-76.52803659439087, 39.1838364847587],
 *     [-76.5295386314392, 39.17683392507606],
 *     [-76.54520273208618, 39.17876344106642]
 * ]);
 *
 * map.removeSource('some id');  // remove
 * ```
 */
export class CanvasSource extends ImageSource {
  declare options: CanvasSourceSpecification;
  animate: boolean;
  canvas?: HTMLCanvasElement;
  width = 0;
  height = 0;
  /**
   * Enables animation. The image will be copied from the canvas to the map on each frame.
   */
  play = (): void => {
    this._playing = true;
    this.style?.triggerRepaint?.();
  };

  /**
   * Disables animation. The map will display a static copy of the canvas image.
   */
  pause = (): void => {
    if (this._playing) {
      this.prepare();
      this._playing = false;
    }
  };

  _playing = false;

  /** @internal */
  constructor(id: string, options: CanvasSourceSpecification, dispatcher: WorkerDispatcher, eventedParent: Evented) {
    super(id, options, dispatcher, eventedParent);
    this.type = 'canvas';

    // We build in some validation here, since canvas sources aren't included in the style spec:
    if (!options.coordinates) {
      this.fire(new ErrorEvent(new ValidationError(`sources.${id}`, null, 'missing required property "coordinates"')));
    }
    else if (!Array.isArray(options.coordinates) || options.coordinates.length !== 4
      || options.coordinates.some(c => !Array.isArray(c) || c.length !== 2 || c.some(l => typeof l !== 'number'))) {
      this.fire(new ErrorEvent(new ValidationError(`sources.${id}`, null, '"coordinates" property must be an array of 4 longitude/latitude array pairs')));
    }

    if (options.animate && typeof options.animate !== 'boolean') {
      this.fire(new ErrorEvent(new ValidationError(`sources.${id}`, null, 'optional "animate" property must be a boolean value')));
    }

    if (!options.canvas) {
      this.fire(new ErrorEvent(new ValidationError(`sources.${id}`, null, 'missing required property "canvas"')));
    }
    else if (typeof options.canvas !== 'string' && !(options.canvas instanceof HTMLCanvasElement)) {
      this.fire(new ErrorEvent(new ValidationError(`sources.${id}`, null, '"canvas" must be either a string representing the ID of the canvas element from which to read, or an HTMLCanvasElement instance')));
    }

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

    this._finishLoading();
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

  _hasInvalidDimensions(): boolean {
    const canvas = this.canvas;
    if (!canvas)
      return true;

    for (const x of [canvas.width, canvas.height]) {
      if (Number.isNaN(x) || x <= 0)
        return true;
    }
    return false;
  }

  private _getCanvas(): HTMLCanvasElement | undefined {
    const configuredCanvas = this.options.canvas;
    if (configuredCanvas instanceof HTMLCanvasElement) {
      return configuredCanvas;
    }
    if (typeof configuredCanvas !== 'string') {
      return undefined;
    }
    const element = document.getElementById(configuredCanvas);
    return element instanceof HTMLCanvasElement ? element : undefined;
  }
}
