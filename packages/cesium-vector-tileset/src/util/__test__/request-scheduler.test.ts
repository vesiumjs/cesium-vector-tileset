import type { WorkerEndpoint } from '../../worker/worker-channel';
import type { GetResourceResponse, RequestParameters } from '../ajax';
import { transferableAbortController } from 'node:util';
import { Request as CesiumRequest, RequestScheduler, RequestType } from 'cesium';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addProtocol, removeProtocol } from '../../source/protocol-crud';
import { WorkerDispatcher } from '../../worker/dispatcher';
import { WorkerChannel } from '../../worker/worker-channel';
import { getSharedWorkerPool, WorkerPool } from '../../worker/worker-pool';
import { makeRequest } from '../ajax';
import { getImage } from '../image-request';

const context = vi.hoisted(() => ({ worker: false }));
vi.mock('../../worker/scope', async original => ({
  ...await original<typeof import('../../worker/scope')>(),
  isWorker: () => context.worker,
}));

const scheduler = RequestScheduler as typeof RequestScheduler & {
  request: (request: CesiumRequest) => Promise<unknown> | undefined;
  update: () => void;
  clearForSpecs: () => void;
};
type WireMessage = Parameters<WorkerChannel['receive']>[0]['data'];
const workers: Endpoint[] = [];
const controllers: AbortController[] = [];
let dispatcher: WorkerDispatcher;
let fetches: Array<{ request: Request; resolve: (response: Response) => void; worker: boolean }>;
const limits = { total: RequestScheduler.maximumRequests, server: RequestScheduler.maximumRequestsPerServer };

class Endpoint extends EventTarget {
  readonly channel: WorkerChannel;
  readonly terminate: () => void;

  constructor() {
    super();
    const scope = new EventTarget() as EventTarget & WorkerEndpoint;
    scope.postMessage = message => this.dispatchEvent(new MessageEvent('message', { data: message }));
    this.channel = new WorkerChannel(scope);
    this.terminate = () => this.channel.remove();
    workers.push(this);
  }

  postMessage(message: WireMessage): void {
    this.channel.receive({ data: message });
  }
}

function controller(): AbortController {
  const value = new AbortController();
  controllers.push(value);
  return value;
}

function workerRequest(worker: number, request: RequestParameters, abort = controller()): Promise<GetResourceResponse<unknown>> {
  vi.stubGlobal('worker', { channel: workers[worker].channel, referrer: window.location.href });
  context.worker = true;
  try {
    return makeRequest(request, abort);
  }
  finally {
    context.worker = false;
  }
}

function terrain(url: string): () => void {
  let complete!: () => void;
  const request = new CesiumRequest({
    url,
    throttleByServer: true,
    type: RequestType.TERRAIN,
    requestFunction: () => new Promise<void>(resolve => complete = resolve),
  });
  void scheduler.request(request)?.catch(() => {});
  return () => complete();
}

function complete(index: number, data = 'loaded'): void {
  const response = new Response(data, { headers: { 'Cache-Control': 'max-age=60', 'Expires': 'Wed, 14 Oct 2026 00:00:00 GMT', 'ETag': 'tile-v1' } });
  Object.defineProperty(response, 'url', { value: `${fetches[index].request.url}?redirected` });
  fetches[index].resolve(response);
}

beforeEach(async () => {
  scheduler.clearForSpecs();
  RequestScheduler.maximumRequests = 2;
  RequestScheduler.maximumRequestsPerServer = 1;
  vi.stubGlobal('Request', Object.getPrototypeOf(Request));
  vi.stubGlobal('AbortController', transferableAbortController().constructor);
  fetches = [];
  vi.stubGlobal('fetch', vi.fn((request: Request) => new Promise<Response>((resolve, reject) => {
    fetches.push({ request, resolve, worker: context.worker });
    request.signal.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true });
  })));
  vi.stubGlobal('Worker', Endpoint);
  WorkerPool.workerCount = 2;
  dispatcher = new WorkerDispatcher(getSharedWorkerPool(), 'scheduler-test');
  await dispatcher.waitForInitComplete();
  // The second acquisition is the real global dispatcher that handles requests
  // originating from either pooled worker, rather than a scheduler per worker.
  const { getGlobalDispatcher } = await import('../../worker/dispatcher');
  await getGlobalDispatcher()!.waitForInitComplete();
  await Promise.resolve();
});

afterEach(async () => {
  for (const value of controllers.splice(0)) value.abort();
  dispatcher.remove();
  for (const worker of workers.splice(0)) worker.channel.remove();
  scheduler.clearForSpecs();
  await new Promise(resolve => setTimeout(resolve, 20));
  RequestScheduler.maximumRequests = limits.total;
  RequestScheduler.maximumRequestsPerServer = limits.server;
  context.worker = false;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('main-thread request admission', () => {
  it('shares global and server slots with terrain across workers and retains fetch metadata', async () => {
    const finishTerrain = terrain('https://shared.test/terrain');
    const waiting = workerRequest(0, { url: 'https://shared.test/vector', headers: { 'If-None-Match': 'previous' } });
    const admitted = workerRequest(1, { url: 'https://other.test/vector', credentials: 'include', cache: 'reload' });
    for (const promise of [waiting, admitted]) void promise.catch(() => {});
    await vi.waitFor(() => expect(fetches).toHaveLength(1));
    expect(fetches[0].request.url).toBe('https://other.test/vector');
    expect(fetches[0].worker).toBe(false);
    expect(fetches[0].request.credentials).toBe('include');
    expect(fetches[0].request.cache).toBe('reload');
    const main = makeRequest({ url: 'https://third.test/sprite' }, controller());
    void main.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fetches).toHaveLength(1);

    complete(0);
    await expect(admitted).resolves.toMatchObject({ data: 'loaded', etag: 'tile-v1', cacheControl: 'max-age=60', expires: 'Wed, 14 Oct 2026 00:00:00 GMT', url: 'https://other.test/vector?redirected' });
    await vi.waitFor(() => expect(fetches).toHaveLength(2));
    expect(fetches[1].request.url).toBe('https://third.test/sprite');
    finishTerrain();
    await vi.waitFor(() => expect(fetches).toHaveLength(3));
    expect(fetches[2].request.headers.get('If-None-Match')).toBe('previous');
    expect(fetches[2].worker).toBe(false);
    complete(1);
    complete(2);
    await Promise.all([waiting, main]);
  });

  it('cancels waiting and admitted worker requests without starting stale fetches', async () => {
    RequestScheduler.maximumRequests = 1;
    const finishTerrain = terrain('https://shared.test/terrain');
    const canceledController = controller();
    const canceled = workerRequest(0, { url: 'https://shared.test/canceled' }, canceledController).catch(error => error);
    canceledController.abort();
    expect(await canceled).toMatchObject({ name: 'AbortError' });
    const liveController = controller();
    const live = workerRequest(1, { url: 'https://shared.test/live' }, liveController).catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fetches).toHaveLength(0);

    finishTerrain();
    await vi.waitFor(() => expect(fetches).toHaveLength(1));
    expect(fetches[0].request.url).toBe('https://shared.test/live');
    liveController.abort();
    expect(await live).toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetches[0].request.signal.aborted).toBe(true));
    complete(0, 'late data');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(fetches).toHaveLength(1);
  });

  it('retries Cesium cancellation when a second issued request loses its server slot', async () => {
    const first = makeRequest({ url: 'https://shared.test/first' }, controller());
    const second = makeRequest({ url: 'https://shared.test/second' }, controller());
    for (const request of [first, second]) void request.catch(() => {});
    await vi.waitFor(() => expect(fetches).toHaveLength(1));
    expect(fetches[0].request.url).toBe('https://shared.test/first');
    complete(0, 'first');
    await expect(first).resolves.toMatchObject({ data: 'first' });
    await vi.waitFor(() => expect(fetches).toHaveLength(2));
    expect(fetches[1].request.url).toBe('https://shared.test/second');
    complete(1, 'second');
    await expect(second).resolves.toMatchObject({ data: 'second' });
  });

  it('keeps custom protocols local and rejects HTTP failures without retrying them', async () => {
    const protocol = vi.fn(async () => ({ data: new ArrayBuffer(0), etag: 'custom-v1' }));
    addProtocol('scheduler-test', protocol);
    try {
      await expect(workerRequest(0, { url: 'scheduler-test://local/tile', type: 'arrayBuffer' })).resolves.toMatchObject({ etag: 'custom-v1' });
      expect(protocol).toHaveBeenCalledTimes(1);
      expect(fetches).toHaveLength(0);

      const request = workerRequest(1, { url: 'https://shared.test/missing' }).catch(error => error);
      await vi.waitFor(() => expect(fetches).toHaveLength(1));
      fetches[0].resolve(new Response('Missing tile', { status: 404, statusText: 'Not Found' }));
      expect(await request).toMatchObject({ name: 'Error', status: 404, url: 'https://shared.test/missing' });
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(fetches).toHaveLength(1);
    }
    finally {
      removeProtocol('scheduler-test');
    }
  });

  it('admits HTML image requests through the same slots as terrain', async () => {
    RequestScheduler.maximumRequests = 1;
    const images: HTMLImageElement[] = [];
    vi.stubGlobal('Image', class {
      constructor() {
        const image = document.createElement('img');
        let source = '';
        Object.defineProperty(image, 'src', {
          get: () => source,
          set: (value: string) => {
            source = value;
            if (value)
              images.push(image);
          },
        });
        return image;
      }
    });
    const finishTerrain = terrain('https://shared.test/terrain');
    const request = getImage({ url: 'https://shared.test/raster' }, controller(), false);
    void request.catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(images).toHaveLength(0);
    finishTerrain();
    await Promise.race([
      vi.waitFor(() => expect(images).toHaveLength(1)),
      request.then(() => {}, (error) => { throw error; }),
    ]);
    expect(images[0].src).toBe('https://shared.test/raster');
    images[0].dispatchEvent(new Event('load'));
    await expect(request).resolves.toMatchObject({ data: images[0] });
    expect(fetches).toHaveLength(0);
  });

  it('preserves image request headers and response metadata and closes a canceled decode', async () => {
    class Bitmap {
      close = vi.fn();
    }
    const decoded = new Bitmap();
    vi.stubGlobal('ImageBitmap', Bitmap);
    const decode = vi.fn(async () => decoded);
    vi.stubGlobal('createImageBitmap', decode);
    const request = getImage({ url: 'https://shared.test/raster', headers: { Accept: 'image/png' }, cache: 'reload' }, controller(), false);
    void request.catch(() => {});
    await vi.waitFor(() => expect(fetches).toHaveLength(1));
    expect(fetches[0].request.headers.get('Accept')).toBe('image/png');
    expect(fetches[0].request.cache).toBe('reload');
    complete(0);
    await expect(request).resolves.toMatchObject({ data: decoded, etag: 'tile-v1', cacheControl: 'max-age=60', url: 'https://shared.test/raster?redirected' });

    let finishDecode!: (value: Bitmap) => void;
    decode.mockImplementation(() => new Promise(resolve => finishDecode = resolve));
    const canceledController = controller();
    const canceled = getImage({ url: 'https://shared.test/canceled-raster' }, canceledController).catch(error => error);
    await vi.waitFor(() => expect(fetches).toHaveLength(2));
    complete(1);
    await vi.waitFor(() => expect(decode).toHaveBeenCalledTimes(2));
    canceledController.abort();
    const late = new Bitmap();
    finishDecode(late);
    expect(await canceled).toMatchObject({ name: 'AbortError' });
    expect(late.close).toHaveBeenCalledTimes(1);
  });
});
