import type { CameraFrameSnapshot } from '../scene/render-frame';
import type { PlacementView } from './symbol-placement';
import { Cartesian3, Cartographic, Ellipsoid, EllipsoidalOccluder, SceneMode, WebMercatorProjection } from 'cesium';
import { symbolViewProjection } from './symbol-placement';

interface SymbolFrame extends PlacementView {
  viewProjection: Float64Array;
}

/** Converts one frozen camera into the coordinate system used by symbol drawing and collision. */
export function symbolFrame(snapshot: CameraFrameSnapshot, cameraZoom: number): SymbolFrame {
  const { mode, mapProjection, centerLng } = snapshot;
  let isPointVisible: PlacementView['isPointVisible'];
  let projectPosition: PlacementView['projectPosition'];
  if (mode === SceneMode.SCENE3D) {
    const occluder = new EllipsoidalOccluder(mapProjection.ellipsoid, snapshot.positionWC);
    const position = new Cartesian3();
    isPointVisible = (x, y, z) => {
      position.x = x;
      position.y = y;
      position.z = z;
      return occluder.isPointVisible(position);
    };
  }
  else {
    const ellipsoid = mapProjection.ellipsoid ?? Ellipsoid.WGS84;
    const world = new Cartesian3();
    const cartographic = new Cartographic();
    const projected = new Cartesian3();
    const position: [number, number, number] = [0, 0, 0];
    const worldWidth = 2 * Math.PI * ellipsoid.maximumRadius;
    const centerX = centerLng * Math.PI / 180 * ellipsoid.maximumRadius;
    projectPosition = (x, y, z) => {
      world.x = x;
      world.y = y;
      world.z = z;
      if (!ellipsoid.cartesianToCartographic(world, cartographic))
        return undefined;
      mapProjection.project(cartographic, projected);
      if (mode === SceneMode.SCENE2D)
        projected.x += worldWidth * Math.round((centerX - projected.x) / worldWidth);
      // Native planar vertices use the projected z,x,y axis order.
      position[0] = projected.z;
      position[1] = projected.x;
      position[2] = projected.y;
      return position;
    };
  }
  return {
    viewProjection: symbolViewProjection(snapshot.viewMatrix, snapshot.projectionMatrix),
    projectPosition,
    isPointVisible,
    width: snapshot.drawingBufferWidth,
    height: snapshot.drawingBufferHeight,
    pixelRatio: snapshot.pixelRatio,
    cameraZoom,
    mercatorProjection: mapProjection instanceof WebMercatorProjection,
    cameraToCenterDistance: snapshot.cameraToCenterDistance,
    orthographic: snapshot.orthographic,
  };
}
