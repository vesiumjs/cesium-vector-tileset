import { Cartesian3, Cartographic, Math as CesiumMath, SceneMode } from 'cesium';
import { describe, expect, it } from 'vitest';
import { demoCameraConfig, demoMapConfig, demoSearchParameters, readDemoSelection } from '../demo-config';

describe('demo configuration', () => {
  it('resolves a shared scenario to its style and ellipsoid camera pose', () => {
    const selection = readDemoSelection(new URLSearchParams('scenario=manhattan&height=15'));
    const map = demoMapConfig(selection);
    const camera = demoCameraConfig(selection);
    const destination = camera.view!.destination;
    if (!(destination instanceof Cartesian3))
      throw new Error('scenario must use an ellipsoid position');
    const position = Cartographic.fromCartesian(destination);
    expect(map.url).toContain('buildings.json');
    expect(position.height).toBeCloseTo(15, 5);
    expect(CesiumMath.toDegrees(position.longitude)).toBeCloseTo(-74.01192337274551, 8);
    expect(CesiumMath.toDegrees(position.latitude)).toBeCloseTo(40.70752701473173, 8);
    expect(camera.view!.orientation.pitch).toBeCloseTo(CesiumMath.toRadians(-12));
  });

  it('keeps explicit source overrides when opening a scenario link', () => {
    const selection = readDemoSelection(new URLSearchParams('scenario=manhattan&source=bright'));
    expect(demoMapConfig(selection).url).toBe('https://tiles.openfreemap.org/styles/bright');
  });

  it('uses a top-down rectangle in 2D even when the selected angle is oblique', () => {
    const selection = readDemoSelection(new URLSearchParams('view=london&mode=2d&angle=oblique'));
    const camera = demoCameraConfig(selection);
    expect(camera.mode.value).toBe(SceneMode.SCENE2D);
    expect(camera.view!.destination).toHaveProperty('west');
    expect(camera.sphere).toBeUndefined();
  });

  it('round-trips custom styles, camera scale and resolution through a shared URL', () => {
    const selection = readDemoSelection(new URLSearchParams('style=https://example.com/style.json&view=world&scale=512&resolutionRatio=2&mode=cv'));
    expect(readDemoSelection(demoSearchParameters(selection))).toEqual(selection);
    expect(demoMapConfig(selection)).toMatchObject({ url: 'https://example.com/style.json', credit: '' });
  });
});
