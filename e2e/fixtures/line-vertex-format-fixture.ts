import type { MapProjection } from 'cesium';
import type { LinePrimitiveGeometry } from '../../packages/cesium-vector-tileset/src/data/projected-geometry';
import type { SceneCollections } from '../../packages/cesium-vector-tileset/src/render/scene/scene-collections';
import type { ReferenceLineBake } from './line-float-reference';
import Point from '@mapbox/point-geometry';
import * as Cesium from 'cesium';
import { BoundingSphere, Cartesian2, Cartesian3, Cartographic, Color, ColorGeometryInstanceAttribute, ComponentDatatype, Ellipsoid, Geometry, GeometryAttribute, GeometryInstance, GeometryInstanceAttribute, GeometryPipeline, Matrix4, PolylineColorAppearance, Primitive, PrimitiveCollection, PrimitiveType, WebMercatorProjection } from 'cesium';
import { LineBucket } from '../../packages/cesium-vector-tileset/src/data/bucket/line-bucket';
import { EXTENT } from '../../packages/cesium-vector-tileset/src/data/extent';
import { GeometryPrimitive } from '../../packages/cesium-vector-tileset/src/render/geometry/geometry-primitive';
import { LineGeometryCache } from '../../packages/cesium-vector-tileset/src/render/line/line-geometry';
import { LINE_AA_FS, LINE_AA_VS } from '../../packages/cesium-vector-tileset/src/render/line/line-renderer';
import { cameraZoom } from '../../packages/cesium-vector-tileset/src/render/scene/covering';
import { captureUploadedPrimitiveBytes, collectionGpuBytes, rememberPrimitiveBytes } from '../../packages/cesium-vector-tileset/src/render/scene/resource-memory';
import { lineBucketPrimitives } from '../../packages/cesium-vector-tileset/src/render/vector/bucket-geometry';
import { EvaluationParameters } from '../../packages/cesium-vector-tileset/src/style/evaluation-parameters';
import { LineStyleLayer } from '../../packages/cesium-vector-tileset/src/style/style-layer/line-style-layer';
import { CanonicalTileID } from '../../packages/cesium-vector-tileset/src/tile/tile-id';
import { bakeReferenceLine, REFERENCE_LINE_AA_FS, REFERENCE_LINE_AA_VS, REFERENCE_PLANAR_LINE_AA_VS } from './line-float-reference';

interface ReferenceFrame {
  mapProjection: MapProjection;
  scene3DOnly: boolean;
  context: { elementIndexUint: boolean };
  passes: { render: boolean; pick: boolean };
}

interface ReferenceCombineResult {
  geometries: Array<Geometry & { boundingSphereCV?: BoundingSphere }>;
  modelMatrix: Matrix4;
  pickOffsets: unknown;
  offsetInstanceExtend: unknown;
  boundingSpheres: Array<BoundingSphere | undefined>;
  boundingSpheresCV: Array<BoundingSphere | undefined>;
}

interface NativeReferenceRuntime {
  PrimitivePipeline: {
    combineGeometry: (parameters: {
      instances: GeometryInstance[];
      ellipsoid: MapProjection['ellipsoid'];
      projection: MapProjection;
      elementIndexUintSupported: boolean;
      scene3DOnly: boolean;
      vertexCacheOptimize: boolean;
      compressVertices: boolean;
      modelMatrix: Matrix4;
      createPickOffsets?: boolean;
    }) => ReferenceCombineResult;
  };
  PrimitiveState: { COMBINED: number };
}

const nativeReference = Cesium as unknown as NativeReferenceRuntime;

/** Assemble the original FLOAT layout directly from the raw bake, before packing. */
function nativeFloatGeometry(baked: ReferenceLineBake, source: LinePrimitiveGeometry, tile: CanonicalTileID, planar: boolean, projection: MapProjection): Geometry {
  const floatAttribute = (componentsPerAttribute: number, values: Float32Array) => new GeometryAttribute({
    componentDatatype: ComponentDatatype.FLOAT,
    componentsPerAttribute,
    values,
  });
  const attributes: Record<string, GeometryAttribute> = {
    position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: baked.positions }),
    expandAndWidth: floatAttribute(2, baked.expandAndWidthUnit),
    a_corner: floatAttribute(1, baked.corners),
    a_cornerParam: floatAttribute(1, baked.cornerParams),
  };
  if (planar) {
    // The frozen oracle owns its topology. Clean and project the authored
    // source independently of the production geometry preparation.
    const vertices = baked.projection?.vertices;
    if (!vertices)
      throw new Error('Native FLOAT reference requires source vertex topology');
    const clean: number[] = [];
    for (let index = 0; index < source.tilePositions.length / 2; index++) {
      const previous = clean[clean.length - 1];
      if (previous === undefined || source.tilePositions[index * 2] !== source.tilePositions[previous * 2]
        || source.tilePositions[index * 2 + 1] !== source.tilePositions[previous * 2 + 1]) {
        clean.push(index);
      }
    }
    const first = clean[0];
    const last = clean[clean.length - 1];
    const closed = clean.length > 3 && source.tilePositions[first * 2] === source.tilePositions[last * 2]
      && source.tilePositions[first * 2 + 1] === source.tilePositions[last * 2 + 1];
    if (closed)
      clean.pop();
    const projected = clean.map((index) => {
      const cartesian = Cartesian3.unpack(source.positions as unknown as number[], index * 3);
      const point = projection.ellipsoid.cartesianToCartographic(cartesian, new Cartographic());
      if (!point)
        throw new Error('Native FLOAT reference cannot project its authored source');
      point.longitude = ((tile.x + source.tilePositions[index * 2] / EXTENT) / 2 ** tile.z - 0.5) * 2 * Math.PI;
      return projection.project(point, new Cartesian3());
    });
    const centers = new Float64Array(vertices.length * 3);
    const previous = new Float32Array(centers.length);
    const next = new Float32Array(centers.length);
    for (let vertex = 0; vertex < vertices.length; vertex++) {
      const index = vertices[vertex];
      const center = projected[index];
      const before = projected[closed ? (index + projected.length - 1) % projected.length : Math.max(0, index - 1)];
      const after = projected[closed ? (index + 1) % projected.length : Math.min(projected.length - 1, index + 1)];
      Cartesian3.pack(center, centers as unknown as number[], vertex * 3);
      // Missing endpoint neighbours mirror in planar coordinates. Subtract
      // DOUBLE coordinates before writing the original FLOAT attributes.
      for (const [component, axis] of (['x', 'y', 'z'] as const).entries()) {
        previous[vertex * 3 + component] = !closed && index === 0 ? center[axis] - after[axis] : before[axis] - center[axis];
        next[vertex * 3 + component] = !closed && index === projected.length - 1 ? center[axis] - before[axis] : after[axis] - center[axis];
      }
    }
    attributes.position = new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: centers });
    attributes.prevOffset = floatAttribute(3, previous);
    attributes.nextOffset = floatAttribute(3, next);
  }
  else {
    if (!baked.prevOffsets || !baked.nextOffsets)
      throw new Error('Native FLOAT reference requires 3D neighbour offsets');
    attributes.prevOffset = floatAttribute(3, baked.prevOffsets);
    attributes.nextOffset = floatAttribute(3, baked.nextOffsets);
  }
  if (baked.dashFrom && baked.dashTo) {
    if (!baked.lineDistances)
      throw new Error('Native FLOAT reference requires dash distances');
    attributes.a_linesofar = floatAttribute(1, baked.lineDistances);
    attributes.a_dashFrom = floatAttribute(3, baked.dashFrom);
    attributes.a_dashTo = floatAttribute(3, baked.dashTo);
  }
  return new Geometry({
    attributes: attributes as unknown as Geometry['attributes'],
    indices: baked.indices,
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.clone(baked.boundingSphere),
  });
}

function nativeProjectedSphere(sphere: BoundingSphere, matrix: Matrix4, projection: MapProjection): BoundingSphere {
  const projected = BoundingSphere.projectTo2D(BoundingSphere.transform(sphere, matrix), projection);
  // Native createVertexArray owns the final (height, longitude, latitude)
  // swizzle, so its input sphere must use projected attribute coordinates.
  const { x, y, z } = projected.center;
  projected.center.x = y;
  projected.center.y = z;
  projected.center.z = x;
  return projected;
}

/** Independent FLOAT assembly; Native still owns VA, batches, picking and destruction. */
class NativeFloatReference extends Primitive {
  private _combined = false;
  private readonly _planar: boolean;

  constructor(options: NonNullable<ConstructorParameters<typeof Primitive>[0]>, planar: boolean) {
    super(options);
    this._planar = planar;
  }

  update(frameState?: ReferenceFrame): void {
    if (!this._combined && (frameState.passes.render || frameState.passes.pick)) {
      const instances = this.geometryInstances;
      const source = Array.isArray(instances) ? instances : [instances];
      const combined = nativeReference.PrimitivePipeline.combineGeometry({
        instances: source,
        ellipsoid: frameState.mapProjection.ellipsoid,
        projection: frameState.mapProjection,
        elementIndexUintSupported: frameState.context.elementIndexUint,
        scene3DOnly: true,
        vertexCacheOptimize: this.vertexCacheOptimize,
        compressVertices: this.compressVertices,
        modelMatrix: Matrix4.clone(this.modelMatrix),
        createPickOffsets: (this as Primitive & { _createPickOffsets?: boolean })._createPickOffsets,
      });
      // Collect each instance's final encoded centres independently of the
      // production bounds adapter.
      const instanceHigh = source.map(() => [] as number[]);
      const instanceLow = source.map(() => [] as number[]);
      for (const geometry of combined.geometries) {
        const attributes = geometry.attributes as unknown as Record<string, GeometryAttribute>;
        if (this._planar) {
          attributes.position2DHigh = attributes.position3DHigh;
          attributes.position2DLow = attributes.position3DLow;
          delete attributes.position3DHigh;
          delete attributes.position3DLow;
          const high = attributes.position2DHigh.values;
          const low = attributes.position2DLow.values;
          geometry.boundingSphereCV = BoundingSphere.fromEncodedCartesianVertices(high as unknown as number[], low as unknown as number[]);
          const ids = attributes.batchId.values;
          for (let vertex = 0; vertex < ids.length; vertex++) {
            for (let component = 0; component < 3; component++) {
              instanceHigh[ids[vertex]].push(high[vertex * 3 + component]);
              instanceLow[ids[vertex]].push(low[vertex * 3 + component]);
            }
          }
        }
        else if (!frameState.scene3DOnly) {
          geometry.boundingSphereCV = nativeProjectedSphere(geometry.boundingSphere, combined.modelMatrix, frameState.mapProjection);
        }
      }
      for (let index = 0; index < source.length; index++) {
        if (this._planar) {
          combined.boundingSpheresCV[index] = BoundingSphere.fromEncodedCartesianVertices(instanceHigh[index], instanceLow[index]);
        }
        else if (!frameState.scene3DOnly && combined.boundingSpheres[index]) {
          combined.boundingSpheresCV[index] = nativeProjectedSphere(combined.boundingSpheres[index], combined.modelMatrix, frameState.mapProjection);
        }
      }
      Object.assign(this, {
        _geometries: combined.geometries,
        _attributeLocations: GeometryPipeline.createAttributeLocations(combined.geometries[0]),
        modelMatrix: Matrix4.clone(combined.modelMatrix, this.modelMatrix),
        _pickOffsets: combined.pickOffsets,
        _offsetInstanceExtend: combined.offsetInstanceExtend,
        _instanceBoundingSpheres: combined.boundingSpheres,
        _instanceBoundingSpheresCV: combined.boundingSpheresCV,
        _numberOfInstances: source.length,
        _instanceIds: source.map(instance => instance.id),
        _recomputeBoundingSpheres: true,
        _state: nativeReference.PrimitiveState.COMBINED,
      });
      this._combined = true;
    }
    Reflect.apply(Primitive.prototype.update, this, [frameState]);
  }
}

export async function createLineFormatValidation(mode: '2d' | 'cv' | '3d', scenario: 'curved' | 'dateline' | 'short-legs' | 'near-plane' | 'dense-lines' = 'curved') {
  const { scene } = window.renderValidation.viewer;
  scene.debugShowFramesPerSecond = true;
  scene.requestRenderMode = false;
  const planar = mode !== '3d';
  const shader = LINE_AA_VS;
  const referenceShader = planar ? REFERENCE_PLANAR_LINE_AA_VS : REFERENCE_LINE_AA_VS;
  const modernInstances: GeometryInstance[] = [];
  const referenceInstances: GeometryInstance[] = [];
  const sourcePointCounts: number[] = [];
  let shortLegMeters: number | undefined;
  const centerLongitude = scenario === 'dateline' ? 179.999 : -0.1276;
  const centerLatitude = scenario === 'dateline' ? -16.5 : 51.5072;
  // z18 represents a one-unit short leg at roughly a centimetre on the
  // ground, while keeping buffered source coordinates inside MVT's clamp.
  const zoom = scenario === 'short-legs' ? 18 : 14;
  const mercatorY = (latitude: number) => (1 - Math.log(Math.tan(Math.PI / 4 + latitude * Math.PI / 360)) / Math.PI) / 2;
  const tile = new CanonicalTileID(zoom, Math.floor((centerLongitude + 180) / 360 * 2 ** zoom), Math.floor(mercatorY(centerLatitude) * 2 ** zoom));
  const geometryCache = new LineGeometryCache(tile);
  const tilePoint = (longitude: number, latitude: number) => {
    return new Point(
      Math.round(((longitude + 180) / 360 * 2 ** zoom - tile.x) * EXTENT),
      Math.round((mercatorY(latitude) * 2 ** zoom - tile.y) * EXTENT),
    );
  };
  for (let index = 0; index < (scenario === 'dense-lines' ? mode === '2d' ? 3 : 2 : 9); index++) {
    const longitude = (scenario === 'dateline' ? 179.999 : -0.1276) + (index % 3 - 1) * (scenario === 'curved' ? 0.003 : 0.0003);
    const latitude = (scenario === 'dateline' ? -16.5 : 51.5072) + (Math.floor(index / 3) - 1) * (scenario === 'curved' ? 0.0015 : 0.0003);
    const leg = scenario === 'curved' ? 0.001 : 0.0015;
    const points = scenario === 'dense-lines'
      ? Array.from({ length: 11_000 }, (_, step) => {
          const point = tilePoint(longitude, latitude);
          point.x += step - 5_500;
          return point;
        })
      : scenario === 'curved' && index === 7
        ? [[longitude - leg, latitude], [longitude, latitude], [longitude - leg, latitude], [longitude + leg, latitude]].map(([x, y]) => tilePoint(x, y))
        : scenario === 'curved' && index === 8
          ? Array.from({ length: 33 }, (_, step) => {
              const point = tilePoint(longitude, latitude);
              point.x += (step - 16) * 32;
              point.y += Math.round(Math.sin(step * Math.PI / 4) * 8);
              return point;
            })
          : scenario === 'short-legs'
            ? [tilePoint(longitude - 0.001, latitude), tilePoint(longitude, latitude), (() => {
                const point = tilePoint(longitude, latitude);
                point.x++;
                point.y--;
                return point;
              })(), tilePoint(longitude - 0.0009, latitude + 0.000003), tilePoint(longitude + 0.001, latitude + 0.000006)]
            : [[longitude - leg, latitude], [longitude, latitude], [longitude - 0.0006, latitude + 0.0006], [longitude + leg, latitude + 0.0006]].map(([x, y]) => tilePoint(x, y));
    if (index === 0 && scenario !== 'dense-lines')
      points.push(points[0]);
    if (points.some(point => !Number.isInteger(point.x) || !Number.isInteger(point.y)
      || point.x < -16384 || point.x > 16383 || point.y < -16384 || point.y > 16383)) {
      throw new Error('Line format scenario exceeds the real integer source coordinate range');
    }
    const join = scenario === 'curved' && index === 8 ? 'miter' : ['round', 'miter', 'bevel'][index % 3];
    const cap = ['round', 'square', 'butt'][Math.floor(index / 3)];
    const miterLimit = index % 2 ? 1.3 : 3.5;
    const options = { join, cap, miterLimit, roundLimit: 1.05, widthPx: 255 };
    const layer = new LineStyleLayer({
      id: `line-format-${index}`,
      type: 'line',
      source: 'line-format',
      layout: { 'line-join': join as 'round' | 'miter' | 'bevel', 'line-cap': cap as 'round' | 'square' | 'butt', 'line-miter-limit': miterLimit, 'line-round-limit': options.roundLimit },
      paint: { 'line-color': '#f00', 'line-width': 12 },
    }, {});
    layer.recalculate(new EvaluationParameters(zoom), []);
    const bucket = new LineBucket({ layers: [layer], zoom, index } as never);
    bucket.addFeature({ index, sourceLayerIndex: 0, geometry: [points], properties: {}, type: 2, patterns: {}, dashes: {} }, [points], index, tile, {}, {});
    const source = lineBucketPrimitives(bucket, tile, scene.mode)[0];
    if (!source || source.tilePositions.length !== points.length * 2)
      throw new Error('Line format source points were unexpectedly collapsed or subdivided');
    sourcePointCounts.push(source.positions.length / 3);
    if (scenario === 'short-legs' && index === 0)
      shortLegMeters = Cartesian3.distance(Cartesian3.unpack(source.positions as unknown as number[], 3), Cartesian3.unpack(source.positions as unknown as number[], 6));
    const geometry = geometryCache.geometry(source, options, planar);
    if (!geometry)
      throw new Error('Source-backed line format could not bake the scenario');
    const referenceBake = bakeReferenceLine(Array.from({ length: source.positions.length / 3 }, (_, index) => Cartesian3.unpack(source.positions as unknown as number[], index * 3)), options, planar, { tileID: tile, tilePositions: source.tilePositions });
    if (!referenceBake)
      throw new Error('Native FLOAT reference could not bake the scenario');
    const id = { featureIndex: index, join, cap, miterLimit };
    const paint = () => ({
      color: ColorGeometryInstanceAttribute.fromColor(Color.RED),
      lineWidth: new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, value: [12] }),
      lineMiterLimit: new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, value: [Math.fround(options.join === 'bevel' ? 1.05 : options.miterLimit)] }),
    });
    modernInstances.push(new GeometryInstance({ geometry, id, attributes: paint() }));
    referenceInstances.push(new GeometryInstance({ id, attributes: paint(), geometry: nativeFloatGeometry(referenceBake, source, tile, planar, scene.mapProjection) }));
  }
  // Native Primitive.getUniforms consumes Appearance.uniforms at runtime.
  const appearance = (vertexShaderSource: string, fragmentShaderSource = LINE_AA_FS) => Object.assign(new PolylineColorAppearance({ translucent: true, vertexShaderSource, fragmentShaderSource, renderState: { cull: { enabled: false } } }), {
    uniforms: { u_line_width: 1, u_line_color: Color.WHITE, u_line_layer_offset: 0, u_line_meters_per_pixel: 0, u_line_mercator_projection: 0 },
  });
  const reference = new NativeFloatReference({ geometryInstances: referenceInstances, appearance: appearance(referenceShader, REFERENCE_LINE_AA_FS), asynchronous: false, cull: false }, planar);
  const sharedAppearance = appearance(shader);
  const compact = new GeometryPrimitive({ geometryInstances: modernInstances, appearance: sharedAppearance }, 'line');
  const peer = scenario === 'curved' ? new GeometryPrimitive({ geometryInstances: modernInstances.slice(0, 1), appearance: sharedAppearance }, 'line') : undefined;
  if (peer)
    peer.show = false;
  rememberPrimitiveBytes(compact);
  const group = new PrimitiveCollection();
  group.add(reference);
  group.add(compact);
  if (peer)
    group.add(peer);
  const { tileset } = window.renderValidation;
  tileset.add(group);
  // Production cold primitives only advance through the owned preparation
  // queue. The FLOAT oracle shares the same group and draw lifecycle.
  (tileset as unknown as {
    _renderer: {
      collections: SceneCollections;
    };
  })._renderer.collections.queueFirstUpdate([group], false);
  if (scenario === 'near-plane')
    scene.camera.setView({ destination: Cartesian3.fromDegrees(-0.1276, 51.5072, 2), orientation: { heading: 0, pitch: 0, roll: 0 } });
  let styleZoom: number | undefined;
  const updateProjection = () => {
    const input = { camera: scene.camera, mode: scene.mode, projection: scene.mapProjection, width: scene.canvas.clientWidth, height: scene.canvas.clientHeight };
    styleZoom = cameraZoom(input) ?? styleZoom ?? cameraZoom({ ...input, sampleY: input.height - 1 });
    if (styleZoom === undefined)
      throw new Error('Native line format camera has no measurable surface scale');
    // Both layouts use the same actual camera scale. The FLOAT oracle keeps
    // its own shader and DOUBLE source centers; no packed geometry is read.
    const metersPerPixel = 2 * Math.PI * Ellipsoid.WGS84.maximumRadius / (512 * 2 ** styleZoom);
    const mercatorProjection = scene.mapProjection instanceof WebMercatorProjection ? 1 : 0;
    for (const owned of [sharedAppearance, reference.appearance, compact.appearance, peer && !peer.isDestroyed() ? peer.appearance : undefined]) {
      if (!owned)
        continue;
      const uniforms = (owned as typeof sharedAppearance).uniforms;
      uniforms.u_line_meters_per_pixel = metersPerPixel;
      uniforms.u_line_mercator_projection = mercatorProjection;
    }
  };
  updateProjection();
  const stopProjection = scene.preRender.addEventListener(updateProjection);
  let latest: Uint8Array | undefined;
  const stop = scene.postRender.addEventListener(() => {
    const { canvas, context } = scene;
    latest = context.readPixels({ width: canvas.width, height: canvas.height });
  });
  async function capture(primitive: Primitive) {
    reference.show = primitive === reference;
    compact.show = primitive === compact;
    if (peer && !peer.isDestroyed())
      peer.show = primitive === peer;
    await new Promise<void>(resolve => scene.postRender.addEventListener(function once() {
      scene.postRender.removeEventListener(once);
      resolve();
    }));
    if (!latest)
      throw new Error('Native Scene did not produce pixels');
    return latest.slice();
  }
  return {
    compact,
    ready() {
      if (window.renderValidation.renderErrors.length)
        throw new Error(window.renderValidation.renderErrors.join('\n'));
      return reference.ready && compact.ready && (!peer || peer.ready);
    },
    async compare() {
      const original = await capture(reference);
      const packed = await capture(compact);
      let paintedPixels = 0;
      let changedPixels = 0;
      let sample: Cartesian2 | undefined;
      for (let offset = 0; offset < packed.length; offset += 4) {
        const painted = (pixels: Uint8Array) => pixels[offset] > 70 && pixels[offset + 1] < 60 && pixels[offset + 2] < 60;
        if (painted(original) || painted(packed))
          paintedPixels++;
        if ([0, 1, 2, 3].some(channel => original[offset + channel] !== packed[offset + channel]))
          changedPixels++;
        if (!sample && packed[offset] > 250 && packed[offset + 1] < 5 && packed[offset + 2] < 5) {
          const { canvas } = scene;
          sample = new Cartesian2((offset / 4 % canvas.width + 0.5) * canvas.clientWidth / canvas.width, (canvas.height - 1 - Math.floor(offset / 4 / canvas.width) + 0.5) * canvas.clientHeight / canvas.height);
        }
      }
      if (!sample)
        throw new Error('Native reference did not visibly render a pickable line');
      const packedPick = scene.pick(sample)?.id;
      await capture(reference);
      const referencePick = scene.pick(sample)?.id;
      captureUploadedPrimitiveBytes(compact);
      const texture = compact.positionTexture as typeof compact.positionTexture & { pixelFormat: number; pixelDatatype: number };
      let isolation: { hiddenPrepared: boolean; ownedAppearances: boolean; cleanOriginal: boolean; distinctTextures: boolean; distinctDimensions: boolean; sharedProgram: boolean; commandTextures: boolean; peerDestroyed: boolean; survivorUnchanged: boolean } | undefined;
      if (peer) {
        const hiddenPrepared = !peer.show && !!peer.positionTexture && (peer as GeometryPrimitive & { _va: unknown[] })._va.length > 0;
        await capture(peer);
        type NativeCommands = GeometryPrimitive & { _sp: object; _colorCommands: Array<{ uniformMap: { lineRecord_texture: () => object } }> };
        const main = compact as NativeCommands;
        const other = peer as NativeCommands;
        const otherTexture = peer.positionTexture;
        isolation = {
          hiddenPrepared,
          ownedAppearances: compact.appearance !== sharedAppearance && peer.appearance !== sharedAppearance && compact.appearance !== peer.appearance,
          cleanOriginal: sharedAppearance.vertexShaderSource === shader && !Object.hasOwn(sharedAppearance.uniforms, 'lineRecord_texture'),
          distinctTextures: !!texture && !!otherTexture && texture !== otherTexture,
          distinctDimensions: texture.width !== otherTexture.width || texture.height !== otherTexture.height,
          sharedProgram: main._sp === other._sp,
          commandTextures: main._colorCommands.every(command => command.uniformMap.lineRecord_texture() === texture) && other._colorCommands.every(command => command.uniformMap.lineRecord_texture() === otherTexture),
          peerDestroyed: false,
          survivorUnchanged: false,
        };
        group.remove(peer);
        isolation.peerDestroyed = otherTexture.isDestroyed() && !texture.isDestroyed();
        const survivor = await capture(compact);
        isolation.survivorUnchanged = packed.every((value, index) => value === survivor[index]);
      }
      const uploaded = (compact as GeometryPrimitive & { _va: Array<{ numberOfVertices: number; indexBuffer: { indexDatatype: number } }> })._va;
      const indexDatatypes = uploaded.map(va => va.indexBuffer.indexDatatype);
      const uploadedVertices = uploaded.reduce((sum, va) => sum + va.numberOfVertices, 0);
      const cameraViews: Array<{ changedPixels: number; stableStorage: boolean }> = [];
      if (mode === '2d' && scenario === 'curved') {
        const arrays = [...uploaded];
        for (let view = 0; view < 3; view++) {
          scene.camera.twistLeft(Math.PI / 7);
          scene.camera.moveRight(40);
          scene.camera.zoomIn(scene.camera.positionCartographic.height * 0.05);
          const oldPixels = await capture(reference);
          const newPixels = await capture(compact);
          let changed = 0;
          for (let pixel = 0; pixel < newPixels.length; pixel += 4) {
            if ([0, 1, 2, 3].some(channel => oldPixels[pixel + channel] !== newPixels[pixel + channel]))
              changed++;
          }
          const currentArrays = (compact as GeometryPrimitive & { _va: typeof uploaded })._va;
          cameraViews.push({ changedPixels: changed, stableStorage: texture === compact.positionTexture && currentArrays.length === arrays.length && arrays.every((array, index) => array === currentArrays[index]) });
        }
      }
      const cpuRecordsReleased = (compact as unknown as { _linePositionData?: Float32Array })._linePositionData === undefined;
      const result = { paintedPixels, changedPixels, cameraViews, comparedPixels: packed.length / 4, packedPick, referencePick, geometryBytes: collectionGpuBytes(compact), textureBytes: texture?.sizeInBytes, textureFormat: texture && { pixelFormat: texture.pixelFormat, pixelDatatype: texture.pixelDatatype }, cpuRecordsReleased, isolation, indexDatatypes, uploadedVertices, sourcePointCounts, sourceZoom: zoom, shortLegMeters, attributes: Object.keys((compact as GeometryPrimitive & { _attributeLocations: Record<string, number> })._attributeLocations), fps: scene.debugShowFramesPerSecond, errors: window.renderValidation.renderErrors };
      stop();
      stopProjection();
      tileset.remove(group);
      group.destroy();
      return { ...result, textureDestroyed: texture?.isDestroyed() };
    },
  };
}
