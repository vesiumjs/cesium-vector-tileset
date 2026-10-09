/** Unpremultiplied RGBA pixels for a named style image. */
export interface TilesetImage {
  width: number;
  height: number;
  data: Uint8Array | Uint8ClampedArray;
}

export interface TilesetImageOptions {
  pixelRatio?: number;
  sdf?: boolean;
  stretchX?: Array<[number, number]>;
  stretchY?: Array<[number, number]>;
  content?: [number, number, number, number];
}

/** Cached tile, rendering and allocation counters from the last update. */
export interface TilesetStats {
  renderableTiles: number;
  pendingPublishes: number;
  bucket: { tiles: number; collections: number; retiredTiles: number };
  symbol: { tiles: number; fadingTiles: number; retiredTiles: number; primitives: number };
  pattern: { tiles: number; retiredTiles: number; layerCollections: number };
  raster: { tiles: number; layerCollections: number };
  featureIndexes: number;
  gpuMemory: { totalBytes: number; maxBytes: number; entries: number; evictions: number };
  renderPassGpuBytes: number;
  submittedCommands: number;
}
