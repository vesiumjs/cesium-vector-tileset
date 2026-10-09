import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { PerspectiveFrustum } from 'cesium';
import type { FeatureCollection, Point } from 'geojson';
import type { TestTileset, TestViewer } from './browser-types';
import { Cartesian2, Cartesian3, Cartographic, Color, Ellipsoid, EllipsoidalOccluder, EllipsoidGeodesic, IntersectionTests, Matrix4, SceneMode, SceneTransforms, Viewer } from 'cesium';
import { CesiumVectorTileset } from '../../packages/cesium-vector-tileset';
import { drawBatchForOwner } from '../../packages/cesium-vector-tileset/src/render/scene/draw-batch';
import 'cesium/Build/Cesium/Widgets/widgets.css';

const fov = 36.875112943;
const height = 120;
const ellipsoid = Ellipsoid.WGS84;
const geodesic = new EllipsoidGeodesic(new Cartographic(0, 0), new Cartographic(0, 0.01), ellipsoid);
const points = [800, 2500].map((distance) => {
  const location = geodesic.interpolateUsingSurfaceDistance(distance);
  return { id: String(distance), distance, coordinates: [location.longitude * 180 / Math.PI, location.latitude * 180 / Math.PI] as [number, number], world: ellipsoid.cartographicToCartesian(location) };
});
const data: FeatureCollection<Point> = { type: 'FeatureCollection', features: points.map((point, index) => ({ type: 'Feature', id: index + 1, properties: { name: point.id }, geometry: { type: 'Point', coordinates: point.coordinates } })) };
const style: StyleSpecification = {
  version: 8,
  transition: { duration: 0, delay: 0 },
  sources: { points: { type: 'geojson', data } },
  layers: [{ id: 'icons', type: 'symbol', source: 'points', layout: { 'icon-image': 'square', 'icon-size': 1, 'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport', 'icon-padding': 0, 'icon-allow-overlap': true, 'icon-ignore-placement': true }, paint: { 'icon-opacity': 1 } }],
};
function measure(canvas: HTMLCanvasElement, pixels: Uint8Array, center: { x: number; y: number }) {
  const radius = 40;
  const x0 = Math.floor(center.x - radius);
  const x1 = Math.ceil(center.x + radius);
  const y0 = Math.floor(center.y - radius);
  const y1 = Math.ceil(center.y + radius);
  let area = 0;
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height)
        continue;
      const index = ((canvas.height - 1 - y) * canvas.width + x) * 4;
      if (pixels[index] > pixels[index + 1] + 8 && pixels[index] > pixels[index + 2] + 8)
        area += pixels[index] / 255;
    }
  }
  return { area, alphaWidth: Math.sqrt(area), bounded: x0 > 0 && y0 > 0 && x1 < canvas.width && y1 < canvas.height };
}
async function createHorizon() {
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
    sceneMode: SceneMode.SCENE3D,
  }) as unknown as TestViewer;
  viewer.scene.globe.baseColor = Color.BLACK;
  viewer.scene.globe.depthTestAgainstTerrain = false;
  viewer.scene.skyAtmosphere!.show = false;
  viewer.scene.skyBox!.show = false;
  viewer.scene.backgroundColor = Color.BLACK;
  const errors: string[] = [];
  viewer.scene.renderError.addEventListener((_scene, error: Error) => errors.push(error.stack ?? error.message));
  const tileset = new CesiumVectorTileset({ style }) as unknown as TestTileset;
  const image = { width: 16, height: 16, data: new Uint8Array(16 * 16 * 4) };
  for (let index = 0; index < image.data.length; index += 4)
    image.data.set([255, 0, 0, 255], index);
  tileset.addImage('square', image, { pixelRatio: 1 });
  viewer.scene.primitives.add(tileset);
  let pixels: Uint8Array | undefined;
  let frames = 0;
  let draws = 0;
  let pitch = -1;
  let changedAt = performance.now();
  const originalDraw = viewer.scene.context.draw;
  viewer.scene.context.draw = function (command, ...args) {
    if (drawBatchForOwner(command.owner)?.kind === 'symbol')
      draws++;
    return originalDraw.call(this, command, ...args);
  };
  viewer.scene.preRender.addEventListener(() => draws = 0);
  viewer.scene.postRender.addEventListener(() => {
    pixels = viewer.scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
    frames++;
  });
  function setView(value: number) {
    pitch = value;
    changedAt = performance.now();
    const frustum = viewer.camera.frustum as PerspectiveFrustum;
    frustum.fov = fov * Math.PI / 180;
    frustum.aspectRatio = viewer.canvas.clientWidth / viewer.canvas.clientHeight;
    viewer.camera.setView({ destination: Cartesian3.fromDegrees(0, 0, height), orientation: { heading: 0, pitch: pitch * Math.PI / 180, roll: 0 } });
    frames = 0;
    pixels = undefined;
    viewer.scene.requestRender();
  }
  setView(-1);
  return {
    setView,
    ready: () => performance.now() - changedAt > 350 && tileset.tilesLoaded && frames > 20 && !!pixels,
    capture() {
      if (!pixels)
        throw new Error('Native must render');
      const scene = viewer.scene;
      const camera = viewer.camera;
      const ray = camera.getPickRay(new Cartesian2(viewer.canvas.clientWidth / 2, viewer.canvas.clientHeight / 2))!;
      const centerIntersection = IntersectionTests.rayEllipsoid(ray, ellipsoid);
      const viewProjection = Matrix4.multiply((camera.frustum as PerspectiveFrustum).projectionMatrix, camera.viewMatrix, new Matrix4());
      const occluder = new EllipsoidalOccluder(ellipsoid, camera.positionWC);
      const anchors = [...tileset._renderer.symbol._tiles.values()].flatMap((entry) => {
        const tile = 'canonical' in entry.input.tileID ? entry.input.tileID.canonical : entry.input.tileID;
        const precision = Math.SQRT2 * 2 * Math.PI * ellipsoid.maximumRadius / (2 ** tile.z * 8192);
        return entry.batches.flatMap(batch => batch.icon
          ? batch.icon.instances.map((instance) => {
              const index = instance.vertexStart * 3;
              return { opacity: batch.icon!.opacities[instance.vertexStart], precision, world: new Cartesian3(batch.icon!.positions[index], batch.icon!.positions[index + 1], batch.icon!.positions[index + 2]) };
            })
          : []);
      });
      const location = ellipsoid.cartesianToCartographic(camera.positionWC)!;
      const gl = scene.context._gl;
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        pitch,
        errors,
        draws,
        tilesLoaded: tileset.tilesLoaded,
        gpu: String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER)),
        viewport: [viewer.canvas.width, viewer.canvas.height, viewer.canvas.clientWidth, viewer.canvas.clientHeight],
        camera: { mode: scene.mode, longitude: location.longitude, latitude: location.latitude, height: location.height, pitch: camera.pitch * 180 / Math.PI, heading: camera.heading, roll: camera.roll, fov: (camera.frustum as PerspectiveFrustum).fovy * 180 / Math.PI, rayOriginError: Cartesian3.distance(ray.origin, camera.positionWC), rayDirectionError: Cartesian3.distance(ray.direction, camera.directionWC), centerIntersection: centerIntersection ? { start: centerIntersection.start, stop: centerIntersection.stop } : undefined, focusDistance: tileset._renderer.covering.cameraFrame?.cameraToCenterDistance, styleZoom: tileset._renderer.evaluation.zoom },
        points: points.map((point) => {
          // Worker points are quantized to the tile extent. Measure the actual
          // emitted ground anchor, and qualify it against one tile cell.
          const sourceAnchors = anchors.filter(anchor => Cartesian3.distance(anchor.world, point.world) <= anchor.precision);
          const world = sourceAnchors[0]?.world ?? point.world;
          const center = SceneTransforms.worldToWindowCoordinates(scene, world)!;
          const w = viewProjection[3] * world.x + viewProjection[7] * world.y + viewProjection[11] * world.z + viewProjection[15];
          const depth = (viewProjection[2] * world.x + viewProjection[6] * world.y + viewProjection[10] * world.z + viewProjection[14]) / w;
          return { id: point.id, distance: point.distance, coordinates: point.coordinates, center, w, depth, nonoccluded: occluder.isPointVisible(world), sourceLoaded: sourceAnchors.length > 0, sourceAnchors: sourceAnchors.map(anchor => ({ opacity: anchor.opacity, error: Cartesian3.distance(anchor.world, point.world), precision: anchor.precision })), pixels: measure(viewer.canvas, pixels!, center) };
        }),
      };
    },
  };
}
declare global { interface Window { symbol3dHorizon: Awaited<ReturnType<typeof createHorizon>> } }
void createHorizon().then(value => window.symbol3dHorizon = value);
