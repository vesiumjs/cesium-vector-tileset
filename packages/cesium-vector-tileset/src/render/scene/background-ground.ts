import type { StyleImage } from '../../style/style-image';
import type { RenderFrameState } from './render-frame';
import * as Cesium from 'cesium';
import { Cartesian2, Cartesian3, Color, SceneMode, WebMercatorProjection } from 'cesium';

export interface BackgroundPattern {
  from: StyleImage;
  to: StyleImage;
  fade: number;
  fromScale: number;
  toScale: number;
}

export interface BackgroundPaint {
  /** MapLibre's already premultiplied color, including background-opacity. */
  color: Color;
  opacity: number;
  pattern?: BackgroundPattern;
}

interface BackgroundCommand {
  owner?: object;
  pass: number;
  shaderProgram: { destroy: () => void };
}

interface BackgroundContext {
  depthTexture: boolean;
  defaultTexture: BackgroundTexture;
  uniformState: { globeDepthTexture: BackgroundTexture };
  createViewportQuadCommand: (source: object, options: {
    owner: object;
    pass: number;
    renderState: object;
    uniformMap: Record<string, () => unknown>;
  }) => BackgroundCommand;
}

interface BackgroundTexture {
  width: number;
  height: number;
  destroy: () => void;
}

interface CesiumRuntime {
  Pass: { OPAQUE: number };
  RenderState: { fromCache: (options: object) => object };
  ShaderSource: new (options: { sources: string[]; defines: string[] }) => object;
  EncodedCartesian3: { fromCartesian: (position: Cartesian3, result: { high: Cartesian3; low: Cartesian3 }) => void };
  Texture: new (options: { context: BackgroundContext; source: HTMLCanvasElement; preMultiplyAlpha: boolean }) => BackgroundTexture;
}

const Pass = (Cesium as unknown as CesiumRuntime).Pass;
const RenderState = (Cesium as unknown as CesiumRuntime).RenderState;
const ShaderSource = (Cesium as unknown as CesiumRuntime).ShaderSource;
const EncodedCartesian3 = (Cesium as unknown as CesiumRuntime).EncodedCartesian3;
const Texture = (Cesium as unknown as CesiumRuntime).Texture;

const MATERIAL_SOURCE = `
uniform vec4 color;
uniform float opacity;
uniform bool patterned;
uniform sampler2D fromImage;
uniform sampler2D toImage;
uniform vec2 fromSize;
uniform vec2 toSize;
uniform vec2 fromPhase;
uniform vec2 toPhase;
uniform vec2 fromDimensions;
uniform vec2 toDimensions;
uniform float fade;

vec4 backgroundColor(vec2 coordinate) {
    vec4 result = color;
    if (patterned) {
        vec2 fromUV = fract((coordinate + fromPhase) / fromSize);
        vec2 toUV = fract((coordinate + toPhase) / toSize);
        fromUV = (fromUV * fromDimensions + 1.0) / (fromDimensions + 2.0);
        toUV = (toUV * toDimensions + 1.0) / (toDimensions + 2.0);
        vec4 from = texture(fromImage, vec2(fromUV.x, 1.0 - fromUV.y));
        vec4 to = texture(toImage, vec2(toUV.x, 1.0 - toUV.y));
        // Canvas textures are premultiplied on upload, matching MapLibre's
        // filtered pattern atlas. Crossfade and opacity apply in one draw.
        result = mix(from, to, fade) * opacity;
    }
    return result;
}`;

const FRAGMENT_SOURCE = `
uniform vec3 u_referenceHigh;
uniform vec3 u_referenceLow;
uniform vec3 u_referenceNormal;
uniform vec3 u_referenceHorizontal;
uniform vec3 u_referenceEast;
uniform vec2 u_referenceGeodetic;
uniform vec3 u_inverseRadiiSquared;
uniform float u_worldScale;
uniform bool u_planar;
uniform bool u_mercator;
uniform float u_projectionRadius;
uniform bool u_patterned;
uniform vec2 u_depthSize;

// Subtract the camera/reference in Cesium's encoded coordinate space before
// adding the eye-space offset. This retains sub-pixel precision at high zoom.
vec3 relativePosition(vec3 positionEC) {
    return (czm_encodedCameraPositionMCHigh - u_referenceHigh)
        + (czm_encodedCameraPositionMCLow - u_referenceLow)
        + czm_inverseViewRotation * positionEC;
}

float logOnePlus(float value) {
    return abs(value) < 0.001 ? value * (1.0 - 0.5 * value) : log(1.0 + value);
}

float mercatorDelta(float latitudeDelta) {
    float sinLatitude = u_referenceGeodetic.x;
    float cosLatitude = u_referenceGeodetic.y;
    float sinDelta = sin(latitudeDelta);
    float cosDeltaMinusOne = -2.0 * pow(sin(latitudeDelta * 0.5), 2.0);
    float difference = sinLatitude * cosDeltaMinusOne + cosLatitude * sinDelta;
    return 0.5 * (logOnePlus(difference / (1.0 + sinLatitude))
        - logOnePlus(-difference / (1.0 - sinLatitude)));
}

vec2 worldPixelDelta(vec3 relative) {
    if (u_planar) {
        float longitudeDelta = relative.y / u_projectionRadius;
        float northDelta = relative.z / u_projectionRadius;
        return vec2(longitudeDelta, -(u_mercator ? northDelta : mercatorDelta(northDelta))) * u_worldScale;
    }
    vec3 deltaNormal = relative * u_inverseRadiiSquared;
    float east = dot(deltaNormal, u_referenceEast);
    float horizontal = dot(deltaNormal, u_referenceHorizontal);
    float baseHorizontal = length(u_referenceNormal.xy);
    float horizontalLength = length(vec2(baseHorizontal + horizontal, east));
    // Compute the change in length without subtracting two nearly equal
    // float32 values. Longitude and latitude remain accurate near the camera.
    float horizontalDelta = (2.0 * baseHorizontal * horizontal + horizontal * horizontal + east * east)
        / (horizontalLength + baseHorizontal);
    float longitudeDelta = atan(east, baseHorizontal + horizontal);
    float latitudeDelta = atan(deltaNormal.z * baseHorizontal - horizontalDelta * u_referenceNormal.z,
        dot(u_referenceNormal, u_referenceNormal) + deltaNormal.z * u_referenceNormal.z + horizontalDelta * baseHorizontal);
    return vec2(longitudeDelta, -mercatorDelta(latitudeDelta)) * u_worldScale;
}

void main() {
    vec2 uv = gl_FragCoord.xy / u_depthSize;
    float depth = czm_unpackDepth(texture(czm_globeDepthTexture, uv));
    // Cesium copies globe depth after each frustum's GLOBE pass. A surface
    // pixel belongs to that frustum only; sky and other frustums stay clear.
    if (depth <= 0.0 || depth >= 1.0) {
        discard;
    }
    vec2 coordinate = vec2(0.0);
    if (u_patterned) {
        vec4 eye = czm_windowToEyeCoordinates(gl_FragCoord.xy, depth);
        coordinate = worldPixelDelta(relativePosition(eye.xyz / eye.w));
    }
    out_FragColor = backgroundColor(coordinate);
}`;

function imageCanvas(image: StyleImage): HTMLCanvasElement {
  const data = image.data!;
  const canvas = document.createElement('canvas');
  canvas.width = data.width + 2;
  canvas.height = data.height + 2;
  const context = canvas.getContext('2d')!;
  // Repeat the edge pixels into a one-texel border, as MapLibre's pattern
  // atlas does, so linear filtering remains continuous across repeat seams.
  const pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const sourceX = (x + data.width - 1) % data.width;
      const sourceY = (y + data.height - 1) % data.height;
      const source = (sourceY * data.width + sourceX) * 4;
      pixels.set(data.data.subarray(source, source + 4), (y * canvas.width + x) * 4);
    }
  }
  context.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
  return canvas;
}

function positiveModulo(value: number, period: number): number {
  return value - period * Math.floor(value / period);
}

/** MapLibre's integer-zoom world-pixel phase and crossfade-scaled sprite period. */
export function backgroundPatternCoordinates(
  image: Pick<StyleImage, 'data' | 'pixelRatio'>,
  scale: number,
  zoom: number,
  longitude: number,
  latitude: number,
): { size: Cartesian2; phase: Cartesian2 } {
  const size = new Cartesian2(image.data!.width / image.pixelRatio * scale, image.data!.height / image.pixelRatio * scale);
  const worldSize = 512 * 2 ** Math.floor(zoom);
  const x = (longitude + Math.PI) / (2 * Math.PI) * worldSize;
  const y = (Math.PI - Math.log(Math.tan(Math.PI / 4 + latitude / 2))) / (2 * Math.PI) * worldSize;
  return { size, phase: new Cartesian2(positiveModulo(x, size.x), positiveModulo(y, size.y)) };
}

/**
 * A background is a ground draw batch, independent of MVT availability.
 * The globe depth mask follows actual terrain in 2D, CV and 3D; the command
 * joins the same style order as fills, lines, rasters and symbols.
 */
export class BackgroundGround {
  private _command?: BackgroundCommand;

  private _context?: BackgroundContext;

  private _useLogDepth = false;

  private _images = new Map<StyleImage, { version: number | undefined; texture: BackgroundTexture }>();

  private _paint: BackgroundPaint = { color: Color.TRANSPARENT, opacity: 0 };

  private _fromTexture?: BackgroundTexture;

  private _toTexture?: BackgroundTexture;

  private _fromCoordinates = { size: new Cartesian2(1, 1), phase: new Cartesian2() };

  private _toCoordinates = { size: new Cartesian2(1, 1), phase: new Cartesian2() };

  private _fromDimensions = new Cartesian2(1, 1);

  private _toDimensions = new Cartesian2(1, 1);

  private _depthSize = new Cartesian2();

  private _frameNumber?: number;

  private _frameLongitude = 0;

  private _reference = { high: new Cartesian3(), low: new Cartesian3() };

  private _normal = new Cartesian3();

  private _east = new Cartesian3();

  private _horizontal = new Cartesian3();

  private _geodetic = new Cartesian2();

  private _inverseRadiiSquared = new Cartesian3();

  private _worldScale = 0;

  private _planar = false;

  private _mercator = false;

  private _projectionRadius = 1;

  private _patterned = false;

  update(frame: RenderFrameState, mode: SceneMode, zoom: number, paint: BackgroundPaint): void {
    if (!frame.passes?.render || !frame.context || !frame.mapProjection || !frame.commandList) {
      return;
    }
    const context = frame.context as unknown as BackgroundContext;
    if (!context.depthTexture) {
      throw new Error('Style backgrounds require Cesium depth textures.');
    }
    const useLogDepth = !!(frame as RenderFrameState & { useLogDepth?: boolean }).useLogDepth;
    if (this._context !== context || this._useLogDepth !== useLogDepth) {
      this._command?.shaderProgram.destroy();
      this._command = undefined;
      if (this._context && this._context !== context) {
        this._destroyImages();
      }
      this._context = context;
      this._useLogDepth = useLogDepth;
    }
    this._paint = paint;
    if (paint.pattern) {
      const projection = frame.mapProjection;
      const ellipsoid = projection.ellipsoid;
      const camera = frame.camera.positionCartographic;
      if (frame.frameNumber === undefined || this._frameNumber !== frame.frameNumber) {
        this._frameNumber = frame.frameNumber;
        this._frameLongitude = camera.longitude;
      }
      // Cesium canonicalizes longitude after moving the second 2D viewport
      // across the date line. Keep the pattern in the same unwrapped world.
      const longitude = mode === SceneMode.SCENE2D
        ? camera.longitude + 2 * Math.PI * Math.round((this._frameLongitude - camera.longitude) / (2 * Math.PI))
        : camera.longitude;
      this._planar = mode !== SceneMode.SCENE3D;
      this._mercator = projection instanceof WebMercatorProjection;
      this._projectionRadius = ellipsoid.maximumRadius;
      this._worldScale = 512 * 2 ** Math.floor(zoom) / (2 * Math.PI);
      const cartographic = new Cesium.Cartographic(camera.longitude, camera.latitude, 0);
      const reference = this._planar
        ? projection.project(cartographic)
        : ellipsoid.cartographicToCartesian(cartographic);
      EncodedCartesian3.fromCartesian(this._planar ? new Cartesian3(reference.z, reference.x, reference.y) : reference, this._reference);
      Cartesian3.clone(ellipsoid.oneOverRadiiSquared, this._inverseRadiiSquared);
      Cartesian3.multiplyComponents(ellipsoid.cartographicToCartesian(cartographic), this._inverseRadiiSquared, this._normal);
      Cartesian3.fromElements(-Math.sin(camera.longitude), Math.cos(camera.longitude), 0, this._east);
      Cartesian3.fromElements(Math.cos(camera.longitude), Math.sin(camera.longitude), 0, this._horizontal);
      this._geodetic.x = Math.sin(camera.latitude);
      this._geodetic.y = Math.cos(camera.latitude);
      const { from, to, fromScale, toScale } = paint.pattern;
      this._fromCoordinates = backgroundPatternCoordinates(from, fromScale, zoom, longitude, camera.latitude);
      this._toCoordinates = backgroundPatternCoordinates(to, toScale, zoom, longitude, camera.latitude);
      this._fromTexture = this._texture(from, context);
      this._toTexture = this._texture(to, context);
      this._fromDimensions = new Cartesian2(from.data!.width, from.data!.height);
      this._toDimensions = new Cartesian2(to.data!.width, to.data!.height);
    }
    this._patterned = !!paint.pattern;
    for (const [image, cached] of this._images) {
      if (image !== paint.pattern?.from && image !== paint.pattern?.to) {
        cached.texture.destroy();
        this._images.delete(image);
      }
    }
    if (!this._command) {
      // READ_ONLY makes Cesium retain the viewport vertex positions instead
      // of deriving a log-depth geometry shader (whose near-plane discard
      // would erase this quad). It also selects the right depth decoder.
      this._command = context.createViewportQuadCommand(new ShaderSource({ sources: [MATERIAL_SOURCE, FRAGMENT_SOURCE], defines: useLogDepth ? ['LOG_DEPTH_READ_ONLY'] : [] }), {
        owner: this,
        pass: Pass.OPAQUE,
        renderState: RenderState.fromCache({ depthTest: { enabled: false }, depthMask: false, blending: Cesium.BlendingState.PRE_MULTIPLIED_ALPHA_BLEND }),
        uniformMap: {
          color: () => this._paint.color,
          opacity: () => this._paint.opacity,
          patterned: () => this._patterned,
          fromImage: () => this._patterned ? this._fromTexture : context.defaultTexture,
          toImage: () => this._patterned ? this._toTexture : context.defaultTexture,
          fromSize: () => this._fromCoordinates.size,
          toSize: () => this._toCoordinates.size,
          fromPhase: () => this._fromCoordinates.phase,
          toPhase: () => this._toCoordinates.phase,
          fromDimensions: () => this._fromDimensions,
          toDimensions: () => this._toDimensions,
          fade: () => this._paint.pattern?.fade ?? 1,
          u_referenceHigh: () => this._reference.high,
          u_referenceLow: () => this._reference.low,
          u_referenceNormal: () => this._normal,
          u_referenceHorizontal: () => this._horizontal,
          u_referenceEast: () => this._east,
          u_referenceGeodetic: () => this._geodetic,
          u_inverseRadiiSquared: () => this._inverseRadiiSquared,
          u_worldScale: () => this._worldScale,
          u_planar: () => this._planar,
          u_mercator: () => this._mercator,
          u_projectionRadius: () => this._projectionRadius,
          u_patterned: () => this._patterned,
          u_depthSize: () => {
            // GlobeDepth owns a full-view framebuffer even while Cesium
            // clips a 2D date-line viewport. Use that texture's dimensions.
            this._depthSize.x = context.uniformState.globeDepthTexture.width;
            this._depthSize.y = context.uniformState.globeDepthTexture.height;
            return this._depthSize;
          },
        },
      });
    }
    frame.commandList.push(this._command);
  }

  destroy(): void {
    this._command?.shaderProgram.destroy();
    this._command = undefined;
    this._destroyImages();
  }

  /**
   * @internal
   */
  private _texture(image: StyleImage, context: BackgroundContext): BackgroundTexture {
    let cached = this._images.get(image);
    if (!cached || cached.version !== image.version) {
      cached?.texture.destroy();
      cached = { version: image.version, texture: new Texture({ context, source: imageCanvas(image), preMultiplyAlpha: true }) };
      this._images.set(image, cached);
    }
    return cached.texture;
  }

  /**
   * @internal
   */
  private _destroyImages(): void {
    for (const cached of this._images.values()) {
      cached.texture.destroy();
    }
    this._images.clear();
  }
}
