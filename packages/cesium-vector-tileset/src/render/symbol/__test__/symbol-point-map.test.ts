import { describe, expect, it } from 'vitest';
import { CollisionBoxArray, GlyphOffsetArray, SymbolInstanceArray, SymbolLineVertexArray } from '../../../data/array-types.g';
import { SymbolBucket, SymbolBuffers } from '../../../data/bucket-runtime';
import { ProgramConfigurationSet } from '../../../data/program-configuration';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { SymbolStyleLayer } from '../../../style/style-layer/symbol-style-layer';
import { CanonicalTileID } from '../../../tile/tile-id';
import { symbolBucketGeometry } from '../symbol-geometry';

describe('ground point bucket geometry', () => {
  it.each(['map', 'viewport'] as const)('retains map pitch with %s rotation without inventing line geometry', (rotation) => {
    const layer = new SymbolStyleLayer({ id: 'points', type: 'symbol', source: 'points', layout: { 'symbol-placement': 'point', 'icon-image': 'square', 'icon-size': 1, 'icon-pitch-alignment': 'map', 'icon-rotation-alignment': rotation } }, {});
    layer.recalculate(new EvaluationParameters(13), []);
    const bucket = new SymbolBucket();
    bucket.layers = [layer];
    bucket.zoom = 13;
    bucket.tilePixelRatio = 512 / 8192;
    bucket.iconSizeData = { kind: 'constant', layoutSize: 1 };
    bucket.textSizeData = { kind: 'constant', layoutSize: 24 };
    bucket.symbolInstances = new SymbolInstanceArray();
    bucket.symbolInstances.resize(1);
    bucket.symbolInstances.int16[0] = 4096;
    bucket.symbolInstances.int16[1] = 4096;
    bucket.symbolInstances.uint16[20] = 4;
    bucket.glyphOffsetArray = new GlyphOffsetArray();
    bucket.lineVertexArray = new SymbolLineVertexArray();
    bucket.text = new SymbolBuffers(new ProgramConfigurationSet([], 13));
    bucket.icon = new SymbolBuffers(new ProgramConfigurationSet([], 13));
    for (const [x, y] of [[-8, -8], [8, -8], [8, 8], [-8, 8]])
      bucket.icon.layoutVertexArray.emplaceBack(4096, 4096, x * 32, y * 32, 0, 0, 0, 0, 0, 0, 0, 0);
    bucket.icon.indexArray.emplaceBack(0, 1, 2);
    bucket.icon.indexArray.emplaceBack(0, 2, 3);
    const geometry = symbolBucketGeometry(bucket, new CanonicalTileID(13, 4096, 4096), 'point', new CollisionBoxArray()).icon!;
    expect(geometry.mapPitch).toBe(true);
    expect(geometry.viewportPerspective).toBe(false);
    expect(geometry.pointMapRotation).toBe(rotation);
    expect(geometry.instances).toHaveLength(1);
    expect(geometry.instances[0].line).toBeUndefined();
    expect(Array.from(geometry.offsets)).toEqual([-8, -8, 8, -8, 8, 8, -8, 8]);
    expect(Array.from(geometry.dynamics)).toEqual(Array.from<number>({ length: 12 }).fill(0));
  });
});
