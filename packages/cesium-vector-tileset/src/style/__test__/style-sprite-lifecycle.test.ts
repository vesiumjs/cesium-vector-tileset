import type { GetResourceResponse, RequestParameters } from '../../util/ajax';
import type { Style } from '../style';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CesiumVectorTileset } from '../../cesium-vector-tileset';
import { addProtocol, removeProtocol } from '../../source/protocol-crud';
import { ImageRequest } from '../../util/image-request';

interface SpriteRequest {
  parameters: RequestParameters;
  signal: AbortSignal;
  resolve: (response: GetResourceResponse<unknown>) => void;
  reject: (error: Error) => void;
}

const spriteUrl = (name: string) => `sprite-test://${name}/sprite`;
const emptyStyle = { version: 8 as const, sources: {}, layers: [] };
let requests: SpriteRequest[];
let pixels: WeakMap<HTMLImageElement, Uint8ClampedArray>;

beforeEach(() => {
  requests = [];
  pixels = new WeakMap();
  vi.stubGlobal('OffscreenCanvas', class {});
  addProtocol('sprite-test', (parameters, controller) => new Promise((resolve, reject) => {
    // A decoder or a custom protocol may already have queued its result when
    // cancellation arrives. Its late result still crosses the real loader.
    requests.push({ parameters, signal: controller.signal, resolve, reject });
  }));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let data = new Uint8ClampedArray(4);
    return {
      canvas: this,
      drawImage: (image: HTMLImageElement) => { data = pixels.get(image)!; },
      getImageData: () => ({ width: 1, height: 1, data }),
    } as unknown as CanvasRenderingContext2D;
  });
});

afterEach(() => {
  for (const request of requests) request.reject(new Error('Sprite test finished'));
  removeProtocol('sprite-test');
  ImageRequest.resetRequestQueue();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function spriteRequests(name: string, skip = 0): Promise<SpriteRequest[]> {
  const prefix = spriteUrl(name);
  await vi.waitFor(() => expect(requests.filter(request => request.parameters.url.startsWith(prefix)).slice(skip)).toHaveLength(2));
  return requests.filter(request => request.parameters.url.startsWith(prefix)).slice(skip);
}

function completeSprite(pending: SpriteRequest[], id: string, rgba: number[]): void {
  for (const request of pending) {
    if (request.parameters.type === 'json') {
      request.resolve({ data: { [id]: { width: 1, height: 1, x: 0, y: 0, pixelRatio: 1 } } });
    }
    else {
      const image = document.createElement('img');
      image.width = image.height = 1;
      pixels.set(image, new Uint8ClampedArray(rgba));
      request.resolve({ data: image });
    }
  }
}

async function createTileset() {
  const tileset = new CesiumVectorTileset({ style: emptyStyle });
  await tileset.whenReady();
  return { tileset, style: (tileset as unknown as { _renderer: { style: Style } })._renderer.style };
}

describe('sprite request ownership', () => {
  it.each(['success', 'error'] as const)('keeps the latest public style pending after a superseded sprites late %s', async (outcome) => {
    const { tileset, style } = await createTileset();
    try {
      tileset.setStyle({ ...emptyStyle, sprite: spriteUrl('a') });
      const first = await spriteRequests('a');
      tileset.setStyle({ ...emptyStyle, sprite: spriteUrl('b') });
      const second = await spriteRequests('b');
      const changed = vi.fn();
      const failed = vi.fn();
      style.on('data', changed);
      tileset.errorEvent.addEventListener(failed);
      if (outcome === 'success') {
        completeSprite(first, 'old', [255, 0, 0, 255]);
      }
      else {
        for (const request of first) request.reject(new Error('Superseded sprite failed'));
      }
      await vi.waitFor(() => expect(first.every(request => request.signal.aborted)).toBe(true));
      // Flush the loader's success and finalization, not just its transport.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(style.getImage('old')).toBeUndefined();
      expect(tileset.tilesLoaded).toBe(false);
      expect(changed).not.toHaveBeenCalled();
      expect(failed).not.toHaveBeenCalled();
      expect(second.every(request => !request.signal.aborted)).toBe(true);

      completeSprite(second, 'new', [0, 255, 0, 255]);
      await vi.waitFor(() => expect(tileset.tilesLoaded).toBe(true));
      expect(style.getImage('old')).toBeUndefined();
      expect(style.getImage('new').data.data).toEqual(new Uint8Array([0, 255, 0, 255]));
      expect(changed).toHaveBeenCalledOnce();
    }
    finally {
      if (!tileset.isDestroyed())
        tileset.destroy();
    }
  });

  it('makes a public style without a sprite ready and ignores the unloaded sprites late result', async () => {
    const { tileset, style } = await createTileset();
    try {
      tileset.setStyle({ ...emptyStyle, sprite: spriteUrl('a') });
      const pending = await spriteRequests('a');
      tileset.setStyle(emptyStyle);
      expect(pending.every(request => request.signal.aborted)).toBe(true);
      expect(tileset.tilesLoaded).toBe(true);
      const changed = vi.fn();
      style.on('data', changed);
      completeSprite(pending, 'removed', [255, 0, 0, 255]);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(style.getImage('removed')).toBeUndefined();
      expect(tileset.tilesLoaded).toBe(true);
      expect(changed).not.toHaveBeenCalled();
    }
    finally {
      if (!tileset.isDestroyed())
        tileset.destroy();
    }
  });

  it('cancels every superseded sprite and prevents late commits after the tileset is destroyed', async () => {
    const { tileset, style } = await createTileset();
    try {
      tileset.setStyle({ ...emptyStyle, sprite: spriteUrl('a') });
      const first = await spriteRequests('a');
      tileset.setStyle({ ...emptyStyle, sprite: spriteUrl('b') });
      const second = await spriteRequests('b');
      const broadcast = vi.spyOn(style.dispatcher, 'broadcast');
      tileset.destroy();
      expect([...first, ...second].every(request => request.signal.aborted)).toBe(true);
      broadcast.mockClear();
      completeSprite(first, 'old', [255, 0, 0, 255]);
      completeSprite(second, 'new', [0, 255, 0, 255]);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(style.images.listImages()).toEqual([]);
      expect(broadcast).not.toHaveBeenCalled();
      expect(tileset.isDestroyed()).toBe(true);
    }
    finally {
      if (!tileset.isDestroyed())
        tileset.destroy();
    }
  });

  it('keeps the existing sprite namespace when another sprite is added', async () => {
    const { tileset, style } = await createTileset();
    try {
      tileset.setStyle({ ...emptyStyle, sprite: [{ id: 'base', url: spriteUrl('a') }] });
      completeSprite(await spriteRequests('a'), 'icon', [255, 0, 0, 255]);
      await vi.waitFor(() => expect(tileset.tilesLoaded).toBe(true));
      expect(style.listImages()).toEqual(['base:icon']);

      const complete = vi.fn();
      style.addSprite('extra', spriteUrl('b'), {}, complete);
      const extra = await spriteRequests('b');
      // Complete any reload of the existing sprite as well. The assertion
      // concerns namespace ownership, independent of HTTP cache policy.
      completeSprite(requests.filter(request => request.parameters.url.startsWith(spriteUrl('a'))), 'icon', [255, 0, 0, 255]);
      completeSprite(extra, 'icon', [0, 255, 0, 255]);
      await vi.waitFor(() => expect(tileset.tilesLoaded).toBe(true));
      expect(style.listImages().sort()).toEqual(['base:icon', 'extra:icon']);
      expect(style.getImage('base:icon').data.data).toEqual(new Uint8Array([255, 0, 0, 255]));
      expect(style.getImage('extra:icon').data.data).toEqual(new Uint8Array([0, 255, 0, 255]));
      expect(complete).toHaveBeenCalledExactlyOnceWith(undefined);
    }
    finally {
      if (!tileset.isDestroyed())
        tileset.destroy();
    }
  });

  it.each([false, true])('prevents a removed namespace from returning after a pending sprite load (retains another: %s)', async (retainBase) => {
    const { tileset, style } = await createTileset();
    try {
      tileset.setStyle({
        ...emptyStyle,
        sprite: [
          ...(retainBase ? [{ id: 'base', url: spriteUrl('a') }] : []),
          { id: 'extra', url: spriteUrl('b') },
        ],
      });
      const base = retainBase ? await spriteRequests('a') : [];
      const extra = await spriteRequests('b');
      style.removeSprite('extra');
      expect([...base, ...extra].every(request => request.signal.aborted)).toBe(true);
      const changed = vi.fn();
      style.on('data', changed);
      completeSprite(base, 'icon', [255, 0, 0, 255]);
      completeSprite(extra, 'icon', [255, 0, 0, 255]);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(style.getImage('extra:icon')).toBeUndefined();
      expect(changed).not.toHaveBeenCalled();
      expect(tileset.tilesLoaded).toBe(!retainBase);
      if (retainBase) {
        completeSprite(await spriteRequests('a', 2), 'icon', [0, 255, 0, 255]);
        await vi.waitFor(() => expect(tileset.tilesLoaded).toBe(true));
        expect(style.listImages()).toEqual(['base:icon']);
        expect(style.getImage('base:icon').data.data).toEqual(new Uint8Array([0, 255, 0, 255]));
      }
    }
    finally {
      if (!tileset.isDestroyed())
        tileset.destroy();
    }
  });
});
