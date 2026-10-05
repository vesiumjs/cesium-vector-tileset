import type { GeometryInstance, PrimitiveCollection } from 'cesium';
import type { FillExtrusionBucket } from '../../data/bucket-runtime';
import type { ExtrusionLighting } from './extrusion-geometry';
import type { TilePickObject } from './tile-conversion';
import { Cartesian3, CullFace, PerInstanceColorAppearance } from 'cesium';
import { GeometryPrimitive } from '../geometry/geometry-primitive';
import { extrusionStyleForFeature } from './feature-attributes';

// MapLibre's fill_extrusion.vertex.glsl lighting, with Native position,
// instance attributes, gamma correction, picking and depth handling.
const VERTEX_SHADER = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 a_extrusionNormal;
in float a_extrusionTop;
in float batchId;
uniform vec3 u_extrusionLightPosition;
uniform vec3 u_extrusionLightColor;
uniform float u_extrusionLightIntensity;
uniform bool u_extrusionLightEnabled;
out vec4 v_color;

vec3 cvt_extrusionColor(vec3 color, vec3 normal, vec3 shape, float top)
{
    if (!u_extrusionLightEnabled) return floor(color * 255.0 + 0.5);
    float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float directional = clamp(dot(normal, u_extrusionLightPosition), 0.0, 1.0);
    float intensity = u_extrusionLightIntensity;
    directional = mix(1.0 - intensity, max(1.0 - luminance + intensity, 1.0), directional);
    if (shape.z != 0.0 && normal.y != 0.0) {
        directional *= clamp((top + shape.x) * sqrt(shape.y / 150.0),
            mix(0.7, 0.98, 1.0 - intensity), 1.0);
    }
    vec3 lit = clamp((color + 0.03) * directional * u_extrusionLightColor,
        0.3 * (1.0 - u_extrusionLightColor), vec3(1.0));
    return floor(lit * 255.0 + 0.5);
}

void main()
{
    vec4 color = czm_batchTable_extrusionColor(batchId);
    vec3 shape = czm_batchTable_extrusionShape(batchId);
    vec3 normal = a_extrusionNormal / vec3(8192.0, 16384.0, 16384.0);
    // Each source triangle has one face normal. Interpolate its shaded
    // bottom/top values rather than the nonlinear gradient's input.
    vec3 bottom = cvt_extrusionColor(color.rgb, normal, shape, 0.0);
    vec3 top = cvt_extrusionColor(color.rgb, normal, shape, 1.0);
    v_color = vec4(floor(mix(bottom, top, clamp(a_extrusionTop, 0.0, 1.0))) / 255.0,
        floor(color.a * 255.0 + 0.5) / 255.0);
    gl_Position = czm_modelViewProjectionRelativeToEye * czm_computePosition();
}
`;

interface ExtrusionUniforms {
  u_extrusionLightPosition: Cartesian3;
  u_extrusionLightColor: Cartesian3;
  u_extrusionLightIntensity: number;
  u_extrusionLightEnabled: boolean;
}

const colorValue = new Float32Array(4);
const shapeValue = new Float32Array(3);

/** Layers whose initial zero opacity deferred their first geometry upload. */
export const deferredExtrusionLayers = new WeakMap<PrimitiveCollection, string[]>();

/** Native geometry owns shape; its instance table and Appearance own live paint. */
export class ExtrusionPrimitive extends GeometryPrimitive {
  private readonly _ids: TilePickObject[];
  private readonly _heights: Float64Array;
  private readonly _paintAppearance: PerInstanceColorAppearance & { uniforms: ExtrusionUniforms };

  constructor(instances: GeometryInstance[], lighting?: ExtrusionLighting) {
    const appearance = new PerInstanceColorAppearance({
      flat: true,
      translucent: false,
      // MapLibre extrusions draw outward faces once, including when alpha < 1.
      // Native closed translucent volumes would instead draw two passes.
      closed: false,
      renderState: { cull: { enabled: true, face: CullFace.BACK } },
      vertexShaderSource: VERTEX_SHADER,
    }) as PerInstanceColorAppearance & { uniforms: ExtrusionUniforms };
    appearance.uniforms = {
      u_extrusionLightPosition: new Cartesian3(),
      u_extrusionLightColor: new Cartesian3(),
      u_extrusionLightIntensity: 0,
      u_extrusionLightEnabled: false,
    };
    super({ geometryInstances: instances, appearance }, 'native');
    this._paintAppearance = appearance;
    this._ids = instances.map(instance => instance.id as TilePickObject);
    this._heights = new Float64Array(instances.length * 2);
    let visible = false;
    for (const [index, instance] of instances.entries()) {
      const shape = instance.attributes.extrusionShape.value;
      this._heights[index * 2] = shape[0];
      this._heights[index * 2 + 1] = shape[1];
      const alpha = instance.attributes.extrusionColor.value[3];
      appearance.translucent ||= alpha < 1;
      visible ||= alpha > 0;
    }
    this.show = visible;
    this.setLighting(lighting);
  }

  setLighting(lighting?: ExtrusionLighting): void {
    const uniforms = this._paintAppearance.uniforms;
    uniforms.u_extrusionLightEnabled = lighting !== undefined;
    if (lighting) {
      Cartesian3.fromArray(lighting.position, 0, uniforms.u_extrusionLightPosition);
      const color = uniforms.u_extrusionLightColor;
      color.x = lighting.color.red;
      color.y = lighting.color.green;
      color.z = lighting.color.blue;
      uniforms.u_extrusionLightIntensity = lighting.intensity;
    }
  }

  /** False means that height/base changed and the caller must rebuild shape. */
  updatePaint(bucket: FillExtrusionBucket, layerId: string, zoom: number): boolean {
    // Validate shape before changing any Native paint, so a replacement keeps
    // the complete predecessor while its new geometry is prepared.
    for (const [index, id] of this._ids.entries()) {
      const style = extrusionStyleForFeature(bucket, id.featureIndex, layerId, zoom);
      if (style.base !== this._heights[index * 2] || style.height !== this._heights[index * 2 + 1]) {
        return false;
      }
    }
    let translucent = false;
    let visible = false;
    for (const id of this._ids) {
      const style = extrusionStyleForFeature(bucket, id.featureIndex, layerId, zoom);
      const attributes = this.getGeometryInstanceAttributes(id);
      const color = style.color;
      colorValue[0] = color.red;
      colorValue[1] = color.green;
      colorValue[2] = color.blue;
      colorValue[3] = color.alpha;
      const current = attributes.extrusionColor as Float32Array;
      if (!colorValue.every((value, index) => value === current[index])) {
        attributes.extrusionColor = colorValue;
      }
      shapeValue[0] = style.base;
      shapeValue[1] = style.height;
      shapeValue[2] = style.verticalGradient ? 1 : 0;
      if ((attributes.extrusionShape as Float32Array)[2] !== shapeValue[2]) {
        attributes.extrusionShape = shapeValue;
      }
      translucent ||= color.alpha < 1;
      visible ||= color.alpha > 0;
    }
    this._paintAppearance.translucent = translucent;
    this.show = visible;
    return true;
  }
}
