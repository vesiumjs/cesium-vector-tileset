import { Cartesian3 } from 'cesium';
import { cameraFrame } from './camera-helper';

/** Recorded orbit 18 of the real-city 1280 x 720 motion fixture. */
export function cityOrbitFrame() {
  const frame = cameraFrame({ width: 1280, heightPixels: 720, fovY: 35.98339777135764 * Math.PI / 180 });
  Object.assign(frame.context, { mode: frame.mode });
  frame.camera.setView({
    destination: new Cartesian3(3979691.109098712, -8862.94643978272, 4970972.918904937),
    orientation: {
      direction: new Cartesian3(0.3666185234776036, -0.000816475512379568, -0.930370996759271),
      up: new Cartesian3(0.9303686895761167, -0.0020719718286958157, 0.36661943263984303),
    },
  });
  return frame;
}
