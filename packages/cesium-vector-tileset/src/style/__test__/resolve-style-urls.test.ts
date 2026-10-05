import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import { resolveStyleUrls } from '../resolve-style-urls';

const styleUrl = 'https://example.com/VectorTileServer/resources/styles/root.json';

describe('resolveStyleUrls', () => {
  it('resolves ArcGIS style resources against the style URL without changing the input', () => {
    const style = {
      version: 8,
      sprite: '../sprites/sprite',
      glyphs: '../fonts/{fontstack}/{range}.pbf',
      sources: {
        esri: { type: 'vector', url: '../../' },
        direct: { type: 'vector', tiles: ['../../tile/{z}/{y}/{x}.pbf'] },
      },
      layers: [],
    } as StyleSpecification;

    const resolved = resolveStyleUrls(style, styleUrl);

    expect(resolved.sprite).toBe('https://example.com/VectorTileServer/resources/sprites/sprite');
    expect(resolved.glyphs).toBe('https://example.com/VectorTileServer/resources/fonts/{fontstack}/{range}.pbf');
    expect(resolved.sources.esri).toEqual({ type: 'vector', url: 'https://example.com/VectorTileServer/' });
    expect(resolved.sources.direct).toEqual({
      type: 'vector',
      tiles: ['https://example.com/VectorTileServer/tile/{z}/{y}/{x}.pbf'],
    });
    expect(style.sprite).toBe('../sprites/sprite');
    expect(style.sources.esri).toEqual({ type: 'vector', url: '../../' });
    expect(style.sources.direct).toEqual({ type: 'vector', tiles: ['../../tile/{z}/{y}/{x}.pbf'] });
  });

  it('resolves each named sprite while preserving absolute resource URLs', () => {
    const style = {
      version: 8,
      sprite: [
        { id: 'default', url: '../sprites/sprite' },
        { id: 'icons', url: 'https://cdn.example.com/icons' },
      ],
      sources: { vector: { type: 'vector', tiles: ['https://cdn.example.com/{z}/{x}/{y}.pbf'] } },
      layers: [],
    } as StyleSpecification;

    const resolved = resolveStyleUrls(style, styleUrl);

    expect(resolved.sprite).toEqual([
      { id: 'default', url: 'https://example.com/VectorTileServer/resources/sprites/sprite' },
      { id: 'icons', url: 'https://cdn.example.com/icons' },
    ]);
    expect(resolved.sources.vector).toEqual(style.sources.vector);
    expect(resolved.sprite).not.toBe(style.sprite);
  });
});
