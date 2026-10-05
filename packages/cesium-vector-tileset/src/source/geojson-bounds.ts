import { LngLatBounds } from '../geo/lng-lat-bounds';

type DeepCoordinates = GeoJSON.Position | DeepCoordinates[];

function isPosition(coords: DeepCoordinates): coords is GeoJSON.Position {
  return coords.length > 0 && typeof coords[0] === 'number';
}

function extractCoordinates(coords: DeepCoordinates): number[][] {
  if (!coords || coords.length === 0)
    return [];

  if (isPosition(coords)) {
    return [coords];
  }

  return coords.flatMap(c => extractCoordinates(c));
}

function getCoordinatesFromGeometry(geometry: GeoJSON.Geometry | null): number[][] {
  if (!geometry) {
    return [];
  }
  if (geometry.type === 'GeometryCollection') {
    return geometry.geometries.flatMap(g => getCoordinatesFromGeometry(g));
  }

  return extractCoordinates(geometry.coordinates);
}

/**
 * Calculates the bounding box of GeoJSON data.
 * @param data - The GeoJSON data to calculate bounds for
 * @returns The bounding box of the GeoJSON data
 */
export function getGeoJSONBounds(data: GeoJSON.GeoJSON): LngLatBounds {
  const bounds = new LngLatBounds();
  let coordinates: number[][];

  switch (data.type) {
    case 'FeatureCollection':
      coordinates = data.features.flatMap(f => getCoordinatesFromGeometry(f.geometry));
      break;
    case 'Feature':
      coordinates = getCoordinatesFromGeometry(data.geometry);
      break;
    default:
      coordinates = getCoordinatesFromGeometry(data);
      break;
  }

  if (coordinates.length === 0) {
    return bounds;
  }

  for (const coordinate of coordinates) {
    const [lng, lat] = coordinate;

    bounds.extend([lng, lat]);
  }
  return bounds;
}
