# MapLibre 与 Cesium 渲染调度源码研究

核实时间：2026-10-13（Asia/Shanghai）。项目检查基线：`4f9032bb7239fd838ffec1199b37b537623055cc`。本记录区分源码事实与待实测的优化假设；没有把源码结构当成已经测得的耗时或收益。

## 版本与证据范围

通过 npm registry 的 `npm view <package> version dist-tags --json` 和官方仓库的 `git ls-remote` 实时核实，随后下载固定 commit 的官方源文件比较。研究期间主任务将 MapLibre 开发参考依赖从 6.12.0 更新为 6.14.0；Cesium 原本就是 1.146.0。MapLibre 不是本库的生产渲染后端，因此升级参考依赖本身不能解释本库帧时间变化。

| 项目 | npm latest / 对应 release commit | 当时官方 main commit |
| --- | --- | --- |
| MapLibre GL JS | `6.14.0` / `72927301b7594536630d896c45c64c4d0d4c587f` | `6d05e81138c952313cf228896693b54c2e6593dd` |
| Cesium | `1.146.0` / `b8d3a36fe98a3e432eb89253c95d5f20e605e0f1` | `201f20f232f7fb046a43568fc51324acb4a846cc` |

版本来源：[MapLibre registry](https://registry.npmjs.org/maplibre-gl/latest)、[MapLibre v6.14.0](https://github.com/maplibre/maplibre-gl-js/releases/tag/v6.14.0)、[Cesium registry](https://registry.npmjs.org/cesium/latest)、[Cesium 1.146](https://github.com/CesiumGS/cesium/releases/tag/1.146)。Cesium tag 是 annotated tag，其 tag object 为 `b90bf5fa30c8f573072181165c9462d987e26580`，上表使用 peeled commit。

main 与 release 必须分开：检查的 Cesium `Primitive.js`、`DrawCommand.js`、`renderBufferPolylineCollection.js` 完全相同；`Scene.js` 和 `BufferPrimitiveCollection.js` 仅出现 `Object` → `object` 的 JSDoc 改动。MapLibre main 的 `pauseable_placement.ts`、`placement.ts` 与 release 相同，`map.ts` 的差异主要涉及注册平面投影初始化和 terrain 的坐标助手，没有改变本文的 `_render` 调度逻辑。不能把 main 当成另一份已经发布的性能修复。[Cesium main](https://github.com/CesiumGS/cesium/tree/201f20f232f7fb046a43568fc51324acb4a846cc)、[MapLibre main](https://github.com/maplibre/maplibre-gl-js/tree/6d05e81138c952313cf228896693b54c2e6593dd)

另外，MapLibre [v6.12.0](https://github.com/maplibre/maplibre-gl-js/tree/7976a989280508d763265f95f523e945d04d87b0) → 6.14.0 的 `placement.ts`、`pauseable_placement.ts` 文件完全相同，`style.ts` 中 `_placementInputsChanged` 与 `_updatePlacement` 算法也没有变化。Context7 的 MapLibre 目录仍列出 v5.19.0，故其内容只作导航；所有版本敏感结论均回到固定 commit 源码。Cesium Context7 查询发生传输错误，直接读取官方源码完成核实。

## 1. 空闲绘制与 CPU 更新是两件事

### 极高 zoom 的图层范围

zoom25 实测 Native 所有图层隐藏、MapLibre 仍绘制的共同原因是本项目 `StyleLayer` 构造时默认 `maxzoom=24`。上游6.14构造直接保存 `layer.minzoom/maxzoom`，未设置的值保留 `undefined`，因此不触发最大 zoom 隐藏条件。[上游 StyleLayer](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/style/style_layer.ts#L122-L124)

本项目已保留未设置状态，序列化明确保留显式0/24，并让现有样式 diff 的“移除范围”恢复为未设置。复用原范围回归验证zoom24/25在移除上限后可见，以及显式24通过serialize→load仍在24隐藏；相关style/worker/lifecycle共24项通过。没有把来源 canonical maxzoom 或相机 zoom 上限与图层可见范围混为一谈。极限 fixture 还需避免 Cesium 默认碰撞保护把亚米相机抬高；该保护属于相机输入条件，不作为修改生产 `cameraZoom` 的依据。

MapLibre `_render` 分别控制 style/source/placement 脏状态；绘制结束后只有剩余脏状态、显式持续 repaint 或 render-to-texture 后续帧才安排下一次绘制。`triggerRepaint` 通过一个 `_frameRequest` 合并多次请求。它没有把每次 opacity 动画都视为重新选择瓦片或重建几何。[MapLibre map.ts](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/ui/map.ts#L4385-L4511)、[triggerRepaint](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/ui/map.ts#L4587-L4604)

Cesium `requestRenderMode` 仍运行 `preUpdate`、`prePassesUpdate`、`postUpdate`、`postPassesUpdate` 和 `afterRender`；仅真正绘制时运行 `preRender`/`postRender`，且只有此时递增 `frameNumber`。时间变化仍可触发绘制，默认 `maximumRenderTimeChange=0` 不能等同于“静止相机就绝不渲染”。`afterRender` 回调返回 `true` 会请求后续帧。[Cesium Scene.render](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/Scene.js#L4629-L4723)、[afterRender drain](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/Scene.js#L4193-L4210)、[maximumRenderTimeChange](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/Scene.js#L683-L704)

仓库 [scene-frame-budget.ts](../packages/cesium-vector-tileset/src/render/scene/scene-frame-budget.ts) 已按 `preUpdate` tick 共享预算，避免 idle tick 的相同 `frameNumber` 被误当成同一物理帧；[scene-render-wake.ts](../packages/cesium-vector-tileset/src/render/scene/scene-render-wake.ts) 已区分 runnable work 与 recency deadline，并用定时唤醒支持 demand render。这里不需要重新引入单独 RAF 循环。验证应分别记录 CPU update tick 数与实际 render 帧数；否则“无绘制”可能掩盖持续 CPU 工作。

## 2. 符号排布：上游也只发布完整结果

MapLibre 排布观察投影、world copies、碰撞设置和 model-view-projection 矩阵，矩阵无法表达的内容变化通过显式触发补充。普通 pauseable placement 每次给约 2ms；检查点在 tile/bucket part 边界，单个 part 仍可能超过 2ms。完整排布完成后才替换 `style.placement` 并更新 opacity；相机持续变化会使结果 stale，但不会每帧取消在途排布。已完成结果在 fade 区间保持 recent，缩放停止后可缩短 recency。[placement invalidation/commit](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/style/style.ts#L1910-L2000)、[pauseable placement](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/style/pauseable_placement.ts#L27-L121)、[recency](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/symbol/placement.ts#L1309-L1346)

仓库 [symbol-placement-pass.ts](../packages/cesium-vector-tileset/src/render/symbol/symbol-placement-pass.ts) 已使用冻结视图、代次 revision、完整 commit 和 recency；其 `advance` 按单个 symbol pair 检查预算，比上游 bucket-part 边界更细。场景的 current/prospective/handoff collision scope 属于本项目替换交接需求，不能简单用一个全局排布对象覆盖。当前不足没有证据指向“缺少 MapLibre 最新排布算法”。

MapLibre 将静态 layout 与动态位置/opacity 放在不同 vertex buffer，opacity 用每顶点 uint8 紧凑表示。仓库已经分离 `a_dynamic` 与 `a_opacity` 并直接上传；其 opacity 为 Float32Array。压缩 opacity 最多减少这一条流的字节量，不能视为整体几何或帧时间减少 75%。应先证明 opacity copy 占比，再考虑修改 Native attribute datatype、CPU owner、初始化与恢复路径。[MapLibre SymbolBuffers](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/data/bucket/symbol_bucket.ts#L100-L107)、[buffer upload](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/data/bucket/symbol_bucket.ts#L204-L219)、[仓库 symbol-gpu-resources.ts](../packages/cesium-vector-tileset/src/render/symbol/symbol-gpu-resources.ts)

## 3. 主要待实测机会：限制不可中断的冷资源单元

Cesium `Primitive.update` 即使 `asynchronous:true`，Worker 返回后的 `createVertexArray` 仍在主线程一次遍历全部 combined geometry 并分配/上传 VA。`asynchronous:false` 还会同次运行 `loadSynchronous`：clone 每个 Geometry、combineGeometry、上传。Worker 异步只解决部分 CPU 准备，不能自动解决首帧 GPU 上传峰值。[Primitive.update](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/Primitive.js#L2084-L2146)、[loadSynchronous](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/Primitive.js#L1313-L1373)、[createVertexArray](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/Primitive.js#L1626-L1685)

仓库 [geometry-primitive.ts](../packages/cesium-vector-tileset/src/render/geometry/geometry-primitive.ts) 已有 Worker 准备、line 分步上传与安全边界接管。更值得检查的是 [symbol-gpu-resources.ts](../packages/cesium-vector-tileset/src/render/symbol/symbol-gpu-resources.ts)：`SymbolGpuResources` 使用 `asynchronous:false`，`mergeSymbolHalves` 按 tile/layer/material 合并且没有顶点数量或上传字节上限。[scene-collections.ts](../packages/cesium-vector-tileset/src/render/scene/scene-collections.ts) 能在 child 间控制准入，不能暂停一次 Native child update。密集符号瓦片因此可能使单个已准入单元跨越帧预算。

BufferPoint/BufferPolygon 首次 update 也按整 collection 容量生成属性并分配/上传 buffer，没有内建 deadline。仓库已经按实际内容设容量，避免任意默认容量；但 [vector-tile-builder.ts](../packages/cesium-vector-tileset/src/render/vector/vector-tile-builder.ts) 的一个 layer/tile collection 仍可能很大。Buffer collection 的 CPU 填充 yield 与 Native 首次上传分片是不同边界。[point initial allocation/upload](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/renderBufferPointCollection.js#L97-L271)、[polygon initial allocation/upload](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/renderBufferPolygonCollection.js)

**建议，等待 profiler 印证：**先记录每次 cold child update 的 elapsed、vertex/index 数、上传字节和 owner kind。如果 P95/P99 的尖峰由少数大 symbol/Buffer collection 主导，再给 Native cold resource 单元设内容规模上限，按 layer 内原顺序分段。必须保留 symbol 的 `vertexStart` 地址、动态 owner、完整排布 commit 与 replacement handoff；不同样式图层不能为减少 draw call 合为不可拆批次。仅增加全局预算或将所有 Primitive 改成 `asynchronous:true`，没有解决上述边界。

## 4. DrawCommand 的稳定身份会影响 Native 派生缓存

Cesium DrawCommand setter 只在字段改变时置 `dirty=true`；`shallowClone` 即便传入已有 result 也无条件置 dirty 并重置 `lastDirtyTime`。`Scene.updateDerivedCommands` 在 dirty 时同步 pick/log-depth/HDR/shadow/OIT 等派生命令。这里的 dirty 分支并不意味着必定重新编译 shader，派生 shader 自身仍有缓存。[DrawCommand setters/clone](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Renderer/DrawCommand.js#L632-L666)、[Scene derived-command update](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/Scene.js#L1893-L1966)

仓库 [draw-command-replay.ts](../packages/cesium-vector-tileset/src/render/scene/draw-command-replay.ts) 已维护 replay 身份并按 Native 源字段变化同步；[draw-commands.ts](../packages/cesium-vector-tileset/src/render/scene/draw-commands.ts) 的普通 paint/extrusion derivative 也有缓存。保留这些实现比每帧重做 clone 更符合 Native 生命周期。

**明确且局部的待实测机会：**`extrusionIdCommand` 每次调用都 `shallowClone(source, cached)`，然后立即 `scene.updateDerivedCommands(command)`。触发条件是有透明 extrusion compositor，且实际 `passes.postProcess` 需要 selected-ID rendering；普通无后处理场景不会进入。可以考虑复用稳定 replay，只有源字段或最终 ID-pass 状态变化才使其 dirty。先在含 selected feature 后处理的场景测该调用及 Native 派生分支占比；没有该场景的 profile，不能据此解释普通拖动性能。

Buffer renderers 自己也缓存 command。blend pass 改变时会销毁/重建其 render state 和 command；不能直接把 Native 源 command 的 pass 改成样式顺序所需的 pass，否则下次 Native update 会误判 blend transition。仓库已经采用独立 paint derivative，属于必须保留的正确设计。[Buffer renderer command lifecycle](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/renderBufferPointCollection.js#L305-L371)

## 5. BufferCollection 已有优化与剩余成本

上游 Buffer collection 用固定容量 ArrayBuffer、可复用 flyweight、一个连续 dirty range；显式提供 boundingVolume 关闭自动重算。仓库已复用 BufferPoint/BufferPolygon scratch，按实际数量设 capacity，并提供预计算包围球。这里不应再以“缺少 BufferCollection 优化”提出重复改造。[BufferPrimitiveCollection capacity/flyweight](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/BufferPrimitiveCollection.js#L743-L777)、[bounding volume policy](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/BufferPrimitiveCollection.js#L148-L159)、[仓库 builder](../packages/cesium-vector-tileset/src/render/vector/vector-tile-builder.ts)

如果只有最前与最后两个 feature 变脏，dirty range 仍覆盖两者之间的所有元素；CPU 属性生成会跳过 clean feature，但 GPU range copy 覆盖整个跨度。`PROPERTIES` 分支上传所有 attribute locations，`GEOMETRY` 分支仅上传 position。所以“不调用未变化的 setMaterial”真实有效；仓库 [vector-paint-updater.ts](../packages/cesium-vector-tileset/src/render/vector/vector-paint-updater.ts) 已比较打包颜色/尺寸再写入。进一步收益需来自减少实际更新跨度或规模，不能假定 Native 支持任意多个脏区间。[dirty range merge](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/BufferPrimitiveCollection.js#L828-L848)、[point range upload](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/renderBufferPointCollection.js#L272-L304)

BufferPolyline 是实验 API，只支持 OPAQUE 或 TRANSLUCENT，固定容量不可原地扩容；批量 setPositions 只能替换相同顶点总数。仓库线轨道还有 dash、pattern、offset、shader clipping、分层排序和分步上传需求，不能依据名称相似直接换成 BufferPolyline。应先列出具体缺失语义，再做针对性原型。[BufferPolylineCollection](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/BufferPolylineCollection.js#L27-L79)、[setPositions contract](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/BufferPolylineCollection.js#L183-L194)

## 优先级与验证

| 候选 | 当前证据 | 先验证什么 | 合理验收 |
| --- | --- | --- | --- |
| 限制 symbol/Buffer 冷资源单元规模 | 源码证明一次 update 不可中断；未证明实际占比 | 冷启动、快速缩放时各 owner 的单次 update/P95/P99 | 减少超过预算的 Native update；图层叠放、placement handoff 不回归 |
| 稳定 extrusion selected-ID command | 已定位无条件 shallowClone→dirty；触发场景受限 | 透明建筑加 feature-selection 后处理 | 未变化帧减少派生更新；选中、取消选中、拾取仍正确 |
| 紧凑 symbol opacity / 缩小动态上传范围 | 与上游 uint8 有表示差异；收益未知 | 实际 copy 字节、copy 调用及 elapsed | 总帧时间或峰值上传下降；不丢失初始化/ready/恢复最新状态 |
| 少做 idle CPU 更新 | 上游与项目均已有按需机制 | 实际 render 帧数、CPU tick 次数、recency timer wakes | 静止且无工作时无持续重排；Worker 回复、移除和交接能及时唤醒 |

研究阶段仅增加本记录；下面另记录主任务随后授权并实施的局部优化。

## 实测补充：固定属性过渡代次的枚举与活动值

主任务浏览器 profile 报告 `hasTransition` 自耗时约 36ms，调用方会多次检查 transition flags。项目 `Transitioning.hasTransition` 原先每次 `Object.keys(_values)` 并逐属性检查 `prior`；`possiblyEvaluate` 也逐次枚举同一代次的 own keys。

实施范围仅为 [properties.ts](../packages/cesium-vector-tileset/src/style/properties.ts) 的 `Transitionable.transitioned/untransitioned` 与 `Transitioning`：构建代次前填好 own property values，构造时缓存 own keys 与当时有 `prior` 的 value 引用。`possiblyEvaluate` 继续按 own keys 评估；`hasTransition` 只检查缓存引用的当前 `prior`，全部结束或 data-driven snap 后清空活动列表。过渡中 `prior` 只会清除，新 `prior` 由新代次构建，因此没有跨代次的失效策略。默认 property values 仍通过同一个 prototype 提供。

临时脚本 `node_modules/.cache/temp/comprehensive-audit/transition-benchmark.ts` 使用真实 `src/styles/osm-us.json` 的 10 个 `createStyleLayer` 实例与 `layer.hasTransition()`；对同一组对象交替替换原算法、只缓存键算法和实施算法，9 轮每算法各 100 万次调用，取中位数。创建/解析样式与准备过渡发生在计时之外。运行环境：Node `v24.14.0`；原始结果保存于同目录 `transition-benchmark.json`。

| 输入状态 | 原实现 | 只缓存键 | 缓存活动 value | 对原实现下降 |
| --- | --- | --- | --- | --- |
| 静止、无过渡 | 24.31ms | 18.94ms | 7.35ms | 69.8% |
| 3 个 line layer 延迟过渡 | 22.70ms | 17.70ms | 8.50ms | 62.6% |
| 上述过渡完成后 | 24.57ms | 19.89ms | 7.89ms | 67.9% |

活动值引用比只缓存键进一步减少属性查找与扫描，故采用活动值方案。这是该检查热点的 Node 微基准，不代表浏览器总帧时间或 FPS 的相同百分比改善；端到端收益由主任务的后续 browser profile 判断。没有修改 `style.ts` 的缓存/失效策略。

局部 eslint 已通过；现有 style-state-change 与 frozen-line-paint 共 9 个测试通过。复用冻结线绘制用例验证过渡结束标志，新增真实图层行为覆盖继承默认 width 的首次延迟过渡、中断后的递归插值、结束后新代次、data-driven snap 与恢复默认值，防止缓存掩盖活动过渡或改变 prototype 默认语义。

## 实测补充：真正的 globe 分支与倾斜相机

新增 [globe-render-comparison.spec.ts](../e2e/globe-render-comparison.spec.ts) 与独立 fixture，使用 MapLibre **6.14.0** 的公开 projection 配置。默认 `globe` 在 zoom 11→12 从 `vertical-perspective` 插值为 `mercator`；在城市 zoom 14，即使样式写 `globe`，实际 GPU 已是 Mercator。独立控制用例实测 linked shader 没有 `GLOBE` define、transform 的 `isGlobeRendering=false`。真正球面用例使用公开 `vertical-perspective`，四种图元的真实 draw 都具有 `GLOBE` define，实际 uniform/UBO 中 `u_projection_transition=1`，不是仅检查样式配置。[projection factory](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/geo/projection/projection_factory.ts)、[GlobeTransform](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/geo/projection/globe_transform.ts)、[globe shader](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/shaders/glsl/_projection_globe.vertex.glsl)

校准使用实际 `projectionMatrix` 与 `modelViewProjectionMatrix` 反解 camera forward/up，球面 cameraPosition 按 Native 赤道半径 6378137 转成 ECEF，统一 CSS/绘图 viewport 640×720、DPR 1、垂直 FOV 45°、center 0°/0°、bearing/roll 0、zoom 14。pitch 0/65 的实际相机位置误差为 0m，direction/up 误差约 2e-16；四个地面中心投影误差约 1e-10px。实际 Native 与 MapLibre Worker 图标锚点投影误差不超过 4e-11px；圆锚点在倾斜时误差 0.1955px，仍小于独立资格门槛 0.2px。只有经过资格检查的实际 framebuffer 才用于比较。

这明确采用**球面单位坐标到 WGS84 赤道半径的模型归一化**。MapLibre 高度 shader 常量为 6371008.8，Native 为 WGS84；没有声称两侧绝对物理地球模型一致。地面中心放在赤道，以控制地面模型差异；建筑侧面和有限面积仍可能受到椭球形状、浮点投影或瓦片量化影响。当前 fixture 的 terrain 为 MapLibre `null` 与 Native `EllipsoidTerrainProvider`，没有覆盖 DEM。上游 vertical-perspective 的 terrain 相机重新定位仍注明尚未完全支持，不能把本轮结果延伸到 DEM terrain。[vertical-perspective 相机矩阵、terrain 注释与 camera API](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/geo/projection/vertical_perspective_transform.ts)、[sphere radius 与 3D radial height](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/shaders/glsl/_projection_globe.vertex.glsl)

现有 `symbol-map-perspective` / `line-perspective` 覆盖 Columbus View 中真实倾斜相机和 MapLibre Mercator 透视；新增测试覆盖球面投影 shader、球面上的 map-aligned circle/symbol、建筑径向高度与球面投影深度。它没有穷举经纬度、相机角度或 terrain 组合。

### 已资格化的差异，尚未在本研究任务中修改生产实现

2026-10-13 的两次硬件复跑使用 `ANGLE (Intel, Vulkan 1.4.318 (Intel(R) Graphics (RKL GT1)), Intel open-source Mesa driver)`。RGBA 独占颜色 mask 在共同孤立 ROI 中完整容纳每个元素；宽/高由 mask 的各列/行最大覆盖累加，完整形状使用所有像素的绝对差。建筑使用蓝色轮廓 mask，隔离光照强度的实现差异。

| pitch 65° 的测量 | Native | MapLibre 6.14.0 | 结论 |
| --- | --- | --- | --- |
| 东西向线的屏幕厚度 | 1.663px | 5.224px | 同一真实相机下明显不同；必须先解决 style scale 定义再重测，不能假设倾斜地图线恒定屏幕宽度 |
| map/map 圆的宽×高 | 30.918×30.914px | 30.871×13.075px | Native 未产生 MapLibre 对应的 map-pitch 扁平形状；由主任务另派生产修复 |
| map/map opaque 图标的宽×高 | 19.067×7.557px | 27.549×10px | Worker anchor 已校准，尺寸差异仍存在；style zoom 与 camera-to-center 距离定义需要先统一 |
| 隔离建筑轮廓 | 没有超过本轮差异门槛 | 没有超过本轮差异门槛 | 将后置穿楼线从形状 fixture 中移出后，pitch65 建筑轮廓不再出现原先被 overdraw 制造的大差异 |
| 单独启用后置穿楼线时，建筑中心 RGB | 8,8,255 | 255,0,0 | 实际深度/绘制顺序语义不同；不能拿被线覆盖的建筑 mask 当作建筑尺寸错误 |

pitch0 控制也有小残差：线段长度相差 1px（厚度相差 0.184px）、建筑轮廓高度相差 2px、图标宽度相差 0.694px。这些严格比较会失败，但目前没有足够证据归因于生产几何错误；没有放宽门槛让它们变绿。特别是线的 mask 宽度对应**整段长度**，不等同于 stroke width。

诊断阶段复现命令：`rtk proxy env E2E_GPU=hardware pnpm exec playwright test e2e/globe-render-comparison.spec.ts --output=node_modules/.cache/playwright/comprehensive-audit/globe-camera-definition`。当时结果 **1 passed / 2 failed**；两项失败发生在所有相机、Worker、实际 GPU 分支资格检查通过之后的形状和深度比较。原始 JSON、PNG 与 trace 位于上述缓存目录；该阶段没有改生产渲染代码。后续获授权的实现与复测见下面的记录，不能把这个初始结果写成最终全绿。

### style zoom：误差来自高度策略覆盖光学中心尺度

上游 `getGlobeRadiusPixels(worldSize, centerLatitude)` 返回 `worldSize/(2π*cos(centerLatitude))`，`worldSize=512*2^zoom`；`VerticalPerspectiveTransform._calcMatrices` 以 `cameraToCenterDistance/globeRadiusPixels` 作为单位球上相机到地面 center 的斜距。`cameraToCenterDistance=H/(2*tan(fovY/2))` 是像素焦距。6.14.0 的 `calculateCameraOptionsFromTo` 也直接按这一斜距反解 zoom，完全没有按 camera pitch 乘补偿系数。[globe radius/latitude](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/geo/projection/globe_utils.ts)、[camera placement 与 inverse camera API](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/geo/projection/vertical_perspective_transform.ts)、[TransformHelper focal distance](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/geo/transform_helper.ts)

在本轮已归一化的赤道模型中，Native 的实际 canvas 中心 pick ray 与椭球交点给出距离 `d` 和中心纬度 `φ`，直接重建 `zoom = log2((H/(2*tan(fovY/2))) * 2π*a*cos(φ)/(512*d))`，其中 `a` 为声明的归一化半径 6378137。这使用实际 camera/ellipsoid/frustum，不依赖传入的 pitch 标签。实测：

| 实际相机 | camera height | camera→center 距离 | 交点/FOV 重建 zoom | covering.ts 相邻 pixel 测量 zoom | 当前 Native styleZoom |
| --- | --- | --- | --- | --- | --- |
| pitch0 | 4152.044483m | 4152.044483m | 14.000000000001 | 13.9999999940 | 14.0000000000 |
| pitch65 | 1755.847067m | 4152.044507m | 13.9999999916 | 13.9999999883 | 15.2416544531 |

因此，本轮不是 `covering.ts.cameraZoom` 的两条射线采样出了 15.24；该函数实际仍得到 14。`render-frame.ts` 为 SCENE3D 优先选择 `globeCameraScale`，后者以相机 nadir height 和相机纬度计算样式尺度，并把 height 作为 symbol camera-to-center distance，覆盖了已正确还原的光学 center scale。

需要产品层明确选择：MapLibre camera zoom 还是自由 Cesium 相机的 nadir-ground style reference。已有 `camera-focus.test.ts` 的 3D horizon 用例保持同一个 ECEF camera position 旋转方向，要求 style zoom 固定；本轮 MapLibre 用例则围绕固定 map center 旋转相机并保持 MapLibre zoom 固定，两者不能混作同一个不变量。如果要求对齐 MapLibre globe，正常 center ray 命中时应采用实际 optical focus distance / focus latitude 的定义，同时将对应斜距用于符号透视；horizon、相机 padding/off-center frustum、任意纬度的 WGS84→sphere 映射与 terrain elevation 必须单独规定。仅有本轮赤道实测，不能据此声称全纬度或未命中地面的相机已经精确一致。

相邻水平 pixel 地面分辨率本质上是局部投影 Jacobian；在当前 bearing/roll0 的赤道 fixture 中它与定义 zoom 一致，不意味着任意 bearing、roll、非中心 principal point 下都能替代上游 globe camera 定义。建议先用上游精确反解 API 验证正常 focus 的少量独立分支，再做针对性生产调整；不要把未知的椭球或 horizon 行为藏在经验 pitch 系数里。

### 获授权的修复：统一真实球面 optical focus

进一步完整阅读最新版 `VerticalPerspectiveTransform.unprojectScreenPoint` 确认：**globe miss 的规则也是可见地面 horizon，不是 Mercator 的 10000m 空中目标**。未命中时，先与实际 horizon clipping plane 求交；交点在相机背后或射线与平面平行时，按上游一颗球直径的射线点投影到该平面；再把平面内相对 horizon disk center 的方向径向归一化到 disk radius，得到最近的可见地平线点。`calculateCameraOptionsFromTo` 按实际 sea-level sphere target 的距离反解 zoom。[unprojectScreenPoint 与 camera inverse](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/geo/projection/vertical_perspective_transform.ts#L994-L1054)、[horizon disk 与 radial clamp](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/geo/projection/globe_utils.ts#L326-L356)

获授权后实现为单一 `globeCameraFocus`：正常 ray/ellipsoid hit 返回实际交点；miss 在 ellipsoid scaled space 中按上述单位球 horizon 构造，然后映回实际椭球。style zoom、符号 camera-to-center distance 与来源 ground range 共用这个真实海平面 focus。删除只按高度计算的 `globeCameraScale`、`CameraScale` 接口与 render-frame 中重复 `groundScale` 状态；没有保留新旧兼容分支。Columbus View 的 `columbusCameraFocus` 继续按 Mercator 最新 helper 定义处理其真正的平面 miss，两个投影的规则不会混用。

独立回归直接执行安装的 MapLibre 6.14 `VerticalPerspectiveTransform`：31.24° latitude、bearing45°、roll23°，按实际 cameraPosition/view-projection matrices 校准 Native sphere camera，pitch0/65 对比 style zoom 与 slant range；miss 用 `screenPointToLocation` 与 `calculateCameraOptionsFromTo` 作 oracle，覆盖前向 horizon plane 与 behind-plane 的两条代表性射线。修复前真实 orbit 用例得到 Native zoom15.2421 而 oracle14，修复后这些 globe oracle 全通过。

这证明单位球模型的算法一致性；WGS84 使用 scaled-space 的椭球扩展，不能称球面和椭球的绝对物理模型全域相同。padding/off-center camera、DEM terrain、inside-ellipsoid camera 尚未通过本轮独立 GPU parity 证明。自由 Native miss camera 的实际观看方向也不能直接由 MapLibre 只围绕 sea-level center 的公开 orbit camera 渲染；本轮 horizon fixture 使用公开 `Map.unproject` 验证该射线的 surface 规则，明确不声称自由 miss 相机的所有像素已与 MapLibre 同机位对齐。

### 高空飞行：10000m 虚拟距离污染 source LOD

主任务实际 demo 跨洲 flight 相机高度 **1624731.236m**，center ray miss 时旧 globe focus.zoom12.520795，对应约10000m虚拟距离；source producer 把它作为 ground center distance，实际 Mercator-normalized ground height 为0.05984155、centerDistance为0.00036841，height/distance=162.43，`acos(min(1,ratio))` 因而变成0，错误关闭 variable source detail。实际画面曾产生 **265087** 个 ideal tile；逐 tile loaded 事件的后续全量扫描放大了卡顿，来源距离污染是先行根因。

统一真实 horizon 后，相同原始相机 pose 的独立纯函数复算得到：focus.zoom **3.753007722**、实际 camera→surface 距离 **4836691.317m**、center **23.269989°/41.273067°/0m**；source ground height **0.05984155**、centerDistance **0.15856230**。完整两个 geographic z0 rectangle 的全世界地面授权实际仅得到 **64 个 z3 tile**，world/far desired zoom 都为3。没有 production tile-count cap，也没有按相机高度猜阈值。

source producer 不再从 globe focus.zoom 反算 10000m，而从真实 surface center 与实际 camera 的 Mercator-normalized ground coordinates 求 range。globe variable detail 的 gate 同步最新版 provider：**来源 covering zoom >4 时允许，与 pitch 无关**；<=4 的实际低倍率视图正常采用常量 detail。CV 继续保留其独立实际 ground-height 与 virtual center 规则。[globe source variable gate](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/geo/projection/globe_covering_tiles_details_provider.ts#L114-L116)、[covering camera/center distances](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/geo/projection/covering_tiles.ts#L294-L310)

相关 5 个 scene 测试文件共 **44 tests 通过**，包括 2D/CV、正常 globe orbit、真实 sphere horizon、低空附近来源仍至少 z14、高空实际 pose 全世界覆盖非空且不超过其数学 z4 上界，以及缓存 surface coverage 在新视图完成前保持旧发布结果。测试的数量上界用于捕捉真实距离回归，生产实现没有强行截断覆盖。局部 eslint 与 e2e vue-tsc 通过。

### 修复后的 GPU 信号与保留的诊断边界

正常校准的 pitch65 / zoom14 中，optical scale 修复使 Native style zoom 回到14，线的严格 shape 比较不再失败；图标从19.067×7.557恢复到26.882×10，对 MapLibre27.549×10剩0.667px宽残差。主任务独立 circle 修复后，map/map 圆也退出失败列表；主任务绘制顺序修复后，初始 post-line/extrusion depth probe 从蓝/红不同恢复一致。

此前新增自动 globe zoom11 诊断时，line/symbol 的小残差消失，但顶视建筑 Native16px/MapLibre18px 的 binary mask 高度差仍使严格比较失败。以下最终资格检验直接读取实际上传的顶点和 GPU 输出，进一步区分了模型/采样与真实渲染错误；这条历史红信号没有通过扩大0.5px门槛消除。

旧 nadir horizon GPU fixture 现保留不受 minzoom 限制的蓝色建筑，另放一个 minzoom14 的青色建筑。实测 focus zoom15.044时青色可见，miss的真实 horizon focus zoom10.323时青色隐藏；蓝色建筑各姿态仍有6000+真实像素。公开 MapLibre sphere unproject oracle 与实际 styles zoom 误差小于1e-8。viewport CJK 文本按最新版 shader 的 `clamp(0.5+0.5*centerDistance/anchorClipW,0,4)` 比例改变，而不是错误要求屏幕字形恒定。[symbol perspective rule](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/shaders/glsl/symbol_text_and_icon.vertex.glsl#L85-L101)

该自由 miss 相机里的近处道路很宽，原先±100px ROI把它截成202px。现记录完整 framebuffer 中有界的真实外沿 AA 覆盖，保持道路非零像素与 optical scale 的方向控制；没有把未校准真实 Worker line anchor 的 declared-ground 行截面当作绝对宽度 oracle。完整同机位 MapLibre GPU 线形状比较仍由正常 globe fixture 独立严格检查。

新增 source handoff depth 回归使用真实 `setStyle` 改 sourceID/layerIDs，`page.route` 阻塞 fresh GeoJSON URL；等待期间旧 extrusion/line 仍发真实 draw，但同一点从红变黑。实际命令顺序记录为新 `replacement-background` → old buildings → old lines → old circles → **新 background 再次绘制** → old icons，证明未知新 background 排在旧保留几何之后覆盖。缓存产物为 `globe-handoff-background-probe/*/globe-source-handoff-waiting.json`；生产 snapshot/order 修复由主任务处理，本研究任务不改其独占文件。用例继续断言新源完成后真实红色、移除后无绘制/黑色地面，并发生实际 GPU buffer 删除；在等待黑色修复前，后续两个阶段尚未执行，不能宣称其已验证。

主任务随后把 old retained ranks 与当前未出现的 layerID declared ranks 合并到同一 handoff snapshot，保留原 extrusion cutoff；完整 depth → held old-source pixels → fresh-source complete → remove → actual GPU buffer deletion 回归在 `held-style-green` 产物中通过（14.1s）。上述黑色结果保留为修复前的诊断证据。

冻结生产后的只读精度检验进一步收窄两个残差来源：

- 对请求的80m屋顶四角，使用已捕获真实 MapLibre Float64 MVP 与 Native WGS84 ECEF/FOV 独立解析投影：Native 顶边 `y=351.51965`、底边 `368.48035`，对应 MapLibre sphere `351.46231` / `368.53769`。单边模型差只有 **0.05734px**，但跨过 pixel-center `351.5` / `368.5`；关闭 MSAA 的硬边 mask 因而可放大成16行与18行。这与实际顶视蓝色 mask 的结果一致，支持模型/采样解释。该计算针对请求几何，尚未独立追踪每个 Worker roof vertex，不能把它写成生产所有建筑路径均已正确的证明。
- globe shader 先以 float32 计算 `mercator_pos.x≈0.5`，再计算 `spherical_x=mercator_pos.x*PI*2+PI≈2π`。zoom14 的 worldSize8388608，前者的 ULP `2^-24` 对应 **0.5 CSS px**，后者的 ULP `2^-21` 乘 globe radius pixels 对应约 **0.637 CSS px**；zoom11 则只有0.0625 / 0.0796px。这与实际 zoom14 line/icon 小残差在 zoom11 消失的尺度一致，但完整归因仍需要实际 GPU uniform/vertex 证据。CPU `reference.project` 的 Float64 Worker-anchor 资格不能自动排除 GPU float32 的这层量化。[实际 globe vertex 投影](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/shaders/glsl/_projection_globe.vertex.glsl#L57-L98)

该解析阶段的假设随后通过下面的实际 VAO/UBO 与 transform feedback 证据检验；没有把 Native 高精度几何降为 float32 来追随参考渲染的量化。

### globe variable LOD 与 postRender 确认帧

完整单测整合发现旧 lifecycle 用例的隐含前提也需同步：height6000m、longitude微移1e-6的两个真实3D camera pose，source zoom13/style zoom13.1361982926及实际 tileID 都相同，但最新版 globe covering zoom>4 是 variable detail，两个 pose 的 `SourceTileLod.sameSelection` 按不同物理选择对象返回false。旧 covering debt 已由真实 camera render 消费，postRender 留下的是**新选择**的确认 callback，并不是旧回调重复执行或预算耗时。

独立缓存复算脚本 `node_modules/.cache/temp/comprehensive-audit/frame-covering-selection-repro.ts` 使用真实 Cesium camera、真实 source producer 与 actual terrain/frustum selection，证明3D variable的sameSelection=false而CV constant的sameSelection=true。测试使用同一3D BufferPolygon GPU边界：将原“无新debt”用例明确置于最新版允许的 globe source zoom<=4 constant branch；另保留原高倍率3D camera，验证新 variable selection只补一次确认 tick，随后恢复静止。没有修改生产 wake/covering 逻辑，也没有模拟 `sameSelection` 结果。

affected lifecycle **14 tests 通过**；随后完整单测 **58 files / 309 tests 通过**，build类型检查与局部eslint通过。单测结果与下述硬件 GPU 的模型/精度资格分别记录，不把单测全绿等同于所有投影模型的像素完全相同。


### 最终形状资格：实际 VAO/UBO、屋顶边界与 GPU 顶点

规范验收采用默认自动 globe 的 **zoom11 / pitch0、65**，仍要求 actual GLOBE shader、transition1、实际 camera/FOV/Worker anchor 资格。line/circle/symbol 保留原0.5px完整 pixel shape、宽、高门槛。建筑读取每个真实 draw 的 VAO attributes、实际 EBO indices 与 bound uniform/UBO，包括跨赤道两张实际来源 tile；Native 按实际 `high*65536+low` 解码上传 ECEF，MapLibre 按实际 `a_pos/a_normal_ed/tile/base/height` 重建 sphere 模型。没有把声明四角或私有缓存布局当作实际 Worker 几何。

建筑首先比较两侧连续投影尺寸（仍0.5px），再按各自真实模型的完整凸轮廓在 pixel-center 采样，核对各自实际蓝色 mask 的宽、高、四条像素边界和完整覆盖（仍0.5px）。因此一行/一列尺寸增大或像素偏移仍失败；合法的 WGS84/sphere 边界采样差异不会被误报成尺寸错误。fixture 限于这一明确的凸建筑，不把凸轮廓方法推广到任意凹多边形或遮挡场景；独立后置穿楼线/来源替换用例继续检验真实深度与生命周期。

| 实际上传几何的顶视 roof 边界（zoom11） | Native WGS84 | MapLibre sphere |
| --- | --- | --- |
| 上沿 / 下沿 | 351.516814 / 368.483186px | 351.459458 / 368.540542px |
| 连续高度 | 16.966373px | 17.081084px |
| 该模型预测 mask 宽×高 | 17×16px | 17×18px |
| 真实 framebuffer mask 宽×高 | 17×16px | 17×18px |

真实模型连续高度只差0.114711px，两边各0.057355px，却跨过351.5/368.5的两个 pixel-center。倾斜65°时实际连续高度22.233537 /22.297364px，两个模型及真实 framebuffer 都为18×23px。这把此前请求几何上的解析推断推进到实际上传顶点的证据。

城市 **forced vertical-perspective zoom14** 保留为高倍率精度诊断。显式 `tf=1` 在实际 program link 前选择内建 `gl_Position`，诊断重放使用当时真实 linked program、VAO、textures、UBO，并保存实际 attributes、indices、uniforms 与输出；没有 clone shader 或改动 geographic shape。GLES indexed draw 在 feedback active 时受限，故重放 POINTS 覆盖实际 index range，保留原 gl_VertexID，启用 RASTERIZER_DISCARD，随后恢复 GL 状态。由于选择 feedback varying 可能改变 driver 优化，先要求两个原/TF 页面在各姿态的**完整双方 framebuffer SHA-256 完全相同**，才能使用顶点证据；全部实际 draw 的 GL errors 为空。[WebGL2 transform feedback](https://registry.khronos.org/webgl/specs/latest/2.0/)、[GLES drawElements 限制](https://github.com/KhronosGroup/OpenGL-Refpages/blob/main/es3/html/glDrawElements.xhtml)

zoom14 建筑 Native actual GPU vertex 与其实际 ECEF CPU 模型的最大投影误差为 pitch0 **0.0000067px**、pitch65 **0.0001044px**；MapLibre actual GPU vertex 对实际 sphere inputs 的 Float64 模型为 **0.287641 /0.277884px**。屋顶蓝色 coverage 均仍吻合各自模型。图标的实际 GPU envelope（包含atlas border，不能直接当作ink尺寸）进一步指出剩余宽度误差来自参考 GPU 浮点运算：

| icon envelope 宽度 | Native actual GPU | MapLibre actual GPU | MapLibre actual VAO/UBO，Float64 运算 | 使用实际 camera Float64 matrix |
| --- | --- | --- | --- | --- |
| pitch0 | 25.999514px | 26.738177px | 25.999404px | 25.999525px |
| pitch65 | 29.499421px | 30.251891px | 29.522895px | 29.523065px |

独立复算按6.14 `symbol_icon.vertex.glsl` 的已资格化 map-aligned、constant-size、无terrain/rotation/height分支逐步执行，直接消费 TF 页上传属性及实际 uniforms。顶视 Native 与参考的双精度几何宽度约差1e-5px，而参考 GPU 的宽度多0.739px；倾斜中真实模型宽度约差0.024px，参考 GPU 多约0.729px。这比只按 zoom 的 float ULP 估计更直接：实际 TF 输出与实际输入的双精度 oracle 一致解释了高倍率参考量化残差。[实际 icon vertex shader](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/shaders/glsl/symbol_icon.vertex.glsl)、[sphere vertex projection](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/shaders/glsl/_projection_globe.vertex.glsl)

可复现 CPU oracle 为 `node_modules/.cache/temp/comprehensive-audit/globe-symbol-feedback-oracle.py`，输入真实 `globe-render-comparison.json`。首次有资格的硬件结果为 `globe-feedback-qualification` 中 **2 passed /26.7s**：自动11严格形状验收与forced14 TF精度资格。forced14的原始line长度1px、icon ink宽0.694/0.667px残差仍写入JSON `differences`，明确不声称forced14逐像素相等，也不任意放宽其差异门槛。上述数值只代表已校准的赤道两个姿态、当前实际硬件与无DEM模型，不声称全域球面/椭球 parity。

最终在所有 camera/circle/owner-order 生产修改冻结后，运行 `rtk proxy env E2E_GPU=hardware E2E_CESIUM_BUILD=production pnpm exec playwright test e2e/globe-render-comparison.spec.ts --output=node_modules/.cache/playwright/comprehensive-audit/globe-final-qualified --reporter=list`：**4 passed /36.8s**。分别为默认城市globe实际flat资格（7.1s）、forced城市globe TF精度资格（15.3s）、真实depth/source-handoff/new-ready/remove与GPU资源释放（6.9s）、自动globe11严格模型/形状验收（6.5s）。JSON/PNG/trace缓存路径为 `globe-final-qualified`；局部eslint与完整vue-tsc通过。
