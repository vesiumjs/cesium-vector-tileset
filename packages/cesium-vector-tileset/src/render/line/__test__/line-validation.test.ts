import { Cartesian3, Geometry } from 'cesium';
import * as Cesium from 'cesium';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DashAtlas } from '../../../assets/dash-atlas';
import { LineBucket } from '../../../data/bucket-runtime';
import { EvaluationParameters } from '../../../style/evaluation-parameters';
import { LineStyleLayer } from '../../../style/style-layer/line-style-layer';
import { CanonicalTileID } from '../../../tile/tile-id';
import { lineInputs } from '../../geometry/line-input';
import { DashMaterial } from '../dash-material';
import { beginLineBuild, canResumeLineBuild, commitLineBuild, stepLineBuild } from '../line-renderer';

const contextLimits = (Cesium as unknown as { ContextLimits: { _maximumTextureSize: number } }).ContextLimits;

function dashBuild(constant = false, count = 100) {
  const layer = new LineStyleLayer({
    id: 'road',
    type: 'line',
    source: 'source',
    paint: { 'line-dasharray': constant
      ? ['step', ['zoom'], ['literal', [1, 1]], 1, ['literal', [2, 1]]]
      : ['case', ['boolean', ['feature-state', 'selected'], false], ['literal', [2, 1]], ['literal', [1, 1]]] },
  }, {});
  layer.recalculate(new EvaluationParameters(0), []);
  const array = { arrayBuffer: new Uint16Array([0, 1, 0, 0, 0, 1, 0, 0]).buffer, bytesPerElement: 16, length: 1 };
  const range = vi.fn(() => ({ index: 0, start: 0, end: 1 }));
  const configuration = { getAttributeArray: (property: string) => !constant && property === 'line-dasharray' ? array : undefined };
  const bucket = Object.assign(Object.create(LineBucket.prototype), {
    layers: [layer],
    featureLineJoinCaps: [],
    lineJoinCap: { join: 'round', cap: 'round', miterLimit: 2, roundLimit: 1.05 },
    programConfigurations: { paintRevision: 0, get: () => configuration, getFeatureRange: range },
  });
  const positions = new Float64Array([...Cartesian3.pack(Cartesian3.fromDegrees(0, 0), []), ...Cartesian3.pack(Cartesian3.fromDegrees(1, 0), [])]);
  const source = { layerId: 'road', featureIndex: 0, positions, tilePositions: new Float64Array([0, 0, 1, 0]) };
  const material = new DashMaterial(new DashAtlas(256, 64));
  const dash = { material, rows: { '1:0': { dasharray: [1, 1], round: true }, '2:0': { dasharray: [2, 1], round: true } } };
  const sources = Array.from({ length: count }, (_, featureIndex) => constant ? { ...source, featureIndex } : source);
  const state = beginLineBuild(sources, { road: bucket }, '0/0/0', new CanonicalTileID(0, 0, 0), 0, 0, false, dash);
  return { state, range, layer, bucket, array, dash };
}

describe('line input validation across frames', () => {
  beforeAll(() => vi.stubGlobal('OffscreenCanvas', class {}));
  afterAll(() => vi.unstubAllGlobals());
  it('bounds real dash pages by the known two-track position texture capacity', () => {
    const previous = contextLimits._maximumTextureSize;
    const { state, dash } = dashBuild(true, 3);
    contextLimits._maximumTextureSize = 4;
    try {
      expect(stepLineBuild(state, { exhausted: false })).toBe(true);
      const collection = commitLineBuild(state)!;
      expect(collection.length).toBe(3);
      for (let index = 0; index < collection.length; index++)
        expect(collection.get(index).geometryInstances).toHaveLength(1);
    }
    finally {
      contextLimits._maximumTextureSize = previous;
      state.collection?.destroy();
      dash.material.destroy();
    }
  });

  it('rejects one indivisible feature exceeding the known texture capacity', () => {
    const previous = contextLimits._maximumTextureSize;
    const { state, dash } = dashBuild(true, 1);
    contextLimits._maximumTextureSize = 3;
    try {
      expect(() => stepLineBuild(state, { exhausted: false })).toThrow(/capacity/);
    }
    finally {
      contextLimits._maximumTextureSize = previous;
      state.collection?.destroy();
      dash.material.destroy();
    }
  });

  it('bounds FLOAT record addresses without requiring an initialized Native context', () => {
    const previous = contextLimits._maximumTextureSize;
    const { state, dash } = dashBuild(true, 3);
    contextLimits._maximumTextureSize = 0;
    try {
      // Exercise page assembly using real typed-array record counts without
      // constructing millions of extrusion vertices or uploading anything.
      while (state.layerIndex === 0)
        expect(state.iterator!.next().done).toBe(false);
      const instances = state.byLayer[0].instances!;
      const original = instances[0].geometry;
      const input = lineInputs.get(original)!;
      instances[0].geometry = new Geometry({ ...original });
      lineInputs.set(instances[0].geometry, { ...input, positions: new Float64Array((2 ** 24 - 2) * 3) });
      expect(stepLineBuild(state, { exhausted: false })).toBe(true);
      const collection = commitLineBuild(state)!;
      expect(collection.length).toBe(2);
      expect(collection.get(0).geometryInstances).toHaveLength(2);
      expect(collection.get(1).geometryInstances).toHaveLength(1);
    }
    finally {
      contextLimits._maximumTextureSize = previous;
      state.collection?.destroy();
      dash.material.destroy();
    }
  });

  it('invalidates feature-state row edits', () => {
    const { state, bucket, array, dash } = dashBuild();
    stepLineBuild(state, { exhausted: false });
    expect(canResumeLineBuild(state)).toBe(true);
    new Uint16Array(array.arrayBuffer)[5] = 2;
    bucket.programConfigurations.paintRevision++;
    expect(canResumeLineBuild(state)).toBe(false);
    state.collection!.destroy();
    dash.material.destroy();
  });

  it('checks source references and layout on every path after feature keys have been verified', () => {
    const { state, bucket, dash } = dashBuild(true);
    stepLineBuild(state, { exhausted: false });
    expect(canResumeLineBuild(state)).toBe(true);
    const source = state.byLayer[0].sources[99];
    const positions = source.positions;
    source.positions = positions.slice();
    expect(canResumeLineBuild(state)).toBe(false);
    source.positions = positions;
    const tilePositions = source.tilePositions;
    source.tilePositions = tilePositions.slice();
    expect(canResumeLineBuild(state)).toBe(false);
    source.tilePositions = tilePositions;
    expect(canResumeLineBuild(state)).toBe(true);
    bucket.featureLineJoinCaps[source.featureIndex] = { ...bucket.lineJoinCap, miterLimit: 3 };
    expect(canResumeLineBuild(state)).toBe(false);
    state.collection!.destroy();
    dash.material.destroy();
  });
});
