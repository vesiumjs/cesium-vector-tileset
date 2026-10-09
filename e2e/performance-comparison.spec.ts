import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import process from 'node:process';
import { expect } from 'playwright/test';
import { fromGeojsonVt, test } from './fixtures';

interface PerformanceCombineTask {
  id: number;
  createTaskIds: number[];
  started: number;
  instances: number;
  bytes: number;
  attributes: string[];
  wallMs?: number;
  error?: unknown;
}
interface PerformanceCreateTask extends Omit<PerformanceCombineTask, 'attributes' | 'createTaskIds'> {
  transferredBuffers: number;
  createdBytes?: number;
}
type PerformanceMeasurement = Window['performanceMeasurement'];
type MeasuredRun = Awaited<ReturnType<PerformanceMeasurement['run']>>;
type ColdRun = PerformanceMeasurement['cold'] & { tasks: PerformanceCombineTask[]; createTasks: PerformanceCreateTask[] };
interface PerformanceRequest { url: string; phase: string; zoom: number; tileBytes: number }
interface RendererResult {
  index: number;
  renderer: string;
  requests: PerformanceRequest[];
  phases: Array<MeasuredRun & { summary: ReturnType<typeof summarize>['summary'] }>;
  cold?: ColdRun & { summary: ReturnType<typeof summarize>['summary'] };
  hardware?: PerformanceMeasurement['hardware'];
  projectionChecks?: Array<Awaited<ReturnType<PerformanceMeasurement['checkPose']>>>;
  warmed?: Awaited<ReturnType<PerformanceMeasurement['warm']>>;
  requestsByPhase?: Record<string, { total: number; uniqueTiles: number }>;
  requestsByZoom?: Record<number, { total: number; servedBytes: number }>;
  errors?: string[];
}
declare global { interface Window { performanceCombineTasks: PerformanceCombineTask[]; performanceCreateTasks: PerformanceCreateTask[] } }

// Reuse the deterministic vt-pbf encoder already owned by the browser fixture.
// The grid is anchored to global z14 coordinates. Underzoomed source tiles
// contain every reference cell they cover, preserving screen density across
// renderer-specific source LODs rather than repeating a different-sized city.
const extent = 4096;
const square = (x, y, size) => [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]];
function encodeTile(zoom) {
  const children = 2 ** (14 - zoom);
  const parcels = [];
  const roads = [];
  for (let childY = 0; childY < children; childY++) {
    for (let childX = 0; childX < children; childX++) {
      for (let index = 0; index < 1024; index++) {
        parcels.push({
          type: 3,
          geometry: square((childX * extent + index % 32 * 128 + 8) / children, (childY * extent + Math.floor(index / 32) * 128 + 8) / children, 104 / children),
          tags: { index },
        });
      }
      for (let index = 0; index < 128; index++) {
        roads.push({
          type: 2,
          geometry: [Array.from({ length: 33 }, (_, segment) => {
            const position = (index % 64 + 0.5) * 64;
            const bend = Math.sin(segment * Math.PI / 4) * 4;
            const [x, y] = index < 64 ? [segment * 128, position + bend] : [position + bend, segment * 128];
            return [(childX * extent + x) / children, (childY * extent + y) / children];
          })],
          tags: { index },
        });
      }
    }
  }
  return fromGeojsonVt({
    ground: { features: [{ type: 3, geometry: square(0, 0, extent), tags: {} }] },
    parcels: { features: parcels },
    roads: { features: roads },
  }, { version: 2, extent });
}
// Encoding occurs before either renderer starts; route callbacks only serve
// cached bytes. Each level repeats at an integer number of global z14 tiles.
const tiles = new Map([12, 13, 14].map(zoom => [zoom, Buffer.from(encodeTile(zoom))]));

function distribution(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { count: sorted.length, total: sorted.reduce((sum, value) => sum + value, 0), p50: sorted[Math.floor(sorted.length * 0.5)] ?? null, p95: sorted[Math.floor(sorted.length * 0.95)] ?? null, max: sorted.at(-1) ?? null };
}

function summarize<Run extends { frames: PerformanceMeasurement['cold']['frames'] }>(run: Run) {
  const frames = run.frames;
  const stages = [...new Set(frames.flatMap(frame => Object.keys(frame.stages)))];
  return {
    ...run,
    summary: {
      renderedFrames: frames.length,
      cpuMs: distribution(frames.map(frame => frame.cpuMs)),
      stageCpuMs: Object.fromEntries(stages.map(stage => [stage, distribution(frames.map(frame => frame.stages[stage] ?? 0))])),
      // Render start intervals include scheduling, browser and GPU backpressure.
      // Neither this nor pre/postRender latency is a GPU duration measurement.
      actualFrameIntervalsMs: distribution(frames.slice(1).map((frame, index) => frame.time - frames[index].time)),
      drawCalls: distribution(frames.map(frame => frame.drawCalls)),
      submittedVertexInvocations: distribution(frames.map(frame => frame.submittedVertices)),
      liveBufferCapacityBytes: distribution(frames.map(frame => frame.bufferBytes)),
      uploadCalls: distribution(frames.map(frame => frame.uploads)),
      uploadedBufferBytes: distribution(frames.map(frame => frame.uploadedBytes)),
    },
  };
}

const hardwareGpu = process.env.E2E_PERF_GPU === '1';
const smoke = process.env.E2E_PERF_SMOKE === '1';
const roundCaps = process.env.E2E_PERF_ROUND_CAPS === '1';
test.use({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
  launchOptions: { args: hardwareGpu
    ? ['--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan', '--disable-vulkan-surface']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
});

test('local MVT renderer performance comparison @performance', async ({ browser, renderUrl }, testInfo) => {
  test.skip(process.env.E2E_PERFORMANCE !== '1', 'Opt in to the sequential renderer measurement with E2E_PERFORMANCE=1');
  test.setTimeout(600_000);
  const style = {
    version: 8,
    transition: { duration: 0, delay: 0 },
    sources: { city: { type: 'vector', tiles: [`${renderUrl}/performance-local/{z}/{x}/{y}.pbf`], minzoom: 12, maxzoom: 14 } },
    layers: [
      { 'id': 'ground', 'type': 'fill', 'source': 'city', 'source-layer': 'ground', 'paint': { 'fill-color': '#263344', 'fill-antialias': false } },
      { 'id': 'parcels', 'type': 'fill', 'source': 'city', 'source-layer': 'parcels', 'paint': { 'fill-color': '#8c9fbc', 'fill-antialias': false } },
      { 'id': 'roads', 'type': 'line', 'source': 'city', 'source-layer': 'roads', 'layout': { 'line-cap': roundCaps ? 'round' : 'butt', 'line-join': 'miter' }, 'paint': { 'line-color': '#ffffff', 'line-width': 3 } },
    ],
  };
  const report = {
    methodology: {
      rendererOrder: smoke ? ['cesium', 'maplibre'] : ['cesium', 'maplibre', 'maplibre', 'cesium'],
      lineCap: roundCaps ? 'round' : 'butt',
      smoke,
      path: { origin: [-0.1276, 51.5072], mapZoom: 14, zoomAmplitude: 0.35, longitudeAmplitude: 0.04, latitudeAmplitude: 0.013 },
      view: 'Cesium SCENE2D orthographic and MapLibre Mercator, pitch 0, bearing 0. This is a planar top-down city load; it does not compare tilted 3D rendering.',
      viewport: [1280, 720],
      dpr: 1,
      warm: 'Full 360-step closed geographic pan/zoom path, wait for loaded source tiles and geometry at every twelfth position, then return to origin. Every measured run starts after twelve loaded animation frames. Any cache eviction or continuing work during measurement remains visible in request/upload counters.',
      workload: 'Stationary: 180 animation steps. Slow/fast: the same closed geographic pan/zoom path in 360/120 animation steps. Paths advance per requestAnimationFrame; walltime is measured, not presumed fixed.',
      frameCpu: 'Main-thread synchronous Cesium Scene.render / MapLibre Map._render inclusive duration. Camera driver CPU is separate. Worker parsing, asynchronous loading, browser compositor and GPU completion are excluded.',
      stageCpu: 'Nested inclusive owner method durations, measured only inside the whole frame; stages must not be summed. Engine stages have different responsibilities.',
      frameIntervals: 'Actual renderer start intervals include browser scheduling and GPU backpressure; they are not GPU time or a fixed refresh-rate FPS guarantee.',
      commands: 'Context drawElements/drawArrays/instanced calls include globe/background and clipping work. Submitted vertex invocations count index/vertex submissions with instances, not distinct geometry vertices. Cesium stats.submittedCommands is a separate pre-frustum tileset counter.',
      memory: 'Common live WebGL bufferData capacity tracked by each target binding until deleteBuffer, including renderer baseline buffers and uniform buffers. Every tracked allocation is checked against getBufferParameter(BUFFER_SIZE) outside measured frames. Excludes texture storage, worker/CPU heap, driver overhead and actual VRAM residency. Cesium gpuMemory is its mixed library budget: Native Primitive VA buffers are captured once after upload, while collection capacities and other resource inputs are reserved separately. It excludes Native batch-table textures and remains distinct from this common context buffer counter.',
      overhead: 'Both runs use identical instance WebGL hooks and frame wrappers. Cesium stage hooks and native FPS panel add instrumentation overhead; no readPixels, screenshots or geometry traversal run inside the measured frame.',
      rendering: 'Continuous rendering enabled in both engines even for stationary runs; loading/readiness polling, shader/module compilation and screenshots are outside timings. Source tile selection and geometry are engine-specific and are reported rather than forced equal.',
      geographicLoad: 'Same globally anchored z14 parcel/road grid in z12/13/14 MVT. A z13 payload contains 4 reference tiles and z12 contains 16. Coarser native LOD can parse/upload more offscreen geometry; that cost is retained. MVT integer quantization changes curves by at most a subpixel at these views.',
      spatialEvidence: 'Geographic parcel centers must classify as parcel color. Road center vertices must find white within one framebuffer pixel, allowing raster edge AA. Samples cover a fixed global reference grid and catch the earlier doubled/halved screen density. Aggregate fractions and screenshots are retained.',
      gpuRequested: hardwareGpu ? 'hardware ANGLE Vulkan; reject known software renderers and retain the actual renderer string' : 'software SwiftShader; do not generalize this result to hardware GPU throughput',
      cpuThrottleRate: Number(process.env.E2E_CPU_RATE ?? 1),
      performanceThresholds: 'None. Assertions validate load, errors, projection equivalence and real draw submissions only.',
      cold: 'Initial renderer setup through loaded tiles and twelve stable frames, before path checks or warming. Walltime includes module/setup/network/compilation and settling. Scene/Map frame CPU and Nested Native pack/unpack calls are reported separately. unpackAndAttributePacking correlates the actual first returned geometry from Native unpack through line bounds, all layout packing and createAttributeLocations in its async main-thread continuation, outside Scene.render; subsequent state assignment is excluded. Create and combine task walls are observed separately, each starting just before its postMessage and including queue, Worker startup, execution, clone/transfer and main-thread delivery. They exclude input preparation/admission before postMessage and are not Worker CPU time. Main packCreateGeometryResults must remain absent; create source buffers must be cloned, and the original Native packed results are transferred to combine. Create bytes sum attribute/index view lengths per geometry occurrence; they do not measure deduplicated clone backing storage or wire payload.',
    },
    fixture: {
      extent,
      referenceZoom: 14,
      verticesPerRoad: 33,
      levels: [...tiles].map(([zoom, bytes]) => ({ zoom, polygonsPerTile: 1 + 1024 * 4 ** (14 - zoom), roadsPerTile: 128 * 4 ** (14 - zoom), tileBytes: bytes.byteLength, tileSha256: createHash('sha256').update(bytes).digest('hex') })),
      style,
    },
    browser: browser.version(),
    runs: [] as RendererResult[],
  };
  try {
    // ABBA reduces a consistent first/last-run thermal or browser-order bias.
    // Each context/page is destroyed before the next renderer starts.
    for (const [index, renderer] of report.methodology.rendererOrder.entries()) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      if (process.env.E2E_CPU_RATE) {
        const session = await context.newCDPSession(page);
        await session.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.E2E_CPU_RATE) });
      }
      const errors = [];
      const externalRequests = [];
      const requests: PerformanceRequest[] = [];
      await page.addInitScript(() => {
        window.performanceCombineTasks = [];
        window.performanceCreateTasks = [];
        const createdResults = new WeakMap<object, PerformanceCreateTask>();
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          measuredTasks = new Map<number, PerformanceCombineTask | PerformanceCreateTask>();

          constructor(...args: ConstructorParameters<typeof Worker>) {
            super(...args);
            this.measuredTasks = new Map();
            this.addEventListener('message', (event) => {
              const task = this.measuredTasks.get(event.data?.id);
              if (task) {
                task.wallMs = performance.now() - task.started;
                task.error = event.data.error ?? null;
                if ('transferredBuffers' in task) {
                  task.createdBytes = event.data.result?.packedData?.byteLength;
                  if (event.data.result?.packedData)
                    createdResults.set(event.data.result.packedData.buffer, task);
                }
                this.measuredTasks.delete(event.data.id);
              }
            });
          }

          postMessage(message: { id: number; parameters?: { subTasks?: Array<{ geometry: { attributes: Record<string, { values: { byteLength: number } } | undefined>; indices?: { byteLength: number } } }>; packedInstances?: Float64Array; createGeometryResults?: Array<{ packedData: Float64Array; stringTable: string[] }> } }, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
            const parameters = message?.parameters;
            if (parameters?.subTasks) {
              const task: PerformanceCreateTask = {
                id: message.id,
                started: performance.now(),
                instances: parameters.subTasks.length,
                bytes: parameters.subTasks.reduce((sum, { geometry }) => sum + (geometry.indices?.byteLength ?? 0) + Object.values(geometry.attributes).reduce((bytes, attribute) => bytes + (attribute?.values.byteLength ?? 0), 0), 0),
                transferredBuffers: Array.isArray(transferOrOptions) ? transferOrOptions.length : transferOrOptions?.transfer?.length ?? 0,
              };
              this.measuredTasks.set(task.id, task);
              window.performanceCreateTasks.push(task);
            }
            if (parameters?.packedInstances && parameters.createGeometryResults) {
              const task: PerformanceCombineTask = {
                id: message.id,
                // Native TaskProcessor IDs belong to their processor. Match
                // each create chunk by its actual returned buffer instead.
                createTaskIds: parameters.createGeometryResults.map((result) => {
                  const created = createdResults.get(result.packedData.buffer);
                  if (!created)
                    throw new Error('Native combine input has no observed create result');
                  return created.id;
                }),
                started: performance.now(),
                instances: parameters.packedInstances[0],
                bytes: parameters.packedInstances.byteLength + parameters.createGeometryResults.reduce((sum, item) => sum + item.packedData.byteLength, 0),
                attributes: parameters.createGeometryResults[0].stringTable,
              };
              this.measuredTasks.set(task.id, task);
              window.performanceCombineTasks.push(task);
            }
            return Array.isArray(transferOrOptions) ? super.postMessage(message, transferOrOptions) : super.postMessage(message, transferOrOptions);
          }
        };
      });
      let pagePhase = 'initial';
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(renderUrl).origin) {
          externalRequests.push(url.href);
          return route.abort();
        }
        if (url.href === `${renderUrl}/performance-local/style.json`)
          return route.fulfill({ json: style });
        if (url.href.startsWith(`${renderUrl}/performance-local/`) && url.pathname.endsWith('.pbf')) {
          const zoom = Number(url.pathname.match(/\/(\d+)\/\d+\/\d+\.pbf$/)![1]);
          const bytes = tiles.get(zoom);
          requests.push({ url: url.href, phase: pagePhase, zoom, tileBytes: bytes?.byteLength ?? 0 });
          if (!bytes) {
            errors.push(`Unexpected source zoom ${zoom}; fixture only contains z12/13/14`);
            return route.fulfill({ status: 400, body: 'Unsupported fixture source zoom' });
          }
          return route.fulfill({ body: bytes, contentType: 'application/x-protobuf' });
        }
        return route.continue();
      });
      const result: RendererResult = { index, renderer, requests, phases: [] };
      report.runs.push(result);
      try {
        await page.goto(`${renderUrl}/e2e/fixtures/performance-fixture.html?renderer=${renderer}`);
        await expect.poll(() => page.evaluate(() => !!window.performanceMeasurement), { timeout: 60_000 }).toBe(true);
        result.cold = summarize(await page.evaluate(() => ({ ...window.performanceMeasurement.cold, tasks: window.performanceCombineTasks, createTasks: window.performanceCreateTasks })));
        assert.ok(result.cold.frames.length > 0, `${renderer} has no observed cold frames`);
        if (renderer === 'cesium') {
          assert.equal(result.cold.nativePacking.filter(call => call.method === 'packCreateGeometryResults').length, 0, 'Native Geometry packing ran on the main thread');
          assert.ok(result.cold.nativePacking.some(call => call.method === 'packCombineGeometryParameters'), 'Native instance metadata packing was not observed');
          assert.deepEqual(result.cold.createTasks.map(task => task.id).sort(), result.cold.tasks.flatMap(task => task.createTaskIds).sort(), 'Native cold create and combine task chains differ');
          assert.ok(result.cold.createTasks.length > 0 && result.cold.createTasks.every(task => Number.isFinite(task.wallMs) && task.error === null && task.transferredBuffers === 0 && (task.createdBytes ?? 0) > 0), 'Native cold create did not clone and pack Geometry in its Worker');
          for (const task of result.cold.tasks)
            assert.equal(result.cold.createTasks.filter(created => task.createTaskIds.includes(created.id)).reduce((sum, created) => sum + created.instances, 0), task.instances, 'Native cold create pieces changed the combined instance count');
          assert.equal(result.cold.nativePacking.filter(call => call.method === 'unpackAndAttributePacking').length, result.cold.nativePacking.filter(call => call.method === 'unpackCombineGeometryResults').length, 'Native cold async attribute packing was not observed for every result');
          assert.ok(result.cold.tasks.length > 0 && result.cold.tasks.every(task => Number.isFinite(task.wallMs) && task.error === null), 'Native cold Worker task did not settle');
        }
        result.hardware = await page.evaluate(() => window.performanceMeasurement.hardware);
        if (hardwareGpu)
          assert.doesNotMatch(result.hardware.renderer, /swiftshader|llvmpipe|softpipe|software rasterizer/i, 'the hardware run selected a software renderer');
        assert.deepEqual(result.hardware.framebuffer, [1280, 720]);
        pagePhase = 'projection-check';
        result.projectionChecks = [];
        for (const progress of [0, 0.25, 0.5, 0.75])
          result.projectionChecks.push(await page.evaluate(progress => window.performanceMeasurement.checkPose(progress), progress));
        pagePhase = 'warm';
        result.warmed = await page.evaluate(steps => window.performanceMeasurement.warm(steps), smoke ? 60 : 360);
        const buffers = result.warmed.resources.buffers;
        assert.ok(buffers.rows.length > 0 && buffers.bytes > 0, `${renderer} has no attributed uploaded tile buffers`);
        assert.equal(buffers.bytes + buffers.unattributedBytes, result.warmed.bufferBytes, `${renderer} tile buffer snapshot differs from the actual WebGL capacity`);
        if (renderer === 'maplibre') {
          assert.ok((result.warmed.resources as Extract<typeof result.warmed.resources, { buckets: number }>).indexTriangles > 0, 'MapLibre has no logical triangle indices');
          assert.equal(buffers.rows.reduce((bytes, row) => bytes + (row as Extract<typeof row, { assignedBytes: number }>).assignedBytes, 0), buffers.bytes, 'MapLibre shared buffers were counted more than once');
        }
        else {
          assert.ok((buffers as Extract<typeof buffers, { geometryTextures: object }>).geometryTextures.rows.length > 0 && (buffers as Extract<typeof buffers, { geometryTextures: object }>).geometryTextures.bytes > 0, 'Native immutable line textures were not attributed');
          assert.ok((buffers as Extract<typeof buffers, { geometryTextures: object }>).geometryTextures.rows.every(row => row.uploads.length === 1), 'immutable line positions were uploaded repeatedly');
        }
        assert.ok(result.warmed.pixelEvidence.parcelFraction > 0.05, `${renderer} did not visibly render the parcel load`);
        assert.ok(result.warmed.pixelEvidence.roadFraction > 0.005, `${renderer} did not visibly render the road load`);
        await page.screenshot({ path: testInfo.outputPath(`${index}-${renderer}-warmed.png`) });
        for (const [name, steps] of smoke ? [] : [['stationary', 180], ['slow', 360], ['fast', 120]] as Array<['stationary' | 'slow' | 'fast', number]>) {
          pagePhase = name;
          const measured = await page.evaluate(({ name, steps }) => window.performanceMeasurement.run(name, steps), { name, steps });
          result.phases.push(summarize(measured));
          assert.ok(measured.frames.length > 0, `${renderer}/${name} produced no measured frames`);
          assert.ok(measured.frames.every(frame => frame.drawCalls > 0), `${renderer}/${name} produced a frame without draw submissions`);
          assert.ok(measured.frames.every(frame => frame.bufferBytes > 0), `${renderer}/${name} had no uploaded geometry buffers`);
          if (renderer === 'cesium') {
            assert.ok((measured.resources as Extract<typeof measured.resources, { stats: object }>).stats.renderableTiles > 0, 'Cesium has no renderable source tiles');
            assert.ok((measured.resources as Extract<typeof measured.resources, { stats: object }>).stats.submittedCommands > 0, 'Cesium MVT submitted no commands');
            assert.ok((measured.resources as Extract<typeof measured.resources, { stats: object }>).buffers.geometryTextures.rows.every(row => row.uploads.length === 1
              && !row.uploads.some(upload => ['stationary', 'slow', 'fast'].includes(upload.phase))), 'measured frames reuploaded immutable line positions');
          }
          else {
            assert.ok((measured.resources as Extract<typeof measured.resources, { buckets: number }>).buckets > 0 && (measured.resources as Extract<typeof measured.resources, { buckets: number }>).layoutVertices > 0, 'MapLibre has no uploaded MVT geometry');
          }
        }
        result.requestsByPhase = Object.fromEntries([...new Set(requests.map(request => request.phase))].map(phase => [phase, { total: requests.filter(request => request.phase === phase).length, uniqueTiles: new Set(requests.filter(request => request.phase === phase).map(request => request.url)).size }]));
        result.requestsByZoom = Object.fromEntries([12, 13, 14].map(zoom => [zoom, { total: requests.filter(request => request.zoom === zoom).length, servedBytes: requests.filter(request => request.zoom === zoom).reduce((total, request) => total + request.tileBytes, 0) }]));
        result.errors = [...errors, ...await page.evaluate(() => window.performanceMeasurement.errors)];
        assert.ok(requests.length > 0, `${renderer} never requested fixture MVT`);
        assert.deepEqual(result.errors, []);
        assert.deepEqual(externalRequests, [], 'benchmark must not depend on external tiles, assets or keys');
        await page.evaluate(() => window.performanceMeasurement.destroy());
      }
      finally {
        await context.close();
      }
    }
    const reference = report.runs.find(run => run.renderer === 'maplibre');
    for (const run of report.runs) {
      assert.equal(run.hardware.renderer, reference.hardware.renderer, 'renderer runs used different GPUs');
      const probes = run.warmed.pixelEvidence.probes;
      const referenceProbes = reference.warmed.pixelEvidence.probes;
      assert.equal(probes.length, referenceProbes.length, 'geographic geometry sample count differs');
      for (const [index, probe] of probes.entries()) {
        assert.deepEqual(probe.geographic, referenceProbes[index].geographic, 'spatial comparison sampled different coordinates');
        assert.ok(probe.matches, `${run.renderer} ${probe.kind} probe failed at ${probe.geographic}`);
        assert.equal(probe.matches, referenceProbes[index].matches, 'geographic parcel/road distribution differs');
      }
      for (const [index, check] of run.projectionChecks.entries()) {
        const expected = reference.projectionChecks[index];
        assert.ok(Math.abs(check.resources.zoom - expected.resources.zoom) < 0.001, `mapZoom mismatch at path checkpoint ${index}`);
        for (let corner = 0; corner < 2; corner++) {
          for (let axis = 0; axis < 2; axis++)
            assert.ok(Math.abs(check.footprint[corner][axis] - expected.footprint[corner][axis]) < 0.00001, `footprint mismatch at path checkpoint ${index}`);
        }
        for (const [landmark, sample] of check.projections.entries()) {
          const pixel = expected.projections[landmark].pixel;
          const errorPixels = Math.hypot(sample.pixel[0] - pixel[0], sample.pixel[1] - pixel[1]);
          assert.ok(errorPixels <= 1, `projected landmark differs by ${errorPixels}px at path checkpoint ${index}`);
        }
      }
    }
  }
  finally {
    const output = testInfo.outputPath('performance-comparison.json');
    await writeFile(output, JSON.stringify(report, null, 2));
    await testInfo.attach('performance-comparison', { path: output, contentType: 'application/json' });
  }
});
