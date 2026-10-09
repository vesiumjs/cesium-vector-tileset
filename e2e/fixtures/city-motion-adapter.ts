import type { MapGeoJSONFeature } from 'maplibre-gl';
import type { TestTileset, TestViewer } from './browser-types';
import { Cartesian2, Cartesian3, Cartesian4, Cartographic, Matrix4, SceneMode, WebMercatorProjection } from 'cesium';
import { Map as MapLibre, MercatorCoordinate, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { cameraZoom } from '../../packages/cesium-vector-tileset/src/render/scene/covering';
import { drawBatchForOwner } from '../../packages/cesium-vector-tileset/src/render/scene/draw-batch';
import { cityDiagnostics } from './city-diagnostics';
import { mapSurfaceContinuity, nativeSurfaceContinuity } from './city-surface-continuity';

export interface CityPose {
  phase: string;
  destination: number[];
  direction: number[];
  up: number[];
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  fov: number;
  groundProjections?: Array<{ coordinate: [number, number]; pixel: [number, number] }>;
  /** Explicit CV physical camera, independent of the zero-ground zoom capture. */
  physicalCamera?: { coordinate: [number, number]; altitude: number; roll: number };
}

export interface CityCameraSample {
  position: number[];
  direction: number[];
  fov: number;
  zoom: number;
  styleZoom?: number;
  elevation?: number;
  maximumPitch?: number;
  issued?: ReturnType<MapLibre['calculateCameraOptionsFromCameraLngLatAltRotation']>;
  groundProjections: NonNullable<CityPose['groundProjections']>;
  gpu: string;
}

const circumference = 2 * Math.PI * 6378137;
const qualificationEnabled = () => new URLSearchParams(location.search).has('cityCameraQualification');
function gpuName(gl: WebGL2RenderingContext) {
  const extension = gl.getExtension('WEBGL_debug_renderer_info');
  return String(gl.getParameter(extension?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
}

type CityFeature = Pick<MapGeoJSONFeature, 'id' | 'properties' | 'geometry'> & { layerId: string };

function recorder() {
  const started = performance.now();
  const label = new URLSearchParams(location.search).has('cityVideo') ? document.createElement('div') : undefined;
  if (label) {
    label.style.cssText = 'position:fixed;top:0;left:0;z-index:10;padding:4px 8px;background:white;color:black;font:16px monospace;pointer-events:none';
    document.body.append(label);
  }
  let phase = 'cold';
  let cameraVersion = 0;
  let appliedAt = started;
  let presentedVersion = -1;
  const frames: Array<{ phase: string; at: number; cpu: number; cameraVersion: number; commands?: number }> = [];
  const ticks: Array<{ phase: string; at: number; cpu: number; cameraVersion: number; rendered: boolean }> = [];
  const presentations: Array<{ phase: string; cameraVersion: number; latency: number }> = [];
  const milestones: Record<string, number> = {};
  const projectionErrors: Array<{ phase: string; cameraVersion: number; maximum: number }> = [];
  const cameraFrames: Array<CityCameraSample & { phase: string; cameraVersion: number; at: number }> = [];
  return {
    milestone(name: string) {
      milestones[name] ??= performance.now() - started;
    },
    start(phaseName: string) { phase = phaseName; },
    apply(phaseName: string) {
      phase = phaseName;
      cameraVersion++;
      appliedAt = performance.now();
    },
    rendered(at: number, cpu: number, commands?: number) {
      frames.push({ phase, at: at - started, cpu, cameraVersion, commands });
      if (label)
        label.textContent = `${phase} · pose ${cameraVersion} · ${((at - started) / 1000).toFixed(2)}s`;
      if (presentedVersion !== cameraVersion) {
        presentations.push({ phase, cameraVersion, latency: performance.now() - appliedAt });
        presentedVersion = cameraVersion;
      }
    },
    tick(at: number, cpu: number, rendered: boolean) {
      ticks.push({ phase, at: at - started, cpu, cameraVersion, rendered });
    },
    projected(errors: number[]) {
      projectionErrors.push({ phase, cameraVersion, maximum: Math.max(...errors) });
    },
    camera(sample: CityCameraSample) {
      cameraFrames.push({ ...sample, phase, cameraVersion, at: performance.now() - started });
    },
    snapshot() { return { elapsed: performance.now() - started, frames, ticks, presentations, milestones: { ...milestones }, projectionErrors, cameraFrames }; },
    state() { return { phase, poseIndex: cameraVersion }; },
    reset() {
      frames.length = 0;
      ticks.length = 0;
      presentations.length = 0;
      projectionErrors.length = 0;
      cameraFrames.length = 0;
      presentedVersion = -1;
    },
  };
}

const tick = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

export function installNativeCityMotion(viewer: TestViewer) {
  const capture = recorder();
  const qualifyCamera = qualificationEnabled();
  const physicalCamera = new URLSearchParams(location.search).has('cityPhysicalCamera');
  if (physicalCamera && (viewer.scene.mode !== SceneMode.COLUMBUS_VIEW || !(viewer.scene.mapProjection instanceof WebMercatorProjection)))
    throw new Error('Physical city camera qualification requires Mercator Columbus View');
  const gpu = qualifyCamera ? gpuName(viewer.scene.context._gl) : '';
  let appliedPose: CityPose | undefined;
  function projectGround(coordinate: [number, number]): [number, number] {
    let position = Cartesian3.fromDegrees(...coordinate, 0, viewer.scene.mapProjection.ellipsoid);
    if (viewer.scene.mode !== SceneMode.SCENE3D) {
      const projected = viewer.scene.mapProjection.project(Cartographic.fromDegrees(...coordinate));
      position = new Cartesian3(projected.z, projected.x, projected.y);
    }
    const matrix = Matrix4.multiply(viewer.camera.frustum.projectionMatrix, viewer.camera.viewMatrix, new Matrix4());
    const clip = Matrix4.multiplyByVector(matrix, new Cartesian4(position.x, position.y, position.z, 1), new Cartesian4());
    return [(clip.x / clip.w + 1) * viewer.canvas.clientWidth / 2, (1 - clip.y / clip.w) * viewer.canvas.clientHeight / 2];
  }
  const observeStages = new URLSearchParams(location.search).has('cityStages');
  let sawSymbol = false;
  let sawStation = false;
  let loaded = false;
  let tileset: TestTileset | undefined;
  if (new URLSearchParams(location.search).has('citySurfaceContinuity'))
    window.citySurfaceContinuity = nativeSurfaceContinuity(viewer, () => tileset, capture.state);
  const original = viewer.scene.render;
  let rendered = false;
  viewer.scene.postRender.addEventListener(() => {
    rendered = true;
  });
  viewer.scene.render = function (...args) {
    rendered = false;
    const at = performance.now();
    original.apply(this, args);
    const cpu = performance.now() - at;
    capture.tick(at, cpu, rendered);
    const submittedCommands = tileset?._lastSubmittedCommands ?? 0;
    const commands = rendered ? submittedCommands : undefined;
    if (!loaded && tileset?.tilesLoaded && submittedCommands > 0) {
      loaded = true;
      capture.milestone('loaded');
    }
    if (rendered) {
      capture.rendered(at, cpu, commands);
      if (qualifyCamera && appliedPose) {
        const camera = viewer.camera;
        capture.camera({
          position: [0.5 + camera.positionWC.y / circumference, 0.5 - camera.positionWC.z / circumference, camera.positionWC.x / circumference],
          direction: [camera.directionWC.y, -camera.directionWC.z, camera.directionWC.x],
          fov: camera.frustum.fovy! * 180 / Math.PI,
          zoom: tileset?._styleEvaluation.zoom ?? Number.NaN,
          styleZoom: tileset?._styleEvaluation.zoom,
          groundProjections: (appliedPose.groundProjections ?? []).map(({ coordinate }) => ({ coordinate, pixel: projectGround(coordinate) })),
          gpu,
        });
      }
      // Diagnostic only, outside the measured Scene.render interval. Command
      // submission is not a claim that nonzero glyph pixels have appeared.
      if (observeStages && tileset) {
        if (submittedCommands > 0)
          capture.milestone('firstLibraryCommand');
        if (!sawSymbol) {
          sawSymbol = viewer.scene._frameState.commandList.some(command =>
            (drawBatchForOwner(command) ?? drawBatchForOwner(command.owner))?.kind === 'symbol');
          if (sawSymbol)
            capture.milestone('firstSymbolCommand');
        }
        if (sawSymbol && !sawStation) {
          const submitted = new Set(viewer.scene._frameState.commandList.flatMap((command) => {
            const batch = drawBatchForOwner(command) ?? drawBatchForOwner(command.owner);
            return batch?.kind === 'symbol' ? [`${batch.tileId}/${batch.layerId}`] : [];
          }));
          sawStation = cityDiagnostics(viewer, tileset, tileset._symbolRenderer.cameraZoom).some((row) => {
            const box = row.screenBox;
            return row.opacity >= 0.1 && row.uploaded && row.shown && row.current
              && tileset._symbolRenderer.isTilePlacementActive(row.tileId)
              && submitted.has(`${row.tileId}/${row.layerId}`) && box
              && box.x2 > 0 && box.y2 > 0 && box.x1 < viewer.canvas.width && box.y1 < viewer.canvas.height;
          });
          if (sawStation)
            capture.milestone('firstSelectedStationSubmission');
        }
      }
    }
  };
  function pose(phase: string): CityPose {
    const camera = viewer.camera;
    const canvas = viewer.canvas;
    const ground = camera.pickEllipsoid(new Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2), viewer.scene.mapProjection.ellipsoid);
    if (!ground)
      throw new Error('City motion camera does not intersect the ground');
    const center = Cartographic.fromCartesian(ground);
    const zoom = cameraZoom({ camera, mode: viewer.scene.mode, projection: viewer.scene.mapProjection, width: canvas.clientWidth, height: canvas.clientHeight });
    if (zoom === undefined || !camera.frustum.fovy)
      throw new Error('City motion requires a perspective camera');
    const longitude = center.longitude * 180 / Math.PI;
    const latitude = center.latitude * 180 / Math.PI;
    const groundProjections = new URLSearchParams(location.search).has('cityProjection')
      ? [[longitude - 0.001, latitude], [longitude + 0.001, latitude], [longitude, latitude - 0.001], [longitude, latitude + 0.001]].map(([longitude, latitude]) => ({
          coordinate: [longitude, latitude] as [number, number],
          pixel: projectGround([longitude, latitude]),
        }))
      : undefined;
    let physical: CityPose['physicalCamera'];
    if (physicalCamera) {
      const coordinate = viewer.scene.mapProjection.unproject(new Cartesian3(camera.positionWC.y, camera.positionWC.z, camera.positionWC.x));
      const longitudeLatitude: [number, number] = [coordinate.longitude * 180 / Math.PI, coordinate.latitude * 180 / Math.PI];
      physical = {
        coordinate: longitudeLatitude,
        altitude: (camera.positionWC.x / circumference) / MercatorCoordinate.fromLngLat(longitudeLatitude, 1).z,
        roll: camera.roll * 180 / Math.PI,
      };
    }
    return {
      phase,
      destination: [camera.positionWC.x, camera.positionWC.y, camera.positionWC.z],
      direction: [camera.directionWC.x, camera.directionWC.y, camera.directionWC.z],
      up: [camera.upWC.x, camera.upWC.y, camera.upWC.z],
      center: [longitude, latitude],
      zoom,
      bearing: camera.heading * 180 / Math.PI,
      pitch: Math.max(0, 90 + camera.pitch * 180 / Math.PI),
      fov: camera.frustum.fovy * 180 / Math.PI,
      groundProjections,
      ...(physical ? { physicalCamera: physical } : {}),
    };
  }
  function apply(value: CityPose) {
    appliedPose = value;
    const projected = viewer.scene.mode !== SceneMode.SCENE3D;
    const position = (values: number[]) => projected
      ? new Cartesian3(values[1], values[2], values[0])
      : Cartesian3.fromArray(values);
    viewer.camera.setView({
      destination: position(value.destination),
      convert: !projected,
      orientation: { direction: position(value.direction), up: position(value.up) },
    });
  }
  const initial = pose('initial');
  appliedPose = initial;
  const position = Cartographic.clone(viewer.camera.positionCartographic);
  function generate() {
    const poses: CityPose[] = [];
    function add(phase: string, scale: number, longitude = 0, heading = 0, pitch = -Math.PI / 2) {
      viewer.camera.setView({
        destination: Cartesian3.fromRadians(position.longitude + longitude, position.latitude, position.height * scale),
        orientation: { heading, pitch, roll: 0 },
      });
      poses.push(pose(phase));
    }
    for (let step = 1; step <= 24; step++)
      add('zoom-out', 2 ** (3 * step / 24));
    for (let step = 1; step <= 24; step++)
      add('zoom-in', 2 ** (3 * (1 - step / 24)));
    for (let step = 1; step <= 24; step++)
      add('pan', 1, Math.sin(step * Math.PI / 12) * 0.025 * Math.PI / 180);
    for (let step = 1; step <= 36; step++)
      add('orbit', 1, 0, step * Math.PI / 18, -Math.PI / 2 + Math.sin(step * Math.PI / 36) * Math.PI / 3);
    poses.push(initial);
    apply(initial);
    return poses;
  }
  const adapter = {
    initial,
    errors: [] as string[],
    attach(value: TestTileset) { tileset = value; },
    ready() {
      const ready = Boolean(tileset?.tilesLoaded && tileset._lastSubmittedCommands > 0);
      return ready;
    },
    generate,
    capturePose: pose,
    async run(poses: CityPose[]) {
      capture.start('stationary');
      for (let step = 0; step < 30; step++)
        await tick();
      for (const value of poses) {
        capture.apply(value.phase);
        apply(value);
        await tick();
      }
      capture.start('settle');
      for (let step = 0; step < 60; step++)
        await tick();
      return capture.snapshot();
    },
    snapshot: capture.snapshot,
    state: capture.state,
    mapFeatures: (): CityFeature[] => { throw new Error('MapLibre feature queries belong to the reference'); },
    sourceCoverage() {
      return Object.entries(tileset!._style.tilePyramids).map(([sourceId, pyramid]) => ({
        sourceId,
        tiles: pyramid._covering!.idealTileIDs.map(id => ({ z: id.canonical.z, x: id.canonical.x, y: id.canonical.y })),
      }));
    },
    async runBare(poses: CityPose[]) {
      if (!tileset)
        throw new Error('Native city tileset has not been attached');
      tileset.show = false;
      await tick();
      capture.reset();
      return adapter.run(poses);
    },
  };
  viewer.scene.renderError.addEventListener((_scene, error: Error) => adapter.errors.push(error.message));
  window.cityMotion = adapter;
  return adapter;
}

export function createMapCityMotion(initial: CityPose) {
  document.body.classList.add('maplibre-only');
  setWorkerUrl(workerUrl);
  const capture = recorder();
  const qualifyCamera = qualificationEnabled();
  let appliedPose = initial;
  let issued: ReturnType<MapLibre['calculateCameraOptionsFromCameraLngLatAltRotation']> | undefined;
  const observeStages = new URLSearchParams(location.search).has('cityStages');
  let sawSymbol = false;
  let sawStation = false;
  let loaded = false;
  const map = new MapLibre({
    container: 'maplibre',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: initial.center,
    zoom: initial.zoom,
    bearing: initial.bearing,
    pitch: initial.pitch,
    maxPitch: initial.physicalCamera ? 89.9 : 85,
    attributionControl: false,
    interactive: false,
    fadeDuration: 0,
  });
  map.setVerticalFieldOfView(initial.fov);
  function apply(value: CityPose) {
    appliedPose = value;
    if (value.physicalCamera) {
      map.setCenterClampedToGround(false);
      map.setVerticalFieldOfView(value.fov);
      // The public converter reads the current transform's elevation. Each
      // pose compares the same zero-ground city plane, independently of the
      // preceding near-horizon pose's elevated finite focus.
      map.setCenterElevation(0);
      issued = map.calculateCameraOptionsFromCameraLngLatAltRotation(value.physicalCamera.coordinate, value.physicalCamera.altitude, value.bearing, value.pitch, value.physicalCamera.roll);
      // Preserve the finite elevated focus returned by the public conversion.
      map.jumpTo(issued);
    }
    else {
      issued = undefined;
      map.jumpTo({ center: value.center, zoom: value.zoom, bearing: value.bearing, pitch: value.pitch });
    }
  }
  if (initial.physicalCamera)
    apply(initial);
  const gpu = qualifyCamera ? gpuName(map.getCanvas().getContext('webgl2')!) : '';
  if (qualifyCamera) {
    map.on('render', () => {
      const transform = (map as unknown as { _camera: { transform: {
        worldSize: number;
        _invViewProjMatrix: number[];
        _pixelMatrix3D: number[];
        getCameraLngLat: () => { lng: number; lat: number };
        getCameraAltitude: () => number;
        coordinatePoint: (point: MercatorCoordinate, elevation: number, matrix: number[]) => { x: number; y: number };
      }; }; })._camera.transform;
      const camera = MercatorCoordinate.fromLngLat(transform.getCameraLngLat());
      const altitudeScale = MercatorCoordinate.fromLngLat(map.getCenter(), 1).z;
      camera.z = transform.getCameraAltitude() * altitudeScale;
      // Read the real center clip ray. Its X/Y use world pixels; Z uses
      // physical meters at the actual focus latitude scale.
      const inverse = Matrix4.fromArray(transform._invViewProjMatrix);
      const points = [0, 0.5].map((depth) => {
        const value = Matrix4.multiplyByVector(inverse, new Cartesian4(0, 0, depth, 1), new Cartesian4());
        return new Cartesian3(value.x / value.w / transform.worldSize, value.y / value.w / transform.worldSize, value.z / value.w * altitudeScale);
      });
      const direction = Cartesian3.normalize(Cartesian3.subtract(points[1], points[0], new Cartesian3()), new Cartesian3());
      capture.camera({
        position: [camera.x, camera.y, camera.z],
        direction: [direction.x, direction.y, direction.z],
        fov: map.getVerticalFieldOfView(),
        zoom: map.getZoom(),
        elevation: map.getCenterElevation(),
        maximumPitch: map.getMaxPitch(),
        issued,
        groundProjections: (appliedPose.groundProjections ?? []).map(({ coordinate }) => {
          const point = transform.coordinatePoint(MercatorCoordinate.fromLngLat(coordinate), 0, transform._pixelMatrix3D);
          return { coordinate, pixel: [point.x, point.y] };
        }),
        gpu,
      });
    });
  }
  const surfaceContinuity = new URLSearchParams(location.search).has('citySurfaceContinuity')
    ? mapSurfaceContinuity(map, capture.state)
    : undefined;
  if (surfaceContinuity)
    window.citySurfaceContinuity = surfaceContinuity;
  const runtime = map as unknown as { _render: (...args: unknown[]) => unknown };
  const original = runtime._render;
  runtime._render = function (...args) {
    const at = performance.now();
    const result = original.apply(this, args);
    const cpu = performance.now() - at;
    surfaceContinuity?.sample();
    capture.tick(at, cpu, true);
    capture.rendered(at, cpu);
    if (!loaded && map.loaded()) {
      loaded = true;
      capture.milestone('loaded');
    }
    if (observeStages && (!sawSymbol || !sawStation) && map.isStyleLoaded()) {
      const features = map.queryRenderedFeatures().filter(feature => feature.layer.type === 'symbol');
      if (!sawSymbol && features.length > 0) {
        sawSymbol = true;
        capture.milestone('firstSymbolFeature');
      }
      if (!sawStation && features.some(feature => /Westminster|Waterloo|Green Park|Piccadilly/.test(String(feature.properties.name ?? '')))) {
        sawStation = true;
        capture.milestone('firstSelectedStationFeature');
      }
    }
    return result;
  };
  const errors: string[] = [];
  map.on('error', event => errors.push(event.error.message));
  window.cityMotion = {
    initial,
    errors,
    attach() {},
    ready() {
      const ready = map.loaded();
      return ready;
    },
    generate: () => { throw new Error('MapLibre replays the Cesium camera poses'); },
    capturePose: () => { throw new Error('Camera poses are captured from Cesium'); },
    async run(poses) {
      capture.start('stationary');
      for (let step = 0; step < 30; step++)
        await tick();
      for (const value of poses) {
        capture.apply(value.phase);
        apply(value);
        if (value.groundProjections) {
          capture.projected(value.groundProjections.map(({ coordinate, pixel }) => {
            const point = map.project(coordinate);
            return Math.hypot(point.x - pixel[0], point.y - pixel[1]);
          }));
        }
        await tick();
      }
      capture.start('settle');
      for (let step = 0; step < 60; step++)
        await tick();
      return capture.snapshot();
    },
    snapshot: capture.snapshot,
    state: capture.state,
    sourceCoverage() {
      return Object.entries(map.getStyle().sources).filter(([, source]) => source.type === 'vector').map(([sourceId]) => {
        const source = map.getSource(sourceId) as unknown as { tileSize: number; minzoom: number; maxzoom: number };
        return { sourceId, tiles: map.coveringTiles({ tileSize: source.tileSize, minzoom: source.minzoom, maxzoom: source.maxzoom }).map(id => ({ z: id.canonical.z, x: id.canonical.x, y: id.canonical.y })) };
      });
    },
    mapFeatures: () => map.queryRenderedFeatures()
      .filter(feature => /Westminster|Waterloo|Green Park|Piccadilly/.test(String(feature.properties.name ?? '')))
      .map(feature => ({ id: feature.id, layerId: feature.layer.id, properties: feature.properties, geometry: feature.geometry })),
    runBare: async () => { throw new Error('Bare control belongs to Cesium'); },
  };
}

declare global {
  interface Window { cityMotion: ReturnType<typeof installNativeCityMotion> }
}
