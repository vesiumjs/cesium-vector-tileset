import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { expect } from 'playwright/test';
import { test } from './fixtures';

export interface MvtWorkerObservation {
  worker: Worker;
  errors: number;
  messages: number;
  terminations: number;
}

test('a real failed MVT Worker rejects all shared clients while the healthy Worker keeps responding', async ({ page, renderUrl }, testInfo) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.mvtWorkers = [];
    window.Worker = class extends NativeWorker {
      record: MvtWorkerObservation;

      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.record = { worker: this, errors: 0, messages: 0, terminations: 0 };
        window.mvtWorkers.push(this.record);
        this.addEventListener('error', () => this.record.errors++);
      }

      postMessage(...args: [message: unknown, transferOrOptions?: Transferable[] | StructuredSerializeOptions]) {
        this.record.messages++;
        return Array.isArray(args[1]) ? super.postMessage(args[0], args[1]) : super.postMessage(args[0], args[1]);
      }

      terminate() {
        this.record.terminations++;
        return super.terminate();
      }
    };
  });
  let heldRequest: string;
  let requested = 0;
  let release: () => void;
  const held = new Promise<void>(resolve => release = resolve);
  await page.route('**/worker-entry.ts*', async (route) => {
    requested++;
    if (requested === 1) {
      heldRequest = route.request().url();
      await held;
      await route.fulfill({ status: 504, body: 'Intentional Worker module failure' });
    }
    else {
      await route.continue();
    }
  });
  await page.goto(`${renderUrl}/e2e/fixtures/mvt-worker-fixture.html`);
  await expect.poll(() => page.evaluate(() => !!window.mvtWorkerFixture)).toBe(true);
  await page.evaluate(() => window.mvtWorkerFixture.start());
  await expect.poll(() => !!heldRequest).toBe(true);
  const pending = await page.evaluate(() => window.mvtWorkerFixture.snapshot());
  assert.deepEqual(pending.calls.map(call => call.status), ['pending', 'pending']);
  assert.ok(pending.pending.every(count => count > 0));
  assert.equal(pending.workers[0].errors, 0);
  release();
  await expect.poll(() => page.evaluate(() => window.mvtWorkerFixture.snapshot().workers[0].errors)).toBe(1);
  await expect.poll(() => page.evaluate(() => window.mvtWorkerFixture.snapshot().calls.map(call => call.status)), { timeout: 5_000 }).toEqual(['rejected', 'rejected']);
  const failed = await page.evaluate(() => window.mvtWorkerFixture.snapshot());
  assert.ok(failed.sameCause);
  assert.deepEqual(failed.pending, [0, 0]);
  assert.deepEqual(failed.workers.map(worker => worker.terminations), [1, 0]);
  assert.ok(failed.calls.every(call => call.name === 'Error'));
  await page.evaluate(() => window.mvtWorkerFixture.lateClient());
  await expect.poll(() => page.evaluate(() => window.mvtWorkerFixture.snapshot().calls.map(call => call.status)), { timeout: 5_000 }).toEqual(['rejected', 'rejected', 'rejected']);
  const late = await page.evaluate(() => window.mvtWorkerFixture.snapshot());
  assert.ok(late.sameCause);
  assert.deepEqual(late.pending, [0, 0, 0]);
  assert.equal(late.workers[0].messages, failed.workers[0].messages, 'a terminal Worker received a new message');
  assert.equal(await page.evaluate(() => window.mvtWorkerFixture.healthy()), true);
  await page.evaluate(() => window.mvtWorkerFixture.destroy());
  await expect.poll(() => page.evaluate(() => window.mvtWorkers.map(worker => worker.terminations))).toEqual([1, 1]);
  const final = await page.evaluate(() => window.mvtWorkerFixture.snapshot());
  assert.equal(final.active, 0);
  const output = testInfo.outputPath('mvt-worker-failure.json');
  await writeFile(output, JSON.stringify({ heldRequest, pending, failed, late, final }, null, 2));
  await testInfo.attach('mvt-worker-failure', { path: output, contentType: 'application/json' });
});
