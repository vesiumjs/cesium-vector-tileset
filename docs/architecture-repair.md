# 项目结构与库复用修复记录

## 完成范围

这次工作的目标是减少重复实现、重复状态和不可达功能，并修复它们暴露出的行为问题。审计从公开入口、Worker 入口和构建入口追踪引用，分别覆盖渲染、样式与来源、数据与工具三组目录。

检查范围包括 `assets`、`data`、`geo`、`render`、`source`、`style`、`symbol`、`tile`、`util`、`worker`，以及包导出、代码生成、声明与 Worker 构建。删除判断同时检查测试和浏览器 fixture；生成器使用的输入模块不能仅因不在运行时入口中就删除。最后额外独立复核了共享批次交接、Canvas 差异、矢量内存和场景释放接线。

第一轮把已确认问题的回归通过当成了整体完成，遗漏了仍可删除的旧功能链、样式更新重复计算和资源所有权问题。第二轮重新检查这些领域，并处理下表中的遗漏。测试数量用于说明验证范围，不作为架构完成的判断依据。

## 已落实的变化

| 领域 | 原问题 | 当前实现与验证重点 |
| --- | --- | --- |
| Cesium 数学与空间工具 | 自写椭球坐标、法线、矩形边界、球坐标和缓动 | 使用 `Cartesian3`、`Ellipsoid`、`BoundingRectangle`、`WebMercatorTilingScheme`、`BoundingSphere`、`Math` 和 `EasingFunction`；保留需要的角度、坐标轴及边界语义 |
| 请求调度 | 普通 HTTP、图片和 Worker 各自调度，不能共享 Cesium 资源竞争 | 普通 HTTP 经主线程接入 `RequestScheduler`；保留请求取消、缓存元数据、响应错误和解码生命周期 |
| 样式更新 | 多次序列化、计算差异、校验和编译相同表达式 | `Style.setState` 返回一次规范化后的前后样式和差异；渲染器复用结果；完整样式验证后执行差异，直接 setter 仍自行验证 |
| 样式状态 | 移除 light 会抛异常；省略属性和删除 global-state 仍留下旧值；稳态更新没有触发重新求值 | 光照完整替换后恢复规范默认值；Worker 同步完整 global-state 快照，并在原字典上更新，保留表达式持有的身份；光照和 global-state 修改标记样式 dirty；缩放范围省略时恢复默认值 |
| 瓦片与发布 | 内容、模式、发布阶段等状态在多个所有者复制 | `TileGeneration` 持有同一代次的状态；驻留、发布队列和渲染记录共用它；几何准备与符号碰撞完成仍分别判断 |
| 图层集合 | Raster/Pattern 只新增父集合，删层后不注销 | 两轨道共用集合生命周期管理；全量轨道定义包含隐藏图层；无所属图层的空父集合在资源释放后回收，保护退休缓存和未完成交接 |
| 动态栅格 | 批次资源同步复制到每瓦片；共享批次随首块交接瓦片销毁；重建后等待关系指向旧实体 | 批次持有材质、纹理和样式；按瓦片隐藏实例，最后一个引用释放后销毁；冷批次重建会迁移所有等待关系；已上传几何保留，尺寸与采样更新纹理；共享物理资源只计一次 |
| 交接期间资源 | 旧资源从活动记录删除后仍在场景绘制，却漏记内存；延迟释放后预算没有更新 | Vector/Raster/Pattern 报告仍存活的交接资源并保持 pinned；Scene 统一延迟释放，并通知预算重新计算；逐层可见性和覆盖查询涵盖交接资源 |
| Canvas 样式 | 运行时支持 Canvas，公开类型却不接受；验证器吞掉字段错误；克隆及差异检查损坏元素身份 | 导出 `TilesetStyleSpecification` 表达真实来源能力；复用 style-spec 校验规则，仅补 Canvas 扩展；配置克隆保留真实元素，来源差异识别元素身份 |
| 线与图案 | 图案线绕开统一线几何，宽度、缩放、连接及距离语义不一致 | 图案线复用统一线准备与上传路径；保留 CSS 像素宽度、连接和端点语义；相机缩放更新现有材质，无需重新请求瓦片 |
| 符号与文字 | GPU 资源细节散落；RTL 插件链不可达；字形依赖不完整 | GPU 资源集中管理；复用 `bidi-js`，保留字素簇和格式字体映射；Unicode 表由生成器维护；镜像字形也进入依赖请求 |
| 图集共享 | 自写 hash 和手工分隔串可能让不同布局共享资源 | 使用包含布局、版本和像素比例的规范 JSON 键；覆盖分隔串碰撞和 Unicode 名称区别 |
| 缓存与覆盖 | 同 key 缓存项混淆淘汰顺序；CV 极端视角恒定高等级细分 | 按实际缓存条目管理顺序；CV 使用投影矩形包围球和有限焦点下的可变 LOD；覆盖 89.9° 与 90° 的遍历边界 |
| 类型约束 | 宽松配置掩盖生命周期空值；辅助读取擦除真实图层类型 | 保留完整 strict 检查；图层查询保留桶的具体图层类型；动态栅格和 Worker 结果表达实际阶段；清除无效参数与闲置状态 |

重点实现位置：

- `packages/cesium-vector-tileset/src/render/scene/tile-generation.ts`
- `packages/cesium-vector-tileset/src/render/scene/layer-collections.ts`
- `packages/cesium-vector-tileset/src/render/symbol/symbol-gpu-resources.ts`
- `packages/cesium-vector-tileset/src/render/raster/raster-renderer.ts`
- `packages/cesium-vector-tileset/src/style/style.ts`
- `packages/cesium-vector-tileset/src/util/request-scheduler.ts`

## 删除与收缩

删除前核对了生产调用、测试、构建和公开导出。保留通过 `setStyle` 实际可达的状态更新和已声明能力。

- 删除不可达 GeoJSON diff、cluster 查询及辅助转换链，保留数据替换、过滤、聚类和聚类属性计算。
- 删除不可达 RTL 插件装载、状态和 Worker 分支，改为内置文字处理。
- 删除 Style 的旧 URL 加载、空样式加载、transformStyle 支路及未调用的编辑接口；公开入口继续使用 `fromUrl` 和 `setStyle`。
- 删除来源未调用的 URL/tile setter、闲置标志，以及 WorkerTile 只赋值不读取的字段与依赖回传支路。
- 删除 `Bounds`、`LngLatBounds` 和 `util/math`；TileBounds 直接保存已验证四元组，保留跨反经线和半开瓦片边界。
- 收缩 FeatureIndex 的输入与状态，删除无效坐标和插入参数、无读者的要素 Map、SegmentVector 死分支。
- 删除闲置图像编辑方法、URL anchor 包装、ImageRequest 对象包装和 Worker 反注册接口。
- 删除 Anchor 未读取的 angle 数据及无效角度计算，恢复继承 Point 的实际接口。

## 保留实现的理由

| 保留实现 | 已复用的能力 | 继续需要的项目语义 |
| --- | --- | --- |
| MapLibre 样式属性和过渡 | style-spec 验证器、表达式、过滤器、差异和插值 | 样式运行时、过渡树及 Worker 数据驱动属性的生命周期仍由本项目持有 |
| 归一化 Mercator 标量 | Cesium 瓦片矩形与包围球、MapLibre oracle | MapLibre 的世界像素比例与平均地球半径不同于 Cesium 米制投影；直接替换会改变选级和高度比例 |
| 可暂停几何准备 | Cesium PrimitivePipeline、坐标编码和原生 GPU 上传 | 主线程帧预算要求分段准备；同步一次处理全部顶点会改变调度契约 |
| 线连接、符号排布和碰撞 | point-geometry、gl-matrix、tinyqueue、tiny-sdf、Cesium Primitive | 需要 MapLibre 连接、端点、沿线文字、格式文字、数据驱动属性与碰撞语义 |
| Worker 消息与 transfer registry | 平台 Worker、结构化传输、Cesium 几何 Worker | 需要反向 glyph/image/dash 请求、多样式路由、取消和表达式原型恢复 |
| CPU 图集与共享 GPU 纹理 | potpack、Cesium Texture/Material | Worker 布局没有 GPU context；共享纹理还需要引用计数与版本生命周期 |
| Canvas 的样式扩展 | style-spec 字段、坐标、来源与层差异规则 | 上游声明式规范禁止 Canvas，项目原有声明式来源仍需公开类型与校验扩展；DOM 身份先投影为标量，再由原生差异算法生成操作 |

因此，剩余代码量不等于还有同量的重复实现。继续替换某个模块时，需要证明其样式、坐标、调度及资源语义能够保持，或者明确修改产品能力。

按生产 TypeScript（排除同级测试和 `.g.ts` 生成物）统计，架构修复阶段的提交基线为 222 个文件、54,356 行，该阶段修复后为 219 个文件、52,023 行。项目仍然有一定规模；这次收敛主要来自删除不可达功能链、复用依赖算法、减少重复计算和明确资源所有权，不能表述为已经改成一个很小的库。

## 验证与限制

已完成 `pnpm lint:eslint` → `pnpm lint:tsc`，全套 Vitest 为 52 个文件、287 条用例通过，`pnpm build:ci` 和 `pnpm build` 通过。删除 Canvas 重复校验后，再次通过 lint、类型、相关 15 条单测及两种构建。

默认 Playwright 31 项通过；另外使用硬件 GPU 运行的 7 项全部通过，共 38 项不同的功能与发布回归。覆盖实际帧缓冲连续性、Canvas 16→32 像素扩尺寸时保留几何实体、交接后资源销毁、CV 地平线，以及线和符号与 MapLibre 的透视像素比较。发布验证覆盖原始和压缩 Worker 的跨来源加载与 CSP、ESM/CommonJS 入口和打包后的类型声明。Canvas 校验收尾并重新构建后，再次通过 Canvas、生产演示和发布包的 9 项相关浏览器检查。

最终浏览器产物分别位于 `node_modules/.cache/playwright/architecture-complete-default/`、`architecture-complete-hardware/` 与 `architecture-complete-pack-canvas/`。默认运行跳过的 7 项硬件用例已单独补跑；3 项独立城市性能基准、需要实时远端服务的 `@live` 用例未运行，因此没有城市 FPS 改善或远端服务稳定性的结论。

核心回归包括缓存淘汰、共享资源计费、隐藏图层重显、同 ID 转轨道交接、样式状态删除、Canvas 身份、Unicode 字形、真实场景覆盖、发布 Worker 和资源释放。资源预算是几何预留容量与上传后可读取的分配统计，仍排除驱动开销、部分 Cesium batch-table 与 terrain 自有存储，不能等同于显卡进程总内存。

部分低层渲染能力仍使用 Cesium 运行时接口；当前验证针对 Cesium 1.146.0。后续 Cesium 版本仍需重新验证这些接口。城市性能基准与功能回归分别记录，不能用单测或渲染通过推导 FPS 提升。

## 后续回归：近地沿线文字变形

用户提供的上海 Liberty 场景在相机高度约 650 米时文字正常，降低到 71.98 米后，黄浦江和道路沿线文字出现剪切、翻转。使用相同经纬度、朝向和俯角重放真实瓦片后复现；CPU 排布角度正常，实际 GPU 顶点输出却包含塌缩的字形四边形。

原因是地面微小位移转换使用的 GPU `sin`、`tanh` 在小角度处丢失精度。`symbol-gpu-resources.ts` 对绝对值小于 0.01 的输入使用五阶级数保留相对精度，其余输入继续使用原函数。修复保持现有椭球投影和文字尺寸语义。

新增 `e2e/line-text-zoom.spec.ts`，通过真实 Worker、中文字形和生产顶点着色器，检查 9 个中文字形在两种高度下的实际 GPU 四边形。旧实现中，低高度的第 5 个字有两条边长度为零；修复后全部字形保持有效、凸且对边方向一致。此用例覆盖原有图标与 CV 透视测试没有覆盖的近地 3D 中文文字投影。该用例已在精简时移除。

本次通过 lint、类型检查、29 条相关单元测试、8 项硬件 GPU 浏览器测试、库与演示构建，以及构建后演示页面的浏览器测试。原截图场景重放中，可见的 17 个字形均未折叠，黄浦江与道路文字恢复清晰。截图保存于 `node_modules/.cache/playwright/line-text-zoom/after-71.98.png`。

## 后续回归：近水平 3D 视角的比例与白模

上海场景从 347.63 米、俯角 −6.9° 变到 263.38 米、俯角 −0.3° 后，道路和文字显著放大，建筑白模全部消失。完整缓存重放没有资源缺失或渲染错误。进一步保留固定相机位置、高度、朝向，只改变俯角，并将样式缩减为背景与原有 `minzoom: 14` 建筑图层，仍然复现消失和恢复。

原实现将中心地面射线或有限光学焦点的缩放级别同时用于来源选级、样式和符号比例。接近地平线时，样式 zoom 下降，地面像素代表的米数增大，建筑图层也被缩放可见性规则隐藏。中心射线离开椭球后，3D 来源失去可变 LOD，相同区域进一步退化为统一 z12。

现在通过 Cesium 椭球坐标与视锥 `getPixelDimensions`，按实际相机高度计算 3D 样式的参考地面比例；符号 CPU 排布和 GPU 使用同一参考距离。来源选级继续使用与其光学距离一致的 zoom，在中心射线不命中时仍保留真实地面高度，按距离细化近处瓦片。3D 焦点使用 Cesium 的真实椭球射线分类，避免把平面地图的固定俯角边界用于不同高度的球面地平线。CV 继续使用原有 MapLibre 平面相机规则。

新增本地 GeoJSON 的硬件回归 `e2e/globe-pitch-scale.spec.ts`，实际测量建筑、道路和中文字形的帧缓冲。在固定 263.38 米高度、−6.9° → −0.3° → −6.9° 的变化中，旧实现的建筑像素从 6153 降为 0，道路宽度从 44 增至至少 202 像素，中文字形从 16×19 增至 46×53。修复后，建筑持续绘制，道路保持 4 像素，文字保持 7×4 的投影字形范围。单测同时覆盖 1200 米高度下球面射线提前离开地面的边界，并验证冷启动、返回视角和远处瓦片降级。该用例已在精简时移除。

最终原城市场景的近水平视角重新绘制建筑，来源瓦片按距离分布在 z9–16。截图位于 `node_modules/.cache/playwright/horizon-pitch/final/pose-b.png`。本次通过 lint、类型检查、16 个文件的 101 条相关单元测试、10 项硬件 GPU 浏览器回归、库与演示构建及构建后演示页面的浏览器验证。验证范围不包含城市性能提升。有限来源焦点仍为既有的 10 千米定义，不推导超过该高度的无限范围 LOD 保证。
