import type { MapProjection } from 'cesium';
import type { CanonicalTileID, OverscaledTileID } from '../../tile/tile-id';
import type { RenderFrameState } from '../scene/render-frame';
import { Cartesian3, Cartesian4, Cartographic, Matrix4 } from 'cesium';
import { wgs84CartographicToCartesian } from '../geometry/tile-to-ecef';

/** Clip canonical geographic tile boundaries in both scene modes. */
export const LINE_TILE_CLIP_FRAGMENT = `
#ifdef LINE_TILE_CLIP
in vec3 v_lineClip3DEye;
in vec3 v_lineClip2DEye;
uniform mat4 u_line_clip_planes;
uniform mat4 u_line_clip_latitudes;
uniform mat4 u_line_clip_planar;

float lineLatitudeSide(vec3 originEC, vec4 shape)
{
    vec3 delta = czm_inverseViewRotation * (v_lineClip3DEye - originEC);
    vec2 radial = delta.xy / shape.z;
    // rho-rho0 as a difference of squares avoids Earth-scale cancellation.
    float radialDelta = dot(2.0 * shape.xy + radial, delta.xy)
        / (length(shape.xy + radial) + 1.0);
    // Constant geodetic latitude at every height: z=tan(phi)*rho-e²N*sin(phi).
    // The origin is on that boundary, so its constant cancels exactly.
    return delta.z - shape.w * radialDelta;
}

void clipLineTile2D()
{
    vec4 positionEC = vec4(v_lineClip2DEye, 1.0);
    if (dot(u_line_clip_planar[0], positionEC) < 0.0
        || dot(u_line_clip_planar[1], positionEC) >= 0.0
        || dot(u_line_clip_planar[2], positionEC) < 0.0
        || dot(u_line_clip_planar[3], positionEC) >= 0.0)
        discard;
}

void clipLineTile3D()
{
    vec4 positionEC = vec4(v_lineClip3DEye, 1.0);
    // A z1 longitude interval is a hemisphere; its two edges share a plane.
    // Its across axis distinguishes the inclusive and exclusive endpoints.
    if (u_line_clip_planes[2].x == 2.0)
    {
        float radial = dot(u_line_clip_planes[0], positionEC);
        float across = dot(u_line_clip_planes[1], positionEC);
        if (radial < 0.0 || (radial == 0.0 && across >= 0.0))
            discard;
    }
    if ((u_line_clip_planes[2].x == 1.0 && dot(u_line_clip_planes[0], positionEC) < 0.0)
        || (u_line_clip_planes[2].y > 0.0 && dot(u_line_clip_planes[1], positionEC) >= 0.0)
        || (u_line_clip_planes[2].z > 0.0 && lineLatitudeSide(u_line_clip_latitudes[0].xyz, u_line_clip_latitudes[2]) < 0.0)
        || (u_line_clip_planes[2].w > 0.0 && lineLatitudeSide(u_line_clip_latitudes[1].xyz, u_line_clip_latitudes[3]) >= 0.0))
        discard;
}

void clipLineTile()
{
    // Endpoints use their own coordinates; morphing must respect both bounds.
    if (czm_morphTime > 0.0)
        clipLineTile3D();
    if (czm_morphTime < 1.0)
        clipLineTile2D();
}
#endif
`;

interface ClipUniformState {
  readonly view: Matrix4;
}

type UniformMap = Readonly<Record<string, () => Matrix4>>;

/** Immutable tile bounds, shared by all layers/chunks; Native owns the view. */
export class LineTileClip {
  readonly uniforms: UniformMap;
  readonly centerLongitude: number;

  private readonly _west: number;

  private readonly _east: number;

  private readonly _south: number;

  private readonly _north: number;

  private readonly _planes: Cartesian4[];

  private readonly _planarPlanes: Cartesian4[];

  private readonly _eyePlanes: Cartesian4[];

  private readonly _origins: Cartesian3[];

  private readonly _eyeOrigins: Cartesian3[];

  private readonly _shapes: Cartesian4[];

  private readonly _packedPlanes = new Matrix4();

  private readonly _packedLatitudes = new Matrix4();

  private readonly _packedPlanar = new Matrix4();

  private readonly _originColumn = new Cartesian4();

  private readonly _view = new Matrix4();

  private _hasView = false;

  private _uniformState!: ClipUniformState;

  private _projection?: MapProjection;

  private _projectedWith?: MapProjection;

  constructor(tileID: CanonicalTileID | OverscaledTileID) {
    const canonical = 'canonical' in tileID ? tileID.canonical : tileID;
    const dimension = 2 ** canonical.z;
    // Native repeats the canonical map with a second 2D viewport. A tile's
    // world-copy identity must not move its geometry or its clip boundaries.
    this._west = canonical.x / dimension * Math.PI * 2 - Math.PI;
    this._east = (canonical.x + 1) / dimension * Math.PI * 2 - Math.PI;
    this.centerLongitude = (this._west + this._east) / 2;
    this._north = Math.atan(Math.sinh(Math.PI * (1 - 2 * canonical.y / dimension)));
    this._south = Math.atan(Math.sinh(Math.PI * (1 - 2 * (canonical.y + 1) / dimension)));
    this._planarPlanes = [new Cartesian4(0, 1, 0, 0), new Cartesian4(0, 1, 0, 0), new Cartesian4(0, 0, 1, 0), new Cartesian4(0, 0, 1, 0)];
    const longitudePlanes = canonical.z === 1
      ? [new Cartesian4(0, canonical.x === 0 ? -1 : 1, 0, 0), new Cartesian4(canonical.x === 0 ? 1 : -1, 0, 0, 0)]
      : [this._longitudePlane(canonical.x, dimension), this._longitudePlane(canonical.x + 1, dimension)];
    this._planes = [...longitudePlanes, ...this._planarPlanes];
    this._eyePlanes = this._planes.map(() => new Cartesian4());
    this._origins = [this._south, this._north].map((latitude) => {
      const position = wgs84CartographicToCartesian(0, latitude);
      return new Cartesian3(position.x, position.y, position.z);
    });
    this._eyeOrigins = this._origins.map(() => new Cartesian3());
    this._shapes = [this._south, this._north].map((latitude, index) => new Cartesian4(
      1,
      0,
      this._origins[index].x,
      Math.tan(latitude),
    ));
    const edges = new Cartesian4(canonical.z === 1 ? 2 : canonical.z > 0 ? 1 : 0, canonical.z > 1 ? 1 : 0, canonical.y < dimension - 1 ? 1 : 0, canonical.y > 0 ? 1 : 0);
    Matrix4.setColumn(this._packedPlanes, 2, edges, this._packedPlanes);
    const packed = (matrix: Matrix4) => () => {
      this._updateView();
      return matrix;
    };
    this.uniforms = {
      u_line_clip_planes: packed(this._packedPlanes),
      u_line_clip_latitudes: packed(this._packedLatitudes),
      u_line_clip_planar: packed(this._packedPlanar),
    };
  }

  bind(frame: RenderFrameState): UniformMap {
    this._uniformState = (frame.context as unknown as { uniformState: ClipUniformState }).uniformState;
    this._projection = frame.mapProjection;
    return this.uniforms;
  }

  /**
   * @internal
   */
  private _longitudePlane(edge: number, dimension: number): Cartesian4 {
    const index = edge % dimension;
    // Canonical edges share one angle, including +/-pi. Quadrants use exact
    // axes so a zero-distance pixel gets one owner at longitude 0 and 180.
    if (index === 0)
      return new Cartesian4(0, -1, 0, 0);
    if (index === dimension / 4)
      return new Cartesian4(1, 0, 0, 0);
    if (index === dimension / 2)
      return new Cartesian4(0, 1, 0, 0);
    if (index === dimension * 3 / 4)
      return new Cartesian4(-1, 0, 0, 0);
    const longitude = index / dimension * Math.PI * 2 - Math.PI;
    return new Cartesian4(-Math.sin(longitude), Math.cos(longitude), 0, 0);
  }

  /**
   * @internal
   */
  private _updateView(): void {
    if (this._projectedWith !== this._projection) {
      const projection = this._projection!;
      const northWest = projection.project(new Cartographic(this._west, this._north));
      const southEast = projection.project(new Cartographic(this._east, this._south));
      this._planarPlanes[0].w = -northWest.x;
      this._planarPlanes[1].w = -southEast.x;
      this._planarPlanes[2].w = -southEast.y;
      this._planarPlanes[3].w = -northWest.y;
      this._projectedWith = projection;
      this._hasView = false;
    }
    const view = this._uniformState.view;
    // Native may move the camera for a second 2D viewport or frustum after
    // tileset.update. Compute at uniform use, once per actual Native view.
    if (this._hasView && Matrix4.equals(this._view, view))
      return;
    Matrix4.clone(view, this._view);
    this._hasView = true;
    for (let index = 0; index < this._planes.length; index++) {
      const plane = this._planes[index];
      const target = this._eyePlanes[index];
      target.x = view[0] * plane.x + view[4] * plane.y + view[8] * plane.z;
      target.y = view[1] * plane.x + view[5] * plane.y + view[9] * plane.z;
      target.z = view[2] * plane.x + view[6] * plane.y + view[10] * plane.z;
      target.w = plane.w - target.x * view[12] - target.y * view[13] - target.z * view[14];
    }
    // A latitude boundary has the same shape at every longitude. Choose
    // the camera meridian to keep its eye-space origin near low-altitude
    // fragments, including those in wide tiles at small zoom levels.
    const cameraX = -(view[0] * view[12] + view[1] * view[13] + view[2] * view[14]);
    const cameraY = -(view[4] * view[12] + view[5] * view[13] + view[6] * view[14]);
    const longitude = Math.atan2(cameraY, cameraX);
    const cosine = Math.cos(longitude);
    const sine = Math.sin(longitude);
    for (let index = 0; index < this._origins.length; index++) {
      const shape = this._shapes[index];
      shape.x = cosine;
      shape.y = sine;
      this._origins[index].x = shape.z * cosine;
      this._origins[index].y = shape.z * sine;
      const origin = Matrix4.multiplyByPoint(view, this._origins[index], this._eyeOrigins[index]);
      this._originColumn.x = origin.x;
      this._originColumn.y = origin.y;
      this._originColumn.z = origin.z;
      Matrix4.setColumn(this._packedLatitudes, index, this._originColumn, this._packedLatitudes);
      Matrix4.setColumn(this._packedLatitudes, index + 2, shape, this._packedLatitudes);
    }
    // Cesium uploads Matrix4 in column-major order; GLSL matrix[i] reads
    // the original vector without changing clip arithmetic or precision.
    for (let index = 0; index < 2; index++)
      Matrix4.setColumn(this._packedPlanes, index, this._eyePlanes[index], this._packedPlanes);
    for (let index = 0; index < 4; index++)
      Matrix4.setColumn(this._packedPlanar, index, this._eyePlanes[index + 2], this._packedPlanar);
  }
}
