import type { GeometryPrepareBatchRequest, GeometryPrepareBatchResult, GeometryPrepareRequest, GeometryPrepareResult } from '../geometry-preparation';
import { describe, expect, it, vi } from 'vitest';
import { GeometryPrepareQueue } from '../geometry-prepare-queue';

const limit = 512 * 1024;

function request(id: number): GeometryPrepareRequest {
  return { parameters: { id }, geometries: [], layout: 'native', scene3DOnly: true, maximumTextureSize: 1024 };
}

function result(id: number): GeometryPrepareResult {
  return { combined: { id } };
}

function harness(onFailure?: (error: unknown) => void) {
  const dispatched: Array<{
    request: GeometryPrepareBatchRequest;
    transfers: ArrayBuffer[];
    resolve: (result: GeometryPrepareBatchResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  const dispatch = vi.fn((request: GeometryPrepareBatchRequest, transfers: ArrayBuffer[]) => new Promise<GeometryPrepareBatchResult>((resolve, reject) => {
    dispatched.push({ request, transfers, resolve, reject });
  }));
  return { queue: new GeometryPrepareQueue(dispatch, onFailure), dispatch, dispatched };
}

function schedule(queue: GeometryPrepareQueue, id: number, bytes = 1, cancelled = () => false) {
  return queue.schedule(request(id), [new ArrayBuffer(bytes)], cancelled);
}

function success(ids: number[]): GeometryPrepareBatchResult {
  return { results: ids.map(id => ({ result: result(id) })) };
}

describe('geometry preparation queue', () => {
  it('fails every pending owner and notifies the context on malformed success', async () => {
    const onFailure = vi.fn();
    const { queue, dispatched } = harness(onFailure);
    const first = schedule(queue, 1, limit);
    const second = schedule(queue, 2, limit);
    const settled = Promise.allSettled([first, second]);
    await Promise.resolve();
    expect(dispatched).toHaveLength(2);
    dispatched[0].resolve({ results: [{ result: {} }] } as GeometryPrepareBatchResult);
    expect((await settled).map(entry => entry.status)).toEqual(['rejected', 'rejected']);
    expect(queue.hasCapacity).toBe(false);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(queue.error);
    dispatched[1].resolve(success([2]));
    queue.destroy();
    expect(onFailure).toHaveBeenCalledOnce();
  });

  it('batches one microtask in submission order and settles by result position', async () => {
    const { queue, dispatch, dispatched } = harness();
    const firstBuffer = new ArrayBuffer(3);
    const secondBuffer = new ArrayBuffer(5);
    const first = queue.schedule(request(1), [firstBuffer], () => false);
    const second = queue.schedule(request(2), [secondBuffer], () => false);
    expect(dispatch).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatched[0].request.requests).toEqual([request(1), request(2)]);
    expect(dispatched[0].transfers).toEqual([firstBuffer, secondBuffer]);
    expect(dispatched[0].transfers[0]).toBe(firstBuffer);
    dispatched[0].resolve(success([11, 22]));
    await expect(first).resolves.toEqual(result(11));
    await expect(second).resolves.toEqual(result(22));
    expect(queue.hasCapacity).toBe(true);
  });

  it('counts actual backing bytes, includes the exact limit, and refuses a third batch', async () => {
    const { queue, dispatched } = harness();
    const backing = new ArrayBuffer(limit - 1);
    const first = queue.schedule(request(1), [backing], () => false);
    const second = schedule(queue, 2);
    const third = schedule(queue, 3);
    expect(queue.hasCapacity).toBe(true);
    expect(schedule(queue, 4, limit)).toBeUndefined();
    const fourth = schedule(queue, 4, limit - 1);
    expect(queue.hasCapacity).toBe(false);
    await Promise.resolve();
    expect(dispatched.map(batch => batch.request.requests.length)).toEqual([2, 2]);
    expect(dispatched.map(batch => batch.transfers.reduce((bytes, buffer) => bytes + buffer.byteLength, 0))).toEqual([limit, limit]);
    dispatched[0].resolve(success([1, 2]));
    dispatched[1].resolve(success([3, 4]));
    await Promise.all([first, second, third, fourth]);
    expect(queue.hasCapacity).toBe(true);
  });

  it('restores per-request error names and stacks without failing siblings or the queue', async () => {
    const { queue, dispatched } = harness();
    const first = schedule(queue, 1);
    const failure = expect(first).rejects.toMatchObject({ name: 'RangeError', message: 'bad geometry', stack: 'worker stack' });
    const second = schedule(queue, 2);
    await Promise.resolve();
    dispatched[0].resolve({ results: [{ error: { name: 'RangeError', message: 'bad geometry', stack: 'worker stack' } }, { result: result(2) }] });
    await failure;
    await expect(second).resolves.toEqual(result(2));
    expect(queue.error).toBeUndefined();
    expect(queue.hasCapacity).toBe(true);
  });

  it('removes a cancelled sibling before dispatch without transferring its buffer', async () => {
    let cancelled = false;
    const kept = new ArrayBuffer(8);
    const discarded = new ArrayBuffer(16);
    const received: ArrayBuffer[][] = [];
    const queue = new GeometryPrepareQueue(async (batch, transfers) => {
      received.push(transfers);
      structuredClone(batch, { transfer: transfers });
      return success([2]);
    });
    const first = queue.schedule(request(1), [discarded], () => cancelled);
    const failure = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const second = queue.schedule(request(2), [kept], () => false);
    cancelled = true;
    await failure;
    await expect(second).resolves.toEqual(result(2));
    expect(received).toEqual([[kept]]);
    expect(discarded.byteLength).toBe(16);
    expect(kept.byteLength).toBe(0);
    expect(queue.hasCapacity).toBe(true);
  });

  it('rejects cancellation after dispatch and then reopens capacity', async () => {
    const { queue, dispatched } = harness();
    let cancelled = false;
    const first = schedule(queue, 1, 1, () => cancelled);
    const failure = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    cancelled = true;
    dispatched[0].resolve(success([1]));
    await failure;
    expect(queue.hasCapacity).toBe(true);
  });

  it.each(['fail', 'destroy'] as const)('rejects in-flight and queued requests on %s and never dispatches late', async (operation) => {
    const { queue, dispatch, dispatched } = harness();
    const first = schedule(queue, 1);
    const firstFailure = expect(first).rejects.toBeInstanceOf(Error);
    await Promise.resolve();
    const second = schedule(queue, 2);
    const secondFailure = expect(second).rejects.toBeInstanceOf(Error);
    const fatal = new Error('worker died');
    if (operation === 'fail')
      queue.fail(fatal);
    else
      queue.destroy();
    await Promise.all([firstFailure, secondFailure]);
    expect(queue.error).toBeInstanceOf(Error);
    expect(queue.hasCapacity).toBe(false);
    if (operation === 'fail')
      expect(queue.error).toBe(fatal);
    dispatched[0].resolve(success([1]));
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(1);
    await expect(schedule(queue, 3)).rejects.toBe(queue.error);
  });

  it('rejects duplicate backing buffers within and across outstanding requests', async () => {
    const { queue, dispatched } = harness();
    const backing = new ArrayBuffer(16);
    expect(() => queue.schedule(request(1), [backing, backing], () => false)).toThrow(RangeError);
    const first = queue.schedule(request(1), [backing], () => false);
    expect(() => queue.schedule(request(2), [backing], () => false)).toThrow(RangeError);
    await Promise.resolve();
    expect(() => queue.schedule(request(2), [backing], () => false)).toThrow(RangeError);
    dispatched[0].resolve(success([1]));
    await first;
    const second = queue.schedule(request(2), [backing], () => false);
    await Promise.resolve();
    dispatched[1].resolve(success([2]));
    await second;
  });
});
