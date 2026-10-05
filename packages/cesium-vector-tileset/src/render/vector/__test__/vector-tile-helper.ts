import type { VectorTileBuildInput } from '../vector-tile-builder';
import type { VectorCollection, VectorTileRenderer } from '../vector-tile-renderer';
import { SceneMode } from 'cesium';
import { UNBOUNDED_BUDGET } from '../../scene/frame-budget';

/** Run the production build protocol synchronously for renderer tests. */
export function buildVectorTile(
  renderer: VectorTileRenderer,
  input: Omit<VectorTileBuildInput, 'mode' | 'styleZoom'> & Partial<Pick<VectorTileBuildInput, 'mode' | 'styleZoom'>>,
): VectorCollection | null {
  const state = renderer.beginTileBuild({ mode: SceneMode.SCENE3D, styleZoom: 0, ...input });
  let complete = renderer.advanceTileBuild(state, UNBOUNDED_BUDGET);
  while (!complete) complete = renderer.advanceTileBuild(state, UNBOUNDED_BUDGET);
  return renderer.commitTileBuild(state);
}
