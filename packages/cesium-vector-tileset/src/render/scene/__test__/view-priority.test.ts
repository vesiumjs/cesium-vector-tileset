import { SceneMode } from 'cesium';
import { describe, expect, it, vi } from 'vitest';
import { viewPriority } from '../view-priority';
import { cityOrbitFrame } from './view-priority-helper';

describe('tile publication viewpoint', () => {
  it('tracks the current ground center when an oblique camera turns at the same position', () => {
    const frame = cityOrbitFrame();
    const before = viewPriority(frame);
    expect(before.latitude * 180 / Math.PI).toBeCloseTo(51.465168023536584, 8);
    frame.camera.setView({ orientation: { heading: 0, pitch: -Math.PI / 6, roll: 0 } });
    const after = viewPriority(frame);
    expect(after.latitude).toBeGreaterThan(frame.camera.positionCartographic.latitude);
    expect(after.longitude).toBeCloseTo(frame.camera.positionCartographic.longitude, 10);
    expect(before.latitude * 180 / Math.PI).toBeCloseTo(51.465168023536584, 8);
  });

  it.each([SceneMode.SCENE2D, SceneMode.COLUMBUS_VIEW, SceneMode.MORPHING])('retains the camera viewpoint outside 3D (mode %s)', (mode) => {
    const frame = { ...cityOrbitFrame(), mode };
    const pick = vi.spyOn(frame.camera, 'getPickRay');
    expect(viewPriority(frame)).toBe(frame.camera.positionCartographic);
    expect(pick).not.toHaveBeenCalled();
  });

  it('retains the camera viewpoint when the center ray points into the sky', () => {
    const frame = cityOrbitFrame();
    frame.camera.setView({ orientation: { pitch: Math.PI / 2 } });
    expect(viewPriority(frame)).toBe(frame.camera.positionCartographic);
  });

  it('retains the camera viewpoint before a canvas has usable CSS dimensions', () => {
    const frame = cityOrbitFrame();
    frame.context.canvas = document.createElement('canvas');
    expect(viewPriority(frame)).toBe(frame.camera.positionCartographic);
  });
});
