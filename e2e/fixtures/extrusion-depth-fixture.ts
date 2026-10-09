import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PerspectiveFrustum, Primitive, PrimitiveCollection } from 'cesium';
import type { FeatureCollection, Polygon } from 'geojson';
import type { TestTileset, TestViewer } from './browser-types';
import { Cartesian3, Cartesian4, Color, Matrix4, PostProcessStage, SceneMode, SceneTransforms, Viewer, WebMercatorProjection } from 'cesium';
import { Map as MapLibre, MercatorCoordinate, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { CesiumVectorTileset } from '../../packages/cesium-vector-tileset';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import 'maplibre-gl/dist/maplibre-gl.css';

const radius = 6378137;
const circumference = 2 * Math.PI * radius;
const fov = 36.875112943;
const coordinate = (x: number, y: number): [number, number] => [x / circumference * 360, Math.atan(Math.sinh(y / radius)) * 180 / Math.PI];
const buildings = [
  { id: 'near', color: '#ff0000', x: 100, y0: 350, y1: 450, height: 120 },
  { id: 'far', color: '#0000ff', x: 140, y0: 520, y1: 620, height: 180 },
];
const data: FeatureCollection<Polygon> = {
  type: 'FeatureCollection',
  features: buildings.map(building => ({
    type: 'Feature',
    properties: { id: building.id, color: building.color, height: building.height },
    geometry: { type: 'Polygon', coordinates: [[coordinate(-building.x, building.y0), coordinate(building.x, building.y0), coordinate(building.x, building.y1), coordinate(-building.x, building.y1), coordinate(-building.x, building.y0)]] },
  })),
};
type Visibility = 'near' | 'far' | 'both';
type ExtrusionOwner = Primitive & { _pickIds: Array<{ color: Color }> };
export interface ExtrusionPose { pitch: number; height: number; bearing: number }
function style(visibility: Visibility, opacity: number, coincident = false, colorAlpha?: number): StyleSpecification {
  return {
    version: 8,
    transition: { duration: 0, delay: 0 },
    light: { anchor: 'map', color: '#ffffff', intensity: 0 },
    sources: { buildings: { type: 'geojson', data: coincident ? { type: 'FeatureCollection', features: [data.features[0], structuredClone(data.features[0])] } : data } },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': colorAlpha === undefined ? '#000000' : '#ffffff' } },
      {
        id: 'buildings',
        type: 'fill-extrusion',
        source: 'buildings',
        ...(visibility === 'both' ? {} : { filter: ['==', ['get', 'id'], visibility] as const }),
        paint: { 'fill-extrusion-color': colorAlpha === undefined ? ['get', 'color'] : ['rgba', 255, 0, 0, colorAlpha], 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': 0, 'fill-extrusion-opacity': opacity, 'fill-extrusion-vertical-gradient': false },
      },
    ],
  };
}
function gpu(gl: WebGL2RenderingContext) {
  const extension = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
}

async function createDepth() {
  setWorkerUrl(workerUrl);
  const mode = new URLSearchParams(location.search).get('mode') === '3d' ? SceneMode.SCENE3D : SceneMode.COLUMBUS_VIEW;
  const viewer = new Viewer('cesium', {
    baseLayer: false,
    animation: false,
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    selectionIndicator: false,
    timeline: false,
    requestRenderMode: false,
    useBrowserRecommendedResolution: false,
    contextOptions: { webgl: { antialias: false } },
    msaaSamples: 1,
    mapProjection: new WebMercatorProjection(),
    sceneMode: mode,
  }) as unknown as TestViewer;
  viewer.scene.globe.baseColor = Color.BLACK;
  viewer.scene.globe.depthTestAgainstTerrain = false;
  viewer.scene.skyAtmosphere!.show = false;
  viewer.scene.skyBox!.show = false;
  viewer.scene.backgroundColor = Color.BLACK;
  const requestedFrustumRatio = new URLSearchParams(location.search).get('frustumRatio');
  if (requestedFrustumRatio) {
    viewer.scene.farToNearRatio = Number(requestedFrustumRatio);
    viewer.scene.logarithmicDepthFarToNearRatio = Number(requestedFrustumRatio);
  }
  const errors: string[] = [];
  viewer.scene.renderError.addEventListener((_scene, error: Error) => errors.push(error.stack ?? error.message));
  const initialStyle = style('both', 0.8);
  const tileset = new CesiumVectorTileset({ style: structuredClone(initialStyle) }) as unknown as TestTileset;
  tileset.errorEvent.addEventListener(error => errors.push(error.message));
  viewer.scene.primitives.add(tileset);
  const reference = new MapLibre({ container: 'maplibre', style: structuredClone(initialStyle), center: [0, 0], zoom: 16, pitch: 70, maxPitch: 180, interactive: false, attributionControl: false, fadeDuration: 0, canvasContextAttributes: { antialias: false } });
  reference.on('error', event => errors.push(event.error.message));
  reference.setCenterClampedToGround(false);
  reference.setVerticalFieldOfView(fov);
  let nativePixels: Uint8Array | undefined;
  let referencePixels: Uint8Array | undefined;
  let nativeFrames = 0;
  let referenceFrames = 0;
  let changedAt = performance.now();
  let pose: ExtrusionPose = { pitch: 70, height: 180, bearing: 0 };
  const saved = new Map<string, { native: Uint8Array; reference: Uint8Array }>();
  let selectedStage: PostProcessStage | undefined;
  viewer.scene.postRender.addEventListener(() => {
    nativePixels = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
    nativeFrames++;
  });
  reference.on('render', () => {
    const canvas = reference.getCanvas();
    const gl = canvas.getContext('webgl2')!;
    referencePixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, referencePixels);
    referenceFrames++;
  });
  const invalidate = () => {
    changedAt = performance.now();
    nativePixels = undefined;
    referencePixels = undefined;
    nativeFrames = 0;
    referenceFrames = 0;
    viewer.scene.requestRender();
    reference.triggerRepaint();
  };
  const setView = (value: ExtrusionPose) => {
    pose = value;
    const frustum = viewer.camera.frustum as PerspectiveFrustum;
    frustum.fov = fov * Math.PI / 180;
    frustum.aspectRatio = viewer.canvas.clientWidth / viewer.canvas.clientHeight;
    const altitude = (pose.height / circumference) / MercatorCoordinate.fromLngLat([0, 0], 1).z;
    viewer.camera.setView({ destination: mode === SceneMode.SCENE3D ? Cartesian3.fromDegrees(0, 0, altitude) : new Cartesian3(0, 0, pose.height), convert: false, orientation: { heading: pose.bearing * Math.PI / 180, pitch: pose.pitch * Math.PI / 180 - Math.PI / 2, roll: 0 } });
    // Reset center elevation before the public physical-camera conversion;
    // jumpTo(calculated) retains the elevation issued by that conversion.
    reference.jumpTo({ center: [0, 0], elevation: 0, zoom: 16, pitch: 0, bearing: 0, roll: 0 });
    reference.jumpTo(reference.calculateCameraOptionsFromCameraLngLatAltRotation([0, 0], altitude, pose.bearing, pose.pitch, 0));
    invalidate();
  };
  setView(pose);
  return {
    setView,
    setVisibility(visibility: Visibility, opacity = 0.8) {
      if (selectedStage)
        selectedStage.enabled = false;
      const next = style(visibility, opacity);
      tileset.setStyle(structuredClone(next));
      reference.setStyle(structuredClone(next));
      invalidate();
    },
    setCoincident() {
      const next = style('near', 0.8, true);
      tileset.setStyle(structuredClone(next));
      reference.setStyle(structuredClone(next));
      invalidate();
    },
    setColorAlpha(alpha: number, opacity = 0.8) {
      if (selectedStage)
        selectedStage.enabled = false;
      viewer.scene.backgroundColor = Color.WHITE;
      viewer.scene.globe.baseColor = Color.WHITE;
      const next = style('near', opacity, false, alpha);
      tileset.setStyle(structuredClone(next));
      reference.setStyle(structuredClone(next));
      invalidate();
    },
    ready(settled = true) {
      return tileset.tilesLoaded && reference.loaded() && (!selectedStage?.enabled || selectedStage.ready) && nativeFrames >= (settled ? 6 : 1) && referenceFrames >= 1 && !!nativePixels && !!referencePixels && (!settled || performance.now() - changedAt > 250);
    },
    selectNear(id: string) {
      const pixels = saved.get(id)!.native;
      const width = viewer.canvas.width;
      const height = viewer.canvas.height;
      let point: { x: number; y: number } | undefined;
      let centerDistance = Infinity;
      for (let y = 4; y < height - 4; y++) {
        for (let x = 4; x < width - 4; x++) {
          let inside = true;
          for (let dy = -3; inside && dy <= 3; dy++) {
            for (let dx = -3; inside && dx <= 3; dx++) {
              const offset = ((y + dy) * width + x + dx) * 4;
              inside = pixels[offset] > 60 && pixels[offset] > pixels[offset + 2] + 40;
            }
          }
          const distance = Math.hypot(x - width / 2, y - height / 2);
          if (inside && distance < centerDistance) {
            centerDistance = distance;
            point = { x, y: height - 1 - y };
          }
        }
      }
      if (!point)
        throw new Error('The independently visible nearest building must provide an eroded pick point');
      const picked = viewer.scene.pick(point) as { primitive?: ExtrusionOwner; id?: { layerId: string; featureIndex: number } } | undefined;
      const pickedId = picked?.primitive?.getGeometryInstanceAttributes(picked.id).pickId;
      const owners = [...tileset._renderer.vector._records.values()].flatMap((record) => {
        const collection = record.collections.get('extrusions') as PrimitiveCollection | undefined;
        return collection ? Array.from({ length: collection.length }, (_, index) => collection.get(index) as ExtrusionOwner) : [];
      });
      const pickedOwner = owners.find(owner => owner === picked?.primitive);
      const pickIds = [...new Set(owners.flatMap(owner => owner._pickIds))];
      if (!pickedId || !pickedOwner?._pickIds.includes(pickedId)) {
        return { point, picked: picked?.id, pickIdCount: pickIds.length, ownerSelected: false, qualification: { ownerCount: owners.length, pickedPrimitive: picked?.primitive?.constructor.name, hasPickedId: !!pickedId, ownerFound: !!pickedOwner, collections: [...tileset._renderer.vector._records.values()].map(record => [...record.collections.keys()]) } };
      }
      if (!selectedStage) {
        selectedStage = new PostProcessStage({
          name: 'extrusion-selected-id-proof',
          fragmentShader: `
uniform sampler2D colorTexture;
in vec2 v_textureCoordinates;
void main() {
    out_FragColor = czm_selected() ? vec4(0.0, 1.0, 0.0, 1.0) : texture(colorTexture, v_textureCoordinates);
}`,
        });
        viewer.scene.postProcessStages.add(selectedStage);
      }
      selectedStage.selected = [{ pickIds }];
      selectedStage.enabled = true;
      invalidate();
      return { point, picked: picked!.id, pickIdCount: pickIds.length, pickedColor: pickedId.color.toBytes(), ownerSelected: true };
    },
    compareSelected(baseId: string, selectedId: string) {
      const base = saved.get(baseId)!.native;
      const selected = saved.get(selectedId)!.native;
      const width = viewer.canvas.width;
      const height = viewer.canvas.height;
      let count = 0;
      let green = 0;
      const mean = { red: 0, green: 0, blue: 0 };
      for (let y = 4; y < height - 4; y++) {
        for (let x = 4; x < width - 4; x++) {
          let inside = true;
          for (let dy = -3; inside && dy <= 3; dy++) {
            for (let dx = -3; inside && dx <= 3; dx++) {
              const offset = ((y + dy) * width + x + dx) * 4;
              inside = base[offset] > 60 && base[offset] > base[offset + 2] + 40;
            }
          }
          if (!inside)
            continue;
          const offset = (y * width + x) * 4;
          count++;
          green += Number(selected[offset + 1] > 200 && selected[offset + 1] > selected[offset] + 40 && selected[offset + 1] > selected[offset + 2] + 40);
          mean.red += selected[offset];
          mean.green += selected[offset + 1];
          mean.blue += selected[offset + 2];
        }
      }
      for (const key of Object.keys(mean) as Array<keyof typeof mean>)
        mean[key] /= Math.max(count, 1);
      return { count, green, selectedFraction: green / Math.max(count, 1), mean };
    },
    compareColorAlpha(baseId: string, actualId: string) {
      const base = saved.get(baseId)!;
      const actual = saved.get(actualId)!;
      const width = viewer.canvas.width;
      const height = viewer.canvas.height;
      const supported = (offset: number) => [base.native, base.reference].every(pixels => pixels[offset] > pixels[offset + 1] + 40 && pixels[offset] > pixels[offset + 2] + 40);
      const result = { count: 0, backgroundCount: 0, native: { red: 0, green: 0, blue: 0, background: 0 }, reference: { red: 0, green: 0, blue: 0, background: 0 } };
      for (let y = 4; y < height - 4; y++) {
        for (let x = 4; x < width - 4; x++) {
          const offset = (y * width + x) * 4;
          if ([base.native, base.reference].every(pixels => pixels[offset] === 255 && pixels[offset + 1] === 255 && pixels[offset + 2] === 255)) {
            result.backgroundCount++;
            for (const renderer of ['native', 'reference'] as const)
              result[renderer].background += Math.min(actual[renderer][offset], actual[renderer][offset + 1], actual[renderer][offset + 2]);
          }
          let inside = true;
          for (let dy = -3; inside && dy <= 3; dy++) {
            for (let dx = -3; inside && dx <= 3; dx++)
              inside = supported(((y + dy) * width + x + dx) * 4);
          }
          if (!inside)
            continue;
          result.count++;
          for (const renderer of ['native', 'reference'] as const) {
            result[renderer].red += actual[renderer][offset];
            result[renderer].green += actual[renderer][offset + 1];
            result[renderer].blue += actual[renderer][offset + 2];
          }
        }
      }
      for (const renderer of ['native', 'reference'] as const) {
        result[renderer].red /= Math.max(result.count, 1);
        result[renderer].green /= Math.max(result.count, 1);
        result[renderer].blue /= Math.max(result.count, 1);
        result[renderer].background /= Math.max(result.backgroundCount, 1);
      }
      return result;
    },
    capture(id: string) {
      if (!nativePixels || !referencePixels)
        throw new Error('Both actual framebuffer draws are required');
      saved.set(id, { native: nativePixels.slice(), reference: referencePixels.slice() });
      const transform = (reference as unknown as { _camera: { transform: {
        getCameraLngLat: () => { lng: number; lat: number };
        getCameraAltitude: () => number;
        _pixelMatrix3D: number[];
        coordinatePoint: (point: MercatorCoordinate, elevation: number, matrix: number[]) => { x: number; y: number };
      }; }; })._camera.transform;
      const referencePosition = MercatorCoordinate.fromLngLat(transform.getCameraLngLat());
      referencePosition.z = MercatorCoordinate.fromLngLat(reference.getCenter(), transform.getCameraAltitude()).z;
      const actual = viewer.camera.positionWC;
      const cartographic = viewer.camera.positionCartographic;
      const nativePosition = mode === SceneMode.SCENE3D
        ? MercatorCoordinate.fromLngLat({ lng: cartographic.longitude * 180 / Math.PI, lat: cartographic.latitude * 180 / Math.PI }, cartographic.height)
        : { x: 0.5 + actual.y / circumference, y: 0.5 - actual.z / circumference, z: actual.x / circumference };
      const ground = buildings.flatMap(building => [[-building.x, building.y0], [building.x, building.y1]]).map(([x, y]) => {
        const location = coordinate(x, y);
        const world = Cartesian3.fromDegrees(...location);
        const native = SceneTransforms.worldToWindowCoordinates(viewer.scene, world);
        const matrix = Matrix4.multiply((viewer.camera.frustum as PerspectiveFrustum).projectionMatrix, viewer.camera.viewMatrix, new Matrix4());
        const clip = Matrix4.multiplyByVector(matrix, new Cartesian4(world.x, world.y, world.z, 1), new Cartesian4());
        const analytic = mode === SceneMode.SCENE3D ? { x: (clip.x / clip.w + 1) * viewer.canvas.clientWidth / 2, y: (1 - clip.y / clip.w) * viewer.canvas.clientHeight / 2 } : undefined;
        const referencePoint = transform.coordinatePoint(MercatorCoordinate.fromLngLat(location), 0, transform._pixelMatrix3D);
        return { native, reference: referencePoint, analytic, globeFlatDelta: native ? Math.hypot(native.x - referencePoint.x, native.y - referencePoint.y) : undefined };
      });
      return {
        id,
        pose,
        mode,
        errors: [...errors],
        ground,
        diagnostics: {
          frustumRatio: { linear: viewer.scene.farToNearRatio, logarithmic: viewer.scene.logarithmicDepthFarToNearRatio },
          frustums: (viewer.scene as unknown as { _view: { frustumCommandsList: Array<{ near: number; far: number }> } })._view.frustumCommandsList.map(bin => ({ near: bin.near, far: bin.far })),
          ownedExtrusionGpuBytes: (tileset as unknown as {
            _renderer: {
              commands: {
                extrusionGpuBytes: number;
              };
            };
          })._renderer.commands.extrusionGpuBytes,
        },
        pixels: Object.fromEntries([['native', nativePixels], ['reference', referencePixels]].map(([name, value]) => {
          const pixels = value as Uint8Array;
          let red = 0;
          let blue = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            red += Number(pixels[index] > pixels[index + 2] + 40);
            blue += Number(pixels[index + 2] > pixels[index] + 40);
          }
          return [name, { red, blue }];
        })),
        frames: { native: nativeFrames, reference: referenceFrames },
        camera: {
          nativePosition,
          referencePosition,
          nativePitch: 90 + viewer.camera.pitch * 180 / Math.PI,
          referencePitch: reference.getPitch(),
          nativeFov: (viewer.camera.frustum as PerspectiveFrustum).fovy * 180 / Math.PI,
          referenceFov: reference.getVerticalFieldOfView(),
          nativeHeading: viewer.camera.heading * 180 / Math.PI,
          referenceBearing: reference.getBearing(),
        },
        gpu: { native: gpu(viewer.scene.context._gl), reference: gpu(reference.getCanvas().getContext('webgl2')!) },
        viewport: { native: [viewer.canvas.width, viewer.canvas.height, viewer.canvas.clientWidth, viewer.canvas.clientHeight], reference: [reference.getCanvas().width, reference.getCanvas().height, reference.getCanvas().clientWidth, reference.getCanvas().clientHeight] },
      };
    },
    compare(nearId: string, farId: string, bothId: string) {
      const near = saved.get(nearId)!;
      const far = saved.get(farId)!;
      const both = saved.get(bothId)!;
      const width = viewer.canvas.width;
      const height = viewer.canvas.height;
      // Intersection of both independent positive controls in BOTH real
      // renderers. Erosion rejects geometry quantization and silhouette AA.
      const supported = (offset: number) => [near.native, near.reference].every(pixels => pixels[offset] > 60 && pixels[offset] > pixels[offset + 2] + 40)
        && [far.native, far.reference].every(pixels => pixels[offset + 2] > 60 && pixels[offset + 2] > pixels[offset] + 40);
      let count = 0;
      const native = { red: 0, blue: 0, nearRed: 0, nearBlue: 0, farBlue: 0, blueLeak: 0 };
      const referenceResult = { ...native };
      const bounds = { x0: width, y0: height, x1: 0, y1: 0 };
      for (let y = 4; y < height - 4; y++) {
        for (let x = 4; x < width - 4; x++) {
          let inside = true;
          for (let dy = -3; inside && dy <= 3; dy++) {
            for (let dx = -3; inside && dx <= 3; dx++)
              inside = supported(((y + dy) * width + x + dx) * 4);
          }
          if (!inside)
            continue;
          count++;
          bounds.x0 = Math.min(bounds.x0, x);
          bounds.x1 = Math.max(bounds.x1, x);
          bounds.y0 = Math.min(bounds.y0, height - 1 - y);
          bounds.y1 = Math.max(bounds.y1, height - 1 - y);
          const offset = (y * width + x) * 4;
          for (const [name, result] of [['native', native], ['reference', referenceResult]] as const) {
            result.red += both[name][offset];
            result.blue += both[name][offset + 2];
            result.nearRed += near[name][offset];
            result.nearBlue += near[name][offset + 2];
            result.farBlue += far[name][offset + 2];
            result.blueLeak += both[name][offset + 2] - near[name][offset + 2];
          }
        }
      }
      for (const result of [native, referenceResult]) {
        for (const key of Object.keys(result) as Array<keyof typeof result>)
          result[key] /= Math.max(count, 1);
      }
      return { count, bounds, native, reference: referenceResult };
    },
    compareCoincident(singleId: string, duplicateId: string) {
      const single = saved.get(singleId)!;
      const duplicate = saved.get(duplicateId)!;
      const width = viewer.canvas.width;
      const height = viewer.canvas.height;
      let count = 0;
      const result = { native: { single: 0, duplicate: 0 }, reference: { single: 0, duplicate: 0 } };
      const supported = (offset: number) => [single.native, single.reference].every(pixels => pixels[offset] > 60 && pixels[offset] > pixels[offset + 2] + 40);
      for (let y = 4; y < height - 4; y++) {
        for (let x = 4; x < width - 4; x++) {
          let inside = true;
          for (let dy = -3; inside && dy <= 3; dy++) {
            for (let dx = -3; inside && dx <= 3; dx++)
              inside = supported(((y + dy) * width + x + dx) * 4);
          }
          if (!inside)
            continue;
          count++;
          const offset = (y * width + x) * 4;
          for (const renderer of ['native', 'reference'] as const) {
            result[renderer].single += single[renderer][offset];
            result[renderer].duplicate += duplicate[renderer][offset];
          }
        }
      }
      for (const renderer of ['native', 'reference'] as const) {
        result[renderer].single /= Math.max(1, count);
        result[renderer].duplicate /= Math.max(1, count);
      }
      return { count, ...result };
    },
  };
}
declare global { interface Window { extrusionDepth: Awaited<ReturnType<typeof createDepth>> } }
void createDepth().then(value => window.extrusionDepth = value);
