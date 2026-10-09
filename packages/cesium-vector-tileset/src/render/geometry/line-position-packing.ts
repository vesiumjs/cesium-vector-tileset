import { Cartesian4 } from 'cesium';

interface RecordLayout {
  descriptors: Cartesian4[];
  stride: number;
}

function* recordLayout(records: Float32Array): Generator<void, RecordLayout> {
  const words = new Uint32Array(records.buffer, records.byteOffset, records.length);
  const descriptors: Cartesian4[] = [];
  const differences = new Uint32Array(12);
  for (let index = 12; index < words.length; index += 12) {
    for (let field = 0; field < 12; field++) differences[field] |= words[field] ^ words[index + field];
    if (words.length > 32 * 12 && (index / 12 + 1) % 32 === 0)
      yield;
  }
  let bits = 0;
  for (let field = 0; field < 12; field++) {
    const seed = words[field];
    const width = 32 - Math.clz32(differences[field]);
    const mask = width === 32 ? -1 : 2 ** width - 1;
    // Native ivec4[] caches signed int32. Preserve the original FLOAT bits,
    // including sign-zero, in that representation and cast back in GLSL.
    descriptors.push(new Cartesian4(bits, width, seed & ~mask, mask | 0));
    bits += width;
  }
  let stride = Math.ceil(bits / 32);
  // Eleven tightly packed words can cross four texels. Twelve are aligned;
  // every other stride fits at most three texels, including unaligned nine.
  if (stride === 11)
    stride = 12;
  return { descriptors, stride };
}

function* packRecords(values: Uint32Array, records: Float32Array, layout: RecordLayout, start: number): Generator<void> {
  const words = new Uint32Array(records.buffer, records.byteOffset, records.length);
  const recordCount = records.length / 12;
  for (let record = 0; record < recordCount; record++) {
    for (let field = 0; field < 12; field++) {
      const descriptor = layout.descriptors[field];
      if (!descriptor.y)
        continue;
      const part = descriptor.x >> 5;
      const shift = descriptor.x & 31;
      const word = words[record * 12 + field] & descriptor.w;
      const offset = start + record * layout.stride + part;
      values[offset] |= word << shift;
      if (shift + descriptor.y > 32)
        values[offset + 1] |= word >>> (32 - shift);
    }
    if (recordCount > 32 && (record + 1) % 32 === 0)
      yield;
  }
}

export interface LinePositionRecords {
  spatial: Float32Array;
  planar?: Float32Array;
}

export interface PreparedLinePositionTexture {
  spatial: RecordLayout;
  planar: RecordLayout;
  planarStart: number;
  width: number;
  height: number;
  values: Uint32Array;
}

/** CPU layout and packing finish before any Native texture is allocated. */
export function* compileLinePositionTexture(records: LinePositionRecords, maximum: number): Generator<void, PreparedLinePositionTexture> {
  if (records.spatial.length % 12 !== 0 || (records.planar && records.spatial.length !== records.planar.length))
    throw new RangeError('line position texture requires matching complete spatial and planar records');
  const recordCount = records.spatial.length / 12;
  const spatial = yield* recordLayout(records.spatial);
  // A genuinely 3D-only Scene may contain positions that cannot project.
  // Its inactive planar track is all-prefix zero, without stored records.
  const planar: RecordLayout = records.planar
    ? yield* recordLayout(records.planar)
    : { descriptors: Array.from({ length: 12 }, () => new Cartesian4(0, 0, 0, 0)), stride: 0 };
    // Each track starts on a texel boundary, so its records retain the same
    // maximum of three texel reads as an independently packed texture.
  const planarStart = Math.ceil(recordCount * spatial.stride / 4) * 4;
  const texels = Math.max(1, Math.ceil((planarStart + recordCount * planar.stride) / 4));
  const width = Math.min(maximum, Math.ceil(Math.sqrt(texels)));
  const height = Math.ceil(texels / width);
  if (recordCount === 0 || width <= 0 || height <= 0 || width > maximum || height > maximum)
    throw new RangeError(`line position texture needs ${recordCount} records (${width}x${height} texels), exceeding Native's ${maximum}x${maximum} limit`);
  const values = new Uint32Array(width * height * 4);
  yield* packRecords(values, records.spatial, spatial, 0);
  if (records.planar)
    yield* packRecords(values, records.planar, planar, planarStart);
  return { spatial, planar, planarStart, width, height, values };
}
