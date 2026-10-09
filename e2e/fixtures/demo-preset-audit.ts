import type { Cartesian2, Cartesian3, Matrix4 } from 'cesium';
import type { Page } from 'playwright/test';
import type { TestScene, TestTileset } from './browser-types';

export type PresetAuditStage = 'zoom-in' | 'orbit' | 'tilt' | 'return';

/** Retain camera state in a browser closure, released with the test's handle. */
export async function createDemoPresetAudit(page: Page) {
  await page.getByTestId('tileset-status').waitFor();
  const handle = await page.evaluateHandle(async () => {
    type SceneElement = Element & { __vueParentComponent: { props: { scene: TestScene } } };
    let scene: TestScene | undefined;
    let tileset: TestTileset | undefined;
    const deadline = performance.now() + 30_000;
    while (!tileset) {
      scene = document.querySelector<SceneElement>('[data-testid="camera-readout"]')?.__vueParentComponent.props.scene;
      if (scene) {
        tileset = Array.from({ length: scene.primitives.length }, (_, index) => scene!.primitives.get(index) as TestTileset)
          .find(primitive => typeof primitive.stats === 'function');
      }
      if (!tileset) {
        if (performance.now() >= deadline)
          throw new Error('Demo tileset was not attached within 30 seconds');
        await new Promise<void>(resolve => setTimeout(resolve, 50));
      }
    }
    const currentScene = scene!;
    const currentTileset = tileset;
    const camera = currentScene.camera;
    const Cartesian = camera.positionWC.constructor as typeof Cartesian3;
    const Matrix = camera.transform.constructor as typeof Matrix4;
    const original = {
      position: Cartesian.clone(camera.positionWC),
      direction: Cartesian.clone(camera.directionWC),
      up: Cartesian.clone(camera.upWC),
      heading: camera.heading,
      pitch: camera.pitch,
    };
    const target = camera.pickEllipsoid({
      x: currentScene.canvas.clientWidth / 2,
      y: currentScene.canvas.clientHeight / 2,
    } as Cartesian2, currentScene.mapProjection.ellipsoid);
    if (!target || ![target.x, target.y, target.z].every(Number.isFinite))
      throw new Error('Preset camera has no finite ellipsoid target at the canvas centre');
    const range = Cartesian.distance(original.position, target);
    const targetPosition = currentScene.mapProjection.ellipsoid.cartesianToCartographic(target);
    if (!targetPosition || !Number.isFinite(range) || range <= 0)
      throw new Error('Preset camera has an invalid centre target or camera range');

    let frames = 0;
    const renderErrors: string[] = [];
    const tileErrors: string[] = [];
    const removeFrame = currentScene.postRender.addEventListener(() => frames++);
    const removeRenderError = currentScene.renderError.addEventListener((_scene: TestScene, error: Error) => renderErrors.push(error.message));
    const removeTileError = currentTileset.errorEvent.addEventListener((error: Error) => tileErrors.push(error.message));
    const degrees = (radians: number) => radians * 180 / Math.PI;
    const vector = (value: Cartesian3) => ({ x: value.x, y: value.y, z: value.z });

    function snapshot() {
      const position = camera.positionCartographic;
      return {
        camera: {
          longitude: degrees(position.longitude),
          latitude: degrees(position.latitude),
          height: position.height,
          heading: degrees(camera.heading),
          pitch: degrees(camera.pitch),
          roll: degrees(camera.roll),
          position: vector(camera.positionWC),
          direction: vector(camera.directionWC),
          up: vector(camera.upWC),
        },
        target: { longitude: degrees(targetPosition.longitude), latitude: degrees(targetPosition.latitude), height: targetPosition.height, range },
        returned: {
          positionMeters: Cartesian.distance(camera.positionWC, original.position),
          direction: Cartesian.distance(camera.directionWC, original.direction),
          up: Cartesian.distance(camera.upWC, original.up),
        },
        frames,
        loaded: currentTileset.tilesLoaded,
        stats: currentTileset.stats(),
        alerts: [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent ?? ''),
        renderErrors: [...renderErrors],
        tileErrors: [...tileErrors],
      };
    }

    function waitLoaded(timeout: number): Promise<void> {
      if (currentTileset.tilesLoaded)
        return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const remove = currentScene.postRender.addEventListener(() => {
          if (currentTileset.tilesLoaded) {
            clearTimeout(timer);
            remove();
            resolve();
          }
        });
        timer = setTimeout(() => {
          remove();
          reject(new Error(`Demo tileset did not finish loading within ${timeout} ms`));
        }, timeout);
      });
    }

    function renderedMutation(mutate: () => void) {
      return new Promise<ReturnType<typeof snapshot>>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout>;
        const remove = currentScene.postRender.addEventListener(() => {
          clearTimeout(timer);
          remove();
          try {
            resolve(snapshot());
          }
          catch (error) {
            reject(error);
          }
        });
        timer = setTimeout(() => {
          remove();
          reject(new Error('Camera mutation did not produce a postRender frame within 3000 ms'));
        }, 3000);
        try {
          mutate();
        }
        catch (error) {
          clearTimeout(timer);
          remove();
          reject(error);
        }
      });
    }

    async function move(stage: PresetAuditStage) {
      const from = {
        position: Cartesian.clone(camera.positionWC),
        direction: Cartesian.clone(camera.directionWC),
        up: Cartesian.clone(camera.upWC),
      };
      const samples: Array<ReturnType<typeof snapshot>> = [];
      for (let step = 1; step <= 8; step++) {
        const ratio = step / 8;
        samples.push(await renderedMutation(() => {
          if (stage === 'return') {
            camera.setView({
              destination: Cartesian.lerp(from.position, original.position, ratio, new Cartesian()),
              orientation: {
                direction: Cartesian.lerp(from.direction, original.direction, ratio, new Cartesian()),
                up: Cartesian.lerp(from.up, original.up, ratio, new Cartesian()),
              },
            });
          }
          else {
            const heading = original.heading + (stage === 'zoom-in' ? 0 : stage === 'orbit' ? ratio * 0.45 : 0.45);
            const tiltedPitch = Math.min(-0.09, original.pitch + 0.25);
            const pitch = stage === 'tilt' ? original.pitch + ratio * (tiltedPitch - original.pitch) : original.pitch;
            camera.lookAt(target, { heading, pitch, range: range * (stage === 'zoom-in' ? 1 - ratio * 0.25 : 0.75) });
            camera.lookAtTransform(Matrix.IDENTITY);
          }
        }));
      }
      return samples;
    }

    return {
      snapshot,
      waitLoaded,
      move,
      dispose: () => {
        removeFrame();
        removeRenderError();
        removeTileError();
      },
    };
  });

  return {
    snapshot: () => handle.evaluate(audit => audit.snapshot()),
    waitLoaded: (timeout = 90_000) => handle.evaluate((audit, timeout) => audit.waitLoaded(timeout), timeout),
    move: (stage: PresetAuditStage) => handle.evaluate((audit, stage) => audit.move(stage), stage),
    dispose: async () => {
      try {
        await handle.evaluate(audit => audit.dispose());
      }
      finally {
        await handle.dispose();
      }
    },
  };
}
