import type { GetResourceResponse, RequestParameters } from './ajax';
import { getProtocol } from '../source/protocol-crud';
import { isWorker } from '../worker/scope';
import { AbortError, throwIfAborted } from './abort-error';
import { makeRequest, sameOrigin } from './ajax';
import { arrayBufferToImage, arrayBufferToImageBitmap, isImageBitmap } from './image';
import { scheduleRequest } from './request-scheduler';

function getImageUsingHtmlImage(requestParameters: RequestParameters, abortController: AbortController): Promise<GetResourceResponse<HTMLImageElement | ImageBitmap | null>> {
  return new Promise<GetResourceResponse<HTMLImageElement | ImageBitmap | null>>((resolve, reject) => {
    const image = new Image();
    const url = requestParameters.url;
    const credentials = requestParameters.credentials;
    if (credentials && credentials === 'include') {
      image.crossOrigin = 'use-credentials';
    }
    else if ((credentials && credentials === 'same-origin') || !sameOrigin(url)) {
      image.crossOrigin = 'anonymous';
    }

    const cancel = () => {
      // Set src to '' to actually cancel the request
      image.onerror = image.onload = null;
      image.src = '';
      reject(new AbortError(abortController.signal.reason));
    };
    abortController.signal.addEventListener('abort', cancel, { once: true });

    image.fetchPriority = 'high';
    image.onload = () => {
      image.onerror = image.onload = null;
      abortController.signal.removeEventListener('abort', cancel);
      resolve({ data: image });
    };
    image.onerror = () => {
      image.onerror = image.onload = null;
      abortController.signal.removeEventListener('abort', cancel);
      if (abortController.signal.aborted) {
        return;
      }
      reject(new Error('Could not load image. Please make sure to use a supported image type such as PNG or JPEG. Note that SVGs are not supported.'));
    };
    image.src = url;
  });
}

function arrayBufferToCanvasImageSource(data: ArrayBuffer): Promise<HTMLImageElement | ImageBitmap | null> {
  const imageBitmapSupported = typeof createImageBitmap === 'function';
  if (imageBitmapSupported) {
    return arrayBufferToImageBitmap(data);
  }
  else {
    return arrayBufferToImage(data);
  }
}

/** Loads and decodes an image, retaining metadata for expiring raster tiles. */
export async function getImage(requestParameters: RequestParameters, abortController: AbortController, supportImageRefresh: boolean = true): Promise<GetResourceResponse<HTMLImageElement | ImageBitmap | null>> {
  throwIfAborted(abortController.signal);
  const hasExplicitHeaders = Object.keys(requestParameters.headers ?? {}).length > 0;
  requestParameters.headers ||= {};
  if (!Object.keys(requestParameters.headers).some(header => header.toLowerCase() === 'accept'))
    requestParameters.headers.accept = 'image/webp,*/*';
  requestParameters.type = 'image';
  // - If refreshExpiredTiles is false, then we can use HTMLImageElement to download raster images.
  // - Fetch/XHR (via MakeRequest API) will be used to download images for following scenarios:
  //      1. Style sprites need decoded pixel data through the fetch/XHR path.
  //      2. If refreshExpiredTiles is true (default), then in order to read the image cache header,
  //          fetch/XHR request will be required
  // - For any special case handling like use of AddProtocol, worker initiated request or additional headers
  //      let makeRequest handle it.
  // - HtmlImageElement request automatically adds accept header for all the browser supported images
  const canUseHTMLImageElement = supportImageRefresh === false
    && !isWorker(globalThis)
    && !getProtocol(requestParameters.url)
    && !hasExplicitHeaders
    && (!requestParameters.method || requestParameters.method === 'GET')
    && requestParameters.body === undefined
    && requestParameters.cache === undefined
    && requestParameters.referrerPolicy === undefined;

  const getImagePromise = canUseHTMLImageElement
    ? scheduleRequest(requestParameters.url, abortController, controller => getImageUsingHtmlImage(requestParameters, controller))
    : makeRequest(requestParameters, abortController);
  const response = await getImagePromise;
  if (response.data instanceof HTMLImageElement || isImageBitmap(response.data)) {
    // Custom protocols may return decoded images directly.
    return { ...response, data: response.data };
  }
  if (response.data instanceof ArrayBuffer) {
    const image = await arrayBufferToCanvasImageSource(response.data);
    if (abortController.signal.aborted && isImageBitmap(image))
      image.close();
    throwIfAborted(abortController.signal);
    return { ...response, data: image };
  }
  if (response.data === null || response.data === undefined) {
    return { ...response, data: null };
  }
  throw new TypeError('Image request returned an unsupported response type.');
}
