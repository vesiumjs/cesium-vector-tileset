import type { Primitive } from 'cesium';
import type { LinePositionRecords, PreparedLinePositionTexture } from '../geometry/line-position-packing';
import * as Cesium from 'cesium';
import { PixelDatatype, PixelFormat } from 'cesium';
import { compileLinePositionTexture as packLinePositions } from '../geometry/line-position-packing';

export type { LinePositionRecords, PreparedLinePositionTexture } from '../geometry/line-position-packing';

type PrimitiveOptions = NonNullable<ConstructorParameters<typeof Primitive>[0]>;
type LineAppearance = NonNullable<PrimitiveOptions['appearance']> & { uniforms: Record<string, unknown> };

interface NativeTexture {
  readonly width: number;
  readonly height: number;
  readonly sizeInBytes: number;
  copyFrom: (options: { source: { width: number; height: number; arrayBufferView: Uint32Array }; xOffset: number; yOffset: number }) => void;
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

/** CPU layout and packing use the capability of the current Native context. */
export function* compileLinePositionTexture(records: LinePositionRecords): Generator<void, PreparedLinePositionTexture> {
  return yield* packLinePositions(records, ContextLimits.maximumTextureSize);
}

/** Immutable source positions. Native vertices retain their shared record IDs. */
export class LinePositionTexture {
  readonly texture: NativeTexture;
  readonly appearance: LineAppearance;
  private _values?: Uint32Array;

  static create(records: LinePositionRecords, appearance: PrimitiveOptions['appearance'], context: object): LinePositionTexture {
    const compiler = compileLinePositionTexture(records);
    let step = compiler.next();
    while (!step.done) step = compiler.next();
    const positions = new LinePositionTexture(step.value, appearance, context);
    const upload = positions.upload();
    while (!upload.next().done) {
      // Synchronous callers explicitly finish the bounded uploader.
    }
    return positions;
  }

  constructor(prepared: PreparedLinePositionTexture, appearance: PrimitiveOptions['appearance'], context: object) {
    if (!appearance)
      throw new TypeError('line position texture requires an appearance');
    if (!(context as { webgl2: boolean }).webgl2)
      throw new TypeError('line position texture requires Native WebGL2 texture support');
    const { spatial, planar, planarStart, width, height, values } = prepared;
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
    // Allocation and bounded row writes belong to separate render admissions.
    this.texture = new Texture({
      context,
      width,
      height,
      pixelFormat: PixelFormat.RGBA_INTEGER,
      pixelDatatype: PixelDatatype.UNSIGNED_INT,
      sampler: nearestSampler,
      flipY: false,
    });
    this._values = values;
    uniforms.lineRecord_texture = this.texture;
  }

  * upload(): Generator<void> {
    const values = this._values;
    if (!values)
      return;
    const width = this.texture.width;
    const height = this.texture.height;
    const rows = Math.max(1, Math.floor(256 * 1024 / (width * 16)));
    for (let row = 0; row < height; row += rows) {
      const count = Math.min(rows, height - row);
      this.texture.copyFrom({ source: { width, height: count, arrayBufferView: values.subarray(row * width * 4, (row + count) * width * 4) }, xOffset: 0, yOffset: row });
      yield;
    }
    this._values = undefined;
  }

  destroy(): void {
    this._values = undefined;
    if (!this.texture.isDestroyed())
      this.texture.destroy();
  }
}
