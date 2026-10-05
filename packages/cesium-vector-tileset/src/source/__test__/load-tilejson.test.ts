import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getJSON } from '../../util/ajax';
import { loadTileJson } from '../load-tilejson';

vi.mock('../../util/ajax', () => ({ getJSON: vi.fn() }));

beforeEach(() => vi.mocked(getJSON).mockReset());

describe('loadTileJson', () => {
  it('loads the original URL without a request transform', async () => {
    vi.mocked(getJSON).mockResolvedValue({ data: { tiles: ['tiles/{z}/{x}/{y}.pbf'] } });
    const abortController = new AbortController();

    await loadTileJson({ type: 'vector', url: 'https://example.com/tiles.json' }, undefined, abortController);

    expect(getJSON).toHaveBeenCalledWith({ url: 'https://example.com/tiles.json' }, abortController);
  });

  it('preserves asynchronous request transforms and headers for ArcGIS metadata', async () => {
    vi.mocked(getJSON).mockResolvedValue({ data: { tiles: ['tile/{z}/{y}/{x}.pbf'] } });
    const abortController = new AbortController();

    await loadTileJson(
      { type: 'vector', url: 'https://example.com/source' },
      async () => ({ url: 'https://cdn.example.com/VectorTileServer', headers: { Authorization: 'Bearer token' } }),
      abortController,
    );

    expect(getJSON).toHaveBeenCalledWith({
      url: 'https://cdn.example.com/VectorTileServer?f=json',
      headers: { Authorization: 'Bearer token' },
    }, abortController);
  });

  it('resolves TileJSON tile templates against the transformed request URL', async () => {
    vi.mocked(getJSON).mockResolvedValue({ data: {
      tilejson: '2.2.0',
      tiles: ['../tiles/{z}/{x}/{y}.pbf'],
      minzoom: 1,
      maxzoom: 12,
    } });

    const result = await loadTileJson(
      { type: 'vector', url: 'https://example.com/style/tiles.json', maxzoom: 10 },
      () => ({ url: 'https://cdn.example.com/data/metadata/tiles.json' }),
      new AbortController(),
    );

    expect(result?.tiles).toEqual(['https://cdn.example.com/data/tiles/{z}/{x}/{y}.pbf']);
    expect(result?.minzoom).toBe(1);
    expect(result?.maxzoom).toBe(10);
    expect(getJSON).toHaveBeenCalledOnce();
  });

  it('resolves relative tiles against the final URL after a TileJSON redirect', async () => {
    vi.mocked(getJSON).mockResolvedValue({
      url: 'https://cdn.example.com/redirected/metadata.json',
      data: { tiles: ['tiles/{z}/{x}/{y}.pbf'] },
    });

    const result = await loadTileJson(
      { type: 'vector', url: 'https://example.com/source' },
      undefined,
      new AbortController(),
    );

    expect(result?.tiles).toEqual(['https://cdn.example.com/redirected/tiles/{z}/{x}/{y}.pbf']);
  });

  it('loads ArcGIS VectorTileServer metadata as JSON and uses its tile levels', async () => {
    vi.mocked(getJSON).mockResolvedValue({ data: {
      tiles: ['tile/{z}/{y}/{x}.pbf'],
      tileInfo: {
        lods: [{ level: 2 }, { level: 3 }, { level: 4 }],
      },
    } });

    const result = await loadTileJson(
      { type: 'vector', url: 'https://example.com/VectorTileServer/' },
      undefined,
      new AbortController(),
    );

    const request = vi.mocked(getJSON).mock.calls[0]?.[0];
    expect(request.url).toBe('https://example.com/VectorTileServer/?f=json');
    expect(result?.tiles).toEqual(['https://example.com/VectorTileServer/tile/{z}/{y}/{x}.pbf']);
    expect(result?.minzoom).toBe(2);
    expect(result?.maxzoom).toBe(4);
  });

  it('resolves ArcGIS tiles below a VectorTileServer URL without a trailing slash', async () => {
    vi.mocked(getJSON).mockResolvedValue({ data: {
      tiles: ['tile/{z}/{y}/{x}.pbf'],
      tileInfo: { lods: [{ level: 0 }] },
    } });

    const result = await loadTileJson(
      { type: 'vector', url: 'https://example.com/VectorTileServer' },
      undefined,
      new AbortController(),
    );

    expect(result?.tiles).toEqual(['https://example.com/VectorTileServer/tile/{z}/{y}/{x}.pbf']);
  });
});
