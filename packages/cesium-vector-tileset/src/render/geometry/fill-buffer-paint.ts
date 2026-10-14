import type { BufferPolygonCollection } from 'cesium';
import type { FillStyleLayer } from '../../style/style-layer/fill-style-layer';
import { BoundingSphere, Cartesian3, Cartographic, Ellipsoid, SceneMode } from 'cesium';
import { FillCameraPaint } from './fill-camera-paint';
import { mercatorTranslationPadding } from './mercator-translation';

/** Native fills translate from immutable Worker/drape positions, never from the previous frame. */
export class FillBufferPaint {
  private readonly _paint = new FillCameraPaint();
  private readonly _collection: BufferPolygonCollection;
  private readonly _source: readonly Float64Array[];
  private readonly _bounds: BoundingSphere;
  private _mercator?: Float64Array;
  private _positions?: Float64Array;
  private _maximumHeight = 0;

  constructor(collection: BufferPolygonCollection, positions: readonly Float64Array[]) {
    this._collection = collection;
    this._source = positions;
    this._bounds = BoundingSphere.clone(collection.boundingVolume);
  }

  updateCameraPaint(layer: FillStyleLayer, zoom: number, bearing?: number): void {
    if (this._paint.update(layer, zoom, bearing))
      this._applyTranslation();
  }

  captureCameraPaint(layer: FillStyleLayer): (zoom: number, bearing?: number) => void {
    return this._paint.capture(layer, () => this._applyTranslation());
  }

  private _preparePositions(): void {
    const count = this._source.reduce((sum, positions) => sum + positions.length, 0);
    const mercator = this._mercator = new Float64Array(count);
    this._positions = new Float64Array(count);
    const point = new Cartesian3();
    const cartographic = new Cartographic();
    let offset = 0;
    for (const positions of this._source) {
      for (let index = 0; index < positions.length; index += 3, offset += 3) {
        point.x = positions[index];
        point.y = positions[index + 1];
        point.z = positions[index + 2];
        Ellipsoid.WGS84.cartesianToCartographic(point, cartographic);
        mercator[offset] = (cartographic.longitude + Math.PI) / (2 * Math.PI);
        // Cesium's projection clamps at 85 degrees. Keep the full latitude
        // range here; exact poles remain fixed under finite Mercator offsets.
        mercator[offset + 1] = Math.abs(cartographic.latitude) === Math.PI / 2
          ? (cartographic.latitude > 0 ? -Infinity : Infinity)
          : 0.5 - Math.log(Math.tan(Math.PI / 4 + cartographic.latitude / 2)) / (2 * Math.PI);
        mercator[offset + 2] = cartographic.height;
        this._maximumHeight = Math.max(this._maximumHeight, cartographic.height);
      }
    }
  }

  private _applyTranslation(): void {
    if (!this._mercator)
      this._preparePositions();
    const mercator = this._mercator!;
    const positions = this._positions!;
    const translation = this._paint.translation;
    const zero = translation.x === 0 && translation.y === 0;
    const point = new Cartesian3();
    const cartographic = new Cartographic();
    let offset = 0;
    for (const source of this._source) {
      for (let index = 0; index < source.length; index += 3, offset += 3) {
        if (zero || !Number.isFinite(mercator[offset + 1])) {
          positions[offset] = source[index];
          positions[offset + 1] = source[index + 1];
          positions[offset + 2] = source[index + 2];
          continue;
        }
        cartographic.longitude = (mercator[offset] + translation.x) * (2 * Math.PI) - Math.PI;
        cartographic.latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * (mercator[offset + 1] + translation.y))));
        cartographic.height = mercator[offset + 2];
        Ellipsoid.WGS84.cartographicToCartesian(cartographic, point);
        positions[offset] = point.x;
        positions[offset + 1] = point.y;
        positions[offset + 2] = point.z;
      }
    }
    const collection = this._collection;
    BoundingSphere.clone(this._bounds, collection.boundingVolume);
    collection.boundingVolume.radius += mercatorTranslationPadding(translation, Ellipsoid.WGS84, SceneMode.SCENE3D, this._maximumHeight);
    // Native copies the payload and marks GEOMETRY dirty, including the
    // terrain provider's lookup data when this collection is draped.
    collection.setPositions(positions, 0, collection.primitiveCount);
  }
}
