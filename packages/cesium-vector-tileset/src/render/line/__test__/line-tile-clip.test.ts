import * as Cesium from 'cesium';
import { Cartesian3, Matrix3, Matrix4, SceneMode, WebMercatorProjection } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
import { CanonicalTileID } from '../../../tile/tile-id';
import { LINE_TILE_CLIP_FRAGMENT, LineTileClip } from '../line-tile-clip';
import { clipBaseline } from './line-tile-clip-baseline';

const names = ['u_line_clip_planes', 'u_line_clip_latitudes', 'u_line_clip_planar'];

// Only the GL boundary is substituted. Native reflection, callback consumption,
// matrix comparison and column-major Float32 upload all run production Cesium.
function nativeShader() {
  const uploads: number[][] = [];
  const gl = {
    FLOAT_MAT4: 35676,
    LINK_STATUS: 35714,
    ACTIVE_ATTRIBUTES: 35721,
    ACTIVE_UNIFORMS: 35718,
    createShader: () => ({}),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    createProgram: () => ({}),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    deleteShader: vi.fn(),
    useProgram: vi.fn(),
    getProgramParameter: (_program: unknown, parameter: number) => parameter === 35714 ? true : parameter === 35718 ? 3 : 0,
    getActiveUniform: (_program: unknown, index: number) => ({ name: names[index], type: 35676, size: 1 }),
    getUniformLocation: (_program: unknown, name: string) => name,
    uniformMatrix4fv: (_location: unknown, transpose: boolean, values: Float32Array) => {
      expect(transpose).toBe(false);
      uploads.push(Array.from(values));
    },
  };
  const runtime = Cesium as unknown as {
    ShaderProgram: new (options: object) => { _bind: () => void; _setUniforms: (uniforms: object, state: object, validate: boolean) => void };
  };
  const shader = new runtime.ShaderProgram({ gl, vertexShaderText: 'void main() {}', fragmentShaderText: LINE_TILE_CLIP_FRAGMENT });
  shader._bind();
  return { shader, uploads };
}

describe('packed line tile clip Native uniforms', () => {
  it.each([[0, 0, 0], [1, 0, 0], [1, 1, 1], [2, 2, 1], [22, 3495253, 1752632]])('uploads the original clip values for z%s/x%s/y%s in three matrices', (z, x, y) => {
    const tileIndex = [[0, 0, 0], [1, 0, 0], [1, 1, 1], [2, 2, 1], [22, 3495253, 1752632]].findIndex(tile => tile[0] === z && tile[1] === x && tile[2] === y);
    const clip = new LineTileClip(new CanonicalTileID(z, x, y));
    const state = { view: Matrix4.clone(Matrix4.IDENTITY) };
    const frame = { context: { uniformState: state }, mapProjection: new WebMercatorProjection(), mode: SceneMode.SCENE3D };
    const uniforms = clip.bind(frame as never);
    const { shader, uploads } = nativeShader();
    const views = [Matrix4.clone(Matrix4.IDENTITY), Matrix4.fromTranslation(new Cartesian3(0, 20037508.342789244, -800)), Matrix4.fromRotationTranslation(Matrix3.fromRotationZ(0.7), new Cartesian3(-6378000, -380, 1200))];
    for (const [index, view] of views.entries()) {
      frame.mode = [SceneMode.SCENE3D, SceneMode.SCENE2D, SceneMode.MORPHING][index];
      // Native changes its viewport/frustum view after bind, within one frame.
      state.view = view;
      uploads.length = 0;
      shader._setUniforms(uniforms, state, false);
      expect(uploads).toHaveLength(3);
      expect(uploads.flat()).toEqual(clipBaseline[tileIndex][index]);
      uploads.length = 0;
      shader._setUniforms(uniforms, state, false);
      expect(uploads).toHaveLength(0);
    }
  });
});
