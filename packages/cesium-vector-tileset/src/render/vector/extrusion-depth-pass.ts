import type { Camera } from 'cesium';
import type { ReplayDrawCommand } from '../scene/draw-command-replay';
import type { RenderFrameState } from '../scene/render-frame';
import * as Cesium from 'cesium';
import { BlendingState, BoundingRectangle, BoundingSphere, Cartesian2, Cartesian3, Cartesian4, Color, DepthFunction, Matrix4, PixelDatatype, PixelFormat, SceneMode, TextureMagnificationFilter, TextureMinificationFilter } from 'cesium';

interface NativeTexture { sizeInBytes: number; destroy: () => void }
interface NativeFramebuffer { destroy: () => void }
interface NativePassState { framebuffer?: NativeFramebuffer; viewport: BoundingRectangle; blendingEnabled?: boolean; scissorTest?: object }
interface NativeCommand extends ReplayDrawCommand {
  pass: number;
  execute: (context: NativeContext, state: NativePassState) => void;
  shaderProgram?: { destroy: () => void };
  derivedCommands?: { logDepth?: { command: NativeCommand }; hdr?: { command: NativeCommand } };
}
interface NativeUniformState {
  projection: Matrix4;
  infiniteProjection: Matrix4;
  view: Matrix4;
  model: Matrix4;
  viewport: BoundingRectangle;
  currentFrustum: Cartesian2;
  frustumPlanes: Cartesian4;
  updateFrustum: (frustum: object) => void;
  updateCamera: (camera: object) => void;
}
interface NativeContext {
  drawingBufferWidth: number;
  drawingBufferHeight: number;
  halfFloatingPointTexture: boolean;
  uniformState: NativeUniformState;
  createViewportQuadCommand: (shader: string, options: object) => NativeCommand;
}
export interface ExtrusionDepthScene {
  highDynamicRange: boolean;
  updateDerivedCommands: (command: object) => void;
  _frameState: { useLogDepth: boolean; mode: SceneMode };
  _view: { frustumCommandsList: Array<{ near: number; far: number }> };
  camera: Camera;
}
interface ClearCommand {
  pass: number;
  owner?: object;
  execute: (context: NativeContext, state: NativePassState) => void;
}
const runtime = Cesium as unknown as {
  Pass: { OPAQUE: number };
  ClearCommand: new (options?: object) => ClearCommand;
  PassState: new (context: NativeContext) => NativePassState;
  Texture: new (options: object) => NativeTexture;
  Framebuffer: new (options: object) => NativeFramebuffer;
  Sampler: new (options: object) => object;
  RenderState: { fromCache: (options: object) => object };
  Camera: { clone: (camera: Camera, result?: Camera) => Camera & { update: (mode: SceneMode) => void } };
};

const COMPOSITE = `
uniform sampler2D u_color;
uniform sampler2D u_depth;
uniform vec2 u_textureSize;
uniform vec4 u_viewport;
uniform mat4 u_fullInverseProjection;
uniform vec2 u_fullFrustum;
uniform vec2 u_interval;
uniform bool u_logDepth;
uniform float u_eyeOffset;

void main()
{
    vec2 texturePosition = gl_FragCoord.xy / u_textureSize;
    vec4 color = texture(u_color, texturePosition);
    if (color.a <= 0.0) discard;
    float depth = texture(u_depth, texturePosition).r;
    vec2 ndc = (gl_FragCoord.xy - u_viewport.xy) / u_viewport.zw * 2.0 - 1.0;
    vec4 eye;
    if (u_logDepth) {
        float distance = exp2(depth * log2(u_fullFrustum.y - u_fullFrustum.x + 1.0)) - 1.0 + u_fullFrustum.x;
        // The far endpoint can have w == 0 at GPU precision. Its xyz still
        // gives the exact ray direction; normalize by eye-space depth without
        // dividing by that homogeneous w.
        vec4 ray = u_fullInverseProjection * vec4(ndc, 1.0, 1.0);
        eye = vec4(ray.xyz * (distance / -ray.z), 1.0);
    } else {
        eye = u_fullInverseProjection * vec4(ndc, depth * 2.0 - 1.0, 1.0);
        eye /= eye.w;
    }
    float distance = -eye.z;
    // Native opaque frustums deliberately overlap. Composite exactly one
    // physical interval, retaining the scene depth already drawn in that bin.
    if (distance < u_interval.x || distance >= u_interval.y) discard;
    eye.z += u_eyeOffset;
    vec4 clip = czm_projection * eye;
    if (u_logDepth) {
        gl_FragDepth = log2(clip.w - czm_currentFrustum.x + 1.0) * czm_oneOverLog2FarDepthFromNearPlusOne;
    } else {
        gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
    }
    out_FragColor = color;
}
`;

class LayerCommand extends runtime.ClearCommand {
  boundingVolume?: BoundingSphere;
  cull = false;
  occlude = false;

  private _commands: NativeCommand[] = [];

  private _scene!: ExtrusionDepthScene;

  private _frustum!: Camera['frustum'];

  private _revision = 0;

  private _renderedRevision = -1;

  private _context?: NativeContext;

  private _framebuffer?: NativeFramebuffer;

  private _color?: NativeTexture;

  private _depth?: NativeTexture;

  private _composite?: NativeCommand;

  private _width = 0;

  private _height = 0;

  private _colorDatatype?: PixelDatatype;

  private readonly _view = new Matrix4();

  private readonly _viewport = new BoundingRectangle();

  private readonly _textureSize = new Cartesian2();

  private readonly _fullFrustum = new Cartesian2();

  private readonly _fullInverseProjection = new Matrix4();

  private readonly _interval = new Cartesian2();

  private readonly _quadViewport = new Cartesian4();

  private _logDepth = false;

  private _height2D = 0;

  private _eyeOffset = 0;

  private _camera2D?: Camera;

  private readonly _clear = new runtime.ClearCommand({ color: Color.TRANSPARENT, depth: 1 });

  constructor() {
    super({ pass: runtime.Pass.OPAQUE });
  }

  update(commands: readonly ReplayDrawCommand[], frame: RenderFrameState, scene: ExtrusionDepthScene): this {
    this._commands = commands as NativeCommand[];
    this._scene = scene;
    if (scene._frameState?.mode === SceneMode.SCENE2D)
      this._height2D = scene.camera.position.z;
    this._frustum = frame.camera.frustum.clone(this._frustum?.constructor === frame.camera.frustum.constructor ? this._frustum as never : undefined);
    this._revision++;
    const spheres = commands.flatMap(command => command.boundingVolume ? [command.boundingVolume] : []);
    this.boundingVolume = spheres.length ? BoundingSphere.fromBoundingSpheres(spheres, this.boundingVolume) : undefined;
    this.owner = commands[0]?.owner;
    return this;
  }

  execute = (context: NativeContext, caller: NativePassState): void => {
    this._resources(context);
    const uniforms = context.uniformState;
    const savedFrustum = {
      near: uniforms.currentFrustum.x,
      far: uniforms.currentFrustum.y,
      projectionMatrix: Matrix4.clone(uniforms.projection),
      infiniteProjectionMatrix: Matrix4.clone(uniforms.infiniteProjection),
      offCenterFrustum: { top: uniforms.frustumPlanes.x, bottom: uniforms.frustumPlanes.y, left: uniforms.frustumPlanes.z, right: uniforms.frustumPlanes.w },
    };
    const model = Matrix4.clone(uniforms.model);
    const viewport = BoundingRectangle.clone(uniforms.viewport);
    const offscreen = new runtime.PassState(context);
    offscreen.framebuffer = this._framebuffer;
    offscreen.viewport = BoundingRectangle.clone(caller.viewport);
    const is2D = this._scene._frameState.mode === SceneMode.SCENE2D;
    const shiftedHeight = is2D ? this._scene.camera.position.z : 0;
    const interval = this._scene._view.frustumCommandsList.find(bin => is2D
      ? Math.abs(bin.near - (this._height2D - shiftedHeight + 1)) < 1e-5
      : bin.far === savedFrustum.far);
    if (!interval)
      throw new Error('Extrusion compositor requires the actual Native depth-frustum interval');
    this._interval.x = interval.near;
    this._interval.y = interval.far;
    this._eyeOffset = is2D ? this._height2D - shiftedHeight : 0;
    try {
      // Native shifts the 2D camera for each linear depth bin. Resolve the
      // whole layer under its original physical view, then restore that bin's
      // camera before writing its exact projected scene depth.
      if (is2D) {
        const camera = runtime.Camera.clone(this._scene.camera, this._camera2D);
        camera.update(SceneMode.SCENE2D);
        // update establishes Native's mode/transform; retain the actual
        // viewport's un-clamped wrapped position on this owned camera.
        Cartesian3.clone(this._scene.camera.position, camera.position);
        camera.position.z = this._height2D;
        this._camera2D = camera;
        uniforms.updateCamera(camera);
      }
      if (this._renderedRevision !== this._revision || !Matrix4.equals(this._view, uniforms.view) || !BoundingRectangle.equals(this._viewport, caller.viewport)) {
        this._logDepth = this._scene._frameState.useLogDepth;
        uniforms.updateFrustum(this._frustum);
        Matrix4.inverse(this._frustum.projectionMatrix, this._fullInverseProjection);
        this._fullFrustum.x = this._frustum.near;
        this._fullFrustum.y = this._frustum.far;
        this._clear.execute(context, offscreen);
        for (const command of this._commands) {
          this._scene.updateDerivedCommands(command);
          let native = this._logDepth ? command.derivedCommands?.logDepth?.command : command;
          if (!native)
            throw new Error('Extrusion compositor requires Native log-depth derivative');
          if (this._scene.highDynamicRange && native.derivedCommands?.hdr)
            native = native.derivedCommands.hdr.command;
          native.execute(context, offscreen);
        }
        this._renderedRevision = this._revision;
        Matrix4.clone(uniforms.view, this._view);
        BoundingRectangle.clone(caller.viewport, this._viewport);
      }
      if (is2D) {
        uniforms.updateCamera(this._scene.camera);
      }
      uniforms.updateFrustum(savedFrustum);
      this._quadViewport.x = caller.viewport.x;
      this._quadViewport.y = caller.viewport.y;
      this._quadViewport.z = caller.viewport.width;
      this._quadViewport.w = caller.viewport.height;
      this._composite!.execute(context, caller);
    }
    finally {
      if (is2D) {
        uniforms.updateCamera(this._scene.camera);
      }
      uniforms.updateFrustum(savedFrustum);
      uniforms.model = model;
      uniforms.viewport = viewport;
    }
  };

  /**
   * @internal
   */
  private _resources(context: NativeContext): void {
    const width = context.drawingBufferWidth;
    const height = context.drawingBufferHeight;
    const colorDatatype = this._scene.highDynamicRange
      ? context.halfFloatingPointTexture ? PixelDatatype.HALF_FLOAT : PixelDatatype.FLOAT
      : PixelDatatype.UNSIGNED_BYTE;
    if (this._context === context && this._width === width && this._height === height && this._colorDatatype === colorDatatype && this._framebuffer && this._composite)
      return;
    this._destroyResources();
    this._textureSize.x = width;
    this._textureSize.y = height;
    const sampler = new runtime.Sampler({ minificationFilter: TextureMinificationFilter.NEAREST, magnificationFilter: TextureMagnificationFilter.NEAREST });
    try {
      this._color = new runtime.Texture({ context, width, height, pixelFormat: PixelFormat.RGBA, pixelDatatype: colorDatatype, sampler });
      this._depth = new runtime.Texture({ context, width, height, pixelFormat: PixelFormat.DEPTH_COMPONENT, pixelDatatype: PixelDatatype.UNSIGNED_INT, sampler });
      this._framebuffer = new runtime.Framebuffer({ context, colorTextures: [this._color], depthTexture: this._depth });
      this._composite = context.createViewportQuadCommand(COMPOSITE, {
        owner: this,
        renderState: runtime.RenderState.fromCache({ depthTest: { enabled: true, func: DepthFunction.LESS_OR_EQUAL }, depthMask: true, blending: BlendingState.ALPHA_BLEND }),
        uniformMap: {
          u_color: () => this._color,
          u_depth: () => this._depth,
          u_textureSize: () => this._textureSize,
          u_viewport: () => this._quadViewport,
          u_fullInverseProjection: () => this._fullInverseProjection,
          u_fullFrustum: () => this._fullFrustum,
          u_interval: () => this._interval,
          u_logDepth: () => this._logDepth,
          u_eyeOffset: () => this._eyeOffset,
        },
      });
      this._context = context;
      this._width = width;
      this._height = height;
      this._colorDatatype = colorDatatype;
      this._renderedRevision = -1;
    }
    catch (error) {
      this._destroyResources();
      throw error;
    }
  }

  /**
   * @internal
   */
  private _destroyResources(): void {
    if (this._framebuffer) {
      this._framebuffer.destroy();
    }
    else {
      // Until the framebuffer adopts attachments, the layer owns each
      // successful partial allocation independently.
      this._color?.destroy();
      this._depth?.destroy();
    }
    this._framebuffer = undefined;
    this._color = undefined;
    this._depth = undefined;
    this._composite?.shaderProgram?.destroy();
    this._composite = undefined;
    this._context = undefined;
    this._width = 0;
    this._height = 0;
    this._colorDatatype = undefined;
    this._renderedRevision = -1;
  }

  get memoryBytes(): number {
    return (this._color?.sizeInBytes ?? 0) + (this._depth?.sizeInBytes ?? 0);
  }

  destroy(): void {
    this._destroyResources();
    this._commands.length = 0;
  }
}

/** Own nearest RGBA/depth and composite exactly once per physical pixel. */
export class ExtrusionDepthPass {
  private readonly _layers = new Map<string, LayerCommand>();

  get memoryBytes(): number {
    let bytes = 0;
    for (const layer of this._layers.values())
      bytes += layer.memoryBytes;
    return bytes;
  }

  prepare(id: string, commands: readonly ReplayDrawCommand[], frame: RenderFrameState, scene: ExtrusionDepthScene): ReplayDrawCommand {
    let layer = this._layers.get(id);
    if (!layer) {
      layer = new LayerCommand();
      this._layers.set(id, layer);
    }
    return layer.update(commands, frame, scene);
  }

  retain(ids: ReadonlySet<string>): void {
    for (const [id, layer] of this._layers) {
      if (!ids.has(id)) {
        layer.destroy();
        this._layers.delete(id);
      }
    }
  }

  destroy(): void {
    for (const layer of this._layers.values())
      layer.destroy();
    this._layers.clear();
  }
}
