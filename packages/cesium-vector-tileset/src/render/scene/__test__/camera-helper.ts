import type { MapProjection, PerspectiveFrustum, Scene } from 'cesium';
import { Camera, Cartesian3, GeographicProjection, MapMode2D, OrthographicOffCenterFrustum, SceneMode } from 'cesium';

interface CameraOptions {
  mode?: SceneMode;
  projection?: MapProjection;
  longitude?: number;
  latitude?: number;
  height?: number;
  heading?: number;
  pitch?: number;
  roll?: number;
  pixelRatio?: number;
  width?: number;
  heightPixels?: number;
  fovY?: number;
}

/** A real Cesium camera without a WebGL Scene; height sets world width in 2D. */
export function cameraFrame(options: CameraOptions = {}) {
  const mode = options.mode ?? SceneMode.SCENE3D;
  const width = options.width ?? 1280;
  const height = options.heightPixels ?? 800;
  const pixelRatio = options.pixelRatio ?? 1;
  const canvas = document.createElement('canvas');
  Object.defineProperties(canvas, {
    clientWidth: { value: width },
    clientHeight: { value: height },
  });
  const scene = {
    canvas,
    mapProjection: options.projection ?? new GeographicProjection(),
    drawingBufferWidth: width * pixelRatio,
    drawingBufferHeight: height * pixelRatio,
    pixelRatio,
    mapMode2D: MapMode2D.ROTATE,
  };
  const camera = new Camera(scene as Scene);
  if (mode === SceneMode.SCENE2D) {
    camera.direction = new Cartesian3(0, 0, -1);
    camera.up = new Cartesian3(0, 1, 0);
    camera.right = new Cartesian3(1, 0, 0);
    camera.frustum = new OrthographicOffCenterFrustum({ left: -1, right: 1, top: height / width, bottom: -height / width });
  }
  else if (options.fovY !== undefined) {
    (camera.frustum as PerspectiveFrustum).fov = width > height
      ? 2 * Math.atan(Math.tan(options.fovY / 2) * width / height)
      : options.fovY;
  }
  camera.update(mode);
  camera.setView({
    destination: Cartesian3.fromDegrees(options.longitude ?? 0, options.latitude ?? 0, options.height ?? 10_000),
    orientation: { heading: options.heading ?? 0, pitch: options.pitch ?? -Math.PI / 2, roll: options.roll ?? 0 },
  });
  return { mode, camera, mapProjection: scene.mapProjection, pixelRatio, context: scene };
}
