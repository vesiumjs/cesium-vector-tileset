import { Request, RequestScheduler, RequestState } from 'cesium';
import { AbortError, throwIfAborted } from './abort-error';

// Cesium's runtime exposes these methods, but omits its internal admission API
// from the generated declarations. Keep that boundary here; every HTTP request
// uses the same scheduler instance as the scene's terrain and imagery.
const scheduler = RequestScheduler as typeof RequestScheduler & {
  request: (request: Request) => Promise<void> | undefined;
  update: () => void;
};
type CancellableRequest = Request & { cancel: () => void };

const pending = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;

function scheduleUpdate(): void {
  if (timer !== undefined)
    return;
  timer = setTimeout(() => {
    timer = undefined;
    scheduler.update();
    for (const attempt of pending) attempt();
    scheduler.update();
    if (pending.size)
      scheduleUpdate();
  }, 16);
}

/**
 * Wait for Cesium admission without a second concurrency limit. The shared
 * timer also drives initial style requests before a scene starts rendering.
 * Cesium may refuse admission or cancel an issued request when its heap or
 * server fills; both cases retry while the caller still owns the request.
 */
export async function scheduleRequest<T>(url: string, controller: AbortController, perform: (controller: AbortController) => Promise<T>): Promise<T> {
  throwIfAborted(controller.signal);
  if (!/^https?:$/.test(new URL(url, window.location.href).protocol))
    return perform(controller);

  return new Promise<T>((resolve, reject) => {
    let request: CancellableRequest | undefined;
    let transport: AbortController | undefined;
    let result: { value?: T } | undefined;
    let issued = false;
    let settled = false;

    function finish(error?: unknown, result?: T): void {
      if (settled)
        return;
      settled = true;
      pending.delete(attempt);
      controller.signal.removeEventListener('abort', cancel);
      if (error !== undefined)
        reject(error);
      else
        resolve(result as T);
    }
    function cancel(): void {
      request?.cancel();
      transport?.abort(controller.signal.reason);
      finish(new AbortError(controller.signal.reason));
      // Request.cancel only marks the lease; update releases the scheduler slot.
      scheduleUpdate();
    }
    function attempt(): void {
      if (settled || issued)
        return;
      transport ||= new AbortController();
      const currentTransport = transport;
      result ||= {};
      const currentResult = result;
      request ||= new Request({
        url,
        throttle: true,
        throttleByServer: true,
        requestFunction: async () => { currentResult.value = await perform(currentTransport); },
        cancelFunction: () => currentTransport.abort(new AbortError('Request cancelled by Cesium')),
      }) as CancellableRequest;
      const currentRequest = request;
      let response: Promise<void> | undefined;
      try {
        response = scheduler.request(currentRequest);
      }
      catch (error) {
        finish(error);
        return;
      }
      if (!response)
        return;
      issued = true;
      void response.then(() => finish(undefined, currentResult.value), (error) => {
        if (settled)
          return;
        if (currentRequest.state === RequestState.CANCELLED) {
          request = undefined;
          transport = undefined;
          result = undefined;
          issued = false;
          scheduleUpdate();
        }
        else {
          finish(error);
        }
      });
    }

    controller.signal.addEventListener('abort', cancel, { once: true });
    if (controller.signal.aborted) {
      cancel();
      return;
    }
    pending.add(attempt);
    scheduleUpdate();
  });
}
