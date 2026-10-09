import { Cartographic, Math as CesiumMath, SceneMode } from 'cesium';
import { describe, expect, it } from 'vitest';
import { createDemoSelection, demoMapConfig } from '../demo-selection';
import { demoPresets } from '../preset-catalog';
import { demoCameraConfig } from '../scene-config';

describe('demo scene configuration', () => {
  it('converts the Manhattan waterfront pose into ellipsoid coordinates and radians', () => {
    const config = demoCameraConfig(createDemoSelection('manhattan'));
    const position = Cartographic.fromCartesian(config.destination);
    expect(CesiumMath.toDegrees(position.longitude)).toBeCloseTo(-74.018, 8);
    expect(CesiumMath.toDegrees(position.latitude)).toBeCloseTo(40.699, 8);
    expect(position.height).toBeCloseTo(1000, 5);
    expect(config.orientation).toEqual({ heading: CesiumMath.toRadians(32), pitch: CesiumMath.toRadians(-25), roll: 0 });
  });

  it('resolves every gallery preset into a finite camera position and map source', () => {
    for (const preset of demoPresets) {
      const selection = createDemoSelection(preset.id);
      const config = demoCameraConfig(selection);
      const position = Cartographic.fromCartesian(config.destination);
      expect(position.height).toBeCloseTo(preset.height, 4);
      expect(Math.abs(position.latitude)).toBeLessThanOrEqual(Math.PI / 2);
      expect(demoMapConfig(selection).url).not.toBe('');
    }
  });

  it('selects Cesium scene modes while keeping the preset pose independent of source changes', () => {
    const selection = createDemoSelection('london');
    const original = demoCameraConfig(selection);
    selection.source = 'bright';
    selection.style = 'https://example.com/style.json';
    expect(demoCameraConfig(selection)).toEqual(original);
    const modes = { '3d': SceneMode.SCENE3D, '2d': SceneMode.SCENE2D, 'cv': SceneMode.COLUMBUS_VIEW } as const;
    for (const mode of ['3d', '2d', 'cv'] as const) {
      selection.mode = mode;
      expect(demoCameraConfig(selection).mode.value).toBe(modes[mode]);
    }
  });
});
