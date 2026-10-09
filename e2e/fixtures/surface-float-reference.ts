import type { Cartesian4 } from 'cesium';
import type { RenderFrameState } from '../../packages/cesium-vector-tileset/src/render/scene/render-frame';
import type { NativePrimitive, NativeShaderProgram, TestViewer } from './browser-types';
import { BoundingSphere, Cartesian3, Cartographic, Color, ColorGeometryInstanceAttribute, ComponentDatatype, Geometry, GeometryAttribute, GeometryInstance, JulianDate, PerInstanceColorAppearance, PerspectiveFrustum, Primitive, PrimitiveCollection, PrimitiveType, Rectangle, SceneMode } from 'cesium';
import { GeometryPrimitive } from '../../packages/cesium-vector-tileset/src/render/geometry/geometry-primitive';
import { FrameBudget } from '../../packages/cesium-vector-tileset/src/render/scene/frame-budget';
import { SceneCollections } from '../../packages/cesium-vector-tileset/src/render/scene/scene-collections';
import { FRAME_CPU_TARGET_MS } from '../../packages/cesium-vector-tileset/src/render/scene/scene-frame-budget';

// Frozen pre-compression shader. The reference below uses Native's own default
// shader, position encoding and czm_computePosition instead of this source.
function oldSurfaceShader(morph: boolean): string {
  return `
in vec3 position2DHigh;
in vec3 position2DLow;
${morph ? 'in vec3 a_positionHigh;\nin vec3 a_positionLow;' : ''}
in vec4 color;
in float batchId;
out vec4 v_color;
void main()
{
    vec4 p = czm_translateRelativeToEye(position2DHigh.zxy * 65536.0, position2DLow.zxy);
${morph ? '    p = czm_columbusViewMorph(p, czm_translateRelativeToEye(a_positionHigh * 65536.0, a_positionLow), czm_morphTime);' : ''}
    v_color = color;
    gl_Position = czm_modelViewProjectionRelativeToEye * p;
}
`;
}

const sources = [
  { id: 'local-ring', color: Color.RED, points: [-0.15, 51.495, 60, -0.13, 51.495, 60, -0.13, 51.51, 60, -0.15, 51.51, 60], triangles: [0, 1, 2, 0, 2, 3] },
  {
    id: 'height-box',
    color: Color.LIME,
    points: [-0.12, 51.497, 80, -0.105, 51.497, 80, -0.105, 51.51, 80, -0.12, 51.51, 80, -0.12, 51.497, 330, -0.105, 51.497, 330, -0.105, 51.51, 330, -0.12, 51.51, 330],
    triangles: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
  },
  { id: 'date-line-ring', color: Color.BLUE, points: [179.97, -16.52, 110, -179.97, -16.52, 110, -179.97, -16.48, 110, 179.97, -16.48, 110], triangles: [0, 1, 2, 0, 2, 3] },
];

function instances(): GeometryInstance[] {
  return sources.map(({ id, color, points, triangles }) => {
    const positions = new Float64Array(points.length);
    for (let offset = 0; offset < points.length; offset += 3)
      Cartesian3.pack(Cartesian3.fromDegrees(points[offset], points[offset + 1], points[offset + 2]), positions as unknown as number[], offset);
    const geometry = new Geometry({
      attributes: { position: new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions }) } as Geometry['attributes'],
      indices: new Uint16Array(triangles),
      primitiveType: PrimitiveType.TRIANGLES,
      boundingSphere: BoundingSphere.fromVertices(positions as unknown as number[]),
    });
    return new GeometryInstance({ geometry, id, attributes: { color: ColorGeometryInstanceAttribute.fromColor(color) } });
  });
}

function layout(primitive: NativePrimitive) {
  return primitive._va.map(array => ({
    vertices: array.numberOfVertices,
    attributes: Object.entries(primitive._attributeLocations).map(([name, location]) => {
      const attribute = Array.from({ length: array.numberOfAttributes }, (_, index) => array.getAttribute(index)).find(attribute => attribute.index === location)!;
      return { name, type: attribute.componentDatatype, components: attribute.componentsPerAttribute, normalize: attribute.normalize };
    }),
  }));
}

function viewMorphSources(viewer: TestViewer, morphTime: number): void {
  const { scene, camera, canvas } = viewer;
  const center = Cartographic.fromDegrees(-0.1275, 51.503, 150);
  const ecef = scene.ellipsoid.cartographicToCartesian(center);
  const projected = scene.mapProjection.project(center);
  const planar = new Cartesian3(projected.z, projected.x, projected.y);
  const target = Cartesian3.lerp(planar, ecef, morphTime, new Cartesian3());
  const normal = Cartesian3.normalize(Cartesian3.lerp(Cartesian3.UNIT_X, scene.ellipsoid.geodeticSurfaceNormal(ecef), morphTime, new Cartesian3()), new Cartesian3());
  const north3D = new Cartesian3(-Math.sin(center.latitude) * Math.cos(center.longitude), -Math.sin(center.latitude) * Math.sin(center.longitude), Math.cos(center.latitude));
  const north = Cartesian3.lerp(Cartesian3.UNIT_Z, north3D, morphTime, new Cartesian3());
  const direction = Cartesian3.negate(normal, new Cartesian3());
  const right = Cartesian3.normalize(Cartesian3.cross(direction, north, new Cartesian3()), new Cartesian3());
  const up = Cartesian3.normalize(Cartesian3.cross(right, direction, new Cartesian3()), new Cartesian3());
  const position = Cartesian3.add(target, Cartesian3.multiplyByScalar(normal, 6000, new Cartesian3()), new Cartesian3());
  // Native's animated morph camera zooms out to five Earth radii. Frame these
  // independently authored vertices at the actual intermediate morph position.
  camera.worldToCameraCoordinatesPoint(position, camera.position);
  camera.worldToCameraCoordinatesVector(direction, camera.direction);
  camera.worldToCameraCoordinatesVector(up, camera.up);
  Cartesian3.cross(camera.direction, camera.up, camera.right);
  camera.frustum = new PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: canvas.width / canvas.height, near: 1, far: 500000000 });
}

/** Independent source geometry and Native FLOAT GPU oracle, run in the real scene. */
export async function compareSurfaceFloat(viewer: TestViewer, hidden: { show: boolean }, morph = false) {
  const { scene, camera, canvas } = viewer;
  const renderLoop = viewer.useDefaultRenderLoop;
  const hiddenShow = hidden.show;
  const globeShow = scene.globe.show;
  const cameraView = {
    position: Cartesian3.clone(camera.position),
    direction: Cartesian3.clone(camera.direction),
    up: Cartesian3.clone(camera.up),
    right: Cartesian3.clone(camera.right),
    frustum: camera.frustum.clone(),
  };
  viewer.useDefaultRenderLoop = false;
  hidden.show = false;
  scene.globe.show = false;
  const time = JulianDate.clone(viewer.clock.currentTime);
  const morphTime = scene.morphTime;
  const appearance = new PerInstanceColorAppearance({ flat: true, translucent: false, vertexShaderSource: oldSurfaceShader(morph) });
  // Exercise the real owned preparation queue while the comparison freezes
  // its camera/time and temporarily hides the application's tileset.
  class OracleCollection extends PrimitiveCollection {
    readonly collections = new SceneCollections(this, () => scene.requestRender(), () => true);

    update(frameState?: RenderFrameState): void {
      const budget = new FrameBudget(FRAME_CPU_TARGET_MS);
      const pumped = this.collections.pumpFirstUpdates(frameState!, budget);
      this.collections.updateChildren(frameState!, pumped);
    }
  }
  const group = scene.primitives.add(new OracleCollection());
  const primitives = [0, 1].map(() => group.add(new GeometryPrimitive({ geometryInstances: instances(), appearance, vertexCacheOptimize: true, compressVertices: true }, morph ? 'surface-morph' : 'surface-planar')));
  group.collections.queueFirstUpdate(primitives);
  const production = primitives as unknown as NativePrimitive[];
  const reference = group.add(new Primitive({ geometryInstances: instances(), appearance: new PerInstanceColorAppearance({ flat: true, translucent: false }), asynchronous: false, vertexCacheOptimize: true, compressVertices: true })) as NativePrimitive;
  const render = () => {
    scene.requestRender();
    scene.render(time);
  };
  try {
    for (let frame = 0; !production.every(primitive => primitive.ready) || !reference.ready; frame++) {
      if (frame > 300)
        throw new Error('surface FLOAT oracle did not finish Native upload');
      // Do not initializeFrame: it advances camera tweens during a morph.
      render();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
    const descriptors = production.map(primitive => (primitive.appearance as typeof appearance & { uniforms: { surface_words: Cartesian4[] } }).uniforms);
    const independentUniforms = production[0].appearance !== production[1].appearance
      && descriptors[0] !== descriptors[1] && descriptors[0].surface_words !== descriptors[1].surface_words
      && descriptors[0].surface_words.every((word, index) => word !== descriptors[1].surface_words[index]);
    const programs = production.map(primitive => (primitive as NativePrimitive & { _sp?: NativeShaderProgram })._sp);
    const sharedProgram = programs[0] === programs[1] && !!programs[0];
    const views = morph ? ['morph'] : ['local', ...(scene.mode === SceneMode.COLUMBUS_VIEW ? ['date-line-east', 'date-line-west'] : ['date-line'])];
    const comparisons = views.map((view) => {
      if (morph)
        viewMorphSources(viewer, morphTime);
      else if (view.startsWith('date-line') && scene.mode === SceneMode.COLUMBUS_VIEW)
        // CV expands a crossing Rectangle to Rectangle.MAX_VALUE. View its
        // positive-longitude Native split directly instead of zooming globally.
        camera.setView({ destination: Cartesian3.fromDegrees(view.endsWith('west') ? -179.985 : 179.985, -16.5, 9000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
      else
        camera.setView({ destination: view === 'local' ? Rectangle.fromDegrees(-0.16, 51.487, -0.095, 51.518) : Rectangle.fromDegrees(179.955, -16.535, -179.955, -16.465) });
      const pixels = [production[0], reference, production[1]].map((active) => {
        for (const primitive of [...production, reference])
          primitive.show = primitive === active;
        render();
        return scene.context.readPixels({ width: canvas.width, height: canvas.height });
      });
      const mismatches = [pixels[0], pixels[2]].map(value => value.reduce((count, channel, index) => count + Number(channel !== pixels[1][index]), 0));
      const samples = sources.map(({ id, color }) => {
        const rgb = [color.red, color.green, color.blue].map(channel => Math.round(channel * 255));
        const matches = (x: number, y: number) => rgb.every((channel, index) => pixels[0][(y * canvas.width + x) * 4 + index] === channel);
        let count = 0;
        let point: { x: number; y: number } | undefined;
        for (let y = 2; y < canvas.height - 2; y++) {
          for (let x = 2; x < canvas.width - 2; x++) {
            if (!matches(x, y))
              continue;
            count++;
            if (!point && matches(x - 1, y) && matches(x + 1, y) && matches(x, y - 1) && matches(x, y + 1))
              point = { x: (x + 0.5) * canvas.clientWidth / canvas.width, y: (canvas.height - y - 0.5) * canvas.clientHeight / canvas.height };
          }
        }
        const picks = [production[0], reference].map((active) => {
          for (const primitive of [...production, reference])
            primitive.show = primitive === active;
          return point ? scene.pick(point)?.id as string | undefined : undefined;
        });
        return { id, count, picks };
      });
      return {
        view,
        mismatches,
        samples,
        morphTime: scene.morphTime,
        camera: {
          position: Cartesian3.pack(camera.positionWC, []),
          direction: Cartesian3.pack(camera.directionWC, []),
          up: Cartesian3.pack(camera.upWC, []),
          near: camera.frustum.near,
          far: camera.frustum.far,
          fovy: camera.frustum.fovy,
        },
      };
    });
    return {
      comparisons,
      independentUniforms,
      sharedProgram,
      morphTime,
      production: layout(production[0]),
      reference: layout(reference),
      descriptorCount: descriptors[0].surface_words.length,
      fps: scene.debugShowFramesPerSecond,
      destroyed: (() => {
        for (const primitive of [...production, reference])
          group.remove(primitive);
        return [...production, reference].every(primitive => primitive.isDestroyed());
      })(),
    };
  }
  finally {
    for (const primitive of [...production, reference]) {
      if (!primitive.isDestroyed())
        group.remove(primitive);
    }
    scene.primitives.remove(group);
    // 2D/CV positionWC uses projected axes; MORPHING rejects setView. Restore
    // the original local vectors and frustum before resuming the real animation.
    Cartesian3.clone(cameraView.position, camera.position);
    Cartesian3.clone(cameraView.direction, camera.direction);
    Cartesian3.clone(cameraView.up, camera.up);
    Cartesian3.clone(cameraView.right, camera.right);
    camera.frustum = cameraView.frustum;
    hidden.show = hiddenShow;
    scene.globe.show = globeShow;
    viewer.useDefaultRenderLoop = renderLoop;
    scene.requestRender();
  }
}
