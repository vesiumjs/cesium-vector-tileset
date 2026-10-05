import type { Geometry, Primitive } from 'cesium';
import { Cartesian4, ComponentDatatype, GeometryAttribute } from 'cesium';

type Appearance = NonNullable<NonNullable<ConstructorParameters<typeof Primitive>[0]>['appearance']> & { uniforms?: Record<string, unknown> };

function positionShader(source: string, morph: boolean, lanes: number): string {
  const names = ['position2DHigh', 'position2DLow', ...(morph ? ['a_positionHigh', 'a_positionLow'] : [])];
  for (const name of names) {
    const declaration = `in vec3 ${name};`;
    if (source.split(declaration).length !== 2)
      throw new TypeError(`surface positions require exactly one ${declaration}`);
    source = source.replace(declaration, '');
  }
  const main = /void main\(\)\s*\{/;
  if (!main.test(source))
    throw new TypeError('surface positions require a vertex shader main function');
  const bytes = Array.from({ length: lanes }, (_, lane) => lane === lanes - 1
    ? `    return uint(a_surface${lane}[index - ${lane * 4}]);`
    : `    if (index < ${(lane + 1) * 4}) return uint(a_surface${lane}[index - ${lane * 4}]);`).join('\n');
  const positions = names.map((name, track) => {
    const field = Math.floor(track / 2) * 6 + (track % 2) * 3;
    const values = Array.from({ length: 3 }, (_, axis) => track % 2
      ? `uintBitsToFloat(surface_word(${field + axis}))`
      : `float(int(surface_word(${field + axis}) << 16u) >> 16)`);
    return `    vec3 ${name} = vec3(${values.join(', ')});`;
  }).join('\n');
  // Prefixes, widths and offsets are uniforms. Only the bounded number of
  // byte lanes changes the shader, never the tile or its position values.
  return `
precision highp int;
${Array.from({ length: lanes }, (_, lane) => `in highp vec4 a_surface${lane};`).join('\n')}
uniform highp vec4 surface_words[${morph ? 12 : 6}];
highp uint surface_byte(int index)
{
${lanes ? bytes : '    return 0u;'}
}
highp uint surface_word(int field)
{
    vec4 descriptor = surface_words[field];
    highp uint word = uint(descriptor.z) | (uint(descriptor.w) << 16u);
    int bit = int(descriptor.x);
    int width = int(descriptor.y);
    int consumed = 0;
    // A 32-bit field at an arbitrary bit offset occupies at most five bytes.
    // Each shift is 0..31; a constant field reads no vertex bytes.
    for (int part = 0; part < 5; part++)
    {
        if (consumed == width) break;
        int count = min(8 - (bit & 7), width - consumed);
        highp uint value = surface_byte(bit >> 3) >> uint(bit & 7);
        word |= (value & ((1u << uint(count)) - 1u)) << uint(consumed);
        consumed += count;
        bit += count;
    }
    return word;
}
${source.replace(main, match => `${match}\n${positions}\n`)}`;
}

/** Native's final positions, encoded without changing a single low FLOAT bit. */
export function packSurfacePositions(geometries: Geometry[], appearance: Appearance, morph: boolean): Appearance {
  if (!appearance)
    throw new TypeError('surface positions require an appearance');
  const names = ['position2DHigh', 'position2DLow', ...(morph ? ['position3DHigh', 'position3DLow'] : [])];
  const inputs = geometries.map(geometry => names.map((name, track) => {
    const values = geometry.attributes[name].values as Float32Array;
    return track % 2 ? new Uint32Array(values.buffer, values.byteOffset, values.length) : values;
  }));
  const descriptors: Cartesian4[] = [];
  let bits = 0;
  for (const [track] of names.entries()) {
    for (let axis = 0; axis < 3; axis++) {
      let first = true;
      let seed = 0;
      let difference = 0;
      for (const channels of inputs) {
        const values = channels[track];
        for (let index = axis; index < values.length; index += 3) {
          let word = values[index];
          if (track % 2 === 0) {
            const code = word / 65536;
            if (!Number.isInteger(code) || code < -32768 || code > 32767)
              throw new RangeError('geometry encoded high exceeds signed 16-bit range');
            word = code & 0xFFFF;
          }
          if (first) {
            seed = word;
            first = false;
          }
          difference |= seed ^ word;
        }
      }
      const width = 32 - Math.clz32(difference);
      const prefix = seed & (width === 32 ? 0 : -1 << width);
      descriptors.push(new Cartesian4(bits, width, prefix & 0xFFFF, prefix >>> 16));
      bits += width;
    }
  }
  const bytes = Math.ceil(bits / 8);
  const components = Array.from({ length: Math.ceil(bytes / 4) }, (_, lane) => Math.min(4, bytes - lane * 4));
  for (const [geometryIndex, geometry] of geometries.entries()) {
    const attributes = geometry.attributes as Geometry['attributes'] & Record<string, GeometryAttribute>;
    const count = attributes.batchId.values.length;
    const streams = components.map(size => new Uint8Array(count * size));
    for (const [field, descriptor] of descriptors.entries()) {
      if (!descriptor.y)
        continue;
      const track = Math.floor(field / 3);
      const axis = field % 3;
      const values = inputs[geometryIndex][track];
      const mask = descriptor.y === 32 ? 0xFFFFFFFF : 2 ** descriptor.y - 1;
      for (let vertex = 0; vertex < count; vertex++) {
        const value = values[vertex * 3 + axis];
        let word = ((track % 2 ? value : value / 65536) & mask) >>> 0;
        let bit = descriptor.x;
        let remaining = descriptor.y;
        while (remaining > 0) {
          const byte = bit >> 3;
          const lane = byte >> 2;
          const shift = bit & 7;
          const consumed = Math.min(8 - shift, remaining);
          streams[lane][vertex * components[lane] + (byte & 3)] |= (word << shift) & 0xFF;
          word >>>= consumed;
          bit += consumed;
          remaining -= consumed;
        }
      }
    }
    for (const name of ['position2DHigh', 'position2DLow', 'position3DHigh', 'position3DLow'])
      delete attributes[name];
    for (const [lane, values] of streams.entries()) {
      attributes[`a_surface${lane}`] = new GeometryAttribute({
        componentDatatype: ComponentDatatype.UNSIGNED_BYTE,
        componentsPerAttribute: components[lane],
        normalize: false,
        values,
      });
    }
  }
  const shader = positionShader(appearance.vertexShaderSource, morph, components.length);
  return Object.create(Object.getPrototypeOf(appearance), {
    ...Object.getOwnPropertyDescriptors(appearance),
    vertexShaderSource: { value: shader, configurable: true },
    uniforms: { value: { ...appearance.uniforms, surface_words: descriptors }, writable: true, configurable: true, enumerable: true },
  }) as Appearance;
}
