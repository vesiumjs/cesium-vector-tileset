/*
* Approximate radius of the earth in meters.
* Uses the WGS-84 approximation. The radius at the equator is ~6378137 and at the poles is ~6356752. https://en.wikipedia.org/wiki/World_Geodetic_System#WGS84
* 6371008.8 is one published "average radius" see https://en.wikipedia.org/wiki/Earth_radius#Mean_radius, or ftp://athena.fsv.cvut.cz/ZFG/grs80-Moritz.pdf p.4
*/
export const earthRadius = 6371008.8;

/**
 * A {@link LngLat} object, an array of two numbers representing longitude and latitude,
 * or an object with `lng` and `lat` or `lon` and `lat` properties.
 *
 * @group Geography and Geometry
 *
 * @example
 * ```ts
 * let v1 = new LngLat(-122.420679, 37.772537);
 * let v2 = [-122.420679, 37.772537];
 * let v3 = {lon: -122.420679, lat: 37.772537};
 * ```
 */
export type LngLatLike = LngLat | {
  lng: number;
  lat: number;
} | {
  lon: number;
  lat: number;
} | [number, number];

/**
 * A `LngLat` object represents a given longitude and latitude coordinate, measured in degrees.
 * These coordinates are based on the [WGS84 (EPSG:4326) standard](https://en.wikipedia.org/wiki/World_Geodetic_System#WGS84).
 *
 * MapLibre GL JS uses longitude, latitude coordinate order (as opposed to latitude, longitude) to match the
 * [GeoJSON specification](https://tools.ietf.org/html/rfc7946).
 *
 * Note that any MapLibre GL JS method that accepts a `LngLat` object as an argument or option
 * can also accept an `Array` of two numbers and will perform an implicit conversion.
 * This flexible type is documented as {@link LngLatLike}.
 *
 * @group Geography and Geometry
 *
 * @example
 * ```ts
 * let ll = new LngLat(-123.9749, 40.7736);
 * ll.lng; // = -123.9749
 * ```
 * @see [Get coordinates of the mouse pointer](https://maplibre.org/maplibre-gl-js/docs/examples/get-coordinates-of-the-mouse-pointer/)
 */
export class LngLat {
  /**
   * Longitude, measured in degrees.
   */
  lng: number;

  /**
   * Latitude, measured in degrees.
   */
  lat: number;

  /**
   * @param lng - Longitude, measured in degrees.
   * @param lat - Latitude, measured in degrees.
   */
  constructor(lng: number, lat: number) {
    if (Number.isNaN(lng) || Number.isNaN(lat)) {
      throw new TypeError(`Invalid LngLat object: (${lng}, ${lat})`);
    }
    this.lng = +lng;
    this.lat = +lat;
    if (this.lat > 90 || this.lat < -90) {
      throw new Error('Invalid LngLat latitude value: must be between -90 and 90');
    }
  }

  /**
   * Converts an array of two numbers or an object with `lng` and `lat` or `lon` and `lat` properties
   * to a `LngLat` object.
   *
   * If a `LngLat` object is passed in, the function returns it unchanged.
   *
   * @param input - An array of two numbers or object to convert, or a `LngLat` object to return.
   * @returns A new `LngLat` object, if a conversion occurred, or the original `LngLat` object.
   * @example
   * ```ts
   * let arr = [-73.9749, 40.7736];
   * let ll = LngLat.convert(arr);
   * ll;   // = LngLat {lng: -73.9749, lat: 40.7736}
   * ```
   */
  static convert(input: LngLatLike): LngLat {
    if (input instanceof LngLat) {
      return input;
    }
    if (Array.isArray(input) && (input.length === 2 || input.length === 3)) {
      return new LngLat(Number(input[0]), Number(input[1]));
    }
    if (!Array.isArray(input) && typeof input === 'object' && input !== null) {
      return new LngLat(
        Number('lng' in input ? input.lng : input.lon),
        Number(input.lat),
      );
    }
    throw new Error('`LngLatLike` argument must be specified as a LngLat instance, an object {lng: <lng>, lat: <lat>}, an object {lon: <lng>, lat: <lat>}, or an array of [<lng>, <lat>]');
  }
}
