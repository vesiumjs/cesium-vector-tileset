import type { CreditDisplay, JulianDate, Material } from 'cesium';
import { Cartesian3, Clock, Globe, Moon, Scene, SceneMode, ShadowMode, SkyAtmosphere, SkyBox, Sun, WebMercatorProjection } from 'cesium';

// These Native Scene members are omitted from Cesium's public declarations.
// Keep the render-loop, credit integration and owned Moon cleanup here.
interface SceneFrameInternals extends Scene {
  initializeFrame: () => void;
  pixelRatio: number;
  _frameState: { creditDisplay: CreditDisplay };
}

interface MoonImageMaterial extends Material {
  _textures: Record<string, unknown>;
}

interface MoonMaterialOwner extends Moon {
  _ellipsoidPrimitive: { material: MoonImageMaterial };
}

interface SceneViewOptions {
  sceneMode?: SceneMode;
  /** Drawing-buffer pixels per CSS pixel. Matches CesiumWidget's default of 1. */
  resolutionRatio?: number;
  onError: (cause: unknown) => void;
}

/** Owns the canvas, frame loop and browser lifecycle of one Cesium Scene. */
export class SceneView {
  readonly scene: Scene;
  readonly creditDisplay: CreditDisplay;
  private readonly _element: HTMLDivElement;
  private readonly _canvas: HTMLCanvasElement;
  private readonly _clock = new Clock();
  private readonly _resolutionRatio: number;
  private readonly _onError: SceneViewOptions['onError'];
  private _moon?: MoonMaterialOwner;
  private _removeRenderError?: () => void;
  private _frameId?: number;
  private _running = true;
  private _destroyed = false;
  private _width = -1;
  private _height = -1;

  constructor(container: HTMLElement, options: SceneViewOptions) {
    const ratio = options.resolutionRatio ?? 1;
    if (!Number.isFinite(ratio) || ratio <= 0)
      throw new RangeError('resolutionRatio must be a positive finite number');
    this._resolutionRatio = ratio;
    this._onError = options.onError;
    const element = this._element = document.createElement('div');
    element.className = 'cesium-widget';
    const canvas = this._canvas = document.createElement('canvas');
    element.appendChild(canvas);
    const credits = document.createElement('div');
    credits.className = 'cesium-widget-credits';
    element.appendChild(credits);
    container.appendChild(element);
    canvas.width = Math.floor(canvas.clientWidth * ratio);
    canvas.height = Math.floor(canvas.clientHeight * ratio);

    let scene: Scene | undefined;
    try {
      this.scene = scene = new Scene({
        canvas,
        creditContainer: credits,
        creditViewport: element,
        mapProjection: new WebMercatorProjection(),
        requestRenderMode: true,
        maximumRenderTimeChange: Infinity,
      });
      this.creditDisplay = (scene as SceneFrameInternals)._frameState.creditDisplay;
      scene.camera.constrainedAxis = Cartesian3.UNIT_Z;
      scene.globe = new Globe(scene.ellipsoid);
      scene.globe.shadows = ShadowMode.RECEIVE_ONLY;
      scene.skyBox = SkyBox.createEarthSkyBox();
      scene.sun = new Sun();
      scene.moon = this._moon = new Moon() as MoonMaterialOwner;
      scene.skyAtmosphere = new SkyAtmosphere(scene.ellipsoid);
      scene.debugShowFramesPerSecond = true;
      scene.rethrowRenderErrors = true;
      this.resize();
      if (options.sceneMode === SceneMode.SCENE2D)
        scene.morphTo2D(0);
      else if (options.sceneMode === SceneMode.COLUMBUS_VIEW)
        scene.morphToColumbusView(0);

      canvas.addEventListener('mousedown', this._blurActiveElement);
      canvas.addEventListener('pointerdown', this._blurActiveElement);
      canvas.addEventListener('contextmenu', this._preventDefault);
      canvas.addEventListener('selectstart', this._preventDefault);
      this._removeRenderError = scene.renderError.addEventListener((_scene: Scene, cause: unknown) => {
        this._stop();
        // Scene may still be inside render(). Dispose after its stack unwinds.
        queueMicrotask(() => this._fail(cause));
      });
      this._frameId = requestAnimationFrame(this._render);
    }
    catch (cause) {
      this._stop();
      this._removeListeners();
      try {
        this._destroyScene(scene);
      }
      finally {
        element.remove();
      }
      throw cause;
    }
  }

  resize(): void {
    if (this._destroyed)
      return;
    const width = Math.floor(this._canvas.clientWidth * this._resolutionRatio);
    const height = Math.floor(this._canvas.clientHeight * this._resolutionRatio);
    if (width === this._width && height === this._height)
      return;
    this._width = width;
    this._height = height;
    this._canvas.width = width;
    this._canvas.height = height;
    (this.scene as SceneFrameInternals).pixelRatio = this._resolutionRatio;
    if (width > 0 && height > 0) {
      const frustum = this.scene.camera.frustum;
      if ('aspectRatio' in frustum) {
        frustum.aspectRatio = width / height;
      }
      else {
        frustum.top = frustum.right * (height / width);
        frustum.bottom = -frustum.top;
      }
    }
    this.scene.requestRender();
  }

  destroy(): void {
    if (this._destroyed)
      return;
    this._destroyed = true;
    this._stop();
    this._removeListeners();
    try {
      this._destroyScene(this.scene);
    }
    finally {
      this._element.remove();
    }
  }

  private _destroyScene(scene: Scene | undefined): void {
    const moon = this._moon;
    this._moon = undefined;
    try {
      if (moon) {
        // Scene omits Moon; Moon's EllipsoidPrimitive omits its Material.
        const material = moon._ellipsoidPrimitive.material;
        try {
          material.destroy();
        }
        finally {
          // Native image rejection callbacks inspect this dictionary after
          // destroy. Do not let them destroy an already released texture.
          material._textures = {};
          moon.destroy();
          if (scene?.moon === moon)
            scene.moon = undefined;
        }
      }
    }
    finally {
      if (scene && !scene.isDestroyed()) {
        scene.camera.cancelFlight();
        scene.destroy();
      }
    }
  }

  private readonly _render = (): void => {
    this._frameId = undefined;
    if (!this._running || this._destroyed)
      return;
    try {
      this.resize();
      const canRender = this._width > 0 && this._height > 0;
      if (canRender)
        (this.scene as SceneFrameInternals).initializeFrame();
      const time: JulianDate = this._clock.tick();
      if (canRender)
        this.scene.render(time);
      if (this._running && !this._destroyed)
        this._frameId = requestAnimationFrame(this._render);
    }
    catch (cause) {
      this._fail(cause);
    }
  };

  private _stop(): void {
    this._running = false;
    if (this._frameId !== undefined)
      cancelAnimationFrame(this._frameId);
    this._frameId = undefined;
  }

  private _fail(cause: unknown): void {
    if (this._destroyed)
      return;
    try {
      this.destroy();
    }
    finally {
      this._onError(cause);
    }
  }

  private _removeListeners(): void {
    this._removeRenderError?.();
    this._removeRenderError = undefined;
    this._canvas.removeEventListener('mousedown', this._blurActiveElement);
    this._canvas.removeEventListener('pointerdown', this._blurActiveElement);
    this._canvas.removeEventListener('contextmenu', this._preventDefault);
    this._canvas.removeEventListener('selectstart', this._preventDefault);
  }

  private readonly _blurActiveElement = (): void => {
    const active = this._canvas.ownerDocument.activeElement;
    if (active instanceof HTMLElement && active !== this._canvas)
      active.blur();
  };

  private readonly _preventDefault = (event: Event): void => {
    event.preventDefault();
  };
}
