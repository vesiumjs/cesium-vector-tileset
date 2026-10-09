# cesium-vector-tileset

English | [简体中文](./README.zh-CN.md)

Add a styled vector map to your Cesium scene: roads, land and water, points, labels, and extruded buildings. Use MapLibre-style JSON to control the map's appearance alongside your existing Cesium content.

The library supports 3D, 2D, and Columbus View, works with any frontend framework, and includes TypeScript declarations. It adapts MapLibre GL JS's style and tile processing to Cesium's rendering APIs.

[Live demo](https://vesiumjs.github.io/cesium-vector-tileset/) — choose a view preset, map style, and scene mode; add or remove the tileset, and follow your current camera position and heading, pitch, and roll.

## Gallery

Click a screenshot to explore the map in the live demo.

| Shanghai · Lujiazui skyline                                                                                                                                                                                                            | Hong Kong · Central waterfront                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [![Shanghai · Lujiazui skyline](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/shanghai-buildings.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=shanghai&source=buildings&mode=3d) | [![Hong Kong · Central waterfront](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/hong-kong-buildings.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=hong-kong&source=buildings&mode=3d) |
| **London · 2D roads and labels**                                                                                                                                                                                                       | **Barcelona · Dense street grid**                                                                                                                                                                                                           |
| [![London · 2D roads and labels](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/london-2d.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=london&source=liberty&mode=2d)             | [![Barcelona · Dense street grid](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/barcelona-3d.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=barcelona&source=liberty&mode=3d)           |
| **Chicago · Buildings and labels**                                                                                                                                                                                                     | **Chongqing · Rivers and bridges**                                                                                                                                                                                                          |
| [![Chicago · Buildings and labels](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/chicago-3d.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=chicago&source=liberty&mode=3d)         | [![Chongqing · Rivers and bridges](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/chongqing-3d.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=chongqing&source=liberty&mode=3d)          |

Map data: [OpenFreeMap](https://openfreemap.org/) / [OpenMapTiles](https://www.openmaptiles.org/) / © [OpenStreetMap](https://www.openstreetmap.org/copyright).

## Quick start

Install the library and Cesium:

```bash
pnpm add cesium@^1.146.0 cesium-vector-tileset
```

The default entry is unminified. Import from `cesium-vector-tileset/min` to use the minified version; CDN files use the `.min.mjs` suffix, including their Workers.

The example assumes you already have a Cesium `Scene` and a render loop. Serve a version 8 style JSON at `/styles/map.json`, or replace the URL with your map provider's style URL:

```ts
import type { Scene } from 'cesium';
import { CesiumVectorTileset } from 'cesium-vector-tileset';

export async function addVectorMap(scene: Scene) {
  const tileset = await CesiumVectorTileset.fromUrl('/styles/map.json');
  tileset.errorEvent.addEventListener((error) => {
    console.error('Vector map error:', error);
  });
  return scene.primitives.add(tileset);
}
```

Move the camera to an area covered by your source. Vector tile layers need a `source-layer` that matches the tile data. You can also pass an inline style, including GeoJSON, to `new CesiumVectorTileset({ style })` and await `whenReady()` before adding it to the scene. See the demo's [example styles](https://github.com/vesiumjs/cesium-vector-tileset/tree/main/src/styles) for map definitions.

Deploy Cesium's static assets with your application, using the same Cesium installation as your scene. Keep the library's distributed modules together, including `worker.mjs` and `geometry-worker.mjs`; browser rendering requires WebGL and module Workers. The demo's [Vite configuration](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/vite.config.ts) shows asset setup with `unplugin-cesium`.

## Working with the map

`fromUrl()` and `whenReady()` wait for style initialization. Viewport tiles load after the map joins the scene; `tilesLoaded` reports whether current loading and rendering preparation have settled, and can change as the camera moves. Catch initialization failures and listen to `errorEvent` for later errors.

Change `show` to toggle visibility and call `setStyle(nextStyle)` to change the map's style. The library requests frames for its asynchronous work in Cesium's demand rendering mode. Your application continues to own the scene and camera.

For authenticated or customized resource requests, pass `transformRequest` when creating the tileset. `gpuMemoryBudgetBytes` controls the estimated resident tile GPU cache budget (256 MiB by default); active tiles remain resident, so it is not a hard limit on total GPU memory. `stats()` helps inspect loading and resource use. Options and method signatures are included in the package's TypeScript declarations.

Remove and dispose of the map when it is no longer needed. Cesium collections normally destroy removed primitives; this also handles collections configured to retain them:

```ts
scene.primitives.remove(tileset);
if (!tileset.isDestroyed()) {
  tileset.destroy();
}
```

## Styles and compatibility

- Sources: MVT, MLT, GeoJSON, raster tiles, images, video, and canvas. Layers: `background`, `fill`, `line`, `circle`, `fill-extrusion`, `symbol`, and `raster`.
- MapLibre expressions and filters, data-driven styling, dashed lines, image patterns, text, and icons are supported. This is a subset of MapLibre's rendering capabilities; `heatmap`, `hillshade`, and `raster-dem` are unavailable, and `line-gradient` is rejected.
- `heightReference` can drape ordinary fill polygons when the scene provides Cesium's vector provider. Lines, points, labels, extrusions, and image patterns keep ellipsoid heights. Label and icon picking is currently unavailable.
- Style URL loading resolves relative source URLs, tile templates, sprites, and glyphs against the style URL. Use absolute URLs for remote GeoJSON `data` and video `urls`.
- The Cesium peer range is `^1.146.0`; the recorded rendering baseline uses 1.146.0. Some rendering integrations use Cesium internals, so the declared range does not mean every later release has been tested. See the [validation record](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/docs/research/performance-baseline.md).

## Documentation and support

See the [architecture](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/docs/architecture.md) and [module responsibilities](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/docs/module-responsibilities.md) for implementation details. Report problems through [GitHub issues](https://github.com/vesiumjs/cesium-vector-tileset/issues), including a reproducible style, the affected view, and your Cesium version.

## License and credits

Licensed under the [MIT License](./LICENSE). The implementation adapts MapLibre GL JS code and designs and uses Cesium for rendering. Distributed builds include third-party notices; dependencies and map data retain their own licenses. Display the attribution required by your map provider.
