import type { GeometryPrepareBatchRequest, GeometryPrepareBatchResult } from '../packages/cesium-vector-tileset/src/render/geometry/geometry-preparation';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { test } from './fixtures';

export interface NativeWorkerTask {
  id: number;
  state: 'pending' | 'held' | 'rejected' | 'resolved' | 'aborted';
  transferredBefore: number[];
  transferredAfter?: number[];
  inputBytes: number;
  requestCounts: number[];
  nativeInstanceCounts: number[];
  lineInputCounts: number[];
  resultCount?: number;
  outputBytes?: number;
  nativeGeometryCounts?: number[];
  lineTextureBytes?: number[];
  lineBoundsCounts?: number[];
}

export interface NativeWorkerObservation {
  url: string;
  stage?: 'geometry' | 'probe';
  probe?: { transferredBefore: number[]; transferredAfter: number[]; returnedValue?: number };
  tasks: NativeWorkerTask[];
  errors: Array<{ type: string; message: string }>;
  terminated: number;
}

export interface NativeWorkerBlob {
  url: string;
  revoked: boolean;
}

interface WorkerRequest {
  id?: number;
  parameters?: GeometryPrepareBatchRequest;
  array?: Int8Array;
}

interface WorkerReply {
  id?: number;
  result?: GeometryPrepareBatchResult;
  error?: { name: string; message: string };
  array?: Int8Array;
}

type Snapshot = ReturnType<Window['nativeWorkerFixture']['snapshot']>;

for (const scenario of ['normal', 'cdn', 'missing-entry', 'messageerror'] as const) {
  test(`production geometry Worker lifecycle: ${scenario}`, async ({ page, renderUrl }, testInfo) => {
    const responses: Array<{ url: string; status: number }> = [];
    const errors: string[] = [];
    const history: Array<{ name: string; snapshot: Snapshot }> = [];
    page.context().on('response', response => responses.push({ url: response.url(), status: response.status() }));
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      const createObjectURL = URL.createObjectURL;
      const revokeObjectURL = URL.revokeObjectURL;
      const workers: ObservedWorker[] = [];
      window.nativeWorkers = [];
      window.nativeWorkerBlobs = [];
      window.nativeWorkerUnhandledRejections = [];
      window.addEventListener('unhandledrejection', event => window.nativeWorkerUnhandledRejections.push(String(event.reason)));
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

      function returnedBytes(result: GeometryPrepareBatchResult): number {
        const buffers = new Set<ArrayBuffer>();
        const seen = new WeakSet<object>();
        function visit(value: unknown): void {
          if (!value || typeof value !== 'object' || seen.has(value))
            return;
          seen.add(value);
          if (value instanceof ArrayBuffer)
            buffers.add(value);
          else if (ArrayBuffer.isView(value))
            buffers.add(value.buffer as ArrayBuffer);
          else
            Object.values(value).forEach(visit);
        }
        visit(result);
        return [...buffers].reduce((total, buffer) => total + buffer.byteLength, 0);
      }

      // Every reply is produced by the actual deployed Worker. Holding only
      // its delivery makes queue saturation and fatal sibling cancellation
      // deterministic without replacing computation, serialization or transfer.
      class ObservedWorker extends NativeWorker {
        readonly observation: NativeWorkerObservation;
        private readonly heldReplies = new Map<number, WorkerReply>();
        private readonly releasedEvents = new WeakSet<Event>();

        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          const workerUrl = String(url);
          this.observation = {
            url: workerUrl,
            stage: workerUrl.includes('geometry.worker') ? 'geometry' : undefined,
            tasks: [],
            errors: [],
            terminated: 0,
          };
          workers.push(this);
          window.nativeWorkers.push(this.observation);
          this.addEventListener('error', event => this.observation.errors.push({ type: event.type, message: event.message ?? '' }));
          this.addEventListener('messageerror', event => this.observation.errors.push({ type: event.type, message: 'message could not be decoded' }));
          this.addEventListener('message', (event: MessageEvent<WorkerReply>) => {
            if (this.observation.probe)
              this.observation.probe.returnedValue = event.data.array?.[0];
            const task = this.observation.tasks.find(task => task.id === event.data.id);
            if (!task)
              return;
            if (!this.releasedEvents.has(event)) {
              const result = event.data.result;
              if (result) {
                task.resultCount = result.results.length;
                task.outputBytes = returnedBytes(result);
                task.nativeGeometryCounts = result.results.map(entry => 'result' in entry
                  ? ((entry.result.combined as { geometries?: unknown[] }).geometries?.length ?? 0)
                  : 0);
                task.lineTextureBytes = result.results.map(entry => 'result' in entry ? entry.result.linePositions?.values.byteLength ?? 0 : 0);
                task.lineBoundsCounts = result.results.map(entry => 'result' in entry ? (entry.result.lineBoundsCV?.length ?? 0) / 4 : 0);
              }
              task.state = 'held';
              this.heldReplies.set(task.id, event.data);
              event.stopImmediatePropagation();
              return;
            }
            task.state = event.data.error || event.data.result?.results.some(entry => 'error' in entry) ? 'rejected' : 'resolved';
          });
        }

        postMessage(message: WorkerRequest, transferOrOptions?: Transferable[] | StructuredSerializeOptions) {
          const transfers = (Array.isArray(transferOrOptions) ? transferOrOptions : transferOrOptions?.transfer ?? [])
            .filter((value): value is ArrayBuffer => value instanceof ArrayBuffer);
          let task: NativeWorkerTask | undefined;
          if (message.parameters) {
            this.observation.stage = 'geometry';
            task = {
              id: message.id!,
              state: this.observation.terminated ? 'aborted' : 'pending',
              transferredBefore: transfers.map(buffer => buffer.byteLength),
              inputBytes: transfers.reduce((total, buffer) => total + buffer.byteLength, 0),
              requestCounts: message.parameters.requests.map(request => request.geometries.length),
              nativeInstanceCounts: message.parameters.requests.map(request => (request.parameters as { packedInstances: Float64Array }).packedInstances[0]),
              lineInputCounts: message.parameters.requests.map(request => request.lineInputs?.length ?? 0),
            };
            this.observation.tasks.push(task);
          }
          else {
            this.observation.stage = 'probe';
            this.observation.probe = { transferredBefore: transfers.map(buffer => buffer.byteLength), transferredAfter: [] };
          }
          super.postMessage(message, transfers);
          if (task)
            task.transferredAfter = transfers.map(buffer => buffer.byteLength);
          else if (this.observation.probe)
            this.observation.probe.transferredAfter = transfers.map(buffer => buffer.byteLength);
        }

        release(id: number): void {
          const reply = this.heldReplies.get(id);
          if (!reply)
            throw new Error(`No held production geometry reply for task ${id}`);
          this.heldReplies.delete(id);
          const event = new MessageEvent<WorkerReply>('message', { data: reply });
          this.releasedEvents.add(event);
          this.dispatchEvent(event);
        }

        terminate() {
          this.observation.terminated++;
          for (const task of this.observation.tasks) {
            if (task.state === 'pending' || task.state === 'held')
              task.state = 'aborted';
          }
          this.heldReplies.clear();
          super.terminate();
        }
      }
      window.Worker = ObservedWorker;
      window.nativeWorkerRelease = (id) => {
        const worker = workers.find(worker => worker.observation.stage === 'geometry');
        if (!worker)
          throw new Error('Production geometry Worker has not started');
        worker.release(id);
      };
      window.nativeWorkerFailMessage = () => {
        const worker = workers.find(worker => worker.observation.stage === 'geometry');
        if (!worker)
          throw new Error('Production geometry Worker has not started');
        worker.dispatchEvent(new MessageEvent('messageerror'));
      };
    });

    const query = new URLSearchParams();
    if (scenario === 'cdn') {
      const baseUrl = new URL(`${renderUrl}/cesiumStatic/`);
      baseUrl.hostname = 'localhost';
      query.set('cesiumBaseUrl', baseUrl.href);
      // Change the actual resolved entry asset origin. Cesium's asset base
      // alone affects only its transfer probe, not the production entry URL.
      await page.context().route(/\/geometry\.worker\.ts\?worker&url(?:&|$)/, (route) => {
        const entryUrl = new URL(route.request().url());
        entryUrl.hostname = 'localhost';
        entryUrl.search = '?worker_file&type=module';
        return route.fulfill({ contentType: 'text/javascript', body: `export default ${JSON.stringify(entryUrl.href)};` });
      });
    }
    if (scenario === 'missing-entry') {
      await page.context().route(/\/geometry\.worker\.ts\?worker_file(?:&|$)/, route => route.fulfill({
        status: 404,
        contentType: 'text/javascript',
        body: 'Missing production geometry Worker entry',
      }));
    }

    try {
      await page.goto(`${renderUrl}/e2e/fixtures/native-worker-fixture.html?${query}`);
      await page.waitForFunction(() => window.nativeWorkerFixture);
      const admitted = await page.evaluate(() => window.nativeWorkerFixture.start());
      history.push({ name: 'admitted', snapshot: admitted });
      assert.deepEqual(admitted.states.map(state => state.state), ['COMBINING', 'COMBINING', 'READY']);
      assert.equal(admitted.mainMetadataCalls, 2, 'occupied slots allocated metadata for the waiting owner');
      assert.equal(admitted.mainAssemblyCalls, 0);
      assert.equal(admitted.mainPackCalls, 0);
      const failed = scenario === 'missing-entry' || scenario === 'messageerror';
      if (scenario !== 'missing-entry') {
        await expect.poll(() => page.evaluate(() => window.nativeWorkerFixture.snapshot().workers.filter(worker => worker.stage === 'geometry').flatMap(worker => worker.tasks).filter(task => task.state === 'held').length), { timeout: 15_000 }).toBe(2);
      }
      if (scenario === 'messageerror')
        await page.evaluate(() => window.nativeWorkerFixture.failMessage());

      if (failed) {
        await expect.poll(() => page.evaluate(() => window.nativeWorkerFixture.snapshot().states.filter(state => state.state === 'FAILED').length), { timeout: 5000 }).toBe(2);
        await page.evaluate(() => window.nativeWorkerFixture.admitWaiting());
        await expect.poll(() => page.evaluate(() => window.nativeWorkerFixture.snapshot().states.filter(state => state.state === 'FAILED').length), { timeout: 5000 }).toBe(3);
        const failure = await page.evaluate(() => window.nativeWorkerFixture.advance());
        history.push({ name: 'failed', snapshot: failure });
        assert.ok(failure.states.every(state => state.error.length > 0));
        assert.equal(failure.mainMetadataCalls, 2, 'fatal queue admitted a waiting owner');
        assert.equal(failure.completedTasks, 0, 'fatal browser event was reported as a completed Native task');
        assert.ok(failure.wakes > 0, 'owner failure did not wake the scene through afterRender');
      }
      else {
        const saturated = await page.evaluate(() => window.nativeWorkerFixture.snapshot());
        history.push({ name: 'saturated', snapshot: saturated });
        const tasks = saturated.workers.filter(worker => worker.stage === 'geometry').flatMap(worker => worker.tasks);
        assert.equal(tasks.length, 2);
        assert.ok(tasks.every(task => task.requestCounts.length === 1 && task.inputBytes <= 512 * 1024));
        assert.equal(saturated.completedTasks, 0, 'held replies released a queue slot early');
        assert.equal(saturated.mainMetadataCalls, 2);
        await page.evaluate(() => window.nativeWorkerFixture.releaseReply(0));
        await expect.poll(() => page.evaluate(() => window.nativeWorkerFixture.advance().states.map(state => state.state)), { timeout: 5000 })
          .toEqual(['COMBINED', 'COMBINING', 'READY']);
        const restored = await page.evaluate(() => window.nativeWorkerFixture.snapshot());
        history.push({ name: 'first-reply-adopted', snapshot: restored });
        assert.ok(restored.prepared[0].geometryCount > 0 && restored.prepared[0].textureBytes > 0);

        await page.evaluate(() => window.nativeWorkerFixture.admitWaiting());
        await expect.poll(() => page.evaluate(() => window.nativeWorkerFixture.snapshot().workers.filter(worker => worker.stage === 'geometry').flatMap(worker => worker.tasks).filter(task => task.state === 'held').length), { timeout: 15_000 }).toBe(2);
        const oversized = await page.evaluate(() => window.nativeWorkerFixture.snapshot());
        history.push({ name: 'oversize-admitted', snapshot: oversized });
        const oversizeTask = oversized.workers.find(worker => worker.stage === 'geometry')!.tasks[2];
        assert.ok(oversizeTask.inputBytes > 512 * 1024, 'fixture did not exercise an oversize Native request');
        assert.deepEqual(oversizeTask.requestCounts, [4097], 'oversize request shared its Worker batch');
        assert.equal(oversized.mainMetadataCalls, 3);

        await page.evaluate(() => {
          window.nativeWorkerFixture.releaseReply(1);
          window.nativeWorkerFixture.releaseReply(2);
        });
        await expect.poll(() => page.evaluate(() => window.nativeWorkerFixture.advance().states.map(state => state.state)), { timeout: 5000 })
          .toEqual(['COMBINED', 'COMBINED', 'COMBINED']);
      }

      await expect.poll(() => page.evaluate(() => window.nativeWorkerFixture.snapshot().transferProbePending)).toBe(false);
      const beforeDestroy = await page.evaluate(() => window.nativeWorkerFixture.snapshot());
      history.push({ name: 'before-destroy', snapshot: beforeDestroy });
      const geometryWorkers = beforeDestroy.workers.filter(worker => worker.stage === 'geometry');
      const probes = beforeDestroy.workers.filter(worker => worker.stage === 'probe');
      assert.equal(geometryWorkers.length, 1, 'one context created duplicate production geometry Workers');
      assert.equal(probes.length, 1);
      assert.equal(probes[0].terminated, 1);
      assert.deepEqual(probes[0].probe, { transferredBefore: [1], transferredAfter: [0], returnedValue: 99 });
      assert.equal(responses.filter(response => response.url.endsWith('/Workers/transferTypedArrayTest.js') && response.status === 200).length, 1);
      assert.equal(beforeDestroy.inputBytes, admitted.inputBytes, 'transfer detached the shared source geometry');
      assert.deepEqual(beforeDestroy.inputValues, admitted.inputValues);
      assert.deepEqual(beforeDestroy.inputIndices, admitted.inputIndices);
      assert.deepEqual(beforeDestroy.inputAttributes, admitted.inputAttributes, 'Worker assembly mutated shared source attributes');
      assert.equal(beforeDestroy.mainAssemblyCalls, 0, 'Native combine ran in the main isolate');
      assert.equal(beforeDestroy.mainPackCalls, 0, 'Native packed output was serialized in the main isolate');
      assert.deepEqual(beforeDestroy.unhandledRejections, []);
      const worker = geometryWorkers[0];
      if (failed) {
        assert.equal(worker.terminated, 1, 'fatal browser event retained the production Worker');
        assert.equal(worker.errors.length, 1);
        assert.ok(worker.tasks.every(task => task.state === 'aborted'), 'fatal queue left an observed task pending');
        if (scenario === 'missing-entry')
          assert.ok(responses.some(response => response.url.includes('geometry.worker.ts?worker_file') && response.status === 404));
        else
          assert.equal(worker.errors[0].type, 'messageerror');
      }
      else {
        assert.equal(worker.terminated, 0);
        assert.deepEqual(worker.errors, []);
        assert.deepEqual(errors, []);
        assert.equal(beforeDestroy.completedTasks, 3);
        assert.deepEqual(worker.tasks.map(task => task.id), [0, 1, 2], 'production TaskProcessor IDs did not advance');
        assert.ok(worker.tasks.every(task => task.state === 'resolved' && task.resultCount === 1 && (task.outputBytes ?? 0) > 0));
        assert.deepEqual(worker.tasks.map(task => task.nativeInstanceCounts), [[513], [513], [4097]]);
        assert.deepEqual(worker.tasks.map(task => task.lineInputCounts), [[513], [513], [4097]]);
        assert.deepEqual(worker.tasks.map(task => task.lineBoundsCounts), [[513], [513], [4097]]);
        assert.ok(worker.tasks.every(task => task.nativeGeometryCounts?.every(count => count > 0) && task.lineTextureBytes?.every(bytes => bytes > 0)));
        assert.ok(worker.tasks.every(task => task.transferredBefore.length > 0 && task.transferredBefore.every(bytes => bytes > 0)
          && task.transferredAfter?.length === task.transferredBefore.length && task.transferredAfter.every(bytes => bytes === 0)), 'owned Native input packets were not transferred');
        beforeDestroy.instanceCounts.forEach((count, index) => {
          assert.deepEqual(beforeDestroy.instanceIds[index], Array.from({ length: count }, (_, feature) => `feature-${feature}`));
          assert.equal(beforeDestroy.prepared[index].boundsCVCount, count);
          assert.equal(beforeDestroy.prepared[index].boundsCVFinite, true);
          assert.ok(beforeDestroy.prepared[index].attributes.includes('a_lineRecord') && beforeDestroy.prepared[index].attributes.includes('batchId'));
        });
      }

      const geometryBlobs = beforeDestroy.blobs.filter(blob => blob.url === worker.url);
      if (scenario === 'cdn') {
        assert.ok(worker.url.startsWith('blob:'), 'cross-origin entry bypassed the production module bootstrap');
        assert.equal(geometryBlobs.length, 1);
        assert.equal(geometryBlobs[0].revoked, false);
        assert.ok(responses.some(response => new URL(response.url).hostname === 'localhost'
          && response.url.includes('geometry.worker.ts?worker_file') && response.status === 200));
      }
      else {
        assert.equal(geometryBlobs.length, 0);
      }

      for (const index of [0, 1]) {
        const partial = await page.evaluate(index => window.nativeWorkerFixture.cancel(index), index);
        history.push({ name: `release-owner-${index}`, snapshot: partial });
        assert.equal(partial.workers.find(candidate => candidate.stage === 'geometry')!.terminated, failed ? 1 : 0, 'non-final owner release disposed shared transport');
        if (scenario === 'cdn')
          assert.equal(partial.blobs.find(blob => blob.url === worker.url)!.revoked, false);
      }
      const afterDestroy = await page.evaluate(() => window.nativeWorkerFixture.destroy());
      history.push({ name: 'last-owner-released', snapshot: afterDestroy });
      assert.ok(afterDestroy.states.every(state => state.destroyed));
      assert.ok(afterDestroy.workers.every(candidate => candidate.terminated === 1), 'last owner did not terminate transport exactly once');
      if (scenario === 'cdn')
        assert.equal(afterDestroy.blobs.find(blob => blob.url === worker.url)!.revoked, true, 'last owner retained the production bootstrap URL');

      const artifact = testInfo.outputPath('native-worker.json');
      await writeFile(artifact, JSON.stringify({ scenario, history, responses, errors }, null, 2));
      await testInfo.attach('native-worker', { path: artifact, contentType: 'application/json' });
    }
    catch (error) {
      const snapshot = await page.evaluate(() => window.nativeWorkerFixture?.snapshot());
      const artifact = testInfo.outputPath('native-worker-error.json');
      await writeFile(artifact, JSON.stringify({ scenario, snapshot, history, responses, errors }, null, 2));
      await testInfo.attach('native-worker-error', { path: artifact, contentType: 'application/json' });
      throw error;
    }
    finally {
      await page.evaluate(() => window.nativeWorkerFixture?.finish());
    }
  });
}
