import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CesiumVectorTileset } from '../cesium-vector-tileset';
import { browser } from '../util/browser';
import { ResourceType } from '../util/request';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fromUrl', () => {
  it('rejects invalid styles and destroys the failed candidate', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: 8, sources: {}, layers: [{ id: 'bad', type: 'line', source: 'missing' }] }),
    }));
    const destroy = vi.spyOn(CesiumVectorTileset.prototype, 'destroy');
    await expect(CesiumVectorTileset.fromUrl('https://example.com/style.json')).rejects.toThrow(/missing/);
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy.mock.instances[0].isDestroyed()).toBe(true);
  });

  it('cancels and destroys a candidate while style initialization is pending', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: 8, sources: {}, layers: [] }),
    }));
    const initialize = vi.spyOn(browser, 'frameAsync').mockImplementation(() => new Promise(() => {}));
    const destroy = vi.spyOn(CesiumVectorTileset.prototype, 'destroy');
    const pending = CesiumVectorTileset.fromUrl('https://example.com/style.json', { signal: controller.signal });
    const rejected = expect(pending).rejects.toHaveProperty('name', 'AbortError');
    await vi.waitFor(() => expect(initialize).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy.mock.instances[0].isDestroyed()).toBe(true);
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
