import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileLinePositionTexture } from '../line-position-texture';

vi.mock('cesium', async original => ({ ...await original<typeof import('cesium')>(), ContextLimits: { maximumTextureSize: 4096 } }));

afterEach(() => vi.restoreAllMocks());

function records(count: number, track: number): Float32Array {
  const words = new Uint32Array(count * 12);
  for (let point = 0; point < count; point++) {
    for (let field = 0; field < 12; field++)
      words[point * 12 + field] = field === 0 ? 0x80000000 : Math.imul(point + track, 2654435761) ^ field * 65537;
  }
  return new Float32Array(words.buffer);
}

describe('line position texture CPU compilation', () => {
  it('yields within large record scans and preserves every source word in both tracks', () => {
    const spatial = records(1000, 0);
    const planar = records(1000, 17);
    const compiler = compileLinePositionTexture({ spatial, planar });
    let step = compiler.next();
    expect(step.done).toBe(false);
    let yields = 0;
    while (!step.done) {
      yields++;
      step = compiler.next();
    }
    expect(yields).toBeGreaterThan(100);
    const packed = step.value;
    for (const [source, layout, start] of [[spatial, packed.spatial, 0], [planar, packed.planar, packed.planarStart]] as const) {
      const expected = new Uint32Array(source.buffer);
      for (let point = 0; point < 1000; point++) {
        let bits = 0n;
        for (let word = layout.stride - 1; word >= 0; word--)
          bits = (bits << 32n) | BigInt(packed.values[start + point * layout.stride + word]);
        for (let field = 0; field < 12; field++) {
          const descriptor = layout.descriptors[field];
          const value = BigInt(descriptor.z >>> 0) | ((bits >> BigInt(descriptor.x)) & BigInt(descriptor.w >>> 0));
          expect(Number(value)).toBe(expected[point * 12 + field]);
        }
      }
    }
  });

  it('finishes tiny records directly and can discard an unfinished larger compilation', () => {
    expect(compileLinePositionTexture({ spatial: records(32, 0) }).next().done).toBe(true);
    const abandoned = compileLinePositionTexture({ spatial: records(1000, 0) });
    expect(abandoned.next().done).toBe(false);
    expect(abandoned.return(undefined).done).toBe(true);
  });
});
