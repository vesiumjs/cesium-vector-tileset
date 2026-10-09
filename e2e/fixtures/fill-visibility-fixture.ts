import type { NativeCommand, NativeVertexArray, TestTileset, TestViewer } from './browser-types';
import { BoundingSphere, BufferPolygonCollection, Cartesian2, Cartesian3, Cartographic, Math as CesiumMath } from 'cesium';
import { tileBoundingSphere } from '../../packages/cesium-vector-tileset/src/render/geometry/tile-bounding-sphere';
import { drawBatchForOwner } from '../../packages/cesium-vector-tileset/src/render/scene/draw-batch';

type FillOwner = BufferPolygonCollection & {
  _renderContext?: {
    vertexArray: NativeVertexArray;
    command: NativeCommand;
    attributeArrays: { positionHigh: Float32Array; positionLow: Float32Array };
  };
};

/** Exercise the real source cache, buffer renderer and Native command execution. */
export function installFillVisibility(viewer: TestViewer, tileset: TestTileset) {
  const scene = viewer.scene;
  const originalDraw = scene.context.draw;
  const originalView = {
    destination: Cartesian3.clone(viewer.camera.positionWC),
    orientation: { direction: Cartesian3.clone(viewer.camera.directionWC), up: Cartesian3.clone(viewer.camera.upWC) },
  };
  const originalHeight = viewer.camera.positionCartographic.height;
  const orientation = { heading: viewer.camera.heading, pitch: viewer.camera.pitch, roll: viewer.camera.roll };
  const width = viewer.canvas.clientWidth;
  const height = viewer.canvas.clientHeight;
  const coordinates = [[width + 80, height / 2 - 48], [width + 176, height / 2 - 48], [width + 128, height / 2 + 48]].map(([x, y]) => {
    const world = viewer.camera.pickEllipsoid(new Cartesian2(x, y), scene.mapProjection.ellipsoid);
    if (!world)
      throw new Error('fill visibility ray missed the ellipsoid');
    const point = Cartographic.fromCartesian(world);
    return [CesiumMath.toDegrees(point.longitude), CesiumMath.toDegrees(point.latitude)];
  });
  const center = coordinates.reduce(([x, y], point) => [x + point[0] / 3, y + point[1] / 3], [0, 0]);
  const resources = new Map<FillOwner, { vertexArray: NativeVertexArray; high: Float32Array; low: Float32Array; bounds: BoundingSphere }>();
  let draws = 0;
  const owners = () => {
    const result: Array<{ owner: FillOwner; tileBounds: BoundingSphere }> = [];
    for (const record of tileset._vectorRenderer._records.values()) {
      for (const collection of record.collections.values()) {
        if (collection instanceof BufferPolygonCollection && drawBatchForOwner(collection)?.layerId === 'visibility-fill')
          result.push({ owner: collection as FillOwner, tileBounds: tileBoundingSphere(record.tileID) });
      }
    }
    return result;
  };
  scene.context.draw = function (command, ...args) {
    if (drawBatchForOwner(command.owner)?.layerId === 'visibility-fill')
      draws++;
    return originalDraw.call(this, command, ...args);
  };
  return {
    create() {
      tileset.setStyle({
        version: 8,
        transition: { duration: 0, delay: 0 },
        sources: {
          fill: {
            type: 'geojson',
            maxzoom: 10,
            tolerance: 0,
            data: { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...coordinates, coordinates[0]]] } },
          },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#224455' } },
          { id: 'visibility-fill', type: 'fill', source: 'fill', paint: { 'fill-color': '#00ff00', 'fill-opacity': 1, 'fill-antialias': false } },
        ],
      });
    },
    move(inside: boolean) {
      viewer.camera.setView(inside
        ? { destination: Cartesian3.fromDegrees(center[0], center[1], originalHeight), orientation }
        : originalView);
      scene.requestRender();
    },
    sample(reference = false) {
      const active = owners();
      const saved = active.map(({ owner }) => BoundingSphere.clone(owner.boundingVolume));
      if (reference) {
        for (const { owner, tileBounds } of active)
          BoundingSphere.clone(tileBounds, owner.boundingVolume);
      }
      draws = 0;
      return new Promise<{
        draws: number;
        owners: number;
        green: number;
        picked?: string;
        stable: boolean;
        enclosed: boolean;
        pixels: number[];
      }>((resolve, reject) => {
        const stop = scene.postRender.addEventListener(() => {
          stop();
          try {
            const renderDraws = draws;
            const pixels = scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
            let green = 0;
            let pickPosition: Cartesian2 | undefined;
            for (let offset = 0; offset < pixels.length; offset += 4) {
              if (pixels[offset] < 3 && pixels[offset + 1] > 252 && pixels[offset + 2] < 3) {
                green++;
                if (!pickPosition) {
                  const pixel = offset / 4;
                  pickPosition = new Cartesian2((pixel % viewer.canvas.width + 0.5) * width / viewer.canvas.width, (viewer.canvas.height - Math.floor(pixel / viewer.canvas.width) - 0.5) * height / viewer.canvas.height);
                }
              }
            }
            const picked = pickPosition && scene.pick(pickPosition, 1, 1) as { layerId?: string } | undefined;
            let stable = true;
            let enclosed = true;
            for (const [index, { owner }] of active.entries()) {
              const render = owner._renderContext;
              if (!render)
                throw new Error('fill owner has not uploaded its real Native vertex array');
              const { positionHigh: high, positionLow: low } = render.attributeArrays;
              const previous = resources.get(owner);
              if (!previous)
                resources.set(owner, { vertexArray: render.vertexArray, high, low, bounds: owner.boundingVolume });
              else
                stable &&= previous.vertexArray === render.vertexArray && previous.high === high && previous.low === low && previous.bounds === owner.boundingVolume && !render.vertexArray.isDestroyed();
              const bounds = saved[index];
              const point = new Cartesian3();
              for (let vertex = 0; vertex < owner.vertexCount; vertex++) {
                point.x = high[vertex * 3] + low[vertex * 3];
                point.y = high[vertex * 3 + 1] + low[vertex * 3 + 1];
                point.z = high[vertex * 3 + 2] + low[vertex * 3 + 2];
                enclosed &&= Cartesian3.distance(point, bounds.center) <= bounds.radius;
              }
            }
            stable &&= resources.size === active.length && active.every(({ owner }) => resources.has(owner));
            resolve({ draws: renderDraws, owners: active.length, green, picked: picked?.layerId, stable, enclosed, pixels: Array.from(pixels) });
          }
          catch (error) { reject(error); }
          finally {
            for (const [index, { owner }] of active.entries())
              BoundingSphere.clone(saved[index], owner.boundingVolume);
          }
        });
        scene.requestRender();
      });
    },
    dispose() {
      scene.context.draw = originalDraw;
      resources.clear();
    },
  };
}

declare global {
  interface Window { fillVisibility: ReturnType<typeof installFillVisibility> }
}
