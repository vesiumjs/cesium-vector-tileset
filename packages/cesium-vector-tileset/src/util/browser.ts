import { AbortError, throwIfAborted } from './abort-error';
import { subscribe } from './evented';

export const browser = {
  /**
   * Returns a promise that resolves on the next animation frame.
   * @param abortController - Controller to abort the scheduled frame.
   * @param targetWindow - Optional window to use for requestAnimationFrame.
   *   When the map is rendered in a popup window or iframe, pass the owning
   *   window to ensure animation frames continue even when the main window
   *   is not focused.
   */
  frameAsync(abortController: AbortController, targetWindow?: Window): Promise<number> {
    return new Promise((resolve, reject) => {
      throwIfAborted(abortController.signal);
      const win = targetWindow ?? window;
      let unsubscribe: () => void;
      const frameId = win.requestAnimationFrame((timestamp) => {
        unsubscribe();
        resolve(timestamp);
      });
      const subscription = subscribe(abortController.signal, 'abort', () => {
        unsubscribe();
        win.cancelAnimationFrame(frameId);
        reject(new AbortError(abortController.signal.reason));
      }, false);
      unsubscribe = subscription.unsubscribe;
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

  get hardwareConcurrency(): number {
    return (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  },

  /** Current CSS-to-device pixel ratio for sprites, imagery and symbols. */
  get devicePixelRatio(): number {
    return typeof window !== 'undefined' && window.devicePixelRatio > 0 ? window.devicePixelRatio : 1;
  },

};
