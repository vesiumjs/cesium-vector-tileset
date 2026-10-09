# 动态渲染验证

2026-10-07；Cesium 1.146.0 / engine 26.4.0、MapLibre GL JS 6.12.0、TypeScript 6.0.x。

**状态：原始目标仍在进行。** 下列正确性回归和局部预算验证不能代表真实城市的整体流畅度已经达标。独立运行完整城市场景后，完整 Scene 帧和冷加载仍存在明显差距；此前的完成判断过早。

### 2026-10-09 测量修正

#### 普通与压缩构建

按用户最终要求，tsdown 留在根目录，两个源码入口采用 `tile.worker.ts`、`geometry.worker.ts` 命名。以同一配置定义输出 minify=false / true 两套构建：普通 `index.mjs`、`worker.mjs`、`geometry-worker.mjs` 保留可读代码；压缩版分别为 `index.min.mjs`、`worker.min.mjs`、`geometry-worker.min.mjs`。主入口引用对应版本的 Worker，共享模块同样使用该版本后缀，公开类型只生成一份。默认包入口使用普通版本，`cesium-vector-tileset/min` 导出压缩版本；中英文 README 与架构文档同步更新。

ESLint → TSC → 库/demo build 通过。`plain-and-minified-builds` 的 20 项硬件浏览器/发布包回归全部通过（36.8s）：两种版本的 Node import/require、构造器身份、ESM/CommonJS 类型解析、可读与压缩文件及 Worker URL、实际 geometry Worker CDN/CSP 传输和 shared chunk 来源、parser Worker 消息、生产 demo 及失败/销毁控制。后续性能对比需要明确选择构建版本；当前 `index.mjs` 是普通版本，不能直接与此前同名压缩快照比较。上述结果不代表真实城市动态性能目标达成。

#### 演示添加/移除与构建配置精简

按用户要求删除 demo 的 tileset 包装组件和 Widget composable，`App.vue` 直接展示 `fromUrl`、`scene.primitives.add`、`scene.primitives.remove`。面板提供添加、移除；当前实例、加载取消、错误监听和 credits 在入口统一清理，选择与相机参数转换保留为纯配置函数。浏览器验证实际移除后集合为空、旧实例已销毁、画面已清除，重新添加使用新实例恢复绘制；加载中移除会取消请求，迟到响应不能重新加入实例。验证没有调用方 requestRender。

tsdown 配置按用户最终要求保留在仓库根目录，库包 build 显式引用根配置，以 cwd 指定库包作为构建目录。删除显式声明入口/目录、重复 Cesium external、source map 和 chunk 命名等配置；保留浏览器输出、公开文件扩展名、依赖打包及 Worker URL。公开声明继续保留外部类型依赖。

ESLint → TSC → 70 文件 / 1026 单测 → 库/demo build 全部通过。硬件浏览器 `demo-add-remove-default-build` 的 35 项回归一次全绿（3.1min），涵盖实际添加/移除/取消、13 个预设配置、实时相机与投影切换、错误与 credits 交接、生产 demo、4 项 geometry Worker 生命周期及 8 项 packed package 消费。README 六张图集及发布文档链接验证通过。本次是 demo 与构建职责精简，不代表原始城市动态性能目标达成。

用户进一步追问 Worker 是否必须单独构建。[tsdown 官方多入口文档](https://tsdown.dev/options/entry)支持一次构建多个入口；[插件文档](https://tsdown.dev/advanced/plugins)提供通用扩展机制，并未要求每个 Worker 单独配置。实际试验确认两个 Worker 能共用默认代码拆分：删除 `codeSplitting: false` 和第三份配置，以相对导入加载共享 CPU runtime。主线程与 Worker 仍分两个配置，分别保留 Cesium peer 和打包 Worker 依赖。Worker 产物总大小由约 786.6kB 减至 653.0kB，这是文件体积变化，不是动态性能成绩。ESLint → TSC → 库/demo build 通过，`default-worker-code-splitting` 的生产 demo、4 项 Worker 生命周期及 8 项 packed 消费共 13 项全部通过（30.9s）；CDN/CSP 消费明确验证共享模块从 Worker 的 CDN origin 加载，不依赖文档 import map。此前把独立单文件构建称为必要的判断已修正。

#### 缩小停止后的符号等待

安装版 MapLibre 的真实 `Placement.commit` / `stillRecent` 与本库 scope 在同一时钟下对照：缩小 0.5 / 1 / 2 级并停止时，旧实现仍等满 300ms，分别在约 200 / 100 / 40ms 的实际断言取得 RED；连续缩小和放大控制通过。现在按已提交视图的 zoom 差缩短停止后的 recency，连续变化保留原窗口，结构与内容变化仍紧急。deadline / runnable getter 只读取状态，不把同一帧内重复查询当作停止。

Root 生命周期消费者进一步取得独立 RED：即便 scope 策略已修正，原 idle Native tick 仍把内部 wake 留在 300ms。现由 symbol renderer 在 idle tick 观察已记录的 zoom，重新安排最早 owned deadline；此入口不投影、不推进 placement，也不执行 Native GPU update。消费者验证 idle 后 deadline 约 100ms、期间没有 requestRender，到期内部唤醒一次；隐藏、释放与销毁的取消控制保留。

冻结 `city-symbol-stopped-zoom-production` 完成 ESLint → TSC → 70 文件 / 1026 单测 → 库/demo build。硬件 `symbol-stopped-zoom-dynamic` 8 项全部通过（1.2min）：100/900 symbols 连续缩放旋转、越界隐藏、同 source zoom 几何复用、静止 heading recency、默认 paint 过渡、贴地恢复、半透明交接，以及实际 MapLibre 同相机和延迟瓦片的连续可见性。缩小停止后的精确 deadline 由前述独立 clock / Root 消费者验证；不把 heading 浏览器控制描述为缩小 deadline 实测。

无 profiler/video/readback/stage observer 的独立城市完整帧回放 `city-symbol-stopped-zoom-performance-valid` 保持 109 连续姿态、409 commands / 111866193 tile GPU bytes、零渲染错误。Native cold 4424.4ms，拉远/拉近/平移/旋转 CPU P95=27.6/21.2/23.9/24.4ms；MapLibre cold 1056.9ms，P95=7.1/5.4/7.6/5.9ms。此前 Native split-transfer 基线为 cold3989.2ms、P95=27.1/26.0/23.5/21.9ms；方向混合，不证明整体吞吐或加载加速。settle 绘制由40降到26帧也只是此轮观察。完整帧16.67ms门槛仍失败，原目标保持 active。首次复测因冻结目录参数写错而加载失败，已移至正确临时目录重跑；失败产物 `city-symbol-stopped-zoom-performance` 不计性能结果。

#### 几何服务的完整等待与双 Worker 候选

在已验证的精确准入版上记录实际 London 发布包的服务边界：61 个 Native geometry Worker 批次包含 418 个 owner 请求。首个 dispatch 至最后 reply 的 2345.1ms 区间中，没有 pending Worker 任务的时间为 568.5ms（24.24%）；一个任务占 49.40%，两个任务占 26.36%。最长输入空档 171ms。render 中 CPU advance 合计 273.0ms，postPasses 中 79.5ms，idle 中只有 4.6ms。此探针有包装，只用于归因，post→reply 包含排队和传输，不能作为 Worker 纯 CPU 时间。

另一独立诊断记录 334 次真实 preparePaint，合计 22.1ms，全部返回完成。输入空档仍存在，因此不能把主要等待归因于 paint 失败。adapter cold 与探针的 tileset-attachment 零点不同，不能直接相减把末尾差值当作 GPU upload 时间。原始记录在 `city-geometry-service-timeline` 与 `city-geometry-paint-service-diagnostic` 的 Playwright 产物目录。

只在已有两批约束中试验两个惰性 Native TaskProcessor，消费者测试先得到单 processor 的 RED。候选保持共享 queue 的两批、512KB 合批和 oversize/cancellation/failure 规则；公平 London 回放保持 109 连续姿态、409 commands / 111866193 tile GPU bytes、零错误，无 profiler/video/readback/stage observer。cold 为 3959.0→4372.5ms，动态完整 CPU P50/P95 为 14.7/23.0→15.8/24.3ms，相机提交代理 P95 为 28.9→30.0ms。没有收益，已撤回候选并核对精确准入基线的 303 source/dist hashes。

实验中一次误用了同名旧快照 `city-two-geometry-workers-probe`，该组数值明确排除；以上结果来自新建的 `city-two-geometry-workers-batched-probe`，原始公平对照保存在 `london-two-geometry-workers-batched-pair`。未把旧快照、局部 budget 或增加线程数当作加速证明。

#### 新几何在绘制后提前准备的候选

`city-fresh-geometry-cpu-production` 让非空新 GeometryPrimitive 在既有绘制后/空闲 CPU 入口启动准备，保留真实绘制前的 preparePaint、Native BatchTable 和 GPU 上传。实际 SceneCollections 消费先取得 RED，再通过共享 owner 去重、空输入、单次最低进展和真实 Worker 回复控制；真实 Native BatchTable/pick ID 消费核对提前派发后的最新 color/lineWidth，3D 与两种 CV 投影的 Root 生命周期也验证绘制后的首次派发。候选通过 ESLint → TSC → 70 文件 / 1026 tests → 库/demo build，冻结 301 source / 8 dist。

无 profiler/video/readback/stage observer 的独立 London 对照均保持相同109姿态、409 commands、111866193 tile GPU bytes和零错误。正向旧/候选 cold=3905.7/4142.5ms，动态完整 Scene CPU P50/P95=15.2/24.4与15.7/24.5ms，提交代理P95=26.1/28.0ms；反向候选/旧 cold=4172.2/4606.6ms，P50/P95=15.3/23.0与15.4/24.1ms，提交代理P95=26.0/28.4ms。两轮冷耗时方向相反，不能证明稳定整体收益；候选与其测试已从生产源码撤回，实验完整源码及结果仍保存在临时冻结和 Playwright 产物。汇总：`node_modules/.cache/playwright/london-fresh-geometry-cpu-summary.json`。该结果也不能把之前测得的全部 Worker 空档归因为首次 paint admission。

#### 临时道路坐标与大索引传输

试验将 Native combine 使用的临时道路中心从 DOUBLE 改为 FLOAT，消除最终丢弃的 High/Low 编码；源拓扑、位置纹理和投影边界仍保留原精度。独立 stock Native 消费者核对最终属性、索引、记录及 DOUBLE 边界，候选通过全套检查。但静默 London 对照（相同 109 个连续姿态、409 commands、111866193 tile GPU bytes、零错误）cold=4007.2/4072.2ms，完整动态 CPU P50/P95=15.3/21.9与15.4/22.7ms，提交代理 P95=27.1/29.4ms，没有显示收益。因此撤回临时坐标改动及其专用测试，未将省去一次编码称作整体加速。候选冻结与原始结果保留在 `city-line-temporary-float-storage-production` 和 `london-line-temporary-float-pair`。

Worker handler 诊断确认两版均收到 418 个请求（68 native、338 line、12 extrusion），但第二版的短命 Native transfer 检测 Worker 在 CDP 恢复操作前退出，诊断报 `No session with given id`。这组诊断未通过，不作为完整性能验收；不是生产几何 Worker 的渲染错误。

另发现实际 Native 16-bit 拆分的传输故障：`fitToUnsignedShortIndices` 返回普通属性/索引数组，打包时 `.buffer` 为 undefined，使真实 `structuredClone(..., { transfer })` 失败。保留按原 component datatype 转成 typed storage 的修复。独立 native 布局消费者用 65538 个顶点取得实际 RED（`TypeError: Value is not an object`），无需复杂道路扇面便可复现；验证两个 16-bit 输出几何、原属性格式、所有权转移和共享源未分离。这个分支未用于正常 WebGL2 London，不能解释其首屏或完整帧差距。原始性能目标仍在进行。

最终保留改动通过 ESLint → TSC → 70 文件 / 1020 tests → 库/demo build；4 项实际 geometry Worker 生命周期与 8 项 packed package 消费者全部通过（23.7s），包括 CDN/CSP、真实打包传输、图集及文档链接。新回归直接使用跨 realm 的真实 structuredClone，按实际 typed-array 格式验证输出。冻结 `city-native-split-transfer-production` 的 301 source / 8 dist hashes 与当前生产库一致；相较模块重构基线，仅 geometry-preparation 和其测试变化，dist 仅 geometry-worker.mjs/map 变化，主库、parser Worker、公开声明逐字节相同。

#### 库与演示的职责重构

用户追加代码结构、版本声明、README 和 demo 重构要求。公开参数与具名图片/统计类型、可取消的样式请求及资源 URL 解析、context 共享 geometry Worker 生命周期、Native 管线结构类型、符号相机坐标转换分别由实际消费者模块负责。GeometryPrepareQueue 成为已接收请求唯一的 Promise settlement 所有者，删除 geometry owner 的第二份 reject 注册和 Promise 包装。主类保留 Cesium 生命周期、帧内顺序与资源交接；没有新增旧接口转调层。

Cesium package/peer/development 声明改为 `^1.146.0`，锁文件保留已安装的具体版本。独立 geometry Worker 不再以 Scene 与打包运行时的版本标签完全相等作为准入；真实 Native packedInstances 的数组类型、实例数与布局长度在 unpack 前校验，并保留数量、纹理能力、传输独立性及按请求失败隔离。真实 pack→transfer→prepare 消费者在旧版本标签检查上 RED，新结构合同通过该消费；不同版本标签不能代替实际后续引擎版本的验证。

演示只使用统一 `demoPresets` 和 `preset/source/style/mode/resolutionRatio` 状态。地点、压力场景、相机角度与高度选择已删除；预设初始相机与实际鼠标操作使用同一 Cesium 相机。显示模块在 postRender 读取模式正确的经纬高与 HPR，空闲时跳过相同姿态并在卸载前移除监听，不为显示数值额外 requestRender。已删除预设说明与来源条件面板。13 个预设按真实数据逐项进行五阶段动态构图检查；删除 12 个重复/代表性不足项，新增芝加哥、巴塞罗那、重庆，调整楼墙遮挡、朝海和目标偏移视图。[预设校验与原始产物](./demo-preset-validation.md)。中英文 README 更新六张当前预设实景图。ESLint → TSC → 70 文件 / 1019 tests → 库/demo build 已通过，随后浏览器回归正在补充，原始动态性能目标继续进行。

浏览器交接回归发现新 demo 在正常样式成功激活后，旧 active map 在 pending 期间报告的瓦片错误仍留在界面。保留旧 map 加载期与 candidate 失败后的错误监听，在成功 handoff 处清除旧 map 的错误状态；两项原失败用例、旧 active 错误仍可报告正控和 credits 交接共 4 项硬件回归 GREEN（33.5s）。

最终库/demo build、70 文件 / 1019 单测、ESLint/TSC 全绿。默认消费者 33 项分批闭环：首批 26 项通过，2 项旧错误残留按上述交接修正后通过；4 项旧 Worker 回归因测量已删除的 stock create/combine 双 Worker 失败，重写为实际生产 geometry Worker 消费者后，正常/CDN/入口404/messageerror四项全部通过（加最终 built demo 共 5 项，22.1s）。新控制保留真实 Native pack/transfer/source intact、两槽与512KB/oversize、主线程零 combine/pack、结果采用、最后owner terminate/blob撤销和 fatal 无悬置请求证据；没有仅删除旧断言。新发布README消费者还验证6张图集、locale/LICENSE本地文件与外部docs链接，8项实际packed package回归全绿（6.5s），确保npm不引用未打包的docs目录。实时相机HUD在3D/CV/2D实际连续缩放中与Camera位置/HPR一致，无额外requestRender。全部13实景预设正式动态回归亦分批通过，路由收尾失败与修正见预设报告。

冻结 `city-module-refactor-production` 的301 source / 8 dist hashes与最终生产库逐个一致。静默公平 London 对照 `london-module-refactor-pair`（40.9s），分别独立context、相同109连续姿态、409 commands / 111866193 tile GPU bytes、零错误；无profiler/video/readback/stage observer。精确准入基线与重构版的cold为4391.6/4241.0ms，完整动态Scene CPU P50/P95为15.6/24.9与15.8/23.7ms，相机提交代理P95为30.3/30.0ms。这是单pair的回归核对，没有明显退化，但不证明稳定加速或与MapLibre一致。[完整对照数据](../../node_modules/.cache/playwright/london-module-refactor-pair/london-module-refactor-pai-7f077-actor-production-comparison/pair.json)。原始性能目标仍 active。

#### 几何队列的精确准入和实际等待

恢复 bounded collision 冻结版后，两个短实景诊断将 London 完整加载的后半段定位到几何：readiness 探针以 tileset attachment 为时间零点（比 adapter cold 时钟晚约 222ms），style loaded=1010.5ms，12 个符号瓦片的 target/prospective 排布在 1781.9ms 已完成，publish queue 在 3023.9ms 清空，first updates 直到 4401.1ms 才结束，adapter cold=4640.5ms。另一个 owner 探针在 2514.8ms 记录 113 个 line、2 个 extrusion 和 23 个 native owner 等待两个占用的批次，最后仍等待实际 line/extrusion Worker 回复。它们有观察包装，只作归因；不能从等待计数直接计算可获得收益。

源码确认 `hasCapacity` 原来只看 batches.length<2，而 schedule 实际允许请求加入最后一批尚未 dispatched、总 transfer 不超过 512KB 的批次。修正统一两者：GeometryPrimitive 从真实 Native metadata 和按 geometryPacketEnd 对齐的 chunk 大小得到 exact transfer bytes，在 raw clone 前准入；schedule 根据真实 backing buffers 再检查一次，复制期间槽位被占用时保留独立 packet。最大两批、512KB 合批上限、oversize 单独占槽、取消和失败规则保持。粗准入仍在 Native metadata 分配之前，多 chunk 规划在 512-instance/chunk 边界让出，避免等待者提前持有大 metadata 或一次扫完所有实例。

公开 queue 消费在旧 getter 上取得 RED；真实 GeometryPrimitive→Native metadata→TaskProcessor transfer→prepareGeometryBatch→restore 消费验证两槽中的未发送小批可合并，oversize raw data 未被复制、source backing store 完整。另两项消费者 RED→GREEN 证明：两个已发送批次占满时不先分配 Native metadata；预算耗尽时不提前检查下一组第 513 个 geometry。89 项定向控制通过，最终 ESLint → TSC → 69 文件 / 1008 tests → 库/demo build 通过。只读审查确认 exact 字节与实际 transfer 相同，未发现取消/失败永久等待或重复 buffer 所有权。冻结 `city-exact-geometry-admission-production`（295 source / 8 dist），与 bounded collision 仅四个 geometry 源文件/测试及 index.mjs/map 不同；两 Worker、其 maps 和公开声明逐字节一致，当前 303 hashes 匹配。

隔离初候选的静默 London 正反对照 cold 4620.1→4124.5 / 4825.6→3960.5ms；但是该候选在 metadata 和规划的边界上尚有上述风险，不作为最终成绩。补完边界的发布版重新对照，保持同一初始物理相机、109 连续姿态、409 commands / 111866193 tile GPU bytes、零错误，无 profiler/video/readback/stage observer：

| 最终版顺序 | 旧 / 新 cold ms | 旧 / 新动态完整 CPU P50 / P95 ms | 旧 / 新相机提交代理 P95 ms |
| --- | --- | --- | --- |
| 旧→新 | 4688.8 / 4808.3 | 16.3 / 25.1 → 17.4 / 26.7 | 31.1 / 30.2 |
| 新→旧 | 4856.1 / 4508.6 | 16.0 / 24.2 → 15.4 / 22.3 | 29.3 / 26.8 |

保留依据是精确准入与既有 schedule 契约一致、确定的消费者等待修正；最终整场景收益方向不一致，不能宣称稳定加载加速或整体目标达成。原始结果在 `london-exact-geometry-admission-{final-pair,final-reverse-pair}/summary.json`。旧版本和风险初候选继续留在 temp 供复核。

真实 Native Worker 的第一次硬件验收 normal/cdn/cancellation 失败，旧 bounded collision 对照也同样失败：CPU 隔离 fixture 用 update 恢复回复时误入真实 line GPU 上传，缺少 appearance 而 FAILED；实际 Worker 已返回完整 geometry/texture。这不是新队列故障。fixture 改为调用正式 advancePreparation 消费回复，保留原 Worker、transfer、reply gate、状态/结果断言以及独立 admission；normal/CDN/missing-owned/messageerror/cancellation 五项随后通过（12.8s）。该 fixture 修正后再按完整命令链检查，1008 tests 和库/demo build 通过。

`city-exact-geometry-admission-horizon` 完成真实 Native/MapLibre 独立 64 姿态连续回放（35.8s），高度 120→240→120m、俯仰 −15→−0.1° 并返回，每个实际渲染姿态的相机/FOV/四个地面投影保持资格，零错误。完整录像各抽取 16 时刻并实际查看：近处巨大道路色带未恢复，建筑随高度/俯仰隐藏和恢复；Native 首次细节仍明显晚于 MapLibre。录像含初始化和观察，25.80/10.04s 总长不作公平耗时。整体冷加载、动态完整帧和响应尾部目标继续。

#### 修复接近水平视角的碰撞索引崩溃

用户报告 `SymbolCollisionIndex.reserve → SymbolTileSelection.filter` 抛出 `RangeError: Map maximum size exceeded` 并停止整个 Scene。碰撞网格原来为未截断的透视框枚举所有 64px 单元；相机 clip W 接近零时，有限框也可覆盖极大区域，超出安全整数的 cell 坐标还会使 `++` 不再前进。修复保留完整碰撞形状和 overlap 规则：最多 256 单元的普通框进入稀疏网格，大框或非安全整数坐标通过列表做精确检查。索引 clear 同时释放普通框和大框列表，不截断碰撞大小、不吞异常。

新增消费者测试从已完成的 SymbolTilePlacement 进入真实 selection.filter，在 clip W=1e−6/1e−18 下用限访 Map 复现旧算法失控，涵盖恢复正常视图、clear、never/always/cooperative 以及圆形精确碰撞。完整 ESLint → TSC → 69 文件 / 1005 tests → 库/demo build 通过。冻结 `city-bounded-symbol-collision-production`（295 source / 8 dist）；与前一冻结版仅碰撞实现、其测试及 index.mjs/map 不同，两 Worker、maps、公开声明保持逐字节一致；当前 303 个 source/dist 文件匹配冻结散列。

真实 Liberty 陆家嘴硬件验证 `lujiazui-bounded-symbol-collision-capture` 完成 115 个相机姿态、379 次实际 postRender，包含下降至 1m、俯仰 −0.01°、跨过实际选中 POI、旋转与返回。零页面/Scene 错误，返回有 57 条非空实际符号命令和 169 个可见实例，最终原图已查看。这组原始城市轨迹大框计数为零，因此不将其称为极端分支复现。

另用真实 GeoJSON 单点、12px 图标、发布构建和 Native CV 相机运行 `symbol-horizon-collision-near`：从 120m 下降至 1m，在符号前方 5m 倾斜至 −0.000001°，再逐步返回，共 263 次实际 postRender。大框路径计数达到 1，网格最大 2 单元，零页面/Scene 错误；返回的实际 postRender framebuffer 有 144 个绿色图标像素。它是受控真实 GPU 消费回归，不等同于复现用户原始城市崩溃。最初 100m 距离的探针未触发大框，且在 postRender 外读已清空 framebuffer 得到零像素，该失败保留；改为 5m，并在真实 postRender 读像素后通过。以上诊断带观察/读回，均不作公平性能成绩。

最后以当前 always-overlap 消费回归替换旧版实现再次取得两项 RED，确认异常来自 reserve 分支，恢复当前实现后全文件 56 项 GREEN。静默串行 `london-bounded-symbol-collision-pair`（37.2s）保持同一实际相机、109 姿态、409 commands / 111866193 tile GPU bytes、零错误，无 profiler/video/readback/stage observer：旧/新 cold 4542.6/4659.6ms，完整动态 CPU P50/P95 为 16.2/25.1 → 16.7/24.8ms，提交代理 P95 为 27.5/32.1ms。单轮结果有升有降，不宣称性能提高；保留必要的崩溃修复，整体性能目标继续进行。

#### 实际 Worker 冷加载归因

`city-worker-cold-profile-live` 使用页面 CDP Target 自动附加到真实 Worker，分别采样三个瓦片 Worker 和一个几何 Worker，Native 自身临时 Worker 单独记录；已 detach 的 transfer 检测 Worker 不调用 stop。带 profiler 的 cold=4808ms，仅作诊断。主线程 9469ms profile 含页面初始化，不能把全部 idle 4811ms 称为冷加载等待。几何 Worker 3645ms 中 idle 2230ms，prepareGeometryBatch inclusive 1181ms；三个瓦片 Worker parse 各约 313–340ms，不支持单个几何 Worker 整段满载的判断。

源码与采样共同确认道路 expanded DOUBLE position 存在重复生成：PreparedLineGeometry 存储和传输每个条带顶点的完整位置，geometry packet 随后因正式 line input 排除该 attribute，几何 Worker 又从同一中心线/条带顶点重建。它是下一步候选；需要统一修改准备态模型、transfer、restore 和内存统计，不能仅删除一个非主路径数组，也不以 compileLineGeometry 131ms 包装成可省掉全部 line build 334ms。当前生产未实施此候选。

该候选现已完整试验并撤回：`city-centreline-only-probe` 统一删除 compiler、prepared model、packed transfer 和 restore 中展开位置，并保留正式 Native 重建及全 line-input 的 28bytes/vertex upload reservation。真实 Worker→transfer→Tile→line publication 消费取得 RED→GREEN，37 项定向控制通过；只做定向 ESLint 和库构建，未称完整验收。只读审查确认生产 strip 均走 GeometryPrimitive('line')，同步 Native 参考在 combine 前正式重建，未发现剩余确定正确性问题。

直接静默串行 `london-centreline-only-pair`（37.2s）完整 109 姿态保持同一相机、409 commands / 111866193 tile GPU bytes、零错误，无并行编译/profiler/video/readback：旧/候选 cold 4481.3/4727.7ms，完整动态 CPU P50/P95 16.1/23.7 → 16.7/24.9ms，提交代理 P95 26.5/28.6ms。没有整场景收益，故不追加反向轮或完整检查；恢复九处候选源码、fixture 的原读取与八个 dist 文件，保留已通过的 bounded collision 修复。候选和原始结果仅留在 temp/playwright 目录。

#### 静止加载配额的提前准入没有收益

恢复冻结生产后，`city-loading-service-diagnostic` 在真实 London 加载的 lease/frame/continuation 边界记录：请求 12ms 的普通预算返回 437 次，延长 quota 返回 50 次，其余 283 次未获新 admission；这些是调用数，不是帧数。普通预算 allowance P50/P95=2.67/6.67ms，说明已有静止 floor 只在普通预算耗尽之后才扩展。观察有方法包装，仅作诊断，不能把统计推导成加载速度。

隔离 `city-early-loading-service-probe` 尝试在普通预算耗尽前提前准入同一 requested floor，同时扣除当前 deferredCharge，保留唯一参与者/轮转 stage/单 tick token；min0/undefined 的动态行为保持原分支。预算消费者 RED→GREEN，109 项预算和生命周期控制通过，定向 ESLint、库构建和只读审查通过；未跑完整验收。直接静默串行 `london-early-loading-service-pair`（36.9s）仍为同相机、109 姿态、409 commands / 111866193 tile GPU bytes、零错误：旧/候选 cold 4472.4/4477.7ms，完整动态 CPU P50/P95 15.8/23.5 → 16.4/23.5ms，提交代理 P95 26.3/27.1ms。没有加载收益，不追加反向轮或扩大 quota；已恢复两处预算文件和八个 dist。该结果排除把提前 12ms admission 当作本轮主要加速方案，整体目标继续。

本文既有表格中的“呈现”时间取自相机设置至 `Scene.render` 完成，是提交延迟代理；不包含已被证明的 GPU 完成或浏览器合成显示时间。录像用于检查实际连续画面，不能把这项代理直接称为实际显示延迟。

#### 撤回符号几何的 Worker 合并候选

现有 London cold 采样确认 SymbolPrimitive 的 Native 同步 combine 合计 53.81 ms（projectTo2D 21.29、combineInstances 20.42、encodeAttribute 7.81 ms），不足以解释秒级加载差距。隔离候选将符号复用既有 GeometryPrimitive(native) 的分片复制、同一 Worker 和两项准入，不增加 Worker 或额度，保留 allowPicking=false、POINTS 合并及最终 TRIANGLES 命令。

实际 buildSymbolHalves→mergeSymbolHalves→SceneCollections→TaskProcessor transfer→prepareGeometryBatch→Native table/VA/command 消费者取得两种 RED：旧路径没有 Worker 消息；仅切换继承时，飞行期间改变的 opacity 在首个 command 中仍为八个零。候选在 Native 首次创建 VA 后补写最新 opacity/dynamics，visible、empty、cancelled、fade 与 afterRender 控制通过；定向 ESLint 和 122 项相关测试通过。仅进行了库构建，未声称完成完整检查或硬件像素验收；候选冻结 `city-symbol-geometry-worker-probe`（296 source / 8 dist）。

一次静默串行 London 109 姿态对照（无 profiler、video、readback 或内部 stage observer）保留同一初始相机、409 commands、111866193 tile GPU bytes，零错误：

| 旧 / 候选 | cold ms / 绘制帧 | cold CPU P50 / P95 / max ms | 动态 CPU P50 / P95 / max ms | 相机提交代理 P95 ms |
| --- | --- | --- | --- | --- |
| 旧 | 4594.3 / 199 | 15.8 / 21.1 / 35.6 | 16.6 / 24.2 / 43.3 | 28.2 |
| 候选 | 4942.3 / 224 | 14.9 / 19.6 / 33.3 | 16.7 / 24.4 / 51.8 | 29.0 |

冷帧变轻但总等待增加，动态没有主要收益；撤回三处已有文件与新增 consumer test，并恢复旧 dist，最终 295 source / 8 dist hashes 完全匹配 `city-mode-road-shader-production`。不追加反向轮、完整检查或 GPU 批次来为这个失败候选寻找收益。候选及真实测试仍归档在临时冻结目录。目标继续进行。

同期只读 warm 审查也排除 SourceRenderSync / ActiveTiles 缓存作为主要路线：三个 Shanghai profiles 的 updateSource 总 inclusive 104 / 101 / 106 ms，对应约 216–243 个非 cold 帧，整条路径约 0.43–0.48 ms/帧；getRenderableIds 仅 5–17 ms 总量、getLoadedDescendents 6–10 ms 总量。这些为采样归因，不是精确计时或可获得收益，不支持在该路径追求 1–2 ms/帧。

#### 完全不可见符号的上传时序

恢复原生产构建后，`city-empty-symbol-census` 实际 London 初始完整布局有 94 个 Native 符号 owners，其中 41 个最终所有 halves 的 opacity 都为零；几何 VBO/IBO 合计 15032004 bytes，其中这些 owners 占 4064112 bytes（不包含共享 atlas）。这证明存在最终不可见的已上传资源，但不能直接预测跳过它们能缩短加载。

随后 `city-empty-symbol-timing-census` 在任何 symbol owner 注册前安装排布时序观察（initialOwners=0），记录全部 94 个 owner 首次 entry.placed；当时 47 个全零，**无 VA 的数量和尚未开始 Native 的数量均为 0**，最后完整布局仍是 41 个全零。全部空结果都在 Native 准备之后确定，因此给 upload 加一个“完整排布后 empty 则跳过”的判断在当前流程不能省掉这些工作。探针为诊断，不用于比较冷加载性能。

只读消费链审查另确认：prospective 排布当前等待 symbolsUploaded，永久未上传的 dirty streams 会阻止 tilesLoaded，展示满足与实际 drawable coverage 不能合并，未来首次非零选择还必须回到正式预算上传及完整布局交接。若让所有符号先排布再上传，是新的阶段顺序和 readiness 模型改动，可能增加串行等待；本轮不把它包装成一个简单 empty 优化，也不伪造 Native.ready。两项 census 的原始记录在对应产物 `census.json`。生产源码及构建继续保持已验收冻结版。

#### 撤回提前准备 prospective 排布的候选

隔离候选只拆开 `symbolsUploaded && prepareVisiblePlacement(...)` 的短路条件：排布先准备，展示切换仍等待上传和完整排布。真实 TileResidency→SymbolTileRenderer 消费者取得 RED→GREEN：独立区域的新 owner 上传尚未完成时，held 父 + 新 owner 的 prospective 碰撞结果已完成；旧父仍显示、新 owner 仍隐藏。上传完成后无需额外排布更新即可激活该结果，opacity 从 target 的 1 变为 prospective 的 0。定向 ESLint 和 71 项相关测试通过；仅库构建，冻结 `city-symbol-placement-overlap-probe`，未进行完整检查或硬件像素验收。

静默串行 London 109 姿态旧→候选对照（`london-symbol-placement-overlap-pair/pair.json`）保持同一物理初始相机、409 commands、111866193 tile GPU bytes，零错误；无 profiler、video、readback 或内部阶段观察：cold 4815.3→4793.1 ms，均 208 绘制帧；动态完整 CPU P50/P95 16.4/24.2→16.5/25.2 ms，相机提交代理 P95 28.3→30.0 ms。整体差异不足以保留该候选；本次未测首次可见符号时间，不据此声称它提前显示。撤回两处源文件并恢复已验收 dist，不追加反向轮和完整检查。

同轮只读复核也排除“静态 DrawCommandReplay 跳过 Native.update”作为主要路线：剔除 first-upload 后，两份 Shanghai 采样的普通 GeometryPrimitive→Native.update 总量分别为 117.728 / 94.926 ms，约 222 个 warm 帧，即整个路径约 0.53 / 0.43 ms/帧。即使全删也未达 1 ms，且 passes、模式 bounds、矩阵值、BatchTable dirty、Material/Appearance 和部分上传仍要正确更新。没有实施此缓存。

#### 按 Scene 模式去除道路无用 shader 输入

保留一项范围明确的绘制输入简化：道路在 3D 使用固定 1、2D/CV 使用固定 0 的 morph 分支，真正 MORPHING 使用原始 shader。每个原始 Appearance 拥有不可变模式版本，两个独立 Scene 不互相修改；LinePositionTexture 从原始 Appearance 构造，在其适配后选择模式版本，避免早期 Native 准备把 morph 原始分支永久丢失。硬件反射确认 CV 的实际 uniform 从 29 组降为 21 组，attributes 仍是原来的三组。保留依据是确定的无用输入减少和各模式正确性，不宣称稳定整帧加速。

实际 GeometryPrimitive→LinePositionTexture→Native 消费测试完成 RED→GREEN，覆盖实线/虚线、独立上下文、3D→CV→2D→MORPH→3D，以及 VA、texture、material 的复用。最终 ESLint→完整 TSC→69 文件 / 1002 tests→库/demo build 通过；冻结 `city-mode-road-shader-production`（295 source / 8 dist）。两个 Worker、其 maps 和公开声明与前一冻结版逐字节相同。发布构建的六项硬件道路模式用例通过（52.9 s），保留真实像素、拾取、资源复用及销毁断言。

冻结 Shanghai 64 姿态正反对照保持相同 34 tiles / 630 commands / 26765891 tile GPU bytes、相同初始相机及零错误；没有 profile/video/readback/stage observer：

| 顺序 | 旧 / 新 cold ms | 旧 / 新完整动态 CPU P50 / P95 ms | 旧 / 新提交延迟 P95 ms | 旧 / 新最大提交延迟 ms |
| --- | --- | --- | --- | --- |
| 旧→新 | 5042.7 / 4858.3 | 16.4 / 28.8 → 15.9 / 29.8 | 47.2 / 42.4 | 52.1 / 248.2 |
| 新→旧 | 4841.1 / 5053.3 | 16.1 / 29.2 → 16.5 / 26.7 | 45.8 / 48.2 | 73.3 / 127.7 |

整体收益方向不一致，冷加载及长停顿仍未解决。248.2 ms 的相机版本 35 确实从高度 210 m 改为 195 m、俯仰 −0.1°，不是重复姿态；该轮完整 Scene CPU 最大 39.4 ms，不能仅凭 Scene 内采样归因这一等待。原始结果：`shanghai-cv-mode-road-shader-{qualified-pair,reverse-pair}/summary.json`。

正式 `city-mode-road-shader-horizon` 的 Native/MapLibre 独立 64 姿态实际回放通过（30.9 s），包含 120–240 m、−15→−0.1° 及返回，逐帧实际相机、FOV、四处地面投影保持资格。双方录像各 16 时刻 contacts 已实际查看并按 HUD 姿态比较：近处巨大道路色带没有恢复，建筑按高度/俯仰隐藏和恢复；Native 首次完整细节仍明显较慢。双方视频总长 21.28 / 9.92 s 含初始化，不当作公平耗时。原始整体目标继续进行。

#### 长停顿的任务边界

针对同一冻结城市追加两次串行诊断 `city-response-stall` / `city-response-stall-shaders`，只在 warm 开启 CDP sampling、timeline、Long Task / Long Animation Frame 和 RAF 记录，第二次另观察真实 GL shader 来源；这些有探针，不能当公平性能成绩。两次都没有复现 248.2 ms 的相机提交等待，最大代理分别 65.9 / 52.1 ms，因此不能给原来那次等待指定原因。

首轮实际 settle 捕捉 88 ms Long Task、87.787 ms RAF callback；与浏览器时钟对齐的采样中 `getProgramParameter` 占 70.819 ms，调用链是 Native Primitive shader 初始化→GeometryPrimitive.update→pumpFirstUpdates。第二轮实际 LINK_STATUS（35714）查询等待 26.3 ms，warm 全段仅这一新 program，来源确认是 extrusion 单行 batch table shader，并非新的道路模式版本。安装版 Native 在创建 shader 后立即访问 vertexAttributes，触发 initialize / link 状态同步查询；当前这一步不能由合作式帧预算拆开。尚未记录初始建筑 shader 身份，不能把新 program 定性为重复编译或缓存失效，也不凭两次差异宣称性能改善。

其他 50–67 ms 长动画帧往往只有约 20–24 ms 的 Scene callback，其余包含任务间隙；在 height-240 附近另观察到 Worker 消息 microtasks、字形生成和 GC。没有证据把全部停顿归为字形 microtask 爆发，因此不直接增加字形节流策略。下一步应核对初始与回程 shader source、attributeLocations 和缓存生命周期，再决定是否有可删除的重复编译。最终 295 source / 8 dist hashes 与上述已验收冻结版一致，诊断没有修改生产源码。

随后第三次 `city-response-stall-lifetime` 从导航前观察真实 WebGL shaderSource / attach / bind / link / delete，包含初始阶段。整个该段回放只出现一个 extrusion program，首次 link 在 15427.4 ms 的 settle / pose64，LINK_STATUS 等待 49.4 ms，产生 72 ms Long Task；完整 VS/FS 和七个 attribute bindings 已记录。**该次明确是首次编译，不能归为缓存失效后的重复编译。** 最大相机提交代理为 53.7 ms，仍未复现原 248.2 ms。三次诊断初始俯仰为 −1°，不把其建筑 shader 时序外推至正式 −15° 初始录像。原始记录为 `shader-lifetime.json`；未据此加入保活缓存、预热或字形节流策略。

#### 绘制参数成本的上界

对 `city-stationary-loading-full-profile` 现有采样的只读复核确认：`cesium-profile.json` 是独立 warm 文件（7972.924 ms），cold 是另一个 9579.126 ms 文件，因此 Context.draw 1129.153 ms / setUniforms 624.244 ms 本身就是 warm，不能误认为混入冷初始化。对应 216 个动态渲染帧和 22 个 settle 帧。

按 `_setUniforms` 子树去重，能映射到库的 manual callbacks 合计 83.916 ms，识别到的 AutomaticUniforms.getValue 合计 92.227 ms；即使全部归给动态帧，两类总计也仅 0.815 ms/帧。最大的 packed line clip callback 57.324 ms，其中 `_updateView` 40.110 ms、Matrix4.equals 15.179 ms 互相嵌套。采样不足以支持靠这些 callback 的缓存或重算改动节省约 1 ms/帧，因此不扩大这条微优化路线。

其余实际成本包括 Native mat4 setter 96.643 ms、sampler setter 68.364 ms、ivec4 array setter 56.960 ms，以及 `_setUniforms` self 80.256 ms。它们不是已证实可以从库中直接删除的重复工作；多 frustum、2D 第二 viewport、model/view 变化仍必须正确响应。诊断数值不当作新优化的公平整帧收益。

#### 撤回符号首次上传交替策略

实际 line GeometryPrimitive（10000 点）与 buildSymbolHalves→mergeSymbolHalves→SymbolPrimitive 消费测试复现 nonSurface FIFO 等待：六个实际 SceneFrameBudget physical ticks 中，旧策略先推进路网，符号 Native 首次更新为 0；候选策略交替推进，两类各 3 次，同 tick 再泵不会多推进。另验证 surface 优先和已 ready bookkeeping 不占冷 admission。候选完成 ESLint → 完整 TSC → 69 文件 / 1002 tests → 库/demo build，冻结 `city-symbol-upload-fairness-production`（294 source / 8 dist），源码只改三处相关模块/测试。

但是冻结真实资源、独立 context 的 Shanghai 64 姿态正反对照没有稳定整体收益，保持相同 34 tiles / 630 commands / 26765891 tile GPU bytes、初始相机资格和零错误，且没有 profile/video/readback/stage observer：

| 顺序 | 旧 / 候选 cold ms | 旧 / 候选动态完整 CPU P50 / P95 ms | 旧 / 候选提交延迟 P95 ms |
| --- | --- | --- | --- |
| 旧→候选 | 4831.3 / 4992.7 | 16.4 / 28.1 → 16.6 / 28.3 | 46.4 / 60.0 |
| 候选→旧 | 5125.1 / 5081.8 | 16.9 / 30.6 → 16.0 / 23.8 | 48.4 / 45.9 |

London 单独的首次符号诊断也方向不一致：首轮 firstSelectedStationSubmission 1877.9→1505.0 ms，反向 1694.0→1856.0 ms；firstSymbolCommand 1874.8→1502.8 / 1692.3→1852.4 ms。诊断开启 stage observer，不能当公平整帧成绩；站点筛选包含上传、opacity≥0.1、当前 placement 激活、可见窗口和真实提交，不宣称已检测非零 glyph GPU 像素。两轮最终都保持 12 tiles / 409 commands / 111866193 tile GPU bytes。

撤回三处候选源码和候选构建，恢复之前已完整验证的 `city-shared-lod-ancestors-production`。测试中的特定排队改善不能替代真实城市的稳定收益，因此不保留额外策略复杂度。候选快照和诊断数据保留在临时缓存中供复核：`shanghai-cv-symbol-upload-fairness-{qualified-pair,reverse-pair}`、`london-cold-symbol-upload-fairness-diagnostic-{pair,reverse-pair}`。原始整体目标仍在进行。

#### 共用祖先的瓦片层级判断

最新冻结版的 London 完整场景仍有明显差距：`city-stationary-loading-full-motion` 的 Native cold 4783.7 ms，MapLibre 859.4 ms；拉远/拉近/平移/旋转 Native CPU P50 为 18.0/17.2/16.9/15.9 ms，MapLibre 为 4.5/2.3/3.7/3.7 ms。这组默认 London 3D 轨迹没有启用 CV 物理相机资格，不能当作低角度投影一致性的证明。

另以实际 Shanghai CV 相机诊断 `shanghai-cv-current-production-profile`：完整 Scene inclusive 3741.6 ms，Root update 1695.2 ms，covering 278.2 ms，其中 SourceTileLod.select 201.6 ms、desiredZoom self 116.8 ms。相邻候选反复从根节点构造相同祖先并计算同一公式。修复将祖先遍历改为标量坐标，只在最终返回时创建瓦片 ID；冻结 camera/source 的 LOD 实例按 wrap、zoom 和精确数值位置保留祖先判断，实例随镜头/源规则变化释放，不跨 pose 复用、不修改 MapLibre 公式或 Native 授权范围。

实际 globeVisibleTileIDs 消费者和安装版 MapLibre coveringTiles oracle 完成 RED→GREEN：旧公式计算 834 次超过唯一祖先完整树的 203 个上界；新首次最多 203 次，同一 LOD 再次消费为 0 次，新实例重新计算。另覆盖 source min/max、round、reparse、日期线与 z25。最终 ESLint → 完整 TSC → 69 文件 / 1000 tests → 库/demo build 通过，冻结 `city-shared-lod-ancestors-production`（294 source / 8 dist）。源码仅上述模块和其测试两文件改变；所有 source hashes 一致，两个 Worker/其 maps/公众声明与上一冻结版逐字节相同。

上海正反对照独立 context、冻结资源、64 连续姿态，无 profile/video/readback/stage observer；保持 34 tiles / 630 commands / 26765891 tile GPU bytes、初始相机资格及零页面错误：

| 顺序 | 旧 / 新 cold ms | 旧 / 新动态完整 CPU P50 / P95 ms | 旧 / 新呈现 P95 ms |
| --- | --- | --- | --- |
| 旧→新 | 5132.3 / 4787.8 | 18.5 / 29.4 → 16.6 / 26.5 | 40.6 / 51.7 |
| 新→旧 | 5236.4 / 4901.0 | 18.3 / 28.8 → 16.9 / 34.0 | 43.0 / 51.8 |

每个新 cameraVersion 的首帧 CPU P50 也由 19.1→17.2 / 18.8→17.1 ms，改善并非仅同姿态第二帧复用。保留确定的重复计算减少与两轮中位数改善；呈现尾部两轮变差、第二轮 CPU P95 也变差，新 max 57.2 ms，不能声称整体响应体验已改善或目标完成。原始结果见 `.cache/playwright/shanghai-cv-shared-lod-ancestors-{qualified-pair,reverse-pair}/summary.json`。

`city-shared-lod-ancestors-horizon` 实际 Native/MapLibre 独立的 64 姿态通过（31.7 s），包含 120–240m、俯仰 −15→−0.1° 及返回，实际 camera/FOV/四处地面投影保持资格。两份完整录像的 16 时刻 contacts 已实际查看并按 HUD 姿态核对：近处巨大道路色带没有恢复；建筑随高度/俯仰隐藏和恢复，Native 细节首次出现仍显著较慢。录像总长 Native 21.96 / MapLibre 10.00 s 含初始化，不算公平耗时。

随后验证了 nonSurface 首次上传 FIFO 的交替候选，但城市正反对照没有稳定收益，已撤回，见上节；不能将该消费链直接当作全部冷加载归因。

#### 镜头停稳后的加载推进

原来的小额度没有解决冷加载。全局 12 ms floor 的隔离控制在 Shanghai AB/BA 中将 cold 5677.5→4419.1 / 6261.5→4534.4 ms，但动态完整 CPU P50 17.9→22.0 / 19.1→22.3 ms，因此不采用全局加额。最终只在实际 camera pose 连续稳定 200 ms、无样式变化/过渡且仍有 first-update/publish 工作时，请求 12 ms floor；位置、方向、FOV/viewport 或 Scene 改变立即恢复原默认服务。限定 3D/CV；普通未耗尽预算、唯一 physical-tick token、participant/stage 轮转及 measured charge 保持原规则。floor 是合作式工作预算，原子步骤仍可能超时，不声称完整帧硬限 12 ms。

五项实际 SceneFrameWork continuation/run 消费者以及四项真实 Root 生命周期消费完成 RED→GREEN，包括下一帧默认额度恢复、相机/FOV 改变及不足 200 ms 的控制。Root 测试使用真实 pending GeometryPrimitive、真实 SceneFrameWork，WebGL/Worker 边界替代，continuation observer 不替换实现。最终 ESLint → 完整 TSC → 69 文件 / 996 tests → 库/demo build 通过，冻结 `city-stationary-loading-production`（294 source / 8 dist）。

两个独立 context 的实际 Shanghai CV 正/反对照均保持 64 连续姿态、物理初始相机资格、相同 34 tiles / 630 commands / 26765891 tile GPU bytes、无页面错误；无 profile/video/readback/stage observer：

| 顺序 | 旧 / 新 cold ms（绘制帧） | 旧 / 新动态完整 CPU P50 / P95 ms | 旧 / 新呈现 P95 ms |
| --- | --- | --- | --- |
| 旧→新 | 6601.7（283） / 4922.3（214） | 18.3 / 26.3 → 17.9 / 29.6 | 50.4 / 52.3 |
| 新→旧 | 6580.1（285） / 5023.0（210） | 18.7 / 31.6 → 17.6 / 25.8 | 59.8 / 48.5 |

冷加载分别缩短 25.4% / 23.7%，因此保留该范围明确的加载策略。静止加载 cold CPU P95 19.7→26.3 / 19.9→24.0 ms，是吞吐与加载期帧耗时的实际取舍。动态中位数没有增加，尾部并不一致；第二轮新 cold max 100.6 ms、首轮新 dynamic max 79.3 ms，不能说整体流畅度已达标。原始数据位于 `.cache/playwright/shanghai-cv-stationary-loading-{qualified-pair,reverse-pair}/summary.json`。原始整体目标仍 active。

同一冻结发布版 `city-stationary-loading-horizon` 的实际 Shanghai 64 姿态通过（33.0 s）；Native/MapLibre 独立运行，保留实际相机、FOV 与地面投影资格。两份录像的 16 时刻 contacts 已实际查看，按 HUD 姿态核对；近道路巨大色带未恢复，高度/俯仰变化仍按相同样式隐藏建筑，Native 首次出现完整细节仍显著慢。录像总长 Native 23.32 s / MapLibre 9.96 s 含初始化，不当作公平性能成绩，也不把同秒数当相同姿态。最终 294 source hashes 与冻结一致；两个 Worker 及其 maps 与旧 packed-clip 构建逐字节相同，声明仅增加私有加载状态和私有方法，无公众参数或方法变化。

此前 CPU-only native browser-idle 候选完成 70 文件 / 998 tests、检查和构建，但实际 cold 5288.8→6643.7 ms，只有 15.3 ms / 38 units 的额外 CPU；追加现有 detached line resource uploads 的隔离版本 cold 5605.8→6003.3 ms，额外 cold work 15.6 ms / 63 units；两者均撤回。两个 lazy Native TaskProcessors 共享原来的两项队列准入，实际 cold 5476.0→5581.9 ms，也没有保留。生产没有新增 browser-idle 回调、额外 Worker 或 stats 字段。

#### 冷加载推进额度的隔离试验

`city-overload-four-milliseconds-probe` 只把物理帧超额推进的最低额度从 2 ms 调至 4 ms，Worker 不变，生产源码仍保留 2 ms。上海冻结串行对照 `shanghai-cv-overload-four-qualified-probe` 保留 64 实际姿态、相机资格与相同 34 tiles / 630 commands / 26765891 tile GPU bytes，无诊断包装、录像或读回。旧 / 新 cold 为 5226.8 / 5289.3 ms；动态完整 Scene CPU P50 / P95 为 17.7 / 25.8 → 20.7 / 27.8 ms，呈现 P95 为 46.2 / 46.8 ms。没有冷加载收益且动态更慢，因此撤回，不继续反向重复。

现有诊断任务轨迹中 103 个 owned Worker tasks、418 个 owner requests；第一发送至最后回复的 3245.7 ms 内，有 40.8% 时间没有在途任务，只有 18.0% 时间达到两项准入上限。post→reply 时间不是 Worker 计算时间，这些数据不支持单凭增加 Worker 数量提高吞吐。随后 browser-idle 与双 Worker 隔离试验亦未缩短 cold；最终保留的停稳加载策略及其实际取舍见上节。

#### 道路裁剪参数的 Native uniform 消费

当前 warm 采样的 Native `_setUniforms` inclusive 为 618.160 ms，属于 Context.draw 子树，不能与它相加。道路裁剪原有 11 个 vec3/vec4 callbacks，现无损打包为三个 column-major mat4；GLSL 直接读取原向量所在列，保留实际 uniform 使用时的 Native view 更新、2D 重复视口及纬度边界的相机经线。参数浮点数由 42 增至 48，不把接口数量下降直接当作 GPU/FPS 收益。

五项真实 Cesium ShaderProgram reflection/createUniform/`_setUniforms` 消费测试先因缺少新 uniform 失败，再验证三次 matrix 上传、旧 Float32 数值与列序完全相同、稳定视图零重复上传；GL 边界被替代，因此真实 shader 编译仍另行验收。完整 ESLint → TSC → 69 文件 / 987 tests → 库/demo build 通过，冻结 `city-packed-line-clip-production`（294 source / 8 dist）。两份 Worker 及其 maps 与字形修复版逐字节相同；声明差异仅新增 Matrix4 import。真实硬件 `city-packed-line-clip-gpu` 的六项实线/虚线 2D/CV/3D 回归一次通过（54.0 s），保留实际道路/建筑像素、拾取、连续 zoom/mode、VA identity 与销毁断言。

上海 CV 正/反顺序对照均为两个独立 context、同一冻结资源及 64 个连续高度/俯仰姿态。无 profile/video/readback/stage observer，全部 34 tiles / 630 commands / 26765891 tile GPU bytes、无页面错误、初始相机资格一致：

| 顺序 | 旧 / 新 cold ms | 旧 / 新完整动态 CPU P50 / P95 ms | 旧 / 新呈现 P95 ms |
| --- | ---: | --- | ---: |
| 旧→新 | 6265.8 / 5720.4 | 19.5 / 33.3 → 18.6 / 31.9 | 46.6 / 48.8 |
| 新→旧 | 5736.9 / 5612.8 | 19.1 / 32.0 → 18.3 / 29.7 | 52.5 / 39.3 |

两轮完整动态 CPU 中位数分别降低 4.6% / 4.2%，P95 分别降低 4.2% / 7.2%，因此保留该窄范围改动。冷加载两轮降低 8.7% / 2.2%，只陈述这两个对照，不能外推稳定全城加速。呈现结果不一致，第一轮新 max 为 141.1 ms、旧 83.7 ms，第二轮新 61.9 ms、旧 73.6 ms；没有证据声称整体已达到 MapLibre 体验。原始结果见 `.cache/playwright/shanghai-cv-packed-line-clip-{qualified-pair,reverse-pair}/summary.json`。整体目标仍 active。

同一冻结发布版 `city-packed-line-clip-horizon` 的 Shanghai 64 连续姿态通过（37.7 s），保留独立 Native/MapLibre 的实际物理相机、FOV、地面投影资格。双方录像各 16 个时刻已经实际查看，按 HUD 姿态核对，近道路没有恢复原巨大色带；Native 初始等待与回程细节恢复仍明显慢。视频总长 Native 28.16 s / MapLibre 10.00 s 含初始化，不作为公平成绩，也不把相同秒数当作相同相机姿态。最终源码与冻结 manifest 的 294 项 hash 一致。

#### 同时加载瓦片时的字形重复生成

真实 Shanghai CV 冻结源码 CDP 采样 `shanghai-cv-solid-source-profile` 完成 64 姿态，冷阶段 `_drawGlyph` inclusive 438.726 ms、compileLineBuild 194.580 ms、compileLineGeometry 122.604 ms、lineBucketPrimitives 10.362 ms。这是带采样的归因数据，不能计为公平成绩。公共 `GlyphSource.getGlyphs` 的并发瓦片消费者随后复现：八个请求的两个中文字符实际绘制 16 次，应为两次；不同字体及远程 range 失败后的 local fallback 也重复绘制。每个字体/codepoint 现在共享 pending local draw，完成缓存、失败释放请求；各响应仍各自克隆可转移 bitmap。四项真实 RED→GREEN，包括失败后重试及实际 transfer 后缓存/另一瓦片的数据完整性。

平面实线 Worker 预编译曾作为独立候选完成真实 Worker→packed transfer→Tile→publication、准确各 mode 拓扑、低/高 zoom、取消/重启及 array owner 共享控制；包含此候选的 68 文件 / 993 tests、ESLint、TSC、build 通过，冻结为 `city-worker-planar-glyph-production`。但实际 Shanghai 冻结对照 cold 6144.5→6503.2 ms，没有证明新增 Worker 计算提高加载吞吐；该候选的七个生产文件及两个测试现已恢复到此前已验证的 solid-page 快照，仅保留字形请求修复。候选源码及其 993 项证据仍保存在临时冻结目录，不把实验说成最终生产状态。

单独字形修复使用 `city-local-glyph-isolated-production`，两份 Worker 和声明均与旧构建逐字节相同。Shanghai 正/反两个冻结串行 pair 共四个实际运行，每次 64 个连续姿态、独立 context、无 profile/video/readback/内部 stage observer；全部 34 tiles / 630 commands / 26765891 tile GPU bytes、无页面错误，物理相机初始资格一致：

| 顺序 | 旧 / 新 cold ms | 旧 / 新动态完整 CPU P95 ms | 旧 / 新呈现 P95 ms |
| --- | ---: | ---: | ---: |
| 旧→新 | 5972.7 / 5467.4 | 31.4 / 28.3 | 55.6 / 47.6 |
| 新→旧 | 5631.7 / 6010.8 | 27.5 / 26.7 | 50.6 / 47.9 |

冷加载首轮改善没有在反向轮重现，不宣称稳定冷加载提升；动态尾部两轮下降，但仍超过整帧目标，不宣称整体已达 MapLibre 体验。保留依据是已经确认并消除同一字形重复生成。原始数据见 `.cache/playwright/shanghai-cv-local-glyph-{qualified-pair,reverse-pair}/summary.json`。

撤回平面实验后的最终生产状态完成 ESLint → 完整 TSC → 68 文件 / 982 tests → 库/demo build，冻结 `city-local-glyph-production`（292 source / 8 dist）。最终 main、两份 Worker 和声明与上述四次实际 Shanghai 运行使用的 isolated 构建逐字节相同；两份 Worker/声明也与旧 solid-page 构建相同，因此没有再重复无代码差异的 GPU 批次。原始整体目标保持 active，冷加载和完整城市动态成本继续未达标。

首次 planar pair 和两次 isolated glyph pair 因未缓存远景 URL 中止，均不计行为 RED 或性能结果。一次正常轨迹 capture 没有请求到同一缺失瓦片，不能说它已补齐全部资源；随后直接冻结实际缺失 URL 及相关两级区域的 public MVT，再开始上述完整 replay。isolated main 首次构建也因缺少 package dependency symlink 将几项依赖误判 external，未运行该版本；补齐依赖解析后再构建，两个 Worker/声明不变资格通过。

#### 最近建筑表面与重复混色修复

半透明建筑现在按实际样式层收集全部可见 Native owner，在库持有的 RGBA/depth framebuffer 中确定最近表面，再向当前 Native 深度区间合成一次。保留实际 geometry、shader、拾取和 Scene 深度；不修改 Scene 全局绘制、共享 stencil 或调用方 PassState。分配失败可清理并重试，resize、样式失活和 tileset destroy 释放资源；16 项定向单测覆盖资源回滚、清理及 uniforms 恢复。

`extrusion-compositor-candidate1` 的实际 CV 七个高度/角度往返姿态全部得到 Native / MapLibre red=204、blue=6，后方蓝色泄漏为零；重复同面建筑仍为 204，修复前 Native 为单面 235 / 重复 252。独立近/远可见控制、opacity=0、实际相机/FOV/地面投影及硬件资格均保留。`extrusion-compositor-qualified-controls` 的 CV、globe 和重复面三项通过；globe 与平面 Mercator 的地面几何不同，实际 2.2–3.2 px 差异明确记录，并用独立解析 ECEF 投影验证 Native，不把曲面当平面。

同批实际 multi-frustum 控制先复现 red=245（MapLibre=204），实际 37 个深度区间；此前三项通过不代表跨区间正确。GPU float32 下 near=0.1 / far=1e10 的 inverse projection 两项为 −5/+5，远端 homogeneous w=0，原除法产生无效射线并重复合成。改为直接以 homogeneous xyz 和 eye depth 归一化后，原严格硬件用例 `extrusion-compositor-multifrustum-after` 通过（21.5 s），保留全部资格及 204 像素阈值。

最终 ESLint → 完整 TSC → 66 文件 / 962 单测 → 库与 demo build 全绿，冻结 `city-extrusion-compositor-production` 为 290 source / 8 dist。最终冻结构建的模式回归、真实 Shanghai 连续录像及完整城市性能结果继续记录；上述最近表面正确性不等于原始整体性能目标完成。

冻结构建 `city-extrusion-compositor-final-gpu` 的建筑四项、五项 line family 和三个 dense page 通过；3D dash 的最后一项内部 pass 断言仍要求旧 TRANSLUCENT/OIT，因新最近表面处理明确替换该通道而失败。该用例此前真实道路、pattern 建筑、symbol 像素和建筑拾取已通过；更新为实际 OPAQUE 层命令及其 Native translucent source 的 depth write / blending disabled 资格后，`city-extrusion-compositor-line-family-qualified` 单项通过（15.0 s），原像素、拾取和销毁断言保留。不是一次 13 项不中断全绿。

发布包 `city-extrusion-compositor-horizon` 在独立 Native / MapLibre context 下完成实际 Shanghai 64 个连续姿态、逐帧物理相机和地面投影资格（39.7 s）。双方录像的 16 时刻已经实际查看并按 HUD 姿态对齐，近道路未恢复原截图巨大色带，建筑最近可见面变实；Native 冷等待和返回后的细节加载仍明显。录像总长 Native 29.20 s / MapLibre 9.96 s，包括初始化及冷加载，不用同一秒数当作同姿态或公平性能成绩。

同冻结构建的 `city-extrusion-compositor-continuity` 完成独立 MapLibre 的真实城市 109 姿态水面连续性（33.2 s），原水面检查通过。随后只读审查发现 HDR shader 的线性 RGB 被 RGBA8 提前量化；四项实际资源分配/HDR 切换单测先失败，再按 Native 的 half-float / float 选择及 datatype 缓存资格修复。完整 ESLint → TSC → 66 文件 / 966 单测 → 库/demo build 通过，冻结 `city-extrusion-compositor-hdr-production`（290 source / 8 dist）。上述 Shanghai/13 项批次是非 HDR 冻结的硬件证据；不把 HDR 四项单测说成实际 HDR 像素验收。

静默、串行、无诊断探针的完整城市 A/B/B/A（A 为正确的 isolated idle-upload 构建，B 为 HDR compositor 构建）已完成；实际 108 姿态及两端呈现控制保留：

| 产物后缀 | 冷加载 ms | 冷绘制帧 | 拉远 / 拉近 / 平移 / 旋转完整 CPU P95 ms |
| --- | ---: | ---: | --- |
| before | 5692.7 | 262 | 27.8 / 23.4 / 23.7 / 22.8 |
| after | 5808.7 | 269 | 26.8 / 24.0 / 27.8 / 26.7 |
| after-repeat | 5308.1 | 240 | 25.8 / 22.7 / 24.3 / 24.5 |
| before-repeat | 6112.9 | 288 | 29.0 / 24.9 / 24.4 / 25.1 |

产物 `city-extrusion-compositor-{before,after,after-repeat,before-repeat}`。冷均值 5902.8→5558.4 ms，但首轮新值高于旧值，不能声称稳定加载改善；拉远尾部降低，平移/旋转未得到一致收益。MapLibre 四轮动态 CPU P95 约 5.2–8.1 ms，仍显著更快。新呈现平移 P95 37.2 / 28.1 ms，旧 26.0 / 25.8 ms，也不能声称整体流畅度达标。两边 Native 初始均 12 瓦片；提交命令 428→417 是层命令数量，并非 offscreen 真实 draw 数。现有 `gpuMemory` 为 tile residency 的 111867489 bytes / 36 entries / 0 evictions，**未包含新增 owned compositor attachments**；不将相同统计当作零额外显存。修复保留依据是最近表面、重复面及跨区间的真实像素正确性。

另一个精确样式差异已修复：MapLibre extrusion 使用 premultiplied RGB，最终 alpha 只取图层 opacity；Native 曾把颜色 alpha 再乘到图层 opacity。真实白色背景控制 `extrusion-color-alpha-white-qualified-red` 在 212214 个有效像素上得到 Native RGB=255/156/156、MapLibre=159/57/57；相机、背景、alpha=1 和 layer opacity=0 正控先通过。仅 `extrusionStyleForFeature` 重建 premultiplied RGB 并设置 alpha=layerOpacity 后，常量/source/composite 的六项失败转绿，10 项定向单测通过；`extrusion-alpha-and-id-qualified-controls` 的原严格 white GPU 用例通过（11.0 s），两端 RGB 完全相同 159/57/57，alpha1=255/57/57，opacity0=255/255/255。实际离屏附件在 opacity0 后为 0 bytes。Liberty 实际 building-3d 颜色是无 alpha 的 hsl(35,8%,85%)、图层 opacity=0.8，因此这个额外颜色问题不归为 Shanghai 截图根因。

同批 selected postprocessing 得到另一项已资格化的实际行为 RED：opaque 选中控制 >98% green，通过真实 Scene.pick owner、Native pickId identity 和相机资格后，translucent 的 212214 个近建筑像素 green=0。首次 `extrusion-selected-id-qualified-red` 是夹具错误地从 standard fill polygons 收集 extrusion IDs，不能当行为 RED；改为实际 extrusion PrimitiveCollection 并保存诊断后的结果才是行为回归。缺失正常渲染 ID pass 是新 ClearCommand compositor 的已知限制，正在修复，普通 scene.pick 的通过不能替代此验收。

`stats().renderPassGpuBytes` 现单独报告库持有的离屏附件；`gpuMemory` 继续报告 tile residency 缓存。README 双语和 API 注释明确了两个统计范围，避免将相同 tile bytes 当作零新增资源。

alpha / 独立显存统计的 ESLint → 完整 TSC → 67 文件 / 976 单测 → 库/demo build 通过，冻结 `city-extrusion-alpha-production`（291 source / 8 dist）。此冻结点尚未修复 selected-ID；后续结果如下。

selected-ID 已恢复：仅真实 `frameState.passes.postProcess` 启用时，为 compositor 的 Native extrusion geometry 提交独立派生缓存的 ID 命令。普通颜色/深度写入关闭，Native pick 派生显式恢复 RGBA 和 depth write；保留真实 owner、pickId、VA、shader 和 Native log-depth 派生，源命令不被修改。定向行为测试先在缺少 ID 命令时失败，修复后 12 项通过。

`extrusion-id-and-alpha-final-candidate` 的八项实际硬件用例一次全绿（1.4 min）：CV 七姿态、37 个 depth bins、真实 globe、重合面、selected postprocess、白背景 color alpha，以及 2D solid / 3D dash 的模式、像素、拾取和销毁控制。原真实 qualified selected RED 转绿；未将首次错误 ID 收集的资格失败算作行为 RED。最终 ESLint → 完整 TSC → 67 文件 / 977 单测 → 库/demo build 通过，冻结 `city-extrusion-id-production`（291 source / 8 dist）。这些正确性结果不替代仍未达标的整城市性能目标。

该冻结发布版的 `city-extrusion-id-horizon` 再次完成真实 Shanghai 64 姿态（39.5 s），独立 Native / MapLibre 物理相机资格保留；实际查看双方完整录像 16 时刻，原近道路巨幅膨胀未复现，Native 冷加载及回程细节等待仍明显。录像包含启动，Native 29.12 s / MapLibre 9.96 s，不将视频总长用作公平性能或同姿态比较。

当前回包诊断 `city-current-task-wakes-upload-qualified` 明确启用 stage / Worker / upload observers，不算公平速度：481 次真实绘制、103 次明确 owned geometry event、389 次未知 Native event。85 个 owned 回包对应的后续绘制全部处于 cold；其中末次 `renderFirstUpdates=false` 的五帧仍分别实际创建 1/2/2/3/4 个 Native BatchTable。该末次检查不能代表帧入口无工作，没有证据支持删掉一批空绘制，因此不改运输层。首次同名 `-diagnostic` 运行忘记显式启用 stage，被禁止公平计时包含包装的资格断言拦截，不计入性能或行为 RED。

此前标为“无探针”“安静”或 fairTiming 的城市计时仍有夹具默认开启的 Native 内部方法包装、阶段统计和 postRender 命令扫描。两边的测量负担不同，**这些历史数值不能作为无诊断采样的 Cesium / MapLibre 公平绝对耗时对照**；同夹具的旧新变化也仅保留为历史观察，不能替代修正后的验证。

城市计时现在默认完全不安装上述包装，不收集阶段数组或逐帧命令统计；只有显式 cityStages 才启用。实际渲染计数和完整 Scene 计时保留。三项硬件回归先在默认城市模式的 ownUpdate 断言失败，修复后全绿，同时确认显式诊断及普通正确性夹具仍可采样。城市性能用例也断言无包装、阶段数组为空，并记录诊断标志。

修正夹具后的 912 构建基线 `city-unobserved-performance-baseline`：Native 冷加载 6263.2 ms，拉远 / 拉近 / 平移 / 旋转完整 CPU P95 为 29.4 / 24.5 / 25.2 / 25.2 ms；MapLibre 对应为 6.7 / 8.2 / 6.6 / 5.9 ms。Native 初始仍为 12 瓦片、457 命令、111877969 GPU bytes。此轮仍明确显示动态差距，不能宣布目标完成；后续生产优化必须使用同一修正夹具复测。

#### 静态 surface 与道路相机样式的缓存分离

真实混合道路、Fill、Circle 瓦片复现四项失败：3D Buffer 和 CV Native standard 下，constant/source 面和圆点因道路 width 的 zoom 依赖，在每个 1/8 zoom 步重新遍历 feature。修复只把 surface zoom 依赖独立出来，constant/source cache key 固定为 0，camera/composite 保持原 1/8 步；样式 revision、真实 feature-state paintRevision 和 force transition 仍使缓存失效，道路相机 uniform 保持实时。四项失败转绿，10 项 camera/composite、样式依赖切换、feature-state 和 transition 正控通过。

ESLint → TSC → 65 文件 / 926 单测 → 库与 demo 构建通过，冻结为 `city-surface-paint-production`（287 source / 8 dist）。同一修正夹具的候选 `city-surface-paint-performance` 冷加载 5783.1 ms、四个动态 CPU P95 为 26.1 / 27.4 / 27.3 / 24.9 ms；随后旧 912 构建 `city-surface-paint-before-repeat` 为 6181.9 ms、26.8 / 25.8 / 27.4 / 27.9 ms。双方初始 Native 瓦片、命令、GPU bytes 均与上表相同；每轮连续 108 相机姿态均实际呈现、页面错误为 0，阶段采样关闭。**动态收益混合，不能宣称稳定 FPS 改善；保留依据是实际消除无效 feature 访问及正控，而不是整体性能达标。**

硬件动态 `city-surface-paint-dynamics` 的 100/900 符号连续缩放旋转、同 source zoom 可见性边界几何复用、pending 数据 paint transition 四项通过（生产 Native）。Buffer alpha/pick 用例首先因生产 Native 压缩后 constructor.name 为 e、夹具期望完整类名而中止，保留失败产物；以该用例原设计的 source Native 重跑全部 Buffer alpha/颜色/大小/GPU buffer/pick 断言通过（12.0 s，`city-surface-paint-buffer-source-native`）。此重跑不是生产 Native 的完整 Buffer 正确性验收。

#### 虚线永久页与分步上传

跨瓦片实线合批的独立硬件实验也已结束，生产代码未采用该方案。临时 `line-cross-tile-prototype` 保留真实 32 个相邻 z14 瓦片、4096 个实例及原 feature/tile/generation pick IDs，将 32 owners / VA / commands 合为 1。全部显示、分别隐藏两个瓦片、恢复四帧的完整 RGB 与逐瓦片基线完全相同；真实拾取的瓦片数为 32→31→31→32。然而最终同轨迹 ABBA 的完整 Scene CPU P95 为基线 1.6/1.4 ms、合并 3.0/2.9 ms，没有稳定收益，因此停止生产集成。实验仅测保留几何的独立 Scene，不包含整城市选择/发布，也未测 GPU duration；不能用减少命令数声称城市 FPS 改善。原始证据保留在 `.cache/playwright/line-cross-tile-prototype/result-32.json` 和临时目录的 `qualification.json`。

随后 `city-current-source-profile` 对当前 solid-page 源码进行独立 CDP 采样，非公平计时。动态窗口 7957.793 ms 中 Native Scene.render inclusive 4179.799 ms，Root update 2255.862 ms，Context.draw 1128.979 ms（嵌套值不可相加）；Root 直接子项 updateChildren 468.999 ms、symbol placement 436.251 ms、draw preparation 209.265 ms。冷阶段主线程 compileLineBuild inclusive 348.179 ms、compileLineGeometry self 90.858 ms、geometry packet copyValues self 126.627 ms。该 London 夹具默认 3D，不能把上述编译耗时归因于 CV 实线。另一个真实 Worker→transfer→Tile→publication seam 已确认 2D/CV/morph 实线仍重新编译；候选需要 Shanghai CV 的独立采样及实景对照，而不能用 London 诊断时间声称平面收益。

实线也已复用现有表示容量分页：只将 `dashPages` 改名为 `linePages`，真实 `LineBucket` 的 solid / dash / family 共用；`FillBucket` outline 保留旧范围。实际 `commitLineBuild` → packet → Worker kernel → Native combine 的 3000 条短路消费者先产生 6 owners / 6 永久 VA 输入（RED），修复后 1 / 1，全部实例保留。现有 planar outline 的 1000 实例仍为两页。定向 32 项和全套 67 文件 / 978 单测通过，ESLint、完整 TSC、库/demo build 通过，冻结 `city-solid-line-page-production`（291 source / 8 dist）；最后一项仅测试泛型类型修正后完整 TSC 再通过，运行语义未变。

新冻结源码 `city-solid-page-final-gpu` 的 2D / CV / 3D 三项实线 GPU 回归一次全绿（29.2 s），保留实际道路和建筑像素、样式拾取、连续缩放、模式交接、VA 身份及销毁。未重复整批与此次无关的 GPU 测试。

两个安静串行、无诊断的发布包城市对照 `city-solid-page-before/after` 保留 108 实际姿态：cold 5560.5→5661.8 ms，260→254 绘制；初始相同 12 tiles / 36 entries / 零 evictions，提交命令 417→409，tile GPU bytes 111867489→111866193，另有相同 7372800 bytes compositor。动态完整 CPU P95（拉远/拉近/平移/旋转）28.5/22.9/23.6/24.1→28.1/25.1/21.7/22.6 ms，呈现 P95 34.1/29.6/24.9/27.0→31.5/29.2/24.8/31.0 ms。Map cold 846.6/863.2 ms，动态 CPU P95 约 5–8.2 ms。初始确实少了八条命令，冷时间与拉近/旋转呈现未改善，不宣称整城市稳定加速；末尾 fading / retired symbol 数不同也明确保留，不能用末尾 bytes 差额声称稳定资源收益。不再为该小范围结果追加 ABBA；整体性能目标仍未完成。

容量核对：line position texture 明确要求 WebGL2；该路径实际 Primitive BatchTable stride 为 float texture 下 4、无 float texture 下 10 texels（含 pickColor），重播复用相同属性。在 [OpenGL ES 3.0 table 6.28](https://registry.khronos.org/OpenGL/specs/es/3.0/es_spec_3.0.pdf) 的真实最小 MAX_TEXTURE_SIZE=2048 下，最坏 stride10 的整行 instance 容量为 417792，高于每页65536上限；人工很小 texture limit 的既有测试只验证 position 页，不宣称整 Native BatchTable 硬件资格。未知0不猜硬件尺寸，仍由实际打包和 Native context 校验。

真实城市 owner census 确认同一瓦片/虚线图层的冷构建分块永久保留多个 VA 和绘制命令；例如 road_path_pedestrian 的六个 COMPLETE owner 在相机运动中持续参与绘制。冷工作量边界不应成为永久绘制边界。现在虚线按 Native instance ID、FLOAT record address 和真实双 track texture 容量生成永久页，上传仍按 256 KiB 写入并受帧预算控制，完整 feature 的 index prefix 才可绘制；ready 等待全页上传完成，替换期间保留旧 owner。

硬件密集场景的修改前资格检查确认两个瓦片、超过 30000 vertices、实际道路像素、多个要素拾取和部分加载可见性，12 owner / VA / command 对两瓦片的 owner 数断言失败。首版在 3D / CV / 2D 均降为 2 owner / VA / command，12 步连续缩放保持资源 identity，实际 Scene collection removal 后资源销毁。扩大模式回归发现 Worker 先于 Native 首次 update 回包会在 batch table 初始化抛出 undefined.attributes；真实 Native 单测复现后，预算内借 Native COMBINING 状态初始化自身 table，再还原 COMBINED，避免复制内部 helper。真实 records 容量、单 feature 超容量拒绝、FLOAT 地址边界与未知 ContextLimits=0 控制也实际红→绿。

最终 ESLint → TSC → 65 文件 / 936 单测 → 库与 demo build 通过，冻结 `city-line-page-production`（288 source / 8 dist）。模式回归原有 building layout 断言还停留在 Native position 属性；926 修改前快照也同样失败，而真实 packed extrusion 的四个跨模式 position 属性、道路/建筑连续像素、拾取与旧资源释放都成立，已将该断言更新到实际生产 layout。最终硬件和真实城市结果另行记录，不能将减少 VA 数直接当作整体性能达标。

最终硬件 `city-line-page-final-gpu` 的六项 line family 及三模式密集 upload page 全部通过（1.2 min）。发布包 `shanghai-cv-line-page-dynamic` 连续 64 步从 120 m / −15° 变到 −0.1°、升高到 240 m，再返回 120 m / −1°，29.1 s 通过；实际录像 16 时刻已查看，近道路没有恢复到原截图的膨胀色带，但初始等待仍明显。109 姿态、独立 MapLibre 参考的真实水面连续性 `city-line-page-continuity` 通过（32.0 s），仅目标姿态逐实际帧读像素，不作为公平计时。

补充资格审计：上述临时 Shanghai 脚本只运行 Native，不能证明完整城市近地平线与 MapLibre 匹配。camera pose 和方向实际复播成立（最大 WC 差约 1.6e−8 m），但 capturePose 使用 ground cameraZoom，而生产超过 89.25° 使用 MapLibre 公共物理相机 API 的有限 focus，二者最大 style zoom 差 3.55437。旧 `shanghai-cv-preparation-dynamic` 同样如此，先前关于该脚本零 zoom 差的判断有误；不归为新页改动的生产回归。

随后新增正式 `city-horizon-camera.spec.ts`，分别独立运行两个真实浏览器 context，连续 64 个高度/俯仰姿态，逐实际呈现帧核对物理相机、中心方向、FOV、四个地面投影点及 style zoom。旧 MapLibre 默认 85° pitch 上限实际 RED：pose 9 相机差 13.347 m；新公共物理相机 API 对照设置 maxPitch 89.9，每次先清零上次有限 focus 的 centerElevation。MapLibre 公共 API 的相机纬度/焦点纬度高度换算引入至多 0.096473 m 的纯 Z 差，水平差小于 1e−8 m；实际地面投影误差小于 0.00788 px。有限 focus 的 zoom 误差小于 1e−5，普通地面相机的 zoom 差再由实际 Z 比值独立验证，残差小于 1e−5。最终 `city-horizon-camera-qualified-final` 在冻结 936 发布包上硬件通过（37.1 s），实际查看双方连续录像的 16 时刻，按 HUD 姿态对齐：近道路没有恢复巨大色带，Native 的冷等待和建筑透叠仍明显。本轮带录像及相机采样，不作为公平性能计时。

新增 `extrusion-depth.spec.ts` 用两个独立可见的红/蓝建筑控制和真实 MapLibre 最近表面对照，连续七个变高度/角度往返姿态，实际相机位置、FOV、方向、地面像素、硬件、opacity=0 资格全部通过后，Native 最近红建筑区域仍被后方蓝建筑覆盖：蓝泄漏 180.9–181.8/255，MapLibre 为 0，重叠有效像素约 109k–119k。`extrusion-nearest-surface-red` 为已实际运行的行为 RED；源码显示 CV extrusion 禁用 depth write、3D 走 Native OIT 均不符合 MapLibre 最近表面处理。修复尚在进行，不能据此宣布正确性完成。

无诊断探针的四轮生产对比使用同一真实城市数据、108 相机姿态，Native 初始均为 12 瓦片。非 dash 命令分类与数量完全相同，dash 从 79 降到 50，总命令 457→428；59 个符号按要素键配对后全部字段相同（数组顺序不同）。GPU bytes 为 111877969→111867489，entries=36、evictions=0。

| 轮次 / 产物后缀 | 冷加载 ms | 冷绘制帧 | 拉远 / 拉近 / 平移 / 旋转完整 CPU P95 ms |
| --- | ---: | ---: | --- |
| before | 6259.7 | 300 | 26.4 / 26.3 / 24.7 / 25.1 |
| after | 5767.8 | 271 | 25.7 / 24.7 / 24.4 / 25.2 |
| after-repeat | 6534.7 | 308 | 28.0 / 28.9 / 24.9 / 26.9 |
| before-repeat | 5997.2 | 283 | 26.8 / 22.7 / 24.4 / 24.5 |

产物 `city-line-page-{before,after,after-repeat,before-repeat}`。冷加载旧均值 6128.5 ms、新均值 6151.2 ms，**没有稳定冷加载或整帧速度收益**，首轮 7.9% 的改善已被复测否定。保留的已证实结果仅是消除永久重复 draw owner、正确的部分上传与生命周期；不能凭合并后的 VA / command 数宣称性能目标达成。完整 Scene P95 仍明显高于 16.67 ms 和同轮 MapLibre，原始目标继续进行。

新 `city-line-page-profile`（37.3 s，诊断计时）按实际 bundle / Vite Native source map 还原：warm 7822.0 ms 含 idle 2777.6 ms，Native Scene inclusive 4166.2 ms，Root update 2144.1 ms，children update 493.9 ms、symbol 379.9 ms、draw prepare 202.4 ms、source sync 216.0 ms，Native Context.draw 1174.8 ms、uniforms 673.9 ms。inclusive 相互嵌套，不相加当独占 CPU，不作为公平性能改进结论。热点 UniformFloatVec4.set 与 sampler 已按真实 Native 函数确认，descriptor array setter 仅 58.4 ms inclusive，占 uniforms 8.7%；排除把 descriptor 优化当主要整帧解决方案。

纯资源上传已与 Native render adoption 分离。Native Buffer.copyFromArrayView、Texture.copyFrom 自行 bind / upload / unbind；Context.draw 每次解绑 VA，Scene context.endFrame 在 postPassesUpdate 前完成，提供安全 seam。共享 physical tick 与原预算控制 post-passes / idle 资源写入，仅完整 feature prefix 增长或全部上传完成时内部请求 render；table、shader、bounds、ready / replacement publication 仍在真实 Native render，pick 只读取已呈现 prefix。真实 Root idle 与昂贵 draw 后 post-pass 两条行为 RED（GPU writes=0）已转绿，同 tick 不重复发预算。

独立审查发现持续 transition 会截断全部 deferred GPU 上传；实际 Root 两条 seam 再次 RED 后，已将 immutable resource continuation 与 CPU style/transition/pixel-ratio gating 分离，CPU preparation/build 仍禁行，资源按同预算继续。168 项定向测试通过。合并初版 nearest-depth 修复后的 ESLint → TSC → 65 文件 / 957 单测 → 库与 demo build 通过，冻结 `city-nearest-depth-production`。单独上传改动的归因构建 `city-line-idle-upload-validated-production` 保留冻结 936 的 draw-commands 源码和测试，重建 lib 并冻结，其余当前源码/产物已恢复；此隔离构建不包含 nearest-depth 改动。

初版 upload 快照的六项 line-family 和 3D/2D dense page 通过；CV 首次因 source 尚未选择时空 scene 的 loaded=true 而误结束。夹具追加实际 loaded 且 vertices>30000 的等待后，CV 实际像素/pick/部分上传/连续资源 identity/销毁全部通过（8.9 s），未降低任何内容断言。64 个实际陆家嘴姿态、独立 MapLibre 物理相机对照 `city-line-idle-upload-horizon` 通过（38.7 s）。修正 transition 后 `city-line-idle-upload-validated-gpu` 三模式 dense page 全部通过（20.6 s），实际像素、pick、部分上传、连续缩放 VA/texture identity 与 scene removal 后销毁均保留。

无默认诊断探针四轮 `city-line-idle-{before,after,after-repeat,before-repeat}` 均使用 108 实际相机姿态；Native 12 瓦片、428 commands、111867489 GPU bytes、36 entries、evictions=0 不变。冷加载分别 5526.5 / 5494.8 / 5260.3 / 5581.6 ms，cold renders 为 257 / 252 / 243 / 265；旧均值 5554.1 ms、新 5377.6 ms，缩短约 3.2%。对应拉远/拉近/平移/旋转完整 CPU P95：旧 27.7/25.7/24.6/27.7，新 25.5/26.2/25.2/24.5，新复测 26.0/22.8/25.5/25.3，旧复测 29.4/24.7/25.1/25.2 ms。动态结果混合，新复测旋转呈现 P95 44.6 ms 也未改善；**不能宣称整体性能达标**。保留依据是纯资源安全推进及小幅冷加载收益，完整城市差距仍待解决。

初版 nearest-depth 的七姿态 CV 真实 GPU `extrusion-nearest-surface-cv-after` 通过（14.4 s），后方蓝色泄漏消失。独立 coincident 正控却实际 RED：Native 单建筑红 235.35→重复建筑 252.65，MapLibre 保持 204→204，212k 有效 ROI。3D 当前夹具先因物理相机归一化差 0.201392 m 未通过资格，不能作为生产 RED。源码审查又指出 Native 逐深度 frustum 清 depth，全 layer prepass 只在单 frustum 成立。正在实施独立 RGBA/depth nearest-surface compositor，保留这些新失败与单帧颜色偏差作为后续验收，尚未完成。

### 2026-10-08 最新完整城市结果

#### 符号布局等待期间的空渲染

真实 SymbolRenderer 的点符号相机变化回归复现了另一处调度问题：矩阵变化后的即时可见性过滤已经完成，非紧急完整布局仍在 300 ms recency 窗口内；没有活动 job、投影或 Native 属性上传，旧 `hasRunnableWork` 却仍为 true，持续请求完整 Scene 帧。该行为断言在修改前实际失败，不依赖新增 getter 缺失。修复区分 pending 与 runnable，并由 tileset 维护最早布局截止时间，到期内部唤醒 Native；隐藏、释放 Scene 和销毁取消等待，截止时间后移时重新计算。缩放等紧急变化仍立即推进。

首版整合的 ESLint → TypeScript → 56 文件 / 671 项单测 → 库与 demo 构建通过，生产快照为 `city-symbol-recency-wake-production`，其中真实 SymbolRenderer/Native VA 上传和 Root 生命周期定向验证 85 项通过。硬件相机停止回归在旧 665 构建失败、新构建通过：真实高度变化先触发新 commit，再保持位置/高度作 0.001° heading 变化，确认为相同 placement 参数、不同投影矩阵；保留瓦片、VA/VBO、pending 和像素检查。等待期内允许最初 80 ms 的合法 Native followup，至 deadline 前 30 ms 无持续 postRender，到期不调用外部 requestRender 而完成布局。产物为 `camera-recency-stop-stable-before`（真实 runnable 误报红）与 `camera-recency-stop-stable-after`（7.4 s 绿）。初始 1° 旋转改变覆盖，因此资格不合格；Native 后续矩阵正交化还产生约 1e-9 的平移末位误差，停止矩阵检查采用绝对 1e-8 容差，placement 参数仍精确比较。

真实 Residency 交接验证进一步复现两条遗漏：handoff owners 与 target 完全相同时由 target 代为推进，但 duplicate handoff 的 urgent 状态仍被统计为 runnable；排除该重复参与者后，stale empty successor 被保留时 Residency 又无条件返回续帧。实际场景保持旧 owner 可见、新 owner 隐藏、release=0，目标和可见 scope 都只等 recency，没有 first update；先在 runnable 断言红，修正重复统计后在 Residency 续帧断言红。修复复用实际 scope 参与规则，并仅在尚未上传或真正可运行时继续未完成交接；300 ms 后布局完成，新 owner 激活，旧 owner 才退出。整合后的 ESLint → TypeScript → 56 文件 / 672 单测 → build 通过，92 项定向验证通过，冻结为 `city-symbol-recency-handoff-production`。26 项完整硬件动态回归全部通过（3.5 min，产物 `symbol-recency-handoff-production-dynamics`），城市水面连续性通过（35.0 s，产物 `city-surface-continuity-symbol-recency-handoff`）。

672 与 665 构建完成无诊断探针的安静 ABBA，使用首次 loaded 冷计时与同一独立 context 协议：

| recency 轮次 | Native 冷加载 ms | 冷 render / idle | 拉远 / 拉近 / 平移 / 旋转 CPU P95 ms | MapLibre 冷加载 ms |
| --- | ---: | ---: | --- | ---: |
| after | 9659.0 | 443 / 136 | 26.0 / 23.6 / 24.8 / 24.7 | 856.4 |
| before | 9874.9 | 445 / 144 | 27.2 / 21.6 / 29.5 / 27.5 | 865.5 |
| before repeat | 9444.5 | 430 / 136 | 26.3 / 21.0 / 27.7 / 30.8 | 845.4 |
| after repeat | 9622.9 | 461 / 116 | 26.8 / 27.2 / 22.9 / 24.6 | 860.6 |

四轮完整帧门槛仍失败。冷加载没有稳定收益，平移和旋转的尾部下降，拉近没有稳定改善；settle 由旧 22/21 render 变为新 20/20，不能据此宣称城市整体体验已达标。对应产物 `city-symbol-recency-handoff-{after,before,before-repeat,after-repeat}`。保留修复的依据是实际相机等待的空渲染红→绿与正确交接，不是对整体吞吐的承诺。

`city-symbol-recency-pipeline-census` 是首版 671 构建的实际城市时间链诊断，通过用例但未开启整帧性能门槛。108 个 cold 生命周期事件无丢失，12 个瓦片各自完成 request / loadVectorData / tileLoaded / enqueue / beginTileBuild 的实际元数据配对。第一批请求至 data 到达调用者约 970–1271 ms；data→enqueue return 约 0.3–1.6 ms；enqueue→begin 约 2.6–205.7 ms。首次 begin 为绝对 5594.3 ms，首个实际 Worker admission 7083.8 ms，间隔 1489.5 ms；post 7093.8 ms，尚不能将这个跨度归因于某一个 tile 的 CPU 或网络/Worker self。相对 cold origin 由 Native tick 与 recorder 的连续序列推导，约 4275.0 ms，前 100 对偏差范围 0.2 ms；不宣称精确 origin。

本轮 bounded Native census 产物从上一轮 229 MB 降至 5.88 MB，保留完整汇总和代表/最近明细；observer errors、帧外更新和绘制均为 0。探针本身仍耗时 878 ms，tile probe 40.1 ms，admission probe 167.2 ms；这些数值不相加当独占 CPU，诊断 cold12.237s和动态P95不与安静轮次同比。下一步继续拆解 begin 到首个任务之间的真实 build phase 推进。

672 发布构建的后续 `city-symbol-recency-build-phases` 实际城市诊断通过（43.5 s，性能门槛关闭），只开启 tile phase 与 admission 探针。cold 456 个生命周期事件无丢失；126 次 advance 调用按入口 phase 统计为 convert16/23.6ms、polygons8/6.1ms、details14/154.8ms、lines39/256.2ms、extrusions49/138.8ms。单次调用可推进到其它 phase，这些不是各 phase 的独占 CPU。首次 begin 为绝对5135.2ms，首个实际 Native admission6372.2ms，间隔1237.0ms；第一块 vector tile 的 line 在6145.4ms完成，extrusion 在6343.3ms完成，6350.1ms才发布。它的12次推进累计63.9ms，分布在约982ms中，不能将整个跨度当计算耗时。冷 tile probe19.5ms、完整39.5ms；未使用此诊断轮次作公平性能比较。

短任务聚合正在验证：真实 Native TaskProcessor 回归在旧实现中16个同轮小 owner 只有2个进入 COMBINING，实际断言红；有界队列按上下文将准备请求聚合为最多两个在途批次，每批512KiB，单个超大请求独立。新回归实际执行转移、Worker kernel 与逐 owner 上传，同时验证共享缓存不 detach；独立错误、取消、销毁和真实满槽控制通过。生产协议只有 batch，尚未完成城市收益验收，不能据此宣称原始目标完成。

聚合审查进一步发现畸形成功回包与协议错误清理缺口。四项真实 TaskProcessor 控制先在撤修复状态红：数量不匹配时两个 owner 已失败但 Worker terminate 为0；undefined、null、缺失 combined 时 Native 状态仍为 COMBINING。补充成功结果校验及 queue fatal→context failOwner 后，同一两个任务在途、第三 owner 满槽等待的控制全绿，33项 Primitive 回归通过；Worker 在最后 owner 销毁前立即终止，等待 owner 也退出且无第三提交。队列18项、Kernel与line build15项定向通过；这些仍不是城市性能验收。

整合后的 ESLint → TypeScript → 57文件/697单测 → 库与demo构建通过，冻结为 `city-batched-prepare-production`（272 source / 8 dist）。动态硬件首轮21项通过，5项Worker lifecycle旧控制失败：三个小owner现在可合法同批COMBINING，而原测试期待第三READY；观测还读取旧single协议。改用真实microtask分别提交前两个、占两个实际batch，canonical观测仅统计真实请求/回包，原并发上限、第三READY、transfer/sourcecache/CSP/CDN/fatal/取消/销毁断言全部保留。ESLint/TSC及这5项重跑通过（19.4s，`batched-prepare-native-worker-adapted`）；合计26项硬件动态控制通过。发布包跨CDN原始geometry Worker测试通过（5.1s），109姿态水面连续性通过（33.3s）。生产实现未因夹具适配改变。

无诊断探针的安静 ABBA：

| batch轮次 | Native冷加载ms | 冷render / idle | 拉远 / 拉近 / 平移 / 旋转CPU P95 ms | MapLibre冷加载ms |
| --- | ---: | ---: | --- | ---: |
| after | 7058.1 | 313 / 110 | 23.1 / 27.5 / 25.3 / 24.7 | 844.3 |
| before | 8877.1 | 388 / 144 | 26.2 / 22.7 / 22.3 / 25.2 | 889.9 |
| before repeat | 8859.6 | 389 / 142 | 26.4 / 21.3 / 24.1 / 25.0 | 867.7 |
| after repeat | 7773.3 | 352 / 112 | 23.1 / 22.7 / 20.1 / 22.8 | 854.4 |

新均值7415.7ms，旧8868.4ms，冷加载缩短约16.4%，冷render减少约14.4%；四轮cold命令分类与数量一致，不能将收益归为少绘制内容。保留聚合的依据是此冷加载收益及上述正确性控制。拉远与旋转尾部下降，拉近和平移没有稳定收益，四轮完整帧门槛均仍失败，原始目标未完成。新repeat的最终symbol命令59，其它轮55，因此运动后符号状态继续以语义诊断核对，不能将settle render从19变3单独作为性能结论。产物 `city-batched-prepare-{after,before,before-repeat,after-repeat}`。

新版本全程109姿态语义与录像诊断通过（40.3s，`city-batched-prepare-whole-motion-video`），双方独立context，最终ready、错误为0、MapLibre匹配投影误差<1px。此轮含录像和语义采样，不与ABBA公平计时同比；仍需结合全程画面判断动态体验。

已实际查看双方16时刻全程contact及84–101附近的密集orbit contact，按画面HUD姿态校核：两边约87–100都有大面积空白，不能归为新的库特有覆盖丢失；101时MapLibre恢复较完整，Native仍补细节。录像Native28.60s/MapLibre13.88s，包含各自初始化与冷等待，不能直接按同视频秒数比姿态。此回程细节延迟仍未解决。

`city-batched-prepare-profile`（41.3s，性能门槛关闭）的最新CDP采样使用此次冻结bundle与该次Vite缓存的真实source map还原，不拿旧Native位置套新bundle。warm窗口7625.1ms含idle2922.8ms；Root update inclusive2025.2ms、Symbol update341.9ms，其中完整pass advance188.9ms、即时selection filter109.2ms；DrawCommands prepare182.9ms、DrawCommandReplay update116.6ms、Residency syncHeld97.1ms。Native Context.draw inclusive1051.0ms、shader uniforms604.2ms。以上inclusive相互嵌套，不能相加当独占CPU，也不是新优化效果。三项静态扫描候选仍未确认收益。

随后试验只将范围内zoom变化从完整布局的紧急判断中排除，保持即时过滤及其它viewport/input紧急参数。真实Renderer旧红验证GPU隐藏已完成却启动urgent job；候选通过ESLint→TSC→700单测→build及8项完整硬件相机回归（1.2min），冻结为 `city-zoom-recency-production`。但无探针ABBA未支持保留：

| zoom recency轮次 | Native冷加载ms | 冷render / idle | 拉远 / 拉近 / 平移 / 旋转CPU P95 ms | MapLibre冷加载ms |
| --- | ---: | ---: | --- | ---: |
| after | 6708.1 | 299 / 102 | 25.0 / 25.2 / 25.0 / 22.3 | 867.3 |
| before | 6809.3 | 299 / 105 | 24.0 / 22.6 / 28.1 / 26.6 | 848.9 |
| before repeat | 6908.1 | 302 / 111 | 25.2 / 21.7 / 23.0 / 20.8 | 847.9 |
| after repeat | 7413.5 | 336 / 108 | 26.9 / 26.0 / 21.9 / 24.4 | 862.8 |

四轮完整帧均红。拉近两轮明显变慢、冷加载及其它阶段没有稳定整体收益，不能凭MapLibre相近调度策略保留负收益实现。已仅将Scope生产文件及其两份测试从697冻结快照恢复，其余批量提交/生命周期/recency唤醒/覆盖修复保留。恢复后的 ESLint → TSC → 57文件/697单测 → 库与demo构建再次通过。候选和真实red/green控制留在700快照，产物 `city-zoom-recency-{after,before,before-repeat,after-repeat}`，不能作为当前生效的优化。

697 的 `city-batched-prepare-build-phases` 后续诊断通过（40.7s，完整帧性能门槛关闭），只实际启用 tile 生命周期探针：cold486、完整1564事件无丢失，探针20.3/41.3ms。11块冷瓦片的 lines 入口调用返回时已经进入 extrusions，其后等待最终 vector 发布126.3–1458.4ms，后续 advance 合计2.8–31.9ms；这些是发布等待跨度与被包裹调用耗时，不能把等待当独占CPU。连续运动新增55次begin，推进主要在convert/polygons，18次返回details，只有2次details入口；没有新的线阶段完成或最终vector发布。因此提前发布线是有证据的冷加载候选，却尚不能解释全部回程延迟。此轮未开启admission/Worker探针，也不作为公平性能收益证据。

随后仅将 DrawCommandReplay 的25字段动态分派改为静态访问；仍比较 raw Native 输入与上次输入，保留 final paint 状态、metadata dirty 与实时 bounds。真实 Native DrawCommand 的 Node 局部基准每轮25万次，旧161.2–164.5ms，新12.1–18.0ms；这不是WebGL或城市性能。ESLint/TSC、56项 Native命令/派生状态/多viewport定向回归、完整57文件/697单测、构建通过；9项硬件line family/屏幕边缘/paint/pick/2D/CV/3D回归通过（1.4min）。测量快照 `city-static-replay-production` 的dist与后续干净源码快照 `city-static-replay-validated-production` 完全一致，后者相对697只差这一个生产文件。

无探针 ABBA 产物 `city-static-replay-{after,before,before-repeat,after-repeat}`：

| static replay轮次 | Native冷加载ms | 冷render / idle | 拉远 / 拉近 / 平移 / 旋转CPU P95 ms | MapLibre冷加载ms |
| --- | ---: | ---: | --- | ---: |
| after | 7088.8 | 319 / 106 | 28.6 / 21.0 / 23.6 / 25.9 | 863.7 |
| before | 7754.5 | 357 / 106 | 22.9 / 22.0 / 23.1 / 22.5 | 866.1 |
| before repeat | 8461.0 | 390 / 112 | 28.2 / 22.2 / 25.7 / 25.7 | 851.3 |
| after repeat | 7326.1 | 331 / 108 | 25.8 / 22.9 / 24.5 / 24.0 | 845.8 |

新cold均值7207.5ms、旧8107.8ms，缩短约11.1%，冷render减少约13.0%；新两轮都低于旧两轮，全部cold/final命令类别与数量相同。保留依据为局部基准、Native行为控制与该冷加载收益。216动态绘制帧的均值新16.729/16.569ms、旧16.054/17.456ms，平均仅约0.6%差距且配对方向不一致，不宣称动态收益；各阶段P95仍超门槛，整体目标仍未完成。

早线发布的真实行为回归已红（1 failed/42 skipped，2.24s）：真实GeoJSON Worker parse、投影、转移、Tile恢复、64个建筑geometryRanges及actual minimumBudget推进均成功，构建已经进入extrusions且真实GeometryPrimitive线owner完成，但publication为空、renderer/Scene未收到线，实际TaskProcessor和Worker提交为0。回归暂存在 `node_modules/.cache/temp/early-line-publication/`，正在单独实施发布边界；尚未作为收益或修复完成证据。

早线发布候选的原行为红已绿，TilePublishQueue共50项、邻近vector budget/Worker lines/memory accounting/Residency共37项通过。非空线完成后增加内部lines-ready提交边界，partial append保留result与standard、登记已转移线source，最终才标complete；8个新控制覆盖实际Native admission、3D/2D/CV追加点与建筑、owner身份与代次、取消、paint、旧代pick/hold和idle不发布。ESLint→TSC→57文件/705单测→库与demo构建通过，冻结为 `city-early-lines-production`；相对干净static replay快照只有三生产文件与一测试改变，两个Worker dist未变。独立只读审查未发现具体新增缺陷，但不作为运行或性能证据；随后26项硬件动态回归全部通过（3.3min，`early-lines-production-dynamics`）。

早线发布无探针 ABBA 为 `city-early-lines-{after,before,before-repeat,after-repeat}`：

| 轮次 | Native冷加载ms | 冷render / idle | 拉远 / 拉近 / 平移 / 旋转CPU P95 ms | 216动态帧均值ms |
| --- | ---: | ---: | --- | ---: |
| after | 7189.6 | 338 / 86 | 31.1 / 28.5 / 26.2 / 23.7 | 16.4843 |
| before | 7625.6 | 343 / 112 | 24.3 / 20.9 / 25.7 / 27.4 | 16.8426 |
| before repeat | 6917.3 | 314 / 99 | 29.8 / 24.7 / 22.8 / 23.6 | 16.8565 |
| after repeat | 7725.7 | 366 / 97 | 29.0 / 20.1 / 23.8 / 23.6 | 16.4403 |

新冷加载均值7457.7ms、旧7271.5ms，配对方向不同，没有稳定冷吞吐收益；动态帧均值约减少2.3%，各阶段P95仍混合且完整帧门槛全红，不能宣称整体流畅度达标。保留依据是已完成线不再被后续建筑阻塞的真实行为回归。全部cold/final命令数量与类别一致。

`city-early-lines-build-phases` 诊断中，12块冷瓦片完成线到实际发布仅0–1.3ms，其中10块同帧；首发布6562.5ms/f89，首真实Native batch admission6588.3ms/f90，Worker post6589ms、reply6676.3ms。生命周期720冷/2038累计事件，无丢失；累计探针42.8ms、admission探针133.9ms，不是公平计时。连续运动未新增线完成或最终vector发布，不能用此阶段修复解释全部回程延迟。

`city-early-lines-whole-motion-video` 的109姿态诊断通过，最终ready且错误为0。实际查看双方全程16时刻contact及orbit密集contact并按HUD核对：MapLibre约101恢复主要细节，Native约103–104才补齐，回程一两帧延迟仍在。Native录像32.96s、MapLibre14s包含各自初始化和等待，不能以相同视频秒数比较姿态，也不作公平性能成绩。

对Native相机派生uniform候选的只读采样进一步缩小了范围：同次source map的sourcesContent与Cesium1.146原始minified index.js逐字一致，三个目标czm getter调用栈并集57.601ms（uniform604.220ms的9.53%），相应UniformState getter并集58.549ms，其中还包含其它automatic uniform的间接路径。它们是完整Scene的成本，线shader可消除部分更小；不能以604ms宣称缓存收益。没有实施该候选，避免用frameNumber/对象身份缓存实际Native view或替换Native setter。

#### 回程缓存细节与确认帧

705生产构建的真实109姿态探针 `city-return-covering-probe` 显示：101首帧当前source zoom14、已有15块loaded z14，旧z13祖先仍阻止其中完整四子footprint参与补齐。实际硬件回归 `city-return-coverage-before` 的四子loaded正控成立，首帧仍选择z13/4092/2724，因此32.1s后真实red；不是资源未到达或没有跑过动态相机。补齐不能直接追加部分子瓦片：Residency按整层门控，3/4子覆盖必须继续保留粗覆盖。

仅完整、不重叠loaded footprint替换的首版有26项局部控制、ESLint/TSC、57文件/713单测与build通过。真实coarse/fine Fill owners正控先red再green，3/4真实粗覆盖、mixed depth/重复面积、desired zoom上限、缩远、frustum/horizon负控均保留。但首版硬件 `city-return-coverage-after` 又揭示确认帧闪回：101首帧fine已选入，第二帧同pose恢复粗ancestor，symbol提交12→1；没有把局部green当作最终完成。

随后真实owner连续帧测试再次red：首帧4fine过，第二同pose帧回粗。将完整cached refinement独立于transient补齐，并按current pose和stable loaded-ID数组身份缓存，连续三帧保持fine，缩远恢复coarse；分别缓存Globe primary IDs，避免未确认姿态间卸载fine后制造新的请求。另一个卸载实际red→green、静止三帧同covering对象/零Native可见性扫描/无wake，合计28项局部通过。

`city-cached-detail-confirmed-production` 在713冻结源码上仅替换上述生产文件与同级测试，独立构建并冻结manifest；没有夹入同时开发的道路shader。实际109姿态硬件回归 `city-return-coverage-confirmed` 通过（24.1s），101首帧及确认帧四子ideal/renderable保持，至少一个实际可见的旧road owner同帧提交。四子footprint整体选择包含视锥外区域，不能要求全部四块都有当前Native绘制命令。此结果证明缓存覆盖正确性，不证明整体CPU P95达标。

#### 上海陆家嘴的道路透视

用户补充的实景截图显示远处道路密集成黄毯；没有提供相机参数，按地标估计相机后，以Liberty、1569×906/DPR1、121.483/31.226、高1800m、heading45°/pitch−25°的真实Native相机pose驱动独立MapLibre。`shanghai-line-view-before` 通过（1.1min），并录制1800m下pitch−45/−35/−25/−15与900/1800/3600m的8姿态。已实际查看双方initial/final及全程16时刻contact；Native远路恒宽、明显更粗密，MapLibre远路变细淡。Native57.24s、Map12.56s录像含冷初始化，不能按相同视频秒数比较，也不能据此声称公平性能。

真实固定GeoJSON对照 `line-perspective-red` 先成立：顶视两侧6条线alpha积分宽度10px、同实际CV/FOV/viewport、端点与中心投影误差约1e−9px、同Intel Vulkan硬件均通过，只有near/far透视断言red。60°倾斜east方向Native近/远10/10，Map10.133/2.565；70°Native10/10、Map7.141/1.471。north方向也有方向性差异，不能用统一depth缩放替代地面投影。

源码确认本库原在window坐标按像素外扩，MapLibre先在tile地面平面外扩再投影。首版地面外扩、投影gamma与独立devicepixel margin的 `line-perspective-ground-first` 通过同一实际MapLibre硬件对照（10.1s），top资格、近/中/远两方向、ratio及逐条absolute alpha宽度差小于0.35px；最大差0.173px。8个局部文件/97单测及TSC通过，3D使用WGS84 east/north地面Jacobian，CV/2D使用实际场景投影，8位置声明与12word记录保持。此时还不能认为3D上海、cap/join/dash/pick/near-plane或整体性能已验收；后续硬件与新projection getter控制继续进行。

`shanghai-line-view-ground` 完成独立双方真实3D重放（1.0min），实际查看initial及全程16时刻contact，并按HUD读取8姿态密集contact：远处黄色道路明显变细，原大片泛黄减轻；抬高时Native远区标签仍比Map密集，回程仍有细节补入。此轮有录像且视口大于London安静基线，不能当公平性能成绩。Native各运动首次呈现约65–180ms、Map约25–33ms，是该诊断观察，不证明所有差距均属库内。双方地面投影最大误差小于0.15px。

首轮硬件AA发现真实圆帽shared-strip回归：原RGB≤6资格下487/628的Native219,11,14对Map212,13,17；另diagonal230/529差16。恢复地面平面逆投影的端头沿线coverage后两处误差均降至1；`ground-aa-caps-final`完整16项硬件全绿（1.7min），保留10项顶视正控、2项shared-cap和4项真正MapLibre3D/CV斜视对照，原RGB≤6未放宽。新斜视端点phase3D0.01216px、CV约7.62e−8px，最大RGB误差3/1。旧斜视constant-screen-width参考已移为实际MapLibre ground framebuffer，不能继续把错误旧宽度当语义。

FLOAT夹具缺新增projection uniforms，`ground-line-float-red`真实curved2d在Native `_setUniforms`失败（6.5s）。补齐每帧实际cameraZoom/projection，独立FLOAT shader迁移地面扩展、gamma与圆帽；保持原FLOAT source位置、独立bake/topology/NativeCombine，未引用production shader。`ground-line-float-first`及`ground-line-float-modes`共12项真实硬件全绿，仍要求changedPixels=0、pick一致、VA/texture稳定、容量预算及释放。近裁剪面FLOAT等价不代表独立MapLibre裁剪形状已验收。

`ground-lines-family-visibility-final`18项硬件通过（2.4min）：三模式solid/dash paint/pick/destroy、实时near/far宽度、三个DPR/scale屏边miters/caps及八个round solid/dash opacity/buffer控制。整合ESLint→TSC→57文件719单测→build通过，冻结`city-ground-lines-final-production`273source/8dist；仅shader圆帽两文件是相对首版ground生产的增量。55项Tile边界硬件控制也通过：全球低层级与z0 buffered8、2D共享边界20在live原ground下通过；3D16及CV11以冻结ground source重跑通过。实现局部LOD期间，首次live套件被中间态热加载打断一次（ReferenceError lod），此条不作shader回归红，已以冻结source重跑对应场景。产物`ground-lines-tile-clip-final`、`ground-lines-tile-clip-frozen-remaining`、`ground-lines-tile-clip-frozen-3d`。不宣称原始目标完成。

最新 `shanghai-covering-ground` 实际诊断通过（57.2s），42帧记录cold及8相机变化的Globe/source IDs。稳定Globe换算primary为z13×11/z14×41，ideal为z13×10/z14×41；同记录相机的本地真实MapLibre coveringTiles重建为z11×2/z12×2/z13×3/z14×10。远区Native14/13724/6690中心约(676,56)，Map选择祖先12/3431/1672。初始/最终稳定缓存没有新增细ID，因此基础Globe→source LOD是首要差异；pose8第31记录又确认13/6861/3344被完整四z14缓存替换，而Map仍选z13。正在修局部透视sourceLOD，不能删近区完整缓存交接或只按中心zoom截断。

`getRenderableIds(true)`包含symbol-fade hold，52对44的统计不是52个显示标签，也不能证明8个旧owner实际绘制。标签判断需实际placement资格、submitted symbol batch和shown/opacity；当前不将该统计作为标签残留结论。

透视来源LOD已修复并冻结为`city-perspective-lod-production`（58文件739单测、ESLint/TSC/build通过）。独立实际MapLibre公共`coveringTiles()`对照先在旧构建取得red：相机与地面投影资格通过，但远区没有Map所选12/3431/1672祖先。新版`shanghai-source-lod-after-captured`27.1s通过，Native稳定覆盖23块（z11×2/z12×2/z13×3/z14×7/z15×9）、Map17块（z11×2/z12×2/z13×3/z14×10），远区祖先匹配；近区z15沿用既有overscale及父来源裁剪，并非额外请求z15数据。首次replay缺新增粗级资源属于夹具缺缓存，未当作生产red。109姿态`city-return-source-lod-after`也通过，回程101及确认帧保留旧fine细节。

用户再补充CV接近平行地面时近路巨带。实际有限GeoJSON、公共MapLibre相机API、匹配规范化相机（误差0.000148投影米）、严格硬件及75°/85°正控后，旧构建取得真实历史red：同一90°最终相机，75°路径Native宽1.858px，89.9°路径422.732px，Map两路径均60.179px。生产改为MapLibre定义的有限物理焦点，消除无地面交点时复用之前zoom；Geographic/WebMercator真实相机历史及独立公共API控制通过。冻结`city-horizon-focus-production`277source/8dist，59文件754单测、ESLint/TSC/build通过。首轮实际GPU两路径mpp均9.271036683250571、宽均60.700px；默认离地1.01米与Map零地面有0.521px差异。随后只在fixture将Native绘制平面清零，并增加实时surfaceOffset===0资格；同fixture旧739真实历史red15.6s，新754严格0.35px门槛green14.1s，未放宽。89°误差0.000025px、89.9°0.000076px、90°0.003761px；两条历史的mpp、线宽和1496红色像素完全一致。产物`line-horizon-original-zero-lift-red`和`line-horizon-focus-zero-lift`，无需额外AA生产改动。

上海CV连续64姿态录像`shanghai-horizon-focus-dynamic`34.8s通过，H120/240、pitch−15°至−0.1°。先校验public CV坐标轴回放，位置差4.78e−9m、方向差4.81e−14；最终保持陆家嘴。之前临时回放把CV世界坐标作为ECEF传入，最终跑到俄境，该录像动态部分无效，已修正e2e回放坐标轴而非生产逻辑。已实际查看initial/final与全程16时刻contact，仍见河面淡色横带，因此不宣称截图问题全部解决；正在独立有限水面/道路GPU隔离。新轮是Native视觉诊断，不作公平性能或同视角Map城市验收。

后续只读复核发现EPSILON14姿态复用能跨89.25°焦点域边界，以及Geographic CV非法纬度360°会在LngLat构造抛错。先取得独立red后，集中限制焦点输入纬度；仅在CV方向不精确相等时追加实际投影/相机的焦点域一致检查，保留两域归一化姿态复用与零额外射线。局部91项及全量59文件758项单测、ESLint/TSC/build通过，冻结`city-horizon-validated-production`277source/8dist。已有109姿态真实水面连续性`city-surface-horizon-focus`36.6s通过，但该ROI并不覆盖用户横条的全部原因。

混合层级覆盖与请求消费修复（665 项单测）使用冻结发布构建 `city-mixed-branch-wake-production`，与旧 `city-idle-preparation-production` 在无并行测试、无诊断探针的条件下做 after → before → before → after 四轮。双方独立 context，冷计时统一采用首次 loaded。

| 轮次 | Native 冷加载 ms | 冷 render / idle | 拉远 / 拉近 / 平移 / 旋转 CPU P95 ms | MapLibre 冷加载 ms |
| --- | ---: | ---: | --- | ---: |
| after | 10592.2 | 494 / 141 | 26.8 / 22.5 / 23.5 / 25.4 | 858.7 |
| before | 9673.6 | 457 / 123 | 25.9 / 17.4 / 24.0 / 24.2 | 850.4 |
| before repeat | 9727.2 | 470 / 113 | 27.3 / 22.4 / 29.4 / 24.6 | 852.8 |
| after repeat | 9594.0 | 437 / 137 | 28.2 / 23.1 / 23.5 / 24.7 | 849.7 |

四轮完整帧门槛均失败，没有稳定的整体性能收益。覆盖修复保留的依据是旧构建在同一动态水面 oracle 两次丢失像素、新构建两次连续保留，不能将缺失水面减少的绘制成本视作性能优势。产物分别为 `city-mixed-branch-wake-after`、`city-mixed-branch-wake-before`、`city-mixed-branch-wake-before-repeat`、`city-mixed-branch-wake-after-repeat`（均位于 `node_modules/.cache/playwright/`）。

另一次 `city-cold-scheduler-reasons` 是诊断轮次，不能与上述公平计时同比。按冷 milestone 的绝对时间对齐，604 个实际 tick 中为 468 render / 136 idle；探针从第 16 个 tick 起记录 589 个，其中 466 render / 123 idle。首次任务至最后任务的跨度 7785.6 ms，实际任务 admission→return 区间内无已提交任务约 4273.3 ms。136 个实际绘制帧没有已提交任务且没有新 admission，但有可运行的 owner；这些帧都拿到了正常或最低 upload 服务量，不能归因于 upload 未获调度。

实际准备推进有 1526 次调用（copy 568、restore 473、slot 485），累计被包裹调用 CPU 393.7 ms，探针自身 238.8 ms；这些时间并非完整 Scene 独占成本。74 个 owner 的 packet copy 跨多 tick，其中 owner 174 的两个 copy 分类调用合计约 0.7 ms，相关全部推进约 1.1 ms，分散在约 533 ms 内；中间还存在实际满槽等待，不能将整个跨度归为游标问题或将 phase 分类当作完整 packet 复制成本。真实游标在一次部分复制后转向尚未开始的兄弟，产生了一个可定向复现的调度问题：Worker 空槽时，已 admission 的 packet 未连续完成。新增真实 TaskProcessor、typed-array copy、共享 Scene budget 的回归在旧游标上失败；只保留当前 packet 游标的候选通过 ESLint → TSC → 56 文件 / 666 单测 → build，冻结为 `city-packet-continuation-production`。

该候选在相同安静 ABBA 中未得到稳定整体收益，已撤回两文件改动，生产源码恢复到 665 项验证的构建。候选和实验测试保留在缓存快照以供诊断，不作为当前回归或目标达成证据。

| packet 候选轮次 | Native 冷加载 ms | 冷 render / idle | 拉远 / 拉近 / 平移 / 旋转 CPU P95 ms | MapLibre 冷加载 ms |
| --- | ---: | ---: | --- | ---: |
| after | 9241.4 | 416 / 137 | 27.3 / 22.6 / 25.2 / 24.5 | 867.5 |
| before | 9511.1 | 431 / 138 | 28.2 / 22.1 / 25.3 / 28.4 | 863.5 |
| before repeat | 9145.2 | 411 / 137 | 30.0 / 24.1 / 25.1 / 26.2 | 847.1 |
| after repeat | 9659.8 | 435 / 143 | 30.5 / 21.4 / 28.2 / 21.8 | 839.7 |

对应产物为 `city-packet-continuation-after`、`city-packet-continuation-before`、`city-packet-continuation-before-repeat`、`city-packet-continuation-after-repeat`。四轮完整帧门槛全部失败。

665 构建另录完整连续运动 `city-mixed-branch-whole-motion-video`，实际语义用例通过（40.5 s）；Native/MapLibre 分别独立 context，连续 109 姿态，最终均恢复 ready。已看完 16 时刻全程 contact，并密集核对 orbit 的姿态 84–101：双方约 87–100 段均有大片空白，不能只凭 Native 录像判定为新的库特有覆盖丢失；新区域回来时 Native 细节仍较慢。录像、全程 contact 和密集 orbit contact 分别保存为 `cesium-motion.webm` / `maplibre-motion.webm`、`*-motion-contact.png`、`*-orbit-detail.png`。录像只支持该诊断观察，最终 ready 和水面单点连续性通过不能代表整个动态体验已达标。

#### Native 更新成本与实际绘制归因

`city-native-owner-update-census` 通过实际城市诊断（1.5 min，未开启整帧验收断言，不是性能达标）。探针监听 Native preUpdate/postUpdate/postRender，保留库的 Scene.render 预算包装器；测原始 Primitive.update，按实际成功 Context.draw 的 VA 关联，sharedVA、unknown 和 noSubmittedCommands 分开。没有 observer error、帧外 Native update 或 renderError。全量明细首轮为 229 MB；后续仅保留最近 60 tick 与每 60 tick 的代表明细，完整汇总仍保留。首版直接包装 Scene.render 会破坏预算所有权，已在运行前撤掉，未把该版用作证据。

实际 origin 为 4031.0 ms；连续 1077 个 tick 与 motion recorder 匹配（首 tick 对应 recorder 第 15 条），末尾 7 tick 是 snapshot 后尾部。首次 loaded 为绝对 14806.2 ms，真实 cold 截止 tick632；轮询的 throughTick677 不能作为 loaded 截止。

| 动态阶段 | ready Native CPU P95 ms | exclusive 未绘制 line/dash CPU P95 ms |
| --- | ---: | ---: |
| 拉远 | 2.8 | 1.0 |
| 拉近 | 1.9 | 0.6 |
| 平移 | 2.4 | 0.7 |
| 旋转 | 2.1 | 0.7 |

216 个实际动态绘制帧，完整 Scene CPU 4017.4 ms，ready Native update 247.2 ms（6.15%）；exclusive 未绘制 line/dash 为 58.7 ms，平均 0.272 ms/帧。即使按同帧静态扣掉该时间，P95 也仅从 29.0/26.3/29.2/25.4 变为 28.9/26.0/29.0/25.2 ms；这是算术上限，不是优化结果或安全裁剪证明，因此没有实施提前跳过 Native 更新。

cold 中 468 个 COMBINED→COMPLETE 首次 Native 调用共 230.6 ms，分为 line227/72.8ms、dash161/76.0ms、outline68/20.8ms、extrusion12/61.0ms；发生在264个tick，首末跨度8.400s。348个前置 COMBINING→COMBINING 调用共54.9ms，包含 BatchTable 和其它 Native 检查，不能当 BatchTable self。完整 cold render CPU6067.0ms，探针覆盖的 Native update合计706.4ms，其中305.8ms是已完成owner的反复更新。位置纹理构造、packet准备与恢复在此 Native 调用之外，故230.6ms不是完整准备或纯GPU耗时。Native更新和最终屏外过滤都不足以解释剩余冷加载与整帧差距。

探针自身683.7ms，其中microtask汇总66.6ms，动态阶段292.7ms；诊断干扰大于某些被测小成本，不能拿该轮cold10.775s或动态P95与安静ABBA同比。当前仅用它降低低收益方向的优先级，并继续定位首批数据就绪、预算化构建和短任务推进的时间链。

2026-10-08修正冷计时协议：此前 `coldElapsed=cold.elapsed` 是Playwright轮询发现就绪后的观测时刻，默认轮询间隔可达1000ms，另受浏览器调度影响；下文既有cold数值均为该观测上界，秒级差异不能单凭一次pair归因。当前夹具在每次Native Scene更新/MapLibre render返回后，以同一ready谓词锁存首次loaded milestone，`coldElapsed`改用它，`coldObservedElapsed`保留轮询时刻，cold frames/ticks按首次loaded截断。Native idle也可首次ready，不能只在postRender帧锁存。这仍是loaded/已有命令提交指标，不是首个glyph fragment可见时间；新旧cold协议不能直接同比。

## 独立真实城市基线

新增 `e2e/city-performance.spec.ts`：同一冻结 Liberty 数据、1280×720、DPR1、80 ms 瓦片延迟，分别在独立 context 串行运行 Cesium 与 MapLibre。记录完整 Scene / Map 绘制 CPU，以及每次相机修改到实际绘制的延迟。轨迹从 Cesium 实际相机生成，再交给 MapLibre 重放；包含 24 步拉远、24 步拉近、24 步平移和 36 步旋转/倾斜。冷计时从原生 Globe 稳定后加入库开始，模块加载与裸 Scene 初始化不计入。

修复前的两轮完整帧测量表明：Native 动态阶段 CPU P95 约 28–37 ms，MapLibre 约 6–8 ms；冷加载约 9.2–9.4 秒对 1.2 秒。整帧 P95≤16.67 ms 的门槛实际失败。第三轮加入冷 profile 与裸场景控制，裸 Native 在同轨迹的 CPU P95 仅 1–2 ms；城市内容提交 347–725 条命令，无 GPU 预算驱逐。该轮还开启 fixture 的 FPS overlay，后续协议移除它；所有新旧性能比较必须使用相同 fixture。

冷 profile 含页面设置阶段，动态 profile 从 ready 后开始，二者不得混用。Native 的实际 TaskProcessor 回包已有全局 Scene 唤醒；继续检查的是库内等待期间的重复帧请求，以及大量准备/绘制命令的成本。

单变量实验将 3D 线分块上限从 6000 增至 24000，冷命令只从 724 降至 704，冷加载仍约 9.4 秒，未采用该调参作为修复。

实际站点诊断记录 feature ID、当前 owner、CPU opacity 和屏幕碰撞盒。Waterloo / Westminster / Green Park 的两组近距文字来自不同站点入口，盒不重叠，MapLibre 动态复验后也显示相同入口；不能仅凭重复名称删掉有效标注。

产物：`node_modules/.cache/playwright/city-independent-capture`、`city-independent-before-profile`（保留失败门槛）、`city-before-cold-bare`、`city-chunk-experiment`、`city-stations-before`。这些是诊断基线，尚未构成原始目标的完成验收。

### Worker 实线与等待调度复测

Worker 实线编译、初始化属性 facade 缓存和 pending/runnable 分离整合后，ESLint、TypeScript、41 文件 / 391 项单测和构建通过。完整城市门槛仍失败，不能据此完成目标。

关闭双方 fixture 的 FPS overlay、使用同一最新夹具复跑冻结旧 source：旧版本冷加载 9371 ms / 427 个实际绘制帧，运动阶段完整 CPU P95 为 34.0 / 28.6 / 34.9 / 36.5 ms（拉远 / 拉近 / 平移 / 旋转）。本轮对应为 9821 ms / 411 帧，以及 34.9 / 30.8 / 30.7 / 32.3 ms。MapLibre 冷加载约 1200 / 1188 ms，运动 P95 约 5–7 ms。这一对测量没有显示足够的冷加载改善；阶段差异不能当作稳定吞吐收益。

本轮冷完成提交 724 条库命令：line 287、dash 161、fill 89、fill-outline 68、symbol 89、pattern 17、extrusion 12、background 1。独立语义诊断发现其中 76 条 uniform line/dash 命令的 width 为零。该诊断另录连续缩放、平移与旋转录像，不将录像轮次耗时纳入性能比较。

Worker 实线几何样例传输从 9960 B 增至 51026 B；打包 view 的 backing buffer 还可能被后续 Native create 消息整块克隆。后续工作继续检查这个传输边界、无可见像素的命令，以及 12 ms tile 加独立 2 ms collision 预算不能约束完整 Scene 帧的问题。

产物：`node_modules/.cache/playwright/city-fps-off-before`、`city-worker-runnable-after`（保留完整帧失败）、`city-worker-runnable-profile`、`city-command-video-diagnosis`。最新性能与语义证据优先于下文较早阶段的验证记录。

### 当前整合与未完成项

已补充零 width/opacity uniform line 的最终命令过滤、Native 几何消息的独立 backing buffer 所有权、Scene 统一预算，以及不受重型 paint 预算阻挡的相机 uniform 更新。3D 倾斜视角的发布排序现按实际屏幕中心落地点；真实相机用例中旧实现优先下沿瓦片 `2724`，修复后先发布中心瓦片 `2725`。这些改动尚待整合后的完整检查和独立城市性能复测，不能沿用旧阶段的通过数量。

新的软件渲染 dash 样式交接回归曾在原有 15 秒门槛失败。实际探针中队列持续推进，14.665 秒只有 63 个绘制帧，Scene CPU 为 222–249 ms，可延迟准备平均只有 0.477 ms/帧；六个 job 的实例和阶段游标持续变化，没有 Worker 等待卡死的证据。调度修复过滤隐藏/未就绪参与者，在实际可运行阶段间轮转，同一 Scene quota 内继续推进；最低服务量按 mandatory P95 的 5% 分配，2 ms 下限、16.67 ms 上限，不压低真实 mandatory 估计。原用例在无其他测试/生产编辑的复跑中通过，加载门槛仍为 15 秒；像素、拾取、透明排序和销毁断言保留。该软件过载用例不代表真实城市 FPS 验收。

Native packet 使用单个独立对齐 owner，512 实例的真实 structuredClone transfer 从 2048 个 owner 降至 1 个 / 65536 B，来源与缓存 backing 不 detach。混合类型 packet 允许必要且受限的 alignment padding。失败路径释放不可再上传的网格存储，保留实例元数据和 Native 错误传播。冻结源码控制中的真实 Native Worker normal/CDN/missing-create/missing-combine 四项验证通过，产物为 `node_modules/.cache/playwright/native-one-owner-transfer-verification`；stock Float64 中间复制和整体 staging 峰值仍存在。

新增可选的 `E2E_CITY_WORKERS=1` 消息诊断和 `E2E_CITY_STAGES=1` 冷阶段诊断。后者区分首次库命令、首次 symbol 命令和全部 loaded，并记录已激活、已上传非零 opacity、屏内且有实际命令的选定车站；MapLibre 记录首次查询到 symbol feature 和选定车站。命令提交及 CPU/VBO 状态不证明实际 glyph fragment 已产生，这些指标不能作为完全相同的像素可见性事件比较；仍需要连续画面和像素核对。诊断轮次和默认性能轮次分开运行。

已冻结 Scene 调度与单 owner packet 完成后的 252 个 source 文件及 SHA manifest：`node_modules/.cache/temp/city-before-independent-symbol`。后续继续解决独立 symbol publication，以及结构重载期间旧 uniform collection 的 camera paint 被同时冻结的问题。

这份完整冻结源码在双方独立 context、无其他测试/编辑的串行复跑中仍未达到完整帧门槛：Native 冷加载 14406.8 ms / 678 个实际绘制帧，冷 CPU P95 16.7 ms；拉远 / 拉近 / 平移 / 旋转的完整 CPU P95 为 27.7 / 20.5 / 28.2 / 24.3 ms。MapLibre 冷加载 1159.2 ms，对应运动 P95 为 6.9 / 5.4 / 8.3 / 6.0 ms。相比此前关闭 FPS overlay 的冻结控制，动态 CPU 尾部有所下降，冷加载却从约 9.4 秒增至 14.4 秒。这不是目标完成的证据，后续必须核对重复绘制与实际准备吞吐。产物：`node_modules/.cache/playwright/city-scene-packet-before-symbol`。

独立 symbol publication 的五文件 / 57 项定向验证通过：符号不再等待 vector 和 pattern 完成，部分代次恢复只补缺失 track；缓存恢复仍检查 buckets / schema / mode，完整可见 owner 的 collision 激活条件保留。结构或模式重载的旧 uniform line 现固定已提交样式与 transition 时间，但继续按相机 zoom 求值；旧 record 被替换后，仍绘制的旧 collection 继续更新，销毁后释放快照。包含上述最终 symbol 源码的真实 Native solid / dash 3D 两项回归通过，验证归零和恢复、旧 record 替换后的交接、像素、拾取及 GPU 资源身份。延迟且零时长 transition 的精确终点 NaN 另有真实单元红→绿。上述是定向正确性验证，仍待全量整合及城市首次符号响应复测。

同一城市控制还暴露纹理图案恢复缺失：冷完成有 12 个 pattern tile / 17 条 pattern 命令，连续运动回到初始视角后却为 0，队列已为空。真实 PatternRenderer 的 commit → retire → 永久清除 → 相同输入恢复已复现四个红用例；退休资源已经销毁，旧 tileState 仍让 begin 返回无更新的 complete。后续修复这个资源与完成状态的生命周期，并用连续运动核对，不能把少画图案带来的 CPU 降低作为性能改善。

### 独立符号与资源恢复后的检查

独立 symbol、旧 collection 相机 paint 和 pattern 生命周期修复整合后，ESLint → 完整 TypeScript → 50 文件 / 457 项单测 → 库/demo 构建通过。Pattern 的真实连续运动回归先在冻结旧源码失败：平移、跨 minzoom 拉远、旋转再返回后，资源已经驱逐，队列为空，但最终像素仍为地面色，60 秒内未恢复。修复后同一用例 11.6 秒通过，图案像素、命令和加载状态恢复，无页面错误。产物：`node_modules/.cache/playwright/pattern-motion-before`、`pattern-motion-after`。

修复后的 255 文件 source 冻结在 `node_modules/.cache/temp/city-after-independent-symbol`。无其他测试/编辑的严格城市重放仍未达标：Native 冷加载 **17081.3 ms / 775 个实际绘制帧**；拉远 / 拉近 / 平移 / 旋转的完整 CPU P95 为 **27.4 / 18.8 / 30.1 / 23.1 ms**。MapLibre 冷加载 1199 ms，对应运动 P95 为 7.6 / 7.0 / 5.7 / 6.3 ms。Native 冷和最终均有 648 条库命令，其中 pattern 为 17 条、最终 12 个 pattern tile；不能将旧轮次缺少图案时的耗时当成相同输出的比较。记录全部 Scene.render 调用后，冷阶段 977 次调用中有 202 次未绘制，未绘制 CPU P95 为 0.2 ms；静止阶段没有实际绘制。产物：`node_modules/.cache/playwright/city-independent-symbol-replay-after`，完整帧门槛保留失败。

另一次启用 profile、消息和阶段观测的诊断中，首次 symbol 命令约 3271 ms，首次选定车站提交约 3272 ms，全部 loaded 约 16966 ms。提交状态不能证明实际像素首次可见；连续录像单独核对，也不将诊断轮次的耗时作为公平性能数据。真实 Native 消息观察到 549 次 create，输入约 85.6 MB、Float64 中间回复约 148.9 MB；468 次 combine，输入约 155.7 MB。运动期间没有新增这些任务。消息往返含排队和主线程等待，不等于 Worker CPU，重叠任务的时长也不能相加成 wall time。冷 profile 含页面设置，动态 profile 从 loaded 后开始；重复 uniform 求值与几何中间打包成本是下一步处理对象。产物：`node_modules/.cache/playwright/city-independent-symbol-profile`。当前后续缓存和 owned Worker 改动尚未通过整合验收，原始目标保持进行中。

### Owned geometry Worker 与排布服务复验

262 个 source 文件及 SHA manifest 冻结在 `node_modules/.cache/temp/city-owned-worker-late-placement`。Native geometry preparation 由库自己的单次 Worker 任务完成，绕过 stock create 的 Float64 中间打包，同时在 Worker 编译线位置纹理；主线程保留受限复制、实例元数据、最终 Native 上传与错误所有权。Worker 使用真实 context 能力，与主线程 Cesium VERSION 严格一致。重复实例的 bounds 独立，源与缓存 backing 不被 detach。

相机 uniform 按 evaluated paint 对象与准确 zoom 缓存；未首次上传的旧 line family 保留已提交 uniform/instance paint。Scene 的 placement 最低服务预算在必要属性/投影准备之后、真正开始 collision 时发放，避免新发的额度在进入 collision 前已耗尽。同一 Scene、不同 scope 和 viewport 仍共享一次额度。真实 Native 属性上传模拟耗时 3 ms 后，排布从一对推进到约 20 对的红→绿回归通过。

上述整合的 ESLint → 完整 TypeScript → 52 文件 / 479 项单测 → 库/demo 构建通过。硬件 Native owned Worker normal/CDN/missing/messageerror/cancellation 五项、真实 tarball Node/types/archive/Worker 消费六项及 3D solid/dash 两项通过。CDN 页面明确允许 Cesium runtime 所需 eval/wasm-eval，不声明无 eval 的页面兼容。

默认完整城市测量仍保留失败：Native 冷 **12452.2 ms / 532 个绘制帧**，拉远/拉近/平移/旋转完整 CPU P95 **27.3 / 16.4 / 23.2 / 23.0 ms**；MapLibre 冷 929.4 ms，对应 7.7 / 5.3 / 4.9 / 5.3 ms。冷与最终内容均保留 17 条 pattern 命令；静止 0 绘制，停下后 settle 21 个绘制帧（此前 59）。产物 `node_modules/.cache/playwright/city-owned-worker-late-placement-performance`。这一轮体现改善，仍不满足完整帧门槛。

同 source 连续录屏、109 个匹配视角及 readiness 诊断在 39 秒完成，运动结束后首次 poll 已 ready；此前 255 控制录屏中仅 collision 排布尚未完成，最终等待约 54 秒。两轮录屏耗时不作公平 FPS 数据。当前匹配视角的四个附近地面点投影最大误差低于 1 CSS px，不外推整幅椭球与平面投影完全相同。

逐段视频仍发现快速拉远时旧排布符号压缩成密集团簇，属于原始目标未完成项，不能用终态 ready 代替验证。双方快速缩放/倾斜时都有外围背景未加载，须逐视角区分新增区域暂无数据与库误藏已有父瓦片。此前 255 有一次全部符号晚消失的失败录屏，后续录屏未再次复现，仍不能宣称已证明其根因。产物 `node_modules/.cache/playwright/city-owned-worker-late-placement-video`。

新 262 motion profile 中 Cesium self 分类约 2001 ms、库 self 约 1515 ms；Native 普通 draw、每帧线标签投影、来源同步与命令准备均有成本。Profile 数值含采样开销，只用于定位；inclusive 子时间不得与父时间相加。产物 `node_modules/.cache/playwright/city-owned-worker-late-placement-profile`。继续处理可证明的重复工作和运动当帧的符号密度，目标保持进行中。

### 当前视图过滤与跨级缓存覆盖

完整排布仍按冻结视图异步推进；已完成排布的 selected 实例在当前视图联合投影/碰撞过滤，复用相同 overlap、optional 与 text/icon 配对规则。过滤不改写候选基线，反向缩放可恢复，原来 hidden 的候选只在完整新 pass 后进入选择集。1000 个点的回归中仅 2 个已选候选被实时投影；真实 opacity VBO、held/new generation、priority、fading 和配对规则通过。

新增第二个红：已有符号在相机返回后恢复 [1,1,0]，旧 offscreen job 完成却再次写成 [0,0,0]。完成 pass 的统一提交判定现在在 opacity 写入前阻止 stale 结果覆盖已有可见 owner 的 baseline；job 仍完成并排队下一视图。混合 handoff 保留 unaffected baseline，并与新 owner 联合过滤。此修复没有证明 stale 新 owner 的全零交接已解决，仍需独立验证。

跨级覆盖的真实 owner 红：缓存中已有已上传 z13 父 surface，z14 相机返回时 Globe 仍保留旧视图，首帧未提交该父。加载数据补充查询现覆盖限定父子 LOD 范围，避免与 Globe primary 父子重叠；旧集合首帧恢复且零 fresh request。内容版本缓存避免相机/active-cache 转移重新枚举，load/reload/fail/unload/expiry/eviction/clear 均验证失效。GPU 提交在 jsdom owner seam 替代，不能称为 Browser 像素证据。

重型 paint 最低预算同样改在 live camera paint 之后领取；真实根调用顺序红由 0 单元推进到受限约 20 单元，同物理帧第二视口无新额度。

这些改动与精确 Cesium peer/dev 契约整合后，ESLint → TypeScript → **53 文件 / 502 单测** → 库/demo build 全绿；实际发布 tarball 6 项通过。source 263 文件及 SHA 冻结为 `node_modules/.cache/temp/city-live-selection-cross-lod`。真实连续 video 38.4 秒通过，运动后首 poll 已 ready；逐段解码显示快速拉远的原旧符号团簇明显稀疏，返回后符号保留。视频属于动态正确性诊断，不作公平 FPS 统计。

不带视频/采样/阶段探针的独立完整城市复测仍失败：Native 冷 **12184.6 ms**，拉远/拉近/平移/旋转完整 CPU P95 **24.9 / 20.1 / 22.8 / 22.0 ms**，停下后 23 个绘制帧；MapLibre 冷 931.6 ms，对应 7.9 / 5.2 / 7.6 / 5.1 ms。冷和最终 pattern 均 17 条，symbol 均 89 条，输出未通过遗漏图案来提速。产物 `node_modules/.cache/playwright/city-live-selection-cross-lod-performance` 与 `city-live-selection-cross-lod-video`。完整帧仍未达标。

最新 readiness 还发现 3 个完整 symbol entry、共 23 个 ready/show/挂载 Native Primitive，其所有 CPU 实例 opacity 为零且无 dirty/pending；尚缺最终 command owner 关联，不能从 39 个零 geometry part 直接推算 39 条命令。正在真实 owner seam 验证全不可见 ready owner 的 Native 排队与恢复路径；目标仍在进行。

### Ready 全不可见 Native owner

冻结源 `city-zero-native-owners`（263 文件）新增两个跳过更新的条件：合并 symbol owner 已 ready、所有 half 的已上传 opacity 为零、没有待上传属性或 BatchTable fade dirty；line family 已完成 Native 初始化、所有 replay layer 均为 uniform 且 width 或 alpha 为零。首次准备、instance paint、可见 sibling 和恢复路径仍执行 Native update。symbol 可见性缓存只在最终 opacity 上传成功后扫描，VA 未到达或 pre-ready 的失败重试不扫描数组。

真实合并 symbol owner 红→绿：三个 half 合并成两个 owner，ready 全零时五帧的 Native delegate 调用由 10 次变为 0；partial sibling、fade dirty、动态属性 pending 和 SceneCollections 首更新控制保留。另一红→绿覆盖 pending 上传重复扫描：VA 未到达四帧扫描四次变为零，pre-ready 再四帧仍零，最终上传后 CPU/GPU 和缓存一致。这些单测在 GPU 上传边界使用 spy，不代表浏览器帧率。

ESLint、完整类型检查、53 文件 / 510 单测和库/demo 构建通过。真实硬件 3D solid/dash 两个线族用例通过；新增 solid 全透明场景在四个相机驱动的实际绘制帧中 Native owner update 为零，随后恢复原 VA、position texture、像素及道路/外框拾取，未重新请求瓦片。实际城市整帧复测未达标：Native cold 14.3079 秒，拉远/拉近/平移/旋转完整 Scene CPU P95 为 29.8 / 22.9 / 26.4 / 26.6 ms；MapLibre cold 1.1960 秒，对应 8.0 / 6.6 / 6.6 / 5.2 ms。cold 与最终 symbol 提交由 89 条变为 55 条，其他 kind 数相同，但本轮没有证明整体提速。7 个非实网连续 camera 用例均通过；独立录像诊断 52.5 秒通过，Native ready 首次检查即满足，MapLibre 对全部 109 个 Native 相机姿态的近中心地面投影最大误差为 0.120 CSS px。录像诊断的时长不可用于公平帧率比较。新 owner stale 全零交接修复及 standalone dash 的 ready 更新优化正在后续版本验证，不计入此冻结测量。

### 空 successor 交接、dash 与已选中道路标签

`city-stale-handoff-dash-zero` 冻结源新增两项修复。旧相机排布生成的全零 successor 不再提前退役仍有可恢复候选的旧 owner；当前相机的合法全零结果仍可交接，无旧覆盖的首次加载也不阻塞。完成旧视图的非空排布后会继续追赶当前视图，最终恢复 idle。真实 residency 控制用例在关闭 guard 时复现旧 owner 提前隐藏。standalone dash 已 ready、Native COMPLETE、uniform width/alpha 为零且无 BatchTable dirty 时跳过 Native delegate；不套用到可能有可见 sibling 的 line family 主 owner。实际硬件 dash 四个相机帧的 Native 调用红→绿为 48→0，恢复时正控制确实再次调用 Native，原 VA/texture、像素和拾取恢复。54 文件 / 520 单测、类型检查、ESLint、构建及 3D solid/dash 浏览器用例通过。

`city-selected-line-projection` 冻结源与 dist 保留上述修复，并使 live line symbol 投影只访问完整排布基线中的候选实例。完整碰撞排布仍处理所有 pair；临时被当前相机隐藏的基线候选仍可恢复。没有基线时仍排空初始/待上传动态属性，新排布在同相机完成也更新实际 GPU dynamics。1000 个实例、两个基线候选的实际 owner 控制中，相机更新的投影回调从 1004 降到 6，隐藏实例数值访问从 1996 降到 0；GPU 边界在单测中替代，不能外推为整帧提速。54 文件 / 525 单测、完整检查与构建通过，7 个连续 camera 浏览器用例通过。

独立默认 Source 入口复测仍未达标：Native cold 13.3374 秒，拉远/拉近/平移/旋转完整 Scene CPU P95 为 31.6 / 22.0 / 28.2 / 23.5 ms；MapLibre cold 1.1795 秒，对应 8.0 / 4.9 / 9.0 / 6.4 ms。另用冻结 dist 与 Cesium 官方 `Build/Cesium/index.js` 生产 ESM 做一次串行前后对照，双方 MapLibre 均为生产 dist：520 版本 Native cold 13.0573 秒、P95 31.0 / 20.9 / 27.0 / 24.8 ms；525 版本 cold 11.1041 秒、P95 27.3 / 19.3 / 24.0 / 23.5 ms。对应 MapLibre cold 0.9729 / 0.9997 秒、P95 6.9 / 6.2 / 6.3 / 5.2 与 7.2 / 4.9 / 5.6 / 5.6 ms。两版 cold/最终均有 614 条同 kind 命令（symbol 55、pattern 17），静止绘制帧为零。单轮对照不能证明稳定整体提速，生产入口同样未达到 16.67 ms 门槛，不能将剩余差距归因于开发入口。

实际生产 ESM alias 经 Vite metadata 确认；Cesium prebundle 中 debug `Check.typeOf.object` 调用从 Source 的 1086 处变为 2 处，未通过只设置 NODE_ENV 冒充生产构建。原始数据：`city-selected-line-source-performance`、`city-published-production-before-selected-valid`、`city-published-production-after-selected`。没有 `-valid` 的首次生产入口轮次因 URL 缺少 Vite base 造成 404，不计入任何比较。

后续默认 Source CPU 采样 `city-selected-line-source-profile` 中 library self 1602.0 ms、Cesium self 2153.7 ms；symbol renderer inclusive 306.2 ms，旧零 owner 版本为 455 ms。阶段包含关系和不同采样轮次阻止直接相加或将差额当作公平整帧收益。新的热点包括逐要素道路几何校验（sameLineGeometry self 43.6 ms）及 Native 绘制调用。整体目标仍在进行。

最新冻结发布包 + Native 生产入口连续录像 `city-selected-line-published-video-valid` 通过（51.4 秒诊断、Native 视频 39.6 秒）。运动后首次 poll 已 ready，双方各自目标 feature 行在运动前后为 Native 59→59、MapLibre 20→20；这些是语义记录，不是可见标签数量。109 个匹配姿态的近中心地面投影最大误差 0.120 CSS px。逐段解码检查缩放、平移、旋转/倾斜及最终静止；放大返回后的道路和标签恢复并保留。快速拉远/拉近仍出现外围未覆盖区域，MapLibre 同轨迹也出现空白，因此不能仅由录像将空白归因为 Native 退役错误，仍需逐帧覆盖与请求证据。首次 `city-selected-line-published-video` 因诊断夹具使用源码 `instanceof SymbolBucket` 排除了发布包对象而失败；已按实际 symbol 图层识别 bucket 后重测，未修改生产渲染。

### 数据 Worker 的发布依赖

新增真实 packed data Worker 浏览器控制，不提供 Worker import map，发送实际 WorkerChannel 样式消息。旧包启动失败，无法回复；`data-worker-import-map-red` 保留红产物。道路生产者为读取 `lineInputs` 从 `geometry-primitive` 导入再导出，因而把 Native Scene adapter 拉入数据 Worker；发布 worker 又静态导入共享模块中的 bare `cesium`，document import map 不作用于 Worker。

拓扑 WeakMap 现由独立 `line-input.ts` 所有，所有生产/测试导入直接指向它，不保留旧 barrel。main、data Worker 和 geometry Worker 分别构建；data Worker 内置其实际使用的 Cesium CPU 依赖。新 data bundle 579.49 kB、314 个 sourcemap source，其中 33 个 Cesium CPU source；无静态外部 import、Scene、Widgets 或 geometry-primitive source。几何 Worker 仍为 202.25 kB，main 为 685.71 kB。原先 main 与 data Worker 共享代码，现在两个 realm 各自包含需要的代码；数据 Worker 不再依赖整套外部 Cesium ESM。传输继续使用命名 registry 及数组 DTO，主线程恢复 Geometry 时重新登记本地拓扑，WeakMap 无需跨线程共享。现有上游许可覆盖 bundled CPU 依赖。

ESLint → TypeScript → 54 文件 / 525 单测 → 库/demo build 通过；`data-worker-standalone-published` 七项真实发布消费者通过，包含 Node ESM/CJS、类型、archive、CDN geometry Worker 和新增 data Worker 无 import-map 回复。源 265 文件与 dist 9 文件 SHA 冻结为 `city-standalone-data-worker`。

新一轮安静串行生产入口对照 `city-data-worker-production-before/after`：Native cold 11.9707→11.5353 秒，拉远/拉近/平移/旋转完整 Scene CPU P95 26.6 / 20.7 / 28.9 / 27.1→26.4 / 20.9 / 26.3 / 26.6 ms。MapLibre cold 1.0282 / 0.9908 秒，对应 P95 7.4 / 6.7 / 5.7 / 5.9 与 7.8 / 5.9 / 6.3 / 6.1 ms。双方 Native cold/最终 kind 数相同、总计 614 条，stationary 绘制为零。首次 commands 超过纯背景的时间为 2.3079→1.4353 秒；这只是首内容提交观测，不等于全部 Worker 启动耗时。完整 cold 和动态门槛仍失败，没有将发布 bug 修复宣称为整体体验完成。

最新发布包连续录像 `city-data-worker-production-video` 通过（48.2 秒诊断），运动后第一次检查已 ready；语义行仍为 Native 59→59、MapLibre 20→20，全部 109 个匹配姿态的最大投影误差 0.120 CSS px。剩余冷加载在首内容后仍逐步提交命令，必须继续检查构建/首次上传服务和 Native 绘制成本。

### 命令派生缓存与首次更新推进（2026-10-08）

Line family replay 不再逐帧用 Native shallowClone 重置 dirty 与 lastDirtyTime；持有各 layer 的命令，通过实际 Native setters 同步变化字段，只有原 uniform map 身份改变时重建 overlay。Native base update、真实 shader/pass/VA/bounds/modelMatrix 失效仍保留。符号绘制 pass 在最终遮挡判定后只赋值一次，避免稳定 OVERLAY 每帧先改 OPAQUE 再改回。真实 Native 派生命令单测及道路硬件红→绿控制：四个相机驱动 postRender 帧，log-depth 派生调用从 24 次变为 0，仍有 6 条道路命令，VA 与位置纹理身份保持。

首次更新游标在消费进度前跳过等待 Worker 的 child，防止等待 child 用掉过载帧唯一的推进机会。真实 GeometryPrimitive/TaskProcessor seam 复现：第一条线等待真实任务回复、第二条线可执行，mandatory paint 已耗尽额度；旧实现第二条复制 0 bytes，修复后推进一个不超过 16 KiB 的实际 owned copy，等待 owner 不重发任务。显示、隐藏与同物理帧第二视口控制保留。

ESLint → TypeScript → 54 文件 / 531 单测 → 库/demo build 通过；冻结 `city-command-validity-upload-progress` 为 265 source 文件、8 build dist 文件（pack 的 prepack 会另生成许可文件）。后增硬件派生控制单独通过 ESLint 与完整类型检查。14 项硬件连续 camera、solid/dash 三模式道路、pattern 用例通过，产物 `command-validity-upload-browser`；latest published 连续录像 `city-command-validity-production-video` 通过并逐段查看，道路与标签缩放返回后恢复。

安静串行生产入口对照 `city-command-validity-production-before/after`：Native cold **10.4920→11.4500 秒**，拉远/拉近/平移/旋转完整 Scene CPU P95 **27.5 / 23.9 / 33.0 / 24.0→27.7 / 15.4 / 25.8 / 25.8 ms**。MapLibre cold 0.9764 / 0.9681 秒，对应 P95 7.5 / 5.3 / 6.6 / 6.1 与 7.4 / 7.0 / 6.1 / 5.2 ms。两轮 Native cold/最终库命令均 614 条、kind 数一致，另有 15 条 Native 场景命令。单组结果不证明稳定整体提速；cold 未改善、完整运动门槛仍失败。

Opt-in 冷准备观测 `city-cold-upload-diagnosis` 不计公平性能：537 个观测 cold 帧约 10.26 秒，upload 累计 871.1 ms、build 累计 784.7 ms、243 帧获得 continuation。说明必须进一步核查实际准备服务和 Native 绘制成本，不能从阶段 CPU 或本轮回归通过判定六项目标全部完成。观测器现在只记录真实领取的 frame work，避免诊断自身创建不存在的预算帧。

### 道路批次容量的排除实验

仅在临时冻结 Source `city-line-capacity-experiment` 将 3D vertex cap 6000 改为 24000，512 instance、planar cap、任务槽和预算均保留。与冻结531 Source、相同 Native production 入口串行对照：库命令 614→596（line 254→244、dash 118→110，其他kind不变），cold 13.1013→12.9723 秒；完整运动 P95 26.6 / 21.1 / 30.7 / 26.1→28.8 / 22.4 / 26.1 / 34.9 ms。该试验不涉及当前发布包；不与 published 数据交叉比较。没有证明整体改善，未合入生产参数。产物 `city-line-capacity-source-before/after`。

关联531 published真实任务与准备队列的诊断 `city-upload-worker-service-diagnosis-fixed`：468 次 owned prepare，从首任务到末回复跨度约 9.27 秒，inflight=0 累计 6.81 秒，1为1.49秒、2为0.97秒。一个 context 实际只有一个 Worker，2是未回复任务上限；空槽同时包含尚未构建出输入、主线程准备和浏览器调度，不能称为纯 Worker idle CPU 或两线程利用率。首个探针版本错误地假设 budget lease 在挂载前存在，诊断失败；修正后记录真实领取的 lease，不生成预算帧。正在证明已回复恢复被其他任务占槽截断的问题，尚未计为完整体验改善。

### 已回复准备与扩大 bounds 的命令所有权（2026-10-08）

新增真实 prepareGeometry/TaskProcessor 回复控制：A 返回 96 个 CV bounds 后，B/C 两个未回复任务占槽，A 明确 runnable 且额度充分；旧 update 因全 context pending=2，在恢复32个bounds后就停止，没有Native上传。循环现仅因本 owner 实际 `_waitingForSlot` 或时间预算暂停，不改变两任务上限。无界恢复同次上传；2ms额度仍让出，paint已耗尽时实际copy仍不超过16KiB。取消释放与第三owner准入控制保留。

城市 draw 探针确认主命令的问题：最新531末帧 dirty derived checks 为 dash 118/118、fill-outline 31/31、line 215/254。旧硬件 roads sibling=0 控制没有覆盖 Native primary casing；新增完整 GPU 红 `expanded-command-cache-red` 四个相机帧中 solid casing 24次、dash roads/casing各24次。加入真实fill-outline后 `expanded-command-outline-cache-red` casing/outline各24次。诊断观测包含开销，不能作为公平帧率。

GeometryPrimitive 现在按 raw Native command 持有专用提交命令，扩大的球保留稳定身份，Native 原球与原命令不被改写。`DrawCommandReplay` 只同步真正变化的 raw字段，保留最终pass、depth state、uniform overlay以及自己的派生有效性；不清Native dirty、不复制raw dirty/lastDirtyTime，借用VA/shader资源仍由Primitive销毁。真实 Native Primitive.update→DrawCommands.prepare→Scene.updateDerivedCommands 的 line/dash/outline 单测红→绿，稳定第二帧 log-depth 重派生各1→0；模式切换、同帧两个viewport、矩阵/球数值原地变化、shader/VA/count/instanceCount/uniform/renderState/pick许可变化仍正确。

ESLint → 完整TypeScript → **54文件 / 536单测** → 库/demo build 全绿。266个source文件与8个build dist文件及SHA冻结为 `city-expanded-commands-slot-progress`；main687.61 kB、data Worker579.49 kB、geometry Worker202.25 kB。14 项硬件动态 camera/solid-dash三模式/pattern 回归通过，产物 `expanded-command-slot-hardware`。四个实际相机postRender帧中，实线和虚线的 roads、casing、outline 重复log-depth派生均为0，道路命令与轮廓各6条，VA/texture身份稳定。原expanded红控制保留。

同最新 published production 入口完整城市 `city-expanded-slot-production-after`：Native cold **11.5059秒**，拉远/拉近/平移/旋转完整Scene CPU P95 **25.3 / 22.4 / 30.1 / 23.3 ms**；MapLibre cold 0.9706秒，对应6.8 / 5.6 / 5.6 / 6.0ms。Native cold/最终库命令614、kind数与531前轮一致，未遗漏图案或符号来提速。冷加载未明显改善，完整帧门槛继续失败。latest published 连续录像 `city-expanded-slot-production-video` 通过（48.4秒诊断）；录像与时间探针不计公平FPS。原始六项目标保持进行中，下一项仅调查可证明的屏外line/dash保守剔除。

### 3D 道路四侧平面的保守剔除（2026-10-08）

实际城市稳定帧的最新536诊断确认各库kind的dirty derived checks都已归零，但line254、dash118仍全部绘制。新增剔除只接受有已上传uniform factor、实际FLOAT miter证据的普通3D完整viewport命令，以最终paint、camera/frustum和包含高度偏移的world sphere扩张四侧平面；pick、近面相交、未知属性、offcenter/VR、多viewport、2D/CV/morph均保留。原Native sphere/cull/depth partition不变。Worker准备sphere另包含真实高/低FLOAT重建误差，并不修改共享source sphere。

真实Native DrawCommands+CullingVolume窄线/宽casing及实际decode误差单测红→绿，完整ESLint→TypeScript→**55文件/554单测**→库/demo build通过；268个source与8个dist冻结为`city-line-sideplane-visibility`。DPR1/2的四个相机高度/方向变化中，实际Native draw20→16/20/10/16，uncull与filtered的RGBA差异均0，宽casing拾取和VA/texture身份保留。新增近地约27m控制验证相同像素；该控制的1m世界高度sphere余量允许保留窄线，不要求强制减少draw。低Source maxzoom的厘米级短线会被量化，因此控制使用maxzoom18/tolerance0。`line-visibility-height-bound-control`三项通过；原14项camera/solid-dash三模式/pattern动态硬件回归也保持绿，`line-visibility-dynamics-hardware`保留早期近地fixture的效率断言失败，不算生产误藏。

新的published production串行城市对照`city-line-visibility-production-before/after`：冷加载12.5328→11.4377秒；Native拉远/拉近/平移/旋转P95 **26.8/28.6/28.8/24.7→28.0/23.6/24.3/23.5ms**。MapLibre分别0.9741/0.9895秒及7.3/6.1/6.3/5.1、7.5/4.9/4.6/5.4ms。库命令614→458，具体line254→137、dash118→79，其它kind与符号55保持。裁剪减少实际提交，仍未证明全运动达标；cold单轮差值也不归为独立管线改善。完整16.67ms门槛仍红。

最新连续published录像`city-line-visibility-production-video`通过（49.9秒诊断）；解码Native38.20s/MapLibre13.60s，检查了冷加载、拉远/拉近、平移、倾斜/旋转及返回视角。返回道路、图案、标签保持；冻结数据边界外空白在两renderer都存在。录像不能计公平FPS。下一步根据当前完整帧profile继续定位，及证明line准备包可否省去已被topology完整覆盖的重复DOUBLE顶点中心；原始目标保持active。

### 道路准备包省略可重建的顶点中心（2026-10-08）

line geometry的expanded DOUBLE position与LineInput的原始positions/vertices信息重复。仅有明确topology时，packetEnd与copy同步省略position，Worker走原有重建DOUBLE centres路径后照常Native combine。其它attrs/indices/longitudes/closed/bounds与Native/surface路径保留。字节红544→352，真实两projection、多mode、同geometry不同矩阵、round/miter/dash的完整Native combined/texture/CV bounds等价；重复独立transfer不detach源缓存，lineowned copy16KiB与cancel控制保留。

完整回归首次发现五个旧预算控制只观察Float64Array.set，省略position后先复制Uint8 flags，因而记录0bytes。控制改为观察共同TypedArray.set并按实际target元素大小计量，仍断言0<总copy≤16KiB、waiting不重发、同物理帧第二viewport不额外copy。随后ESLint→TypeScript→**55文件/556单测**→库/demo build绿；21项hardware line三模式/edge camera/owned Worker生命周期/packed package控制绿（`line-topology-packet-hardware`）。268个source与包含prepack notices的9个dist冻结`city-line-topology-packet`。

published production串行公平`city-line-topology-production-before/after`：Native cold11.4266→12.5433秒，四种运动P95 **31.5/22.2/24.7/22.9→28.1/19.9/25.9/25.4ms**；MapLibre0.9685/0.9829秒及7.0/5.4/6.8/7.8、8.0/5.7/5.1/6.1ms。库kind与总数458相同。未证明冷加载或全运动改善，门槛仍红，不把传输减少换算成FPS。

真实byte/服务诊断`city-line-topology-worker-diagnosis`：468个cold prepare输入view bytes83,857,565、backing/transfer83,956,980，返回122,684,235bytes；历史531相同468任务输入97,345,541、backing97,444,956、返回字节完全相同。输入减少13,487,976bytes。首post6031.1至末reply14589.3ms跨度8.5582秒，inflight0/1/2累计6.2741/1.3277/0.9564秒；实际posted/frame为179帧2次、110帧1次。旧531还包含后续slot/cull差异，因此不把跨度下降单独归因于packet。空槽不是纯Worker idle，仍需区分输入构建、上传及预算等待。

当前554完整运动采样`city-line-visibility-production-profile`已按SHA冻结source map归因：总采样7.466s，idle2.925s；library/Native self1.796/1.823s。symbol组self312.934ms，line-renderer114.588、Worker/source200.822ms；Native Context.draw inclusive973.717ms，GeometryPrimitive栈中的Native Primitive.update148.376ms。运动里存在真实收包和firstUpdates，不能当作仅ready稳态。纯line投影inclusive57.186ms，其中live18.224、currentfilter16.204、frozen scopes22.758ms；下一项仅共享一次update中的相同实际view对象投影，保留旧冻结view及逐pair预算，不跨帧缓存。

### 单次符号更新共享纯投影（2026-10-08）

SymbolProjectionContext 只在一次 renderer update 内按实际 view 对象、geometry 与 instance identity 共享纯 line 投影，供 live/current filter/commit/placement pass 使用；不存入跨帧 pass，不合并不同 frozen view。真实 dense1000 控制的两条已选线重复检查6→4；下一次原地修改路径、size 或 glyph offsets 会重新计算，VA 保持，值相同但身份不同的冻结视图仍独立。

完整声明检查发现推断返回类型引用私有 LineGlyphPlacement，context 改为显式使用已有 projectGlyphsAlongLine 返回类型，随后 ESLint→TypeScript→**55文件/558单测**→库/demo build 通过。10项硬件密集符号连续运动、半透明LOD、延迟MapLibre世界符号及确定性多模式控制通过，产物 `symbol-projection-context-hardware`。268个source与8个dist冻结 `city-symbol-projection-context`。

published production公平串行 `city-symbol-projection-production-before/after`：Native cold **10.4914→12.5745秒**，四种运动完整Scene CPU P95 **27.5/21.5/24.9/23.2→26.7/19.3/25.0/24.2ms**；MapLibre0.9668/1.0458秒及7.7/4.8/7.9/7.3、6.8/5.4/5.4/5.9ms。库kind与总数458相同。不能据此宣称整体提速或冷加载改善，完整帧门槛继续失败。

`city-symbol-projection-production-video` 连续运动诊断通过（46.3秒用例）；Native35.32s、MapLibre12.60s录像检查冷加载、缩放、平移、转角/倾斜与返回，并加密抽取Native运动19.3–23.8s每0.3秒。道路与标签返回恢复；冻结覆盖之外留白仍在双方出现。冷加载中标签先到、道路逐步补齐的过程仍明显，原始目标保持active。

### 虚线校验与任务槽排除实验（2026-10-08）

Worker dash row 的几何解析不读取纹理 atlas；该分支忽略无关 atlas append 的 revision，constant 分支仍保留其 revision。同一次校验中按 featureIndex 共享 key、按 round/butt 共享 constant from/to 查询；不跨帧缓存，所有 source 引用和布局标量继续逐路径检查。实际红5/10→绿10/10：无关append的range100→0，constant100paths查询200→2/4，同特征查询100→1；原地row、feature-state、constant atlas entry修改、尾部path引用/布局、zoom与新增prefix控制保留。

临时 Source `city-task-slots-four-experiment` 仅把2个未回复任务槽改4，单Worker、packet与预算不变。安静ABBA：2槽cold12.9629/11.7934s、4槽10.8561/11.8713s；两者平均约12.378/11.364s，逆序没有复现独立改善。对应完整运动P95：2槽27.4/20.9/26.7/24.9及25.9/18.3/27.8/22.7；4槽27.2/18.9/26.9/24.3及26.2/18.2/25.5/23.7ms，门槛全部仍红。最初`city-task-slots-source-two`与录像解码有短暂重叠，仅作预热，不计公平对照。

Opt-in `city-task-slots-admissions-two/four`诊断同为468任务、输入backing83,956,980bytes，无unmatched post。准入到实际post通常约3–13ms；首post至末reply跨度9.7867→8.2498s。输入admitted未post峰值7,810,180→7,824,172、posted未reply7,810,180→8,178,692bytes；完成未上传postRender采样峰值7,488,220→1,444,536bytes。观测CPU155.2/152.1ms；不包含Worker/GPU heap、generator临时缓冲或本帧已消费结果，不计公平性能。

4槽候选经过真实TaskProcessor红→绿、完整ESLint→TypeScript→55文件/564单测→build及5项真实hardware Native Worker lifecycle控制；冻结`city-four-task-dash-validation-candidate`268source/8dist。但published production `city-four-task-dash-production-before/after` cold10.3755→10.4880s，运动P9524.8/19.5/22.2/26.4→27.0/20.2/26.0/22.6ms，kind与库命令458相同。没有证明生产收益，因此撤回4槽参数；保留虚线校验修复，并把新增真实cancel/error/reply控制适配回两槽。不能把该候选检查全绿称为目标完成。

恢复两槽后再次通过完整ESLint→TypeScript→55文件/564单测→build，冻结`city-two-task-dash-validation`。`two-task-dash-validation-dynamics`的22项hardware连续相机、三模式道路、边界可见性、Native Worker与pattern运动控制通过（约3分钟）。`city-two-task-dash-production-video`连续城市诊断通过；实际检查Native34.00秒、MapLibre13.88秒录像的16帧联系图，返回后道路与标签恢复，但冷态道路逐步补齐仍明显。录像是正确性证据，不计公平性能。

### 城市来源覆盖与地面边界诊断

`city-two-task-coverage-diagnosis`对实际浏览器OpenFreeMap请求进行opt-in观察，属于诊断而非公平计时。双方同一初始世界相机、zoom14.29175及1280×720：Native请求12个z14 PBF（x8185–8187、y5446–5449），MapLibre请求6个（同x、y5447–5448）。运动期间Native152次/97个唯一资源URL，MapLibre81次/55个；Native PBF出现z5–14，MapLibre最低z11。重复URL不等于重复parse，需要进一步区分ideal、父级fallback和reload。

纯地面视锥计算中球和OBB均保留与MapLibre相同的6个地面瓦片，但这不证明可以安全丢弃另6个瓦片内容。样式存在未知楼高，MVT缓冲线和屏幕空间字形/线宽可越过地面边界，贴地、地形夸张、模式切换也须保留未知范围。尚未把零高度地面过滤合入fresh source选择。当前新鲜来源依据已渲染Globe覆盖；loaded补充的既有边界过滤不能替代完整内容包络证明。

### Globe快照与来源zoom交接

真实TilePyramid红控制：旧区域z14覆盖、已加载z13父瓦片；相机移走并升至12000m，当前视锥证明旧地面在外、新source zoom12。旧路径仍请求旧区域`12/2046/1362`。修复只把已完成Globe选择与对应source zoom配对；无法配对时保留IDs至postRender，当前style zoom与loaded补充继续更新。第二个真实红控制证明不能一直保留初始覆盖：连续下一pose仍服务已确认远处`12/2246/1362`，不等待相机停止。冷态、六种source配置变化、模式切换、同矩形一次内部唤醒及稳定无重复唤醒控制保留。

完整ESLint→TypeScript→**55文件/575单测**→库/demo build通过，冻结`city-confirmed-globe-source-lod`268source/8dist。Published安静串行`city-source-lod-before/after`：cold10.4522→10.4726s，完整Scene运动P95 **26.5/17.0/19.8/24.7→26.3/18.0/23.9/24.7ms**；MapLibre1.0287/0.9683s。双方库kind458不变。此修复解决错误交接，但尚未证明城市吞吐改善，完整帧门槛继续失败。

`city-source-lod-request-before/after` opt-in真实pyramid方法追踪均成功在无existing tile/dispatch时挂载，unknown ideals0，observer CPU27.5/27.8ms；coverage仍标为可能漏采，方法调用不等于完成fetch/parse。cold各12个ideal z14；motion236→221个_loadTile，全部ideal，z5–10共85→81个，未观察parent-fallback或reload。Native真实运动资源请求147/93unique→140/88，MapLibre100/71→107/71。这证明本轮低层级主要来自Globe矩形映射`min(targetZoom,terrainZoom)`，不能归因于父级兜底；快照修复未解决terrain/sourceLOD耦合。

`confirmed-source-lod-dynamics`22项hardware连续相机、三模式道路、近面/屏边/DPR、Native Worker及pattern控制通过（3分钟）。`city-source-lod-video`真实城市连续诊断通过（46.0秒）；实际检查Native35.04秒、MapLibre12.64秒录像的16帧联系图。冷态道路与建筑逐步补齐仍明显，缩放/运动/最终返回后内容恢复；录像不计公平性能。

`city-source-lod-geometry-profile`使用冻结575 published+Native production、opt-in Worker属性数字汇总/上传阶段/CPU profile，属于诊断，不计公平性能。真实属性确认12个大任务包含`a_extrusionNormal/a_extrusionTop`，共2466instances、输入58,833,276B/回复93,916,128B；其中`position2DHigh/Low`各15,153,876B，3D两轨也各同量。388个line任务输入24,691,289B/回复28,296,871B，68个其它native任务333,000B/471,236B。上述属性是view字节总量，不等于去重backing或GPU驻留，summary额外CPU31.3ms。三组任务往返累计分别472.2/2074.7/485.6ms，包含排队与主线程领取、可重叠，不能解释为Worker CPU或加总成cold wall；本次cold11.4539s。

新575 profile的162个项目sourcesContent SHA与冻结manifest一致。cold采样16.148s含页面setup：library/Native self2395.7/4014.6ms；motion7.872s对应1646.8/1651.4ms。建筑提取inclusive167.2ms、整个建筑build约217ms；Native vertex arrays创建140.1ms，其中typed-array复制58.1、Buffer.create提交44.7ms。cold上传阶段973.3ms还含packet准备、结果恢复和初始化，不是GPU完成时间。468任务首post→末reply跨8581ms，往返累计3032.5ms；冷态575帧中298帧dispatch、170帧2任务及128帧1任务，完整Scene CPU累计6102.7ms。字节体量没有证明建筑Worker是秒级主因，工作跨帧推进期间的反复渲染仍有明显成本。

### 面内容包围球的真实裁剪红控制

固定整tile球让真实屏外小fill仍有1次Native draw；`fill-content-bounds-red`四次移入/移出采样的像素差异0、VA/cache owner稳定，屏内4523green且pick正确。一次预算构建实际内容球、包含Native Float32 high/low解码误差后，`fill-content-bounds-green`屏外draw0、屏内相同4523green/pick/VA，参考像素仍0差异。clamp及2D/CV原路径保留，扫描取消不分配Native owner；完整ESLint→TypeScript→55文件/582单测→build通过，初版冻结`city-fill-content-bounds`269source/8dist。

但published `city-fill-bounds-before/after`初版公平对照cold10.4287→10.5107s、运动P95 **26.5/16.0/24.8/22.9→28.1/18.3/26.4/26.2ms**，未证明整体改善。opt-in `city-fill-bounds-draw-before/after`真实末帧fill draws42→34、derived dirty均0；前者与Circle目标check短暂重叠，因此两轮诊断都不计公平耗时，也不把不同冷帧数下的总draw同比吞吐。初版AABB半对角在斜置地块可能变宽，二次预算scan改为实际points maxdistance；数学红3项→13项针对性控制全绿，城市验证待后续轮次。Sphere中心可能改变，更小radius不等于旧球的集合子集。

### 圆点屏幕边缘的真实丢像素红控制

`circle-tile-bounds-red`真实hardware constant/data-driven各失败：合法细LOD tile里的同一已上传circle owner，固定tile sphere在侧面外；仅关闭原command的CPU cull后reference edge有5320green pixels，默认0。所有阶段先存JSON，再判断正控；固定source covering只为保留owner，不代表来源选择问题。包含小圆不入屏、半径增大、描边、屏内恢复、同VA/pickIDs及首次上传后Source.loadTile0控制。包围球没有随radius/stroke更新，原注释“包含circle pixels”已更正为地面矩形范围。

DrawCommands仅对circle批次的Native BufferPointCollection关闭原command的CPU cull一次，cached paint derivative继承；其它owner及非circle批次不变。Native `isVisible`在cull=false时同时跳过CPU horizon检查，不能称为保留CPU horizon；GPU depth/clip、near/far分区与source/layer显隐继续运行。真实owner单测先红后7/7绿，同cached command跨五次render/pick不反复dirty。`circle-and-tight-fill-bounds-green`hardware三项通过（25.9秒）：两种circle paint的5320/5900边缘像素与cull=false参考一致，near-plane正控两者0像素并可恢复；精确fill球屏外draw0、屏内4523green/pick，VA身份与像素不变。不同GPU宽POINTS规则不能仅凭投影圆交界认定损像素，本轮结论限于已验证Native hardware路径。

最终fill球先预算扫描AABB中心与Native解码误差，再预算扫描实际points到中心的maxdistance，避免半对角空角扩大半径；clamp及2D/CV保留原路径。完整ESLint→TypeScript→56文件/587单测→build通过，冻结`city-circle-and-tight-fill-bounds`270source/8dist（生产已验证；冻结期间额外加入的三项covering回归测试随后用于下一修复，不能称此快照所有测试已绿）。

### 不必要的来源覆盖确认帧

真实CesiumVectorTileset owner同整数source zoom、相同Globe覆盖的相机高度变化，旧路径postRender多请求一帧，18项控制中该项真实失败。缓存改为记录实际primary采样的zoom/revision；保留旧IDs或增加loaded补充不会伪造采样。实际采样已匹配时不再因pose变化单独唤醒；跨整数zoom、旧Globe revision、未知采样、loaded补充及Globe变化仍保留确认，物理同帧多次相机变化的欠账不取消。18项针对性控制全绿，完整ESLint→TypeScript→56文件/590单测→build通过；冻结`city-primary-covering-wake`270source/8dist。

安静published `city-primary-wake-before/after`只比较这次wake变化，双方都含最终精确fill球及circle修复。cold9.4225→10.4711s，完整Scene P95 **24.1/19.9/23.8/23.2→26.5/21.4/24.2/25.9ms**；motion frames均48/48/48/72，library命令458不变。MapLibre cold0.9650/0.9691s及P95 6.9/5.6/6.5/5.1→7.7/5.5/6.0/5.2ms；Native bare Scene P95 1.6/1.1/1.1/1.9与1.6/1.2/1.1/2.0ms。没有城市帧数或吞吐收益，门槛仍真实失败；不能把更少wake的局部回归外推到该城市轨迹。广泛动态验证继续。

`primary-covering-wake-dynamics`25项hardware控制全部通过（3.3分钟），包括100/900符号连续zoom/orbit、即时边界隐藏、同source zoom几何身份、默认paint过渡、draped fills、半透明父子symbol、同世界MapLibre对照、三模式line/dash、三种屏边条件、Native Worker/CDN/错误/取消及pattern motion。`city-primary-wake-video`连续城市诊断通过（46.6秒）；实际查看Native34.92秒/MapLibre13.72秒录像各16帧联系图，返回恢复正常，但Native冷态道路建筑渐进加载仍明显。联系图只是完整录像检查入口，视频不计公平时间。

### 真实绘制成本的宽松上界

`city-primary-draw-reference/omitted`在同一冻结590 published中安静串行执行opt-in draw观察；后者只在真实Context.draw入口省略全部库kind的实际调用，保持Native非库绘制、准备/排布/Worker和派生命令路径。cold10.443→7.3193s，完整Scene运动P95 **26.4/17.0/24.1/22.4→17.6/14.6/11.6/20.1ms**。末帧库draw计数两者相同，其中line137/dash79/symbol55/fill34；省略轮明确标记omitted，Native26仍执行。两轮都是诊断，不计公平性能：省略的内容有意缺失，cold预算会随mandatory成本变化，不能从wall差直接算GPU耗时或把不同cold工作帧796/578当同吞吐。实验说明绘制之外仍有显著成本，也未证明某个单kind是原因。

### 最后一组Worker包围球恢复的空等待

真实TaskProcessor→prepareGeometry kernel→transfer reply→SceneCollections spent minimum admission红控制：32个CV sphere全部恢复后旧路径仍COMBINING，下一次service只完成尾部状态，再下一次才进入Native上传；33控制正常分批。仅在后面还有sphere时每32项yield，使32项末单位可完成COMBINED，Native上传仍需要下一次budget admission；33仍32/1/上传三步。预算guard、VBO独立边界及两个task slots保留，GeometryPrimitive24项针对性控制全绿。575真实任务仅9个owner满足该末尾倍数，不宣称解释秒级cold差距。

完整ESLint→TypeScript→56文件/592单测→build通过，冻结`city-bounded-reply-completion`270source/8dist；`bounded-reply-completion-dynamics`11项hardware Native Worker/三模式line/dash全绿（1.3分钟）。安静published `city-bounded-reply-after/before`按after先运行的反向顺序：before590 cold9.4069s、P95 24.9/22.1/22.5/23.6ms，after592 cold10.4558s、P95 27.8/16.9/23.3/21.3ms；motion frames仍均48/48/48/72，MapLibre cold0.9679/0.9680s。没有证明城市整体收益，完整帧门槛继续失败。

### 空闲物理更新的几何准备原型（未合入）

临时 `city-idle-cpu-prototype` 只在3D按需Scene的 `newFrame=false` 更新推进已由真实render准入的Geometry CPU generator/reply；Native.update、纹理、ready交接与command提交仍留真实render。预算按物理preUpdate tick共享，保留16.67ms目标、2ms placement预留、最低服务配额与两个Native task slots；首次owner准入和paint准备不移入idle。冷态实际观察105个idle ticks、46次CPU admissions、13个runnable ticks，证明入口被使用，不能据此推断不同upload-only frames的覆盖率。

安静published反向紧邻对照 `city-idle-cpu-prototype-after/before`：原型cold9.4015s、460个冷绘制帧；正式592 cold9.3831s、456帧。原型完整Scene运动P95 26.1/14.7/21.7/22.3ms，仍不达标，整体cold无收益，因此没有合入正式代码。下一轮需单独验证未发布vector构建与publication的边界，并用完整Scene.render计时校验idle mandatory预留；postUpdate局部样本不足以证明整个同步更新的CPU成本。

### 空闲vector构建与完整Scene预算原型（未合入）

第二轮 `city-idle-build-prototype` 在前一临时几何入口之外，复用 `_begin/_buildVector` 只准备detached vector，停在surface-ready/vector-ready并醒帧；symbol/pattern/取消/commit/featureIndex/held交接全部留真实render。任何待发布/失效/符号/纹理路径都保持render唤醒；模式、zoom、paint/payload身份、DPR、light、layerOrder或transition变化不在idle重启。临时每Scene.render wrapper测完整同步CPU，只有明确idle tick使用独立mandatory P95，保留16.67ms目标、2ms placement reserve、共享minimum token与两个Native slots。

旧轮询协议下，`city-idle-build-prototype-after/before`初测cold8.3607/9.4002s、冷绘制373/480，原型idle build25steps/331.8ms、geometry131admissions；完整运动P95 23.9/13.6/23.3/23.4对24.0/14.6/23.6/21.2ms，仍失败。仅几何+idle预算的 `city-idle-budget-prototype-factor` cold9.4237s/452绘制，geometry54admissions；组合repeat cold9.4204s/401绘制、build22steps/277.9ms、geometry126admissions，P95 23.9/19.1/21.3/22.2ms。重复没有复现一秒wall改善，且随后发现轮询计时误差，因此不合入、不声称稳定cold收益。实际入口与更少绘制帧得到证明，仍须新协议重测等待时间和暖态成本。

### 取消符号构建的资源所有权

真实CPU prepared halves→renderer.stepBuild→Native SymbolPrimitive/PrimitiveCollection取消回归：旧releaseBuild后collection仍存活，红控制失败。当前每build去重retain提取材质，commit转交原holds，取消只销毁detached collections并release材质/atlas，resourceOwner防止重复释放及释放已commit entry。三项控制覆盖partial无entry、完整prepared Native owner、两个pending与一个live共享材质的取消/删除/后续commit；不假装这些context-free控制验证了真实Texture.adopt。完整ESLint→TypeScript→56文件/595单测及库/demo build通过，补强live共享控制后的三个目标文件89项通过；冻结`city-symbol-build-resource-ownership`270source/8dist。动态GPU验证单独记录。

`symbol-build-resource-dynamics`25项hardware用例全部通过（3.3分钟）：100/900 symbols连续zoom/orbit、跨界即时隐藏与同zoom几何复用、默认paint过渡、draped恢复、半透明父子、同世界MapLibre、circle/fill真实pixels/pick/VA、三模式line/dash、三种屏边、Native Worker生命周期/取消/错误及pattern连续运动。没有把这些回归外推为真实城市性能达标。

新首次loaded协议安静published ABBA（双方均595销毁修复）：正式`city-ready-time-prototype-before`9.4256s/492冷绘制、`city-ready-time-control-repeat`9.9594s/524；候选`city-ready-time-prototype-after`8.6113s/392、`city-ready-time-prototype-repeat`9.2225s/415。两pair wall分别减少0.8143/0.7369s；候选idle vector25/38steps、338.8/480.7ms，geometry114/125admissions。Native运动P95正式26.1/15.8/25.2/21.6及31.7/20.2/23.2/24.0ms；候选23.9/15.4/24.0/21.4及26.5/20.2/23.8/20.0ms，完整门槛仍失败。MapLibre首次loaded0.8508/0.8550/0.8387/0.8384s。证明这轮cold候选值得正式边界控制，不代表暖态或整体目标完成；候选暂未合入。

### 空闲准备正式实现与帧所有权

候选进入正式实现后，闲置推进仅支持3D按需Scene：真实render已准入的Geometry CPU准备和输入稳定、已开始、symbol完成的detached vector构建可续进；首次构建、GPU更新、symbol/pattern、失效重启、发布、拾取索引和交接仍请求真实render。关闭、移出Scene和释放预算时停用此能力。当前预算完整测量idle Scene调用，保持render/idle mandatory独立；wrapper无法安全安装、被host替换或调用失效时退回保守预算。

整合复核还发现同tick早preUpdate与稍后Native判定之间重新建FrameWork会延长deadline、分裂minimum token，并使旧handle的尾部费用漏记。六个新增控制在旧实现全部红；现在同物理tick共享同对象及收费/唯一许可，deadline只收紧，保留最早起点，下一preUpdate才获取新额度。45项预算控制通过。

完整ESLint→TypeScript→56文件/647项单测→库/demo build通过，冻结`city-idle-preparation-production`270source/8dist，主入口702.20kB。`idle-preparation-production-dynamics`25项hardware连续运动、真实pixels/pick/VA、三模式line/dash、Native Worker与pattern回归全部通过（3.3分钟）。

正式published安静ABBA顺序after→before→before→after：after首次loaded10.5249s/524冷绘制，before10.9288s/587；repeat before10.3057s/548，after8.6905s/388，两pair分别减少0.4039/1.6152s，收益幅度存在波动。after运动完整P9527.0/22.3/26.7/23.0ms及24.7/18.0/22.2/21.3ms；before26.8/17.2/22.9/24.0ms及23.7/26.9/25.4/26.7ms。四轮MapLibre首次loaded0.9116/0.8581/0.8473/0.8446s。两组cold改善与更少绘制帧得到支持，暖态未呈稳定收益，完整Scene门槛仍失败。产物分别`city-idle-production-after`、`city-idle-production-before`、`city-idle-production-before-repeat`、`city-idle-production-after-repeat`。连续录像的`city-idle-production-video`诊断通过（41.6秒），逐段画面单独检查，不计公平时间。

### Worker 回包前的 Native 建表唤醒

647版本诊断`city-idle-production-profile`首次loaded10.013s，467真实render累计4669.9ms、133idle累计445.6ms。468个Native任务输入83.86MB；首post到末reply的7480.6ms内，仅1890.9ms存在posted未received任务，其余5589.7ms没有posted任务。该时间不是Worker CPU。admit→post中位6.8ms发生在packet完成之后，Native scheduleTask的await使post等待Scene同步调用后的microtask，不能称为packet准备。114个空槽且仍有runnable waiter的快照缺乏完整stage/owner状态，不能全部归因给同一缺陷。探针本身146.7ms，本轮不计公平成绩。

真实deferred TaskProcessor控制发现，COMBINING无回包时仍因缺BatchTable被判定runnable，实际Native update提前建表。Native原顺序允许COMBINED首次update先建表再VA；当前构造属性facade可在等待期保持最新paint。两个layout的真实Native BatchTable/accessor/pick/afterRender、两次paint写入和真实kernel回包控制通过，只有GPU分配边界替代。取消、错误、两个task slots和预算保留。

当前实验仅取消这次预建表唤醒，并在远程COMBINING等待时停止进入Native；outline旧夹具改为实际回包后验证命令，保留坐标身份和扩展包围球。完整ESLint→TypeScript→56文件/649单测→build通过，冻结`city-deferred-native-table`270source/8dist，主入口702.13kB。`deferred-native-table-dynamics`25项hardware动态回归通过（3.2分钟）。

published production静默ABBA对照`city-deferred-table-after/before/before-repeat/after-repeat`使用相同first-loaded-renderer-update协议，Native cold **9.2779/9.0764/8.7618/9.4292s**，真实render **413/403/398/437**，idle **142/140/126/128**。Native zoom-out/in/pan/orbit P95分别为 **27.3/15.1/24.6/22.1**、**26.8/18.8/23.6/24.4**、**24.3/16.8/22.8/23.0**、**27.9/15.7/23.0/22.1ms**；Map cold **0.8455/0.8513/0.8618/0.8526s**。四轮完整帧门槛均红。延后建表没有证明整体性能收益，两轮cold反而增加0.2015/0.6674s，真实render也增加；已撤回生产deferral小delta，恢复与647冻结源一致的等待期建表语义。真实TaskProcessor/kernel、Native BatchTable及最新paint控制保留，撤回后的完整检查待运行。

### 连续拉远的水面缺失：实际红例

647的原连续视频中pose19 command骤降，pose20水面/道路消失。最初heavy每帧owner/Source扫描的探针未复现；其中第一版还误用Map.isStyleLoaded过滤加载帧，零Map target samples不是生产失败。后续heavy两次green不能排除瞬态问题，因为两RAF的运动墙钟被同步readPixels和深扫描改变。

轻量探针改为Native完成并关闭context后才启动Map，固定River `[-0.12,51.507]`且Map实际water feature `289343`确认；初始仅一次、pose19/20每实际render读ROI，其它帧仅记录camera/meta。保留109pose completeness及相机、视口、投影正控，完全删Native深扫描。`city-surface-continuity-light-serial`与`...-repeat`两次真实hardware/published647连续运动均在pose19缺水断言失败。首轮19为0/0，20为0/0；复测19为124→0，20为0/0。两轮Map对应120/105water pixels，River投影误差0.006751/0.006186 CSS px。初始实际水像素和Map feature确认均通过。这是确定的未修复动态覆盖问题，不能用终态ready或另一条heavy green替代。探针仍属diagnosticOnly/fairTimingfalse，Native callback累计67.5/74.5ms，关键帧同步读回本身约10–12ms；不将诊断耗时算作公平成绩。

`city-surface-continuity-first-loss-owners`仅首次实际zero-water ROI读回后取一次因果snapshot，额外0.7ms；再现19的124→0、20的0/0。缺失帧water/waterway queued commands均0，11旧water owners全retired/livefalse/showfalse/attachedfalse，held为空、hiddenLayers为空。ideal为z11四块，其中三块loading；renderable只有z11(1022,680)和z12(2047,1361)/(2047,1362)，三个水面发布任务仍pending。旧z14西侧(8185..8187,5446..5449)数据仍loaded，与东侧z12属于不同空间分支。

源码`_retainLoadedChildren`按整个target的统一最浅topZoom筛选，东侧z12使西侧z14一并掉出renderable；旧水面又不与东侧新资源重叠，场景hold无法挽救。实际TilePyramid.update+同城市坐标的红例确认，期望的12西侧key完全丢失，只留下2东侧key。新增8项mixed分支控制后，18tests为5fail/13pass，另4个失败覆盖精确完整性、祖孙去重且保留非重叠细分支、相邻target隔离和饱和请求defer。正在修复分支选择及完整性，不扩大maxOverzoom3，也不修改Source LOD或预算。生产修复的实际城市绿验证尚待执行。

正式修复按canonical深度、overscaled深度排序，在每个空间分支选最浅已加载footprint；已被选中祖先覆盖的后代剔除，非重叠细分支保留。完整性使用无重叠footprints的canonical面积精确和，不将mixed数量套入统一zoom公式。18项定向控制全部green；旧请求消费的完整生命周期21项green，保留fresh/idle/hidden/notready/失败与双viewport控制。完整ESLint→TSC→56文件/665tests→库/demo build全部通过，冻结`city-mixed-branch-wake-production`270source/8dist，主入口702.65kB。

`city-surface-continuity-mixed-branch-fixed`在同原light oracle、hardware/published生产构建下，109pose完整正控与关键ROI均通过（35.5s）：Native19为124/124、20为107/107，Map为190/185且actual water feature和projection仍支持oracle（相同0.006751/0.006186 CSS px误差）。Native读回回调91.5ms，仍是非公平诊断；复测、完整GPU回归与公平性能待继续，不能把覆盖正确性green当作整体性能目标完成。

`city-surface-continuity-mixed-branch-fixed-repeat`再次通过（36.6s），Native19/20仍为124/124、107/107，Map190/185；Native callback累计85.8ms。旧版两次red、新版两次green均保留原相机、真实render completeness及像素正控，没有扩大三层替代范围或延长运动等待。

`mixed-branch-wake-production-dynamics`25项hardware动态回归全部通过（3.4分钟）：100/900 symbols连续缩放与orbit、同source zoom越界隐藏、默认paint transition、terrain drape恢复、半透明父子交接、同Map相机和延迟tiles符号连续性、circle/fill实际pixels/pick/VA、2D/CV/3D solid/dash、screen-edge miter/cap、多DPR/scale、Native Worker正常/CDN/失败/取消及pattern motion。

### 真实 draw 命令分布诊断

`city-ready-time-draw-census` 在实际 Context.draw 入口记录 kind/layer/tile、VA、shader、renderState、pass、viewport 和 frustum；不调用 uniform getter。只在 `E2E_CITY_DRAWS=1` 启用，保留最近60帧及每60帧代表详情，并明确标记 `diagnosticOnly=true / fairTiming=false`。828帧中73帧保留详情，观察器自身费用单独记录；本轮没有启用完整城市性能门槛，测试通过不代表性能达标。

最后实际帧有385次 draw：Native26、background2、fill34、fill-outline31、dash79、pattern10、extrusion11、line137、symbol55。其中 dash 的 `road_path_pedestrian` 单层在11个tile产生37个独立VA、共37次draw，使用同一shader及pass；solid `road_minor_casing` / `road_minor` 分别13次draw、10个tile。该数据给出了同tile分块与跨tile命令成本的调查入口，尚不证明安全合并可改善完整帧，也不能破坏图层顺序、拾取、边界覆盖及LOD交接来减少命令。

647版本`city-idle-production-draw-capacity`再次记录真实Context.draw，740帧末帧仍为385draw。pedestrian的37个owner多数为5900–6000 vertices；只有4块达到512实例，其中3块仅4311–4968 vertices。因此不能把512实例上限当作主要分块原因，也没有Native重复提交同owner的证据。pedestrian可见几何196876 vertices，六float dash-row属性占4,725,024B；全部可见dash215395 vertices，对应5,169,480B。这是可见VA属性体积，不是全部cold传输量或已证明的帧耗时。统一dash-row改成owner uniform可能减少属性，但必须证明常量dash与cap、保持旧owner冻结语义和feature/composite支持，当前没有合入此类改动。

`city-deferred-table-before-repeat`的108个运动pose中，开启库为216实际render；隐藏库的bare对照仍为199render/216ticks。静止两者都是0render/60idle。Cesium自身也会在多数pose的两个RAF间隔中绘制两帧，不能把所有第二帧归因给库重复唤醒；库额外17帧的原因仍待精准探针确认。

进一步真实Root/TilePyramid/FillBucket/已上传水面的生命周期控制，按Native `afterRender→postRender`顺序运行。首版GPU夹具缺`createPickId`失败不是有效red；修正外部GPU边界后，`vitest ...frame-lifecycle.test.ts -t 'consumes a postRender covering wake'`的1/2viewports两例均在实际水命令和quiet正控通过后失败：旧postRender覆盖请求已由新相机帧服务，但仍额外requestRender。该源码缺陷已确认，尚不能直接把城市全部17帧归给它；修复及独立城市回测待进行。

### 排布预留额度的上界实验

`city-placement-start-diagnosis`新增上传入口而非帧末runnable观察：556冷帧中535入口false、535末尾false，false→true与true→false各2帧。仍需考虑actual full view、style mutation、其它participant与晚到symbol，不能单凭getter直接回收额度。

临时Source `city-unused-placement-reserve-experiment`仅把固定PLACEMENT_RESERVE_MS2→0，保留全场CPU目标、continuation及2任务槽，用于估计取消reserve的宽松上界，不作为生产候选。`city-placement-reserve-source-before/zero` cold11.9462→10.8217s，完整运动P9529.6/17.4/23.7/24.1→27.4/17.8/26.8/22.5ms；MapLibre0.9413/0.9806s。平移变差，完整帧门槛仍失败；未合入预算修改。若继续，需要所有eligible participant的完整placement需求证明、未知保留reserve、同物理帧多viewport与新输入次帧服务，不能新增deadline或把普通budget误当minimum progress。

## 修复范围

- 初始化支持 `show`、GPU 驻留预算和请求转换；`fromUrl()` 等待初始化，支持取消；销毁遵循 Cesium 的返回值及资源生命周期。
- 挂载、显隐、移除、异步数据与排布完成由库内部唤醒按需渲染，稳定后停止。演示调用方不再额外请求渲染。
- 符号取消固定 128 对/帧限制，使用时间预算及完整代次交接。冻结的排布视图允许连续相机运动期间完成工作。
- 图层越过缩放边界立即隐藏；表面与符号独立退役。表面专用父瓦片不会遮掉符号，父子替换不重复叠画半透明标签。
- 相机和可见性变化复用存活几何。缓存恢复会重新排队尚未完成首次上传的集合，已上传集合保持原对象。
- Worker 传输使用固定数量的打包坐标所有者及范围索引，避免大量独立 typed array / 对象的浏览器克隆。平面轮廓保留原始边界，球面轮廓保留细分结果。
- 线编译、面偏移、集合装配及首次几何编码可以按预算暂停和恢复；取消销毁未发布资源，完整上传后才交接。
- 来源加载按请求代次合并并阻止旧回复覆盖新数据。默认 300 ms paint 过渡期间，Worker 解析等待匹配的 scene binder/schema；不会把数据驱动圆点暂时变成零半径。取消传播到 Worker 的异步依赖及解析交接。

实际 WebGL 创建/上传、单次 Native Buffer add/update 和 Worker 中同步执行的 layout/project 仍是不可中断边界。共享字形下载与图片缓存由其自身所有者管理，不因单个瓦片取消而全部中断。

## 动态正确性

七个维护用例均不由调用方额外请求渲染。每瓦片 100 / 900 个符号的两组运动分别读取 199 / 206 个 postRender 帧，各有 72 个旋转/倾斜帧；越过 minzoom 后的符号、圆点和线残留帧均为零，旋转时符号整片消失帧也为零。额外核对完整几何身份复用、默认 300 ms 数据驱动 paint 过渡中的实际圆点尺寸及像素、贴地显隐恢复、半透明父子替换以及最后符号层删除。

同世界坐标、同相机、相同延迟瓦片的 MapLibre 对照中，本轮拉近后 Native 首个绿色符号帧比 MapLibre 早 2.9 ms，屏幕坐标一致。这只是一个响应时刻的观测，不能外推全部城市标签的首次布局吞吐。[逐帧世界符号对照](../../node_modules/.cache/playwright/continued-complete-regression-remaining/camera-dynamics-world-symb-f6500-re-camera-and-delayed-tiles/maplibre-symbol-dynamics.json)。

扩大回归时发现旧精度夹具将内部 GeometryPrimitive 直接挂到 Scene，绕过预算准备而超时。夹具现使用真实 SceneCollections 准备队列；原来的独立 FLOAT、零像素差异、拾取、隐藏 owner 和 GPU 身份断言保留。Worker 隔离夹具也通过实际 Native context 初始化 WebGL 能力，并显式推进已接收结果的 CPU 准备，继续验证两个并发所有者及第三个所有者的后续准入。没有给生产加入无预算的冷准备路径。

## 城市运动与 CPU 采样

使用伦敦 OpenFreeMap Liberty 样式，冻结 `20261004_113936_pt` 资源；瓦片回复统一延迟 80 ms。硬件为 Intel RKL / Mesa Vulkan。初始 Globe 覆盖及双方数据先稳定，再连续执行 24 步拉远、24 步拉近、24 步平移及 36 步旋转/倾斜。Native 与 MapLibre 同页运行，关闭逐帧 readPixels，保留完整录像。

对照仅回退 11 个几何、线编译和 binder 传输文件；双方共同保留本轮生命周期、来源代次、帧预算及 Native 冷准备修复。因此这里衡量的是这部分重构的影响，不是所有问题修复前后的整体对照。[控制文件散列](../../node_modules/.cache/playwright/continued-control-manifest.json)。

| 指标 | 控制版本 | 本轮版本 |
| --- | ---: | ---: |
| 运动期间渲染帧 | 214 | 215 |
| 新建瓦片次数 | 28 | 38 |
| 构建切片 P95 / 最大，ms | 12.2 / 23.8 | 11.9 / 17.6 |
| tileset update P95 / 最大，ms | 19.1 / 40.1 | 19.9 / 24.4 |
| 符号排布 P95 / 最大，ms | 2.1 / 10.5 | 1.6 / 3.8 |
| Worker receive self 采样，ms | 601.5 | 124.7 |
| 反序列化 self 采样，ms | 287.7 | 61.8 |

本轮运动期间持续提交绘制命令，恢复俯视后完成加载并停止按需渲染。构建切片的 P95 ≤ 16.67 ms、最大 < 50 ms 的断言通过。Worker 交付占用下降、长构建切片缩短，但 update P95 没有明显改善。异步调度导致新建数量不同，这是一组同输入、同轨迹的诊断，不能据此宣称同工作量吞吐或整体 FPS 提升。阶段时间可能嵌套，不能相加。

原始证据：[控制数据](../../node_modules/.cache/playwright/continued-verified-before-complete/camera-dynamics-public-cit-27202-ous-zoom-pan-and-orbit-live/public-camera-dynamics.json)、[本轮数据](../../node_modules/.cache/playwright/continued-verified-after-full-cache/camera-dynamics-public-cit-27202-ous-zoom-pan-and-orbit-live/public-camera-dynamics.json)、[控制 CPU 采样](../../node_modules/.cache/playwright/continued-verified-before-complete/camera-dynamics-public-cit-27202-ous-zoom-pan-and-orbit-live/city-motion.cpuprofile)、[本轮 CPU 采样](../../node_modules/.cache/playwright/continued-verified-after-full-cache/camera-dynamics-public-cit-27202-ous-zoom-pan-and-orbit-live/city-motion.cpuprofile)、[本轮运动录像](../../node_modules/.cache/playwright/continued-verified-after-full-cache/camera-dynamics-public-cit-27202-ous-zoom-pan-and-orbit-live/video.webm)。

缺失冻结资源导致失败的重放、遍历整幅 scene 对象树的诊断探针以及不同 profiling/readback 协议的旧轮次均不计入上述结论。

## 独立 renderer 动态对照

Cesium → MapLibre → MapLibre → Cesium 四轮串行使用独立 context，同一硬件、1280×720、DPR1、二维正射 Mercator 及相同三层样式。z14 每瓦片包含 1024 个地块及 128 条各 33 点道路；低级瓦片保留同等空间密度。每轮完成 360 步预热，再测静止 180 步、慢移 360 步、快移 120 步。双方每轮请求相同的 24 个 z14 及 10 个 z13 瓦片，669 个地理像素探针及投影误差检查通过。

| 主线程同步 CPU 指标，ms | Cesium 两轮 | MapLibre 两轮 |
| --- | ---: | ---: |
| cold wall | 2429.1 / 2203.5 | 1087.7 / 1004.4 |
| cold CPU P95 | 14.7 / 18.1 | 6.3 / 4.3 |
| cold CPU 最大帧 | 22.6 / 22.2 | 12.7 / 6.3 |
| stationary CPU P95 | 1.3 / 1.4 | 0.6 / 0.6 |
| slow CPU P95 | 1.7 / 1.7 | 0.6 / 0.7 |
| fast CPU P95 | 2.1 / 1.9 | 0.6 / 0.7 |

慢移/快移的 renderer 帧间隔 P95 双方均为 16.9–17.0 ms。Cesium 快移最大间隔为 48.2 / 32.8 ms，冷加载最大间隔为 23.3 / 78.7 ms；这些间隔包含浏览器调度与 GPU 背压，不能从同步 CPU 时间推断其具体原因。稳定动态路径已能保持接近显示刷新周期的 P95，但 CPU 和冷加载仍落后于 MapLibre。这不证明三维真实城市整体达到 60 FPS，也不把二维预热后的表现外推到密集符号首次加载。

每轮 Cesium 有 32 次 create、24 次 combine，按返回 buffer 验证所有分片被恰好一次合并；主线程 packCreate、源 buffer transfer 均为零。[完整独立对照数据](../../node_modules/.cache/playwright/continued-independent-abba-correlated/performance-comparison-loc-89c1b-ance-comparison-performance/performance-comparison.json)。

## 2026-10-08 平视与符号补充验收

上海 CV 的 64 个实际相机姿态又用 MapLibre 公共相机 API 独立重放，实际规范化相机最大偏差 0.00001113 投影米、pitch 最大偏差 1.42e−14 度。已查看双方全程 contact，而非只比较最终截图。产物 `shanghai-map-horizon-qualified`。双方河面均出现淡色横带，MapLibre 经公共 API 隐藏全部 symbol 后横带仍在；不能将其直接归因于本库符号或填充缺口。

有限水面/道路隔离覆盖 18 组、每组 20 个真实姿态，89.9°/90°均无缺口；89°在一个姿态发现一个真实黑像素。保留来源覆盖而仅关闭 Globe 绘制、关闭深度测试及关闭 log depth，该像素仍在。未复现大面积横带，不证明那个像素已修复。配对缓存资格另有一次失败，夹具已修正但完整复跑尚待完成；产物 `cv-surface-horizon-paired` 不算全绿。

静默性能轮 `city-horizon-validated-performance` 使用已冻结的 758 项版本，关闭 readback/profiling，双方独立 context。Native 冷加载 9002.9 ms，MapLibre 856.7 ms；Native 拉远/拉近/平移/旋转整帧 CPU P95 为 27.7/26.6/23.5/24.0 ms，MapLibre 为 7.1/7.4/6.9/5.5 ms。16.67 ms 门槛真实失败，整体性能目标仍未完成。额外 `city-horizon-profile` 仅用于归因，不算性能成绩。

点符号硬件对照 `symbol-perspective-qualified-red` 在同一实际相机、同一 16px 公共 addImage 输入下成立：89°近处 Native 15.71px、MapLibre 64px；90°超远图标 MapLibre 已隐藏而 Native 仍显示；近处碰撞 Native 两个、MapLibre 一个。修复 viewport-pitched point 的 GPU 透视大小、CPU 未截断透视碰撞框和远处可见性，保留 allow-overlap 与 text/icon optional 的 always-show 语义。新增相机距离仅在姿态变化时测量，移动继续复用 geometry/material。

第一轮硬件发现新增属性超过 16 个 GPU 槽位，随后将标记合入已有 zoom 属性。第二轮隐藏和碰撞已通过，但 64px 图标仍实测 62.6px。根因是直通透明 RGB 的插值随后再乘 alpha，修复为 MapLibre 同样的 premultiplied 图集过滤，再转为 Native material 所需的 straight RGB；pattern 图集保持自己的混合契约。`symbol-premultiplied-experiment` 两个固定硬件用例 16.4s 全绿，未改变 0.5px 门槛。该轮为源码冻结实验，正式构建与连续动态验收仍待后续记录。沿线与贴地图朝向的符号不包含在此点符号透视结论中。

瓦片队列增加真实已 transfer 的 line geometry 正控：一个未准备的新 sibling 不应阻止已准备输入的旧 job 继续构建。生产者局部 51 项通过；真实 tileset idle hook 的消费端原先仍在 mixed renderNeeded 上早退，新增回归确认为 0 次 advanceBuilds，修复后与队列共 78 项通过。保留总帧预算、未准备 sibling 不读取或发布、重复 idle tick 不再分配额度。尚未取得实景冷加载改进证据。

整合版本 `city-symbol-queue-production` 已完成 ESLint → TSC → 60 文件 / 779 单测 → 库/demo build，并冻结 279 source / 8 dist 散列。正式冻结源码硬件 `symbol-queue-dynamic-final` 11 项全绿（1.5min）：100/900 symbol 连续缩放/旋转、首帧隐藏、几何复用、静止 recency、默认 paint、terrain hide/recover、半透明交接、延迟瓦片的真实 MapLibre 动态对照，以及平视 road 和两个 point symbol 像素对照。此结论不包含整体城市性能达标。

整合版本静默性能 `city-symbol-queue-performance` 40.8s：Native 冷 8428.8ms（410 render / 92 idle），MapLibre 847.6ms；Native 四阶段整帧 P95 30.6/23.0/25.7/25.5ms，MapLibre 6.3/7.0/6.2/5.7ms，最终仍459 commands。真实16.67ms门槛失败。相对758单轮冷加载减少574ms，但不同动态阶段方向不一致，也不是队列独立ABBA，不能宣称稳定整体收益。

`shanghai-symbol-queue-dynamic` 完成相同64个上海CV真实姿态（34.4s），已实际查看全程16时刻contact与最终PNG，并重看经过actual camera资格的MapLibre全程/final。近处LUJIAZUI文字大小趋于一致，远处foreign密集团已减轻；公交图标碰撞选择和沿路文字仍不同。录制含冷初始化，不比较不同视频的同秒位置。`symbol-3d-horizon-qualified-red` 新增actual3D测试7.2s取得真实回归：H120赤道，−1°两次像素正控通过，−0.1°center ray实际miss，但800m图标clipW800.3901、屏幕(320,520.08)、sourceLoaded/nonoccluded均成立，area0。3D当前pose有限焦点修复正在进行，779版本尚不能用于宣称所有模式完成。

3D 当前姿态有限焦点修复已完成。只有中心射线实际未命中椭球且当前姿态满足有限焦点定义时，使用当前 ECEF/ENU 姿态计算焦点；普通命中仍使用实际椭球交点，正射不引入透视。`symbol-3d-focus-dynamic-final` 的 3D 回归通过：上述 −0.1°、800m 图标实际面积从 0 恢复至 4095.96px²、alpha 宽 63.9997px，2500m 图标宽 39.9951px，恢复 −1°也通过。此项验证可见地面图标的保留，不将曲面与 Mercator 的投影视为完全相同。

整合冻结 `city-3d-focus-bookkeeping-production` 已完成 ESLint → TSC → 60 文件 / 789 单测 → 库/demo build，279 source / 8 dist。`symbol-3d-focus-dynamic-final` 12 项硬件用例全部通过（1.6min），包含既有连续运动与 CV 像素对照，以及新增 3D 中心射线 miss 的地面图标回归。沿线与 map-pitched 符号、整体城市性能仍未完成验收。

另一个真实队列回归已修复：Native 在提交绘制命令后才通过 afterRender 设置 ready，次帧已完成上传的清理曾占用唯一冷任务最低准入。真实 owner/command 边界单测先确认 advance=0，再修复为 advance=1，SceneCollections 37 项通过，仍保留实际 ready owner 绘制、帧预算及防止重复更新。仅该修复的独立构建首轮冷加载 9551.4ms，不能声称城市性能收益。

仅上述 bookkeeping 改动的独立构建串行 A/B/B/A（A=修复，B=779）静默硬件四轮已完成。Native 冷加载 A=8911.5/9306.6ms，B=8557.0/9781.7ms；MapLibre 四轮 845.9–868.1ms。Native 四个动态阶段 CPU P95 23.8–31.5ms，所有轮次仍未达16.67ms。修复的平均冷加载只相差约60ms且处于明显轮间波动中，没有稳定加速证据。产物 `city-bookkeeping-abba-a1/b1/b2/a2` 和 `city-bookkeeping-abba-summary.json`，未开启 readback/profiling 或并行编译、GPU 测试。

`cv-surface-actual-va-diagnostic` 完整硬件隔离约 1min，实际水面 1m 和 road-only/combined 的同层序 1.01m 高度资格通过，严格断言仍失败：89°/frame16 四个基础 water/combined 场景各一黑像素，89.9°/90°无漏点。实际 GL SUBPIXEL_BITS=8；实际上传 VA 在同一 east=−305.74810791015625m 边界上，一侧有 north=531.326904296875m 的额外顶点，另一侧只有端点。真实 MVP、packed attributes、indices、最终 shader 及黑像素 RGBA 已保存。非匹配细分造成栅格接缝是待配对验证的因果假设，未将该漏点称为已修复，也未外推为上海的大面积横带。

`cv-surface-seam-paired-qualified` 已完成真实 GPU 配对因果验证（14s）：原始 20 帧恰有 (29,578) 一个黑像素；只在 frame16 将右侧原三角形拆成两片、追加左侧实际边界顶点后，20 帧缺口数为零，目标 RGBA 为蓝色。原六顶点字节、实际 shader、uniforms、材质/深度、owner、相机、覆盖与其余帧完全匹配。首次控制轮因读取上一 draw 的 GL 描述字资格失败，修正为右 command pending descriptors，并在正常 draw 后与实际 GL 值核对；失败轮不计入此结论。此实验确认非匹配边界细分的因果，生产网格修复仍待完成，原始严格 no-hole 用例仍红。

生产接缝修复已通过原始严格用例 `cv-surface-planar-seam-after`（50.9s/总51.8s）：18组×20帧，所有有限 water/road interior 缺口数均为零，不再触发深度/log-depth额外隔离轮。仅实际越出 tile 且 granularity=1 的 fill 从已裁切三角网重建整数边界、去除共线对角线交点，再 triangulate；使用明确的 polygonGroupId 合并同一原始 polygon 的大网格 chunks，独立 polygon/feature 不合并。无邻瓦片运行时依赖、epsilon weld、padding、shader/depth或容差改变。保留 in-tile 快路径和 granularity≥2 的曲面网格。27 项定向单测及局部类型检查通过，包括 hole/notch、断开区域、点接触、实际 parser chunks、Worker metadata、paint/pattern/outline 与 pole/grid。源码冻结 `city-planar-seam-source-candidate` 为282文件；此次 GPU 证据使用冻结源码，其 dist 仍是此前版本，不能称已完成新发布构建。

`symbol-line-perspective-qualified-red2` 三个实际沿线图标用例取得行为回归（此前两次资格问题均已修正）：固定16px公共图片、viewport/map/auto、p0/75/85/89，相机、来源、actual worker anchor、GL along-line/pitch uniforms 与完整未裁切 ROI 均先通过资格。89°近处 viewport：Native宽16px、MapLibre63.998px；map/auto：Native16×16px、MapLibre水平积分76.6547px、垂直积分11.3510px，面积894.906px²。0°双方16px正控通过，shape阈值0.5不变。此回归证明沿线 GPU/CPU投影仍需修复；一个glyph的夹具不声称验证多个glyph的路径间距。生产修复进行中。

水面修复后的 fill 可见性/剔除/拾取/缓存回归，以及 pattern 连续平移/缩放/旋转回归，在同一冻结源码上均通过（`planar-seam-fill-pattern-regression`，2 项/18.2s）。

`city-native-wakes-upload-diagnostic` 是定位用观测，不是公平性能结果。它记录 551 个 cold Scene ticks / 451 个真实渲染，162 个库内 Worker 完成批次；TaskProcessor 完成后的原有 afterRender → Scene.requestRender 路径可直接关联下一帧。418 个 pending pump 中，fresh-only 89 帧但 76 帧同时需要构建，不能宣称可直接节省 89 帧。pump 剩余预算中位数 1.9ms，285/451 次上传推进前已耗尽预算；9 次 idle 几何推进的剩余预算中位数 11.87ms。468 个 owner 的 COMBINED → COMPLETE 分布没有固定“一帧仅一两个”的硬限额。主要待试验点是首次 paint 已覆盖整组后，未触达的 fresh siblings 尚无 CPU continuation；不据此改变 Native 全局 task listener 或 Worker transport。

本轮沿线修复的第一轮实际 GPU（`symbol-line-ground-candidate`）：opaque viewport 的 0/75/85/89° 全部通过严格像素检查；opaque map/auto 除 75° far 外均通过，剩余 Native 水平积分 9.3238px、垂直 1px，reference 零覆盖，仍需追查实际边缘。SDF 组出现 top 比较集合及实际 draw 的资格问题，尚不能作为 SDF 行为 RED 或验收通过。保留原 0.5px 阈值。

首次 paint 后 sibling CPU admission 候选单测 RED→GREEN（53项），但独立生产冻结只替换 geometry-primitive/scene-collections、Worker 字节未改的公平 A/B/B/A 不支持保留：候选 cold 8800.4/9111.2ms，基线8932.1/8074.6ms；候选平均8955.8ms、基线8503.35ms，且所有动态16.67ms门槛仍失败。四轮 Native zoom-out P95=29.4/28/27.5/29.6ms，MapLibre 6.7/7.5/8.5/7.3ms；其余motion同样无稳定收益。故候选两个生产文件及对应新增测试已恢复789冻结版本，不保留无实测收益的新增复杂度。证据 `city-sibling-abba-{a1,b1,b2,a2}` 与摘要JSON；不影响水面和符号修复。

`symbol-point-map-qualified-red` 独立 POINT/public16px、pitch=map、rotation=map/viewport 两项均取得行为 RED：实际相机/worker/source/W/GL uniforms/ROI/top16正控通过，75°near Native16×16、reference水平12.6403/垂直约2.04px，89°near Native16×16、reference水平76.6547/垂直11.3702px。仍缺整个地面quad投影及对应碰撞；开始实施。far3300的零覆盖存在远裁剪差异，不能据此给生产加入距离隐藏，夹具需补真实四角深度资格后再验收。

沿线生产修复现已取得严格 GPU GREEN：`symbol-line-ground-final-six` 六项（opaque/SDF × viewport/map/auto）全部通过49.0s；0/75/85/89°，near/mid/far实际 worker anchors、两端真实四角 clipping、完整未裁切 ROI、public16px正控先资格，再0.5px宽/高/alpha面积。Map最新Frame/Projection UBO通过真实linked program成员offset/binding读取，未复制Native shader作为reference。原far3300超Map75°far-plane、移3000后的取样框越出画布均属资格问题，修正有限source到farEast500/y3000后完整资格通过。生产R按label anchor W调整effective fontsize、沿线CPU路径与glyph offset同rawR、map ground quad使用真实Mercator角点位移，SDF gamma同cos(pitch)与D；GPU属性总槽仍16。此六项使用冻结源码282文件，dist仍旧，尚待新的完整发布构建；仍不声称已覆盖多glyph曲线、point-map或真实城市性能。

沿线修复后的既有地平线/点符号硬件回归 `symbol-line-ground-point-regression` 4项全部通过41.2s：CV道路相机历史独立、3D中心ellipsoid射线miss恢复、POINT viewport rawR远处裁切与近处碰撞。使用同一冻结源码，尚无新发布dist。

POINT map-pitch 生产修复实际硬件已通过：`symbol-point-map-ground-basic-qualified` bearing0两case21.6s，`symbol-point-map-ground-bearing` bearing35两case21.8s，rotation map/viewport × p0/75/85/89°。public16px正控、实际四角clip、完整ROI、worker/camera/GL资格通过后，原严格0.5px width/height/full-alpha-shape对照全部GREEN。CPU actualquad与workerbox、bearing35/roll20的碰撞真RED→GREEN，122项定向测试与局部ESLint/TSC通过。source冻结284文件，dist仍旧；后续曲线label与全发布构建尚未完成。

POINT map-pitch修复后的沿线opaque/SDF六组回归 `symbol-point-map-ground-line-regression` 全部通过47.9s，原四档pitch与0.5阈值不变。多字曲线已有CPU行为RED：可见anchor与三个glyph只需首leg，加一个无关behind-camera远端后，Native动态角全部16而短线正控有效。新公共字体实际GPU第一轮仅p0锚点在画外导致reference动态−Infinity，75°真实glyph/clip/77.9px²可读，不能把首次资格失败声称硬件行为RED。夹具正改为双方共同实际worker anchor轨道target复验。

`symbol-line-path-anchor-qualified-red` 取得公共真实Noto Sans Regular五glyph硬件行为RED（11.4s）：双方相机、来源、actualworkeranchor、glyphoffset/order、Map真实动态/clip、top及return-top实际alpha正控全部通过；75°时只有无需走到的路线远端在相机背后，Native五glyph动态角均16（无glyph可见），Map五glyph角4.71238899且全部visible。位置差0.816–8.115px，原0.5px/0.02rad阈值不变。此前top画外是资格问题，此轮明确为生产line投影回归；生产lazyrequiredlegs等修复进行中。

新增短道路标签缺失的独立根因已确认：实际同一相机 zoom=19.425905933、相同 canonical13/x4095/y4095，Native原先 parsed13且无symbol bucket，MapLibre parsed19且有五glyph/384.57px²真实字体。covering现区分数据footprint上限和终端布局parse zoom，GeoJSON canonical仍13，terminal reparse19；不枚举canonical19。安装版MapLibre覆盖oracle的两处真实RED→GREEN，94项定向测试和局部ESLint/生产类型检查通过，vector既有父URL子切片语义保留。

`symbol-line-path-geojson-parse` 的公共真实字体三组硬件复跑37s：explicit keep-upright=false完整GREEN，短道路actual Native五glyph已恢复；upright与Y-offset仍未通过斜向60°/bearing45的参考状态资格。该姿态MapLibre确有小字像素，但CPU placedSymbol hidden=1/dynamic回到anchor，不能把暂态CPU数组直接当作最终GPU参考。Native实际左侧画布几乎全红，是真实异常，尚待定位。`symbol-line-path-curve-fixed` behind case另有行为RED（11.4s）：文字恢复可见，但五glyph身份/顺序反向，角差π、端glyph位置差12.688px，原严格阈值不变。上述失败均保留，不称曲线符号已完成。

现阶段整合完成 ESLint → TSC →64文件/831单测→库/demo build，并冻结 `city-ground-geojson-production`（284source/8dist；主包753.08kB/gzip209.34、parser Worker582.01kB、geometry Worker202.68kB）。新source covering后的连续camera/hide/reuse/internalRender/road-horizon九项硬件回归全绿1.6min。此构建不是最终验收版本：上海实际连续重放在冷加载即抛 `Planar fill triangles overlap along a directed boundary edge`、Scene停止；已中断，不能把回归绿当作真实城市完成。

`shanghai-planar-real-input` 在相同实际数据/相机的冻结发布主包中仅记录原throw的函数输入，17s得到36点/33源三角片；该轮GREEN只代表诊断数据保存，不代表修复。所有源片同向，[4,28,19]薄片裁到top边界的两个交点取整为同一x=252，量化后强制反向使邻片共享边同向。原输入JSON和失败异常保留；正在修正量化拓扑契约。

`symbol-line-path-actual-va-diagnostic` Y-offset的中心/角对照通过13.3s，但实际截图左侧仍几乎全红，原test未断言整字形覆盖，因此不算完整符号验收。真实GL全部20vertices的offset/packed size/dynamic/modelMatrix正常；p60/bearing45的linked `u_camera_zoom=0`，actual camera zoom18.42590593246、D=240，p0/75的同uniform正确。新LOD material在同一cameraZoom下创建而未进入已有uniform缓存更新，ground shader用zoom0计算米/像素，导致巨型quad。生产late-material初始化与实际像素回归正在修复；此前Map CPU hidden/dynamic暂态已改为实际bound VBO读取，不再用非绘制状态作为最终参考。

新材质修复在 admission 初始化当前zoom及已有view参数，并在原有 materialRefs 的distance/orthographic/projection循环同步zoom；移除只扫cached materials的独立zoom缓存，不增加遍历。真实firstpaint与held/replacement/restore两项oldRED→GREEN，131项符号局部测试通过。`symbol-line-path-material-fixed` Y-offset硬件GREEN16.4s且实际截图左右均正常字体；p60 Native203.0941176/Map203.0901961px²，linked GPUzoom18.42590523。行/列alpha分布W1误差均<0.004px，原0.5px阈值保留。

`symbol-line-path-material-final` upright/keep-upright=false两组分别GREEN13.7/9.5s，含0/75/60°与0/180/45°实际旋转。behind首次仍失败在错误的垂直中心集合参考：精确heading0横向跨度仅2.48e−9px，两投影数值域选取相反翻转；字体offset不对称，反向阅读不能要求内部glyph中心集合逐项相同。保留该姿态完整5glyph有限clip、真实有界字体像素、整体span两端0.5px、area等效宽度0.5px，另在连续序列加入−5/+5两实际相邻姿态严格检查glyph身份/位置0.5px、方向0.02rad和alpha形状0.5px。`symbol-line-path-behind-final`该完整序列GREEN12.9s；±5实际位置最大差0.000334/0.000041px。没有为浮点退化分支加入生产epsilon或强制flip，原behind整标签angle16隐藏回归由lazyrequiredlegs修复。

真实Shanghai fill修正只改planar-fill及两相关测试：保留source traversal/真实fractional intersections，同共享边canonical插值、tile轴exact0/8192，无人工integer round/fan再翻面、epsilon weld或fallback。完整36点/33tri与最小两tri都有独立面积及内外覆盖正负控制，真实面积15970.978328173374/1731.7799671592784，保留251.724137931/251.809523810两个不同角点。18项相关测试、局部ESLint/类型检查通过。`planar-fractional-seam-regression` 原始严格18组×20帧再次全部无缺口（50.3s）；paired原始旧mesh的opt-in诊断skip，未计入成功。新实景重放仍待新的发布构建。

整合版本 `city-ground-fixed-production` 完成 ESLint → TSC →64文件/838单测→库/demo build（284source/8dist；主包753.81kB/gzip209.57、parser Worker582.65kB、geometry Worker202.68kB）。冻结发布构建 `city-ground-fixed-symbol-regression` 的11项硬件回归全部GREEN（1.2min）：3D ellipsoid center-ray miss，沿线opaque/SDF × viewport/map/auto，以及point map-pitch × map/viewport rotation × bearing0/35。实际四角clip、完整alpha形状与原0.5px阈值均保留。

`shanghai-ground-fixed-dynamic` 新发布构建完成64个Shanghai CV俯仰/升降实际姿态，35s无Scene或投影异常；已查看16时刻视频contact及最终画面。`shanghai-map-ground-fixed-dynamic` 公共API重放7.4s，但新核查发现相机位置资格不能单独当作样式zoom一致：Map临时脚本保留跨有限焦点域的旧elevation，返回89°时仍为−21.829m；Native pose.zoom则来自旧ground estimator，而非实际style evaluation。正在补实际样式zoom和当前ground/focus资格，尚不宣称双方完整视觉一致。

静默公平 `city-ground-fixed-performance`（41.8s）仍真实失败：Native冷加载8949.2ms、446真实绘制/531ticks，MapLibre858.9ms；Native拉远/拉近/平移/旋转完整Scene CPU P95为32.6/24.6/31.1/25.4ms，MapLibre7.2/6.7/8.3/5.9ms。未开启profile/readback/观测或并行编译。`city-ground-fixed-profile` 是后续独立归因采样，不能计作公平成绩：motion采样8.340s中Native Scene render inclusive约4.501s，tileset.update约2.436s，actual Context.draw约1.256s（嵌套inclusive不能相加），仍需解决整城市开销。

实际zoom资格修正后的 `shanghai-ground-actual-zoom-dynamic`（32.1s）与 `shanghai-map-current-ground-dynamic`（7.4s）完整重放通过。Native每次postRender读取真实style evaluation与CameraFrame距离；Map每次公共camera计算前把无terrain ground plane重置0，有限域仍由官方10000m公式生成focus。64姿态实际zoom最大差5.72017e−7、相机位置最大差1.11321e−5投影米；最终两端zoom13.91698943/13.91698994。已核对双方最终原图；近处LUJIAZUI、公交图标及道路宽度趋于一致，仍不能据最终帧宣称所有连续视觉/像素完全相同。原仅WC匹配但历史elevation不同的旧图不可用于精确路宽验收。

`city-ground-fixed-draw-census`仅为诊断（非公平时间）：72个保留代表/尾帧16602次库draw，唯一72次重复均为background跨两个frustum；fill/line/dash/symbol没有大量重复。尾帧358次库draw/357unique；line138draw/117VA、dash79、fill34、fill-outline31、symbol53，各kind一个shader program。数据不支持用多frustum重复绘制解释整体性能差距。

用户再次要求加快后，本轮集中修正Scene帧预算的重复计费。可控时钟真实RED：mandatory preamble6ms+tail3ms训练reserve10ms，下帧preamble6ms已执行，旧absolute deadline把该6ms又扣一次；新共享deferred charge只扣一次，保留共同physical deadline、placement预留与单次最低进展token。嵌套measure按outer实际耗时计费一次，同tick分类只能收紧额度，不能重置charge或最低token；正常Scene也从真实render入口包含早注册preUpdate prefix。源码候选尚待完整构建和公平实景对照，不宣称性能改善。

普通非旋转viewport point的同次anchor投影已由6次减至3次（3个实例），碰撞输出[1,0,1]保留；仅局部结果复用，无持久cache。相关138项与整套64文件/845项、ESLint/TSC通过。`city-point-projection-budget-before`为相同微改但旧Scene预算的隔离main基线，Worker字节保持`city-ground-fixed-production`；首次静默基线cold8282.9ms/413renders，四motion P95=29.5/23.8/27.7/26.0ms，Map冷842.1ms。此数不能用于宣称微改独立收益；用于接下来仅预算改动的对照。

新预算整合 `city-budget-charge-production` 完成ESLint→完整TSC→64文件/850单测→库/demo build，284source/8dist；主包754.30kB/gzip209.75。完整TSC首次捕获TS erasableSyntaxOnly不允许constructor parameter property，已改成普通readonly字段赋值，再按规定顺序完整GREEN；未把失败轮计入成功。预算改动与已含局部point复用的隔离baseline相比仅index.mjs/map两个dist散列不同，dts及两个Worker及其maps字节完全一致。公平实景候选已启动，尚无性能收益结论。

预算版本静默对照没有证明整体加速。第一次候选因磁盘仅剩19MB、GPU shader/页面失败及ENOSPC而无效，随后一次页面crash也无效；删除459个旧自动生成Vite缓存目录后恢复约14GB空间，保留冻结构建及测试产物。有效候选 `city-budget-charge-after-clean-cache` cold8703ms，四motion完整Scene CPU P95=31.2/25.9/30.4/30.2ms；反向旧预算 `city-budget-charge-before-clean-cache` cold8913.8ms，P95=26.6/26.9/26.6/29.2ms。MapLibre两轮cold862.9/859.0ms。冷耗时小差异与动态阶段方向不一致，不宣称稳定性能收益；16.67ms整体门槛仍真实失败。

冻结发布预算版本 `city-budget-charge-dynamic` 的9项硬件回归全部通过（1.3min）：100/900 symbol连续缩放/旋转、首帧隐藏、geometry复用、停止相机recency、默认paint、terrain hide/recover、半透明symbol单次交接、延迟瓦片的实际MapLibre动态对照，以及CV平视road宽度。预算数学正确与动态功能回归通过，不能代替真实城市性能目标；原目标保持未完成。

建筑属性压缩整合 `city-extrusion-packed-production` 完成ESLint→完整TSC→65文件/863单测→库/demo build（287source/8dist）。Worker combine后将两个position High和packed normal转为精确SHORT，Low原FLOAT位模式、top、Native FLOAT batchId保留；含CV顶点68→50字节，3D-only44→32字节。Appearance沿用同一实例与uniforms，按实际combined attrs选择Native原有RTE/CV/morph运算顺序；Worker模块与Appearance类分离。`city-extrusion-packed-buildings` 两项实际GPU回归通过24.6s，覆盖捕获的15m墙面、颜色/光照/透明度、Scene.pick身份、VA复用和demo 60/15m及场景模式切换。

静默公平 `city-extrusion-packed-performance` cold8041.9ms、384真实draw；同12tiles/113collections/457commands、36memory entries及零evictions，真实已上传GPU统计由134608783降为111877969 bytes，减少22730814 bytes（16.89%），没有删减可见内容。四motion完整Scene CPU P95=26.2/28.1/27.6/26.0ms；Map cold864.9ms、P95=7.0/5.6/8.3/5.9ms。反向旧预算 `city-extrusion-packed-reverse-baseline` cold7760.2ms、368真实draw、P95=29.5/23.5/28.7/31.4ms，Map cold866.4ms。该改动有确定的数据量收益，但冷耗时和动态耗时没有一致方向，不能宣称稳定整体加速；原性能目标仍未完成。原始对照见 `node_modules/.cache/playwright/city-extrusion-packed-performance/summary.json`。

连续缩放的完整排布调度已修正：MapLibre安装源码的 `Placement.stillRecent` 在连续zoom变化时保留recency，本库此前将cameraZoom和focus distance的每次数值变化同时判为urgent。`samePlacementParameters`仍完整判断视图stale，urgent改为比较结构/能力变化；content、viewport、pixelRatio、projection kind和distance undefined↔defined仍立即处理。当前视图的shader zoom/distance、line projection及可见选择过滤均保留每帧更新。真实clock RED→GREEN：t20旧实现立即生成新布局，新实现pending但无新job、deadline300不延长。新增19个scope控制；五个旧zoom-immediate测试调整到明确recency截止时间，原隐藏/恢复/上传/VA断言保留。

整合 `city-symbol-recency-production` 完成ESLint→完整TSC→65文件/882单测→库/demo build，287source/8dist；相对上轮仅主包/map变化，两个Worker及dts字节完全一致。六项硬件动态回归 `city-symbol-recency-dynamic` 全部通过50.1s：100/900 symbol连续缩放旋转与首帧越界隐藏、同source zoom几何复用、停止camera的deadline唤醒、半透明符号单次交接、与实际MapLibre同相机/延迟瓦片的连续可见性。

静默公平 `city-symbol-recency-performance` cold6994.9ms，四motion完整Scene CPU P95=29.0/25.6/23.7/24.8ms、P50=18.3/18.1/17.2/16.8ms；Map cold842.6ms、P95=7.7/5.3/6.4/6.7ms。12tiles/457commands/111877969 GPU bytes与上轮一致；Native四阶段绘制数仍48/48/48/72，不宣称已去除整场景第二帧或达到整体16.67ms门槛。注意city Map参考fadeDuration=0会强制full placement，recency策略依据来自安装源码默认行为；不能用此次策略差异解释Map参考所有性能差距。

`shanghai-symbol-recency-dynamic` 最新发布构建重放64个连续CV俯仰/升降姿态通过31.4s。与已资格化旧Shanghai实际rendered poses逐项比较，实际style zoom、focus distance、camera position最大差均为0；最终zoom13.916989426、D6875.844709米。已查看完整录像16时刻contact和最终原图，墙面在需要的俯角出现、回到地平线时隐藏，未发现新投影或路宽异常。视频记录含Vite/冷启动空白和较长内容准备，仍有真实加载体验问题，不能用最终画面或重放通过宣称原目标全部完成。

冷加载预算因果诊断 `city-cold-budget-diagnosis` 使用同一冻结发布包和城市输入，仅改变 tile CPU 截止时间：正常 8128.4ms / 402 次真实绘制；33ms 为 4373.7ms / 141 次；取消截止时间为 4288.4ms / 129 次，但最大完整 Scene CPU 增至 120.5ms。三组最终 GPU bytes / commands 相同。该实验确认准备队列的帧间推进节奏影响加载，但放宽预算不是可接受的生产修复；诊断时长不计作公平性能成绩。

进一步的 `city-cold-post-preparation-diagnosis` 保持正常 tile / placement 预算，在 Native 实际绘制结束后的 postPassesUpdate 中，仅用物理帧截止时间（Scene start + 16.67ms − 1ms）前的剩余时间调用已有纯 CPU 准备方法。正常 8029.1ms / 386 次绘制，原型 5911.3ms / 294 次；完整 Scene CPU 最大值 43.8 / 29.1ms。原型实际服务 261 次、累计 CPU 679.0ms；两组均为 111877969 GPU bytes、457 commands、36 entries、零 evictions。该诊断证明不重复预留已结束的绘制时间可以加快准备；尚待生产实现、生命周期回归和无探针的公平动态对照，不能提前记为达标。

生产 `city-post-preparation-production` 已落实上述绘制后 CPU 准备：保留 Native 父 postPasses hook，只在真实 owned render capture、当前物理 tick / frame、成功 render update、3D requestRenderMode 及当前 eligible participant 下服务一次；deadline 仍为 start + 16.67ms − 1ms，无 minimum，也不重复扣已完成绘制的 mandatory reserve。style / queue 扫描位于 admission 内，过期帧不增加该扫描；嵌套 measure 只累计一次。现有 advancePreparations / advanceBuilds 保留原输入资格，GPU / Native.update / publication 不进入新 hook。真实消费者关闭 CPU 步骤取得 RED，再恢复为 GREEN：CPU advance 一次，当前绘制命令和 Native update 次数不变，当前 drain 未调用，完成只请求下一帧。新增 13 项控制；完整 ESLint → TSC → 65 文件 / 895 单测 → 库/demo build 全绿，冻结 287 source / 8 dist，两个 Worker 字节仍与上轮一致。独立只读审查无剩余确定问题；公平性能和硬件动态结果另记。

冻结发布构建 `city-post-preparation-dynamic` 的 9 项硬件动态回归全绿（1.2min）：100/900 symbol 连续缩放旋转、首帧隐藏、同 source zoom 的完整 geometry 复用、静止 recency 内部唤醒、pending tile paint transition、terrain hide/recover、半透明交接、实际 MapLibre 延迟瓦片连续可见性，以及近远地面 road width 公共相机像素对照。此次 hook 只在 3D 生效，不把此前 Shanghai CV 的视觉验收当作新 hook 的加载收益。

静默公平 `city-post-preparation-performance`（39.0s）与随后只更换为旧 882 版本的反向控制 `city-post-preparation-reverse-baseline`（42.5s）均完成，无 profile / readback / 额外 observer、并行编译或 GPU。候选冷加载 6317.8ms、295 次绘制；控制 8513.0ms、414 次，减少 2195.2ms（25.79%）。均为 12 tiles / 457 commands / 111877969 GPU bytes、36 entries、零 evictions；Map 两轮冷 843.8 / 899.5ms。候选四 motion 完整 Scene CPU P95 = 28.3 / 24.8 / 25.4 / 24.5ms；控制 = 30.6 / 25.9 / 24.1 / 27.4ms，仍未达到 16.67ms，也无所有阶段一致加速。冷 Scene CPU P95 候选 20.6ms、控制 17.0ms，最大 47.3 / 30.2ms，均无 >50ms CPU 帧；冷帧间隔 P95 则为 28.5 / 30.5ms。这是利用剩余时间提高准备吞吐的真实取舍：合作式工作单元不能保证完整 Scene 不超截止时间。保留较短加载结果，不宣称严格整帧 60FPS 或原目标全部完成，也不将一组反向对照称为稳定多轮速度提升。数据见 `node_modules/.cache/playwright/city-post-preparation-performance/summary.json`。

`city-post-preparation-profile` 仅诊断、不计公平时间：7.975s 动态采样窗口中完整 Native Scene inclusive 约 4.191s，Root update 约 2.195s，actual Context.draw 约 1.151s（嵌套不可相加）。Root 子项中 updateChildren 约 468ms、SymbolRenderer 约 400ms、SourceRenderSync 约 240ms、DrawCommands.prepare 约 203ms。额外 `city-hidden-updates-diagnosis` 实际观察完成 Native owner 在当前 style-hidden layer 中仍更新，隐藏更新各类合计约 25.6ms；primary line owner 可能还供应可见 replay，因此该数字也不是安全跳过的全部开销。未扩大隐藏调度改动，也未用诊断数据宣称 FPS 提升。

沿线符号同次投影复用已完成：同一 SymbolProjectionContext / view / geometry / instance 保存原 worker anchor、perspective 及惰性 baked glyph projection，缓存 missing 结果；positions 每 glyph 不同，不假设共享 anchor、不跨帧缓存。真实 live line attributes + placement collision 消费取得 RED→GREEN：viewport anchor 2/3 次降为 1 次，三个 distinct baked glyph 在 quad 双消费中各 2→1；map-pitch、box、circle-only、undefined hiding 及独立 view/context 控制保留精确碰撞 bounds 和 dynamics。新增 6 项，定向 126 项全绿。

整合 `city-line-projection-production` 完成 ESLint → 完整 TSC → 65 文件 / 901 单测 → 库/demo build、冻结 287 source / 8 dist。`city-line-projection-dynamic` 12 项硬件回归全绿（2.1min），含 6 项连续相机/符号控制、4 项真实多 glyph curved-path heading/tilt/keep-upright/Y-offset/behind-endpoint 对照，以及 viewport/map opaque line icon 在 0/75/85/89° 的实际 MapLibre alpha 像素与 clip 资格。未改原 0.5px 和动态可见性门槛。

静默公平 `city-line-projection-performance`（38.1s）冷 5311.5ms、221 次绘制，仍为 12 tiles / 457 commands / 111877969 GPU bytes、36 entries、零 evictions；Map cold 844.1ms。四 motion 完整 Scene CPU P95 = 26.4 / 25.3 / 26.0 / 25.3ms，P50 = 18.4 / 18.1 / 16.8 / 16.4ms；Map P95 = 7.0 / 5.2 / 6.7 / 6.0ms。冷加载的单轮下降待反向控制，动态阶段没有一致改善，不能据 901 单测与 12 项硬件回归宣称整体体验已达标。

反向控制 `city-line-projection-reverse-baseline`（37.9s）仅换回 895 构建：冷加载 5278.6ms，Map 846.0ms；四 motion P95 = 27.4 / 25.4 / 24.7 / 26.6ms。旧构建也得到约 5.3s 冷加载，因此不能把首次 6.3→5.3s 归因于沿线投影复用；动态结果同样有升有降。该修改保留确定的同次投影次数减少与完整视觉控制，不宣称已证明整城市 FPS 或冷加载提升。

`city-cv-preparation-production` 将现有 detached CPU continuation 一致扩展至 Columbus View：prePasses 的 queue capability、idle 与 postPasses 入口共享资格；仅当前 Scene/frame 同 mode、真实 Geographic/WebMercator、非 scene3DOnly 的 CV 合格，2D/morph/未知 projection 保留正常渲染路径。六项实际 uploaded owner 消费的 CV 正控旧 RED→GREEN，五项资格负控保留；仅 Native 已上传边界替身，实际 Root、SceneBudget、water owner/geometry 和队列为真实消费者。完整 ESLint → TSC → 65 文件 / 912 单测 → 库/demo build 全绿，冻结 287 source / 8 dist。第一 CV Shanghai 性能重放遇缺失资源而失败，未计成绩；随后独立 capture 补齐相同轨迹，再进行无探针冻结 before/after，结果另记。

Shanghai CV 初始近地平线相机（121.489/31.244、120m、heading115、pitch−1、1569×906）的 `shanghai-cv-preparation-pair-frozen` 无 profile/readback/video/附加observer、分别独立 context 完成同64姿态。901 before cold8462.4ms/367绘制，912 after5767.6ms/251绘制，单pair下降31.84%；双方34tiles/645commands/26338925 GPU bytes相同，initial WC差<0.001m、direction/up/center差<1e−10、zoom差<1e−8。cold CPU P95=17.3/19.5ms，max34.6/34.9、零>50ms。dynamic完整Scene CPU P95=26.5/35.2ms，presentation P95=54.5/48.9ms；不能宣称动态整体改善。初次pair capture完整轨迹跑完但被不必要的initial JSON精确浮点相等断言拦截（direction差约1e−16），保留失败，改用既有物理相机资格后冻结pairGREEN42.1s。其他通用CV/反向试验因未缓存coarse parent/glyph资源失败，均未计成绩；补齐资源的网络capture不计公平速度。reverse仍遇未缓存11/1719/843，不能将单pair写成稳定多轮收益。原始结果及summary见 `.cache/playwright/shanghai-cv-preparation-pair-frozen/summary.json`。

`shanghai-cv-preparation-dynamic` 发布构建的实际64个连续俯仰/升降姿态GREEN31.1s。已读取完整录像16时刻contact和最终原图；与已资格化旧版实际rendered poses比较，zoom最大差0、focus5.1e−6米、position2.1e−9米；未发现新增路宽或符号尺寸异常，墙面在适当俯角出现/隐藏。录像包含启动空白和冷加载，仍保留实际加载体验限制，不以单帧或动态回归GREEN判定全目标完成。

只读核查installed Native Scene.render确认先cameraChanged判定、再设置newFrame=true、再prePasses；Root idle仅在newFrame=false服务。因此新的camera draw不会先推进旧view idle job，此猜测被排除。post CPU按真实剩余deadline服务，已超时帧不执行；vector post若关闭queue capability会失去advanceBuilds，而capability true却不提供idle consumer可能抑制续帧，未引入该不一致组合。

`city-cv-preparation-mode-switch` 使用冻结912源码与Native production硬件控制GREEN15.2s：真实60m/15m白色建筑墙面及street corridor保留，CV→2D→3D相机坐标保持，移除建筑后的像素负控通过，无page errors。最终diff whitespace检查通过。

## 此前阶段检查

ESLint、完整 TypeScript 检查、40 个文件 / 371 个单测及库/demo 构建通过。187 个不同非实网端到端/发布消费者用例在硬件模式下分批验证通过；另有冻结城市重放及独立四轮 ABBA 各一项通过。

187 项不是一次不中断的全绿运行：首轮 109 项通过后停在旧内部几何夹具；修正后 12 个道路和 4 个表面用例通过，Worker 夹具在真实能力初始化后四项通过，其余 58 项通过。失败诊断保留，未算作成功轮次。[验证批次与原始产物索引](../../node_modules/.cache/playwright/continued-verification-summary.json)。

## 复现

```bash
pnpm exec playwright test e2e/camera-dynamics.spec.ts --grep-invert '@live'
E2E_GPU=hardware E2E_LIVE=1 E2E_CITY_RESOURCES=capture pnpm exec playwright test e2e/camera-dynamics.spec.ts
E2E_GPU=hardware E2E_LIVE=1 E2E_CITY_RESOURCES=replay E2E_PROFILE=1 E2E_VERIFY_BUDGET=1 pnpm exec playwright test e2e/camera-dynamics.spec.ts
E2E_GPU=hardware E2E_CITY_PERFORMANCE=1 E2E_CITY_RESOURCES=capture pnpm exec playwright test e2e/city-performance.spec.ts
E2E_GPU=hardware E2E_CITY_PERFORMANCE=1 E2E_CITY_RESOURCES=replay E2E_VERIFY_CITY_BUDGET=1 pnpm exec playwright test e2e/city-performance.spec.ts
```

重放缺失资源会失败，不回退实网。相机覆盖存在调度差异，首次 capture 必须覆盖实际运行所需的全部瓦片。基准的 create/combine 关联按实际返回并传输的结果 buffer 核对；Native TaskProcessor 的消息 ID 仅在各自 processor 内有意义，不能跨 processor 对比。
