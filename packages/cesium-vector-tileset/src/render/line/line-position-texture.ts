import type { Primitive } from 'cesium';
import * as Cesium from 'cesium';
import { Cartesian4, PixelDatatype, PixelFormat } from 'cesium';

type PrimitiveOptions = NonNullable<ConstructorParameters<typeof Primitive>[0]>;
type LineAppearance = NonNullable<PrimitiveOptions['appearance']> & { uniforms: Record<string, unknown> };

interface NativeTexture {
  readonly width: number;
  readonly height: number;
  readonly sizeInBytes: number;
  destroy: () => void;
  isDestroyed: () => boolean;
}

// Texture, Sampler and ContextLimits are runtime exports omitted from Native's
// declarations. Keep the same local integration slice as atlas-sharing.ts.
interface CesiumRuntime {
  Texture: new (options: unknown) => NativeTexture;
  Sampler: { readonly NEAREST: object };
  ContextLimits: { readonly maximumTextureSize: number };
}

const Texture = (Cesium as unknown as CesiumRuntime).Texture;
const ContextLimits = (Cesium as unknown as CesiumRuntime).ContextLimits;
const nearestSampler = (Cesium as unknown as CesiumRuntime).Sampler.NEAREST;

interface RecordLayout {
  descriptors: Cartesian4[];
  stride: number;
}

function recordLayout(records: Float32Array): RecordLayout {
  const words = new Uint32Array(records.buffer, records.byteOffset, records.length);
  const descriptors: Cartesian4[] = [];
  let bits = 0;
  for (let field = 0; field < 12; field++) {
    const seed = words[field];
    let difference = 0;
    for (let index = field + 12; index < words.length; index += 12)
      difference |= seed ^ words[index];
    const width = 32 - Math.clz32(difference);
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

function packRecords(values: Uint32Array, records: Float32Array, layout: RecordLayout, start: number): void {
  const words = new Uint32Array(records.buffer, records.byteOffset, records.length);
  const recordCount = records.length / 12;
  for (const [field, descriptor] of layout.descriptors.entries()) {
    if (!descriptor.y)
      continue;
    const part = descriptor.x >> 5;
    const shift = descriptor.x & 31;
    for (let record = 0; record < recordCount; record++) {
      const word = words[record * 12 + field] & descriptor.w;
      const offset = start + record * layout.stride + part;
      values[offset] |= word << shift;
      if (shift + descriptor.y > 32)
        values[offset + 1] |= word >>> (32 - shift);
    }
  }
}

function positionShader(source: string): string {
  for (const track of ['3D', '2D']) {
    for (const name of [`position${track}High`, `position${track}Low`, `prevOffset${track}`, `nextOffset${track}`]) {
      const declaration = `in vec3 ${name};`;
      if (source.split(declaration).length !== 2)
        throw new TypeError(`line position texture requires exactly one ${declaration}`);
      source = source.replace(declaration, '');
    }
  }
  const main = /void main\(\)\s*\{/;
  if (!main.test(source))
    throw new TypeError('line position texture requires a line vertex shader main function');
  return `
precision highp int;
uniform highp usampler2D lineRecord_texture;
uniform int lineRecord_width;
uniform int lineRecord_stride3D;
uniform highp ivec4 lineRecord_words3D[12];
uniform int lineRecord_stride2D;
uniform int lineRecord_start2D;
uniform highp ivec4 lineRecord_words2D[12];
in float a_lineRecord;
highp uvec4 lineRecord0;
highp uvec4 lineRecord1;
highp uvec4 lineRecord2;
int lineRecord_offset;
highp uvec4 lineRecord_texel(int texel)
{
    return texelFetch(lineRecord_texture, ivec2(texel % lineRecord_width, texel / lineRecord_width), 0);
}
highp uint lineRecord_part(int part)
{
    int lane = lineRecord_offset + part;
    if (lane < 4) return lineRecord0[lane];
    if (lane < 8) return lineRecord1[lane - 4];
    return lineRecord2[lane - 8];
}
void lineRecord_load(int word, int stride)
{
    int texel = word >> 2;
    lineRecord_offset = word & 3;
    lineRecord0 = uvec4(0u);
    lineRecord1 = uvec4(0u);
    lineRecord2 = uvec4(0u);
    if (stride > 0)
        lineRecord0 = lineRecord_texel(texel);
    if (lineRecord_offset + stride > 4)
        lineRecord1 = lineRecord_texel(texel + 1);
    if (lineRecord_offset + stride > 8)
        lineRecord2 = lineRecord_texel(texel + 2);
}
highp uint lineRecord_word(ivec4 descriptor)
{
    highp uint prefix = uint(descriptor.z);
    if (descriptor.y == 0) return prefix;
    int part = descriptor.x >> 5;
    int shift = descriptor.x & 31;
    highp uint word = lineRecord_part(part) >> uint(shift);
    if (shift + descriptor.y > 32)
        word |= lineRecord_part(part + 1) << uint(32 - shift);
    return prefix | (word & uint(descriptor.w));
}
${source.replace(main, match => `${match}
${(['3D', '2D'] as const).map(track => `
    vec3 position${track}High = vec3(0.0);
    vec3 position${track}Low = vec3(0.0);
    vec3 prevOffset${track} = vec3(0.0);
    vec3 nextOffset${track} = vec3(0.0);
    if (czm_morphTime != ${track === '3D' ? '0.0' : '1.0'})
    {
        lineRecord_load(${track === '2D' ? 'lineRecord_start2D + ' : ''}int(a_lineRecord) * lineRecord_stride${track}, lineRecord_stride${track});
${[`position${track}High`, `position${track}Low`, `prevOffset${track}`, `nextOffset${track}`].map((name, index) => `        ${name} = uintBitsToFloat(uvec3(${[0, 1, 2].map(component => `lineRecord_word(lineRecord_words${track}[${index * 3 + component}])`).join(', ')}));`).join('\n')}
    }
`).join('')}
`)}`;
}

/** Immutable source positions. Native vertices retain their shared record IDs. */
export class LinePositionTexture {
  readonly texture: NativeTexture;
  readonly appearance: LineAppearance;

  constructor(records: { spatial: Float32Array; planar?: Float32Array }, appearance: PrimitiveOptions['appearance'], context: object) {
    if (!appearance)
      throw new TypeError('line position texture requires an appearance');
    if (!(context as { webgl2: boolean }).webgl2)
      throw new TypeError('line position texture requires Native WebGL2 texture support');
    if (records.spatial.length % 12 !== 0 || (records.planar && records.spatial.length !== records.planar.length))
      throw new RangeError('line position texture requires matching complete spatial and planar records');
    const recordCount = records.spatial.length / 12;
    const spatial = recordLayout(records.spatial);
    // A genuinely 3D-only Scene may contain positions that cannot project.
    // Its inactive planar track is all-prefix zero, without stored records.
    const planar: RecordLayout = records.planar
      ? recordLayout(records.planar)
      : { descriptors: Array.from({ length: 12 }, () => new Cartesian4(0, 0, 0, 0)), stride: 0 };
    // Each track starts on a texel boundary, so its records retain the same
    // maximum of three texel reads as an independently packed texture.
    const planarStart = Math.ceil(recordCount * spatial.stride / 4) * 4;
    const texels = Math.max(1, Math.ceil((planarStart + recordCount * planar.stride) / 4));
    const maximum = ContextLimits.maximumTextureSize;
    const width = Math.min(maximum, Math.ceil(Math.sqrt(texels)));
    const height = Math.ceil(texels / width);
    if (recordCount === 0 || width <= 0 || height <= 0 || width > maximum || height > maximum)
      throw new RangeError(`line position texture needs ${recordCount} records (${width}x${height} texels), exceeding Native's ${maximum}x${maximum} limit`);
    const values = new Uint32Array(width * height * 4);
    packRecords(values, records.spatial, spatial, 0);
    if (records.planar)
      packRecords(values, records.planar, planar, planarStart);
    const shader = positionShader(appearance.vertexShaderSource);
    const uniforms = {
      ...(appearance as LineAppearance).uniforms,
      lineRecord_texture: undefined as NativeTexture | undefined,
      lineRecord_width: width,
      lineRecord_stride3D: spatial.stride,
      lineRecord_words3D: spatial.descriptors,
      lineRecord_stride2D: planar.stride,
      lineRecord_start2D: planarStart,
      lineRecord_words2D: planar.descriptors,
    };
    this.appearance = Object.create(Object.getPrototypeOf(appearance), {
      ...Object.getOwnPropertyDescriptors(appearance),
      vertexShaderSource: { value: shader, configurable: true },
      uniforms: { value: uniforms, writable: true, configurable: true, enumerable: true },
    }) as LineAppearance;
    // Native uploads synchronously without retaining the typed source. All
    // allocating preparation precedes GPU creation; no CPU backing is owned.
    this.texture = new Texture({
      context,
      source: { width, height, arrayBufferView: values },
      pixelFormat: PixelFormat.RGBA_INTEGER,
      pixelDatatype: PixelDatatype.UNSIGNED_INT,
      sampler: nearestSampler,
      flipY: false,
    });
    uniforms.lineRecord_texture = this.texture;
  }

  destroy(): void {
    if (!this.texture.isDestroyed())
      this.texture.destroy();
  }
}
