import type { Material, Moon } from 'cesium';
import { Cartesian3, Clock, CreditDisplay, PerspectiveOffCenterFrustum, Resource, Scene, SceneMode } from 'cesium';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneView } from '../scene-view';

type SceneDouble = Scene & {
  initializeFrame: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
  pixelRatio: number;
  _frameState: { creditDisplay: CreditDisplay };
};

interface MoonImageMaterial extends Material {
  _textures: Record<string, { destroy: () => unknown }>;
  _loadedImages: { image: HTMLImageElement }[];
  _initializationError?: unknown;
  update: (context: { defaultTexture: object }) => void;
}

function moonResources(scene: Scene): { moon: Moon; material: MoonImageMaterial } {
  const moon = scene.moon as Moon & { _ellipsoidPrimitive: { material: MoonImageMaterial } };
  return { moon, material: moon._ellipsoidPrimitive.material };
}

const boundary = vi.hoisted(() => ({
  scenes: [] as SceneDouble[],
  constructorError: undefined as unknown,
  onRequestRender: undefined as ((scene: SceneDouble) => void) | undefined,
}));

// Only Scene's WebGL boundary is replaced. Native clock, credits, globe,
// sky resources and frustums retain their actual Cesium implementations.
vi.mock('cesium', async (importOriginal) => {
  const native = await importOriginal<typeof import('cesium')>();
  return {
    ...native,
    // eslint-disable-next-line prefer-arrow-callback -- Scene is constructed with new; arrows cannot implement a constructor.
    Scene: vi.fn(function (options: ConstructorParameters<typeof Scene>[0]) {
      if (boundary.constructorError !== undefined)
        throw boundary.constructorError;
      let destroyed = false;
      const scene = {
        ellipsoid: native.Ellipsoid.default,
        camera: {
          frustum: new native.PerspectiveFrustum({ aspectRatio: 1 }),
          cancelFlight: vi.fn(),
        },
        _frameState: {
          creditDisplay: new native.CreditDisplay(options.creditContainer as HTMLDivElement, '•', options.creditViewport as HTMLDivElement),
        },
        renderError: new native.Event(),
        initializeFrame: vi.fn(),
        render: vi.fn(),
        requestRender: vi.fn(() => boundary.onRequestRender?.(scene)),
        morphTo2D: vi.fn(),
        morphToColumbusView: vi.fn(),
        isDestroyed: () => destroyed,
        destroy: vi.fn(() => {
          destroyed = true;
          scene._frameState.creditDisplay.destroy();
        }),
      } as unknown as SceneDouble;
      boundary.scenes.push(scene);
      return scene;
    }),
  };
});

let container: HTMLDivElement;
let viewport: { width: number; height: number };
let callbacks: Map<number, FrameRequestCallback>;
let sceneViews: SceneView[];

function createSceneView(options: Partial<ConstructorParameters<typeof SceneView>[1]> = {}): SceneView {
  const sceneView = new SceneView(container, { onError: vi.fn(), ...options });
  sceneViews.push(sceneView);
  return sceneView;
}

function advanceFrame(): void {
  const [id, callback] = callbacks.entries().next().value!;
  callbacks.delete(id);
  callback(100);
}

beforeEach(() => {
  boundary.scenes.length = 0;
  boundary.constructorError = undefined;
  boundary.onRequestRender = undefined;
  viewport = { width: 800, height: 600 };
  callbacks = new Map();
  sceneViews = [];
  let nextId = 0;
  vi.stubGlobal('CESIUM_BASE_URL', '/');
  vi.stubGlobal('OffscreenCanvas', class {});
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextId;
    callbacks.set(id, callback);
    return id;
  }));
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => callbacks.delete(id)));
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return this instanceof HTMLCanvasElement ? viewport.width : 0;
  });
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return this instanceof HTMLCanvasElement ? viewport.height : 0;
  });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  sceneViews.forEach(sceneView => sceneView.destroy());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('sceneView', () => {
  it('releases its real Native Moon and private image Material on repeated destroy', () => {
    const sceneView = createSceneView();
    const { moon, material } = moonResources(sceneView.scene);
    try {
      sceneView.destroy();
      sceneView.destroy();
      expect(moon.isDestroyed()).toBe(true);
      expect(material.isDestroyed()).toBe(true);
    }
    finally {
      if (!moon.isDestroyed())
        moon.destroy();
      if (!material.isDestroyed())
        material.destroy();
    }
  });

  it.each(['resolve', 'reject'] as const)('settles a pending Native Moon image after destroy without reviving GPU resources (%s)', async (outcome) => {
    vi.stubGlobal('ImageBitmap', class {});
    const sceneView = createSceneView();
    const { moon, material } = moonResources(sceneView.scene);
    let resolve!: (image: HTMLImageElement) => void;
    let reject!: (cause: unknown) => void;
    const imagePromise = new Promise<HTMLImageElement>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    vi.spyOn(Resource.prototype, 'fetchImage').mockReturnValue(imagePromise);
    // GPU deletion is the boundary; the Material and image-loading callbacks
    // remain Native. A second deletion must be observable as a failure.
    let textureDestroyed = false;
    const texture = { destroy: vi.fn(() => {
      if (textureDestroyed)
        throw new Error('texture already destroyed');
      textureDestroyed = true;
    }) };
    material._textures.image = texture;
    material.uniforms.image = '/pending-moon.jpg';
    const context = { defaultTexture: {} };
    material.update(context);
    sceneView.destroy();
    const image = document.createElement('img');
    const cause = new Error('pending image failed');
    if (outcome === 'resolve')
      resolve(image);
    else
      reject(cause);
    await imagePromise.catch(() => undefined);
    await Promise.resolve();
    expect(moon.isDestroyed()).toBe(true);
    expect(material.isDestroyed()).toBe(true);
    expect(texture.destroy).toHaveBeenCalledTimes(1);
    expect(() => material.update(context)).toThrow('destroyed');
    if (outcome === 'resolve') {
      expect(material._loadedImages).toEqual([{ id: 'image', image }]);
      expect(material._textures.image).toBeUndefined();
    }
    else {
      expect(material._initializationError).toBe(cause);
      expect(material._textures.image).toBe(context.defaultTexture);
    }
  });

  it('keeps Native credits, visual resources and the default CSS-pixel resolution', () => {
    vi.stubGlobal('devicePixelRatio', 3);
    const sceneView = createSceneView();
    const scene = boundary.scenes[0];
    const canvas = container.querySelector('canvas')!;
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(scene.pixelRatio).toBe(1);
    expect(scene.camera.frustum).toHaveProperty('aspectRatio', 4 / 3);
    expect(scene.camera.constrainedAxis).toBe(Cartesian3.UNIT_Z);
    expect(scene.globe.imageryLayers.length).toBe(0);
    expect(scene.skyBox).toBeDefined();
    expect(scene.skyAtmosphere).toBeDefined();
    expect(scene.sun).toBeDefined();
    expect(scene.moon).toBeDefined();
    expect(scene.debugShowFramesPerSecond).toBe(true);
    expect(scene.rethrowRenderErrors).toBe(true);
    expect(sceneView.creditDisplay).toBe(scene._frameState.creditDisplay);
    expect(sceneView.creditDisplay).toBeInstanceOf(CreditDisplay);
  });

  it('ticks a zero-size map scene and resumes Native frames after its size becomes usable', () => {
    viewport = { width: 0, height: 0 };
    const sceneView = createSceneView();
    const scene = boundary.scenes[0];
    const tick = vi.spyOn(Clock.prototype, 'tick');
    advanceFrame();
    expect(tick).toHaveBeenCalledTimes(1);
    expect(scene.initializeFrame).not.toHaveBeenCalled();
    expect(scene.render).not.toHaveBeenCalled();
    expect(callbacks.size).toBe(1);
    viewport = { width: 640, height: 320 };
    advanceFrame();
    expect(tick).toHaveBeenCalledTimes(2);
    expect(scene.initializeFrame).toHaveBeenCalledTimes(1);
    expect(scene.render).toHaveBeenCalledTimes(1);
    expect(scene.render).toHaveBeenLastCalledWith(tick.mock.results[1].value);
    expect(scene.initializeFrame.mock.invocationCallOrder[0]).toBeLessThan(tick.mock.invocationCallOrder[1]);
    expect(tick.mock.invocationCallOrder[1]).toBeLessThan(scene.render.mock.invocationCallOrder[0]);
    expect(scene.camera.frustum).toHaveProperty('aspectRatio', 2);
    expect(callbacks.size).toBe(1);
    expect(vi.mocked(Scene)).toHaveBeenLastCalledWith(expect.objectContaining({
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
    }));
    expect(sceneView.scene).toBe(scene);
  });

  it('updates drawing dimensions, Native pixelRatio and the frustum for an explicit resolution', () => {
    createSceneView({ resolutionRatio: 2 });
    const scene = boundary.scenes[0];
    const canvas = container.querySelector('canvas')!;
    expect([canvas.width, canvas.height, scene.pixelRatio]).toEqual([1600, 1200, 2]);
    viewport = { width: 333, height: 111 };
    advanceFrame();
    expect([canvas.width, canvas.height]).toEqual([666, 222]);
    expect(scene.camera.frustum).toHaveProperty('aspectRatio', 3);
    expect(scene.requestRender).toHaveBeenCalledTimes(2);
  });

  it.each([SceneMode.SCENE2D, SceneMode.COLUMBUS_VIEW])('morphs the already-sized Native Scene to mode %s', (sceneMode) => {
    createSceneView({ sceneMode });
    const scene = boundary.scenes[0];
    const morph = sceneMode === SceneMode.SCENE2D ? scene.morphTo2D : scene.morphToColumbusView;
    expect(morph).toHaveBeenCalledWith(0);
    expect(scene.camera.frustum).toHaveProperty('aspectRatio', 4 / 3);
  });

  it('preserves an off-center frustum width when resizing its height', () => {
    createSceneView();
    const scene = boundary.scenes[0];
    scene.camera.frustum = new PerspectiveOffCenterFrustum({ left: -200, right: 200, top: 200, bottom: -200, near: 1, far: 1e6 });
    viewport = { width: 1000, height: 400 };
    advanceFrame();
    expect(scene.camera.frustum.right).toBe(200);
    expect(scene.camera.frustum.top).toBe(80);
    expect(scene.camera.frustum.bottom).toBe(-80);
  });

  it('cancels queued frames, flights and canvas listeners before releasing its Scene and DOM', () => {
    const sibling = document.createElement('p');
    container.appendChild(sibling);
    const sceneView = createSceneView();
    const scene = boundary.scenes[0];
    const canvas = container.querySelector('canvas')!;
    const queued = callbacks.values().next().value!;
    const input = document.createElement('input');
    container.appendChild(input);
    input.focus();
    canvas.dispatchEvent(new Event('pointerdown'));
    expect(document.activeElement).not.toBe(input);
    sceneView.destroy();
    sceneView.destroy();
    input.focus();
    canvas.dispatchEvent(new Event('pointerdown'));
    expect(document.activeElement).toBe(input);
    queued(100);
    expect(scene.render).not.toHaveBeenCalled();
    expect(scene.camera.cancelFlight).toHaveBeenCalledTimes(1);
    expect(scene.destroy).toHaveBeenCalledTimes(1);
    expect(scene.renderError.numberOfListeners).toBe(0);
    expect(callbacks.size).toBe(0);
    expect(container.querySelector('canvas')).toBeNull();
    expect(sibling.parentNode).toBe(container);
  });

  it('reports a Native render failure once and disposes after render has unwound', async () => {
    const onError = vi.fn();
    createSceneView({ onError });
    const scene = boundary.scenes[0];
    const { moon, material } = moonResources(scene);
    const cause = new Error('Native render failed');
    scene.render.mockImplementation(() => {
      scene.renderError.raiseEvent(scene, cause);
      expect(scene.destroy).not.toHaveBeenCalled();
      throw cause;
    });
    advanceFrame();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledExactlyOnceWith(cause);
    expect(scene.destroy).toHaveBeenCalledTimes(1);
    expect(moon.isDestroyed()).toBe(true);
    expect(material.isDestroyed()).toBe(true);
    expect(scene.renderError.numberOfListeners).toBe(0);
    expect(callbacks.size).toBe(0);
    expect(container.childElementCount).toBe(0);
  });

  it('stops queued rendering when a Native error is raised outside the map scene RAF', async () => {
    const onError = vi.fn();
    createSceneView({ onError });
    const scene = boundary.scenes[0];
    const cause = new Error('external Native render failed');
    scene.renderError.raiseEvent(scene, cause);
    expect(callbacks.size).toBe(0);
    expect(scene.destroy).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(scene.destroy).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(cause);
  });

  it('cleans up when initializeFrame fails before Native can raise renderError', () => {
    const onError = vi.fn();
    createSceneView({ onError });
    const scene = boundary.scenes[0];
    const cause = new Error('controller update failed');
    scene.initializeFrame.mockImplementation(() => {
      throw cause;
    });
    advanceFrame();
    expect(scene.render).not.toHaveBeenCalled();
    expect(scene.destroy).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledExactlyOnceWith(cause);
    expect(callbacks.size).toBe(0);
  });

  it('removes owned DOM when Scene construction fails and exposes the original error', () => {
    const cause = new Error('WebGL context creation failed');
    boundary.constructorError = cause;
    expect(() => createSceneView()).toThrow(cause);
    expect(container.childElementCount).toBe(0);
    expect(callbacks.size).toBe(0);
  });

  it('releases its real Moon and Material when Native setup fails after their creation', () => {
    const cause = new Error('Native requestRender failed during setup');
    let resources: ReturnType<typeof moonResources> | undefined;
    boundary.onRequestRender = (scene) => {
      resources = moonResources(scene);
      throw cause;
    };
    expect(() => createSceneView()).toThrow(cause);
    expect(resources!.moon.isDestroyed()).toBe(true);
    expect(resources!.material.isDestroyed()).toBe(true);
    expect(boundary.scenes[0].destroy).toHaveBeenCalledTimes(1);
    expect(container.childElementCount).toBe(0);
    expect(callbacks.size).toBe(0);
  });

  it.each([0, -1, Infinity, Number.NaN])('rejects invalid resolutionRatio %s before allocating DOM or a Scene', (resolutionRatio) => {
    expect(() => createSceneView({ resolutionRatio })).toThrow(RangeError);
    expect(container.childElementCount).toBe(0);
    expect(boundary.scenes).toHaveLength(0);
  });
});
