import type { RenderFrameState } from '../../scene/render-frame';
import type { ExtrusionDepthScene } from '../extrusion-depth-pass';
import { BoundingRectangle, Cartesian2, Cartesian4, Matrix4, PerspectiveFrustum, PixelDatatype, PixelFormat, SceneMode } from 'cesium';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtrusionDepthPass } from '../extrusion-depth-pass';

const factories = vi.hoisted(() => ({ texture: vi.fn(), framebuffer: vi.fn() }));
vi.mock('cesium', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cesium')>();
  class TextureDriver {
    constructor(options: object) { return factories.texture(options); }
  }
  class FramebufferDriver {
    constructor(options: object) { return factories.framebuffer(options); }
  }
  return {
    ...actual,
    Texture: TextureDriver,
    Framebuffer: FramebufferDriver,
    RenderState: { fromCache: (options: object) => options },
  };
});

interface Texture { sizeInBytes: number; destroy: ReturnType<typeof vi.fn<() => void>> }
interface Framebuffer { destroy: ReturnType<typeof vi.fn<() => void>> }
const datatypeSize = (PixelDatatype as unknown as { sizeInBytes: (datatype: PixelDatatype) => number }).sizeInBytes;

function harness(failure?: 'depth-texture' | 'framebuffer' | 'quad') {
  const textures: Texture[] = [];
  const framebuffers: Framebuffer[] = [];
  const shaders: Array<ReturnType<typeof vi.fn>> = [];
  let fail = failure;
  factories.texture.mockImplementation(({ width, height, pixelDatatype, pixelFormat }: { width: number; height: number; pixelDatatype: PixelDatatype; pixelFormat: number }) => {
    if (fail === 'depth-texture' && textures.length === 1) {
      fail = undefined;
      throw new Error('depth-texture allocation');
    }
    const components = pixelFormat === PixelFormat.RGBA ? 4 : 1;
    const texture = { sizeInBytes: width * height * components * datatypeSize(pixelDatatype), destroy: vi.fn() };
    textures.push(texture);
    return texture;
  });
  factories.framebuffer.mockImplementation(({ colorTextures, depthTexture }: { colorTextures: Texture[]; depthTexture: Texture }) => {
    if (fail === 'framebuffer') {
      fail = undefined;
      throw new Error('framebuffer allocation');
    }
    const framebuffer = { destroy: vi.fn(() => [...colorTextures, depthTexture].forEach(texture => texture.destroy())) };
    framebuffers.push(framebuffer);
    return framebuffer;
  });
  const uniforms = {
    projection: Matrix4.clone(Matrix4.IDENTITY),
    infiniteProjection: Matrix4.clone(Matrix4.IDENTITY),
    view: Matrix4.clone(Matrix4.IDENTITY),
    model: Matrix4.clone(Matrix4.IDENTITY),
    viewport: new BoundingRectangle(0, 0, 100, 100),
    currentFrustum: new Cartesian2(1, 1000),
    frustumPlanes: new Cartesian4(1, -1, -1, 1),
    updateFrustum: vi.fn((value: { projectionMatrix: Matrix4; infiniteProjectionMatrix?: Matrix4; near: number; far: number }) => {
      Matrix4.clone(value.projectionMatrix, uniforms.projection);
      if (value.infiniteProjectionMatrix)
        Matrix4.clone(value.infiniteProjectionMatrix, uniforms.infiniteProjection);
      uniforms.currentFrustum.x = value.near;
      uniforms.currentFrustum.y = value.far;
    }),
  };
  const composite = vi.fn();
  const context = {
    drawingBufferWidth: 100,
    drawingBufferHeight: 100,
    halfFloatingPointTexture: true,
    uniformState: uniforms,
    createViewportQuadCommand: vi.fn(() => {
      if (fail === 'quad') {
        fail = undefined;
        throw new Error('quad allocation');
      }
      const destroy = vi.fn();
      shaders.push(destroy);
      return { pass: 7, shaderProgram: { destroy }, execute: composite };
    }),
    clear: vi.fn(),
  };
  const frustum = new PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 1, near: 1, far: 1000 });
  const frame = { camera: { frustum } } as RenderFrameState;
  const scene = { highDynamicRange: false, updateDerivedCommands: vi.fn(), _frameState: { useLogDepth: false, mode: SceneMode.COLUMBUS_VIEW }, _view: { frustumCommandsList: [{ near: 1, far: 1000 }] } } as unknown as ExtrusionDepthScene;
  const source = { pass: 7, owner: {}, execute: vi.fn() };
  const pass = new ExtrusionDepthPass();
  const command = pass.prepare('buildings', [source], frame, scene);
  const caller = { framebuffer: { original: true }, viewport: new BoundingRectangle(0, 0, 100, 100), blendingEnabled: true, scissorTest: { enabled: false } };
  const execute = () => Reflect.get(command, 'execute')(context, caller);
  return { pass, frame, scene, source, execute, context, caller, uniforms, composite, textures, framebuffers, shaders };
}

beforeEach(() => vi.clearAllMocks());
describe('owned extrusion framebuffer lifetime', () => {
  it.each([
    { halfFloatingPointTexture: true, datatype: PixelDatatype.HALF_FLOAT },
    { halfFloatingPointTexture: false, datatype: PixelDatatype.FLOAT },
  ])('allocates the Native HDR color datatype ($halfFloatingPointTexture)', ({ halfFloatingPointTexture, datatype }) => {
    const value = harness();
    value.context.halfFloatingPointTexture = halfFloatingPointTexture;
    value.scene.highDynamicRange = true;
    value.execute();
    expect(factories.texture.mock.calls[0][0].pixelDatatype).toBe(datatype);
    expect(factories.texture.mock.calls[1][0].pixelDatatype).toBe(PixelDatatype.UNSIGNED_INT);
    value.pass.destroy();
  });

  it.each([
    { halfFloatingPointTexture: true, datatype: PixelDatatype.HALF_FLOAT },
    { halfFloatingPointTexture: false, datatype: PixelDatatype.FLOAT },
  ])('matches Native HDR attachment selection and rebuilds on HDR toggles ($halfFloatingPointTexture)', ({ halfFloatingPointTexture, datatype }) => {
    const value = harness();
    value.context.halfFloatingPointTexture = halfFloatingPointTexture;
    value.execute();
    expect(factories.texture.mock.calls[0][0].pixelDatatype).toBe(PixelDatatype.UNSIGNED_BYTE);
    value.scene.highDynamicRange = true;
    value.execute();
    expect(factories.texture).toHaveBeenCalledTimes(4);
    expect(factories.texture.mock.calls[2][0].pixelDatatype).toBe(datatype);
    expect(factories.texture.mock.calls[3][0].pixelDatatype).toBe(PixelDatatype.UNSIGNED_INT);
    expect(value.pass.memoryBytes).toBe(100 * 100 * (4 * datatypeSize(datatype) + 4));
    expect(value.framebuffers[0].destroy).toHaveBeenCalledTimes(1);
    value.execute();
    expect(factories.texture).toHaveBeenCalledTimes(4);
    value.scene.highDynamicRange = false;
    value.execute();
    expect(factories.texture.mock.calls[4][0].pixelDatatype).toBe(PixelDatatype.UNSIGNED_BYTE);
    expect(value.pass.memoryBytes).toBe(100 * 100 * 8);
    expect(value.framebuffers[1].destroy).toHaveBeenCalledTimes(1);
    value.pass.destroy();
    value.textures.forEach(texture => expect(texture.destroy).toHaveBeenCalledTimes(1));
    value.shaders.forEach(destroy => expect(destroy).toHaveBeenCalledTimes(1));
  });

  it.each(['depth-texture', 'framebuffer', 'quad'] as const)('rolls back partial %s allocation, then retries and destroys exactly once', (failure) => {
    const value = harness(failure);
    expect(value.execute).toThrow('allocation');
    expect(value.pass.memoryBytes).toBe(0);
    value.textures.forEach(texture => expect(texture.destroy).toHaveBeenCalledTimes(1));
    expect(value.source.execute).not.toHaveBeenCalled();
    value.execute();
    expect(value.pass.memoryBytes).toBe(100 * 100 * 8);
    expect(value.source.execute).toHaveBeenCalledTimes(1);
    value.pass.destroy();
    expect(value.pass.memoryBytes).toBe(0);
    value.textures.forEach(texture => expect(texture.destroy).toHaveBeenCalledTimes(1));
    value.framebuffers.forEach(framebuffer => expect(framebuffer.destroy).toHaveBeenCalledTimes(1));
    value.shaders.forEach(destroy => expect(destroy).toHaveBeenCalledTimes(1));
  });

  it('reuses rendered nearest pixels across bins, then rebuilds on resize and releases inactive layers', () => {
    const value = harness();
    value.scene._view.frustumCommandsList = [{ near: 1, far: 500 }, { near: 500, far: 1000 }];
    value.uniforms.updateFrustum(new PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 1, near: 1, far: 500 }));
    value.execute();
    value.uniforms.updateFrustum(new PerspectiveFrustum({ fov: Math.PI / 3, aspectRatio: 1, near: 500 * 0.9999, far: 1000 }));
    value.execute();
    expect(value.source.execute).toHaveBeenCalledTimes(1);
    expect(value.composite).toHaveBeenCalledTimes(2);
    expect(value.context.clear).toHaveBeenCalledTimes(1);
    value.context.drawingBufferWidth = 200;
    value.execute();
    expect(value.source.execute).toHaveBeenCalledTimes(2);
    expect(value.pass.memoryBytes).toBe(200 * 100 * 8);
    expect(value.framebuffers[0].destroy).toHaveBeenCalledTimes(1);
    value.pass.retain(new Set());
    expect(value.pass.memoryBytes).toBe(0);
    value.textures.forEach(texture => expect(texture.destroy).toHaveBeenCalledTimes(1));
  });

  it('restores exact Native uniforms after a draw failure and never mutates caller pass state', () => {
    const value = harness();
    const before = structuredClone(value.caller);
    const projection = Matrix4.clone(value.uniforms.projection);
    value.source.execute.mockImplementationOnce(() => {
      Matrix4.fromUniformScale(2, value.uniforms.model);
      value.uniforms.viewport.width = 10;
      throw new Error('draw failure');
    });
    expect(value.execute).toThrow('draw failure');
    expect(Matrix4.equals(value.uniforms.projection, projection)).toBe(true);
    expect(Matrix4.equals(value.uniforms.model, Matrix4.IDENTITY)).toBe(true);
    expect(value.uniforms.viewport.width).toBe(100);
    expect(value.caller).toEqual(before);
    value.execute();
    expect(value.source.execute).toHaveBeenCalledTimes(2);
    value.pass.destroy();
  });
});
