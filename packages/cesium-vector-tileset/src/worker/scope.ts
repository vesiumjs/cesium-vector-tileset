import type { RTLTextPlugin } from '../source/rtl-text-plugin-worker';
import type { GetResourceResponse, RequestParameters } from '../util/ajax';
import type { AddProtocolAction } from '../util/config';
import type { TileWorker } from './tile-worker';

export interface TileWorkerScope {
  registerRTLTextPlugin: (plugin: RTLTextPlugin) => void;
  addProtocol: (customProtocol: string, loadFn: AddProtocolAction) => void;
  removeProtocol: (customProtocol: string) => void;
  makeRequest: (request: RequestParameters, abortController: AbortController) => Promise<GetResourceResponse<unknown>>;
  worker: TileWorker;
}

/**
 * Identifies the library worker global scope.
 *
 * @returns `true` inside a web worker.
 */
export function isWorker(self: unknown): self is TileWorkerScope {
  // @ts-expect-error WorkerGlobalScope is only defined inside a worker context
  return typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;
}
