// Private MapLibre 6.11.2 contracts, used only outside measured frames.
interface Buffer { buffer?: WebGLBuffer; length?: number }
const bufferFields = [
  'layoutVertexBuffer',
  'layoutVertexBuffer2',
  'centroidVertexBuffer',
  'indexBuffer',
  'indexBuffer2',
  'dynamicLayoutVertexBuffer',
  'opacityVertexBuffer',
  'collisionVertexBuffer',
] as const;
const paintFields = ['paintVertexBuffer', 'zoomInPaintVertexBuffer', 'zoomOutPaintVertexBuffer'] as const;
interface BufferOwner extends Partial<Record<(typeof bufferFields)[number], Buffer>> {
  indexArray?: { length: number };
  programConfigurations?: {
    programConfigurations: Record<string, {
      binders: Record<string, Partial<Record<(typeof paintFields)[number], Buffer>>>;
    }>;
  };
}
interface Bucket extends BufferOwner {
  layers: Array<{ type: string }>;
  uploaded: boolean;
  text?: BufferOwner;
  icon?: BufferOwner;
  textCollisionBox?: BufferOwner;
  iconCollisionBox?: BufferOwner;
}
interface Tile {
  uid: number;
  tileID: { key: string; canonical: { z: number; x: number; y: number }; wrap: number };
  state: string;
  uses: number;
  buckets: Record<string, Bucket>;
}
interface TileManager {
  _inViewTiles: { getAllTiles: () => Tile[] };
  _outOfViewCache: { max: number; data: Record<string, Array<{ value: Tile }>> };
}
interface TileReference { source: string; state: 'active' | 'cached'; cacheKey?: string; version?: number }
interface BufferAllocation { id: number; bytes: number; references: Array<{ row: number; field: string }> }

/** Account all resident vector buckets using actual bufferData capacities. */
export function maplibreBufferSnapshot(map: object, contextBuffers: Map<WebGLBuffer, number>) {
  const managers = (map as { style: { tileManagers: Record<string, TileManager> } }).style.tileManagers;
  const residents = new Map<Tile, TileReference[]>();
  const cacheCapacities: Record<string, number> = {};
  function add(tile: Tile, reference: TileReference) {
    const references = residents.get(tile);
    if (references)
      references.push(reference);
    else
      residents.set(tile, [reference]);
  }
  for (const [source, manager] of Object.entries(managers)) {
    cacheCapacities[source] = manager._outOfViewCache.max;
    for (const tile of manager._inViewTiles.getAllTiles())
      add(tile, { source, state: 'active' });
    // A wrapped key can retain several versions. Reading never removes them.
    for (const [cacheKey, versions] of Object.entries(manager._outOfViewCache.data)) {
      versions.forEach(({ value }, version) => add(value, { source, state: 'cached', cacheKey, version }));
    }
  }

  const allocations = new Map<WebGLBuffer, BufferAllocation>();
  const tiles = [];
  const rows: Array<{
    tile: number;
    state: 'active' | 'cached';
    kind: string;
    layers: string[];
    uploaded: boolean;
    vertices: number;
    indexTriangles: number;
    assignedBytes: number;
    referencedBytes: number;
    bufferIds: number[];
  }> = [];
  for (const [tile, references] of residents) {
    const state = references.some(reference => reference.state === 'active') ? 'active' : 'cached';
    const tileIndex = tiles.length;
    tiles.push({ uid: tile.uid, key: tile.tileID.key, ...tile.tileID.canonical, wrap: tile.tileID.wrap, state, tileState: tile.state, uses: tile.uses, references });
    // Several style layer keys can alias the same bucket.
    const buckets = new Map<Bucket, string[]>();
    for (const [layer, bucket] of Object.entries(tile.buckets)) {
      const layers = buckets.get(bucket);
      if (layers)
        layers.push(layer);
      else
        buckets.set(bucket, [layer]);
    }
    for (const [bucket, layers] of buckets) {
      const row: (typeof rows)[number] = { tile: tileIndex, state, kind: bucket.layers[0].type, layers, uploaded: bucket.uploaded, vertices: 0, indexTriangles: bucket.indexArray?.length ?? 0, assignedBytes: 0, referencedBytes: 0, bufferIds: [] as number[] };
      const rowIndex = rows.length;
      const rowBuffers = new Set<WebGLBuffer>();
      function visitBuffer(wrapper: Buffer | undefined, field: string) {
        const handle = wrapper?.buffer;
        if (!handle)
          return;
        const bytes = contextBuffers.get(handle);
        if (bytes === undefined)
          throw new Error(`MapLibre ${field} has no actual bufferData allocation`);
        let allocation = allocations.get(handle);
        if (!allocation) {
          allocation = { id: allocations.size, bytes, references: [] };
          allocations.set(handle, allocation);
          row.assignedBytes += bytes;
        }
        allocation.references.push({ row: rowIndex, field });
        if (!rowBuffers.has(handle)) {
          rowBuffers.add(handle);
          row.referencedBytes += bytes;
          row.bufferIds.push(allocation.id);
        }
      }
      function visitOwner(owner: BufferOwner, prefix: string) {
        row.vertices += owner.layoutVertexBuffer?.length ?? 0;
        for (const field of bufferFields)
          visitBuffer(owner[field], `${prefix}${field}`);
        for (const [layer, configuration] of Object.entries(owner.programConfigurations?.programConfigurations ?? {})) {
          for (const [property, binder] of Object.entries(configuration.binders)) {
            // Crossfade retains both arrays even when only one is bound.
            for (const field of paintFields)
              visitBuffer(binder[field], `${prefix}paint.${layer}.${property}.${field}`);
          }
        }
      }
      visitOwner(bucket, '');
      for (const field of ['text', 'icon', 'textCollisionBox', 'iconCollisionBox'] as const) {
        const owner = bucket[field];
        if (owner) {
          if (field === 'text' || field === 'icon')
            row.indexTriangles += owner.indexArray?.length ?? 0;
          visitOwner(owner, `${field}.`);
        }
      }
      rows.push(row);
    }
  }
  const bytes = [...allocations.values()].reduce((sum, allocation) => sum + allocation.bytes, 0);
  const unattributed = [...contextBuffers].filter(([handle]) => !allocations.has(handle)).map(([, size], id) => ({ id, bytes: size }));
  const byKind = Object.fromEntries([...new Set(rows.map(row => row.kind))].map(kind => [kind, {
    activeBytes: rows.filter(row => row.kind === kind && row.state === 'active').reduce((sum, row) => sum + row.assignedBytes, 0),
    cachedBytes: rows.filter(row => row.kind === kind && row.state === 'cached').reduce((sum, row) => sum + row.assignedBytes, 0),
    vertices: rows.filter(row => row.kind === kind).reduce((sum, row) => sum + row.vertices, 0),
  }]));
  return { bytes, unattributedBytes: unattributed.reduce((sum, allocation) => sum + allocation.bytes, 0), cacheCapacities, byKind, tiles, rows, allocations: [...allocations.values()], unattributed };
}
