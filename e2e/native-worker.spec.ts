import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { test } from './fixtures';

export interface NativeWorkerTask {
  id: number;
  state: 'pending' | 'rejected' | 'resolved';
  transferredBefore: number[];
  transferredAfter?: number[];
  createdBytes?: number;
  createdCount?: number;
  inputCount?: number;
  inputBytes?: number;
  createResultCounts?: number[];
}

export interface NativeWorkerObservation {
  url: string;
  stage?: 'create' | 'combine' | 'probe';
  probe?: { transferredBefore: number[]; transferredAfter: number[]; returnedValue?: number };
  tasks: NativeWorkerTask[];
  errors: Array<{ type: string; message: string }>;
  terminated: number;
}

export interface NativeWorkerBlob {
  url: string;
  revoked: boolean;
}

for (const scenario of ['normal', 'cdn', 'missing-create', 'missing-combine']) {
  test(`Native create and combine Worker lifecycle: ${scenario}`, async ({ page, renderUrl }, testInfo) => {
    const responses = [];
    const errors = [];
    let probeRequests = 0;
    page.context().on('response', response => responses.push({ url: response.url(), status: response.status() }));
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      const createObjectURL = URL.createObjectURL;
      const revokeObjectURL = URL.revokeObjectURL;
      window.nativeWorkers = [];
      window.nativeWorkerBlobs = [];
      URL.createObjectURL = function (blob) {
        const url = Reflect.apply(createObjectURL, this, [blob]);
        window.nativeWorkerBlobs.push({ url, revoked: false });
        return url;
      };
      URL.revokeObjectURL = function (url) {
        const blob = window.nativeWorkerBlobs.find(blob => blob.url === url);
        if (blob)
          blob.revoked = true;
        return Reflect.apply(revokeObjectURL, this, [url]);
      };
      // Observe real browser transfer and errors without changing their delivery.
      window.Worker = class extends NativeWorker {
        observation: NativeWorkerObservation;

        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          const workerUrl = String(url);
          this.observation = {
            url: workerUrl,
            stage: workerUrl.endsWith('/createGeometry.js') ? 'create' : workerUrl.endsWith('/combineGeometry.js') ? 'combine' : undefined,
            tasks: [],
            errors: [],
            terminated: 0,
          };
          window.nativeWorkers.push(this.observation);
          this.addEventListener('error', event => this.observation.errors.push({ type: event.type, message: event.message ?? '' }));
          this.addEventListener('message', (event) => {
            if (this.observation.probe)
              this.observation.probe.returnedValue = event.data.array?.[0];
            const task = this.observation.tasks.find(task => task.id === event.data.id && task.state === 'pending');
            if (task) {
              task.state = event.data.error !== undefined && event.data.error !== null ? 'rejected' : 'resolved';
              task.createdBytes = event.data.result?.packedData?.byteLength;
              task.createdCount = event.data.result?.packedData?.[0];
            }
          });
        }

        postMessage(message: { id?: number; parameters?: object; array?: Int8Array }, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
          const transfers = (Array.isArray(transferOrOptions) ? transferOrOptions : transferOrOptions?.transfer ?? []) as ArrayBuffer[];
          const parameters = message.parameters as {
            subTasks?: Array<{ geometry: { attributes: Record<string, { values: { byteLength: number } }>; indices: { byteLength: number } } }>;
            createGeometryResults?: Array<{ packedData: Float64Array }>;
          };
          this.observation.stage = message.parameters ? ('subTasks' in message.parameters ? 'create' : 'combine') : 'probe';
          if (this.observation.stage === 'probe')
            this.observation.probe = { transferredBefore: transfers.map(buffer => buffer.byteLength), transferredAfter: [] };
          const task: NativeWorkerTask = message.parameters && {
            id: message.id!,
            state: 'pending',
            transferredBefore: transfers.map(buffer => buffer.byteLength),
            inputCount: parameters.subTasks?.length,
            inputBytes: parameters.subTasks?.reduce((bytes, { geometry }) => bytes
              + Object.values(geometry.attributes).reduce((total, attribute) => total + attribute.values.byteLength, 0)
              + geometry.indices.byteLength, 0),
            createResultCounts: parameters.createGeometryResults?.map(result => result.packedData[0]),
          };
          super.postMessage(message, transfers);
          if (this.observation.probe)
            this.observation.probe.transferredAfter = transfers.map(buffer => buffer.byteLength);
          if (task) {
            task.transferredAfter = transfers.map(buffer => buffer.byteLength);
            this.observation.tasks.push(task);
          }
        }

        terminate() {
          this.observation.terminated++;
          super.terminate();
        }
      };
    });
    await page.route('**/transferTypedArrayTest.js', (route) => {
      probeRequests++;
      return route.continue();
    });
    if (scenario === 'missing-combine')
      await page.route('**/Workers/combineGeometry.js', route => route.fulfill({ status: 404, body: 'Missing combine Worker' }));
    if (scenario === 'missing-create')
      await page.route('**/Workers/createGeometry.js', route => route.fulfill({ status: 404, body: 'Missing create Worker' }));
    const query = new URLSearchParams();
    if (scenario === 'cdn') {
      const baseUrl = new URL('/cesiumStatic/', renderUrl);
      baseUrl.hostname = 'localhost';
      query.set('cesiumBaseUrl', baseUrl.href);
    }
    try {
      await page.goto(`${renderUrl}/e2e/fixtures/native-worker-fixture.html?${query}`);
      await page.waitForFunction(() => window.nativeWorkerFixture);
      const admitted = await page.evaluate(() => window.nativeWorkerFixture.start());
      assert.deepEqual(admitted.states.map(state => state.state), ['COMBINING', 'COMBINING', 'READY']);

      const missing = scenario.startsWith('missing-');
      const state = missing ? 'FAILED' : 'COMBINED';
      await expect.poll(() => page.evaluate(expected => window.nativeWorkerFixture.snapshot().states.filter(state => state.state === expected).length, state), { timeout: 5000 }).toBe(2);
      assert.equal(admitted.mainPackCalls, 0, 'main update serialized Geometry before the create Worker replied');
      await page.evaluate(() => window.nativeWorkerFixture.update());
      await expect.poll(() => page.evaluate(expected => window.nativeWorkerFixture.snapshot().states.filter(state => state.state === expected).length, state), { timeout: 5000 }).toBe(3);
      await expect.poll(() => page.evaluate(() => window.nativeWorkerFixture.snapshot().transferProbePending)).toBe(false);
      const beforeDestroy = await page.evaluate(() => window.nativeWorkerFixture.snapshot());
      await page.evaluate(() => window.nativeWorkerFixture.destroy());
      const afterDestroy = await page.evaluate(() => window.nativeWorkerFixture.snapshot());
      const artifact = testInfo.outputPath('native-worker.json');
      await writeFile(artifact, JSON.stringify({ scenario, admitted, beforeDestroy, afterDestroy, responses, probeRequests, errors }, null, 2));
      await testInfo.attach('native-worker', { path: artifact, contentType: 'application/json' });

      const geometryWorkers = beforeDestroy.workers.filter(worker => worker.stage !== 'probe');
      const probes = beforeDestroy.workers.filter(worker => worker.stage === 'probe');
      const geometryWorkerUrls = new Set(geometryWorkers.map(worker => worker.url));
      const geometryBlobs = beforeDestroy.blobs.filter(blob => geometryWorkerUrls.has(blob.url));
      const destroyedGeometryBlobs = afterDestroy.blobs.filter(blob => geometryWorkerUrls.has(blob.url));
      assert.equal(probeRequests, 1, 'Native transfer capability was not tested through its deployed asset');
      assert.ok(responses.some(response => response.url.endsWith('/transferTypedArrayTest.js') && response.status === 200), 'Native transfer probe asset was unavailable');
      assert.equal(beforeDestroy.transferProbePending, false);
      assert.equal(probes.length, 1);
      assert.equal(probes[0].terminated, 1, 'Native transfer probe did not terminate after its reply');
      assert.deepEqual(probes[0].probe, { transferredBefore: [1], transferredAfter: [0], returnedValue: 99 });
      assert.equal(geometryWorkers.length, scenario === 'missing-create' ? 1 : 2, 'context created duplicate geometry stage Workers');
      assert.equal(beforeDestroy.inputBytes, admitted.inputBytes, 'transfer detached the shared source geometry');
      assert.deepEqual(beforeDestroy.inputValues, admitted.inputValues, 'Native Worker mutated the shared source coordinates');
      assert.deepEqual(beforeDestroy.inputIndices, admitted.inputIndices, 'Native Worker mutated the shared source indices');
      assert.equal(beforeDestroy.mainPackCalls, 0, 'Native create serializer ran in the main isolate');
      assert.ok(afterDestroy.states.every(state => state.destroyed));
      assert.ok(afterDestroy.workers.every(worker => worker.terminated === 1), 'last owner did not terminate each stage Worker exactly once');
      const create = geometryWorkers.find(worker => worker.stage === 'create');
      const combine = geometryWorkers.find(worker => worker.stage === 'combine');
      assert.ok(create);
      if (missing) {
        assert.ok(geometryWorkers.every(worker => worker.terminated === 1), 'fatal Worker failure remained alive');
        assert.equal(geometryWorkers.flatMap(worker => worker.errors).length, 1);
        assert.ok(beforeDestroy.states.every(state => state.error.length > 0));
        assert.ok(responses.some(response => response.url.includes(`/Workers/${scenario === 'missing-create' ? 'createGeometry' : 'combineGeometry'}.js`) && response.status === 404));
      }
      else {
        assert.ok(combine);
        assert.ok(geometryWorkers.every(worker => worker.terminated === 0 && worker.errors.length === 0));
        assert.deepEqual(errors, []);
        assert.equal(create.tasks.length, 6);
        assert.equal(combine.tasks.length, 3);
        assert.deepEqual(create.tasks.map(task => task.id), [0, 1, 2, 3, 4, 5], 'Native create task IDs did not advance');
        assert.deepEqual(combine.tasks.map(task => task.id), [0, 1, 2], 'Native combine task IDs did not advance');
        assert.ok(create.tasks.every(task => task.state === 'resolved' && task.transferredBefore.length === 0 && (task.createdBytes ?? 0) > 0), 'create did not clone input and return a new Native packed buffer');
        assert.equal(create.tasks.filter(task => task.inputCount === 512).length, 3);
        assert.equal(create.tasks.filter(task => task.inputCount === 1).length, 3);
        assert.ok(create.tasks.every(task => task.createdCount === task.inputCount && (task.inputBytes ?? Infinity) <= 512 * 1024), 'Native create lost an input instance or exceeded its fragment budget');
        assert.ok(combine.tasks.every(task => JSON.stringify(task.createResultCounts) === '[512,1]'), 'combine did not receive both stock create results in order');
        assert.ok(beforeDestroy.instanceIds.every(ids => JSON.stringify(ids) === JSON.stringify(Array.from({ length: 513 }, (_, index) => `feature-${index}`))), 'fragmenting changed Native instance IDs');
        assert.ok(combine.tasks.every(task => task.state === 'resolved'
          && task.transferredBefore.length > 0
          && task.transferredBefore.every(bytes => bytes > 0)
          && task.transferredAfter?.length === task.transferredBefore.length
          && task.transferredAfter.every(bytes => bytes === 0)), 'Native inputs were not actually transferred');
        assert.ok(['createGeometry', 'combineGeometry'].every(stage => responses.some(response => response.url.includes(`/Workers/${stage}.js`) && response.status === 200)));
      }
      if (scenario === 'cdn') {
        assert.ok(geometryWorkers.every(worker => worker.url.startsWith('blob:')), 'CDN Workers did not use local module bootstraps');
        assert.equal(geometryBlobs.length, 2);
        assert.ok(geometryBlobs.every(blob => !blob.revoked));
        assert.ok(destroyedGeometryBlobs.every(blob => blob.revoked), 'last owner retained a bootstrap URL');
        assert.ok(['createGeometry', 'combineGeometry'].every(stage => responses.some(response => new URL(response.url).hostname === 'localhost'
          && response.url.includes(`/Workers/${stage}.js`) && response.status === 200)));
      }
      else {
        assert.equal(geometryBlobs.length, 0);
      }
    }
    catch (error) {
      const snapshot = await page.evaluate(() => window.nativeWorkerFixture?.snapshot());
      const artifact = testInfo.outputPath('native-worker-error.json');
      await writeFile(artifact, JSON.stringify({ scenario, snapshot, responses, probeRequests, errors }, null, 2));
      await testInfo.attach('native-worker-error', { path: artifact, contentType: 'application/json' });
      throw error;
    }
    finally {
      await page.evaluate(() => window.nativeWorkerFixture?.finish());
    }
  });
}
