import type { GeometryInstance, SceneMode } from 'cesium';
import type { FillStyleLayer } from '../../style/style-layer/fill-style-layer';
import type { GeometryLayout } from './geometry-preparation';
import { BoundingSphere, WebMercatorProjection } from 'cesium';
import { DrawCommandReplay } from '../scene/draw-command-replay';
import { FillCameraPaint } from './fill-camera-paint';
import { GeometryPrimitive } from './geometry-primitive';
import { MERCATOR_TRANSLATION_SHADER, mercatorTranslationPadding } from './mercator-translation';

export const FILL_TRANSLATION_SHADER = `
uniform vec2 u_fillTranslate;
uniform bool u_fillMercator;
${MERCATOR_TRANSLATION_SHADER}
vec4 cvt_translateFillPosition(vec4 position, vec3 normal)
{
    if (any(notEqual(u_fillTranslate, vec2(0.0)))) {
        if (czm_morphTime == 0.0 && u_fillMercator) {
            position.xyz += vec3(0.0, u_fillTranslate.x, -u_fillTranslate.y)
                * (czm_twoPi * czm_ellipsoidRadii.x);
            return position;
        }
        vec3 deltaWorld;
        position.xyz += cvt_mercatorDelta(normal, u_fillTranslate, 0.0, u_fillMercator, deltaWorld);
    }
    return position;
}
`;

type FillAppearance = NonNullable<NonNullable<ConstructorParameters<typeof GeometryPrimitive>[0]>['appearance']> & {
  uniforms?: Record<string, unknown>;
};

/** Each fill/outline owner keeps camera paint and conservative translated bounds. */
export class FillGeometryPrimitive extends GeometryPrimitive {
  private readonly _paint: FillCameraPaint;
  private readonly _uniforms: Record<string, unknown>;
  private readonly _bounds = new WeakMap<BoundingSphere, BoundingSphere>();
  private readonly _commands = new WeakMap<object, DrawCommandReplay>();

  constructor(instances: GeometryInstance[], appearance: FillAppearance, layout: GeometryLayout, compressVertices = false) {
    const paint = new FillCameraPaint();
    const uniforms = appearance.uniforms = { ...appearance.uniforms, u_fillTranslate: paint.translation, u_fillMercator: true };
    super({ geometryInstances: instances, appearance, compressVertices, vertexCacheOptimize: true }, layout);
    this._uniforms = uniforms;
    this._paint = paint;
  }

  updateCameraPaint(layer: FillStyleLayer, zoom: number, bearing?: number): void {
    this._paint.update(layer, zoom, bearing);
  }

  captureCameraPaint(layer: FillStyleLayer): (zoom: number, bearing?: number) => void {
    return this._paint.capture(layer);
  }

  override update(frameState?: Parameters<GeometryPrimitive['update']>[0]): void {
    if (frameState)
      this._uniforms.u_fillMercator = frameState.mapProjection instanceof WebMercatorProjection;
    const start = frameState?.commandList?.length ?? 0;
    super.update(frameState);
    if (!frameState?.commandList || frameState.commandList.length === start)
      return;
    const padding = mercatorTranslationPadding(this._paint.translation, frameState.mapProjection.ellipsoid, frameState.mode as SceneMode);
    for (let index = start; index < frameState.commandList.length; index++) {
      const command = frameState.commandList[index] as { owner?: object; boundingVolume?: BoundingSphere };
      const source = command.boundingVolume;
      if (command.owner !== this || !source)
        continue;
      let bounds = this._bounds.get(source);
      if (!bounds) {
        bounds = new BoundingSphere();
        this._bounds.set(source, bounds);
      }
      BoundingSphere.clone(source, bounds);
      bounds.radius += padding;
      let replay = this._commands.get(command);
      if (!replay) {
        replay = new DrawCommandReplay(command);
        this._commands.set(command, replay);
      }
      frameState.commandList[index] = replay.update(command, bounds);
    }
  }
}
