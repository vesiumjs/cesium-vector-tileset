# cesium-vector-tileset [![npm version](https://img.shields.io/npm/v/cesium-vector-tileset.svg)](https://www.npmjs.com/package/cesium-vector-tileset)

English | [简体中文](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/README.zh-CN.md)

A vector map for Cesium. Display roads, water, labels, icons and buildings with a MapLibre-style JSON, alongside the other content in your scene.

Use it in 3D, 2D or Columbus View.

[Try the demo](https://vesiumjs.github.io/cesium-vector-tileset/) · [Example styles](https://github.com/vesiumjs/cesium-vector-tileset/tree/main/src/styles) · [GitHub](https://github.com/vesiumjs/cesium-vector-tileset)

## Gallery

Choose a scene, style and view independently. Each image opens one combination in the demo; changing the scene keeps your selected style.

| Scenes                                                                                                                                                                                                                                       | More scenes                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [![Barcelona · City overview](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/demo-barcelona-overview.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=barcelona&source=liberty&mode=3d)     | [![Manhattan · Skyline](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/demo-manhattan-buildings.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=manhattan&source=buildings&mode=3d) |
| [![London · River and bridges](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/demo-london-bridge.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=london&source=liberty&mode=3d)            | [![World · Globe](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/demo-world-overview.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=world&source=world&mode=3d)                    |
| [![Amsterdam · Canal district](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/demo-amsterdam-buildings.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=amsterdam&source=buildings&mode=3d) | [![Paris · Street network](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/demo-paris-streets.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=paris&source=bright&mode=3d)           |
| [![Shanghai · Riverside](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/demo-shanghai-river.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=shanghai&source=liberty&mode=3d)               | [![London · 2D map](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/demo-london-2d.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=london&source=positron&mode=2d)                   |

Data: [OpenFreeMap](https://openfreemap.org/), © [OpenStreetMap](https://www.openstreetmap.org/copyright), and [MapLibre demo tiles](https://demotiles.maplibre.org/).

## Install

```bash
pnpm add cesium@^1.146.0 cesium-vector-tileset
```

Configure Cesium's static assets as you normally would. For Vite, the demo's [configuration](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/vite.config.ts) uses `unplugin-cesium`. Give your map container a height, for example `<div id="map" style="height: 100vh"></div>`.

## Add a map

```ts
import { Viewer } from 'cesium';
import { CesiumVectorTileset } from 'cesium-vector-tileset';
import 'cesium/Build/Cesium/Widgets/widgets.css';

const viewer = new Viewer('map', { baseLayer: false });
const map = await CesiumVectorTileset.fromUrl(
  'https://tiles.openfreemap.org/styles/liberty',
);
viewer.scene.primitives.add(map);

map.errorEvent.addEventListener(error => console.error(error));
```

Already have a Cesium viewer? Add the map to its `scene.primitives`; the library leaves your camera under your control. `fromUrl()` initializes the style, then the visible tiles load as the camera moves. Catch its rejected promise for initialization errors.

Use any compatible version 8 style JSON. For your own data, pass an inline style to `new CesiumVectorTileset({ style })`; [these examples](https://github.com/vesiumjs/cesium-vector-tileset/tree/main/src/styles) show map definitions. A vector layer's `source-layer` must match the layer name in its tile data. Your server needs to allow browser requests for styles, tiles, sprites and fonts.

## Common operations

```ts
map.show = false; // Hide the map without removing it.
map.show = true;
map.setStyle(nextStyle); // Apply a new style JSON object.
const loading = !map.tilesLoaded;
const stats = map.stats(); // Tile, rendering and memory counters.

viewer.scene.primitives.remove(map); // Cesium normally destroys removed primitives.
```

If your primitive collection has `destroyPrimitives: false`, call `map.destroy()` after removal. For authenticated resources, provide `transformRequest` when creating the map. Other options and image methods are documented in the package's TypeScript declarations.

Use `cesium-vector-tileset/min` instead of the default import for the minified build. When copying distributed files, keep the main module and its Worker files together. Use the same Cesium installation for the library and your scene.

## Picking features

`allowPicking` defaults to `false`. Set it to `true` to enable all pickable layers, or configure individual style layer types; omitted types remain disabled. Set this option when creating the map.

```ts
const map = await CesiumVectorTileset.fromUrl(styleUrl, {
  allowPicking: { fill: true, line: true, symbol: true },
});
viewer.scene.primitives.add(map);

const hit = viewer.scene.pick(windowPosition);
const feature = hit?.id;
if (feature?.layerId) {
  console.log(feature.layerId, feature.featureId, feature.properties);
}
```

Use Cesium's `scene.pick` or `scene.drillPick`. Feature metadata is returned in `id` and includes `type`, `layerId`, `source` and `properties`, plus `featureId` and `sourceLayer` when available for vector features. Configurable types are `fill`, `line`, `circle`, `symbol`, `fill-extrusion` and `raster`; fill outlines and patterns follow their style layer's type.

## Supported features

The library implements a subset of MapLibre's version 8 style features.

### Data sources

| Source type                | Support         | Details                                                                       |
| -------------------------- | --------------- | ----------------------------------------------------------------------------- |
| `vector`                   | Supported       | MVT and MLT vector tiles.                                                     |
| `geojson`                  | Supported       | Inline GeoJSON or a GeoJSON URL.                                              |
| `raster`                   | Supported       | Raster image tiles.                                                           |
| `image`, `video`, `canvas` | Supported       | Georeferenced images, video and canvas content.                               |
| `raster-dem`               | **Unsupported** | Decode and load elevation data through Cesium's terrain providers; see below. |

### Rendering and styles

| Feature                                | Support     | Details                                                                                                                                                                         |
| -------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scene modes                            | Supported   | 3D globe, 2D and Columbus View.                                                                                                                                                 |
| Layer types                            | Supported   | `background`, `fill`, `line`, `circle`, `symbol`, `fill-extrusion` and `raster`.                                                                                                |
| Style expressions and filters          | Supported   | Includes data-driven styling, icons and image patterns.                                                                                                                         |
| Text                                   | Supported   | Includes bidirectional text; fonts must cover the displayed glyphs.                                                                                                             |
| Draping                                | Partial     | Ordinary fills can drape onto terrain or 3D Tiles through `heightReference` on compatible Cesium scenes. Other layers, including fill patterns, retain their ellipsoid heights. |
| Feature picking                        | Supported   | Enable through `allowPicking` and use Cesium's native `scene.pick` / `scene.drillPick`, including labels and icons.                                                             |
| `heatmap`, `hillshade`, `color-relief` | Unsupported | These layer types are not implemented.                                                                                                                                          |
| `line-gradient`                        | Unsupported | This line paint property is not implemented.                                                                                                                                    |

### DEM and terrain

**`raster-dem` is not supported.** Before passing a MapLibre style containing DEM data to this library, remove its `raster-dem` sources, layers that reference those sources, and `terrain` configuration. Configure terrain separately on the Cesium viewer.

For raw DEM tiles such as Terrain-RGB or Terrarium, your application must decode the elevation values and provide them through `CustomHeightmapTerrainProvider` or a custom `TerrainProvider`, assigned to `viewer.terrainProvider`. Data already converted to a Cesium terrain format can be loaded with `CesiumTerrainProvider`.

The Cesium peer range is `^1.146.0`; rendering integrations are verified with 1.146.0. Display the attribution required by your data provider.

## Development and support

```bash
pnpm install
pnpm dev
```

See [AGENTS.md](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/AGENTS.md) for contribution and validation conventions. Report reproducible problems through [GitHub issues](https://github.com/vesiumjs/cesium-vector-tileset/issues), with the style, view and Cesium version.

## License

[MIT](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/LICENSE). The project adapts MapLibre GL JS code and uses Cesium for rendering. Distributed builds include third-party notices; map data retains its provider's license.
