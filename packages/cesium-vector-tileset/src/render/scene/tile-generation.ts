import type { SceneMode } from 'cesium';
import type { FeatureIndex } from '../../data/feature-index';
import type { Tile } from '../../tile/tile';

export interface TilePublicationProgress {
  vector: 'pending' | 'surface' | 'complete';
  pattern: boolean;
  symbol: boolean;
}

export type TileGenerationData = Pick<Tile, 'tileID' | 'buckets' | 'textureData' | 'collisionBoxArray'
  | 'glyphAtlasImage' | 'imageAtlas' | 'dashRows'>;

/** Owns one payload's publication and picking lifetime, independently of GPU readiness. */
export class TileGeneration {
  readonly data: TileGenerationData;
  readonly styleRevision: number;
  readonly mode: SceneMode;
  readonly publication: TilePublicationProgress;
  featureIndex: FeatureIndex | undefined;
  private _id: number | undefined;
  private _hasSymbols = false;

  constructor(tile: Tile, styleRevision: number, mode: SceneMode, id?: number, publication?: Readonly<TilePublicationProgress>) {
    this.data = {
      tileID: tile.tileID,
      buckets: tile.buckets,
      textureData: tile.textureData,
      collisionBoxArray: tile.collisionBoxArray,
      glyphAtlasImage: tile.glyphAtlasImage,
      imageAtlas: tile.imageAtlas,
      dashRows: tile.dashRows,
    };
    this.featureIndex = tile.latestFeatureIndex;
    this.styleRevision = styleRevision;
    this.mode = mode;
    this._id = id;
    this.publication = publication ? { ...publication } : { vector: 'pending', pattern: false, symbol: false };
  }

  get reservedId(): number | undefined {
    return this._id;
  }

  get id(): number {
    if (this._id === undefined)
      throw new Error('A tile generation must be reserved before publication.');
    return this._id;
  }

  reserve(id: number): void {
    if (this._id !== undefined && this._id !== id)
      throw new Error('A tile generation cannot change its reserved identity.');
    this._id = id;
  }

  get complete(): boolean {
    return this.publication.vector === 'complete' && this.publication.pattern && this.publication.symbol;
  }

  matches(tile: Tile, styleRevision: number, mode: SceneMode): boolean {
    return this.data.buckets === tile.buckets && this.styleRevision === styleRevision && this.mode === mode;
  }

  publishedSymbols(drawable: boolean): void {
    this._hasSymbols = drawable;
  }

  /** Resume cancelled work without treating independently evicted symbols as cached. */
  resume(tile: Tile, vectorResident: boolean, symbolResident: boolean): boolean {
    this.featureIndex = tile.latestFeatureIndex;
    if (!vectorResident)
      this.publication.vector = 'pending';
    if (this._hasSymbols && !symbolResident)
      this.publication.symbol = false;
    return !this.complete;
  }
}
