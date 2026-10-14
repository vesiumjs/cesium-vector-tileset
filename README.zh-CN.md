# cesium-vector-tileset [![npm 版本](https://img.shields.io/npm/v/cesium-vector-tileset.svg)](https://www.npmjs.com/package/cesium-vector-tileset)

[English](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/README.md) | 简体中文

为 Cesium 场景添加矢量地图。使用 MapLibre 风格的 JSON 样式显示道路、水域、文字、图标和建筑，与场景中的其他内容一起使用。

支持三维地球、二维地图与 Columbus View，不依赖前端框架，提供 TypeScript 类型声明。

[在线演示](https://vesiumjs.github.io/cesium-vector-tileset/) · [样式示例](https://github.com/vesiumjs/cesium-vector-tileset/tree/main/src/styles) · [GitHub](https://github.com/vesiumjs/cesium-vector-tileset)

## 图集

场景、样式和视图可以独立选择。点击图片打开演示中的对应组合；切换场景会保留当前样式。

| 典型场景                                                                                                                                                                                                                                | 更多场景                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [![巴塞罗那 · 城区俯视](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/demo-barcelona-overview.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=barcelona&source=liberty&mode=3d)      | [![曼哈顿 · 高层建筑](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/demo-manhattan-buildings.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=manhattan&source=buildings&mode=3d) |
| [![伦敦 · 河流与桥梁](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/demo-london-bridge.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=london&source=liberty&mode=3d)                | [![全球 · 地球视图](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/demo-world-overview.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=world&source=world&mode=3d)                |
| [![阿姆斯特丹 · 运河街区](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/demo-amsterdam-buildings.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=amsterdam&source=buildings&mode=3d) | [![巴黎 · 放射路网](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/demo-paris-streets.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=paris&source=bright&mode=3d)                |
| [![上海 · 滨江高层](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/demo-shanghai-river.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=shanghai&source=liberty&mode=3d)               | [![伦敦 · 二维地图](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/demo-london-2d.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=london&source=positron&mode=2d)                 |

数据：[OpenFreeMap](https://openfreemap.org/)、© [OpenStreetMap](https://www.openstreetmap.org/copyright)、[MapLibre demo tiles](https://demotiles.maplibre.org/)。

## 安装

```bash
pnpm add cesium@^1.146.0 cesium-vector-tileset
```

按 Cesium 的常规方式部署静态资源。使用 Vite 时可参考演示的[配置](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/vite.config.ts)，其中通过 `unplugin-cesium` 完成资源配置。为地图容器设置高度，例如 `<div id="map" style="height: 100vh"></div>`。

## 添加地图

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

已有 Cesium Viewer 时，将地图加入它的 `scene.primitives` 即可，相机由你的应用控制。`fromUrl()` 完成样式初始化后，地图会随视角加载可见瓦片；初始化错误通过 Promise 拒绝报告。

可以使用兼容的版本 8 样式 JSON。使用自己的数据时，通过 `new CesiumVectorTileset({ style })` 传入内联样式，[样式示例](https://github.com/vesiumjs/cesium-vector-tileset/tree/main/src/styles)可供参考。矢量图层的 `source-layer` 应与瓦片内部图层名对应；样式、瓦片、图标和字体服务器需要允许浏览器跨域访问。

## 常用操作

```ts
map.show = false; // 暂时隐藏地图。
map.show = true;
map.setStyle(nextStyle); // 传入新的样式 JSON 对象。
const loading = !map.tilesLoaded;
const stats = map.stats(); // 查看瓦片、绘制和内存统计。

viewer.scene.primitives.remove(map); // Cesium 通常会销毁移除的对象。
```

如果 PrimitiveCollection 配置了 `destroyPrimitives: false`，移除后需要调用 `map.destroy()`。需要资源鉴权时，在创建地图时传入 `transformRequest`。其他配置项和图片操作方法可通过包内 TypeScript 类型声明查看。

需要压缩版本时，从 `cesium-vector-tileset/min` 导入。复制发布文件时，保留主模块及 Worker 文件的相对位置；地图和场景使用同一份 Cesium 安装。

## 支持范围

支持 MVT、MLT、GeoJSON 矢量数据以及栅格瓦片、图片、视频、canvas。样式可使用面、线、圆点、文字图标和挤出建筑，包括表达式、过滤器、图片图案和双向文字。

当前实现覆盖 MapLibre 的部分能力，不支持 `heatmap`、`hillshade`、`raster-dem` 和 `line-gradient`。字体需要包含所显示的字形。在兼容 Cesium 场景中，可通过 `heightReference` 将普通面贴地；其他图层保持椭球高度。暂不支持文字、图标拾取。

Cesium peer 范围为 `^1.146.0`，渲染接入使用 1.146.0 验证。请按数据提供方要求展示版权署名。

## 开发与反馈

```bash
pnpm install
pnpm dev
```

贡献和验证约定见 [AGENTS.md](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/AGENTS.md)。通过 [GitHub issues](https://github.com/vesiumjs/cesium-vector-tileset/issues)反馈可复现的问题，并提供样式、视角和 Cesium 版本。

## 许可

[MIT](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/LICENSE)。项目复用 MapLibre GL JS 代码并使用 Cesium 渲染，发布包包含第三方声明；地图数据遵循各提供方的许可。
