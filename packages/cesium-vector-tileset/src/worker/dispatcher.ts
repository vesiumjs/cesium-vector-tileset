import type { Subscription } from '../util/evented';
import type { RequestResponseMessageMap } from './messages';
import type { MessageHandler, WorkerEndpoint } from './worker-channel';
import type { WorkerPool } from './worker-pool';
import { GLOBAL_DISPATCHER_ID, makeRequest } from '../util/ajax';

import { MessageType } from './messages';
import { WorkerChannel } from './worker-channel';
import { getSharedWorkerPool } from './worker-pool';

/**
 * Responsible for sending messages from a {@link Source} to an associated worker source (usually with the same name).
 */
export class WorkerDispatcher {
  workerPool: WorkerPool;
  channels: WorkerChannel[];
  channelsReady: Promise<WorkerChannel[]>;
  channelIndex: number;
  id: string | number;
  private removed: boolean;
  private readonly onWorkerError?: (error: Error) => void;
  private readonly failureSubscriptions: Subscription[] = [];

  constructor(workerPool: WorkerPool, mapId: string | number, onWorkerError?: (error: Error) => void) {
    this.workerPool = workerPool;
    this.channels = [];
    this.channelIndex = 0;
    this.id = mapId;
    this.removed = false;
    this.onWorkerError = onWorkerError;
    this.channelsReady = this.initializeChannels(mapId);
    if (mapId !== GLOBAL_DISPATCHER_ID) {
      acquireGlobalDispatcher();
    }
  }

  private async initializeChannels(mapId: string | number): Promise<WorkerChannel[]> {
    const workers = await this.workerPool.acquire(mapId);
    if (this.removed)
      return [];
    this.channels = workers.map((worker: WorkerEndpoint) => {
      const channel = new WorkerChannel(worker, mapId);
      this.failureSubscriptions.push(this.workerPool.subscribeFailure(worker, (error) => {
        channel.fail(error);
        // User error listeners must not interrupt failure delivery to the
        // other channels sharing this worker.
        queueMicrotask(() => {
          if (!this.removed)
            this.onWorkerError?.(error);
        });
      }));
      return channel;
    });
    if (!this.channels.length)
      throw new Error('No channels found');
    return this.channels;
  }

  /**
   * Broadcast a message to all Workers.
   */
  async broadcast<T extends MessageType>(type: T, data: RequestResponseMessageMap[T][0]): Promise<Array<RequestResponseMessageMap[T][1]>> {
    const channels = await this.channelsReady;
    return Promise.all(channels.map(channel => channel.sendAsync({ type, data })));
  }

  /**
   * Acquires a channel to dispatch messages to. The channels are distributed in round-robin fashion.
   * @returns A channel object backed by a web worker for processing messages.
   */
  async getChannel(): Promise<WorkerChannel> {
    const channels = await this.channelsReady;
    this.channelIndex = (this.channelIndex + 1) % channels.length;
    const channel = channels[this.channelIndex];
    if (!channel) {
      throw new Error('No channels found');
    }
    return channel;
  }

  async waitForInitComplete(): Promise<void> {
    if (this.channels.length === 0) {
      await this.channelsReady;
    }
  }

  getReadyChannel(): WorkerChannel {
    this.channelIndex = (this.channelIndex + 1) % this.channels.length;
    const channel = this.channels[this.channelIndex];
    if (!channel) {
      throw new Error('No channels found');
    }
    return channel;
  }

  remove(): void {
    if (this.removed) {
      return;
    }
    this.removed = true;
    for (const subscription of this.failureSubscriptions) subscription.unsubscribe();
    this.failureSubscriptions.length = 0;
    for (const channel of this.channels) {
      if (this.id !== GLOBAL_DISPATCHER_ID) {
        channel.notify({ type: MessageType.removeMap, data: undefined });
      }
      channel.remove();
    }
    this.channels = [];
    this.workerPool.release(this.id);
    if (this.id !== GLOBAL_DISPATCHER_ID) {
      releaseGlobalDispatcher();
    }
  }

  public async registerMessageHandler<T extends MessageType>(type: T, handler: MessageHandler<T>): Promise<void> {
    const channels = await this.channelsReady;
    for (const channel of channels) {
      channel.registerMessageHandler(type, handler);
    }
  }

  public async unregisterMessageHandler<T extends MessageType>(type: T): Promise<void> {
    const channels = await this.channelsReady;
    for (const channel of channels) {
      channel.unregisterMessageHandler(type);
    }
  }
}

let globalDispatcher: WorkerDispatcher | undefined;
let globalDispatcherUsers = 0;

/**
 * This function is used to get the global dispatcher that is shared across all maps instances.
 * It is used by the main thread to send messages to the workers, and by the workers to send messages back to the main thread.
 * If you import a script into the worker and need to send a message to the workers to pass some parameters for example,
 * you can use this function to get the global dispatcher and send a message to the workers.
 * @returns The global dispatcher instance.
 */
export function getGlobalDispatcher(): WorkerDispatcher | undefined {
  return globalDispatcher;
}

function acquireGlobalDispatcher(): void {
  globalDispatcherUsers++;
  if (!globalDispatcher) {
    globalDispatcher = new WorkerDispatcher(getSharedWorkerPool(), GLOBAL_DISPATCHER_ID);
    void globalDispatcher.registerMessageHandler(MessageType.getResource, (_mapId, params, abortController) => {
      if (!abortController) {
        throw new Error('A request abort controller is required.');
      }
      return makeRequest(params, abortController);
    }).catch(() => {});
  }
}

function releaseGlobalDispatcher(): void {
  globalDispatcherUsers--;
  if (globalDispatcherUsers === 0) {
    globalDispatcher!.remove();
    globalDispatcher = undefined;
  }
}
