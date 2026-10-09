import type { Feature, LayerSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { Style } from '../../style/style';
import type { SymbolStyleLayer } from '../../style/style-layer/symbol-style-layer';
import type { TypedStyleLayer } from '../../style/style-layer/typed-style-layer';
import { describe, expect, it } from 'vitest';
import { ImagePosition } from '../../assets/image-atlas';
import { EvaluationParameters } from '../../style/evaluation-parameters';
import { StyleLayerIndex } from '../../style/style-layer-index';
import { RGBAImage } from '../../util/image';
import { createTileTransferRegistry } from '../../worker/tile-transfer';
import { deserialize } from '../bucket';
import { CircleBucket, SymbolBucket, SymbolBuffers } from '../bucket-runtime';
import { ProgramConfigurationSet } from '../program-configuration';

function layer(specification: LayerSpecification, zoom: number): TypedStyleLayer {
  const index = new StyleLayerIndex([specification]);
  const value = index._layers[specification.id] as TypedStyleLayer;
  value.recalculate(new EvaluationParameters(zoom), []);
  return value;
}

function transfer<T>(input: T): T {
  const buffers: Transferable[] = [];
  const encoded = createTileTransferRegistry().serialize(input, buffers);
  return createTileTransferRegistry().deserialize(structuredClone(encoded, { transfer: buffers })) as T;
}

function style(layers: TypedStyleLayer[]): Style {
  return { getLayer: (id: string) => layers.find(value => value.id === id) } as unknown as Style;
}

describe('transferred paint expressions', () => {
  it('transfers paint arrays and interpolation metadata without expression ASTs', () => {
    const specifications: LayerSpecification[] = [
      { id: 'source', type: 'circle', source: 'vector', paint: { 'circle-radius': ['number', ['feature-state', 'radius'], 2] } },
      { id: 'composite', type: 'circle', source: 'vector', paint: { 'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 2, ['number', ['get', 'radius']], 3, ['*', 4, ['number', ['get', 'radius']]]] } },
      { id: 'pattern', type: 'fill', source: 'vector', paint: { 'fill-pattern': ['get', 'pattern'] } },
      { id: 'dash', type: 'line', source: 'vector', paint: { 'line-dasharray': ['case', ['boolean', ['get', 'dashed'], false], ['literal', [2, 1]], ['literal', [1, 1]]] } },
    ];
    const configurations = new ProgramConfigurationSet(specifications.map(specification => layer(specification, 2)), 2);
    const encoded = createTileTransferRegistry().serialize(configurations);
    expect(JSON.stringify(encoded)).not.toContain('"expression"');
    const restored = transfer(configurations);
    const mainLayers = specifications.map(specification => layer(specification, 8));
    restored.bindLayers(mainLayers);
    for (const mainLayer of mainLayers) {
      const configuration = restored.get(mainLayer.id);
      for (const [property, binder] of Object.entries(configuration.binders)) {
        expect(binder.expression).toBe((mainLayer.paint.get as (name: string) => { value: unknown })(property).value);
      }
    }
    expect(restored.get('composite').getInterpolationFactor('circle-radius', 2.5)).toBeCloseTo(Math.SQRT2 - 1);
  });

  it('binds Composite paint through bucket publication while retaining the worker zoom and feature-state slots', () => {
    const specification: LayerSpecification = {
      id: 'circles',
      type: 'circle',
      source: 'vector',
      paint: { 'circle-radius': ['interpolate', ['exponential', 2], ['zoom'], 2, ['+', ['number', ['get', 'radius']], ['number', ['feature-state', 'extra'], 0]], 3, ['*', 4, ['+', ['number', ['get', 'radius']], ['number', ['feature-state', 'extra'], 0]]]] },
    };
    const workerLayer = layer(specification, 2);
    const configurations = new ProgramConfigurationSet([workerLayer], 2);
    const feature: Feature = { id: 42, type: 1, properties: { radius: 2 } };
    configurations.populatePaintArrays(1, feature, 9, { imagePositions: {} });
    const bucket = Object.assign(new CircleBucket(), { layerIds: ['circles'], stateDependentLayerIds: ['circles'], programConfigurations: configurations });
    const mainLayer = layer(specification, 8);
    const published = deserialize(transfer([bucket]), style([mainLayer])).circles as CircleBucket;
    const configuration = published.programConfigurations.get('circles');
    expect(configuration.getInterpolationFactor('circle-radius', 2.5)).toBeCloseTo(Math.SQRT2 - 1);
    expect([...new Float32Array(configuration.getAttributeArray('circle-radius')!.arrayBuffer)]).toEqual([2, 8]);
    published.update([{ id: '42', state: { extra: 3 } }], (index) => {
      expect(index).toBe(9);
      return feature;
    }, { imagePositions: {} });
    expect([...new Float32Array(configuration.getAttributeArray('circle-radius')!.arrayBuffer)]).toEqual([5, 20]);
    expect(published.programConfigurations.paintRevision).toBe(1);
  });

  it('binds text and icon paint with formatted-section overrides before symbol state updates', () => {
    const specification: LayerSpecification = {
      id: 'labels',
      type: 'symbol',
      source: 'vector',
      layout: { 'text-field': ['format', 'A', { 'text-color': '#ff0000' }, 'B', {}] },
      paint: { 'text-color': ['case', ['boolean', ['feature-state', 'active'], false], '#00ff00', '#0000ff'], 'icon-opacity': ['case', ['boolean', ['feature-state', 'active'], false], 0.8, 0.2] },
    };
    const workerLayer = layer(specification, 2);
    const text = new ProgramConfigurationSet([workerLayer], 2, property => property.startsWith('text'));
    const icon = new ProgramConfigurationSet([workerLayer], 2, property => property.startsWith('icon'));
    const feature: Feature = { id: 42, type: 1, properties: {} };
    const formatted = (workerLayer as SymbolStyleLayer).layout.get('text-field').evaluate(feature, {});
    for (const [index, formattedSection] of formatted.sections.entries())
      text.populatePaintArrays(index + 1, feature, 9, { imagePositions: {}, formattedSection });
    icon.populatePaintArrays(1, feature, 9, { imagePositions: {} });
    const bucket = Object.assign(new SymbolBucket(), { layerIds: ['labels'], stateDependentLayerIds: ['labels'], text: new SymbolBuffers(text), icon: new SymbolBuffers(icon) });
    const mainLayer = layer(specification, 8);
    const published = deserialize(transfer([bucket]), style([mainLayer])).labels as SymbolBucket;
    published.update([{ id: '42', state: { active: true } }], (index) => {
      expect(index).toBe(9);
      return feature;
    }, { imagePositions: {} });
    expect([...new Float32Array(published.text.programConfigurations.get('labels').getAttributeArray('text-color')!.arrayBuffer)]).toEqual([65280, 255, 255, 255]);
    expect(new Float32Array(published.icon.programConfigurations.get('labels').getAttributeArray('icon-opacity')!.arrayBuffer)[0]).toBeCloseTo(0.8);
  });

  it('retains both crossfade atlas entries after binding pattern and dash paint', () => {
    const specifications: LayerSpecification[] = [
      { id: 'pattern', type: 'fill', source: 'vector', paint: { 'fill-pattern': ['get', 'pattern'] } },
      { id: 'dash', type: 'line', source: 'vector', paint: { 'line-dasharray': ['case', ['boolean', ['get', 'dashed'], false], ['literal', [2, 1]], ['literal', [1, 1]]] } },
    ];
    const configurations = new ProgramConfigurationSet(specifications.map(specification => layer(specification, 2)), 2);
    const feature: Feature = {
      id: 42,
      type: 2,
      properties: { pattern: 'to', dashed: true },
      patterns: { pattern: { min: 'from', mid: 'to', max: 'to' } },
      dashes: { dash: { min: 'from', mid: 'to', max: 'to' } },
    };
    const image = { data: new RGBAImage({ width: 8, height: 8 }), pixelRatio: 1 };
    const options = {
      imagePositions: {
        from: new ImagePosition({ x: 0, y: 0, w: 10, h: 10 }, image),
        to: new ImagePosition({ x: 12, y: 0, w: 10, h: 10 }, image),
      },
      dashPositions: { from: { y: 2, height: 4, width: 3 }, to: { y: 8, height: 6, width: 7 } },
    };
    configurations.populatePaintArrays(1, feature, 9, options);
    const restored = transfer(configurations);
    restored.bindLayers(specifications.map(specification => layer(specification, 8)));
    restored.populatePaintArrays(2, feature, 10, options);
    const pattern = restored.get('pattern').getAttributeArray('fill-pattern')!;
    const dash = restored.get('dash').getAttributeArray('line-dasharray')!;
    expect([...new Uint16Array(pattern.arrayBuffer).slice(0, 20)]).toEqual([
      1,
      1,
      9,
      9,
      13,
      1,
      21,
      9,
      1,
      1,
      1,
      1,
      9,
      9,
      13,
      1,
      21,
      9,
      1,
      1,
    ]);
    expect([...new Uint16Array(dash.arrayBuffer).slice(0, 16)]).toEqual([
      0,
      2,
      4,
      3,
      0,
      8,
      6,
      7,
      0,
      2,
      4,
      3,
      0,
      8,
      6,
      7,
    ]);
  });
});
