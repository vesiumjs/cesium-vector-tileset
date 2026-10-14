import type { CircleBucket } from '../../data/bucket-runtime';
import type { PointRenderPrimitive } from '../vector/tile-conversion';
import { BoundingSphere, Cartesian2, Cartesian3, Cartesian4, ColorGeometryInstanceAttribute, ComponentDatatype, Geometry, GeometryAttribute, GeometryAttributes, GeometryInstance, GeometryInstanceAttribute, Material, MaterialAppearance, PrimitiveCollection, PrimitiveType, SceneMode, ShowGeometryInstanceAttribute, WebMercatorProjection } from 'cesium';
import { GeometryPrimitive } from '../geometry/geometry-primitive';
import { MERCATOR_TRANSLATION_SHADER, mercatorTranslation, mercatorTranslationPadding } from '../geometry/mercator-translation';
import { columbusCameraFocus, globeCameraFocus } from '../scene/camera-focus';
import { registerDrawBatch } from '../scene/draw-batch';
import { DrawCommandReplay } from '../scene/draw-command-replay';
import { circleStyleForFeature, constantValue, layerFor } from '../vector/feature-attributes';
import { freezeCircleCameraPaint } from './frozen-circle-paint';

const vertexShader = `
uniform float u_circle_camera_distance;
uniform float u_circle_meters_per_pixel;
uniform float u_circle_device_pixel_ratio;
uniform float u_circle_pitch_map;
uniform float u_circle_scale_map;
uniform float u_circle_mercator;
uniform vec2 u_circle_translate;
uniform vec3 u_circle_uniform_dimensions;
in vec3 position3DHigh;
in vec3 position3DLow;
in vec2 a_extrude;
in float batchId;
out vec4 v_circle_fill;
out vec4 v_circle_stroke;
out vec4 v_circle_data;
out vec3 v_positionEC;
out vec3 v_normalEC;
out vec2 v_st;

// Difference formulas preserve sub-centimetre offsets at high camera zoom.
float circleTan(float angle) {
    float square = angle * angle;
    return abs(angle) < 0.01 ? angle * (1.0 + square * (1.0 / 3.0 + square * 2.0 / 15.0)) : tan(angle);
}
${MERCATOR_TRANSLATION_SHADER}
vec3 circleGroundDelta(vec3 normal, vec2 metres) {
    if (czm_morphTime == 0.0 && u_circle_mercator > 0.5)
        return (czm_modelViewRelativeToEye * vec4(0.0, metres.x, metres.y, 0.0)).xyz;
    vec3 east = normalize(vec3(-normal.y, normal.x, 0.0));
    vec3 north = cross(normal, east);
    vec2 angle = metres / czm_ellipsoidRadii.x;
    vec2 tangent = vec2(circleTan(angle.x), circleTan(angle.y));
    float square = dot(tangent, tangent);
    float denominator = sqrt(1.0 + square);
    // MapLibre globeRotateVector, based at the translated center.
    vec3 deltaNormal = normal * (-square / (denominator * (denominator + 1.0)))
        + (east * tangent.x + north * tangent.y) / denominator;
    vec3 deltaWorld = cvt_ellipsoidDelta(normal, deltaNormal, 0.0);
    vec3 delta3D = (czm_modelViewRelativeToEye * vec4(deltaWorld, 0.0)).xyz;
    float northMetres = u_circle_mercator > 0.5 ? metres.y : metres.y * length(normal.xy);
    vec3 delta2D = (czm_modelViewRelativeToEye * vec4(0.0, metres.x, northMetres, 0.0)).xyz;
    return mix(delta2D, delta3D, czm_morphTime);
}
void main() {
    bool translated = any(notEqual(u_circle_translate, vec2(0.0)));
    vec3 normal = vec3(0.0);
    if (translated || u_circle_pitch_map > 0.5)
        normal = czm_geodeticSurfaceNormal(position3DHigh + position3DLow,
            vec3(0.0), czm_ellipsoidInverseRadii * czm_ellipsoidInverseRadii);
    vec3 deltaWorld = vec3(0.0);
    vec3 deltaEC = vec3(0.0);
    if (translated) {
        vec3 delta = cvt_mercatorDelta(normal, u_circle_translate, 0.0, u_circle_mercator > 0.5, deltaWorld);
        deltaEC = (czm_modelViewRelativeToEye * vec4(delta, 0.0)).xyz;
    }
    if (czm_sceneMode == czm_sceneMode3D) {
        vec3 camera = czm_viewerPositionWC * czm_ellipsoidInverseRadii;
        vec3 anchor = (position3DHigh + position3DLow + deltaWorld) * czm_ellipsoidInverseRadii;
        vec3 toAnchor = anchor - camera;
        float limbSquared = dot(camera, camera) - 1.0;
        float towardCamera = -dot(toAnchor, camera);
        bool occluded = limbSquared < 0.0 ? towardCamera > 0.0
            : towardCamera > limbSquared && towardCamera * towardCamera > limbSquared * dot(toAnchor, toAnchor);
        if (occluded) {
            gl_Position = vec4(-2.0, -2.0, -2.0, 1.0);
            return;
        }
    }
    vec4 positionEC = czm_modelViewRelativeToEye * czm_computePosition();
    positionEC.xyz += deltaEC;
    vec4 clip = czm_projection * positionEC;
    vec3 dimensions = czm_batchTable_circleDimensions(batchId);
    dimensions = mix(dimensions, u_circle_uniform_dimensions, step(vec3(0.0), u_circle_uniform_dimensions));
    float radius = dimensions.x;
    float stroke = dimensions.y;
    float extent = radius + stroke;
    if (!(extent > 0.0) || !(clip.w > 0.0)) {
        gl_Position = vec4(-2.0, -2.0, -2.0, 1.0);
        return;
    }
    float distance = max(u_circle_camera_distance, 1.0e-12);
    if (u_circle_pitch_map > 0.5) {
        float scale = u_circle_scale_map > 0.5 ? 1.0 : clip.w / distance;
        vec2 metres = a_extrude * extent * u_circle_meters_per_pixel * scale;
        gl_Position = clip + czm_projection * vec4(circleGroundDelta(normal, metres), 0.0);
    } else {
        float scale = u_circle_scale_map > 0.5 ? distance : clip.w;
        gl_Position = clip;
        gl_Position.xy += a_extrude * extent * czm_pixelRatio * 2.0 / czm_viewport.zw * scale;
    }
    v_circle_fill = czm_batchTable_color(batchId);
    v_circle_stroke = czm_batchTable_strokeColor(batchId);
    v_circle_data = vec4(a_extrude, -max(1.0 / u_circle_device_pixel_ratio / extent, dimensions.z), stroke < 0.01 ? 1.0 : radius / extent);
    v_positionEC = positionEC.xyz;
    v_normalEC = vec3(0.0, 0.0, 1.0);
    v_st = a_extrude;
}
`;

const materialSource = `
in vec4 v_circle_fill;
in vec4 v_circle_stroke;
in vec4 v_circle_data;
czm_material czm_getMaterial(czm_materialInput materialInput) {
    float distance = length(v_circle_data.xy);
    float coverage = smoothstep(0.0, v_circle_data.z, distance - 1.0);
    float strokeMix = v_circle_data.w >= 1.0 ? 0.0
        : smoothstep(v_circle_data.z, 0.0, distance - v_circle_data.w);
    vec4 fill = vec4(v_circle_fill.rgb * v_circle_fill.a, v_circle_fill.a);
    vec4 stroke = vec4(v_circle_stroke.rgb * v_circle_stroke.a, v_circle_stroke.a);
    vec4 color = coverage * mix(fill, stroke, strokeMix);
    if (color.a < 0.5 / 255.0) discard;
    czm_material material = czm_getDefaultMaterial(materialInput);
    material.diffuse = color.a > 0.0 ? color.rgb / color.a : vec3(0.0);
    material.alpha = color.a;
    return material;
}
`;

interface CircleEntry extends PointRenderPrimitive {
  primitive?: CirclePrimitive;
  index: number;
  attributes: GeometryInstance['attributes'];
}

type CircleFrame = Parameters<GeometryPrimitive['update']>[0] & {
  camera: Parameters<typeof globeCameraFocus>[0] & { _scene?: { _view: { passState: { viewport: { x: number; y: number; width: number; height: number } } } } };
  pixelRatio: number;
  context: { drawingBufferWidth: number; drawingBufferHeight: number; elementIndexUint: boolean };
};

interface CircleCamera {
  frame?: number;
  distance: number;
  metresPerPixel: number;
  mercator: number;
  viewportX: number;
  viewportY: number;
  width: number;
  height: number;
  projectionX: number;
  projectionY: number;
  projectionOffsetX: number;
  projectionOffsetY: number;
}
declare class _NativeCircleCollection extends PrimitiveCollection {
  update(frame?: unknown): void;
}
const RuntimeCircleCollection = PrimitiveCollection as typeof _NativeCircleCollection;

const cameraMeasurements = new WeakMap<object, CircleCamera>();
const pixelDimensions = new Cartesian2();

function circleGeometry(position: Cartesian3, subdivided: boolean): Geometry {
  // MapLibre's globe circle granularity 3 retains the encoded extrusion slots
  // 0, 2, 5, 7, so the interior also follows the spherical surface.
  const extrudes = subdivided ? [-1, -3 / 7, 3 / 7, 1] : [-1, 1];
  const side = extrudes.length;
  const positions = new Float64Array(side * side * 3);
  const vertices = new Float32Array(side * side * 2);
  const indices = new Uint16Array((side - 1) ** 2 * 6);
  let index = 0;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const vertex = y * side + x;
      positions[vertex * 3] = position.x;
      positions[vertex * 3 + 1] = position.y;
      positions[vertex * 3 + 2] = position.z;
      vertices[vertex * 2] = extrudes[x];
      vertices[vertex * 2 + 1] = extrudes[y];
      if (x + 1 < side && y + 1 < side) {
        indices.set([vertex, vertex + side + 1, vertex + 1, vertex, vertex + side, vertex + side + 1], index);
        index += 6;
      }
    }
  }
  return new Geometry({ attributes: Object.assign(new GeometryAttributes(), {
    position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }),
    a_extrude: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 2, values: vertices }),
  }), indices,
  // Native POINTS preparation preserves coincident centers across the date line.
  primitiveType: PrimitiveType.POINTS, boundingSphere: new BoundingSphere(position, 0) });
}

class CirclePrimitive extends GeometryPrimitive {
  private readonly _attributeIndices = new Map<string, number>();
  private readonly _bounds = new WeakMap<BoundingSphere, BoundingSphere>();
  private readonly _commands = new WeakMap<object, DrawCommandReplay>();
  private readonly _entries: CircleEntry[];
  private readonly _uniforms: Material['uniforms'];
  private _radius = 0;
  private _stroke = 0;
  private _dimensionsDirty = false;

  constructor(instances: GeometryInstance[], entries: CircleEntry[], appearance: MaterialAppearance) {
    super({ geometryInstances: instances, appearance, compressVertices: false, vertexCacheOptimize: false }, 'native');
    this.cull = false;
    this._entries = entries;
    this._uniforms = appearance.material.uniforms;
    for (let index = 0; index < entries.length; index++) {
      entries[index].primitive = this;
      entries[index].index = index;
      this._radius = Math.max(this._radius, entries[index].style.sizePx / 2);
      this._stroke = Math.max(this._stroke, entries[index].style.outlineWidthPx);
    }
  }

  setAttribute(entry: CircleEntry, name: string, values: Uint8Array | Float32Array): void {
    entry.attributes[name].value = values;
    if (name === 'circleDimensions')
      this._dimensionsDirty = true;
    const table = this._batchTable;
    if (!table)
      return;
    if (this._attributeIndices.size === 0) {
      for (let index = 0; index < table.attributes.length; index++)
        this._attributeIndices.set(table.attributes[index].functionName, index);
    }
    const index = this._attributeIndices.get(`czm_batchTable_${name}`);
    if (index === undefined)
      throw new Error(`Missing circle instance attribute ${name}`);
    table.setBatchedAttribute(entry.index, index, values.length === 1
      ? values[0]
      : new Cartesian4(values[0], values[1], values[2], values[3] ?? 0));
  }

  override update(frame?: Parameters<GeometryPrimitive['update']>[0]): void {
    if (frame)
      updateCameraUniforms(frame as CircleFrame, this._uniforms);
    const start = frame?.commandList?.length ?? 0;
    super.update(frame);
    if (!frame?.commandList)
      return;
    for (let index = start; index < frame.commandList.length; index++) {
      const command = frame.commandList[index];
      if ((command as { owner?: object }).owner !== this)
        continue;
      (command as { primitiveType: number }).primitiveType = PrimitiveType.TRIANGLES;
      const source = command.boundingVolume;
      const state = frame as CircleFrame;
      const translate = this._uniforms.u_circle_translate as Cartesian2;
      const translated = translate.x !== 0 || translate.y !== 0;
      const groundRadius = this._uniforms.u_circle_pitch_map === 1 && state.mode !== SceneMode.SCENE2D;
      // Viewport corners retain their center depth, but ground translation
      // moves that center even when frustum culling is disabled.
      if (!source || (!translated && !groundRadius))
        continue;
      if (this._dimensionsDirty) {
        this._radius = this._stroke = 0;
        for (const entry of this._entries) {
          const dimensions = entry.attributes.circleDimensions.value;
          this._radius = Math.max(this._radius, dimensions[0]);
          this._stroke = Math.max(this._stroke, dimensions[1]);
        }
        this._dimensionsDirty = false;
      }
      const dimensions = this._uniforms.u_circle_uniform_dimensions as Cartesian3;
      const extent = (dimensions.x >= 0 ? dimensions.x : this._radius) + (dimensions.y >= 0 ? dimensions.y : this._stroke);
      const ellipsoid = state.mapProjection.ellipsoid;
      // Longitude has unit angular scale; inverse-Mercator latitude has
      // derivative cos(latitude) <= 1. This bound covers every anchor in the
      // Native batch without a per-frame feature walk.
      const translatePadding = mercatorTranslationPadding(translate, ellipsoid, state.mode);
      let scale = 1;
      if (groundRadius && this._uniforms.u_circle_scale_map !== 1) {
        const camera = state.camera;
        const centerDepth = (source.center.x - camera.positionWC.x) * camera.directionWC.x
          + (source.center.y - camera.positionWC.y) * camera.directionWC.y
          + (source.center.z - camera.positionWC.z) * camera.directionWC.z;
        scale = Math.max(0, centerDepth + source.radius + translatePadding) / this._uniforms.u_circle_camera_distance;
      }
      let padding = groundRadius ? Math.SQRT2 * Math.max(0, extent) * this._uniforms.u_circle_meters_per_pixel * scale : 0;
      if (state.mode === SceneMode.SCENE3D) {
        // Normal-to-ellipsoid scaling is bounded by the squared radii ratio;
        // any two surface points are at most one diameter apart.
        padding = Math.min(2 * ellipsoid.maximumRadius, padding * (ellipsoid.maximumRadius / ellipsoid.minimumRadius) ** 2);
      }
      let bounds = this._bounds.get(source);
      if (!bounds) {
        bounds = new BoundingSphere();
        this._bounds.set(source, bounds);
      }
      BoundingSphere.clone(source, bounds);
      bounds.radius += translatePadding + padding;
      let replay = this._commands.get(command);
      if (!replay) {
        replay = new DrawCommandReplay(command);
        this._commands.set(command, replay);
      }
      frame.commandList[index] = replay.update(command, bounds);
    }
  }
}

/** One layer's circles share a quad appearance in every Cesium scene mode. */
export class CircleCollection extends RuntimeCircleCollection {
  readonly layerId: string;
  readonly entries: CircleEntry[] = [];
  private readonly _appearance: MaterialAppearance;
  private readonly _tileId: string;
  private readonly _mode: SceneMode;
  private _subdivided = false;
  private _instances: GeometryInstance[] = [];
  private _pending: CircleEntry[] = [];
  private readonly _translate = new Cartesian2();
  private _translateViewport = false;

  constructor(layerId: string, tileId: string, pixelRatio: number, mode: SceneMode) {
    super();
    this.layerId = layerId;
    this._tileId = tileId;
    this._mode = mode;
    registerDrawBatch(this, { layerId, tileId: this._tileId, kind: 'circle' });
    const material = new Material({ fabric: { type: 'CvtCircle', source: materialSource }, translucent: true });
    const uniforms = (material as Material & { _uniforms: Record<string, () => unknown> })._uniforms;
    material.uniforms.u_circle_camera_distance = 1;
    material.uniforms.u_circle_meters_per_pixel = 1;
    material.uniforms.u_circle_device_pixel_ratio = pixelRatio;
    material.uniforms.u_circle_pitch_map = 0;
    material.uniforms.u_circle_scale_map = 1;
    material.uniforms.u_circle_mercator = 1;
    material.uniforms.u_circle_translate = new Cartesian2();
    material.uniforms.u_circle_uniform_dimensions = new Cartesian3(-1, -1, -1);
    for (const name of Object.keys(material.uniforms)) uniforms[name] = () => material.uniforms[name];
    this._appearance = new MaterialAppearance({ material, translucent: true, flat: true, closed: false, vertexShaderSource: vertexShader, renderState: { depthTest: { enabled: true }, depthMask: false, cull: { enabled: false } } });
  }

  append(point: PointRenderPrimitive): void {
    const style = point.style;
    const dimensions = new Float32Array([style.sizePx / 2, style.outlineWidthPx, style.blur]);
    const attributes = {
      color: ColorGeometryInstanceAttribute.fromColor(style.color),
      strokeColor: ColorGeometryInstanceAttribute.fromColor(style.outlineColor),
      circleDimensions: new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, value: [...dimensions] }),
      show: new ShowGeometryInstanceAttribute(true),
    };
    const entry = { position: point.position, style: point.style, pickObject: point.pickObject, attributes, index: this._pending.length };
    this.entries.push(entry);
    this._pending.push(entry);
    this._instances.push(new GeometryInstance({ id: point.pickObject, attributes, geometry: circleGeometry(point.position, this._subdivided) }));
    if (this._instances.length === 512)
      this.finish();
  }

  finish(): void {
    if (this._instances.length === 0)
      return;
    const primitive = new CirclePrimitive(this._instances, this._pending, this._appearance);
    registerDrawBatch(primitive, { layerId: this.layerId, tileId: this._tileId, kind: 'circle' });
    this.add(primitive);
    this._instances = [];
    this._pending = [];
  }

  updatePolicy(bucket: CircleBucket, pixelRatio: number): void {
    const layer = layerFor(bucket, this.layerId);
    const uniforms = this._appearance.material.uniforms;
    uniforms.u_circle_pitch_map = constantValue(layer, 'circle-pitch-alignment') === 'map' ? 1 : 0;
    uniforms.u_circle_scale_map = constantValue(layer, 'circle-pitch-scale') === 'map' ? 1 : 0;
    uniforms.u_circle_device_pixel_ratio = pixelRatio;
    const translate = constantValue(layer, 'circle-translate') as [number, number];
    this._translate.x = translate[0];
    this._translate.y = translate[1];
    this._translateViewport = constantValue(layer, 'circle-translate-anchor') === 'viewport';
    const dimensions = uniforms.u_circle_uniform_dimensions as Cartesian3;
    const radius = constantValue(layer, 'circle-radius');
    const stroke = constantValue(layer, 'circle-stroke-width');
    const blur = constantValue(layer, 'circle-blur');
    dimensions.x = typeof radius === 'number' ? radius : -1;
    dimensions.y = typeof stroke === 'number' ? stroke : -1;
    dimensions.z = typeof blur === 'number' ? blur : -1;
    const subdivided = this._mode === SceneMode.SCENE3D && uniforms.u_circle_pitch_map === 1;
    // A globe alignment change creates a budgeted tile generation before
    // publication; uploaded owners retain their original topology.
    if (this.entries.length === 0)
      this._subdivided = subdivided;
  }

  /** Convert paint pixels using the physical camera, independently of source LOD. */
  updateCamera(zoom: number, bearing?: number): void {
    mercatorTranslation(this._translate, this._translateViewport, zoom, bearing, this._appearance.material.uniforms.u_circle_translate as Cartesian2);
  }

  /** Held paint owns the old schema and data while evaluating its camera curves. */
  captureCameraPaint(bucket: CircleBucket): (zoom: number, bearing?: number) => void {
    const paint = freezeCircleCameraPaint(bucket, this.layerId);
    const pixelRatio = this._appearance.material.uniforms.u_circle_device_pixel_ratio as number;
    let evaluatedZoom: number | undefined;
    return (zoom, bearing) => {
      if (paint && evaluatedZoom !== zoom) {
        paint.evaluate(zoom);
        this.updatePolicy(paint.bucket, pixelRatio);
        if (paint.featureCamera)
          this.updatePaint(paint.bucket, zoom);
        evaluatedZoom = zoom;
      }
      this.updateCamera(zoom, bearing);
    };
  }

  /** Uniform dimensions follow continuous zoom without visiting each feature. */
  needsZoomPaint(bucket: CircleBucket): boolean {
    const layer = layerFor(bucket, this.layerId);
    const config = bucket.programConfigurations.get(layer.id);
    if (config.hasCompositeProperties())
      return true;
    const paints = (layer as typeof layer & {
      _transitionablePaint: { _values: Record<string, { value: { expression?: { kind?: string } } }> };
    })._transitionablePaint._values;
    return ['circle-color', 'circle-opacity', 'circle-stroke-color', 'circle-stroke-opacity']
      .some(property => paints[property]?.value.expression?.kind === 'camera');
  }

  updatePaint(bucket: CircleBucket, zoom: number): void {
    for (const entry of this.entries) {
      const style = circleStyleForFeature(bucket, entry.pickObject.featureIndex, this.layerId, zoom);
      const previous = entry.style;
      if (previous.color.toRgba() !== style.color.toRgba())
        entry.primitive!.setAttribute(entry, 'color', ColorGeometryInstanceAttribute.toValue(style.color));
      if (previous.outlineColor.toRgba() !== style.outlineColor.toRgba())
        entry.primitive!.setAttribute(entry, 'strokeColor', ColorGeometryInstanceAttribute.toValue(style.outlineColor));
      if (previous.sizePx !== style.sizePx || previous.outlineWidthPx !== style.outlineWidthPx || previous.blur !== style.blur)
        entry.primitive!.setAttribute(entry, 'circleDimensions', new Float32Array([style.sizePx / 2, style.outlineWidthPx, style.blur]));
      entry.style = style;
    }
  }

  override destroy(): void {
    this.entries.length = 0;
    this._instances.length = 0;
    this._pending.length = 0;
    super.destroy();
  }
}

function updateCameraUniforms(state: CircleFrame, uniforms: Material['uniforms']): void {
  if (state?.camera && state.mapProjection) {
    const camera = state.camera;
    // Scene mutates this viewport and frustum between 2D date-line passes.
    // UniformState.viewport is only applied later, when commands execute.
    const viewport = camera._scene?._view.passState.viewport;
    const viewportX = viewport?.x ?? 0;
    const viewportY = viewport?.y ?? 0;
    const width = (viewport?.width ?? state.context.drawingBufferWidth) / state.pixelRatio;
    const height = (viewport?.height ?? state.context.drawingBufferHeight) / state.pixelRatio;
    const projection = camera.frustum.projectionMatrix;
    let measurement = cameraMeasurements.get(state);
    if (!measurement || measurement.frame !== state.frameNumber
      || measurement.viewportX !== viewportX || measurement.viewportY !== viewportY
      || measurement.width !== width || measurement.height !== height
      || measurement.projectionX !== projection[0] || measurement.projectionY !== projection[5]
      || measurement.projectionOffsetX !== projection[8] || measurement.projectionOffsetY !== projection[9]) {
      const scale = state.mode === SceneMode.SCENE3D
        ? globeCameraFocus(camera, state.mapProjection, width, height)
        : columbusCameraFocus(camera, state.mapProjection, height);
      const distance = state.mode === SceneMode.SCENE2D
        ? 1
        : scale?.cameraToCenterDistance ?? (camera.directionWC.x < 0 ? camera.positionWC.x / -camera.directionWC.x : 1);
      const pixels = camera.frustum.getPixelDimensions(width, height, distance, 1, pixelDimensions);
      measurement = { frame: state.frameNumber, distance, metresPerPixel: pixels.x, mercator: state.mapProjection instanceof WebMercatorProjection ? 1 : 0, viewportX, viewportY, width, height, projectionX: projection[0], projectionY: projection[5], projectionOffsetX: projection[8], projectionOffsetY: projection[9] };
      cameraMeasurements.set(state, measurement);
    }
    uniforms.u_circle_camera_distance = measurement.distance;
    uniforms.u_circle_meters_per_pixel = measurement.metresPerPixel;
    uniforms.u_circle_mercator = measurement.mercator;
  }
}
