import { AbortError } from './abort-error';
import { subscribe } from './evented';

let linkEl;

/** */
export const browser = {
  /**
   * Schedules a callback to be invoked on the next animation frame.
   * @param abortController - Controller to abort the scheduled frame.
   * @param fn - Callback to invoke with the paint start timestamp.
   * @param reject - Callback to invoke if the frame is aborted.
   * @param targetWindow - Optional window to use for requestAnimationFrame.
   *   When the map is rendered in a popup window or iframe, pass the owning
   *   window to ensure animation frames continue even when the main window
   *   is not focused.
   */
  frame(abortController: AbortController, fn: (paintStartTimestamp: number) => void, reject: (error: Error) => void, targetWindow?: Window): void {
    const win = targetWindow || window;
    let unsubscribe: () => void = () => {};
    const frameId = win.requestAnimationFrame((paintStartTimestamp) => {
      unsubscribe();
      fn(paintStartTimestamp);
    });
    const subscription = subscribe(abortController.signal, 'abort', () => {
      unsubscribe();
      win.cancelAnimationFrame(frameId);
      reject(new AbortError(abortController.signal.reason));
    }, false);
    unsubscribe = subscription.unsubscribe;
  },

  /**
   * Returns a promise that resolves on the next animation frame.
   * @param abortController - Controller to abort the scheduled frame.
   * @param targetWindow - Optional window to use for requestAnimationFrame.
   * @see {@link browser.frame}
   */
  frameAsync(abortController: AbortController, targetWindow?: Window): Promise<number> {
    return new Promise((resolve, reject) => {
      this.frame(abortController, resolve, reject, targetWindow);
    });
  },

  getImageCanvasContext(img: HTMLImageElement | ImageBitmap): CanvasRenderingContext2D {
    const canvas = window.document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new Error('failed to create canvas 2d context');
    }
    canvas.width = img.width;
    canvas.height = img.height;
    context.drawImage(img, 0, 0, img.width, img.height);
    return context;
  },

  resolveURL(path: string): string {
    linkEl ||= document.createElement('a');
    linkEl.href = path;
    return linkEl.href;
  },

  get hardwareConcurrency(): number {
    return (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  },

  /** Current CSS-to-device pixel ratio for sprites, imagery and symbols. */
  get devicePixelRatio(): number {
    return typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  },

};
