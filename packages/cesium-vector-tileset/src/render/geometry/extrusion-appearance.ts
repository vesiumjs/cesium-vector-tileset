import type { Geometry, GeometryAttribute } from 'cesium';
import { PerInstanceColorAppearance } from 'cesium';

/** Select Native's position branches from the actual combined attributes. */
export class ExtrusionAppearance<Uniforms extends object = object> extends PerInstanceColorAppearance {
  declare uniforms: Uniforms;
  private readonly _sourceVertexShader: string;

  constructor(options?: ConstructorParameters<typeof PerInstanceColorAppearance>[0]) {
    super(options);
    this._sourceVertexShader = this.vertexShaderSource;
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
