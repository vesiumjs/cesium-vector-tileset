# Cesium 1.140 之后的能力与公开 MVT 源

核对日期：2026-09-30 起；最近复核为 2026-10-02 北京时间。2026-10-01 UTC 20:55:53 GitHub 正式发布 `1.146`，21:21:37.114 npm 发布 `1.146.0`；21:22:10 GET 官方 registry 时 latest 已同步。早先 GET 仍为 1.145 的结果属于历史快照。只使用 Cesium、数据提供方及对应数据版权方的一手资料；下面将已发布能力、网络实测和工程建议分别标明。[官方 release](https://github.com/CesiumGS/cesium/releases/tag/1.146)、[官方 latest API](https://api.github.com/repos/CesiumGS/cesium/releases/latest)、[npm registry](https://registry.npmjs.org/cesium)

## 结论

本项目当前验证基线为 Cesium `1.146.0` / engine `26.4.0` / widgets `16.3.0` / core `0.1.0`，库的 peer 限定为这一已验收 Cesium 版本。升级阶段的582项单测及两批90个不同离线用例已经通过；后续重构的当前检查与未完成项见 [验收基线](./performance-baseline.md#当前验证)。平面线条的 Native combine/upload 适配与 VA 预算捕获访问引擎内部契约，后续版本应先通过对应真实 WebGL 回归，再放开版本范围。仅固定 Cesium peer 不会固定 engine：cesium 1.145 的依赖为 `@cesium/engine: ^26.3.0`，允许解析到 26.4；必须同时记录 lockfile 的实际 engine 版本。[1.145 manifest](https://registry.npmjs.org/cesium/1.145.0)

2026-09-30 核对时官方 latest 是 1.145，1.146 只在 main 候选记录中；最近复核确认 1.146 已正式发布，包含 engine `26.4.0`、widgets `16.3.0` 和新增 core `0.1.0`。core 拆包及实际 peer/Worker 资产需要运行验证，不能仅凭静态 API 相似就认为升级已验收。[固定 1.146 manifest](https://github.com/CesiumGS/cesium/blob/1.146/package.json#L52)、[engine manifest](https://registry.npmjs.org/@cesium%2fengine/26.4.0)

**建议**：保留 Primitive 扩展库定位，优先使用 Cesium 的 Buffer collections、集合生命周期、包围球与按需渲染。原生 `MVTDataProvider` 可作为几何/贴地性能比较对象，但不能据其存在便删除 MapLibre cartography 实现；其公开入口没有 Style JSON 参数。[1.145 MVTDataProvider 源码](https://github.com/CesiumGS/cesium/blob/1.145/packages/engine/Source/Scene/MVTDataProvider.js)

## 已发布、直接相关的变化

| 版本  | 事实                                                                                                                                                                       | 对本项目的意义（工程判断）                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1.141 | Node 最低版本变为 22；Buffer collection 的 `modelMatrix` / `boundingVolume` / `boundingVolumeWC` 不再允许重新赋值；新增 vector metadata 支持。                             | CI 使用 Node 22+；更新矩阵/包围球内容时遵守公开只读引用约定。                                                    |
| 1.142 | 新增 `GeoJsonPrimitive`、`MVTDataProvider`；Buffer collection 新增 `blendOption` 和预计算 `boundingVolume`；包围球改为世界坐标；修复 Buffer point 位置修改不刷新。         | 不再自行实现这些基础几何集合；tile 级世界包围球可以避免动态自动扫描。                                            |
| 1.143 | Buffer point 的 `outlineWidth=0` 不再发生描边颜色渗入；修复 `Scene.updateHeight` 回调错误位置。                                                                            | 不需要为已修复的引擎行为维持应用侧兜底。                                                                         |
| 1.144 | 新增 vector terrain draping；`Texture.defaultColor` 可设材质占位色；修复创建 Framebuffer 后的缓存失同步导致的一帧黑闪。                                                    | 闪屏诊断必须区分引擎 framebuffer 问题与应用的 tile 替换；1.145 已包含此修复。                                    |
| 1.145 | Buffer polyline/polygon 支持向 3D Tiles 贴附；新增 `heightReference` 与 polyline `widthUnits`；改进 vector replacement refinement；修复 draped polyline 双倍宽度并抗锯齿。 | 地形/3D Tiles 贴附优先交给引擎；评估官方 vector traversal；不要把它的改进误认为已经修复本项目自有 tile manager。 |

表内事实来自对应版本的官方发布记录与固定 tag 的 changelog：[1.141](https://github.com/CesiumGS/cesium/releases/tag/1.141)、[1.142](https://github.com/CesiumGS/cesium/releases/tag/1.142)、[1.143](https://github.com/CesiumGS/cesium/releases/tag/1.143)、[1.144](https://github.com/CesiumGS/cesium/releases/tag/1.144)、[1.145](https://github.com/CesiumGS/cesium/releases/tag/1.145)、[固定 1.145 changelog](https://github.com/CesiumGS/cesium/blob/1.145/CHANGES.md)

## 1.146 正式能力与升级边界（2026-10-02）

| 已发布能力                          | 精确边界与工程判断                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Buffer `blendOption` setter         | 只接受 OPAQUE/TRANSLUCENT；renderer 在 pass 改变时释放 renderState 并重建 command。本库已删除跨透明度边界复制整个 Buffer collection 的路径，直接使用 setter。真实像素回归验证透明度往返与独立 circle stroke：集合、VA、pick 身份稳定，原有 GPU buffer 零重分配；Native 仍有属性上传，不能写成零上传。[setter](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/BufferPrimitiveCollection.js#L1054)、[polygon renderer](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/renderBufferPolygonCollection.js#L336) |
| BufferPrimitive `pickObject` setter | 要求 `_pickId === NULL_PICK_ID`，渲染后不能更改；不可用于任意重绑已经显示的 retired collection。[固定源码](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/BufferPrimitive.js#L233)                                                                                                                                                                                                                                                                                                                                                     |
| 批量 `setPositions` 与 dirty 分类   | 要求目标顶点数、输入数组类型匹配。polyline renderer 属性更新可以跳过 CPU 位置编码，但 PROPERTIES 分支仍上传全部属性；不是 paint 上传字节已经下降的证据。[collection](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/BufferPolylineCollection.js#L193)、[renderer](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/renderBufferPolylineCollection.js#L510)                                                                                                                                                   |
| `PrimitiveCollection.add<T>`        | JSDoc/生成类型返回 T，runtime body 与 1.145 相同；有助减少调用侧类型断言，不是运行时性能变化。[固定源码](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/PrimitiveCollection.js#L131)                                                                                                                                                                                                                                                                                                                                                   |
| draped 大宽度 polyline 修复         | pixels 改用深度相关 metersPerPixel，扩大覆盖区、修复离屏 terrain tile 旧数据；米宽新增 `0.1 × ellipsoid.maximumRadius` 上限。属于 VectorProvider draping 路径，不能归因于本库当前自定义道路 Primitive；AA 加入和双倍宽度修复属于 1.145。[官方 PR](https://github.com/CesiumGS/cesium/pull/13737)、[shader](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Shaders/VectorCommon.glsl#L83)、[changelog](https://github.com/CesiumGS/cesium/blob/1.146/CHANGES.md#L54)                                                                          |

固定 1.145→1.146 源码对比中，combineGeometry.js、PrimitiveState.js 逐字相同；PrimitivePipeline、createTaskProcessorWorker、buildModuleUrl 除 core imports 外正文相同。请求 `id/baseUrl/parameters/canTransferArrayBuffer`、返回 `id/result/error` 未变。Primitive.js 仅两处将 `new values.constructor` 改成局部 Constructor 后构造；COMBINED 安装、批表、VA、afterRender ready、destroy 正文未变。engine 26.4 的发布 index.js 仍导出 PrimitivePipeline/PrimitiveState。以上是静态证据，不能代替真实运行。[Worker](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Workers/combineGeometry.js)、[协议](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Workers/createTaskProcessorWorker.js#L29)、[Primitive](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/Primitive.js#L1285)、[发布包](https://registry.npmjs.org/@cesium%2fengine/26.4.0)

1.146 及同一固定 main 提交的 TaskProcessor probe 仍没有 error/messageerror reject/terminate，升级不能替代本轮单用途 Worker owner 修复。升级验收需固定 cesium/engine/core 实际版本，并重跑现有 Native 数值、四种布局、日期线/投影、同源/CDN Worker、三模式 paint/交接/取消/pick/ready，以及实际 Buffer 透明度、show、材质和适用的 draping 回归。[固定 TaskProcessor](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Core/TaskProcessor.js#L33)、[固定 main](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Core/TaskProcessor.js#L33)

## 本次升级的运行验证

Native Buffer renderer 以自己命令的 pass 判断混合变化。旧样式规划会把原命令改为 OPAQUE，既导致稳定透明帧重复重建命令，又可能使透明→不透明时保留旧混合状态。现在使用缓存的 Native DrawCommand.shallowClone 参与样式顺序，保留原命令的 pass/renderState；源 dirty 时才刷新。真实 GPU 回归同时核对稳定帧命令身份及双向 Native blending.enabled。[Native command factory](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Renderer/DrawCommand.js#L625)

独立描边回归首先发现：circle opacity 最终为零时，原 RGB 仍参与 Native 内缘插值，透明绿色填充与蓝色描边产生 50 个绿色主导像素。颜色提取在 opacity 乘入后将最终零 alpha 的颜色清为零 RGBA，消除了该错色。后续真实 framebuffer 回归进一步证明：Native 分别插值 RGB 与 alpha，使部分透明内缘产生交叉项；纯绿填充 alpha=64/255、纯蓝描边 alpha=192/255 的单通道误差约 33 byte，交换 alpha 后误差方向相反。不透明恢复时误差归零，不能只检查两通道总亮度。现在在原 Native fragment shader 上派生预乘贡献插值，再归一化以保留 Native straight-alpha 混合，3D/2D/CV 的同模式 opaque 参考复测单通道误差均小于 1 byte。原几何、Native coverage/discard/gamma 和拾取继续使用；没有复制一套完整点 shader。该颜色比例结论限于关闭 HDR 与后处理的 SDR 测量，HDR 继续使用 Native gamma/tonemapping。另由这个回归发现并修正标准 PointPrimitive setter 前先 mutate getter 导致 GPU 颜色不上传的问题。[Native shader](https://raw.githubusercontent.com/CesiumGS/cesium/1.146/packages/engine/Source/Shaders/BufferPointMaterialFS.glsl)、[MapLibre 6.11.2 shader](https://raw.githubusercontent.com/maplibre/maplibre-gl-js/v6.11.2/src/shaders/glsl/circle.fragment.glsl)

Demo 使用原生 CesiumWidget 管理渲染循环、resize 与浏览器输入，配置集中在 `src/demo-config.ts`。真实浏览器覆盖 idle、拖拽/滚轮、飞行完成/取消、非零时长 3D/2D/CV morph、DPR2、零尺寸恢复与 Primitive 渲染异常。FPS 保持开启。Native Buffer 的 destroy 释放渲染上下文、VA 与拾取颜色，但其 isDestroyed 始终返回 false；GPU 回归以实际资源句柄验证释放。[Buffer lifecycle](https://github.com/CesiumGS/cesium/blob/1.146/packages/engine/Source/Scene/BufferPrimitiveCollection.js#L386)

开发服务器另复现了 Worker 依赖运行中重新优化，使旧 tinyqueue 模块请求 504、WorkerChannel 留下 26/33 个 pending 的问题。Vite 现在预扫描 Worker 入口；共享 MVT Worker 池也统一处理 error/messageerror，让所有客户端请求按原 Error 结算，并向 Style 报告。真实 Worker 模块 504 验证待处理请求清空、后来客户端失败回放、健康 Worker 继续响应和终止一次；没有重试或重新选 Worker。

## 公开 API 的复用边界

### Buffer collections

官方明确将这些 API 标记为 experimental；它们可公开使用，但变更不受常规弃用流程约束。集合使用 ArrayBuffer 保存大量几何，推荐复用 `BufferPrimitive`、`Color`、`Cartesian3` 等 flyweight 对象，避免 N 个 feature 对应 N 套 JS 对象。容量在构造时确定，集合不能原地 resize；提供 `clone` / `fromCollection` 复制到更大集合，新集合不继承旧集合 GPU 资源的所有权。[BufferPrimitiveCollection 文档](https://cesium.com/learn/cesiumjs/ref-doc/BufferPrimitiveCollection.html)、[BufferPolylineCollection 文档](https://cesium.com/learn/cesiumjs/ref-doc/BufferPolylineCollection.html)

polygon 的公开输入包括 `positions`、`holes`、`triangles`；官方示例直接使用 `earcut` 三角化。关闭不需要的 picking 能减少初始化成本和内存；已知包围球可从构造参数传入，之后由调用方负责维护。1.145 的贴附仅支持 polyline/polygon，必须将集合加入 `scene.primitives`。[固定 1.145 polygon 源码](https://github.com/CesiumGS/cesium/blob/1.145/packages/engine/Source/Scene/BufferPolygonCollection.js)、[固定 1.145 base collection 源码](https://github.com/CesiumGS/cesium/blob/1.145/packages/engine/Source/Scene/BufferPrimitiveCollection.js)

**建议**：worker 解码阶段统计 vertex/hole/triangle 容量，tile commit 时精确分配；复用 flyweight 写入，避免 feature 对象与几何数组在主线程反复转译。保留一个清晰的渲染适配模块承担 experimental API 版本变化；该模块不需要运行时猜测 API 是否存在的兼容分支。

传统 `Primitive` 已提供多实例 batching、worker 几何创建、`compressVertices`、`releaseGeometryInstances`、可选 picking 和 `ready`。其 `ready` 表示下一次 `update` 可以绘制，`update` 应由 Scene 调用。[Primitive 文档](https://cesium.com/learn/cesiumjs/ref-doc/Primitive.html)

### 原生 MVTDataProvider

`MVTDataProvider.fromUrl` 输入 XYZ URL 模板，支持 `minZoom` / `maxZoom` / `extent` / `featureIdProperty` / `heightReference` / `scene`。它把 MVT 解码为 vector glTF，再使用 Cesium3DTileset；404/204 作为缺失瓦片处理，公开生成结果在 `provider.tileset`。这是 experimental API。[固定 1.145 MVTDataProvider 源码](https://github.com/CesiumGS/cesium/blob/1.145/packages/engine/Source/Scene/MVTDataProvider.js)、[父 provider 源码](https://github.com/CesiumGS/cesium/blob/1.145/packages/engine/Source/Scene/UrlTemplate3DTilesDataProvider.js)

源码为 MVT layer 建立独立 node，并向 feature properties 写入 `_layer`。公开入口没有 MapLibre Style JSON 消费接口；不能把 `Cesium3DTileStyle` 与 MapLibre 的 source/layer/symbol/sprite 规则视为等价。原生实现也包含运行时 glTF/metadata 转换，应实测总 CPU 与内存，再决定是否适用于目标用例。[vector glTF 构建源码](https://github.com/CesiumGS/cesium/blob/1.145/packages/engine/Source/Scene/buildVectorGltfFromMVT.js)

**建议**：完整地图 cartography 继续复用 MapLibre style-spec 和成熟解码/三角化依赖，Cesium 负责 scene、geometry collection、GPU 与 picking。对只要求基础 geometry/per-feature color 的用例，单独比较原生 provider；避免在公共 API 内引入双套自动后备引擎。

## 按需渲染与闪屏

启用 `requestRenderMode` 后，camera/terrain/imagery/3D Tiles 等变化可自动触发帧，但应用通过 Primitive/Entity API 改内容通常需要 `scene.requestRender()`。update 事件仍会执行；postRender 仅在实际绘制时执行。没有时间驱动内容时可将 `maximumRenderTimeChange` 设为 `Infinity`。[官方 explicit rendering 说明](https://cesium.com/blog/2018/01/24/cesium-scene-rendering-performance/)、[Scene 文档](https://cesium.com/learn/cesiumjs/ref-doc/Scene.html)

**建议**：在 tile commit、样式修改、符号 atlas 完成、visibility 改变时请求一帧；仅当异步 geometry 尚未 ready 或 fade 动画仍在推进时继续请求帧。避免永久 postRender→requestRender 循环。为了使异步 tile 替换无空白，必须把「请求结束」「CPU 构建完成」「GPU 可绘制」「可替换旧覆盖」作为实际不同状态；其正确性由帧序列测试确认，不能只靠网络 pending 数为零。

官方 framebuffer 修复针对 mid-frame construction 扰乱 `Context._currentFramebuffer`，并不能证明任何应用级闪屏已消失。官方 vector refinement 问题针对 LOD 简化后出现连续空子节点、细层几何突然跳出的情况。[黑帧 PR #13662](https://github.com/CesiumGS/cesium/pull/13662)、[vector refinement issue #13686](https://github.com/CesiumGS/cesium/issues/13686)

**建议测试**：延迟 child MVT 响应时 parent 仍保持覆盖；只完成一部分 child 时不产生洞；连续缩放/快速换源时旧异步任务不提交；requestRenderMode 下最终内容一定绘制，静止后不持续绘制；反复移除 layer 后 GPU collection 和事件订阅数量回到初始值。需要录制多帧检测空白，单张稳定截图不能证明无闪屏。

## 免密钥公开数据源

以下是三个不同提供方；Liberty/Bright/Positron 只是同一个 OpenFreeMap 数据源的不同样式，不能算三个独立数据源。2026-09-30 实测以 `User-Agent: Mozilla/5.0` GET style/TileJSON/sample tile，均 HTTP 200，`Access-Control-Allow-Origin: *`。这些结论是当天可访问性的观测，不是长期服务承诺。

| Demo 预设           | 官方 Style / TileJSON                                                                                                                  | Tile 模板与范围                                                                                | 用途                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| OpenFreeMap Liberty | [Style](https://tiles.openfreemap.org/styles/liberty)，[TileJSON](https://tiles.openfreemap.org/planet)                                | TileJSON 返回带周版本路径的 `/planet/<snapshot>/{z}/{x}/{y}.pbf`；z0–14；OpenMapTiles schema。 | 默认城市 cartography，密集道路、建筑、POI、复杂文字。                |
| VersaTiles Colorful | [Style](https://tiles.versatiles.org/assets/styles/colorful/style.json)，[TileJSON](https://tiles.versatiles.org/tiles/osm/tiles.json) | `https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}`；z0–14；Shortbread schema。               | 第二种 schema，验证实现不依赖 OpenMapTiles 的 layer 命名。           |
| MapLibre World      | [Style](https://demotiles.maplibre.org/style.json)，[TileJSON](https://demotiles.maplibre.org/tiles/tiles.json)                        | `https://demotiles.maplibre.org/tiles/{z}/{x}/{y}.pbf`；z0–6；countries/geolines/centroids。   | 全球低缩放、经纬线、国家面、match expression；不适合城市 benchmark。 |

来源与适用范围：[OpenFreeMap 官方 quick start](https://openfreemap.org/quick_start/)、[VersaTiles 官方公共服务器指南](https://docs.versatiles.org/guides/use_tiles_versatiles_org)、[MapLibre 官方 demotiles README](https://github.com/maplibre/demotiles)

### 实测响应

| 请求                                                                           | HTTP / CORS | 响应大小                                                 |
| ------------------------------------------------------------------------------ | ----------- | -------------------------------------------------------- |
| OpenFreeMap `/styles/liberty`、`/styles/bright`、`/styles/positron`、`/planet` | 200 / `*`   | 样式/TileJSON 已解析；snapshot 为 `20260927_080001_pt`。 |
| OpenFreeMap `/planet/20260927_080001_pt/0/0/0.pbf`                             | 200 / `*`   | 80,890 bytes；MVT content-type。                         |
| VersaTiles `/assets/styles/colorful/style.json`                                | 200 / `*`   | 167,849 bytes；JSON。                                    |
| VersaTiles `/tiles/osm/tiles.json`                                             | 200 / `*`   | 6,855 bytes；JSON。                                      |
| VersaTiles `/tiles/osm/0/0/0`                                                  | 200 / `*`   | 127,323 bytes；MVT content-type。                        |
| MapLibre `/style.json`、`/tiles/tiles.json`                                    | 200 / `*`   | JSON 已解析。                                            |
| MapLibre `/tiles/0/0/0.pbf`                                                    | 200 / `*`   | 101,760 bytes；octet-stream。                            |

**实现建议**：不要写死 OpenFreeMap snapshot 路径，始终解析 `/planet`。VersaTiles TileJSON 返回 `/tiles/osm/{z}/{x}/{y}` 相对模板，需要相对 TileJSON URL 解析。OpenFreeMap style 还包含 `natural_earth` raster layer/source；MapLibre World style 还包含 GeoJSON source。若 demo 只显示 vector 子集，应明确表示实际显示范围，不能静默宣称完整样式已兼容。额外可提供 [Bright](https://tiles.openfreemap.org/styles/bright) / [Positron](https://tiles.openfreemap.org/styles/positron) 简单样式切换。

### Attribution 与使用限制

- **OpenFreeMap**：官方允许商业使用，无 key、注册、请求数限制，但不提供 SLA。地图上必须展示 OpenMapTiles 与 OpenStreetMap attribution，OpenFreeMap attribution 是推荐项；不要把软件 MIT 许可当成底层地图数据许可。[官方 usage/license/attribution](https://openfreemap.org/)、[OpenStreetMap copyright](https://www.openstreetmap.org/copyright)
- **VersaTiles**：官方开放免费公共服务器，tileset 指南将 hosted tiles 用途描述为原型和小项目。style/TileJSON 的 attribution 包含 OpenStreetMap contributors 和 ESA WorldCover 2021（CC BY 4.0），需要保留；公共 frontend assets 可能随上游更新发生 breaking change。[公共服务器指南](https://docs.versatiles.org/guides/use_tiles_versatiles_org)、[tileset 指南](https://docs.versatiles.org/basics/tilesets.html)、[style 实测内容](https://tiles.versatiles.org/assets/styles/colorful/style.json)
- **MapLibre World**：官方将它定位为 helloworld/CI demo，无 key、静态托管，可离线。仓库代码 BSD-3-Clause，国家数据来自 Natural Earth（public domain）；复制代码/fixture 时保留 BSD 声明。TileJSON attribution 是空白，不应据此删除代码许可。[官方 README](https://github.com/maplibre/demotiles)、[BSD license](https://github.com/maplibre/demotiles/blob/gh-pages/LICENSE)、[Natural Earth terms](https://www.naturalearthdata.com/about/terms-of-use/)

**E2E 建议**：城市 demo 默认 OpenFreeMap，第二预设 VersaTiles，全球预设 MapLibre World。CI 使用少量已获许可的固定本地 fixture 或请求路由，公开网络源仅做单独 smoke；不能把公网 tile 延迟/周数据更新作为核心回归判断。不要使用仅限特定域名或非商业用途的第三方服务作为默认 production preset。

## 小而有代表性的城市场景（工程建议）

视角使用固定中心、相机高度、heading/pitch，不依赖外部 geocoder。建议 5 个按钮：

| 场景       | 中心经纬度       | 检验重点                                    |
| ---------- | ---------------- | ------------------------------------------- |
| 上海陆家嘴 | 121.505, 31.238  | 密集建筑、河岸、简体中文字形、倾斜场景。    |
| 东京新宿   | 139.700, 35.690  | 密集铁路/道路、日文、symbol collision。     |
| 纽约曼哈顿 | -73.986, 40.748  | 道路网、POI 密度、建筑轮廓。                |
| 巴黎市中心 | 2.350, 48.856    | 河流、复杂路网、重音字母、zoom transition。 |
| 旧金山     | -122.419, 37.775 | 倾斜视角与地形贴附（仅配置 terrain 时）。   |

最小额外交互：源 preset 下拉框、场景按钮、复位视角、加载状态、请求失败提示、可选性能小面板。换 preset 应保留视角，全球专用 preset 可设置一次合适的初始高度；无需在演示页加入复杂控制台或新的业务状态框架。

## 全球来源扩展核查（2026-09-30）

用户进一步要求 demo 来源全部覆盖全球。可以核实 **8 家不同运营方**：OpenFreeMap、VersaTiles、MapLibre、OSMF、BKG、Waymorphic、Maptoolkit、OpenStreetMap US。其中 MapLibre World 仅全球 z0–6 概览；Maptoolkit 和 OSM US 带用途限制，不能把全部来源描述为无限制生产服务。不同样式、同运营方的不同 schema 均不增加提供方数量。

2026-10-04源码复核：demo实际提供11个来源预设、10个城市/区域入口和12个固定压力视角，包括南美、澳洲、非洲、日期变更线与15m建筑白模；Cesium原生FPS始终开启。同日综合用例已经逐一核对全部12个压力预设的UI、相机、对应地区请求和实际绘制；另有七家来源、八个区域的实网验证，详见下方洲际验证记录。Maptoolkit仅做资源核验。离线预设链不代表真实城市吞吐，实网样本也不构成每家来源所有全球区域长期可用的保证。

本轮 GET 携带真实研究标识的 User-Agent，并以 `Origin: http://localhost:5173` 核查 CORS；涉及要求 Referer 的服务同时设置 localhost Referer。表内 HTTP 200、资源字节数是当天单个资源的实测，不能替代浏览器整图测试和长期可用性保证。下表补充前文 3 家；公开 MVT 元数据的 `vector_layers` 已解析，未从域名或文件扩展名猜测 schema。

| 运营方 / 建议预设                                 | 官方入口、schema、覆盖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 样式适配与实际限制                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **OSMF / Shortbread Colorful**                    | [官方 demo](https://vector.openstreetmap.org/demo/) 实际引用 [Colorful style](https://vector.openstreetmap.org/styles/shortbread/colorful.json)；[TileJSON](https://vector.openstreetmap.org/shortbread_v1/tilejson.json) 返回 `https://vector.openstreetmap.org/shortbread_v1/{z}/{x}/{y}.mvt`，全球 z0–14，Shortbread v1。                                                                                                                                                                                           | `background/fill/line/symbol`，无 hillshade/raster-dem；sprite 是带 id 的数组。另 SVWD03 使用系统字体且没有 glyphs URL，Colorful 的 PBF glyphs 更适合本库。数据 attribution 为 OpenStreetMap contributors；best effort、禁止 bulk/offline 抓取、必须有效浏览器 Referer/UA、遵循服务缓存响应，禁止 no-cache。版本切换窗口较短，不应写死瓦片版本。[官方使用政策](https://operations.osmfoundation.org/policies/vector/)                                                                                                                                                                                                                                                           |
| **BKG / basemap.world Farbe**                     | [官方全球产品](https://basemap.de/produkte-und-dienste/web-vektor-world/)、[完整 style](https://sgx.geodatenzentrum.de/gdz_basemapworld_vektor/styles/bm_web_wld_col.json)。`smarttiles_wld` 的 [TileJSON](https://sgx.geodatenzentrum.de/gdz_basemapworld_vektor/tiles/v1/bm_web_wld_3857/bm_web_wld_3857.json)：OpenMapTiles 风格 schema，全球除德国 z0–14；`smarttiles_de` 的 [TileJSON](https://sgx.geodatenzentrum.de/gdz_basemapde_vektor/tiles/v2/bm_web_de_3857/bm_web_de_3857.json)：德国官方 schema，z0–15。 | 必须保留两个 vector 源才能真正覆盖全球。当前 `background/circle/fill/fill-extrusion/line/symbol`，无地形源；完整 style 739,656 bytes，适合复杂样式/双源压力验证。服务 CC BY 4.0，德国数据库 CC BY 4.0 或 DL-DE BY 2.0，国外数据库 ODbL 1.0。公开图应显示 BKG + CC BY 链接及 GeoBasis-DE、OSM、OpenMapTiles，修改时注明变化；上游 style 的短 attribution 不包含全部必需信用，demo 应补全。[BKG 完整许可与来源说明](https://gdz.bkg.bund.de/index.php/default/gdz-basemapworld-vektor-gdz-basemapworld-vektor.html)、[专属 basemap.world 许可 PDF](https://sg.geodatenzentrum.de/web_public/gdz/lizenz/deu/Nutzungsbedingungen_basemapworld.pdf)                                  |
| **Waymorphic / Positron**                         | [运营方官网](https://waymorphic.com/)、[Positron style](https://tiles.waymorphic.com/styles/positron)、[TileJSON](https://tiles.waymorphic.com/planet)。OpenMapTiles，全球 z0–14；实测快照 `planet_20260913_164504_pt`。                                                                                                                                                                                                                                                                                               | Positron 当前只有 `background/fill/line/symbol` 图层，但声明一个未被图层使用的 raster source；Liberty 有实际 raster 图层。纯 MVT 预设应明确使用自有基础 cartography，不能自动过滤完整上游 style。官网允许个人、商业及公共部门，无 key；要求保留 style attribution（Waymorphic、OSM、OpenMapTiles），禁止整星球抓取，无 SLA。[官方 fair use](https://waymorphic.com/#fair-use)                                                                                                                                                                                                                                                                                                   |
| **Maptoolkit / 自有简洁 vector style**            | [官方服务](https://www.maptoolkit.org/)、[真实 TileJSON](https://tiles.maptoolkit.org/mtk.json) 返回 `https://tiles.maptoolkit.org/v28092026/mtk/{z}/{x}/{y}.mvt`，全球 z0–15。独有 schema：`admin/building/housenum_label/landuse/natural/place_label/poi_label/road/road_label/water/water_label`；[官方 schema 文档](https://docs.maptoolkit.org/vector-tiles/schema-reference/)。                                                                                                                                  | 当前 Light 也有 raster-dem + hillshade；Street 还包含 raster，均不能直接作为纯 Primitive preset。可明确维护一个仅 vector 图层的定制样式，使用官方 tiles/fonts/sprites，保留适用版权与许可。Community 适用于符合资格的开源/非商用途或收入低于 €1M 且员工少于 10 FTE 的组织；正式条款有专业用途要求。禁止 bulk/offline、固定媒体输出、后端批量处理及再包装服务。样式可修改/自托管，但引用只能指向其官方服务，不能改用别家的 tile/glyph/sprite。**必须展示至少 24 CSS px 的官方 logo，以及右下角 Maptoolkit copyright / OSM 两个活动链接**，单行 credit 不够。[正式条款 §§4,7,8,11](https://www.maptoolkit.org/tos/)、[attribution 文档](https://docs.maptoolkit.org/attribution/) |
| **OpenStreetMap US / 自有 OpenMapTiles 基础地图** | [官方新服务](https://tiles.openstreetmap.us/)、[OpenMapTiles 产品](https://tiles.openstreetmap.us/vector/openmaptiles/)、[TileJSON](https://tiles.openstreetmap.us/vector/openmaptiles.json) 返回 `https://tiles.openstreetmap.us/vector/openmaptiles/{z}/{x}/{y}.mvt`，全球 z0–14，OpenMapTiles 3.16.0。同运营方的 Sourdough 是第二 schema，不能算第 9 家。                                                                                                                                                           | 官方无纯 vector 成品 style，建议用本项目明确维护的 OpenMapTiles 基础 cartography。PBF glyphs 为 `https://tiles.openstreetmap.us/fonts/{fontstack}/{range}.pbf`，无需 sprite 即可做基础标签。Loopback Development Tier 和匿名 Starter Tier 免 key；Starter 限量、仅非营收用途，营收/更高量需书面许可。显示 `Tiles by OSM US` 链接及 OSM/OpenMapTiles credit；遵循 Origin/Referer/UA、缓存与 429，禁止 bulk/offline。[2025 年正式公开说明](https://openstreetmap.us/news/2025/09/tileservice-general-availability/)、[现行 policy](https://tiles.openstreetmap.us/usage-policy/)                                                                                                  |

### 新来源资源实测

London 样本坐标为 `12/2048/1362`；Tokyo 为 `12/3646/1612`；德国独立源样本为 `12/2185/1343`。下列每行均 HTTP 200；`localhost` 表示响应精确回显 `http://localhost:5173`，不是缺失 CORS。

| 来源       | Style / TileJSON                                                          | MVT 样本                                           | 字体与 sprite                                                                                                                                           | CORS                                           |
| ---------- | ------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| OSMF       | Colorful 355,621 B / TileJSON 8,127 B                                     | London 189,474 B                                   | `styles/shortbread/fonts/noto_sans_regular/0-255.pbf` 83,533 B；`styles/shortbread/sprites/basics/sprites.json` 9,683 B / `.png` 79,640 B               | MVT/TileJSON `*`，style/glyph/sprite localhost |
| BKG        | World style 739,656 B；world TileJSON 21,984 B；Germany TileJSON 14,385 B | London 122,390 B；Tokyo 52,355 B；Germany 45,400 B | `gdz_basemapde_vektor/fonts/v2/Roboto%20Regular/0-255.pbf` 73,990 B；`gdz_basemapde_vektor/sprites/v2/bm_web_col_sprite.json` 9,166 B / `.png` 28,937 B | localhost（无 Origin 请求也曾返回 `*`）        |
| Waymorphic | Positron 25,149 B / TileJSON 25,244 B                                     | London 157,370 B；Tokyo 52,390 B                   | `fonts/Noto%20Sans%20Regular/0-255.pbf` 76,580 B；`sprites/ofm_f384/ofm.json` 27,737 B / `.png` 49,454 B                                                | `*`                                            |
| Maptoolkit | Light 117,070 B（含不支持的地形源）/ mtk TileJSON 6,375 B                 | London 180,278 B                                   | `fonts.maptoolkit.org/Noto%20Sans%20Regular/0-255.pbf` 76,580 B；`icons.maptoolkit.org/sprite.json` 11,410 B / `.png` 32,260 B                          | `*`                                            |
| OSM US     | OpenMapTiles TileJSON 138,253 B                                           | London 132,389 B；Tokyo 51,723 B                   | `fonts/Noto%20Sans%20Regular/0-255.pbf` 83,504 B；基础地图可不使用 sprite                                                                               | localhost                                      |

BKG sprite PNG 首次遇到 SSL EOF，随后同 URL 返回 200；这只是本次网络观测，不能添加来源自动降级逻辑。所有可变 TileJSON 都应保留官方 URL，不能将上表测得的快照名称直接写进固定 demo 配置。

### 定制 style 的最小范围

**工程建议**：为 Waymorphic 和 OSM US 共用一个明确命名的 OpenMapTiles 基础地图工厂：背景、landcover/landuse、water/waterway、transportation 道路、building 轮廓或挤出、place 标签；各 preset 传入自己的 TileJSON、glyphs 和完整 credit。只声明实际使用的 vector source，支持的图层固定写出。不要下载完整上游样式再运行时过滤，也不要把 `transportation` 名称套给其它 schema。

Maptoolkit 是独有 schema，需单独的小样式定义。实测 TileJSON 字段：`water.type/crossing/intermittent`、`road.type/subtype/layer`、`landuse.type/subtype`、`natural.type/subtype`、`building.height/min_height/extrude`、`place_label.name/name_zh/name_en/rank/type`。water/road 混合面与线，应按 `geometry-type` 明确分层。基础 preset 可仅有背景、自然/土地利用面、水面/水线、道路、建筑和地点标签；不必引入 DEM、bathymetry、复杂 legend。由工程明确维护这种精简地图，UI 标明定制 vector 风格，并保留 §11 样式适用许可；不能宣称与 Maptoolkit 完整 Light/Street 等价。

### 排除、镜像与区域附录

- **Geofabrik**：官方商业 tile 服务要求客户自己的 32 字符 API key。[服务政策](https://www.geofabrik.de/maps/vectortiles.html)。[官方 demo style](https://tools.geofabrik.de/map/styles/versatiles_colorful.json) HTTP 200，但它的 tile template 带已配置的 demo key；不能将该 key 拷进本项目、不能把它算作公开免密钥提供方。区域下载包是 ODbL，与免密钥全球托管不是同一许可。[官方下载说明](https://blog.geofabrik.de/index.php/2023/03/30/experimental-vector-tiles-on-download-server/)
- **CARTO / MapTiler / Protomaps**：CARTO 当前官方 vector URL 明确要求 `?key=YOUR_KEY`；旧 URL 能 HTTP 200 也不证明获得免 key 使用许可。[CARTO 官方 Basemaps](https://www.carto.com/basemaps/)。不要拷贝商业提供方网页演示中的 key，或把公开 PMTiles 文件强称为本库已支持的 XYZ MVT。
- **Esri ArcGIS 旧公共端点**：`basemaps.arcgis.com/.../OpenStreetMap_v2/VectorTileServer/resources/styles/root.json` HTTP 200 / CORS `*`，776,106 B；源为 ArcGIS REST metadata，不是标准 TileJSON，瓦片路径 `tile/{z}/{y}/{x}.pbf`。当前 Location Platform 官方支持通路要求 access token。[Esri basemap usage](https://developers.arcgis.com/documentation/mapping-and-location-services/mapping/basemaps/basemap-usage-styles/)。尚未核得这些旧端点供第三方 Primitive 扩展库无限制免密钥使用的许可，因此不计入已核实全球预设，并移除旧端点的三项联网 E2E；可访问性不能替代许可证据。
- **LFMaps**：[官网](https://lfmaps.fr/en/) 明确无 key、商业允许、禁止 bulk；[Bright style](https://data.lfmaps.fr/styles/bright)、[TileJSON](https://data.lfmaps.fr/planet)、London tile/font/sprite 全部 200 / CORS `*`。快照 `20260218_001001_pt`，MVT 156,208 B，style 48,685 B。其官网明确由 OpenFreeMap 提供，TileJSON 名称也为 OpenFreeMap，虽然使用自家 host，不能作为独立数据生产来源凑数量。
- **OpenHistoricalMap**：[官方样式仓库](https://github.com/OpenHistoricalMap/map-styles)可读，真实 main style 包含 raster hillshade、自然地球 staging tile 源及历史日期规则。[版权页](https://www.openhistoricalmap.org/copyright)规定多数数据/样式 CC0，但个别 feature 有附加许可。本次官网 style 和生产 MVT 样本均 403，未证明浏览器可用，不能作为已验证的全球 preset。
- **TrailSplits**：[官方 API](https://trailsplits.com/api)明确免费无 key，全球 basemap 以 PMTiles 提供，非商业/科研用途；本库当前 XYZ 范围不应通过自动后备转换引入 PMTiles。它的全球 contour/POI/trail XYZ 是专题覆盖，不应冒充完整全球 basemap。
- **区域来源，只做研究附录**：Swiss [当前 lightbasemap style](https://vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json) 200、100,415 B，`base/relief` 两 vector 源、仅 background/fill/line/symbol，瑞士/列支敦士登为主要覆盖。[官方文档](https://docs.geo.admin.ch/visualize-data/vector-tiles.html)。Bayern [Standard style](https://vtod1.bayernwolke.de/styles/by_style_standard.json) 200 / `*`、185,573 B，两个 vector 源，有 fill-extrusion/circle；官方提供开放数据使用并要求信用。[官方产品](https://www.digitalisierung.bayern.de/produkte/karten/webvektor.html)。Austria [真实 style](https://maps.wien.gv.at/basemapv/bmapv/3857/resources/styles/root.json) 200 / `*`、264,244 B，bounds `[8.8587,45.7823,17.1608,49.5752]`，ArcGIS schema；相对源/字体/sprite 需正确解析。[官方 basemap.at](https://basemap.at/)。GSI optimal-bvmap 目前主要分发 PMTiles，旧 XYZ 发布已计划结束；不是全球来源。[GSI 官方仓库](https://github.com/gsi-cyberjapan/optimal_bvmap)。以上及 PDOK 荷兰区域服务均不进入用户要求的全球 demo 预设。

### 已落地的全球 demo 预设与建筑白模

`src/demo-config.ts` 保留原有 source id 与 `cityPresets`，现有 **11 个预设、8 家全球运营方**。新增 `osm`、`basemap-world` 使用完整官方样式；`waymorphic`、`osm-us`、`maptoolkit` 使用 `src/styles/` 下明确维护的简洁 JSON，代码没有自动删除不支持图层的逻辑。每个来源提供 `provider`、`description`、`usage`，供界面显示覆盖与用途限制。Maptoolkit credit 含官方 logo，HTML 明确规定 24px 高度和活动版权链接；界面应始终在地图上显示该 credit。

新增 `buildings` 预设仍属于 OpenFreeMap，不计作第 9 家。它只声明 OpenFreeMap vector source，无 glyph/sprite/DEM 请求；白色 `fill-extrusion` 直接读取 `building.render_height` / `building.render_min_height`，保留水面、地面和浅灰道路用于定位。2026-09-30 使用当前 `/planet` TileJSON 取得纽约曼哈顿 z14 `4824/6157` 瓦片，HTTP 200、686,362 bytes；用仓库实际安装的 `@mapbox/vector-tile` 与 `pbf` 解码得到 **1,488 个 building features**，样本真实含 `render_height` 和 `render_min_height`，没有凭建筑层名称猜测高度字段。

建筑白模用于 15m / 60m / 250m 等超低高度视角观察瓦片接缝、地表/建筑深度冲突、临近平面与抬头透视；相机位置需要放在实际道路/开放空间，地面相机高度与远处建筑高度不是同一参数。高负载城市、跨日期变更线、全球低缩放等场景由独立场景预设管理。一般来源切换保留相机位置；世界概览切到全球视图，压力场景使用各自的来源和相机预设。

真实低空浏览器回归还核对了粗级数据：对应地段的 z13 building 是无高度属性的合并面，z14 才含逐建筑高度。白模样式只显示具有正数 `render_height` 的建筑，避免把合并面当作零高度建筑底板；不以默认楼高替代缺失数据。库中的旧地表覆盖与新的建筑图层也必须按实际图层所有权交接，旧水面不能代表新建筑已经有覆盖。

曼哈顿相机另用当日[官方 TileJSON](https://tiles.openfreemap.org/planet) 指向的[金融区 z14/4823/6160 MVT](https://tiles.openfreemap.org/planet/20260927_080001_pt/14/4823/6160.pbf) 核验；上面的 Midtown 样本不覆盖这个相机点。该瓦片 HTTP 200、549,965 bytes，含 1,421 个建筑。对实际多环建筑和道路几何作局部米制投影，选得 Broadway 中心点 `(-74.01192337274551, 40.70752701473173)`、朝向约 32°：点在所有建筑轮廓之外，距最近建筑约 14.11m，独立道路名称层确认 Broadway 及约 31.96° 方向。15m 与 60m 高度、俯角 −12° 的中心射线在这个瓦片内不与建筑相交。这是根据几何计算的局部选址结果，不保证整个视野无遮挡；侧面建筑正是低空展示的一部分。原相机点也在建筑外，但距轮廓约 4.89m，原 35° 朝向在 60m 高度时约 71m 前就遇到一个高 92m 的建筑，故调整到道路中心。

四个本地 JSON 均通过当前安装的 MapLibre `validateStyleMin`；目标 ESLint 和完整 `pnpm lint:tsc` 已通过。2026-10-01 浏览器联网回归已通过 OpenFreeMap、VersaTiles、OSMF、BKG、Waymorphic、OSM US 与 MapLibre World 七家来源，以及真实 OpenFreeMap 曼哈顿 60m / 15m 建筑白模。Maptoolkit 禁止固定媒体输出，仅进行前述资源核验，不加入截图/离线 fixture 抓取。

### 2026-10-04 的洲际绘制与预设链验证

复用现有综合 E2E，案例数量保持不变。当前版本独占硬件离线 **6 通过**：其中一个 demo 控件用例依次选择全部 **12 个压力预设**，独立核对 Native 相机经纬度、高度、heading、pitch、实际 postRender、对应来源与地区的瓦片请求，以及 canvas 上来源特有的颜色。12 组地面采样 coverage 均为 1，Globe/FPS 始终开启；见[预设链摘要](../../node_modules/.cache/playwright/test-results/sky-roundtrip-offline-summary.json)。数据使用确定性 MVT，证明 UI→相机→来源→绘制链路，不代表各城市真实建筑密度或吞吐。

当前版本真实源硬件 E2E **8 通过、316.6 秒、0 失败/跳过/重试后通过**，包含七家来源的八个区域，以及曼哈顿 60m/15m 白模。每个来源要求目标地区成功的 MVT 响应，并通过公开 setStyle 移除源图层、清空来源驻留后与同一背景比较，再恢复原样式核对地图重新出现；见[真实来源摘要](../../node_modules/.cache/playwright/test-results/sky-roundtrip-live-summary.json)。

| 来源 | 实际区域 | 验证边界 |
| --- | --- | --- |
| OpenFreeMap | London；另有 Manhattan 60m/15m 白模 | 完整 Liberty 与实际建筑挤出 |
| VersaTiles | Cape Town | 完整官方 Colorful，包含原始 sky/projection |
| OSMF | Tokyo | 官方 Shortbread 数据及样式 |
| BKG | Berlin、London | 分别取得德国与世界源覆盖目标位置的 MVT |
| Waymorphic | Sydney | 本项目维护的简洁 vector 样式 |
| OSM US | São Paulo | 本项目维护的简洁 vector 样式 |
| MapLibre | World overview | 全球低缩放概览，不能代表城市细节 |

增强的真实源用例先发现 VersaTiles 的 setStyle 抛出 `Unimplemented: setSky`。原始样式已含 sky，库的快照白名单遗漏它，使 diff 误报为新增 sky；这与非洲瓦片 schema 无关。既有换源综合单测使用捕获的根配置先 RED，再验证换源、仅背景、恢复和真正不支持的 sky 修改仍提前拒绝。快照现在保留原根声明，以 live sources/layers 覆写；见[原始失败与离线回归](../../node_modules/.cache/playwright/test-results/sky-roundtrip-red-evidence.json)。

这批验证覆盖六洲的代表性位置，仍不保证每家来源在所有地区的实时可用性；12 个真实高负载压力视角的吞吐也尚未逐项量化。Maptoolkit 的资源核验范围保持原有边界。

### 上游道路盾牌过滤器警告（2026-10-01）

原始 OpenFreeMap Liberty 样式的 `highway-shield-non-us`、`highway-shield-us-interstate`、`road_shield_us` 过滤器，先执行 `['<=', ['get', 'ref_length'], 6]`，随后才判断道路类别。真实 London `12/2046/1361` 的 Outer Circle 线要素与 New York `14/4823/6160` 的 motorway junction 点要素均缺少 `ref_length`。对浏览器 trace 保留的原始样式和 MVT，直接调用已安装的官方 `@maplibre/maplibre-gl-style-spec` 26.4.2 / 26.4.4 的 `featureFilter`，不经过本库，也会返回 false 并报告 `Expected value to be of type number, but found null instead`。`validateStyleMin` 则返回空错误列表：这是数据触发的运行时警告。

官方实现的 `feature_filter/index.ts` 调用编译表达式，`expression/index.ts` 捕获运行时类型错误、输出警告并返回过滤器默认值 false。联网回归仅容许上述三个图层及完整消息相符的已复现警告，全部原始消息保留在测试附件中；未知警告、确定性 fixture 的任何此类警告仍使测试失败。本库与 demo 不修改上游过滤器，也不补造缺失属性。
