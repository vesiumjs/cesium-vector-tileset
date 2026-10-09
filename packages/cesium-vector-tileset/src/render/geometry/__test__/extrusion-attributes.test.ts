import type { GeometryLayout } from '../geometry-preparation';
import * as Cesium from 'cesium';
import { BoundingSphere, Cartesian3, Color, ComponentDatatype, Ellipsoid, Geometry, GeometryAttribute, GeometryInstance, GeometryInstanceAttribute, Matrix4, Primitive, PrimitiveType, WebMercatorProjection } from 'cesium';
import { describe, expect, it } from 'vitest';
import { ExtrusionPrimitive } from '../../vector/extrusion-primitive';
import { ExtrusionAppearance } from '../extrusion-appearance';
import { packExtrusionAttributes } from '../extrusion-attributes';
import { prepareGeometry } from '../geometry-preparation';
import { GeometryPrimitive } from '../geometry-primitive';

const pipeline = (Cesium as unknown as { PrimitivePipeline: {
  packCombineGeometryParameters: (parameters: object, transfers: ArrayBuffer[]) => object;
  unpackCombineGeometryResults: (result: object) => { geometries: Geometry[] };
}; }).PrimitivePipeline;

function prepare(layout: GeometryLayout, scene3DOnly: boolean, transfer?: { bytes: number }): Geometry {
  const positions = Float64Array.from([[-0.12, 51.5, 0], [-0.119, 51.5, 30], [-0.12, 51.501, 30]].flatMap(point => Cartesian3.pack(Cartesian3.fromDegrees(...point as [number, number, number]), [])));
  const geometry = new Geometry({
    attributes: {
      position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }),
      a_extrusionNormal: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: new Float32Array([8192, -16384, 16384, 8192, -16384, 16384, 8192, -16384, 16384]) }),
      a_extrusionTop: new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, values: new Float32Array([0, 1, 1]) }),
    } as Geometry['attributes'],
    indices: new Uint16Array([0, 1, 2]),
    primitiveType: PrimitiveType.TRIANGLES,
    boundingSphere: BoundingSphere.fromVertices(positions as unknown as number[]),
  });
  const parameters = pipeline.packCombineGeometryParameters({
    createGeometryResults: [],
    instances: [new GeometryInstance({ geometry })],
    ellipsoid: Ellipsoid.WGS84,
    projection: new WebMercatorProjection(),
    elementIndexUintSupported: true,
    scene3DOnly,
    vertexCacheOptimize: false,
    compressVertices: false,
    modelMatrix: Matrix4.IDENTITY,
    createPickOffsets: true,
  }, []);
  const transfers: ArrayBuffer[] = [];
  const result = prepareGeometry({ parameters, geometries: [geometry], layout, scene3DOnly, maximumTextureSize: 4096 }, transfers);
  if (transfer)
    transfer.bytes = transfers.reduce((total, buffer) => total + buffer.byteLength, 0);
  const received = structuredClone(result, { transfer: transfers });
  return pipeline.unpackCombineGeometryResults(received.combined).geometries[0];
}

function bytes(geometry: Geometry): number {
  return Object.values(geometry.attributes).reduce((total, attribute) => total + attribute.values.byteLength, 0);
}

describe('extrusion Worker attributes', () => {
  it.each([false, true])('reduces Native storage while preserving exact positions and normals (3D only: %s)', (scene3DOnly) => {
    const nativeTransfer = { bytes: 0 };
    const packedTransfer = { bytes: 0 };
    const native = prepare('native', scene3DOnly, nativeTransfer);
    const packed = prepare('extrusion', scene3DOnly, packedTransfer);
    expect(bytes(native) - bytes(packed)).toBe(3 * (scene3DOnly ? 12 : 18));
    expect(nativeTransfer.bytes - packedTransfer.bytes).toBe(3 * (scene3DOnly ? 12 : 18));
    const attributes = packed.attributes as Record<string, GeometryAttribute>;
    for (const mode of scene3DOnly ? ['3D'] : ['3D', '2D']) {
      const high = attributes[`a_extrusionHigh${mode}`];
      expect(high.componentDatatype).toBe(ComponentDatatype.SHORT);
      expect(Array.from(high.values).every((value, index) => value * 65536 === native.attributes[`position${mode}High`].values[index])).toBe(true);
      const low = attributes[`a_extrusionLow${mode}`].values as Float32Array;
      const reference = native.attributes[`position${mode}Low`].values as Float32Array;
      expect(new Uint32Array(low.buffer, low.byteOffset, low.length)).toEqual(new Uint32Array(reference.buffer, reference.byteOffset, reference.length));
    }
    expect(attributes.a_extrusionNormal.componentDatatype).toBe(ComponentDatatype.SHORT);
    expect(Array.from(attributes.a_extrusionNormal.values)).toEqual(Array.from(native.attributes.a_extrusionNormal.values));
    expect(attributes.a_extrusionTop).toEqual(native.attributes.a_extrusionTop);
    expect(attributes.batchId).toEqual(native.attributes.batchId);
    expect(packed.indices).toEqual(native.indices);
    expect(packed.boundingSphere).toEqual(native.boundingSphere);
    expect(attributes.a_extrusionHigh2D !== undefined).toBe(!scene3DOnly);
  });

  it('preserves signed extrema, FLOAT Low bits, and Native batch IDs above 65535', () => {
    const low = new Float32Array(new Uint32Array([0x80000000, 0x3F800001, 0x00000001]).buffer);
    const attribute = (values: Float32Array) => new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values });
    const batchId = new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 1, values: new Float32Array([0, 65535, 65536]) });
    const geometry = new Geometry({ attributes: {
      position3DHigh: attribute(new Float32Array([-2147483648, 2147418112, 0])),
      position3DLow: attribute(low),
      a_extrusionNormal: attribute(new Float32Array([-32768, 32767, 0])),
      batchId,
    } as Geometry['attributes'] });
    packExtrusionAttributes(geometry);
    const attributes = geometry.attributes as Record<string, GeometryAttribute>;
    expect(Array.from(attributes.a_extrusionHigh3D.values)).toEqual([-32768, 32767, 0]);
    expect(Array.from(attributes.a_extrusionNormal.values)).toEqual([-32768, 32767, 0]);
    expect(attributes.a_extrusionLow3D.values).toBe(low);
    expect(Array.from(new Uint32Array(low.buffer))).toEqual([0x80000000, 0x3F800001, 0x00000001]);
    expect(attributes.batchId).toBe(batchId);
    expect(Array.from(batchId.values)).toEqual([0, 65535, 65536]);
  });

  it.each([
    ['position3DHigh', 1],
    ['position3DHigh', 2147483648],
    ['position3DHigh', -2147549184],
    ['a_extrusionNormal', 0.5],
    ['a_extrusionNormal', 32768],
    ['a_extrusionNormal', -32769],
  ])('rejects lossy SHORT conversion of %s = %s', (name, value) => {
    const attribute = (values: number[]) => new GeometryAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, values: new Float32Array(values) });
    const geometry = new Geometry({ attributes: {
      position3DHigh: attribute([0, 65536, -65536]),
      position3DLow: attribute([0, 0, 0]),
      a_extrusionNormal: attribute([0, 8192, 16384]),
      [name]: attribute([value, 0, 0]),
    } as Geometry['attributes'] });
    expect(() => packExtrusionAttributes(geometry)).toThrow('not exactly representable');
  });

  it.each([false, true])('matches Native RTE/morph expressions without Native reinjection (3D only: %s)', (scene3DOnly) => {
    const appearance = new ExtrusionAppearance({ vertexShaderSource: 'void main() {}' });
    const uniforms = { live: 1 };
    Object.assign(appearance, { uniforms });
    appearance.configurePositions(prepare('extrusion', scene3DOnly));
    const shader = appearance.vertexShaderSource;
    const modify = (Primitive as unknown as { _modifyShaderPosition: (primitive: object, shader: string, scene3DOnly: boolean) => string })._modifyShaderPosition;
    expect(modify({}, shader, scene3DOnly).replace(/\s/g, '')).toBe(shader.replace(/\s/g, ''));
    const native = modify({}, 'in vec3 position3DHigh;\nin vec3 position3DLow;', scene3DOnly);
    const expected = native.slice(native.indexOf('vec4 czm_computePosition()'))
      .replaceAll('czm_computePosition', 'cvt_computeExtrusionPosition')
      .replaceAll('position2DHigh.zxy', '(a_extrusionHigh2D * 65536.0).zxy')
      .replaceAll('position3DHigh', 'a_extrusionHigh3D * 65536.0')
      .replaceAll('position2DLow', 'a_extrusionLow2D')
      .replaceAll('position3DLow', 'a_extrusionLow3D');
    const actual = shader.slice(shader.indexOf('vec4 cvt_computeExtrusionPosition()'), shader.indexOf('void main()'));
    expect(actual.replace(/\s/g, '')).toBe(expected.replace(/\s/g, ''));
    expect(shader.includes('in vec3 a_extrusionHigh2D;')).toBe(!scene3DOnly);
    uniforms.live = 2;
    expect((appearance as ExtrusionAppearance & { uniforms: typeof uniforms }).uniforms).toBe(uniforms);
    expect(appearance.vertexShaderSource).toBe(shader);
  });

  it('keeps the live extrusion Appearance and lighting uniforms after position configuration', () => {
    const owner = new ExtrusionPrimitive([new GeometryInstance({
      geometry: new Geometry({ attributes: {} as Geometry['attributes'] }),
      id: { featureIndex: 0 },
      attributes: {
        extrusionColor: new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 4, value: [1, 0, 0, 0.5] }),
        extrusionShape: new GeometryInstanceAttribute({ componentDatatype: ComponentDatatype.FLOAT, componentsPerAttribute: 3, value: [0, 30, 1] }),
      },
    })]);
    try {
      const appearance = owner.appearance as ExtrusionAppearance<{ u_extrusionLightPosition: Cartesian3; u_extrusionLightColor: Cartesian3; u_extrusionLightIntensity: number; u_extrusionLightEnabled: boolean }>;
      const uniforms = appearance.uniforms;
      appearance.configurePositions(prepare('extrusion', false));
      owner.setLighting({ position: [0.25, -0.5, 0.75], color: new Color(0.1, 0.2, 0.3), intensity: 0.6 });
      expect(owner.appearance).toBe(appearance);
      expect(appearance.uniforms).toBe(uniforms);
      expect(uniforms.u_extrusionLightPosition).toEqual(new Cartesian3(0.25, -0.5, 0.75));
      expect(uniforms.u_extrusionLightColor).toEqual(new Cartesian3(0.1, 0.2, 0.3));
      expect(uniforms.u_extrusionLightIntensity).toBe(0.6);
      expect(uniforms.u_extrusionLightEnabled).toBe(true);
      expect(appearance.translucent).toBe(true);
      expect(owner.cull).toBe(true);
      expect(owner.allowPicking).toBe(true);
      owner.setLighting();
      expect(uniforms.u_extrusionLightEnabled).toBe(false);
    }
    finally {
      owner.destroy();
    }
  });

  it('retains Native support for more than 65536 instances', () => {
    const instance = new GeometryInstance({ geometry: new Geometry({ attributes: {} as Geometry['attributes'] }) });
    const owner = new GeometryPrimitive({ geometryInstances: Array.from({ length: 65537 }).fill(instance) }, 'extrusion');
    expect(owner.cull).toBe(true);
    owner.destroy();
  });
});
