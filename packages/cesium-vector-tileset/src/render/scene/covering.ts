import type { Camera, MapProjection } from 'cesium';
import { Cartesian2, Cartesian3, IntersectionTests, Ray, SceneMode, WebMercatorProjection } from 'cesium';
import { MAX_TILE_ZOOM } from '../../geo/world-bounds';
import { compareTileId, OverscaledTileID } from '../../tile/tile-id';

/** MapLibre style zoom zero has a 512 CSS pixel world, independent of sources. */
export const MAPLIBRE_TILE_SIZE = 512;

export function mapZoomToSourceZoom(mapZoom: number, tileSize: number | undefined): number {
  return mapZoom + Math.log2(MAPLIBRE_TILE_SIZE / (tileSize ?? MAPLIBRE_TILE_SIZE));
}

/** Unwrapped normalized Mercator coordinates, captured before 2D viewport splitting. */
export interface CameraBounds { minX: number; maxX: number; minY: number; maxY: number }

export function planarCameraBounds(camera: Pick<Camera, 'positionWC' | 'rightWC' | 'upWC' | 'frustum'>, projection: MapProjection): CameraBounds | undefined {
  const frustum = camera.frustum as { left: number; right: number; top: number; bottom: number };
  if (![frustum.left, frustum.right, frustum.top, frustum.bottom].every(Number.isFinite))
    return undefined;
  const circumference = 2 * Math.PI * projection.ellipsoid.maximumRadius;
  const mercator = new WebMercatorProjection(projection.ellipsoid);
  const bounds: CameraBounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  const position = new Cartesian3();
  for (const x of [frustum.left, frustum.right]) {
    for (const y of [frustum.bottom, frustum.top]) {
      // Native orthographic camera axes are X=height, Y=east, Z=north.
      // Keep these projected coordinates unwrapped: public 2D pick rays wrap
      // east at the date line and cannot describe a full-world viewport.
      position.x = camera.positionWC.y + camera.rightWC.y * x + camera.upWC.y * y;
      position.y = camera.positionWC.z + camera.rightWC.z * x + camera.upWC.z * y;
      position.z = 0;
      if (!(projection instanceof WebMercatorProjection))
        mercator.project(projection.unproject(position), position);
      const mercatorX = 0.5 + position.x / circumference;
      const mercatorY = 0.5 - position.y / circumference;
      bounds.minX = Math.min(bounds.minX, mercatorX);
      bounds.maxX = Math.max(bounds.maxX, mercatorX);
      bounds.minY = Math.min(bounds.minY, mercatorY);
      bounds.maxY = Math.max(bounds.maxY, mercatorY);
    }
  }
  return bounds;
}

export function planarTileIDs(bounds: CameraBounds, targetZoom: number): OverscaledTileID[] {
  const zoom = Math.min(targetZoom, MAX_TILE_ZOOM);
  const world = 2 ** zoom;
  const minY = Math.max(0, bounds.minY);
  const maxY = Math.min(1, bounds.maxY);
  if (maxY <= minY || bounds.maxX <= bounds.minX)
    return [];
  const fullWorld = bounds.maxX - bounds.minX >= 1;
  const x0 = fullWorld ? 0 : Math.floor(bounds.minX * world);
  const x1 = fullWorld ? world - 1 : Math.ceil(bounds.maxX * world) - 1;
  const y0 = Math.floor(minY * world);
  const y1 = Math.ceil(maxY * world) - 1;
  const tiles: OverscaledTileID[] = [];
  const seen = new Set<string>();
  for (let x = x0; x <= x1; x++) {
    const canonicalX = ((x % world) + world) % world;
    for (let y = y0; y <= y1; y++) {
      const tile = new OverscaledTileID(zoom, 0, zoom, canonicalX, y);
      if (!seen.has(tile.key)) {
        seen.add(tile.key);
        tiles.push(tile);
      }
    }
  }
  return tiles.sort(compareTileId);
}

interface CameraZoomInput {
  camera: Pick<Camera, 'getPickRay' | 'frustum'>;
  mode: SceneMode;
  projection: MapProjection;
  width: number;
  height: number;
  sampleY?: number;
}

function mapPoint(ray: Ray, input: CameraZoomInput, mercator: WebMercatorProjection): Cartesian3 | undefined {
  const { projection, mode } = input;
  let point: Cartesian3;
  if (mode === SceneMode.SCENE3D) {
    const intersection = IntersectionTests.rayEllipsoid(ray, projection.ellipsoid);
    if (!intersection) {
      return undefined;
    }
    point = Ray.getPoint(ray, intersection.start, new Cartesian3());
    const cartographic = projection.ellipsoid.cartesianToCartographic(point);
    return cartographic && mercator.project(cartographic);
  }
  // Cesium's projected world axes are X=height, Y=east, Z=north.
  const distance = -ray.origin.x / ray.direction.x;
  if (!Number.isFinite(distance) || distance < 0) {
    return undefined;
  }
  point = Ray.getPoint(ray, distance, new Cartesian3());
  return mercator.project(projection.unproject(new Cartesian3(point.y, point.z, 0)));
}

/**
 * Measure local Web Mercator resolution using two adjacent CSS screen pixels.
 * Mercator 2D has an exact orthographic scale; surface modes sample rays.
 */
export function cameraZoom(input: CameraZoomInput): number | undefined {
  if (input.mode === SceneMode.MORPHING || input.width <= 0 || input.height <= 0) {
    return undefined;
  }
  if (input.mode === SceneMode.SCENE2D && input.projection instanceof WebMercatorProjection) {
    const frustum = input.camera.frustum as { left: number; right: number };
    const span = frustum.right - frustum.left;
    const circumference = 2 * Math.PI * input.projection.ellipsoid.maximumRadius;
    const zoom = Math.log2(circumference * input.width / (MAPLIBRE_TILE_SIZE * span));
    return Number.isFinite(zoom) ? zoom : undefined;
  }
  const mercator = new WebMercatorProjection(input.projection.ellipsoid);
  const y = input.sampleY ?? input.height / 2;
  const center = input.camera.getPickRay(new Cartesian2(input.width / 2, y));
  const neighbor = input.camera.getPickRay(new Cartesian2(input.width / 2 + 1, y));
  const start = center && mapPoint(center, input, mercator);
  const end = neighbor && mapPoint(neighbor, input, mercator);
  if (!start || !end) {
    return undefined;
  }
  const circumference = 2 * Math.PI * input.projection.ellipsoid.maximumRadius;
  const longitudeDistance = Math.abs(end.x - start.x) % circumference;
  const metersPerPixel = Math.hypot(Math.min(longitudeDistance, circumference - longitudeDistance), end.y - start.y);
  const zoom = Math.log2(circumference / (metersPerPixel * MAPLIBRE_TILE_SIZE));
  return Number.isFinite(zoom) ? zoom : undefined;
}
