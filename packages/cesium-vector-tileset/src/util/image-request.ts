import type { GetResourceResponse, RequestParameters } from './ajax';
import { getProtocol } from '../source/protocol-crud';
import { isWorker } from '../worker/scope';
import { AbortError } from './abort-error';
import { makeRequest, sameOrigin } from './ajax';
import { config } from './config';
import { ensureError } from './errors';
import { arrayBufferToImage, arrayBufferToImageBitmap, isImageBitmap } from './image';

interface PendingImageRequest {
  requestParameters: RequestParameters;
  supportImageRefresh: boolean;
  imageBitmapOptions?: ImageBitmapOptions;
  abortController?: AbortController;
  onError: (error: Error) => void;
  onSuccess: (response: GetResourceResponse<HTMLImageElement | ImageBitmap | null>) => void;
}

type HTMLImageElementWithPriority = HTMLImageElement
  & {
  // fetchPriority is experimental property supported on Chromium browsers from Version 102
  // By default images are downloaded with priority low, whereas fetch request downloads with priority high
  // https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/fetchPriority
    fetchPriority?: 'auto' | 'high' | 'low';
  };

/** Shared concurrency limit for sprite, image-source and raster-tile requests. */
let imageRequestQueue: PendingImageRequest[] = [];
let currentParallelImageRequests = 0;

/**
 * Issue queued image requests up to the concurrency limit.
 */
function processQueue(): void {
  const maxImageRequests = config.MAX_PARALLEL_IMAGE_REQUESTS;

  // limit concurrent image loads to help with raster sources performance on big screens
  for (let numImageRequests = currentParallelImageRequests;
    numImageRequests < maxImageRequests && imageRequestQueue.length > 0;
    numImageRequests++) {
    const topItemInQueue = imageRequestQueue.shift();
    if (!topItemInQueue) {
      break;
    }
    if (!topItemInQueue.abortController || topItemInQueue.abortController.signal.aborted) {
      numImageRequests--;
      // The item is discarded before any request is issued, so nothing else
      // will ever settle its promise. Leaving it pending hangs the caller
      // (raster tile loads await getImage), which leaves the tile stuck in
      // the loading state forever.
      topItemInQueue.onError(new AbortError(topItemInQueue.abortController?.signal.reason));
      continue;
    }
    doImageRequest(topItemInQueue);
  }
}

function getImageUsingHtmlImage(requestParameters: RequestParameters, abortController: AbortController): Promise<GetResourceResponse<HTMLImageElement | ImageBitmap | null>> {
  return new Promise<GetResourceResponse<HTMLImageElement | ImageBitmap | null>>((resolve, reject) => {
    const image = new Image() as HTMLImageElementWithPriority;
    const url = requestParameters.url;
    const credentials = requestParameters.credentials;
    if (credentials && credentials === 'include') {
      image.crossOrigin = 'use-credentials';
    }
    else if ((credentials && credentials === 'same-origin') || !sameOrigin(url)) {
      image.crossOrigin = 'anonymous';
    }

    abortController.signal.addEventListener('abort', () => {
      // Set src to '' to actually cancel the request
      image.src = '';
      reject(new AbortError(abortController.signal.reason));
    });

    image.fetchPriority = 'high';
    image.onload = () => {
      image.onerror = image.onload = null;
      resolve({ data: image });
    };
    image.onerror = () => {
      image.onerror = image.onload = null;
      if (abortController.signal.aborted) {
        return;
      }
      reject(new Error('Could not load image. Please make sure to use a supported image type such as PNG or JPEG. Note that SVGs are not supported.'));
    };
    image.src = url;
  });
}

export function resetRequestQueue(): void {
  imageRequestQueue = [];
  currentParallelImageRequests = 0;
}

/**
 * Request to load an image.
 * @param requestParameters - Request parameters.
 * @param abortController - allows to abort the request.
 * @param supportImageRefresh - `true`, if the image request need to support refresh based on cache headers.
 * @returns - A promise resolved when the image is loaded.
 */
export function getImage(requestParameters: RequestParameters, abortController: AbortController, supportImageRefresh: boolean = true, imageBitmapOptions?: ImageBitmapOptions): Promise<GetResourceResponse<HTMLImageElement | ImageBitmap | null>> {
  return new Promise<GetResourceResponse<HTMLImageElement | ImageBitmap | null>>((resolve, reject) => {
    requestParameters.headers ||= {};
    requestParameters.headers.accept = 'image/webp,*/*';
    Object.assign(requestParameters, { type: 'image' });
    const request: PendingImageRequest = {
      abortController,
      requestParameters,
      supportImageRefresh,
      imageBitmapOptions,
      onError: (error: Error) => {
        reject(error);
      },
      onSuccess: (response) => {
        resolve(response);
      },
    };

    imageRequestQueue.push(request);
    processQueue();
  });
}

function arrayBufferToCanvasImageSource(data: ArrayBuffer, imageBitmapOptions?: ImageBitmapOptions): Promise<HTMLImageElement | ImageBitmap | null> {
  const imageBitmapSupported = typeof createImageBitmap === 'function';
  if (imageBitmapSupported) {
    return arrayBufferToImageBitmap(data, imageBitmapOptions);
  }
  else {
    return arrayBufferToImage(data);
  }
}

async function doImageRequest(itemInQueue: PendingImageRequest) {
  const { requestParameters, supportImageRefresh, imageBitmapOptions, onError, onSuccess, abortController } = itemInQueue;
  if (!abortController) {
    return;
  }
  // - If refreshExpiredTiles is false, then we can use HTMLImageElement to download raster images.
  // - Fetch/XHR (via MakeRequest API) will be used to download images for following scenarios:
  //      1. Style image sprite will had a issue with HTMLImageElement as described
  //          here: https://github.com/mapbox/mapbox-gl-js/issues/1470
  //      2. If refreshExpiredTiles is true (default), then in order to read the image cache header,
  //          fetch/XHR request will be required
  // - For any special case handling like use of AddProtocol, worker initiated request or additional headers
  //      let makeRequest handle it.
  // - HtmlImageElement request automatically adds accept header for all the browser supported images
  const canUseHTMLImageElement = supportImageRefresh === false
    && !imageBitmapOptions
    && !isWorker(globalThis)
    && !getProtocol(requestParameters.url)
    && (!requestParameters.headers
      || Object.keys(requestParameters.headers).reduce((acc, item) => acc && item === 'accept', true));

  currentParallelImageRequests++;

  const getImagePromise = canUseHTMLImageElement
    ? getImageUsingHtmlImage(requestParameters, abortController)
    : makeRequest(requestParameters, abortController);

  try {
    const response = await getImagePromise;
    delete itemInQueue.abortController;
    if (response.data instanceof HTMLImageElement || isImageBitmap(response.data)) {
      // User using addProtocol can directly return HTMLImageElement/ImageBitmap type
      // If HtmlImageElement is used to get image then response type will be HTMLImageElement
      onSuccess({ ...response, data: response.data });
    }
    else if (response.data instanceof ArrayBuffer) {
      const img = await arrayBufferToCanvasImageSource(response.data, imageBitmapOptions);
      onSuccess({ data: img, cacheControl: response.cacheControl, expires: response.expires });
    }
    else if (response.data === null || response.data === undefined) {
      onSuccess({ ...response, data: null });
    }
    else {
      throw new TypeError('Image request returned an unsupported response type.');
    }
  }
  catch (err) {
    delete itemInQueue.abortController;
    onError(ensureError(err));
  }
  finally {
    currentParallelImageRequests--;
    processQueue();
  }
}

resetRequestQueue();

/**
 * The image request queue, exposed as a single object so callers can reference
 * the queue API (and tests can spy on it) without an ES-module namespace.
 */
export const ImageRequest = {
  resetRequestQueue,
  getImage,
};
