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
  it.each([undefined, null, {}, { combined: null }])('fails every pending owner and notifies the context on malformed success %#', async (malformed) => {
    const onFailure = vi.fn();
    const { queue, dispatched } = harness(onFailure);
    const first = schedule(queue, 1, limit);
    const second = schedule(queue, 2, limit);
    const settled = Promise.allSettled([first, second]);
    await Promise.resolve();
    expect(dispatched).toHaveLength(2);
    dispatched[0].resolve({ results: [{ result: malformed }] } as GeometryPrepareBatchResult);
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

  it('admits another request into the queued second batch before copying its buffers', async () => {
    const { queue, dispatched } = harness();
    const first = schedule(queue, 1, 4);
    await Promise.resolve();
    const second = schedule(queue, 2, 8);
    expect(queue.hasCapacity).toBe(true);
    expect(queue.canSchedule(16)).toBe(true);
    expect(queue.canSchedule(limit - 8)).toBe(true);
    expect(queue.canSchedule(limit - 7)).toBe(false);
    expect(queue.canSchedule(limit + 1)).toBe(false);
    const third = queue.canSchedule(16) ? schedule(queue, 3, 16) : undefined;
    expect(third).toBeInstanceOf(Promise);
    expect(schedule(queue, 4, limit + 1)).toBeUndefined();
    await Promise.resolve();
    expect(dispatched.map(batch => batch.request.requests)).toEqual([[request(1)], [request(2), request(3)]]);
    expect(dispatched.map(batch => batch.transfers.reduce((bytes, buffer) => bytes + buffer.byteLength, 0))).toEqual([4, 24]);
    expect(queue.canSchedule(1)).toBe(false);
    expect(queue.hasCapacity).toBe(false);
    expect(schedule(queue, 4)).toBeUndefined();
    dispatched[0].resolve(success([1]));
    await first;
    expect(queue.canSchedule(limit + 1)).toBe(true);
    const fourth = schedule(queue, 4, limit + 1);
    await Promise.resolve();
    expect(dispatched).toHaveLength(3);
    expect(dispatched[2].request.requests).toEqual([request(4)]);
    expect(dispatched[2].transfers.map(buffer => buffer.byteLength)).toEqual([limit + 1]);
    expect(queue.canSchedule(1)).toBe(false);
    dispatched[1].resolve(success([2, 3]));
    dispatched[2].resolve(success([4]));
    await Promise.all([second, third, fourth]);
  });

  it('never adds requests to a dispatched batch and permits at most two pending dispatches', async () => {
    const { queue, dispatched } = harness();
    const first = schedule(queue, 1);
    await Promise.resolve();
    const second = schedule(queue, 2);
    await Promise.resolve();
    expect(schedule(queue, 3)).toBeUndefined();
    expect(dispatched.map(batch => batch.request.requests)).toEqual([[request(1)], [request(2)]]);
    dispatched[1].resolve(success([2]));
    await second;
    const third = schedule(queue, 3);
    await Promise.resolve();
    expect(dispatched).toHaveLength(3);
    dispatched[0].resolve(success([1]));
    dispatched[2].resolve(success([3]));
    await Promise.all([first, third]);
  });

  it('isolates oversized requests in their own batches', async () => {
    const { queue, dispatched } = harness();
    const first = schedule(queue, 1, limit + 1);
    const second = schedule(queue, 2);
    expect(schedule(queue, 3, limit + 1)).toBeUndefined();
    await Promise.resolve();
    expect(dispatched.map(batch => batch.request.requests.length)).toEqual([1, 1]);
    dispatched[0].resolve(success([1]));
    dispatched[1].resolve(success([2]));
    await Promise.all([first, second]);
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

  it('releases both batch slots when all queued requests are cancelled', async () => {
    const { queue, dispatch } = harness();
    let cancelled = false;
    const first = schedule(queue, 1, limit, () => cancelled);
    const second = schedule(queue, 2, limit, () => cancelled);
    const failures = [expect(first).rejects.toMatchObject({ name: 'AbortError' }), expect(second).rejects.toMatchObject({ name: 'AbortError' })];
    expect(queue.hasCapacity).toBe(false);
    cancelled = true;
    await Promise.all(failures);
    expect(dispatch).not.toHaveBeenCalled();
    expect(queue.hasCapacity).toBe(true);
    queue.destroy();
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

  it('closes all outstanding batches when dispatch rejects', async () => {
    const { queue, dispatched } = harness();
    const first = schedule(queue, 1, limit);
    const second = schedule(queue, 2, limit);
    const fatal = new Error('Native fatal');
    const failures = [expect(first).rejects.toBe(fatal), expect(second).rejects.toBe(fatal)];
    await Promise.resolve();
    dispatched[0].reject(fatal);
    await Promise.all(failures);
    expect(queue.error).toBe(fatal);
    expect(queue.hasCapacity).toBe(false);
    dispatched[1].resolve(success([2]));
    await Promise.resolve();
  });

  it('surfaces synchronous dispatch exceptions and stops subsequent queued dispatches', async () => {
    const fatal = new Error('dispatch failed');
    const dispatch = vi.fn(() => {
      throw fatal;
    });
    const queue = new GeometryPrepareQueue(dispatch);
    const first = schedule(queue, 1, limit);
    const second = schedule(queue, 2, limit);
    await Promise.all([expect(first).rejects.toBe(fatal), expect(second).rejects.toBe(fatal)]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(queue.error).toBe(fatal);
  });

  it('rejects the whole batch and closes on mismatched result counts', async () => {
    const { queue, dispatched } = harness();
    const first = schedule(queue, 1);
    const second = schedule(queue, 2);
    const failures = [expect(first).rejects.toBeInstanceOf(RangeError), expect(second).rejects.toBeInstanceOf(RangeError)];
    await Promise.resolve();
    dispatched[0].resolve(success([1]));
    await Promise.all(failures);
    expect(queue.error).toBeInstanceOf(RangeError);
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
