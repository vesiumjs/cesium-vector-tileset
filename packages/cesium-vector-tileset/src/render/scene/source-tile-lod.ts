import type { MapProjection } from 'cesium';
import type { CameraFocus } from './camera-focus';
import type { RenderFrameState } from './render-frame';
import { Cartesian2, Cartesian3, IntersectionTests, Ray, SceneMode } from 'cesium';
import { mercatorXfromLng, mercatorYfromLat, mercatorZfromAltitude } from '../../geo/mercator-coordinate';
import { MAX_TILE_ZOOM } from '../../geo/world-bounds';
import { OverscaledTileID } from '../../tile/tile-id';
import { columbusCameraFocus } from './camera-focus';

interface SourceLodCamera {
  x: number;
  y: number;
  height: number;
  centerDistance: number;
  fov: number;
  variable: boolean;
}

/** Capture the actual ground camera once per pose, including projected CV axes. */
export function sourceLodCamera(frame: RenderFrameState, projection: MapProjection, width: number, height: number, focus?: CameraFocus | null): SourceLodCamera | undefined {
  // A virtual focus can lie on/above the camera plane; it is not a ground
  // target for the variable LOD formula. Keep the finite center cap instead.
  if (frame.mode === SceneMode.COLUMBUS_VIEW && (focus === undefined ? columbusCameraFocus(frame.camera, projection, height) : focus))
    return undefined;
  const fov = (frame.camera.frustum as { fovy?: number }).fovy;
  const ray = frame.camera.getPickRay(new Cartesian2(width / 2, height / 2));
  if (!ray || fov === undefined || !(fov > 0 && fov < Math.PI))
    return undefined;
  let center;
  let position;
  let normal: Cartesian3;
  if (frame.mode === SceneMode.SCENE3D) {
    const intersection = IntersectionTests.rayEllipsoid(ray, projection.ellipsoid);
    if (!intersection)
      return undefined;
    center = projection.ellipsoid.cartesianToCartographic(Ray.getPoint(ray, intersection.start, new Cartesian3()));
    position = projection.ellipsoid.cartesianToCartographic(frame.camera.positionWC);
    normal = projection.ellipsoid.geodeticSurfaceNormal(frame.camera.positionWC);
  }
  else if (frame.mode === SceneMode.COLUMBUS_VIEW) {
    const distance = -ray.origin.x / ray.direction.x;
    if (!Number.isFinite(distance) || distance < 0)
      return undefined;
    const point = Ray.getPoint(ray, distance, new Cartesian3());
    center = projection.unproject(new Cartesian3(point.y, point.z, 0));
    const camera = frame.camera.positionWC;
    position = projection.unproject(new Cartesian3(camera.y, camera.z, camera.x));
    normal = Cartesian3.UNIT_X;
  }
  else {
    return undefined;
  }
  if (!center || !position || Math.abs(position.latitude) >= Math.PI / 2 || Math.abs(center.latitude) >= Math.PI / 2)
    return undefined;
  const degrees = 180 / Math.PI;
  const x = mercatorXfromLng(position.longitude * degrees);
  const y = mercatorYfromLat(position.latitude * degrees);
  const centerX = mercatorXfromLng(center.longitude * degrees);
  const centerY = mercatorYfromLat(center.latitude * degrees);
  const distanceX = centerX - x - Math.round(centerX - x);
  // Columbus View's three world axes are projected metres. Its height must
  // share X/Y's world scale, unlike physical altitude on the 3D ellipsoid.
  const circumference = 2 * Math.PI * projection.ellipsoid.maximumRadius;
  const altitude = frame.mode === SceneMode.COLUMBUS_VIEW
    ? position.height / circumference
    : mercatorZfromAltitude(position.height, position.latitude * degrees);
  const centerAltitude = frame.mode === SceneMode.COLUMBUS_VIEW
    ? center.height / circumference
    : mercatorZfromAltitude(center.height, center.latitude * degrees);
  const distanceZ = Math.abs(altitude - centerAltitude);
  const centerDistance = Math.hypot(distanceX, centerY - y, distanceZ);
  if (!(distanceZ > 0 && centerDistance > 0) || ![x, y, distanceZ, centerDistance].every(Number.isFinite))
    return undefined;
  // Effective perspective pitch comes from the actual Mercator ground target,
  // rather than ENU Camera.pitch (which is also wrong for Columbus View).
  const pitch = Math.acos(Math.min(1, distanceZ / centerDistance)) * degrees;
  const horizontalDirection = Math.sqrt(Math.max(0, 1 - Cartesian3.dot(frame.camera.directionWC, normal) ** 2));
  const sinRoll = horizontalDirection > 0
    ? Math.min(1, Math.abs(Cartesian3.dot(frame.camera.rightWC, normal)) / horizontalDirection)
    : 0;
  const zfov = fov * degrees * (Math.sqrt(1 - sinRoll ** 2) * height + sinRoll * width) / height;
  const maxConstantZoomPitch = Math.max(0, Math.min(60, 78.5 - zfov / 2));
  return { x, y, height: distanceZ, centerDistance, fov, variable: pitch > maxConstantZoomPitch };
}

function integralCos(power: number, from: number, to: number): number {
  const count = 10;
  const step = (to - from) / count;
  let sum = 0;
  for (let index = 0; index < count; index++)
    sum += step * Math.cos(from + (index + 0.5) * step) ** power;
  return sum;
}

/**
 * Source LOD from MapLibre GL JS 6.12 geo/projection/covering_tiles.ts
 * createCalculateTileZoomFunction and MercatorCoveringTilesDetailsProvider.
 * Defaults 9.314/3.0, horizon 89.25 and midpoint integration are source rules,
 * not Native tuning. Globe still authorizes the candidate footprint.
 */
export class SourceTileLod {
  private readonly _pitchBehavior: number;
  private readonly _zoomAdjustment: number;
  private readonly _camera: SourceLodCamera | undefined;
  private readonly _centerZoom: number;
  private readonly _minZoom: number;
  private readonly _maxZoom: number;
  private readonly _round: boolean;
  private readonly _reparse: boolean;
  // A LOD instance belongs to one frozen camera/source selection. Separate
  // worlds and levels keep the numeric x + y * world keys exact through z25.
  private readonly _desiredZoomByWrap = new Map<number, Map<number, number>[]>();

  get maxZoom(): number {
    return this._maxZoom;
  }

  sameSelection(other: SourceTileLod): boolean {
    if (this._camera?.variable || other._camera?.variable)
      return this === other;
    return this._minZoom === other._minZoom && this._maxZoom === other._maxZoom && this._reparse === other._reparse
      && (this._round ? Math.round(this._centerZoom) : Math.floor(this._centerZoom))
      === (other._round ? Math.round(other._centerZoom) : Math.floor(other._centerZoom));
  }

  constructor(camera: SourceLodCamera | undefined, centerZoom: number, minZoom: number, maxZoom: number, round: boolean, reparse = false) {
    this._camera = camera;
    this._centerZoom = centerZoom;
    this._minZoom = minZoom;
    this._maxZoom = maxZoom;
    this._round = round;
    this._reparse = reparse;
    if (camera?.variable) {
      const horizon = 89.25 * Math.PI / 180;
      const behavior = 2 * ((9.314 - 1) / Math.log2(Math.cos(horizon - camera.fov) / Math.cos(horizon)) - 1);
      const pitch = Math.acos(Math.min(1, camera.height / camera.centerDistance));
      const highest = Math.min(horizon, pitch + camera.fov / 2);
      const lowest = Math.min(highest, pitch - camera.fov / 2);
      const count = integralCos(behavior - 1, lowest, highest);
      const countAtZero = 2 * integralCos(behavior - 1, 0, camera.fov / 2);
      this._pitchBehavior = behavior;
      this._zoomAdjustment = Math.log2(Math.max(1, count / countAtZero / 3.0)) / 2;
    }
    else {
      this._pitchBehavior = 0;
      this._zoomAdjustment = 0;
    }
  }

  /** Walk this candidate's ancestors with the same stopping rule as coveringTiles. */
  select(id: OverscaledTileID): OverscaledTileID | undefined {
    const capped = (this._reparse ? id.canonical.z : id.overscaledZ) > this._maxZoom;
    const canonicalZoom = capped ? Math.min(id.canonical.z, this._maxZoom) : id.canonical.z;
    const overscaledZoom = capped ? this._maxZoom : id.overscaledZ;
    const x = id.canonical.x >> (id.canonical.z - canonicalZoom);
    const y = id.canonical.y >> (id.canonical.z - canonicalZoom);
    // Constant LOD first stops at its desired zoom; variable LOD must still
    // inspect every authorized ancestor, sharing work with nearby candidates.
    const firstZoom = this._camera?.variable ? 0 : this._desiredZoom(0, 0, 0, id.wrap);
    for (let zoom = firstZoom; zoom < canonicalZoom; zoom++) {
      const ancestorX = x >> (canonicalZoom - zoom);
      const ancestorY = y >> (canonicalZoom - zoom);
      if (zoom >= this._desiredZoom(zoom, ancestorX, ancestorY, id.wrap))
        return zoom < this._minZoom ? undefined : new OverscaledTileID(zoom, id.wrap, zoom, ancestorX, ancestorY);
    }
    if (canonicalZoom < this._minZoom)
      return undefined;
    // Canonical and overscaled zoom are separate: reaching a source's
    // terminal canonical footprint does not authorize every parsed generation.
    const terminal = Math.max(canonicalZoom, this._desiredZoom(canonicalZoom, x, y, id.wrap));
    if (this._reparse) {
      const parsedZoom = canonicalZoom === this._maxZoom ? terminal : canonicalZoom;
      return new OverscaledTileID(parsedZoom, id.wrap, canonicalZoom, x, y);
    }
    const selectedZoom = Math.min(overscaledZoom, terminal);
    return selectedZoom === id.overscaledZ && canonicalZoom === id.canonical.z
      ? id
      : new OverscaledTileID(selectedZoom, id.wrap, canonicalZoom, x, y);
  }

  allows(id: OverscaledTileID): boolean {
    return this.select(id)?.equals(id) ?? false;
  }

  private _desiredZoom(zoom: number, tileX: number, tileY: number, wrap: number): number {
    const camera = this._camera;
    let desired = this._centerZoom;
    let cache: Map<number, number> | undefined;
    let key = 0;
    if (camera?.variable) {
      const world = 2 ** zoom;
      let levels = this._desiredZoomByWrap.get(wrap);
      if (!levels) {
        levels = [];
        this._desiredZoomByWrap.set(wrap, levels);
      }
      cache = levels[zoom] ??= new Map();
      key = tileX + tileY * world;
      const cached = cache.get(key);
      if (cached !== undefined)
        return cached;
      // Unwrap the actual camera to this source world before measuring the
      // closest point of the tile AABB, including date-line crossings.
      const midpoint = wrap + (tileX + 0.5) / world;
      const x = camera.x + Math.round(midpoint - camera.x);
      const minX = wrap + tileX / world;
      const minY = tileY / world;
      const dx = Math.max(minX - x, 0, x - minX - 1 / world);
      const dy = Math.max(minY - camera.y, 0, camera.y - minY - 1 / world);
      const distance = Math.hypot(dx, dy);
      desired += Math.log2(camera.centerDistance / Math.hypot(distance, camera.height) / Math.max(0.5, Math.cos(camera.fov / 2)));
      desired += this._pitchBehavior * Math.log2(Math.cos(Math.atan(distance / camera.height))) / 2;
      desired -= this._zoomAdjustment;
    }
    const result = Math.max(0, Math.min(this._reparse ? MAX_TILE_ZOOM : this._maxZoom, this._round ? Math.round(desired) : Math.floor(desired)));
    cache?.set(key, result);
    return result;
  }
}
