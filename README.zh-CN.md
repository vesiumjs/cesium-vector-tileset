# cesium-vector-tileset

[English](./README.md) | 简体中文

在 Cesium 中使用 MapLibre 风格的 JSON 样式渲染矢量瓦片。库复用 MapLibre GL JS 的代码与设计来处理样式表达式、瓦片数据和标注布局，再通过 Cesium 的 `Buffer*Collection` 与 `Primitive` API 绘制。

库可接入已有的 Cesium 场景，不依赖前端框架，并提供 TypeScript 类型声明。

[在线演示](https://vesiumjs.github.io/cesium-vector-tileset/)

## 图集

点击截图，在在线演示中体验对应场景。

| 伦敦 · 2D 路网与标注                                                                                                                                                                                                                                   | 东京 · 3D 城市地图                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [![Cesium 2D 中的伦敦路网、图标与文字标注](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/london-2d.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?source=liberty&view=london&mode=2d&scale=0.65)          | [![Cesium 3D 中的东京城市地图](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/tokyo-3d.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?source=liberty&scenario=shinjuku&height=2000)  |
| 阿姆斯特丹 · 建筑挤出                                                                                                                                                                                                                                  | 全球 · 球面地图                                                                                                                                                                                                                  |
| [![阿姆斯特丹的建筑挤出与运河](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/amsterdam-buildings.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?source=buildings&view=amsterdam&angle=oblique&scale=0.22) | [![在 Cesium 球面上渲染的 MapLibre 矢量瓦片](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/world-3d.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?source=world&view=world&mode=3d&scale=4000) |

城市地图：[OpenFreeMap](https://openfreemap.org/) / [OpenMapTiles](https://www.openmaptiles.org/) / © [OpenStreetMap](https://www.openstreetmap.org/copyright)。全球地图：[MapLibre 演示瓦片](https://demotiles.maplibre.org/) / [Natural Earth](https://www.naturalearthdata.com/)。

## 功能

| 领域         | 当前实现                                                                       |
| ------------ | ------------------------------------------------------------------------------ |
| 矢量数据     | Mapbox Vector Tiles（MVT）、MapLibre Tiles（MLT）和 GeoJSON                    |
| 其他数据源   | 栅格瓦片、图片、视频和 canvas                                                  |
| 样式图层     | `background`、`fill`、`line`、`circle`、`fill-extrusion`、`symbol` 和 `raster` |
| 样式能力     | MapLibre 样式表达式与过滤器、数据驱动 paint、虚线和图片图案                    |
| 标注         | 文字与图标、字形和 sprite 加载、碰撞排布、本地 CJK 字形生成                    |
| Cesium 集成  | 3D、2D、Columbus View、场景模式切换，以及受支持 Primitive 的要素拾取           |
| 瓦片生命周期 | Worker 处理、按相机选瓦片、父子瓦片替代、缓存和 GPU 资源退役                   |

本项目是 Cesium 渲染后端，实现了 MapLibre 的部分能力。选择样式前，请阅读[兼容性与限制](#兼容性与限制)。

## 安装

```bash
pnpm add cesium cesium-vector-tileset
```

在应用中配置 Cesium 的静态资源。

## 接入 Cesium

以下示例假定应用已经创建 Cesium `Scene` 并运行渲染循环。

### 从 URL 加载样式

将版本 8 的样式 JSON 部署在 `/styles/map.json`，或将示例 URL 替换为数据提供方的样式地址：

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

`fromUrl()` 请求样式并创建实例；`whenReady()` 等待样式初始化，不代表视口瓦片已绘制。实例加入场景后，`tilesLoaded` 表示当前数据源、几何上传和待处理符号工作是否已完成。相机移动时，该值可能再次变化。

Cesium 通过 Primitive 的 `update(frameState)` 回调提供相机、投影和渲染上下文。实例通过 `frameState.afterRender` 请求后续帧，在 `requestRenderMode` 下也能继续异步加载，无需额外传入场景或渲染回调。

### 使用内联样式

内联 GeoJSON 数据源可以在没有瓦片服务器的情况下体验 API：

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

将相机移到上海即可查看这个点。使用矢量瓦片数据源时，各图层还需要设置 `source-layer`，与瓦片内部的图层名对应。

### 配置与生命周期

| 配置项                     | 用途                                                            |
| -------------------------- | --------------------------------------------------------------- |
| `style`                    | 版本 8 的样式对象，构造函数必填                                 |
| `transformRequest`         | 转换样式、数据源、瓦片、sprite 和字形请求，包括 URL 和请求头    |
| `zoomLevelsToOverscale`    | 在矢量源最大 zoom 以上继续重新解析的层级数，默认 `4`            |
| `localIdeographFontFamily` | 本地 CJK 字体，默认 `sans-serif`；设为 `false` 则使用服务端字形 |
| `heightReference`          | 填充多边形贴地配置，默认 Cesium 的 `HeightReference.NONE`       |
| `signal`                   | 仅用于 `fromUrl()`，在实例创建前取消样式请求                    |

使用 `setStyle(nextStyle)` 应用新的样式对象，未变化的数据源保留瓦片缓存。通过 `addImage()` / `updateImage()` 注册或替换 RGBA 图片，通过 `removeImage()` 移除图片。

`pick(pickObject)` 将受支持 Primitive 的拾取 ID 解析为 `{ layerId, properties }`。`stats()` 提供瓦片、集合、内存和已提交绘制命令计数。`setGpuMemoryBudgetBytes(bytes)` 调整 GPU 缓存预算；活动瓦片会保留，因此该预算不是内存硬上限。类型与方法签名见[公共入口](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/packages/cesium-vector-tileset/index.ts)和[实例实现](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/packages/cesium-vector-tileset/src/cesium-vector-tileset.ts)。

释放地图时，从场景移除实例；如果所属集合尚未销毁它，再显式释放：

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

## 兼容性与限制

- 已验证的 Cesium 版本：1.146.0。
- 支持的图层与数据源类型见上表。尚未实现 `heatmap`、`hillshade` 和 `raster-dem`；样式校验会明确拒绝 `line-gradient`。
- 贴地仅适用于普通填充多边形，且需要承载场景的矢量 provider。线、圆点、符号、挤出建筑和图片图案仍使用椭球高度。
- 文字与图标可以绘制，但符号拾取目前关闭。
- `fromUrl()` 将相对的数据源 TileJSON URL、瓦片模板、sprite 和字形 URL 按样式 URL 解析。远程 GeoJSON `data`、图片 `url` 和视频 `urls` 请使用绝对 URL。
- 浏览器渲染需要 WebGL 和 module Worker。部署时需提供 Cesium 静态资源，包括完整的 `Workers` 目录，以及库的 worker 和共享模块产物。演示通过 `unplugin-cesium` 处理 Cesium 资源，见 [vite.config.ts](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/vite.config.ts)。
- 库本身不依赖框架，Vue 用于演示应用。在 Node 中导入包不等于支持服务端地图渲染。

## 许可证与致谢

项目采用 [MIT 许可证](./LICENSE)。实现参考 MapLibre GL JS 的代码与设计，并使用 Cesium 渲染。第三方依赖与地图数据仍遵循各自的许可证和署名要求。
