# cesium-vector-tileset

English | [简体中文](./README.zh-CN.md)

Render vector tiles in Cesium using MapLibre-style JSON. The library reuses MapLibre GL JS code and designs for style expressions, tile processing, and label layout, then renders through Cesium's `Buffer*Collection` and `Primitive` APIs.

The repository contains the TypeScript library in `packages/cesium-vector-tileset` and a Vue + Vite demo in `src`. The demo includes map styles, city views, and scenarios for buildings, dense labels, and the antimeridian.

## Capabilities

| Area               | Current implementation                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| Vector data        | Mapbox Vector Tiles (MVT), MapLibre Tiles (MLT), and GeoJSON                                                |
| Other sources      | Raster tiles, images, video, and canvas                                                                     |
| Style layers       | `background`, `fill`, `line`, `circle`, `fill-extrusion`, `symbol`, and `raster`                            |
| Styling            | MapLibre style expressions and filters, data-driven paint, dashed lines, and image patterns                 |
| Labels             | Text and icons, glyph/sprite loading, collision placement, and local CJK glyph generation                   |
| Cesium integration | 3D, 2D, Columbus View, scene mode transitions, and feature picking for supported primitives                 |
| Tile lifecycle     | Worker processing, camera-based tile selection, parent/child fallback, caching, and GPU resource retirement |

This is a Cesium rendering backend with a subset of MapLibre's capabilities. See [compatibility and limits](#compatibility-and-limits) before choosing a style.

## Run the demo

Use Node.js **22.13 or newer** and pnpm. From the repository root:

```bash
pnpm install
pnpm dev
```

Open the local URL printed by Vite. The demo starts with the OpenFreeMap Liberty style and a Shanghai view. Use the controls to change the style, camera, or scene mode, or enter your own style JSON URL.

Views can be shared through URL parameters:

```text
/?source=liberty&view=shanghai&mode=3d&angle=oblique
/?scenario=manhattan&height=60
/?source=bright&view=world&mode=2d
```

`source` selects a preset; `style` supplies a custom style URL; `mode` accepts `3d`, `2d`, or `cv`; `angle` accepts `top`, `oblique`, or `horizon`. The available styles, cities, and scenarios are defined in [src/demo-config.ts](./src/demo-config.ts), together with `widgetOptions`, `sceneOptions`, and `tilesetOptions`. Vue switches these configurations; CesiumWidget owns the render loop and resizing.

The presets fetch data from external services. A custom style must reference accessible sources, sprites, and glyphs, with CORS configured for your application's origin. Keep the data provider's required attribution visible and check its usage terms before using a preset beyond the demo.

## Use with Cesium

The demo imports `cesium-vector-tileset` through the pnpm workspace. The following examples use the same public entry point and assume your application already owns a Cesium `Scene` and a render loop.

### Load a style URL

Serve your version 8 style JSON at `/styles/map.json`, or replace the URL with your provider's style URL:

```ts
import type { Scene } from 'cesium';
import { CesiumVectorTileset } from 'cesium-vector-tileset';

export async function addVectorMap(scene: Scene) {
  const tileset = await CesiumVectorTileset.fromUrl('/styles/map.json');

  tileset.errorEvent.addEventListener((error) => {
    console.error('Vector map error:', error);
  });

  try {
    await tileset.whenReady();
    scene.primitives.add(tileset);
    scene.requestRender();
    return tileset;
  }
  catch (error) {
    tileset.destroy();
    throw error;
  }
}
```

`fromUrl()` fetches the style and creates the tileset. `whenReady()` waits for style initialization; it does not wait for viewport tiles to render. Once the tileset is in the scene, `tilesLoaded` reports whether current source data, geometry uploads, and pending symbol work have finished. The value can change as the camera moves.

Cesium supplies the camera, projection, and rendering context through the primitive's `update(frameState)` callback. The tileset requests further frames through `frameState.afterRender`, including asynchronous loading under `requestRenderMode`; no scene or render callback option is needed.

### Use an inline style

An inline GeoJSON source is useful for trying the API without a tile server:

```ts
import type { Scene } from 'cesium';
import { CesiumVectorTileset } from 'cesium-vector-tileset';

export async function addPoint(scene: Scene) {
  const tileset = new CesiumVectorTileset({
    style: {
      version: 8,
      sources: {
        places: {
          type: 'geojson',
          data: {
            type: 'Feature',
            properties: { name: 'Shanghai' },
            geometry: { type: 'Point', coordinates: [121.454, 31.258] },
          },
        },
      },
      layers: [{
        id: 'places',
        type: 'circle',
        source: 'places',
        paint: { 'circle-radius': 8, 'circle-color': '#38bdf8' },
      }],
    },
  });

  try {
    await tileset.whenReady();
    scene.primitives.add(tileset);
    scene.requestRender();
    return tileset;
  }
  catch (error) {
    tileset.destroy();
    throw error;
  }
}
```

Move your camera to Shanghai to see the point. For vector tile sources, each layer also needs a `source-layer` matching a layer name inside the tile data.

### Options and lifecycle

| Option                     | Purpose                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `style`                    | Version 8 style object; required by the constructor                                   |
| `transformRequest`         | Transform style, source, tile, sprite, and glyph requests, including URLs and headers |
| `zoomLevelsToOverscale`    | Levels to reparse above a vector source's maximum zoom; defaults to `4`               |
| `localIdeographFontFamily` | Local CJK font family; defaults to `sans-serif`; `false` uses server glyphs           |
| `heightReference`          | Fill polygon draping; defaults to Cesium's `HeightReference.NONE`                     |
| `signal`                   | `fromUrl()` only: cancels the style request before tileset creation                   |

Use `setStyle(nextStyle)` to apply a new style object. Unchanged sources retain their tile caches. Register or replace RGBA images with `addImage()` / `updateImage()` and remove them with `removeImage()`.

`pick(pickObject)` resolves a supported primitive's pick ID to `{ layerId, properties }`. `stats()` exposes tile, collection, memory, and submitted-command counters. `setGpuMemoryBudgetBytes(bytes)` adjusts the GPU cache budget; active tiles are retained, so this is not a hard memory cap. Types and method signatures are available through the [public entry point](./packages/cesium-vector-tileset/index.ts) and [tileset implementation](./packages/cesium-vector-tileset/src/cesium-vector-tileset.ts).

When disposing a map, remove it from the scene and release it if the owning collection has not already done so:

```ts
import type { Scene } from 'cesium';
import type { CesiumVectorTileset } from 'cesium-vector-tileset';

export function removeVectorMap(scene: Scene, tileset: CesiumVectorTileset) {
  scene.primitives.remove(tileset);
  if (!tileset.isDestroyed()) {
    tileset.destroy();
  }
  scene.requestRender();
}
```

## Compatibility and limits

- The current workspace uses **Cesium 1.146**. The backend uses Cesium rendering internals, so verify compatibility when changing Cesium versions.
- Supported layer and source types are listed above. `heatmap`, `hillshade`, and `raster-dem` are not implemented. `line-gradient` is explicitly rejected by style validation.
- Draping applies only to ordinary fill polygons and requires the hosting scene's vector provider. Lines, circles, symbols, extrusions, and image patterns retain ellipsoid heights.
- Text and icons render, but symbol picking is currently disabled.
- `fromUrl()` resolves relative source TileJSON URLs, tile templates, sprites, and glyph URLs against the style URL. Use absolute URLs for GeoJSON `data`, image `url`, and video `urls` when they are remote resources.
- Browser rendering requires WebGL and module Workers. Deploy Cesium's static assets, including its complete `Workers` directory, along with the library's worker and shared chunks. The demo handles Cesium assets with `unplugin-cesium`; see [vite.config.ts](./vite.config.ts).
- The library is framework independent; Vue is used by the demo. Importing the package in Node does not provide server-side map rendering.

## Development

| Command              | Purpose                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm dev`           | Start the Vite demo server                                                                               |
| `pnpm build`         | Type-check and build the demo into root `dist/`                                                          |
| `pnpm preview`       | Preview the built demo                                                                                   |
| `pnpm build:mvt`     | Build library modules, worker, source maps, and declarations into `packages/cesium-vector-tileset/dist/` |
| `pnpm lint:eslint`   | Run ESLint with automatic fixes                                                                          |
| `pnpm lint:tsc`      | Run workspace TypeScript checks                                                                          |
| `pnpm test`          | Run Vitest unit tests                                                                                    |
| `pnpm test:e2e`      | Build the library and demo, then run the default Playwright suite                                        |
| `pnpm test:e2e:live` | Build the library and run Playwright tests tagged `@live` against external services                      |

Before running browser tests, install Chromium with `pnpm exec playwright install chromium`. Playwright reports and failure artifacts go to `node_modules/.cache/playwright/`.

After code changes, run `pnpm lint:eslint`, then `pnpm lint:tsc`, then relevant tests. Unit tests live beside the code in `__test__/` directories; browser tests live in `e2e/`.

Generated style properties, struct arrays, and Unicode tables should be regenerated rather than edited by hand:

```bash
pnpm --filter cesium-vector-tileset codegen
pnpm --filter cesium-vector-tileset generate-unicode-data
pnpm lint:eslint
```

Keep TypeScript on `6.0.x` until `vue-tsc` and `typescript-eslint` support the next version.

## Project layout and further reading

```text
packages/cesium-vector-tileset/
  index.ts           Public library exports
  src/               Styles, sources, workers, tiles, and Cesium rendering
  build/             Code generators
src/                 Vue demo, CesiumWidget configuration, and styles
e2e/                 Browser integration and rendering tests
docs/                Architecture and research notes
CONTEXT.md           Domain terminology
```

- [Architecture](./docs/architecture.md): tile lifecycle, rendering, and resource ownership.
- [Module responsibilities](./docs/module-responsibilities.md): module boundaries and consumers.
- [Domain terminology](./CONTEXT.md): the vocabulary used across the codebase.

These internal documents are currently written in Chinese.

## License and credits

The project is licensed under the [MIT License](./LICENSE). It builds on MapLibre GL JS and related MapLibre/Mapbox libraries, and uses Cesium for rendering. Third-party code and map data retain their respective licenses and attribution requirements.
