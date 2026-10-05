import type { TestScene, TestTileset } from './browser-types';
import { Cartesian3, Primitive, Rectangle, SceneMode } from 'cesium';
import { CesiumVectorTileset } from '../../packages/cesium-vector-tileset/index';
import { SceneView } from '../../src/scene-view';
import 'cesium/Build/Cesium/Widgets/shared.css';
import 'cesium/Build/Cesium/Widgets/CesiumWidget/CesiumWidget.css';

async function createSceneValidation() {
  const errors: string[] = [];
  const parameters = new URLSearchParams(location.search);
  const sceneView = new SceneView(document.getElementById('map'), {
    resolutionRatio: Number(parameters.get('resolutionRatio') ?? 1),
    onError: cause => errors.push(String(cause)),
  });
  const scene = sceneView.scene as unknown as TestScene;
  scene.camera.setView({ destination: Rectangle.fromDegrees(-0.16, 51.49, -0.1, 51.52) });
  const tileset = await CesiumVectorTileset.fromUrl('/scene-view-fixture/style.json', {
    requestRender: () => scene.requestRender(),
  }) as unknown as TestTileset;
  scene.primitives.add(tileset);
  let renderCalls = 0;
  let renderedFrames = 0;
  let pixels: Uint8Array;
  const render = scene.render;
  scene.render = function (...args) {
    renderCalls++;
    return render.apply(this, args);
  };
  scene.postRender.addEventListener(() => {
    renderedFrames++;
    pixels = scene.context.readPixels({ width: scene.canvas.width, height: scene.canvas.height });
  });
  const validation = {
    sceneView: sceneView as unknown as Omit<SceneView, 'scene'> & { scene: TestScene },
    scene,
    tileset,
    errors,
    Cartesian3,
    Primitive,
    SceneMode,
    counts: () => ({ renderCalls, renderedFrames }),
    coverage() {
      if (!pixels)
        return 0;
      let matching = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if ([51, 102, 170].every((channel, axis) => Math.abs(pixels[index + axis] - channel) < 5))
          matching++;
      }
      return matching / (pixels.length / 4);
    },
  };

  return validation;
}

createSceneValidation().then(validation => window.sceneViewValidation = validation);
declare global {
  interface Window { sceneViewValidation: Awaited<ReturnType<typeof createSceneValidation>> }
}
