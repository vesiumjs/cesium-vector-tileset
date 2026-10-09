import type { LinePaintUniforms } from '../draw-batch';
import type { RenderFrameState } from '../render-frame';
import * as Cesium from 'cesium';
import { BoundingRectangle, BoundingSphere, Cartesian3, Color, Matrix4, OrthographicFrustum, PerspectiveFrustum, SceneMode } from 'cesium';
import { describe, expect, it } from 'vitest';
import { CanonicalTileID } from '../../../tile/tile-id';
import { lineGroundScale } from '../../line/line-ground-scale';
import { LineTileClip } from '../../line/line-tile-clip';
import { registerDrawBatch, registerLinePaint, registerUniformLineExtent } from '../draw-batch';
import { DrawCommands } from '../draw-commands';

const DrawCommand = (Cesium as unknown as { DrawCommand: new (options: object) => { owner: object; pass: number; boundingVolume: BoundingSphere; cull: boolean } }).DrawCommand;

function sceneLines(widths: number[]) {
  const frustum = new PerspectiveFrustum({ fov: Math.PI / 2, aspectRatio: 1, near: 1, far: 1000 });
  const viewport = new BoundingRectangle(0, 0, 1000, 1000);
  const camera = { positionWC: Cartesian3.ZERO, directionWC: new Cartesian3(0, 0, -1), upWC: Cartesian3.UNIT_Y, frustum };
  const sphere = new BoundingSphere(new Cartesian3(120, 0, -100), 1);
  const paints: LinePaintUniforms[] = [];
  const commands = widths.map((width, index) => {
    const owner = {};
    const paint: LinePaintUniforms = {
      clip: new LineTileClip(new CanonicalTileID(0, 0, 0)),
      width,
      color: Color.WHITE.clone(),
      offset: 0,
      metersPerPixel: lineGroundScale(18.5),
      widthUniform: () => paint.width,
      colorUniform: () => paint.color,
      offsetUniform: () => paint.offset,
      metersPerPixelUniform: () => paint.metersPerPixel,
    };
    registerDrawBatch(owner, { kind: index ? 'dash' : 'line', tileId: 'same-family', layerId: `layer-${index}` });
    paints.push(paint);
    registerLinePaint(owner, paint, { widthFactor: 1, miterLimit: 2 });
    return new DrawCommand({ owner, pass: 8, boundingVolume: sphere, cull: false });
  });
  const state = {
    camera,
    context: { drawingBufferWidth: 1000, drawingBufferHeight: 1000, uniformState: { view: Matrix4.IDENTITY } },
    passes: { render: true, pick: false },
    pixelRatio: 1,
    commandList: [...commands],
    cullingVolume: frustum.computeCullingVolume(camera.positionWC, camera.directionWC, camera.upWC),
  } as unknown as RenderFrameState;
  const scene = { useWebVR: false, _view: { passState: { viewport } } };
  return { commands, paints, state, scene, sphere, frustum };
}

describe('uniform road visibility at final Native command preparation', () => {
  it('omits the offscreen narrow road while retaining its wide casing and original bounds', () => {
    const fixture = sceneLines([2, 200]);
    new DrawCommands().prepare(fixture.state, 0, SceneMode.SCENE3D, new Map(), fixture.scene);
    expect(fixture.state.commandList).toEqual([fixture.commands[1]]);
    expect(fixture.commands[1].boundingVolume).toBe(fixture.sphere);
    expect(fixture.sphere.radius).toBe(1);
    expect(fixture.commands[1].cull).toBe(false);
  });

  it('retains a ground-expanded road even when its CSS width cannot reach the frame edge', () => {
    const fixture = sceneLines([2]);
    const draw = new DrawCommands();
    draw.prepare(fixture.state, 0, SceneMode.SCENE3D, new Map(), fixture.scene);
    expect(fixture.state.commandList).toHaveLength(0);
    // The same pose/paint can cover more ground at a different style zoom.
    // Camera-distance pixel expansion alone would still omit this stroke.
    fixture.paints[0].metersPerPixel = lineGroundScale(13);
    fixture.state.commandList = [...fixture.commands];
    draw.prepare(fixture.state, 0, SceneMode.SCENE3D, new Map(), fixture.scene);
    expect(fixture.state.commandList).toEqual(fixture.commands);
    expect(fixture.sphere.radius).toBe(1);
  });

  it.each(['instance', 'unknown-width', 'unknown-miter', 'unknown-scale', 'missing-viewport', 'split-viewport', 'offcenter', 'vr', 'near', 'nonfinite', 'unknown-camera'] as const)('retains roads when %s prevents a conservative bound', (reason) => {
    const fixture = sceneLines([2]);
    if (reason === 'instance')
      registerUniformLineExtent(fixture.commands[0].owner, undefined);
    if (reason === 'unknown-width')
      registerUniformLineExtent(fixture.commands[0].owner, { widthFactor: NaN, miterLimit: 2 });
    if (reason === 'unknown-miter')
      registerUniformLineExtent(fixture.commands[0].owner, { widthFactor: 1, miterLimit: Infinity });
    if (reason === 'unknown-scale')
      fixture.paints[0].metersPerPixel = NaN;
    if (reason === 'missing-viewport')
      fixture.scene._view = undefined as never;
    if (reason === 'split-viewport')
      fixture.scene._view.passState.viewport.width = 500;
    if (reason === 'offcenter')
      fixture.frustum.xOffset = 1;
    if (reason === 'vr')
      fixture.scene.useWebVR = true;
    if (reason === 'near')
      fixture.sphere.center.z = -1;
    if (reason === 'nonfinite')
      fixture.sphere.radius = NaN;
    if (reason === 'unknown-camera')
      Object.assign(fixture.state.camera, { directionWC: undefined });
    new DrawCommands().prepare(fixture.state, 0, SceneMode.SCENE3D, new Map(), fixture.scene);
    expect(fixture.state.commandList).toEqual(fixture.commands);
  });

  it.each([SceneMode.SCENE2D, SceneMode.COLUMBUS_VIEW, SceneMode.MORPHING])('retains the same road in scene mode %s', (mode) => {
    const fixture = sceneLines([2]);
    new DrawCommands().prepare(fixture.state, 0, mode, new Map(), fixture.scene);
    expect(fixture.state.commandList).toEqual(fixture.commands);
  });

  it('preserves picking and restores a wider road with the same command', () => {
    const fixture = sceneLines([2]);
    const draw = new DrawCommands();
    draw.prepare(fixture.state, 0, SceneMode.SCENE3D, new Map(), fixture.scene);
    expect(fixture.state.commandList).toHaveLength(0);
    fixture.state.commandList = [...fixture.commands];
    fixture.state.passes = { render: false, pick: true };
    draw.prepare(fixture.state, 0, SceneMode.SCENE3D, new Map(), fixture.scene);
    expect(fixture.state.commandList).toEqual(fixture.commands);
    fixture.state.commandList = [...fixture.commands];
    fixture.state.passes = { render: true, pick: false };
    registerUniformLineExtent(fixture.commands[0].owner, { widthFactor: 100, miterLimit: 2 });
    draw.prepare(fixture.state, 0, SceneMode.SCENE3D, new Map(), fixture.scene);
    expect(fixture.state.commandList).toEqual(fixture.commands);
  });

  it('retains the diagonal square-cap allowance beyond an orthographic frame edge', () => {
    const fixture = sceneLines([64]);
    const frustum = new OrthographicFrustum({ width: 200, aspectRatio: 1, near: 1, far: 1000 });
    Object.assign(fixture.state.camera, { frustum });
    fixture.state.cullingVolume = frustum.computeCullingVolume(Cartesian3.ZERO, new Cartesian3(0, 0, -1), Cartesian3.UNIT_Y);
    fixture.sphere.center.x = 108;
    fixture.sphere.radius = 0.1;
    registerUniformLineExtent(fixture.commands[0].owner, { widthFactor: 1, miterLimit: 1 });
    new DrawCommands().prepare(fixture.state, 0, SceneMode.SCENE3D, new Map(), fixture.scene);
    expect(fixture.state.commandList).toEqual(fixture.commands);
  });
});
