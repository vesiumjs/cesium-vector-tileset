# cesium-vector-tileset [![npm 版本](https://img.shields.io/npm/v/cesium-vector-tileset.svg)](https://www.npmjs.com/package/cesium-vector-tileset)

[English](./README.md) | 简体中文

为 Cesium 场景添加可定制的矢量地图，显示道路、陆地与水域、点、文字标注和挤出建筑。通过 MapLibre 风格的 JSON 样式控制地图外观，与已有 Cesium 内容一起使用。

库支持 3D、2D 和 Columbus View，不依赖前端框架，并提供 TypeScript 类型声明。它复用 MapLibre GL JS 的样式与瓦片处理能力，通过 Cesium 的渲染 API 绘制。

[在线演示](https://vesiumjs.github.io/cesium-vector-tileset/)：选择视角预设、地图样式与场景模式，添加或移除地图，实时查看当前相机位置及 heading、pitch、roll。

## 图集

点击截图，在在线演示中体验对应地图。

| 上海 · 陆家嘴高层白模                                                                                                                                                                                                            | 香港 · 中环海岸高楼                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [![上海 · 陆家嘴高层白模](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/shanghai-buildings.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=shanghai&source=buildings&mode=3d) | [![香港 · 中环海岸高楼](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/hong-kong-buildings.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=hong-kong&source=buildings&mode=3d) |
| **伦敦 · 2D 路网与标注**                                                                                                                                                                                                         | **巴塞罗那 · 密集网格路口**                                                                                                                                                                                                      |
| [![伦敦 · 2D 路网与标注](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/london-2d.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=london&source=liberty&mode=2d)               | [![巴塞罗那 · 密集网格路口](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/barcelona-3d.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=barcelona&source=liberty&mode=3d)      |
| **芝加哥 · 高层与密集标注**                                                                                                                                                                                                      | **重庆 · 两江交汇与桥梁**                                                                                                                                                                                                        |
| [![芝加哥 · 高层与密集标注](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/chicago-3d.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=chicago&source=liberty&mode=3d)          | [![重庆 · 两江交汇与桥梁](https://raw.githubusercontent.com/vesiumjs/cesium-vector-tileset/main/docs/images/chongqing-3d.jpg)](https://vesiumjs.github.io/cesium-vector-tileset/?preset=chongqing&source=liberty&mode=3d)        |

地图数据：[OpenFreeMap](https://openfreemap.org/) / [OpenMapTiles](https://www.openmaptiles.org/) / © [OpenStreetMap](https://www.openstreetmap.org/copyright)。

## 快速开始

安装库与 Cesium：

```bash
pnpm add cesium@^1.146.0 cesium-vector-tileset
```

默认入口使用未压缩版本。通过 `cesium-vector-tileset/min` 导入压缩版本；CDN 文件及其 Worker 使用 `.min.mjs` 后缀。

以下示例假定应用已有 Cesium `Scene` 和渲染循环。将版本 8 的样式 JSON 部署在 `/styles/map.json`，或替换为地图提供方的样式地址：

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

将相机移到数据源覆盖的区域即可查看地图。矢量瓦片图层的 `source-layer` 需要与瓦片内部图层名对应。也可以通过 `new CesiumVectorTileset({ style })` 传入内联样式和 GeoJSON，并在加入场景前等待 `whenReady()`。演示中的[样式示例](https://github.com/vesiumjs/cesium-vector-tileset/tree/main/src/styles)可供参考。

应用需要部署 Cesium 静态资源，并与场景使用同一份 Cesium 安装。保留库发布模块的相对位置，包括 `worker.mjs` 和 `geometry-worker.mjs`；浏览器渲染需要 WebGL 和模块 Worker。演示的 [Vite 配置](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/vite.config.ts)展示了如何通过 `unplugin-cesium` 配置资源。

## 使用与生命周期

`fromUrl()` 和 `whenReady()` 等待样式初始化完成。实例加入场景后才会加载视口瓦片；`tilesLoaded` 表示当前加载与渲染准备是否已完成，相机移动后可能再次变化。初始化失败通过 Promise 拒绝报告，后续错误可通过 `errorEvent` 监听。

修改 `show` 控制显示，调用 `setStyle(nextStyle)` 更换地图样式。在 Cesium 按需渲染模式下，库会为自身异步工作请求后续帧；场景与相机仍由应用管理。

需要鉴权或定制资源请求时，在创建实例时传入 `transformRequest`。`gpuMemoryBudgetBytes` 控制瓦片 GPU 驻留缓存的估算预算，默认 256 MiB；活跃瓦片会保留，因此该值不是 GPU 总内存的硬上限。`stats()` 可帮助查看加载与资源情况。配置项和方法签名可在包内 TypeScript 类型声明中查看。

不再使用时移除并销毁实例。Cesium 集合通常会销毁移除的 Primitive；以下写法也适用于配置为保留移除对象的集合：

```ts
scene.primitives.remove(tileset);
if (!tileset.isDestroyed()) {
  tileset.destroy();
}
```

## 样式与兼容性

- 数据源：MVT、MLT、GeoJSON、栅格瓦片、图片、视频和 canvas。图层：`background`、`fill`、`line`、`circle`、`fill-extrusion`、`symbol` 和 `raster`。
- 支持 MapLibre 表达式、过滤器、数据驱动样式、虚线、图片图案、文字与图标。当前实现覆盖 MapLibre 的部分渲染能力；不支持 `heatmap`、`hillshade` 和 `raster-dem`，`line-gradient` 会被拒绝。
- 场景提供 Cesium vector provider 时，`heightReference` 可让普通填充面贴附。线、点、标注、挤出建筑与图片图案保留椭球高度。文字与图标暂不支持拾取。
- 从样式 URL 加载时，数据源 URL、瓦片模板、sprite 与 glyphs 的相对地址按样式 URL 解析。远程 GeoJSON `data` 和视频 `urls` 请使用绝对地址。
- Cesium peer 范围为 `^1.146.0`，已有渲染基线使用 1.146.0。部分渲染集成访问 Cesium 内部接口，声明范围不代表每个后续版本都已测试。验证范围见[验收记录](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/docs/research/performance-baseline.md)。

## 文档与支持

实现细节见[架构](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/docs/architecture.md)与[模块职责](https://github.com/vesiumjs/cesium-vector-tileset/blob/main/docs/module-responsibilities.md)。遇到问题可提交 [GitHub issue](https://github.com/vesiumjs/cesium-vector-tileset/issues)，附上可复现的样式、受影响的视角和 Cesium 版本。

## 许可与致谢

项目采用 [MIT License](./LICENSE)。实现复用 MapLibre GL JS 的代码与设计，使用 Cesium 渲染。发布产物包含第三方许可声明；依赖与地图数据保留各自许可。应用需要展示地图提供方要求的署名。
