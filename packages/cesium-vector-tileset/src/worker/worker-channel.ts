import type { Subscription } from '../util/evented';
import type { MessageType, RequestResponseMessageMap, WorkerMessage } from './messages';
import type { Serialized } from './transfer-registry';
import { AbortError } from '../util/abort-error';

import { ensureError } from '../util/errors';
import { subscribe } from '../util/evented';
import { isWorker } from './scope';
import { createTileTransferRegistry } from './tile-transfer';

/**
 * An interface to be sent to the channel in order for it to allow communication between the worker and the main thread
 */
export interface WorkerEndpoint {
  addEventListener: typeof window.addEventListener;
  removeEventListener: typeof window.removeEventListener;
  postMessage: typeof window.postMessage;
  terminate?: () => void;
}

/**
 * This is used to define the parameters of the message that is sent to the worker and back
 */
interface WireMessage {
  id: string;
  type: MessageType | '<cancel>' | '<response>';
  origin: string;
  data?: Serialized;
  targetMapId?: string | number;
  mustQueue?: boolean;
  error?: Serialized;
  sourceMapId?: string | number;
  notification?: boolean;
}

interface PendingRequest {
  resolve: (value?: RequestResponseMessageMap[MessageType][1]) => void;
  reject: (reason?: Error) => void;
  cancel: () => void;
}

/**
 * This interface allowing to substitute only the sendAsync method of the WorkerChannel class.
 */
export interface WorkerMessageSender {
  sendAsync: <T extends MessageType>(message: WorkerMessage<T>, abortController?: AbortController) => Promise<RequestResponseMessageMap[T][1]>;
}

export type MessageHandler<T extends MessageType> = {
  // The registry is indexed by a runtime message tag. Keep the public
  // generic registration API precise while allowing the erased registry to
  // store handlers for all tags.
  bivarianceHack: (mapId: string | number, params: RequestResponseMessageMap[T][0], abortController?: AbortController) => Promise<RequestResponseMessageMap[T][1]>;
}['bivarianceHack'];

const addEventDefaultOptions: AddEventListenerOptions = { once: true };

/** Sends cancellable tile-processing messages and restores transferred responses. */
export class WorkerChannel implements WorkerMessageSender {
  target: WorkerEndpoint;
  mapId?: string | number;
  pendingRequests: { [x: string]: PendingRequest };
  tasks: { [x: string]: WireMessage };
  taskQueue: string[];
  abortControllers: { [x: number | string]: AbortController };
  private taskChannel?: MessageChannel;
  private taskScheduled = false;
  messageHandlers: Partial<Record<MessageType, MessageHandler<MessageType>>>;
  subscription: Subscription;
  private removed = false;
  private failure?: Error;
  private readonly transferRegistry = createTileTransferRegistry();

  /**
   * @param target - The target
   * @param mapId - A unique identifier for the Map instance using this WorkerChannel.
   */
  constructor(target: WorkerEndpoint, mapId?: string | number) {
    this.target = target;
    this.mapId = mapId;
    this.pendingRequests = {};
    this.tasks = {};
    this.taskQueue = [];
    this.abortControllers = {};
    this.messageHandlers = {};
    this.taskChannel = new MessageChannel();
    this.taskChannel.port2.onmessage = () => {
      this.taskScheduled = false;
      this.processNextMessage();
    };
    this.subscription = subscribe<MessageEvent<WireMessage>>(this.target, 'message', message => this.receive(message), false);
  }

  registerMessageHandler<T extends MessageType>(type: T, handler: MessageHandler<T>): void {
    this.messageHandlers[type] = handler;
  }

  unregisterMessageHandler<T extends MessageType>(type: T): void {
    delete this.messageHandlers[type];
  }

  /** Post a one-way control message without a cancellable response lease. */
  notify<T extends MessageType>(message: WorkerMessage<T>): void {
    if (this.removed) {
      return;
    }
    const buffers: Transferable[] = [];
    const notification: WireMessage = {
      ...message,
      id: Math.round((Math.random() * 1e18)).toString(36).substring(0, 10),
      sourceMapId: this.mapId,
      origin: location.origin,
      data: this.transferRegistry.serialize(message.data, buffers),
      notification: true,
    };
    this.target.postMessage(notification, { transfer: buffers });
  }

  /**
   * Sends a message from a main-thread map to a Worker or from a Worker back to
   * a main-thread map instance.
   * @param message - the message to send
   * @param abortController - an optional AbortController to abort the request
   * @returns a promise that will be resolved with the response data
   */
  sendAsync<T extends MessageType>(message: WorkerMessage<T>, abortController?: AbortController): Promise<RequestResponseMessageMap[T][1]> {
    if (this.removed) {
      return Promise.reject(this.failure ?? new AbortError('WorkerChannel has been removed'));
    }

    if (abortController?.signal.aborted) {
      return Promise.reject(new AbortError(abortController.signal.reason));
    }

    return new Promise((resolve, reject) => {
      // We're using a string ID instead of numbers because they are being used as object keys
      // anyway, and thus stringified implicitly. We use random IDs because a channel may receive
      // message from multiple other channels which could run in different execution context. A
      // linearly increasing ID could produce collisions.
      const id = Math.round((Math.random() * 1e18)).toString(36).substring(0, 10);

      let settled = false;
      let subscription: Subscription | undefined;
      const postCancel = () => {
        const cancelMessage: WireMessage = {
          id,
          type: '<cancel>',
          origin: location.origin,
          targetMapId: message.targetMapId,
          sourceMapId: this.mapId,
        };
        try {
          this.target.postMessage(cancelMessage);
        }
        catch {
          // The worker may already have been terminated while its request was
          // being canceled. The local promise still must settle.
        }
      };
      const rejectAndCancel = (reason: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        delete this.pendingRequests[id];
        subscription?.unsubscribe();
        postCancel();
        reject(reason);
      };
      const resolveRequest = (value?: RequestResponseMessageMap[MessageType][1]) => {
        if (settled) {
          return;
        }
        settled = true;
        delete this.pendingRequests[id];
        subscription?.unsubscribe();
        resolve(value);
      };
      const rejectRequest = (reason?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        delete this.pendingRequests[id];
        subscription?.unsubscribe();
        reject(reason);
      };

      subscription = abortController
        ? subscribe(abortController.signal, 'abort', () => {
            rejectAndCancel(new AbortError(abortController.signal.reason));
          }, addEventDefaultOptions)
        : undefined;

      this.pendingRequests[id] = {
        resolve: resolveRequest,
        reject: rejectRequest,
        cancel: () => rejectAndCancel(new AbortError('WorkerChannel has been removed')),
      };

      // AbortSignal does not replay an event for listeners added after the
      // signal became aborted. Re-check after installing the listener to
      // close the check/subscribe race and settle the caller instead of
      // leaving a request in pendingRequests forever.
      if (abortController?.signal.aborted) {
        rejectAndCancel(new AbortError(abortController.signal.reason));
        return;
      }

      try {
        const buffers: Transferable[] = [];
        const messageToPost: WireMessage = {
          ...message,
          id,
          sourceMapId: this.mapId,
          origin: location.origin,
          data: this.transferRegistry.serialize(message.data, buffers),
        };
        this.target.postMessage(messageToPost, { transfer: buffers });
      }
      catch (err) {
        rejectRequest(ensureError(err));
      }
    });
  }

  receive(message: { data: WireMessage }): void {
    if (this.removed) {
      return;
    }
    const data = message.data;
    const id = data.id;

    const SPECIAL_ORIGINS = ['file://', 'resource://android', 'null'];
    const origins = [data.origin, location.origin];

    const isSameOrigin = data.origin === location.origin;
    const hasSpecialOrigin = origins.some(origin => SPECIAL_ORIGINS.includes(origin));

    // Ignore cross-origin messages except for special origins.
    if (!isSameOrigin && !hasSpecialOrigin) {
      return;
    }
    if (data.targetMapId !== undefined && this.mapId !== data.targetMapId) {
      return;
    }
    if (data.type === '<cancel>') {
      // Remove the original request from the queue. This is only possible if it
      // hasn't been kicked off yet. The id will remain in the queue, but because
      // there is no associated task, it will be dropped once it's time to execute it.
      delete this.tasks[id];
      const abortController = this.abortControllers[id];
      delete this.abortControllers[id];
      if (abortController) {
        abortController.abort();
      }
      return;
    }
    if (isWorker(globalThis) || data.mustQueue) {
      // Start one message per MessageChannel turn so cancellation can arrive
      // between handlers. Async handlers remain concurrent: a waiting handler
      // may need a response from a later turn to finish.
      this.tasks[id] = data;
      this.taskQueue.push(id);
      this.scheduleNextMessage();
      return;
    }
    // In the main thread, process messages immediately so that other work does not slip in
    // between getting partial data back from workers.
    void this.handleMessage(id, data).catch(() => {});
  }

  private scheduleNextMessage(): void {
    if (this.removed || this.taskScheduled)
      return;
    this.taskScheduled = true;
    this.taskChannel?.port1.postMessage(true);
  }

  /** Process one queued message, yielding between messages so cancellation can arrive. */
  processNextMessage(): void {
    if (this.removed) {
      return;
    }
    if (this.taskQueue.length === 0) {
      return;
    }
    const id = this.taskQueue.shift();
    if (id === undefined) {
      return;
    }
    const task = this.tasks[id];
    delete this.tasks[id];
    // Schedule another message turn if we know there's more to process _before_ invoking the
    // current task. This is necessary so that processing continues even if the current task
    // doesn't execute successfully.
    if (this.taskQueue.length > 0) {
      this.scheduleNextMessage();
    }
    if (!task) {
      // If the task ID doesn't have associated task data anymore, it was canceled.
      return;
    }

    void this.handleMessage(id, task).catch(() => {});
  }

  private async handleMessage(id: string, task: WireMessage): Promise<void> {
    if (task.type === '<response>') {
      // The `sendResponse` function in the counterpart channel has been called, and we are now
      // resolving or rejecting the promise in the originating channel, if there is one.
      const pendingRequest = this.pendingRequests[id];
      delete this.pendingRequests[id];
      if (!pendingRequest) {
        // If we get a response, but don't have a resolve or reject, the request was canceled.
        return;
      }
      if (task.error) {
        pendingRequest.reject(ensureError(this.transferRegistry.deserialize(task.error)));
      }
      else {
        pendingRequest.resolve(this.transferRegistry.deserialize(task.data) as RequestResponseMessageMap[MessageType][1]);
      }
      return;
    }
    if (task.type === '<cancel>') {
      return;
    }
    const handler = this.messageHandlers[task.type];
    if (!handler) {
      // This might be the case of a custom worker code sending messages to the main thread.
      // No need to do anything.
      // This can be changed for debug in case there's a need to make sure all messages are being handled.
      if (!task.notification) {
        this.sendResponse(id, undefined, null);
      }
      return;
    }
    const params = this.transferRegistry.deserialize(task.data) as RequestResponseMessageMap[MessageType][0];
    if (task.notification) {
      await handler(task.sourceMapId as string | number, params);
      return;
    }
    const abortController = new AbortController();
    this.abortControllers[id] = abortController;
    try {
      const data = await handler(task.sourceMapId as string | number, params, abortController);
      this.sendResponse(id, undefined, data);
    }
    catch (err) {
      this.sendResponse(id, ensureError(err));
    }
  }

  private sendResponse(id: string, err?: Error, data?: RequestResponseMessageMap[MessageType][1] | null): void {
    if (this.removed) {
      delete this.abortControllers[id];
      return;
    }
    const buffers: Transferable[] = [];
    delete this.abortControllers[id];
    const responseMessage: WireMessage = {
      id,
      type: '<response>',
      sourceMapId: this.mapId,
      origin: location.origin,
      error: err ? this.transferRegistry.serialize(err) : undefined,
      data: this.transferRegistry.serialize(data, buffers),
    };
    try {
      this.target.postMessage(responseMessage, { transfer: buffers });
    }
    catch {
      // The counterpart may have been terminated between the removed check
      // and posting the response. There is no live caller to notify here.
    }
  }

  /** Stop every lease when the pooled worker can no longer deliver responses. */
  fail(error: Error): void {
    if (this.removed) {
      return;
    }
    this.failure = error;
    this.remove();
  }

  remove(): void {
    if (this.removed) {
      return;
    }
    this.removed = true;
    if (this.taskChannel) {
      this.taskChannel.port2.onmessage = null;
      this.taskChannel.port1.close();
      this.taskChannel.port2.close();
      this.taskChannel = undefined;
    }
    this.taskScheduled = false;
    this.subscription.unsubscribe();

    for (const id of Object.keys(this.pendingRequests)) {
      if (this.failure) {
        this.pendingRequests[id]?.reject(this.failure);
      }
      else {
        this.pendingRequests[id]?.cancel();
      }
    }
    this.pendingRequests = {};

    for (const id of Object.keys(this.abortControllers)) {
      this.abortControllers[id]?.abort();
    }
    this.abortControllers = {};
    this.tasks = {};
    this.taskQueue = [];
    this.messageHandlers = {};
  }
}
