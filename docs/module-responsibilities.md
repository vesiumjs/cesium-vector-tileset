# 模块职责核对

以下结论依据现有调用链、状态读写、资源创建与销毁路径。库内路径相对于 `packages/cesium-vector-tileset/src/`；演示路径从仓库根目录开始。领域术语见 [CONTEXT.md](../CONTEXT.md)。

## 场景与渲染

| 模块 | 实际调用方与状态归属 | 命名与拆分理由 |
| --- | --- | --- |
| `cesium-vector-tileset.ts` / `CesiumVectorTileset` | 公开 Primitive 入口，接收 Cesium 帧更新；拥有 Style、各渲染轨道、发布队列、驻留策略及最终销毁顺序 | 保留协调入口；它必须安排帧内顺序和资源交接，不因文件较大便增加转调层 |
| `tile/tile-pyramid.ts` / `TilePyramid` | Style 按来源创建；从 covering 选取理想瓦片，加载父子替代，管理活动集合与离屏缓存 | 原 `TileManager` 名称不表达层级选择；采用具体的瓦片金字塔概念 |
| `tile/active-tiles.ts` / `ActiveTiles` | `TilePyramid` 持有，保存仍参与调度的瓦片并缓存排序与可渲染集合 | 原 `InViewTiles` 暗示几何可见性，实际包含加载中、替代及淡出瓦片；异步完成检查也改为 `_isTileActive` |
| `render/scene/source-render-sync.ts` / `SourceRenderSync` | `CesiumVectorTileset.update()` 调用；持有每个来源的输入快照、模式、样式与图片修订、栅格就绪状态 | 保留独立模块；来源跨帧同步与驻留策略有不同状态和失效条件。将原 `SourceFrameSync` 合入驻留会混合职责 |
| `render/scene/tile-residency.ts` / `TileResidency` | 来源同步与发布队列调用；决定场景瓦片暂留、恢复、退役、父子遮罩和源级交接 | 保留驻留策略；不承担来源输入修订缓存、图片就绪重试或几何构建 |
| `render/scene/tile-publish-queue.ts` / `TilePublishQueue` | 帧协调入口与来源同步提交工作；持有待构建任务，按预算推进地表与详情并提交 | 保留有状态队列；阶段、取消和旧代次交接是真实复杂度，不能改成无状态函数 |
| `render/scene/scene-collections.ts` / `SceneCollections` | 发布、来源同步和驻留共同调用；接入新集合，预算推进首次 GPU 更新，延后销毁旧集合 | 栅格、图案方法同时处理 added 与 removed，使用 `applyRasterUpdate`、`applyPatternUpdate`；只有移除的方法才命名为 removal |
| `render/vector/vector-tile-renderer.ts` / `VectorTileRenderer` | 发布队列推进构建，帧入口更新 paint；拥有 live/retired 矢量资源及内部 builder、paint updater | 比原 `BucketRenderer` 明确场景矢量瓦片资源的所有权；保留分步构建接口，私有内部实现不等于消除了调用方的阶段约束 |
| `render/scene/render-layer-index.ts` / `RenderLayerIndex` | 样式变化时重建，帧协调与各轨道查询；按来源和内容类别索引 StyleLayer | 职责是索引既有图层，而非执行构建计划，采用 index |
| `render/scene/style-evaluation.ts` / `StyleEvaluation` | 帧入口调用，组织样式求值、过渡与 paint 更新输入 | 用 evaluation 表达实际工作，不把任意逐帧工作统称为 frame |
| `render/scene/draw-commands.ts` / `DrawCommands` | 集合更新后由帧入口调用；准备 Cesium 命令、应用交接遮罩、维护样式顺序与派生命令缓存 | 保留命令准备模块；原 frame command plan 容易混淆构建优先级与最终绘制顺序 |
| `render/line/line-geometry.ts` / `LineGeometryCache` | line renderer 在一次构建内共享展开几何；按源数组身份、布局与模式缓存，构建结束后释放引用 | 原 `LineGeometryBuild` 没有分阶段构建生命周期；实际是构建范围内的几何缓存 |
| `render/line/dash-material.ts` / `DashMaterial` | 矢量与线渲染消费；持有 Native Material、图集上传修订及 canvas，更新 uniform；所有相关 Primitive 释放后销毁 | 原 `DashAtlasTexture` 未拥有 Texture，而是材质；移到线渲染目录，与 CPU `DashAtlas` 区分 |
| `render/line/line-renderer.ts` | vector builder 与 paint updater 消费；处理实线、虚线及共享线几何 | `isDashStyleLayer` 只有这里消费，改为文件内函数；图片图案判定优先于虚线的行为保持 |
| `render/geometry/` | 矢量、图案、栅格及符号轨道使用坐标转换、细分和 Primitive 准备函数 | 按真实跨轨道共用职责保留；线条专用裁剪、布局与位置纹理归 `render/line/` |

来源同步的固定顺序是 `TilePyramid.update/prepare` → 栅格输入 → 图案输入 → `TileResidency.syncSource`。输入身份未变但栅格图片尚未就绪时，下一帧仍重试。首次 GPU 更新、发布预算及帧后交接继续由各自模块负责。

## 素材、请求与 Worker

| 模块 | 实际调用方与状态归属 | 命名与拆分理由 |
| --- | --- | --- |
| `assets/glyph-source.ts` / `GlyphSource` | Style 响应 Worker 字形请求；拥有远程字形范围缓存、加载去重和本地 TinySDF 生成 | 用 source 表达字形供应职责；与字形图集打包不同，保留独立模块 |
| `assets/style-images.ts` / `StyleImages` | Style 处理图片添加、修改、缺失请求与逐帧回调；维护版本与图片注册表 | 比 `ImageManager` 具体；与按瓦片打包的 `ImageAtlas` 分离 |
| `assets/dash-atlas.ts` / `DashAtlas` | 样式与线渲染请求 SDF 行；拥有 CPU 行数据和修订 | 图集负责 CPU 数据，材质负责 Native 上传及 shader，不合成模糊的资源管理器 |
| `util/request.ts` / `transformRequest` | Style、source、字形及 sprite 下载调用；按可选回调转换 URL、header 等参数 | 原 `RequestManager` 只保存并转调回调，改为函数，不保留新旧兼容层 |
| `util/image-request.ts` | sprite、栅格和图片来源调用；持有并发队列，处理取消、下载及图片解码 | 删除无人注册的节流控制、仅用于该控制的配置和无人读取的请求状态；保留实际并发上限与队列 |
| `worker/worker-channel.ts` / `WorkerChannel` | 主线程 dispatcher 与 Worker 各自创建；拥有一个 endpoint 的请求/响应、取消、handler、传输注册与消息队列 | 原 `Actor` 没有表达通信职责。唯一调度消费者就是本类，内联 `ThrottledInvoker` 的 MessageChannel 并负责关闭端口 |
| `worker/dispatcher.ts` / `WorkerDispatcher` | 每个 Style 持有；将该客户端请求分派到共享 Worker，管理 channel 与租用释放 | 客户端路由与单通道通信是不同职责，保留 |
| `worker/worker-pool.ts` / `WorkerPool` | dispatcher 获取与释放；持有原生 Worker、失败状态与订阅，最后一个客户端释放时终止 Worker | 保留共享生命周期；只返回惰性单例的旧 global/shared worker pool 文件并入这里 |
| `worker/tile-worker.ts` / `TileWorker` | Worker 入口创建；按客户端与来源管理 worker source，处理瓦片解析、重载与依赖取消 | 比通用 `Worker` 明确，不与浏览器原生 Worker 混称 |
| `worker/worker-channel.ts` / `WorkerMessageSender` | worker source 消费；既有直接 channel，也有注入来源信息的发送适配 | 存在实际不同实现，保留最小发送接口 |

消息队列每个 MessageChannel 轮次启动一个任务，取消消息立即处理。启动当前异步 handler 前先安排后续轮次，保证等待中的 handler 可以收到后续 RPC 响应；不能改为逐个 await 整条队列。通道移除后拒绝未完成请求、取消 handler、关闭两个端口并忽略后续消息。

## 演示入口

| 模块 | 实际调用方与状态归属 | 命名与拆分理由 |
| --- | --- | --- |
| `src/app.vue` | Vue 应用入口；持有配置选择与原生 CesiumWidget，展示错误 | 配置变化直接驱动 Cesium 相机和模式切换，渲染循环与尺寸由 Widget 管理 |
| `src/tileset-layer.vue` | `app.vue` 按地图配置使用；管理当前 tileset、异步加载取消、状态、错误和静态 credits | 新样式初始化成功后替换旧实例，不再维护双地图绘制交接 |
| `src/demo-config.ts`、`src/styles/` | app 消费 Widget、Scene、tileset 参数与城市、样式、压力场景；样式 JSON 是资源 | 集中维护演示配置与 URL 选择解析，Vue 负责切换配置 |

是否保留模块，取决于移除后复杂度是否真正消失。来源同步、驻留、地图切换、Worker 通信与共享池有独立状态和生命周期，应保留；仅转调请求、单独包装一个单例 getter、单消费者消息调度以及无调用者的功能应合并或删除。
