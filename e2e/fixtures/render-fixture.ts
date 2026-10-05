import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { RequestTransformFunction } from '../../packages/cesium-vector-tileset/src/util/request';
import type { TestTileset, TestViewer } from './browser-types';
import { Camera, Cartesian2, Cartesian3, Cartographic, HeadingPitchRange, Matrix4, PrimitiveCollection, Rectangle, SceneMode, SceneTransforms, Viewer, WebMercatorProjection } from 'cesium';
import { Map as MapLibre, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { drawBatchForOwner, linePaintForOwner } from '../../packages/cesium-vector-tileset/src/render/scene/draw-batch';
import { loadTileJson } from '../../packages/cesium-vector-tileset/src/source/load-tilejson';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import 'maplibre-gl/dist/maplibre-gl.css';

async function createValidation() {
  const query = new URLSearchParams(location.search);
  const publishedUrl = '/packages/cesium-vector-tileset/dist/index.mjs';
  const { CesiumVectorTileset } = query.has('published')
    ? await import(/* @vite-ignore */ publishedUrl) as typeof import('../../packages/cesium-vector-tileset/index')
    : await import('../../packages/cesium-vector-tileset/index');
  if (!query.has('compare'))
    document.body.classList.add('single');
  setWorkerUrl(workerUrl);
  const views: Record<string, [number, number]> = {
    london: [-0.1276, 51.5072],
    newYork: [-74.006, 40.7128],
    tokyo: [139.6917, 35.6895],
    shanghai: [121.454, 31.258],
    antimeridian: [179.98, -16.5],
    hawaii: [-166, 25],
    beibu: [109.12, 21.03],
  };
  const center = (query.get('center')?.split(',').map(Number) ?? views[query.get('view') ?? 'london']) as [number, number];
  const scale = Number(query.get('scale') ?? 1);
  Camera.DEFAULT_VIEW_FACTOR = 0;
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
    requestRenderMode: true,
    useBrowserRecommendedResolution: false,
    ...(query.get('antialias') === '0' ? { contextOptions: { webgl: { antialias: false } }, msaaSamples: 1 } : {}),
    maximumRenderTimeChange: Infinity,
    mapProjection: new WebMercatorProjection(),
    sceneMode: query.get('mode') === '2d'
      ? SceneMode.SCENE2D
      : query.get('mode') === 'cv' ? SceneMode.COLUMBUS_VIEW : SceneMode.SCENE3D,
  }) as unknown as TestViewer;
  viewer.scene.debugShowFramesPerSecond = true;
  const viewRectangle = Rectangle.fromDegrees(
    center[0] - 0.0375 * scale,
    center[1] - 0.01575 * scale,
    center[0] + 0.0375 * scale,
    center[1] + 0.01575 * scale,
  );
  viewer.camera.setView({ destination: viewRectangle });

  const renderErrors: string[] = [];
  viewer.scene.renderError.addEventListener((_scene, error: Error) => renderErrors.push(error.stack ?? error.message));

  const styleUrl = query.get('style') ?? 'https://tiles.openfreemap.org/styles/liberty';
  const tileset = await CesiumVectorTileset.fromUrl(styleUrl) as unknown as TestTileset;
  viewer.scene.primitives.add(tileset);
  let reference: MapLibre | undefined;
  const referenceErrors: string[] = [];
  if (query.has('compare')) {
    const referenceStyle = structuredClone(tileset.styleSpec) as StyleSpecification;
    const { transformRequest } = (tileset as unknown as { _style: { transformRequest?: RequestTransformFunction } })._style;
    for (const [id, source] of Object.entries(referenceStyle.sources)) {
      if (source.type === 'vector' && source.url) {
        // MapLibre consumes TileJSON; Cesium's loader also normalizes ArcGIS
        // service metadata. Feed both renderers the same explicit templates.
        const metadata = await loadTileJson(source, transformRequest, new AbortController());
        // The loader's shared response declares DEM encoding even for vector sources.
        const normalized = { ...source, ...metadata } as unknown as typeof source;
        delete normalized.url;
        referenceStyle.sources[id] = normalized;
      }
    }
    reference = new MapLibre({
      container: 'maplibre',
      style: referenceStyle,
      center,
      zoom: 14,
      attributionControl: false,
      interactive: false,
      fadeDuration: 0,
    });
    reference.on('error', event => referenceErrors.push(event.error.message));
  }

  // Instrument actual work at its owner; no instrumentation enters the library.
  const internals = tileset as unknown as {
    _styleEvaluation: { zoom: number };
    _style: { tilePyramids: Record<string, { _updateRetainedTiles: (...args: unknown[]) => unknown }> };
    _vectorRenderer: { beginTileBuild: (...args: unknown[]) => unknown };
    _symbolRenderer: {
      update: (...args: unknown[]) => unknown;
      _tiles: Map<string, { collections: PrimitiveCollection[] }>;
    };
  };
  const measurements = {
    builds: 0,
    pyramidWalks: 0,
    updateMs: [] as number[],
    placementMs: [] as number[],
    uploadMs: [] as number[],
    childrenMs: [] as number[],
    buildMs: [] as number[],
    paintMs: [] as number[],
    sourceMs: [] as number[],
    releaseMs: [] as number[],
    styleMs: [] as number[],
    patternMs: [] as number[],
    backgroundMs: [] as number[],
    residencyMs: [] as number[],
    rebuildMs: [] as number[],
    frames: [] as Array<{ zoom: number; tiles: number; commands: number; surfaces: number; pending: number }>,
  };
  function measureMethod(owner: object, method: string, timings: number[]) {
    const target = owner as Record<string, (...args: unknown[]) => unknown>;
    const original = target[method];
    target[method] = function (...args) {
      const start = performance.now();
      const result = original.apply(this, args);
      timings.push(performance.now() - start);
      return result;
    };
  }
  const work = tileset as unknown as {
    _tilePublishQueue: object;
    _vectorRenderer: object;
    _styleEvaluation: object;
    _patternRenderer: object;
    _backgroundRenderer: object;
    _tileResidency: object;
    _sourceRenderSync: object;
  };
  measureMethod(work._tilePublishQueue, 'drain', measurements.buildMs);
  measureMethod(work._vectorRenderer, 'updatePaint', measurements.paintMs);
  measureMethod(work._sourceRenderSync, 'updateSource', measurements.sourceMs);
  measureMethod(work._styleEvaluation, 'evaluate', measurements.styleMs);
  measureMethod(work._patternRenderer, 'update', measurements.patternMs);
  measureMethod(work._backgroundRenderer, 'update', measurements.backgroundMs);
  for (const method of ['syncRetiredCapacity', 'syncHeldTileVisibility', 'syncMemoryBudget', 'releaseReplacedFeatureIndices'])
    measureMethod(work._tileResidency, method, measurements.residencyMs);
  for (const method of ['_republishFlippedTiles', '_buildRasterLayers', '_buildPatternLayers'])
    measureMethod(tileset, method, measurements.rebuildMs);
  const begin = internals._vectorRenderer.beginTileBuild;
  internals._vectorRenderer.beginTileBuild = function (...args) {
    measurements.builds++;
    return begin.apply(this, args);
  };
  const measuredPyramids = new WeakSet<object>();
  function measurePyramids() {
    for (const pyramid of Object.values(internals._style.tilePyramids)) {
      if (measuredPyramids.has(pyramid))
        continue;
      measuredPyramids.add(pyramid);
      const update = pyramid._updateRetainedTiles;
      pyramid._updateRetainedTiles = function (...args) {
        measurements.pyramidWalks++;
        return update.apply(this, args);
      };
    }
  }
  const placement = internals._symbolRenderer.update;
  internals._symbolRenderer.update = function (...args) {
    const start = performance.now();
    const result = placement.apply(this, args);
    measurements.placementMs.push(performance.now() - start);
    return result;
  };
  const update = tileset.update;
  tileset.update = function (...args) {
    measurePyramids();
    const start = performance.now();
    update.apply(this, args);
    measurements.updateMs.push(performance.now() - start);
  };
  const sceneCollections = (tileset as unknown as {
    _sceneCollections: {
      pumpFirstUpdates: (...args: unknown[]) => unknown;
      updateChildren: (...args: unknown[]) => unknown;
      flushRemovals: (...args: unknown[]) => unknown;
    };
  })._sceneCollections;
  measureMethod(sceneCollections, 'flushRemovals', measurements.releaseMs);
  for (const [method, timings] of [
    ['pumpFirstUpdates', measurements.uploadMs],
    ['updateChildren', measurements.childrenMs],
  ] as const) {
    const original = sceneCollections[method];
    sceneCollections[method] = function (...args) {
      const start = performance.now();
      const result = original.apply(this, args);
      timings.push(performance.now() - start);
      return result;
    };
  }
  const coverage: number[] = [];
  let coverageStarted = false;
  let renderedFrames = 0;
  let sampledRows: Uint8Array[] = [];
  function sampleFramebuffer() {
    const context = viewer.scene.context as unknown as { readPixels: (options: object) => Uint8Array };
    sampledRows = [0.25, 0.5, 0.75].map(row => context.readPixels({
      x: Math.floor(viewer.canvas.width * 0.1),
      y: Math.floor(viewer.canvas.height * row),
      width: Math.floor(viewer.canvas.width * 0.8),
      height: 1,
    }));
  }
  function readCoverage(color: number[] = [51, 102, 170]) {
    if (sampledRows.length === 0)
      return [0, 0, 0];
    return sampledRows.map((pixels) => {
      let filled = 0;
      for (let pixel = 0; pixel < pixels.length; pixel += 4) {
        if (color.every((channel, index) => Math.abs(pixels[pixel + index] - channel) < 5))
          filled++;
      }
      return filled / (pixels.length / 4);
    });
  }
  function readPixelSamples() {
    return sampledRows.map(pixels => [0.25, 0.5, 0.75].map((fraction) => {
      const offset = Math.floor(pixels.length / 4 * fraction) * 4;
      return Array.from(pixels.subarray(offset, offset + 4));
    }));
  }
  function readMismatchRanges(color: number[] = [51, 102, 170]) {
    return sampledRows.flatMap((pixels, row) => {
      const ranges = [];
      const y = Math.floor(viewer.canvas.height * [0.25, 0.5, 0.75][row]);
      const width = pixels.length / 4;
      const point = (column: number) => {
        const x = Math.floor(viewer.canvas.width * 0.1) + column;
        // readPixels uses a bottom-left origin; Camera takes CSS pixels from
        // the top-left. Pick the center of this exact framebuffer pixel.
        const windowPosition = new Cartesian2(
          (x + 0.5) * viewer.canvas.clientWidth / viewer.canvas.width,
          (viewer.canvas.height - y - 0.5) * viewer.canvas.clientHeight / viewer.canvas.height,
        );
        const picked = viewer.camera.pickEllipsoid(windowPosition, viewer.scene.globe.ellipsoid);
        const ground = picked && Cartographic.fromCartesian(picked);
        return {
          framebuffer: { x, y },
          window: { x: windowPosition.x, y: windowPosition.y },
          rgba: Array.from(pixels.subarray(column * 4, column * 4 + 4)),
          ground: ground && {
            longitude: ground.longitude * 180 / Math.PI,
            latitude: ground.latitude * 180 / Math.PI,
            mercatorX: (ground.longitude + Math.PI) / (2 * Math.PI),
            mercatorY: (1 - Math.log(Math.tan(Math.PI / 4 + ground.latitude / 2)) / Math.PI) / 2,
          },
        };
      };
      let start = -1;
      for (let column = 0; column <= width; column++) {
        const matches = column === width || color.every((channel, index) => Math.abs(pixels[column * 4 + index] - channel) < 5);
        if (!matches && start === -1)
          start = column;
        if (matches && start !== -1) {
          const end = column - 1;
          ranges.push({ row, pixels: end - start + 1, samples: [...new Set([start, Math.floor((start + end) / 2), end])].map(point) });
          start = -1;
        }
      }
      return ranges;
    });
  }
  viewer.scene.postRender.addEventListener(() => {
    renderedFrames++;
    // Chromium discards the default framebuffer after compositing. Sample at
    // postRender and retain those bytes so polling tests inspect the last frame.
    sampleFramebuffer();
    if (tileset.isDestroyed())
      return;
    const stats = tileset.stats();
    const frame = (viewer.scene as unknown as { _frameState: { commandList: Array<{ owner?: object }> } })._frameState;
    const surfaces = frame.commandList.filter((command) => {
      const batch = drawBatchForOwner(command) ?? drawBatchForOwner(command.owner);
      return batch && ['fill', 'extrusion', 'pattern', 'raster'].includes(batch.kind);
    }).length;
    measurements.frames.push({
      zoom: internals._styleEvaluation.zoom,
      tiles: stats.bucket.tiles,
      commands: stats.submittedCommands,
      surfaces,
      pending: stats.pendingPublishes,
    });
    coverageStarted ||= stats.bucket.tiles > 0;
    if (query.has('synthetic') && coverageStarted) {
      const context = viewer.scene.context as unknown as { readPixels: (options: object) => Uint8Array };
      const pixels = context.readPixels({
        x: Math.floor(viewer.canvas.width * 0.1),
        y: Math.floor(viewer.canvas.height / 2),
        width: Math.floor(viewer.canvas.width * 0.8),
        height: 1,
      });
      let filled = 0;
      for (let pixel = 0; pixel < pixels.length; pixel += 4) {
        if ((Math.abs(pixels[pixel] - 51) < 5 && Math.abs(pixels[pixel + 1] - 102) < 5
          && Math.abs(pixels[pixel + 2] - 170) < 5)
        || (pixels[pixel] > 250 && pixels[pixel + 1] > 250 && pixels[pixel + 2] > 250)) {
          filled++;
        }
      }
      coverage.push(filled / (pixels.length / 4));
    }
  });

  const symbolVisibility = new Map<{ show: boolean }, boolean>();
  let obliqueView: { destination: Cartesian3; orientation: { direction: Cartesian3; up: Cartesian3 } };
  const validation = {
    viewer,
    tileset,
    reference,
    referenceErrors,
    renderErrors,
    atlas: query.has('atlas')
      ? {
          textures: (await import('../../packages/cesium-vector-tileset/src/assets/shared-atlas-textures')).SharedAtlasTextures,
          cesium: await import('cesium'),
        }
      : undefined,
    drawBatch: drawBatchForOwner,
    measurements,
    coverage,
    readCoverage,
    readPixelSamples,
    readMismatchRanges,
    projectPosition(longitude: number, latitude: number, height = 0) {
      return SceneTransforms.worldToWindowCoordinates(viewer.scene, Cartesian3.fromDegrees(longitude, latitude, height));
    },
    get renderedFrames() { return renderedFrames; },
    setObliqueView() {
      viewer.camera.lookAt(
        Cartesian3.fromDegrees(center[0], center[1]),
        new HeadingPitchRange(Math.PI * 35 / 180, -Math.PI / 4, viewer.camera.positionCartographic.height * 1.4),
      );
      viewer.camera.lookAtTransform(Matrix4.IDENTITY);
      obliqueView = {
        destination: Cartesian3.clone(viewer.camera.positionWC),
        orientation: { direction: Cartesian3.clone(viewer.camera.directionWC), up: Cartesian3.clone(viewer.camera.upWC) },
      };
      viewer.scene.requestRender();
    },
    restoreObliqueView() {
      viewer.camera.setView(obliqueView);
      viewer.scene.requestRender();
    },
    setTopView() {
      viewer.camera.setView({ destination: viewRectangle, orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
      viewer.scene.requestRender();
    },
    async setSymbolsVisible(visible: boolean) {
      if (visible) {
        for (const [primitive, show] of symbolVisibility) {
          primitive.show = show;
        }
        symbolVisibility.clear();
      }
      else {
        for (const entry of internals._symbolRenderer._tiles.values()) {
          for (const collection of entry.collections) {
            for (let index = 0; index < collection.length; index++) {
              const primitive = collection.get(index) as { show: boolean };
              symbolVisibility.set(primitive, primitive.show);
              primitive.show = false;
            }
          }
        }
      }
      viewer.scene.requestRender();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    },
    async probeLinePaint() {
      const bucket = tileset as unknown as { _vectorRenderer: { tileIds: string[]; getTileCollections: (id: string) => object[] } };
      const resources = bucket._vectorRenderer.tileIds.flatMap(tileId => bucket._vectorRenderer.getTileCollections(tileId)
        .filter((collection): collection is PrimitiveCollection => collection instanceof PrimitiveCollection)
        .flatMap(collection => Array.from({ length: collection.length }, (_, index) => {
          const primitive = collection.get(index) as { _va?: object[] };
          const paint = linePaintForOwner(primitive);
          return drawBatchForOwner(primitive)?.kind === 'line' && paint && primitive._va?.length
            ? [{ primitive, paint, width: paint.width, arrays: [...primitive._va] }]
            : [];
        }).flat()));
      const height = viewer.camera.positionCartographic.height;
      const beforeZoom = internals._styleEvaluation.zoom;
      const beforeBuilds = measurements.builds;
      viewer.camera.zoomIn(height * 0.001);
      for (let frame = 0; frame < 4; frame++) {
        viewer.scene.requestRender();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      const result = {
        resources: resources.length,
        arraysStable: resources.every(({ primitive, arrays }) => arrays.length === primitive._va?.length && arrays.every((array, index) => array === primitive._va[index])),
        changedWidths: resources.filter(resource => resource.paint.width !== resource.width).length,
        builds: measurements.builds - beforeBuilds,
        zoom: [beforeZoom, internals._styleEvaluation.zoom],
      };
      viewer.camera.zoomOut(height - viewer.camera.positionCartographic.height);
      viewer.scene.requestRender();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return result;
    },
    get zoom() { return internals._styleEvaluation.zoom; },
    syncReference() {
      const position = viewer.camera.positionCartographic;
      reference?.jumpTo({
        center: [position.longitude * 180 / Math.PI, position.latitude * 180 / Math.PI],
        zoom: internals._styleEvaluation.zoom,
        bearing: viewer.camera.heading * 180 / Math.PI,
      });
    },
    reset() {
      measurements.builds = 0;
      measurements.pyramidWalks = 0;
      measurements.updateMs.length = 0;
      measurements.placementMs.length = 0;
      measurements.uploadMs.length = 0;
      measurements.childrenMs.length = 0;
      measurements.buildMs.length = 0;
      measurements.paintMs.length = 0;
      measurements.sourceMs.length = 0;
      measurements.releaseMs.length = 0;
      measurements.styleMs.length = 0;
      measurements.patternMs.length = 0;
      measurements.backgroundMs.length = 0;
      measurements.residencyMs.length = 0;
      measurements.rebuildMs.length = 0;
      measurements.frames.length = 0;
      coverage.length = 0;
    },
  };
  window.renderValidation = validation;
  return validation;
}

declare global {
  interface Window { renderValidation: Awaited<ReturnType<typeof createValidation>> }
}
void createValidation();
