import type { Material } from 'cesium';
import type { ExtrusionLighting } from '../vector/extrusion-geometry';
import { Cartesian2, Cartesian3, CullFace } from 'cesium';
import { ExtrusionAppearance } from '../geometry/extrusion-appearance';
import { EXTRUSION_LIGHT_ROTATION_SHADER } from '../vector/extrusion-geometry';

interface PatternExtrusionUniforms {
  u_extrusionTranslate: Cartesian2;
  u_extrusionMercator: boolean;
  u_pattern_scale: number;
  u_pattern_offset: Cartesian2;
  u_extrusionLightPosition: Cartesian3;
  u_extrusionLightColor: Cartesian3;
  u_extrusionLightIntensity: number;
  u_extrusionLightEnabled: boolean;
  u_extrusionLightRotation: Cartesian2;
  u_extrusionLightViewport: boolean;
}

const VERTEX_SHADER = `
in vec3 a_extrusionNormal;
in float a_extrusionTop;
in vec2 st;
in float batchId;
uniform float u_pattern_scale;
uniform vec2 u_pattern_offset;
uniform vec3 u_extrusionLightPosition;
uniform vec3 u_extrusionLightColor;
uniform float u_extrusionLightIntensity;
uniform bool u_extrusionLightEnabled;
out vec2 v_st;
out vec3 v_lighting;

${EXTRUSION_LIGHT_ROTATION_SHADER}

vec3 patternLighting(vec3 normal, vec3 shape, float top)
{
    if (!u_extrusionLightEnabled) return vec3(1.0);
    // Pattern lighting consumes the raw layout normal, including the top bit.
    normal.x = normal.x * 2.0 + top;
    float directional = clamp(dot(normal / 16383.0, cvt_extrusionLightPosition()), 0.0, 1.0);
    float intensity = u_extrusionLightIntensity;
    directional = mix(1.0 - intensity, max(0.5 + intensity, 1.0), directional);
    if (normal.z == 0.0) {
        float gradient = clamp((top + shape.x) * sqrt(shape.y / 150.0),
            mix(0.7, 0.98, 1.0 - intensity), 1.0);
        directional *= (1.0 - shape.z) + shape.z * gradient;
    }
    return clamp(directional * u_extrusionLightColor,
        0.3 * (1.0 - u_extrusionLightColor), vec3(1.0));
}

void main()
{
    vec3 shape = czm_batchTable_extrusionShape(batchId);
    // Subdivision interpolates the original shaded endpoints. Evaluating the
    // nonlinear gradient at fractional top weights would change the source face.
    vec3 bottom = patternLighting(a_extrusionNormal, shape, 0.0);
    vec3 top = patternLighting(a_extrusionNormal, shape, 1.0);
    v_lighting = mix(bottom, top, a_extrusionTop);
    v_st = st * u_pattern_scale + u_pattern_offset;
    gl_Position = czm_modelViewProjectionRelativeToEye * cvt_translateExtrusionPosition(cvt_computeExtrusionPosition(), shape, a_extrusionTop);
}
`;

const FRAGMENT_SHADER = `
in vec2 v_st;
in vec3 v_lighting;
void main()
{
    czm_materialInput materialInput;
    materialInput.s = v_st.x;
    materialInput.st = v_st;
    materialInput.str = vec3(v_st, 0.0);
    materialInput.normalEC = vec3(0.0, 0.0, 1.0);
    materialInput.positionToEyeEC = vec3(0.0);
    czm_material material = czm_getMaterial(materialInput);
    // Native uses straight alpha. The shared material applies opacity once;
    // lighting affects RGB, preserving the sprite alpha and depth compositor.
    out_FragColor = vec4((material.diffuse + material.emission) * v_lighting, material.alpha);
}
`;

/** Pattern-specific light formula with Native extrusion positions and shared atlas. */
export class PatternExtrusionAppearance extends ExtrusionAppearance<PatternExtrusionUniforms> {
  private readonly _mapLightRotation = new Cartesian2(1, 0);

  constructor(material: Material, coordinates: Pick<PatternExtrusionUniforms, 'u_pattern_scale' | 'u_pattern_offset'>, lighting?: ExtrusionLighting) {
    super({
      flat: true,
      closed: false,
      translucent: true,
      renderState: { cull: { enabled: true, face: CullFace.BACK } },
      vertexShaderSource: VERTEX_SHADER,
      fragmentShaderSource: FRAGMENT_SHADER,
    });
    this.material = material;
    this.uniforms = Object.assign(coordinates, {
      ...this.translationUniforms,
      u_extrusionLightPosition: new Cartesian3(),
      u_extrusionLightColor: new Cartesian3(),
      u_extrusionLightIntensity: 0,
      u_extrusionLightEnabled: false,
      u_extrusionLightRotation: this._mapLightRotation,
      u_extrusionLightViewport: false,
    });
    this.setLighting(lighting);
  }

  setLighting(lighting?: ExtrusionLighting): void {
    const uniforms = this.uniforms;
    uniforms.u_extrusionLightEnabled = lighting !== undefined;
    uniforms.u_extrusionLightViewport = lighting?.viewportRotation !== undefined;
    uniforms.u_extrusionLightRotation = lighting?.viewportRotation ?? this._mapLightRotation;
    if (!lighting)
      return;
    Cartesian3.fromArray(lighting.position, 0, uniforms.u_extrusionLightPosition);
    uniforms.u_extrusionLightColor.x = lighting.color.red;
    uniforms.u_extrusionLightColor.y = lighting.color.green;
    uniforms.u_extrusionLightColor.z = lighting.color.blue;
    uniforms.u_extrusionLightIntensity = lighting.intensity;
  }

  captureLighting(): ExtrusionLighting | undefined {
    const uniforms = this.uniforms;
    if (!uniforms.u_extrusionLightEnabled)
      return undefined;
    const position = uniforms.u_extrusionLightPosition;
    const color = uniforms.u_extrusionLightColor;
    return {
      position: [position.x, position.y, position.z],
      color: { red: color.x, green: color.y, blue: color.z },
      intensity: uniforms.u_extrusionLightIntensity,
      ...(uniforms.u_extrusionLightViewport ? { viewportRotation: uniforms.u_extrusionLightRotation } : {}),
    };
  }
}
