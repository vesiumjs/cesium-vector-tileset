import type { Primitive, PrimitiveCollection } from 'cesium';
import type { SymbolHalf } from '../../packages/cesium-vector-tileset/src/render/symbol/symbol-renderer';
import type { NativePrimitive, TestTileset, TestViewer } from './browser-types';

/** Read ownership and readiness only; never request a frame or touch GPU storage. */
export function cityReadiness(tileset: TestTileset, viewer: TestViewer) {
  const symbols = tileset._symbolRenderer;
  const residency = tileset._tileResidency;
  const scene = tileset._sceneCollections;
  const entryIds = new Map<object, number>();
  const collectionIds = new Map<object, number>();
  const primitiveIds = new Map<object, number>();
  const id = (values: Map<object, number>, value: object): number => {
    let result = values.get(value);
    if (result === undefined) {
      result = values.size;
      values.set(value, result);
    }
    return result;
  };
  const primitive = (value: Primitive) => {
    const native = value as NativePrimitive;
    const destroyed = value.isDestroyed();
    return {
      id: id(primitiveIds, value),
      destroyed,
      show: value.show,
      ready: value.ready,
      state: native._state,
      batchTable: !!native._batchTable,
      vertexArrays: destroyed ? [] : (native._va ?? []).map(array => ({ destroyed: array.isDestroyed(), vertices: array.numberOfVertices })),
    };
  };
  const collection = (value: PrimitiveCollection) => {
    const destroyed = value.isDestroyed();
    const upload = scene._firstUpdates.flatMap((queue, priority) => {
      const state = queue.get(value);
      return state ? [{ priority, index: state.index, staged: state.staged, drawable: [...state.drawable] }] : [];
    });
    return {
      id: id(collectionIds, value),
      destroyed,
      show: value.show,
      rootContains: scene._root.contains(value),
      firstUpdate: scene.hasPendingFirstUpdate(value),
      upload,
      primitives: destroyed ? [] : Array.from({ length: value.length }, (_, index) => primitive(value.get(index) as Primitive)),
    };
  };
  type Entry = TestTileset['_symbolRenderer']['_tiles'] extends Map<string, infer Value> ? Value : never;
  const entry = (tileId: string, value: Entry) => ({
    id: id(entryIds, value),
    tileId,
    current: symbols._tiles.get(tileId) === value,
    visibleOwner: symbols._visibleEntries.get(tileId) === value,
    placed: value.placed,
    active: symbols.isTilePlacementActive(tileId),
    layers: [...value.layerIds],
    collections: value.collections.map(collection),
    batches: value.batches.map((batch, index) => ({
      layerId: value.layerIds[index],
      parts: (['text', 'icon'] as const).flatMap((part) => {
        const geometry = batch[part];
        return geometry ? [{ part, instances: geometry.instances.length, visible: geometry.instances.reduce((count, instance) => count + Number(geometry.opacities[instance.vertexStart] > 0), 0), opacityDirty: geometry.opacityDirty }] : [];
      }),
    })),
  });
  const scope = (value: typeof symbols._targetPlacement) => {
    const batches = (values: typeof value.batches) => values.map(batch => ({ tileId: batch.tileId, entryId: id(entryIds, batch.entry), index: batch.index, current: symbols._tiles.get(batch.tileId) === batch.entry, visibleOwner: symbols._visibleEntries.get(batch.tileId) === batch.entry }));
    const view = (value: NonNullable<typeof symbols._lineView>) => ({ zoom: value.cameraZoom, width: value.width, height: value.height, pixelRatio: value.pixelRatio, viewport: value.viewport && { ...value.viewport }, projection: Array.from(value.viewProjection) });
    return {
      pending: value.pending,
      dirty: value._dirty,
      urgent: value._urgent,
      revision: value._revision,
      lastCommitMs: value._lastCommitMs,
      view: value._view && view(value._view),
      batches: batches(value.batches),
      job: value.job && { revision: value.job.revision, current: value.job.revision === value._revision, batchIndex: value.job.pass._batchIndex, view: view(value.job.view), batches: batches(value.job.batches) },
      complete: value.complete && { revision: value.complete.revision, current: value.isCurrent(value.complete), view: view(value.complete.view), batches: batches(value.complete.batches) },
    };
  };
  const pendingHalf = (half: SymbolHalf) => ({
    layerId: half.layerId,
    part: half.part,
    opacityDirty: half.opacity?.geometry.opacityDirty,
    dynamicDirty: half.dynamic?.dirty,
    opacityTarget: half.opacity?.target && primitive(half.opacity.target.primitive),
    dynamicTarget: half.dynamic?.target && primitive(half.dynamic.target.primitive),
  });
  return {
    at: performance.now(),
    frame: viewer.scene._frameState.frameNumber,
    tilesLoaded: tileset.tilesLoaded,
    styleLoaded: tileset._style.loaded(),
    firstUpdates: scene.pendingFirstUpdateCount,
    paint: tileset._vectorRenderer.needsPaintUpdate,
    jobs: [...tileset._tilePublishQueue._jobs].map(([tileId, job]) => ({ tileId, generationId: job.generationId, surfaces: job.surfaces, symbols: job.symbols, progress: { ...job.progress } })),
    patternRefreshes: tileset._tilePublishQueue._patternRefreshes.size,
    residency: {
      visibleSymbolTiles: [...residency._visibleSymbolTiles],
      hiddenSymbols: [...residency._visibility.hiddenSymbols],
      hiddenStyleTiles: [...residency.hiddenStyleTiles],
      pendingRetirements: [...residency._pendingSymbolRetirements],
      sources: [...residency._sources].map(([sourceId, source]) => ({ sourceId, held: [...source.held], renderableIds: [...source.renderableIds], hydrated: [...source.hydrated], mode: source.mode })),
      tiles: [...residency._tiles].map(([tileId, tile]) => ({ tileId, live: tile.live, generationId: tile.generationId, previousGenerationId: tile.previousGenerationId, publication: tile.publication && { ...tile.publication }, hasSymbols: tile.hasSymbols })),
    },
    symbols: {
      drawable: symbols.hasDrawableSymbols,
      pending: symbols.hasPendingWork,
      runnable: symbols.hasRunnableWork,
      zoom: symbols.cameraZoom,
      lineZoom: symbols._lineView?.cameraZoom,
      fullReplace: symbols._fullReplaceNeeded,
      visibleInputs: symbols._visibleInputsDirty,
      images: symbols._pendingImageEntries.size,
      hiddenTiles: [...symbols._hiddenPlacementTiles],
      excludedTiles: [...symbols._excludedPlacementTiles],
      // The requested owner set exists only while a handoff is being prepared.
      prospectiveTiles: symbols._prospectiveVisibleTiles && [...symbols._prospectiveVisibleTiles],
      target: scope(symbols._targetPlacement),
      visible: scope(symbols._visiblePlacement),
      handoff: scope(symbols._handoffPlacement),
      entries: [...symbols._tiles].map(([tileId, value]) => entry(tileId, value)),
      visibleEntries: [...symbols._visibleEntries].map(([tileId, value]) => entry(tileId, value)),
      held: [...symbols._held].map(([heldId, value]) => ({ heldId, ...entry(value.input.tileId, value) })),
      fading: [...symbols._fading].map(([tileId, value]) => ({ startedMs: value.startedMs, durationMs: value.durationMs, ...entry(tileId, value.entry) })),
      opacity: [...symbols._pendingOpacityHalves].map(pendingHalf),
      dynamic: [...symbols._pendingDynamicHalves].map(pendingHalf),
    },
    replacements: [...scene._replacements].map(value => ({ tileId: value.tileId, kind: value.kind, visible: value.visible, awaitingDetail: value.awaitingDetail, waiting: value.waiting.size, old: [...value.old].map(value => ({ id: id(collectionIds, value), destroyed: value.isDestroyed(), show: value.show })), next: [...value.next].map(value => ({ id: id(collectionIds, value), destroyed: value.isDestroyed(), show: value.show })) })),
  };
}
