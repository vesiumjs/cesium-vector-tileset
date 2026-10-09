import type { CircleLayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { TilePickObject } from '../packages/cesium-vector-tileset/src/render/vector/tile-conversion';
import type { NativeBufferCollection, NativeShaderProgram, NativeVertexArray } from './fixtures/browser-types';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

interface CircleOwner {
  isDestroyed: () => boolean;
  _renderContext?: Pick<NonNullable<NativeBufferCollection['_renderContext']>, 'vertexArray' | 'shaderProgram'>;
  _vaf?: { isDestroyed: () => boolean };
  _sp?: NativeShaderProgram;
  _spTranslucent?: NativeShaderProgram;
}
type CirclePick = TilePickObject & { id?: TilePickObject };
interface CircleSample { index: number; green: number; blue: number }
type CircleWorstSample = CircleSample & { expectedGreen: number; expectedBlue: number; error: number };
interface CirclePhase {
  fill: number;
  stroke: number;
  greenError: number;
  blueError: number;
  worst?: CircleWorstSample;
  samePick: boolean;
  pointPicked: boolean;
  stable: boolean;
  arraysStable: boolean;
  oldArraysReleased: boolean;
  fps: boolean;
  renderErrors: string[];
}

declare global {
  interface Window {
    circleOwners: CircleOwner[];
    circleArrays: Array<NativeVertexArray | { isDestroyed: () => boolean } | undefined>;
    circleSourceShaders: Set<NativeShaderProgram>;
    circlePaintShaders: Set<NativeShaderProgram>;
    captureCircle: () => Promise<void>;
    circlePixels: Uint8Array;
    circleBaseline: Uint8Array;
    circleSamples: CircleSample[];
    circlePickPosition: { x: number; y: number };
    circleInitialPick: CirclePick;
  }
}

const tile = Buffer.from(fromGeojsonVt({
  ground: { features: [{ type: 3, geometry: [[[0, 0], [4096, 0], [4096, 4096], [0, 4096], [0, 0]]], tags: {} }] },
  points: { features: [{ id: 300, type: 1, geometry: [[2048, 2048]], tags: { name: 'circle' } }] },
}, { version: 2, extent: 4096 }));

for (const mode of ['3d', '2d', 'cv']) {
  test(`circle fill and stroke alpha preserve their separate color coverage in ${mode}`, async ({ page, renderUrl }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const style = {
      version: 8,
      transition: { duration: 0, delay: 0 },
      sources: { city: { type: 'vector', tiles: [`${renderUrl}/circle-compositing/{z}/{x}/{y}.pbf`], maxzoom: 14 } },
      layers: [
        { 'id': 'ground', 'type': 'fill', 'source': 'city', 'source-layer': 'ground', 'paint': { 'fill-color': '#000000', 'fill-antialias': false } },
        { 'id': 'points', 'type': 'circle', 'source': 'city', 'source-layer': 'points', 'paint': {
          'circle-color': '#00ff00',
          'circle-radius': 24,
          'circle-stroke-color': '#0000ff',
          'circle-stroke-width': 6,
        } },
      ],
    } satisfies StyleSpecification;
    await page.route('**/circle-compositing/**', route => route.request().url().endsWith('.pbf')
      ? route.fulfill({ body: tile, contentType: 'application/x-protobuf' })
      : route.fulfill({ json: style }));
    const query = new URLSearchParams({ mode, antialias: '0', atlas: '1', style: `${renderUrl}/circle-compositing/style.json` });
    await page.goto(`${renderUrl}/e2e/fixtures/render-fixture.html?${query}`);
    await expect.poll(() => page.evaluate(() => window.renderValidation?.tileset.tilesLoaded
      && window.renderValidation.tileset.stats().renderableTiles > 0), { timeout: 60_000 }).toBe(true);
    const initial = await page.evaluate(async () => {
      const { viewer, tileset, drawBatch, atlas } = window.renderValidation;
      const { scene, canvas } = viewer;
      scene.highDynamicRange = false;
      scene.gamma = 1;
      scene.postProcessStages.fxaa.enabled = false;
      scene.postProcessStages.bloom.enabled = false;
      scene.postProcessStages.ambientOcclusion.enabled = false;
      window.circleOwners = tileset._renderer.vector.tileIds.flatMap(tileId => tileset._renderer.vector.getTileCollections(tileId)
        .flatMap(collection => collection instanceof atlas.cesium.PrimitiveCollection
          ? Array.from({ length: collection.length }, (_, index) => collection.get(index))
          : [collection])
        .filter((collection): collection is CircleOwner => drawBatch(collection)?.kind === 'circle'));
      window.circleArrays = window.circleOwners.map(collection => collection._renderContext?.vertexArray ?? collection._vaf);
      window.circleSourceShaders = new Set(window.circleOwners.flatMap(collection => collection._renderContext
        ? [collection._renderContext.shaderProgram]
        : [collection._sp!, collection._spTranslucent!]));
      window.circlePaintShaders = new Set();
      window.captureCircle = async () => {
        for (let frame = 0; frame < 3; frame++) {
          await new Promise<void>((resolve) => {
            const remove = scene.postRender.addEventListener(() => {
              remove();
              window.circlePixels = scene.context.readPixels({ width: canvas.width, height: canvas.height });
              for (const command of scene._frameState.commandList) {
                if (window.circleOwners.includes(command.owner as CircleOwner))
                  window.circlePaintShaders.add(command.shaderProgram);
              }
              resolve();
            });
            scene.requestRender();
          });
        }
      };
      await window.captureCircle();
      window.circleBaseline = window.circlePixels;
      // Fully covered inner-edge pixels isolate the fill/stroke transition.
      // Each mode has its own Native AA and hence its own opaque reference.
      window.circleSamples = [];
      let black = 0;
      for (let index = 0; index < window.circleBaseline.length; index += 4) {
        const [r, g, b] = window.circleBaseline.subarray(index, index + 3);
        if (r <= 2 && g <= 2 && b <= 2)
          black++;
        if (r <= 2 && g >= 64 && g <= 191 && b >= 64 && b <= 191 && Math.abs(g + b - 255) <= 3)
          window.circleSamples.push({ index, green: g, blue: b });
      }
      const first = window.circleSamples[0];
      if (first) {
        const pixel = first.index / 4;
        window.circlePickPosition = {
          x: (pixel % canvas.width + 0.5) * canvas.clientWidth / canvas.width,
          y: (canvas.height - Math.floor(pixel / canvas.width) - 0.5) * canvas.clientHeight / canvas.height,
        };
        window.circleInitialPick = scene.pick(window.circlePickPosition) as CirclePick;
      }
      return {
        samples: window.circleSamples.length,
        black,
        owners: window.circleOwners.map(collection => collection.constructor.name),
        pick: tileset.pick(window.circleInitialPick.id ?? window.circleInitialPick),
      };
    });
    assert.ok(initial.samples >= 8, 'no opaque inner-edge coverage samples');
    assert.ok(initial.black > 1000, 'the reference did not draw a black ground');
    assert.ok(initial.owners.length > 0);
    assert.ok(initial.owners.every(name => name === (mode === '3d' ? 'BufferPointCollection' : 'PointPrimitiveCollection')));
    assert.equal(initial.pick?.properties.name, 'circle');
    const phases: CirclePhase[] = [];
    // Exact RGBA8 fractions avoid introducing alpha quantization into the reference.
    for (const [fill, stroke] of [[64 / 255, 192 / 255], [192 / 255, 64 / 255], [0, 1], [1, 0], [0, 0], [1, 1]]) {
      Object.assign((style.layers[1] as CircleLayerSpecification).paint!, { 'circle-opacity': fill, 'circle-stroke-opacity': stroke });
      await page.evaluate(style => window.renderValidation.tileset.setStyle(style), style);
      await expect.poll(() => page.evaluate(() => window.renderValidation.tileset.tilesLoaded)).toBe(true);
      const result = await page.evaluate(async ({ fill, stroke }) => {
        await window.captureCircle();
        const { viewer, renderErrors } = window.renderValidation;
        let greenError = 0;
        let blueError = 0;
        let worst: CircleWorstSample | undefined;
        for (const sample of window.circleSamples) {
          const green = window.circlePixels[sample.index + 1];
          const blue = window.circlePixels[sample.index + 2];
          const dg = Math.abs(green - sample.green * fill);
          const db = Math.abs(blue - sample.blue * stroke);
          if (!worst || Math.max(dg, db) > worst.error)
            worst = { ...sample, green, blue, expectedGreen: sample.green * fill, expectedBlue: sample.blue * stroke, error: Math.max(dg, db) };
          greenError = Math.max(greenError, dg);
          blueError = Math.max(blueError, db);
        }
        const pick = viewer.scene.pick(window.circlePickPosition);
        return {
          fill,
          stroke,
          greenError,
          blueError,
          worst,
          samePick: pick === window.circleInitialPick,
          pointPicked: (pick?.id ?? pick)?.layerId === 'points',
          stable: window.circleOwners.every(collection => !collection.isDestroyed()),
          arraysStable: window.circleOwners.every((collection, index) => (collection._renderContext?.vertexArray ?? collection._vaf) === window.circleArrays[index]),
          oldArraysReleased: window.circleArrays.every(array => array!.isDestroyed()),
          fps: viewer.scene.debugShowFramesPerSecond,
          renderErrors,
        };
      }, { fill, stroke });
      phases.push(result);
    }
    const lifecycle = await page.evaluate(async () => {
      const { viewer, tileset, renderErrors, atlas } = window.renderValidation;
      const sources = [...window.circleSourceShaders];
      const sourceIntact = sources.every(shader => !shader.fragmentShaderSource.sources.some(text => text.includes('cvt_circleColor')));
      viewer.scene.highDynamicRange = true;
      viewer.scene.gamma = 2.2;
      await window.captureCircle();
      const hdrPick = viewer.scene.pick(window.circlePickPosition) === window.circleInitialPick;
      viewer.scene.highDynamicRange = false;
      viewer.scene.gamma = 1;
      await window.captureCircle();
      const restored = window.circleSamples.every(sample => Math.abs(window.circlePixels[sample.index + 1] - sample.green) <= 3
        && Math.abs(window.circlePixels[sample.index + 2] - sample.blue) <= 3);
      const paint = [...window.circlePaintShaders];
      const derived = paint.every(shader => !window.circleSourceShaders.has(shader)
        && shader.fragmentShaderSource.sources.some(text => text.includes('cvt_circleColor')));
      const alive = [...sources, ...paint].every(shader => !shader.isDestroyed());
      viewer.scene.primitives.remove(tileset);
      const releaseCounts = sources.map(shader => shader._cachedShader.count);
      // Scene.initializeFrame purges released shaders every 120 frames.
      // Drive the real Scene lifecycle with the context still alive.
      for (let frame = 0; frame < 121 && [...sources, ...paint].some(shader => !shader.isDestroyed()); frame++) {
        await new Promise<void>((resolve) => {
          const remove = viewer.scene.postRender.addEventListener(() => {
            remove();
            resolve();
          });
          viewer.scene.requestRender();
        });
      }
      return {
        sources: sources.length,
        paint: paint.length,
        sourceIntact,
        hdrPick,
        restored,
        derived,
        alive,
        releaseCounts,
        released: [...sources, ...paint].every(shader => shader.isDestroyed()),
        ownersDestroyed: window.circleOwners.every(collection => collection instanceof atlas.cesium.BufferPointCollection
          ? !(collection as CircleOwner)._renderContext
          : collection.isDestroyed()),
        fps: viewer.scene.debugShowFramesPerSecond,
        logDepth: viewer.scene.logarithmicDepthBuffer,
        renderErrors,
      };
    });
    const output = testInfo.outputPath('circle-compositing.json');
    await writeFile(output, JSON.stringify({ mode, initial, phases, lifecycle, errors }, null, 2));
    await testInfo.attach('circle-compositing', { path: output, contentType: 'application/json' });
    for (const phase of phases) {
      assert.ok(phase.greenError <= 3 && phase.blueError <= 3, `inner-edge color mixed separate opacity: ${JSON.stringify(phase.worst)}`);
      assert.equal(phase.pointPicked, phase.fill > 0 || phase.stroke > 0);
      if (phase.pointPicked)
        assert.ok(phase.samePick);
      assert.ok(phase.stable && phase.fps);
      // Native PointPrimitiveCollection changes buffer usage after paint,
      // releases its old VAF and uploads the new one; BufferPoint keeps its VA.
      assert.ok(mode === '3d' ? phase.arraysStable : phase.arraysStable || phase.oldArraysReleased);
      assert.deepEqual(phase.renderErrors, []);
    }
    assert.ok(lifecycle.sources > 0 && lifecycle.paint > 0);
    assert.ok(lifecycle.sourceIntact && lifecycle.derived && lifecycle.alive);
    assert.ok(lifecycle.releaseCounts.every(count => count === 0));
    assert.ok(lifecycle.hdrPick && lifecycle.restored && lifecycle.released && lifecycle.ownersDestroyed && lifecycle.fps);
    assert.deepEqual(lifecycle.renderErrors, []);
    assert.deepEqual(errors, []);
  });
}
