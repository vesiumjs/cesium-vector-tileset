import { describe, expect, it, vi } from 'vitest';
import { ResourceType, transformRequest } from '../request';

describe('transformRequest', () => {
  it('uses the original URL when no callback is provided', () => {
    expect(transformRequest('https://example.com/tiles.json', ResourceType.Source)).toEqual({
      url: 'https://example.com/tiles.json',
    });
  });

  it('uses the original URL when the callback returns undefined', () => {
    expect(transformRequest('https://example.com/tiles.json', ResourceType.Source, () => undefined)).toEqual({
      url: 'https://example.com/tiles.json',
    });
  });

  it('preserves custom request parameters and passes the resource type', () => {
    const parameters = {
      url: 'https://cdn.example.com/tiles.json',
      headers: { Authorization: 'Bearer token' },
      credentials: 'include' as const,
    };
    const callback = vi.fn(() => parameters);

    expect(transformRequest('https://example.com/tiles.json', ResourceType.Source, callback)).toBe(parameters);
    expect(callback).toHaveBeenCalledWith('https://example.com/tiles.json', ResourceType.Source);
  });

  it('supports asynchronous request transforms', async () => {
    const parameters = { url: 'https://cdn.example.com/tile.pbf', headers: { 'X-Tile': 'custom' } };

    await expect(transformRequest('https://example.com/tile.pbf', ResourceType.Tile, async () => parameters)).resolves.toBe(parameters);
  });
});
