import type { ErrorEvent as StyleErrorEvent } from '../../util/evented';
import type { TileWorkerScope } from '../../worker/scope';
import type { WorkerChannel, WorkerEndpoint } from '../../worker/worker-channel';
import { transferableAbortController } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

type MessageData = Parameters<WorkerChannel['receive']>[0]['data'];

async function workerFixture(startupFailure?: Error) {
  vi.resetModules();
  vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(4);
  const [{ TileWorker }, { Style }, { MessageType }, { getSharedWorkerPool }, { rtlMainThreadPluginFactory }] = await Promise.all([
    import('../../worker/tile-worker'),
    import('../style'),
    import('../../worker/messages'),
    import('../../worker/worker-pool'),
    import('../../source/rtl-text-plugin-main-thread'),
  ]);
  const workers: ControlledWorker[] = [];
  class ControlledWorker extends EventTarget {
    readonly messages: MessageData[] = [];
    readonly queued: MessageData[] = [];
    readonly worker: InstanceType<typeof TileWorker>;
    readonly rtlImports: string[] = [];
    deferMessages = false;
    readonly terminate = vi.fn(() => this.worker.channel.remove());

    constructor() {
      super();
      const scope = new EventTarget() as EventTarget & TileWorkerScope & WorkerEndpoint;
      scope.postMessage = (message) => {
        this.dispatchEvent(new MessageEvent('message', { data: message }));
      };
      this.worker = new TileWorker(scope, () => {});
      // The external RTL script import is controlled; its messages still
      // cross the real dispatcher and both real WorkerChannel implementations.
      this.worker.channel.registerMessageHandler(MessageType.syncRTLPluginState, async (_mapId, state) => {
        if (state.pluginStatus === 'loading') {
          this.rtlImports.push(state.pluginURL);
          return { ...state, pluginStatus: 'loaded' };
        }
        return state;
      });
      if (workers.length === 0 && startupFailure) {
        queueMicrotask(() => this.dispatchEvent(new ErrorEvent('error', { error: startupFailure, message: startupFailure.message })));
      }
      workers.push(this);
    }

    postMessage(message: MessageData): void {
      this.messages.push(message);
      if (this.deferMessages) {
        this.queued.push(message);
      }
      else {
        this.worker.channel.receive({ data: message });
      }
    }

    flush(): void {
      for (const message of this.queued.splice(0)) {
        this.worker.channel.receive({ data: { ...message, mustQueue: true } });
      }
      while (this.worker.channel.taskQueue.length > 0) {
        this.worker.channel.processNextMessage();
      }
    }
  }
  vi.stubGlobal('Worker', ControlledWorker);
  const styles = [new Style(), new Style()];
  const startupErrors: StyleErrorEvent['error'][][] = [[], []];
  if (startupFailure) {
    styles.forEach((style, index) => style.on('error', event => startupErrors[index].push(event.error)));
  }
  await Promise.all(styles.map(style => style.dispatcher.waitForInitComplete()));
  return { styles, workers, startupErrors, MessageType, pool: getSharedWorkerPool(), Style, plugin: rtlMainThreadPluginFactory() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('shared style worker lifecycle', () => {
  it('rejects every shared clients pending and future requests when a worker fails', async () => {
    const { styles: [first, second], workers, MessageType, Style, pool } = await workerFixture();
    let later: InstanceType<typeof Style> | undefined;
    const firstErrors: StyleErrorEvent['error'][] = [];
    const secondErrors: StyleErrorEvent['error'][] = [];
    first.on('error', event => firstErrors.push(event.error));
    second.on('error', event => secondErrors.push(event.error));
    try {
      await Promise.all([first, second].map(style => style.dispatcher.broadcast(MessageType.setLayers, [])));
      const target = workers[0];
      const firstChannel = first.dispatcher.channels[0];
      const secondChannel = second.dispatcher.channels[0];
      target.deferMessages = true;
      const abortController = new AbortController();
      const errors: Error[] = [];
      const requests = [
        firstChannel.sendAsync({ type: MessageType.setLayers, data: [] }, abortController),
        firstChannel.sendAsync({ type: MessageType.updateGlobalState, data: {} }),
        secondChannel.sendAsync({ type: MessageType.setLayers, data: [] }),
      ].map(request => request.catch(error => errors.push(error)));
      const reason = new Error('Failed to load MVT worker dependency: 504');
      target.dispatchEvent(new ErrorEvent('error', { error: reason, message: reason.message }));

      await vi.waitFor(() => expect(errors).toHaveLength(3), { timeout: 1000 });
      await Promise.all(requests);
      expect(errors.every(error => error === reason)).toBe(true);
      expect(firstErrors).toEqual([reason]);
      expect(secondErrors).toEqual([reason]);
      expect(target.terminate).toHaveBeenCalledTimes(1);

      target.dispatchEvent(new ErrorEvent('error', { error: new Error('A later error must not replace the first') }));
      target.dispatchEvent(new MessageEvent('messageerror'));
      const posted = target.messages.length;
      abortController.abort();
      await expect(firstChannel.sendAsync({ type: MessageType.setLayers, data: [] })).rejects.toBe(reason);
      expect(target.messages).toHaveLength(posted);
      expect(firstErrors).toEqual([reason]);
      expect(secondErrors).toEqual([reason]);

      const laterErrors: StyleErrorEvent['error'][] = [];
      later = new Style();
      later.on('error', event => laterErrors.push(event.error));
      await later.dispatcher.waitForInitComplete();
      expect(laterErrors).toEqual([reason]);
      await expect(later.dispatcher.channels[0].sendAsync({ type: MessageType.setLayers, data: [] })).rejects.toBe(reason);
      expect(target.messages).toHaveLength(posted);
      expect(workers).toHaveLength(2);
      await second.dispatcher.channels[1].sendAsync({ type: MessageType.updateGlobalState, data: { healthy: true } });
      expect(workers[1].worker.globalStates.get(second.dispatcher.id)).toEqual({ healthy: true });
      expect(workers[1].terminate).not.toHaveBeenCalled();

      first.destroy();
      second.destroy();
      later.destroy();
      await Promise.resolve();
      expect(pool.numActive()).toBe(0);
      expect(workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
    }
    finally {
      first.destroy();
      second.destroy();
      later?.destroy();
      for (const { worker } of workers) worker.channel.remove();
    }
  });

  it('replays a module failure that occurs before clients finish acquiring their channels', async () => {
    const reason = new Error('MVT worker module unavailable: 404');
    const { styles, workers, startupErrors, MessageType } = await workerFixture(reason);
    try {
      expect(startupErrors).toEqual([[reason], [reason]]);
      for (const style of styles) {
        await expect(style.dispatcher.channels[0].sendAsync({ type: MessageType.setLayers, data: [] })).rejects.toBe(reason);
      }
      expect(workers[0].messages).toHaveLength(0);
      expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    }
    finally {
      for (const style of styles) style.destroy();
      for (const { worker } of workers) worker.channel.remove();
    }
  });

  it('aborts a destroyed styles pending tile fetch even when its per-tile cleanup RPC is cancelled', async () => {
    const { styles: [first, second], workers, MessageType, pool } = await workerFixture();
    const { OverscaledTileID } = await import('../../tile/tile-id');
    const requests: { request: Request; reject: (error: Error) => void }[] = [];
    // jsdom wraps Node's Request in a subclass, hiding the own signal getter
    // used by ajax's Fetch capability check. Use its actual Fetch constructor
    // and matching native AbortSignal implementation for this network test.
    vi.stubGlobal('Request', Object.getPrototypeOf(Request));
    vi.stubGlobal('AbortController', transferableAbortController().constructor);
    vi.stubGlobal('fetch', vi.fn((request: Request) => new Promise((_resolve, reject) => {
      requests.push({ request, reject });
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    })));
    const params = (uid: string) => ({
      uid,
      type: 'vector',
      source: 'vector',
      tileID: new OverscaledTileID(0, 0, 0, 0, 0),
      zoom: 0,
      tileSize: 512,
      pixelRatio: 1,
      promoteId: undefined,
      request: { url: `https://example.test/${uid}.pbf` },
    });
    try {
      const firstChannel = first.dispatcher.getReadyChannel();
      const secondChannel = second.dispatcher.getReadyChannel();
      const firstLoad = firstChannel.sendAsync({ type: MessageType.loadTile, data: params('first') }).catch(error => error);
      const secondLoad = secondChannel.sendAsync({ type: MessageType.loadTile, data: params('second') }).catch(error => error);
      await Promise.race([
        vi.waitFor(() => expect(requests).toHaveLength(2)),
        firstLoad.then((error) => { throw error; }),
        secondLoad.then((error) => { throw error; }),
      ]);
      const firstRequest = requests.find(({ request }) => request.url.endsWith('/first.pbf'))!.request;
      const secondRequest = requests.find(({ request }) => request.url.endsWith('/second.pbf'))!.request;
      const firstSource = workers.flatMap(({ worker }) => Object.values(worker.workerSources[first.dispatcher.id]?.vector ?? {}))[0];
      expect(firstSource).toBeDefined();
      for (const target of workers) target.deferMessages = true;
      const perTileCleanup = firstChannel.sendAsync({ type: MessageType.abortTile, data: { uid: 'first', source: 'vector', type: 'vector' } }).catch(error => error);

      first.destroy();
      for (const target of workers) target.flush();

      expect(await perTileCleanup).toMatchObject({ name: 'AbortError' });
      expect(await firstLoad).toMatchObject({ name: 'AbortError' });
      expect(firstRequest.signal.aborted).toBe(true);
      expect(secondRequest.signal.aborted).toBe(false);
      expect(workers.every(worker => worker.terminate.mock.calls.length === 0)).toBe(true);
      for (const target of workers) target.deferMessages = false;
      await second.dispatcher.broadcast(MessageType.updateGlobalState, { surviving: true });
      for (const { worker } of workers) {
        expect(worker.globalStates.get(second.dispatcher.id)).toEqual({ surviving: true });
      }

      second.destroy();
      expect(await secondLoad).toMatchObject({ name: 'AbortError' });
      await Promise.resolve();
      expect(secondRequest.signal.aborted).toBe(true);
      expect(pool.numActive()).toBe(0);
      expect(workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
    }
    finally {
      first.destroy();
      second.destroy();
      for (const { reject } of requests) reject(new DOMException('Test cleanup', 'AbortError'));
      for (const { worker } of workers) worker.channel.remove();
    }
  });

  it('rebuilds the worker pool and imports a previously loaded RTL plugin into its new workers', async () => {
    const { styles: [first, second], workers, Style, plugin, pool } = await workerFixture();
    let restarted: InstanceType<typeof Style> | undefined;
    try {
      const url = 'https://rtl.example/plugin.js';
      await plugin.setRTLTextPlugin(url);
      expect(plugin.getRTLTextPluginStatus()).toBe('loaded');
      const previousWorkers = workers.slice();
      expect(previousWorkers.every(worker => worker.rtlImports.includes(url))).toBe(true);
      first.destroy();
      second.destroy();
      await Promise.resolve();
      expect(pool.numActive()).toBe(0);

      restarted = new Style();
      await restarted.dispatcher.waitForInitComplete();
      await plugin.syncStateWithWorkers();
      const nextWorkers = workers.slice(previousWorkers.length);
      expect(nextWorkers).toHaveLength(previousWorkers.length);
      expect(nextWorkers.every(worker => worker.rtlImports.includes(url))).toBe(true);
      expect(plugin.getRTLTextPluginStatus()).toBe('loaded');
    }
    finally {
      first.destroy();
      second.destroy();
      restarted?.destroy();
      for (const { worker } of workers) worker.channel.remove();
    }
  });

  it('releases styles destroyed before their channels finish initializing', async () => {
    const { styles: [first, second], workers, Style, pool } = await workerFixture();
    first.destroy();
    second.destroy();
    await Promise.resolve();
    const style = new Style();
    style.destroy();
    await style.dispatcher.waitForInitComplete();
    await Promise.resolve();
    expect(pool.numActive()).toBe(0);
    expect(workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
  });
});
