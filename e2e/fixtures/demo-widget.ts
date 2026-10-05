import type { TestScene, TestTileset } from './browser-types';
import { Cartesian3, CesiumWidget, Primitive, Rectangle, SceneMode } from 'cesium';
import { CesiumVectorTileset } from '../../packages/cesium-vector-tileset/index';
import { sceneOptions, widgetOptions } from '../../src/demo-config';
import 'cesium/Build/Cesium/Widgets/shared.css';
import 'cesium/Build/Cesium/Widgets/CesiumWidget/CesiumWidget.css';

async function createSceneValidation() {
  const errors: string[] = [];
  const parameters = new URLSearchParams(location.search);
  const widget = new CesiumWidget(document.getElementById('map'), { ...widgetOptions, showRenderLoopErrors: false });
  widget.resolutionScale = Number(parameters.get('resolutionRatio') ?? 1);
  widget.resize();
  const scene = widget.scene as unknown as TestScene;
  Object.assign(scene, sceneOptions);
  scene.renderError.addEventListener((_scene, cause) => errors.push(String(cause)));
  scene.camera.setView({ destination: Rectangle.fromDegrees(-0.16, 51.49, -0.1, 51.52) });
  const tileset = await CesiumVectorTileset.fromUrl('/widget-fixture/style.json') as unknown as TestTileset;
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
    widget,
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

createSceneValidation().then(validation => window.widgetValidation = validation);
declare global {
  interface Window { widgetValidation: Awaited<ReturnType<typeof createSceneValidation>> }
}
