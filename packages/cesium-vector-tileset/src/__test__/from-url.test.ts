import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CesiumVectorTileset } from '../cesium-vector-tileset';
import { ResourceType } from '../util/request';

afterEach(() => vi.unstubAllGlobals());

describe('fromUrl', () => {
  it('cancels a pending style fetch through the supplied signal', async () => {
    const controller = new AbortController();
    const fetchStyle = vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchStyle);
    const pending = CesiumVectorTileset.fromUrl('https://example.com/style.json', { signal: controller.signal });
    const rejected = expect(pending).rejects.toHaveProperty('name', 'AbortError');
    await vi.waitFor(() => expect(fetchStyle).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
  });

  it('does not create a stale tileset when cancellation occurs during JSON decoding', async () => {
    const controller = new AbortController();
    const response = Promise.withResolvers<StyleSpecification>();
    const decode = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, url: 'https://example.com/style.json', json: decode }));
    const pending = CesiumVectorTileset.fromUrl('https://example.com/style.json', { signal: controller.signal });
    const rejected = expect(pending).rejects.toHaveProperty('name', 'AbortError');
    await vi.waitFor(() => expect(decode).toHaveBeenCalledOnce());
    controller.abort();
    response.resolve({ version: 8, sources: {}, layers: [] });
    await rejected;
  });

  it('transforms the style request and resolves its resources from the response URL', async () => {
    const style = {
      version: 8,
      sources: {},
      layers: [],
      glyphs: '../fonts/{fontstack}/{range}.pbf',
    } satisfies StyleSpecification;
    const fetchStyle = vi.fn().mockResolvedValue({
      ok: true,
      url: 'https://cdn.example.com/styles/root.json',
      json: async () => style,
    });
    vi.stubGlobal('fetch', fetchStyle);
    const transformRequest = vi.fn((url: string) => ({
      url: url.replace('origin.example.com', 'cdn.example.com'),
      headers: { Authorization: 'Bearer test-token' },
    }));

    const tileset = await CesiumVectorTileset.fromUrl('https://origin.example.com/styles/root.json', {
      transformRequest,
    });
    await tileset.whenReady();

    expect(transformRequest).toHaveBeenCalledWith('https://origin.example.com/styles/root.json', ResourceType.Style);
    expect(fetchStyle).toHaveBeenCalledWith('https://cdn.example.com/styles/root.json', expect.objectContaining({
      headers: { Authorization: 'Bearer test-token' },
    }));
    expect(tileset.styleSpec.glyphs).toBe('https://cdn.example.com/fonts/{fontstack}/{range}.pbf');
    tileset.destroy();
  });
});
