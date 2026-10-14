import type { Geometry, GeometryAttribute } from 'cesium';
import { Cartesian2, PerInstanceColorAppearance } from 'cesium';
import { MERCATOR_TRANSLATION_SHADER, mercatorTranslation } from './mercator-translation';

/** Select Native's position branches from the actual combined attributes. */
export class ExtrusionAppearance<Uniforms extends object = object> extends PerInstanceColorAppearance {
  declare uniforms: Uniforms;

  private readonly _sourceVertexShader: string;

  readonly translation = new Cartesian2();
  readonly translationUniforms = { u_extrusionTranslate: this.translation, u_extrusionMercator: true };
  private readonly _translationPixels = new Cartesian2();
  private _translationViewport = false;

  constructor(options?: ConstructorParameters<typeof PerInstanceColorAppearance>[0]) {
    super(options);
    this._sourceVertexShader = this.vertexShaderSource;
  }

  setTranslation(pixels: readonly [number, number], viewport: boolean, zoom: number, bearing?: number): void {
    this._translationPixels.x = pixels[0];
    this._translationPixels.y = pixels[1];
    this._translationViewport = viewport;
    mercatorTranslation(this._translationPixels, this._translationViewport, zoom, bearing, this.translation);
  }

  configurePositions(geometry: Geometry): void {
    const attributes = geometry.attributes as unknown as Record<string, GeometryAttribute>;
    if (!attributes.a_extrusionHigh3D || !attributes.a_extrusionLow3D)
      throw new TypeError('Extrusion appearance requires packed 3D positions');
    const hasCV = attributes.a_extrusionHigh2D !== undefined;
    if (hasCV !== (attributes.a_extrusionLow2D !== undefined))
      throw new TypeError('Extrusion appearance requires a complete CV position pair');
    // Names avoid Native's *3DHigh declaration regex. RTE and morph expressions
    // retain Primitive._modifyShaderPosition's original evaluation order.
    const positionShader = `
in vec3 a_extrusionHigh3D;
in vec3 a_extrusionLow3D;
${hasCV ? 'in vec3 a_extrusionHigh2D;\nin vec3 a_extrusionLow2D;' : ''}
uniform vec2 u_extrusionTranslate;
uniform bool u_extrusionMercator;
${MERCATOR_TRANSLATION_SHADER}
vec3 cvt_extrusionGroundNormal(vec3 position, float height)
{
    vec3 radiiSquared = czm_ellipsoidRadii * czm_ellipsoidRadii;
    vec3 normal = normalize(position);
    // D stays between the ellipsoid radii at any nonnegative height. For
    // WGS84 this angular mapping contracts by < 3e-6, including h > radius;
    // four steps leave only float32 rounding, without subtracting h*normal.
    for (int i = 0; i < 4; ++i) {
        float denominator = sqrt(dot(normal, radiiSquared * normal));
        normal = normalize(position / (radiiSquared / denominator + vec3(height)));
    }
    return normal;
}
vec4 cvt_translateExtrusionPosition(vec4 position, vec3 shape, float top)
{
    if (any(notEqual(u_extrusionTranslate, vec2(0.0)))) {
        float height = mix(shape.x, shape.y, top);
        vec3 normal = cvt_extrusionGroundNormal(a_extrusionHigh3D * 65536.0 + a_extrusionLow3D, height);
        vec3 deltaWorld;
        position.xyz += cvt_mercatorDelta(normal, u_extrusionTranslate, height, u_extrusionMercator, deltaWorld);
    }
    return position;
}
vec4 cvt_computeExtrusionPosition()
{
${hasCV
  ? `    vec4 p;
    if (czm_morphTime == 1.0)
    {
        p = czm_translateRelativeToEye(a_extrusionHigh3D * 65536.0, a_extrusionLow3D);
    }
    else if (czm_morphTime == 0.0)
    {
        p = czm_translateRelativeToEye((a_extrusionHigh2D * 65536.0).zxy, a_extrusionLow2D.zxy);
    }
    else
    {
        p = czm_columbusViewMorph(
                czm_translateRelativeToEye((a_extrusionHigh2D * 65536.0).zxy, a_extrusionLow2D.zxy),
                czm_translateRelativeToEye(a_extrusionHigh3D * 65536.0, a_extrusionLow3D),
                czm_morphTime);
    }
    return p;`
  : '    return czm_translateRelativeToEye(a_extrusionHigh3D * 65536.0, a_extrusionLow3D);'}
}
`;
    // Native's public getter reads this backing field. Configure it before
    // Native creates the program, retaining the authoritative live Appearance.
    Object.assign(this, { _vertexShaderSource: positionShader + this._sourceVertexShader });
  }
}
