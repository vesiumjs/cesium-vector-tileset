import type { CesiumWidget } from 'cesium';
import type { DemoSelection } from './demo-selection';
import type { DemoMode } from './preset-catalog';
import { Cartesian3, Math as CesiumMath, SceneMode, WebMercatorProjection } from 'cesium';
import { demoPresets } from './preset-catalog';

export const widgetOptions = {
  baseLayer: false,
  mapProjection: new WebMercatorProjection(),
  requestRenderMode: true,
  maximumRenderTimeChange: Infinity,
} satisfies NonNullable<ConstructorParameters<typeof CesiumWidget>[1]>;

export const sceneOptions = { debugShowFramesPerSecond: true };
const sceneModes = {
  '3d': { value: SceneMode.SCENE3D, morph: 'morphTo3D' },
  '2d': { value: SceneMode.SCENE2D, morph: 'morphTo2D' },
  'cv': { value: SceneMode.COLUMBUS_VIEW, morph: 'morphToColumbusView' },
} as const satisfies Record<DemoMode, { value: SceneMode; morph: string }>;

export function demoCameraConfig(selection: Pick<DemoSelection, 'preset' | 'mode'>) {
  const preset = demoPresets.find(preset => preset.id === selection.preset)!;
  return {
    mode: sceneModes[selection.mode],
    destination: Cartesian3.fromDegrees(preset.longitude, preset.latitude, preset.height),
    orientation: {
      heading: CesiumMath.toRadians(preset.heading),
      pitch: CesiumMath.toRadians(preset.pitch),
      roll: CesiumMath.toRadians(preset.roll),
    },
  };
}
