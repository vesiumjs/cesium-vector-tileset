import type { NativeCommand, NativeVertexArray, TestTileset, TestViewer } from './browser-types';
import { BoundingSphere, BufferPoint, BufferPointCollection, BufferPointMaterial, Cartesian2, Cartesian3, Math as CesiumMath, SceneTransforms } from 'cesium';
import { latFromMercatorY, lngFromMercatorX, mercatorXfromLng, mercatorYfromLat } from '../../packages/cesium-vector-tileset/src/geo/mercator-coordinate';
import { drawBatchForOwner } from '../../packages/cesium-vector-tileset/src/render/scene/draw-batch';
import { OverscaledTileID } from '../../packages/cesium-vector-tileset/src/tile/tile-id';

type CircleOwner = BufferPointCollection & {
  _renderContext?: { vertexArray: NativeVertexArray; command: NativeCommand & { cull: boolean } };
  _pickIds: Map<object, Array<{ object: unknown }>>;
};

/** Hold a real source owner while independently exercising Native command culling. */
export function installCircleVisibility(viewer: TestViewer, tileset: TestTileset) {
  const scene = viewer.scene;
  const originalCovering = tileset._sceneCovering.covering;
  const originalDraw = scene.context.draw;
  const originalNear = viewer.camera.frustum.near;
  const originalView = {
    destination: Cartesian3.clone(viewer.camera.positionWC),
    orientation: { direction: Cartesian3.clone(viewer.camera.directionWC), up: Cartesian3.clone(viewer.camera.upWC) },
  };
  const z = 22;
  const worldSize = 2 ** z;
  const center = viewer.camera.positionCartographic;
  const x = Math.floor(mercatorXfromLng(CesiumMath.toDegrees(center.longitude)) * worldSize);
  const y = Math.floor(mercatorYfromLat(CesiumMath.toDegrees(center.latitude)) * worldSize);
  const tile = new OverscaledTileID(z, 0, z, x, y);
  const longitude = lngFromMercatorX((x + 0.5) / worldSize);
  const latitude = latFromMercatorY((y + 0.5) / worldSize);
  let owner: CircleOwner | undefined;
  let vertexArray: NativeVertexArray | undefined;
  let pickIds: Array<{ object: unknown }> | undefined;
  let bounds: BoundingSphere | undefined;
  let draws = 0;
  let driven = false;
  let loadsAfterUpload = 0;
  let restoreSourceLoad: (() => void) | undefined;
  let insideView: typeof originalView | undefined;

  const activeOwners = () => [...tileset._vectorRenderer._records.values()]
    .flatMap(record => [...record.collections.values()])
    .filter((collection): collection is CircleOwner => collection instanceof BufferPointCollection
      && drawBatchForOwner(collection)?.layerId === 'visibility-circle');
  scene.context.draw = function (command, ...args) {
    if (drawBatchForOwner(command.owner)?.layerId === 'visibility-circle')
      draws++;
    return originalDraw.call(this, command, ...args);
  };

  return {
    create(dataDriven: boolean) {
      driven = dataDriven;
      // Only source selection is fixed. Worker decoding, builder publication,
      // live paint, Native uploads and culling still use their production paths.
      tileset._sceneCovering.covering = function (...args) {
        const covering = originalCovering.apply(this, args);
        return covering && { ...covering, idealTileIDs: [tile] };
      };
      viewer.camera.setView({ destination: Cartesian3.fromDegrees(longitude, latitude, 1000), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
      insideView = {
        destination: Cartesian3.clone(viewer.camera.positionWC),
        orientation: { direction: Cartesian3.clone(viewer.camera.directionWC), up: Cartesian3.clone(viewer.camera.upWC) },
      };
      scene.highDynamicRange = false;
      scene.gamma = 1;
      scene.postProcessStages.fxaa.enabled = false;
      scene.postProcessStages.bloom.enabled = false;
      scene.postProcessStages.ambientOcclusion.enabled = false;
      tileset.setStyle({
        version: 8,
        transition: { duration: 0, delay: 0 },
        sources: {
          circles: {
            type: 'geojson',
            maxzoom: z,
            tolerance: 0,
            data: { type: 'Feature', id: 73, properties: { radius: 8 }, geometry: { type: 'Point', coordinates: [longitude, latitude] } },
          },
        },
        layers: [
          { id: 'background', type: 'background', paint: { 'background-color': '#224455' } },
          { id: 'visibility-circle', type: 'circle', source: 'circles', paint: {
            'circle-radius': dataDriven ? ['number', ['feature-state', 'radius'], ['get', 'radius']] : 8,
            'circle-color': '#00ff00',
            'circle-stroke-color': '#00ff00',
            'circle-stroke-width': 0,
          } },
        ],
      });
    },
    ready() {
      const current = activeOwners();
      if (!tileset.tilesLoaded || current.length !== 1 || !current[0]._renderContext?.vertexArray)
        return false;
      owner = current[0];
      vertexArray ??= owner._renderContext!.vertexArray;
      pickIds ??= owner._pickIds.get(scene.context);
      bounds ??= BoundingSphere.clone(owner.boundingVolume);
      if (!restoreSourceLoad) {
        const source = tileset._style.getSource('circles')!;
        const originalLoad = source.loadTile;
        source.loadTile = function (tile) {
          loadsAfterUpload++;
          return originalLoad.call(this, tile);
        };
        restoreSourceLoad = () => {
          source.loadTile = originalLoad;
        };
      }
      return !!pickIds?.length;
    },
    move(inside: boolean) {
      if (!insideView || !owner)
        throw new Error('circle owner has not completed Native upload');
      viewer.camera.frustum.near = originalNear;
      viewer.camera.setView(insideView);
      if (!inside) {
        const metersPerPixel = viewer.camera.getPixelSize(owner.boundingVolume, viewer.canvas.width, viewer.canvas.height)
          * viewer.canvas.width / viewer.canvas.clientWidth;
        viewer.camera.moveRight((viewer.canvas.clientWidth / 2 + 32) * metersPerPixel);
      }
      scene.requestRender();
    },
    clipNear() {
      if (!owner)
        throw new Error('circle owner has not completed Native upload');
      const point = new BufferPoint();
      owner.get(0, point);
      const distance = Cartesian3.distance(viewer.camera.positionWC, point.getPosition());
      viewer.camera.frustum.near = distance + owner.boundingVolume.radius + 1;
      scene.requestRender();
    },
    paint(radius: number, stroke = 0) {
      if (driven)
        tileset._style.setFeatureState({ source: 'circles', id: 73 }, { radius });
      const style = structuredClone(tileset.styleSpec);
      const layer = style.layers.find(layer => layer.id === 'visibility-circle');
      if (layer?.type !== 'circle')
        throw new Error('circle layer is missing');
      layer.paint = { ...layer.paint, 'circle-stroke-width': stroke };
      if (!driven)
        layer.paint['circle-radius'] = radius;
      tileset.setStyle(style);
      scene.requestRender();
    },
    material() {
      if (!owner)
        return undefined;
      const material = owner.get(0, new BufferPoint()).getMaterial(new BufferPointMaterial()) as BufferPointMaterial;
      return { size: material.size, stroke: material.outlineWidth };
    },
    sample(reference = false) {
      if (!owner?._renderContext || !bounds)
        throw new Error('circle owner has not completed Native upload');
      const sampledOwner = owner;
      const command = owner._renderContext.command;
      const savedCull = command.cull;
      if (reference)
        command.cull = false;
      draws = 0;
      return new Promise<{
        reference: boolean;
        sourceSelection: string;
        tile: string;
        draws: number;
        green: number;
        edgeGreen: number;
        picked?: string;
        stable: boolean;
        boundsUnchanged: boolean;
        shown: boolean;
        ownerCount: number;
        loadsAfterUpload: number;
        centerEnclosed: boolean;
        nearPlane: number;
        visibility: number | undefined;
        center: { x: number; y: number } | undefined;
        material: { size: number; stroke: number };
        maxPointSize: number;
        pixels: number[];
      }>((resolve, reject) => {
        const stop = scene.postRender.addEventListener(() => {
          stop();
          try {
            const renderDraws = draws;
            const pixels = scene.context.readPixels({ width: viewer.canvas.width, height: viewer.canvas.height });
            let green = 0;
            let edgeGreen = 0;
            let pickPosition: Cartesian2 | undefined;
            for (let offset = 0; offset < pixels.length; offset += 4) {
              if (pixels[offset] < 30 && pixels[offset + 1] > 180 && pixels[offset + 2] < 30) {
                green++;
                const pixel = offset / 4;
                const px = (pixel % viewer.canvas.width + 0.5) * viewer.canvas.clientWidth / viewer.canvas.width;
                if (px < 32)
                  edgeGreen++;
                pickPosition ??= new Cartesian2(px, (viewer.canvas.height - Math.floor(pixel / viewer.canvas.width) - 0.5) * viewer.canvas.clientHeight / viewer.canvas.height);
              }
            }
            const point = new BufferPoint();
            sampledOwner.get(0, point);
            const actualPosition = point.getPosition();
            const center = SceneTransforms.worldToWindowCoordinates(scene, actualPosition);
            const visibility = scene._frameState.cullingVolume?.computeVisibility(sampledOwner.boundingVolume);
            const material = sampledOwner.get(0, new BufferPoint()).getMaterial(new BufferPointMaterial()) as BufferPointMaterial;
            // Keep the in-view picking control at the actual center; the
            // offscreen reference deliberately picks its visible outer edge.
            if (center && center.x >= 0 && center.x < viewer.canvas.clientWidth && center.y >= 0 && center.y < viewer.canvas.clientHeight)
              pickPosition = center;
            const picked = pickPosition && scene.pick(pickPosition, 1, 1);
            const hit = picked && tileset.pick((picked as { id?: object }).id ?? picked);
            const gl = scene.context._gl;
            const pointSizes = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array;
            resolve({
              reference,
              sourceSelection: 'fixture-pinned-z22-source-cover; production Worker/builder/paint/Native owner',
              tile: `${z}/${x}/${y}`,
              draws: renderDraws,
              green,
              edgeGreen,
              picked: hit?.layerId,
              stable: activeOwners().length === 1 && activeOwners()[0] === sampledOwner
                && sampledOwner._renderContext?.vertexArray === vertexArray && !vertexArray!.isDestroyed()
                && sampledOwner._pickIds.get(scene.context) === pickIds,
              boundsUnchanged: BoundingSphere.equals(sampledOwner.boundingVolume, bounds),
              shown: sampledOwner.show,
              ownerCount: activeOwners().length,
              loadsAfterUpload,
              centerEnclosed: Cartesian3.distance(actualPosition, bounds!.center) <= bounds!.radius,
              nearPlane: viewer.camera.frustum.near,
              visibility,
              center: center && { x: center.x, y: center.y },
              material: { size: material.size, stroke: material.outlineWidth },
              maxPointSize: pointSizes[1],
              pixels: Array.from(pixels),
            });
          }
          catch (error) { reject(error); }
          finally { command.cull = savedCull; }
        });
        scene.requestRender();
      });
    },
    dispose() {
      restoreSourceLoad?.();
      tileset._sceneCovering.covering = originalCovering;
      scene.context.draw = originalDraw;
      viewer.camera.frustum.near = originalNear;
      viewer.camera.setView(originalView);
      scene.requestRender();
    },
  };
}

declare global {
  interface Window { circleVisibility: ReturnType<typeof installCircleVisibility> }
}
