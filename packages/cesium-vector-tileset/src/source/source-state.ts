import type { FeatureState } from '@maplibre/maplibre-gl-style-spec';
import type { Style } from '../style/style';
import type { ActiveTiles } from '../tile/active-tiles';
import type { Tile } from '../tile/tile';

export interface FeatureStateEntry { id: string; state: FeatureState }
export type FeatureStates = FeatureStateEntry[];
export type LayerFeatureStates = Record<string, FeatureStates>;

type FeatureStatesMap = Record<string, FeatureState>;
type LayerFeatureStatesMap = Record<string, FeatureStatesMap>;
type DeletedFeatureState = Record<string, null>;
type DeletedLayerState = Record<string, DeletedFeatureState | null>;
type DeletedStatesMap = Record<string, DeletedLayerState | null>;

function featureStatesMapToArray(map: FeatureStatesMap): FeatureStates {
  const result: FeatureStates = [];
  for (const id in map) {
    result.push({ id, state: map[id] });
  }
  return result;
}

/**
 * SourceFeatureState manages the state and pending changes
 * to features in a source, separated by source layer.
 * stateChanges and deletedStates batch all changes to the tile (updates and removes, respectively)
 * between coalesce() events. addFeatureState() and removeFeatureState() also update their counterpart's
 * list of changes, such that coalesce() can apply the proper state changes while agnostic to the order of operations.
 * In deletedStates, null denotes complete removal of state at that scope.
 * @internal
 */
export class SourceFeatureState {
  state: LayerFeatureStatesMap;
  stateChanges: LayerFeatureStatesMap;
  deletedStates: DeletedStatesMap;
  revision: number;

  private _hasPendingChanges = false;

  constructor() {
    this.state = {};
    this.stateChanges = {};
    this.deletedStates = {};
    this.revision = 0;
  }

  updateState(sourceLayer: string, featureId: number | string, newState: FeatureState): void {
    this._hasPendingChanges = true;
    const feature = String(featureId);
    this.stateChanges[sourceLayer] ||= {};
    this.stateChanges[sourceLayer][feature] ||= {};
    Object.assign(this.stateChanges[sourceLayer][feature], newState);

    if (this.deletedStates[sourceLayer] === null) {
      const layerDeletion: DeletedLayerState = this.deletedStates[sourceLayer] = {};
      for (const ft in this.state[sourceLayer] ?? {}) {
        if (ft === feature) {
          const featureDeletion: DeletedFeatureState = layerDeletion[feature] = {};
          for (const prop in this.state[sourceLayer][ft]) {
            if (newState[prop] === undefined)
              featureDeletion[prop] = null;
          }
        }
        else {
          layerDeletion[ft] = null;
        }
      }
    }
    else {
      const layerDeletion = this.deletedStates[sourceLayer];
      const featureDeletionQueued = layerDeletion?.[feature] === null;
      if (featureDeletionQueued) {
        const featureDeletion: DeletedFeatureState = layerDeletion[feature] = {};
        for (const prop in this.state[sourceLayer]?.[feature] ?? {}) {
          if (newState[prop] === undefined)
            featureDeletion[prop] = null;
        }
      }
      else {
        const featureDeletion = layerDeletion?.[feature];
        for (const key in newState) {
          if (featureDeletion && featureDeletion[key] === null)
            delete featureDeletion[key];
        }
      }
    }
  }

  removeFeatureState(sourceLayer: string, featureId?: number | string, key?: string): void {
    if (this.deletedStates[sourceLayer] === null)
      return;

    this._hasPendingChanges = true;

    const feature = String(featureId);
    const layerDeletion: DeletedLayerState = this.deletedStates[sourceLayer] ||= {};

    if (key && featureId !== undefined) {
      if (layerDeletion[feature] !== null) {
        const featureDeletion: DeletedFeatureState = layerDeletion[feature] ||= {};
        featureDeletion[key] = null;
      }
    }
    else if (featureId !== undefined) {
      const updateInQueue = this.stateChanges[sourceLayer]?.[feature];
      if (updateInQueue) {
        const featureDeletion: DeletedFeatureState = layerDeletion[feature] = {};
        for (key in updateInQueue)
          featureDeletion[key] = null;
      }
      else {
        layerDeletion[feature] = null;
      }
    }
    else {
      this.deletedStates[sourceLayer] = null;
    }
  }

  getState(sourceLayer: string, featureId: number | string): FeatureState {
    const feature = String(featureId);
    const base = this.state[sourceLayer] || {};
    const changes = this.stateChanges[sourceLayer] || {};
    const reconciledState = Object.assign({}, base[feature], changes[feature]);
    const layerDeletion = this.deletedStates[sourceLayer];

    if (layerDeletion === null)
      return {};

    const featureDeletions = layerDeletion?.[feature];
    if (featureDeletions === null)
      return {};

    for (const prop in featureDeletions ?? {})
      delete reconciledState[prop];

    return reconciledState;
  }

  hasPendingChanges(): boolean {
    return this._hasPendingChanges;
  }

  initializeTileState(tile: Tile, style: Style): void {
    const layerStates: LayerFeatureStates = {};
    for (const sourceLayer in this.state) {
      layerStates[sourceLayer] = featureStatesMapToArray(this.state[sourceLayer]);
    }
    tile.setFeatureState(layerStates, style, this.revision);
  }

  coalesceChanges(activeTiles: ActiveTiles, style: Style): void {
    if (!this._hasPendingChanges)
      return;

    // Track changes with full state objects, deduplicated by feature id.
    const featuresChangedMap: LayerFeatureStatesMap = {};

    for (const sourceLayer in this.stateChanges) {
      this.state[sourceLayer] ||= {};
      featuresChangedMap[sourceLayer] ||= {};
      for (const feature in this.stateChanges[sourceLayer]) {
        this.state[sourceLayer][feature] ||= {};
        Object.assign(this.state[sourceLayer][feature], this.stateChanges[sourceLayer][feature]);
        featuresChangedMap[sourceLayer][feature] = this.state[sourceLayer][feature];
      }
    }

    for (const sourceLayer in this.deletedStates) {
      this.state[sourceLayer] ||= {};
      featuresChangedMap[sourceLayer] ||= {};
      const layerDeletion = this.deletedStates[sourceLayer];

      if (layerDeletion === null) {
        for (const feature in this.state[sourceLayer]) {
          this.state[sourceLayer][feature] = {};
          featuresChangedMap[sourceLayer][feature] = {};
        }
      }
      else if (layerDeletion) {
        for (const feature in layerDeletion) {
          const featureDeletion = layerDeletion[feature];
          if (featureDeletion === null) {
            this.state[sourceLayer][feature] = {};
          }
          else {
            for (const key of Object.keys(featureDeletion))
              delete this.state[sourceLayer][feature][key];
          }
          featuresChangedMap[sourceLayer][feature] = this.state[sourceLayer][feature];
        }
      }
    }

    this.stateChanges = {};
    this.deletedStates = {};
    this._hasPendingChanges = false;

    if (Object.keys(featuresChangedMap).length === 0)
      return;

    this.revision++;

    const featuresChanged: LayerFeatureStates = {};
    for (const sourceLayer in featuresChangedMap) {
      featuresChanged[sourceLayer] = featureStatesMapToArray(featuresChangedMap[sourceLayer]);
    }

    activeTiles.setFeatureState(featuresChanged, style, this.revision);
  }
}
