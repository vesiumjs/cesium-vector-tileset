import type { ReplayDrawCommand } from '../draw-command-replay';
import * as Cesium from 'cesium';
import { BoundingSphere, Cartesian3 } from 'cesium';
import { describe, expect, it } from 'vitest';
import { DrawCommandReplay } from '../draw-command-replay';

interface RuntimeCommand extends ReplayDrawCommand {
  lastDirtyTime: number;
  derivedCommands: object;
}

const DrawCommand = (Cesium as unknown as {
  DrawCommand: new (options: ReplayDrawCommand) => RuntimeCommand;
}).DrawCommand;

describe('retained Native command replay', () => {
  it('retains derived state and final paint until the Native inputs change', () => {
    const bounds = new BoundingSphere(new Cartesian3(1, 2, 3), 10);
    const source = new DrawCommand({ boundingVolume: bounds, count: 12, pass: 7, uniformMap: { u_paint: () => 1 }, owner: {} });
    const replay = new DrawCommandReplay(source);
    const command = replay.update(source) as RuntimeCommand;
    const finalUniforms = { u_paint: () => 2 };
    const finalOwner = {};
    command.pass = 8;
    command.uniformMap = finalUniforms;
    command.owner = finalOwner;
    const derivatives = command.derivedCommands;
    command.lastDirtyTime = 42;
    command.dirty = false;

    expect(replay.update(source)).toBe(command);
    expect(command.dirty).toBe(false);
    expect(command.lastDirtyTime).toBe(42);
    expect(command.derivedCommands).toBe(derivatives);
    expect(command.pass).toBe(8);
    expect(command.uniformMap).toBe(finalUniforms);
    expect(command.owner).toBe(finalOwner);

    source.count = 24;
    source.pass = 9;
    const uniforms = { u_paint: () => 3 };
    source.uniformMap = uniforms;
    const owner = {};
    source.owner = owner;
    replay.update(source);
    expect(command.count).toBe(24);
    expect(command.pass).toBe(9);
    expect(command.uniformMap).toBe(uniforms);
    expect(command.owner).toBe(owner);
    expect(command.dirty).toBe(true);
    expect(command.lastDirtyTime).toBe(42);
    expect(command.derivedCommands).toBe(derivatives);
  });

  it('keeps expanded bounds independent and invalidates changed metadata permission', () => {
    const sourceBounds = new BoundingSphere(new Cartesian3(1, 2, 3), 10);
    const expandedBounds = new BoundingSphere(sourceBounds.center, 20);
    const source = new DrawCommand({ boundingVolume: sourceBounds });
    const replay = new DrawCommandReplay(source);
    const command = replay.update(source, expandedBounds);
    command.dirty = false;
    expandedBounds.radius = 30;
    replay.update(source, expandedBounds);
    expect(command.boundingVolume).toBe(expandedBounds);
    expect(command.boundingVolume!.radius).toBe(30);
    expect(source.boundingVolume!.radius).toBe(10);
    expect(command.dirty).toBe(false);

    source._pickMetadataAllowed = true;
    replay.update(source, expandedBounds);
    expect(command._pickMetadataAllowed).toBe(true);
    expect(command.dirty).toBe(true);
  });
});
