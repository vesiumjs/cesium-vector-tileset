import { describe, expect, it } from 'vitest';
import { CanonicalTileID } from '../tile-id';

describe('tile URL bounding boxes', () => {
  it.each([
    [0, 0, 0, [-20037508.342789244, -20037508.342789244, 20037508.342789244, 20037508.342789244]],
    [1, 0, 0, [-20037508.342789244, 0, 0, 20037508.342789244]],
    [1, 1, 1, [0, -20037508.342789244, 20037508.342789244, 0]],
    [2, 1, 2, [-10018754.171394622, -10018754.171394622, 0, 0]],
  ])('projects tile %i/%i/%i to EPSG:3857 meters', (z, x, y, expected) => {
    const url = new CanonicalTileID(z, x, y).url(['https://example.test/wms?bbox={bbox-epsg-3857}'], 1);
    const bounds = new URL(url).searchParams.get('bbox')!.split(',').map(Number);
    bounds.forEach((value, index) => expect(value).toBeCloseTo(expected[index], 6));
  });

  it('keeps geographic bounds when the URL uses TMS row numbering', () => {
    const tile = new CanonicalTileID(2, 1, 2);
    const templates = ['https://example.test/{z}/{x}/{y}?bbox={bbox-epsg-3857}'];
    const xyz = new URL(tile.url(templates, 1));
    const tms = new URL(tile.url(templates, 1, 'tms'));
    expect(xyz.pathname).toBe('/2/1/2');
    expect(tms.pathname).toBe('/2/1/1');
    expect(tms.searchParams.get('bbox')).toBe(xyz.searchParams.get('bbox'));
  });
});
