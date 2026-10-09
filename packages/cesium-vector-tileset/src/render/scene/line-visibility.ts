import type { LinePaintUniforms, UniformLineExtent } from './draw-batch';
import type { RenderFrameState } from './render-frame';
import { BoundingSphere, Cartesian2, Cartesian3, Cartesian4, CullingVolume, Ellipsoid, Intersect, OrthographicFrustum, PerspectiveFrustum, SceneMode } from 'cesium';

export interface LineVisibilityScene {
  useWebVR?: boolean;
  _view?: { passState?: { viewport?: { x: number; y: number; width: number; height: number } } };
}

/** A side-plane test only: Native retains near clipping, depth and occlusion. */
export class LineVisibility {
  private readonly _volume = new CullingVolume(Array.from({ length: 4 }, () => new Cartesian4()));
  private readonly _sphere = new BoundingSphere();
  private readonly _position = new Cartesian3();
  private readonly _direction = new Cartesian3();
  private readonly _pixelSize = new Cartesian2();
  private _enabled = false;
  private _perspective = false;
  private _near = 0;
  private _pixelRatio = 0;

  prepare(frame: RenderFrameState, mode: SceneMode, scene?: LineVisibilityScene): void {
    this._enabled = false;
    if (mode !== SceneMode.SCENE3D || !frame.passes?.render || frame.passes.pick || scene?.useWebVR !== false)
      return;
    const viewport = scene._view?.passState?.viewport;
    const width = frame.context?.drawingBufferWidth;
    const height = frame.context?.drawingBufferHeight;
    const ratio = frame.pixelRatio;
    if (!viewport || viewport.x !== 0 || viewport.y !== 0 || viewport.width !== width || viewport.height !== height
      || !width || !height || !ratio || !Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(ratio)
      || width <= 0 || height <= 0 || ratio <= 0) {
      return;
    }
    const frustum = frame.camera.frustum;
    if (frustum instanceof PerspectiveFrustum) {
      if (frustum.xOffset !== 0 || frustum.yOffset !== 0 || !Number.isFinite(frustum.fov) || frustum.fov <= 0 || frustum.fov >= Math.PI)
        return;
    }
    else if (frustum instanceof OrthographicFrustum) {
      if (!Number.isFinite(frustum.width) || frustum.width <= 0)
        return;
    }
    else {
      return;
    }
    if (!Number.isFinite(frustum.near) || frustum.near <= 0 || !Number.isFinite(frustum.far) || frustum.far <= frustum.near
      || !Number.isFinite(frustum.aspectRatio) || frustum.aspectRatio <= 0) {
      return;
    }
    const position = frame.camera.positionWC;
    const direction = frame.camera.directionWC;
    if (!position || !direction || ![position.x, position.y, position.z, direction.x, direction.y, direction.z].every(Number.isFinite)
      || Math.abs(Cartesian3.magnitudeSquared(direction) - 1) > 1e-12) {
      return;
    }
    const planes = (frame.cullingVolume as CullingVolume | undefined)?.planes;
    if (!planes || planes.length < 4)
      return;
    for (let index = 0; index < 4; index++) {
      const plane = planes[index];
      if (![plane.x, plane.y, plane.z, plane.w].every(Number.isFinite))
        return;
      Cartesian4.clone(plane, this._volume.planes[index]);
    }
    frustum.getPixelDimensions(width, height, 1, 1, this._pixelSize);
    if (![this._pixelSize.x, this._pixelSize.y].every(value => Number.isFinite(value) && value > 0))
      return;
    Cartesian3.clone(position, this._position);
    Cartesian3.clone(direction, this._direction);
    this._perspective = frustum instanceof PerspectiveFrustum;
    this._near = frustum.near;
    this._pixelRatio = ratio;
    this._enabled = true;
  }

  outside(bounds: BoundingSphere | undefined, paint: LinePaintUniforms | undefined, extent: UniformLineExtent | undefined): boolean {
    if (!this._enabled || !bounds || !paint || !extent)
      return false;
    const { center, radius } = bounds;
    const { widthFactor, miterLimit } = extent;
    const metersPerPixel = paint.metersPerPixel;
    if (![center.x, center.y, center.z, radius, paint.width, metersPerPixel, widthFactor, miterLimit].every(Number.isFinite)
      || radius < 0 || paint.width < 0 || !metersPerPixel || metersPerPixel < 0 || widthFactor < 0 || miterLimit < 0) {
      return false;
    }
    const depth = (center.x - this._position.x) * this._direction.x
      + (center.y - this._position.y) * this._direction.y
      + (center.z - this._position.z) * this._direction.z;
    if (depth - radius <= this._near)
      return false;
    const distance = Cartesian3.distance(this._position, center) + radius;
    const cornerFactor = Math.max(Math.SQRT2, miterLimit);
    // The shader now expands the painted stroke in the ground plane. Its
    // WGS84 Jacobian can be bounded from the source sphere's outer radius,
    // including elevated geometry, without depending on camera distance.
    const groundScale = Math.max(1, (Cartesian3.magnitude(center) + radius) / Ellipsoid.WGS84.minimumRadius);
    const groundExpansion = (widthFactor * paint.width * 0.5 + 0.5 / this._pixelRatio)
      * metersPerPixel * groundScale * cornerFactor;
    // Keep device-pixel sample padding separate from the ground stroke. The
    // farthest point supplies its conservative perspective pixel footprint.
    const pixelPadding = 1.5 * cornerFactor * Math.max(this._pixelSize.x, this._pixelSize.y)
      * (this._perspective ? distance : 1);
    const expansion = groundExpansion + pixelPadding;
    if (!Number.isFinite(expansion))
      return false;
    BoundingSphere.clone(bounds, this._sphere);
    this._sphere.radius += expansion;
    return Number.isFinite(this._sphere.radius) && this._volume.computeVisibility(this._sphere) === Intersect.OUTSIDE;
  }
}
