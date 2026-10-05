# 几何与要素数据所有权审计

更新于 2026-10-05。针对 Primitive 渲染实现的所有权审计与重构记录。下文区分修改前的持有路径、已实施的内部交接，以及 Worker 交互快照重构；实际内存验收与性能验收分别记录。

## 几何输入的实际持有者

`TilePyramid → Tile.geometry` 持有 Worker 产生的 bucket family 几何。同一 family 的多个样式图层共享该几何。`bucket-geometry.ts` 的 WeakMap 同样以 bucket 为键缓存几何；pattern 轨道的 tile state 保存 bucket，因此退出某个渲染记录不代表源几何已经不可达。

修改前，`VectorTileRenderer._records / _retired → VectorTileRecord.result` 还保存转换后的面、点和线。面记录包含 positions、triangles、material、pickObject；点记录包含 Cartesian3、material、pickObject。普通填充面的 triangles 往往与源几何共享，不能把删除一个引用误算成释放一份数组。

修改前，`tile-renderer.ts` 中的 `radialOffsetCache` 是模块级 `WeakMap<源 positions, Map<偏移, 新 positions>>`。源数组仍由 Tile 持有时，所有已缓存偏移数组也仍可达。同一源几何重新构建时，缓存的生命周期超过一次构建；原“不会延长 tile result 生命周期”的注释不足以描述这一行为。pattern 轨道也调用相同的偏移函数，因此仅调整 vector 记录不能完整解决持有问题。

Cesium BufferPolygonCollection / BufferPointCollection 在 add 时复制输入。Native GeometryPrimitive 的异步准备则仍可能引用原 GeometryInstance 输入，必须让 Native 保有这些数组直至它自身释放或销毁。移除调用方引用可以，清零、截断或 detach 共享数组不可以。

## 哪些运行期数据仍然必要

`vector-paint-updater.ts` 的面与点更新只需要要素身份和样式。Native Buffer 在 `add()` 时已保存 custom pick object，首次上传前即可通过公开的 `get(index, scratch).pickObject` 读取；standard paint entry / PointPrimitive 也保存相同身份。因此当前直接遍历 Native 已拥有的身份，不再保留转换后的面、点，也没有另建 O(F) 拾取数组。Buffer scratch 仅在一次 paint walk 内复用，避免通过 `_collection` 持有退休 owner。

线轨道不同：`line-renderer.ts` 会保留源中心线，用于宽度、虚线布局和样式变化时重新构建。当前不能一并删除 linePrimitives。已完成的 expanded line geometry 缓存拥有构建生命周期，不能把它与仍必要的源中心线混为一谈。

surface 发布后，转换任务还会向同一个 result 追加点；建筑直接由自身 bucket 构建，不再生成平面 polygon 镜像。当前 builder 保留唯一 result，面/点轨道完成即清除对应输入；最终 commit / append 接管所需 line/layer 与 standard entries 后断开 result。Surface record 不接收尚未发布的中心线；取消 detail 后已发布的 fill 继续拥有自己的 Native 资源与 paint 状态。逐要素样式镜像的删除见下文。

普通填充以前生成每顶点两个 Float64 的图案坐标，再在 Worker 传输前逐项删除该字段；细分器输出又经过一份坐标 Map、三个动态数组及索引重排。当前普通面不构造这 16 B/顶点的坐标数组，直接接管细分器的顶点顺序和索引并写最终投影数组。图案通过明确的输出类型取得精确 tile XY；若已有普通面，图案复用其 position/index backing。Worker 分派并入同一个几何模块，删除单独的转调文件。这是数据生成和消费者证据，尚未重新测量全部 isolate 峰值或整体 CPU 收益。

## 构建缓存与取消

在现有 `VectorTileBuilder → VectorTileRenderer` 接口内部完成交接，没有新增由调用方排序的 release 协议。Vector convert 与 pattern build 各自拥有偏移缓存；同一构建的同源同偏移继续复用，完成或取消后断开缓存。Native 与必要道路中心线继续持有各自输入，未截断或 detach 共享数组。

Pattern abandon 原先只从 `destroyPrimitives:false` 的 staging collection 移除 Primitive，没有销毁已经封装但未发布的 Primitive，也未断开 `layerResume.groups`。当前在取消路径销毁这些 detached 资源并清理临时引用；commit 替换 build 字段，不截断已交给 `_tiles` 的 entries 数组。

独立审查还发现 pending group 没有 material 引用：悬停构建使用旧材质时，最后一条 live 引用移除会提前销毁它；同 atlas 的新 opacity 构建取消则会留下零引用材料。当前首次创建 group 就取得一条引用，seal 原样交接，abandon 或已有无效输入跳过分支归还。Atlas build hold 仍独立保护共享纹理。不全局扫描零引用材料，以免误伤另一个悬停构建。

真实单元 RED 覆盖完成后仍存活的 handle、surface 后取消 detail、首次上传前 paint、跨构建缓存隔离、非空 pattern 中途取消，以及多个 pending/live group 共用材质。原始日志：`node_modules/.cache/playwright/test-results/cpu-geometry-ownership-red.log`、`node_modules/.cache/playwright/test-results/pattern-pending-material-red.log`。最终相关 GREEN 与全仓 70 文件 624 单测通过；这些结果验证所有权与行为，不直接给出释放字节。

## 内存测量方法

修改前已用实际 MVT 建立 GC 后基线，再实施并复测。3D / 2D 各三个全新 context，固定伦敦视角、1280×720、DPR1、6 个源瓦片；保留 Native FPS 和 Globe，等待 `tilesLoaded` 与 121 个真实 postRender 帧，覆盖 Native 异步上传与延迟清理。用 CDP `HeapProfiler.collectGarbage`、`Runtime.getHeapUsage` 采样页面主线程 heap / backing storage。CDP backingStorageSize 包括 ArrayBuffer 与 external strings，不能直接称作纯数组大小；构造输入的唯一 ArrayBuffer 字节另行遍历去重。不测 Worker heap、GPU 内存或进程 RSS，也不把 GC 放进帧耗时对比。

负载沿用全球 z14 对齐的 1024 地块、128 道路，另加 1024 个圆点，因此不与原正式性能负载混用。公开 `setStyle` 重排图层时，请求数不增加，但 Worker 从现有数据重构了源几何；WeakMap 身份记录确认 buffers 更换。这组公开重排不能用于宣称同一源数组上的偏移缓存累积，跨构建隔离由直接 converter / pattern 回归验证。

数组 backing storage 的可释放字节只能按唯一 ArrayBuffer 计算：删除引用后不可达的 buffer，扣除仍由源 Tile、Native、线轨道或其他记录持有的 buffer。不要把 Cartesian3、JS 对象大小、Native GPU buffer 容量与 ArrayBuffer 字节相加成“总内存”。

## Worker 要素交互快照（2026-10-03）

旧路径在 Worker 解析 MVT/MLT 后复制 rawTileData 回传，Tile 保存原文，FeatureIndex 在主线程再次创建解码器；pick 与 feature-state 是实际消费者。GeoJSON 和 overzoom 还为此重新编码 protobuf。现在每次完整 parse/reload 生成一份 FeatureSnapshot，直接替换本代次的主线程交互数据；原始下载、decoded parent、overzoom 切片及 reload 数据继续由 Worker 持有，没有删除真实源缓存来制造内存收益。

快照选择非空输出桶的拾取 membership，加所有 vector 与 symbol text/icon paint spans 的要素并集。索引仍为原 source-layer 的稀疏 feature index，保留完整 source-layer 字典顺序和已解析 promoted ID。只有 state-dependent AST 中出现 within/distance 才携带 EXTENT 归一化源几何，坐标与 ring 边界使用 typed arrays。main 不伪造 VectorTileLayer，不保留 raw decode fallback。

属性以共享 key/value 字典和 typed entries 传输；嵌套属性交给原生 structuredClone，隔离原输入与每次 lookup 的返回对象。删除 JSON 前缀编码、自制 JSON codec 与 value-kind 标记，保留 MLT scalar/nested BigInt 和普通 `$name` 键。字典对标量按类型去重，对对象按输入身份去重；没有声称不同对象的结构去重。

ProgramConfigurationSet 直接消费 FeatureLookup。每个 span 保留 ID 与 formatted section，原生 Map 按 String(id) 索引，删除 FeaturePositionMap 的数字归一化、哈希、自制排序及单独传输。初始 Worker paint 与 main state 更新均携带 canonical、availableImages 和对应 section；新 paint 加载重置 state revision，etag-unmodified 保留本代数据与 revision。

真实 Worker → Cesium projection → registry → structuredClone transfer → Tile/public pick 的旧流程 RED 记录了 promoted ID（12 得到 11）、同 revision reload（10 得到 2）、overzoom 新层拾取 undefined、nested GeoJSON 属性/null 损坏。接线后的独立审查又以真实流程复现初始 image context（4 得到 1）和合法 MLT BigInt 属性 JSON 编码异常，两项也已修复。另覆盖 symbol-only 要素、多个 formatted spans、canonical/composite geometry、属性隔离与真实 buffer detach。

原始记录：`node_modules/.cache/playwright/test-results/feature-snapshot-red.log`、`feature-snapshot-image-context-red.log`、`feature-snapshot-mlt-properties-red.log`；最终功能检查是 **74 文件、685 单测通过**，见 `feature-snapshot-{eslint,tsc,tests}.log`。最终源码的完整 Intel 硬件回归为 **161 通过、0 失败、0 跳过、0 重试后通过**，包括 published MLT 的实际拾取/state；Native FPS 与 Globe 保持开启。浏览器 payload、GC 后保留数据、包体积及正式 ABBA 按相同负载前后采集，最终记录见 [性能基线](performance-baseline.md#worker-与内存)。逻辑消息字节、CDP backing storage、heap 和 GPU 储存分别计量，不相互替代。

MLT wrapper 已通过 normalizeFeatureId 保留缺失 ID 为 undefined，安全 bigint 转 number，不安全 bigint 转十进制字符串。既有 vector-tile-mlt 单测覆盖 UINT64 边界，MLT 发布入口 E2E 验证 9007199254740993 的拾取及 feature-state；本批没有重新运行该浏览器用例。

## 当前结论

2026-10-04 的投影所有权重构将 fill/line/circle 几何归入唯一 `Bucket.projectedGeometry`。原 actor registry 会为每个图层 alias 递归重建一份普通 payload/path 对象图，虽然 typed array 的 backing 已去重；新协议随唯一 Bucket 只传一份。Tile、publication、builder 和 converter 的独立 geometry map/参数链已删除，样式 alias 仍保留用于 paint 和 pick。

道路直接计数并写入两块 Float64 owner，路径持有稳定 subarray，未先分配逐路径数组再复制。共用 segment 网格遍历保留原轴选择、舍入、buffer、端点去重和闭合次序。原始实际 actor 路径的 5 组诊断先 RED 后 GREEN，覆盖多图层、重复点、闭合、buffer、z0 与 z8 网格；投影和传输恢复后的每条路径 Float64 字节 SHA 均与精确旧版相同。8 aliases、128 paths 的对象图从 8→1，投影 ArrayBuffer 从 256→2，整体 transferable 数从 384→130；有效投影容量仍为 12,800 B，不能把对象/分配减少当作几何字节、heap 峰值或总体 CPU 收益。见 [原始与最终诊断](../../node_modules/.cache/playwright/test-results/projected-owner-diagnostic-evidence.json)。

既有 actor 综合回归同时验证移除原首层后 surviving casing/dash 正常使用同一 owner、稀疏 featureIndex 与多路径范围、源 UV 保留及稳定 view 身份。完整 reload 的新 buckets 身份、模式细分兼容判定和本地 WeakMap cache 保持；Pattern-only 不投影，低 zoom planar fallback 不覆盖 Worker globe owner。

构造/运行期交接、偏移缓存生命周期、pattern 取消与 pending material 所有权，以及 Worker 交互快照已实施。整个生产级目标仍开放：同条件 MapLibre 性能差距、剩余渲染问题和完整生产验收没有因局部 GREEN 自动关闭。验证范围与实测数字见 [性能基线](performance-baseline.md)。

同日六次精确发布包 / MapLibre 的无 GC isolate 采样已完成数据收集：投影所有权版主线程 warm JS used sampled peak 217.78 /218.32 MiB，MapLibre60.11 /60.52 MiB；各 Worker 波动和非原子集合指标未证明整体下降，短命 transfer-test 仍有漏测。这个结果包含引擎与 fixture 开销，不能全部归因于本库或用256→2的结构结果替代。字段、阶段和覆盖限制见 [全部 isolate 内存诊断](all-isolate-memory.md)。

## 按消费者生成填充描边（2026-10-04）

随后独立运行原发布包与 MapLibre 主线程 allocation/post-GC 快照诊断。Native 的 GC 后 JS used 为176,300,024 B，MapLibre45,354,324 B；这是两个独立 context 的诊断终态，不是无 GC 峰值或总体内存。65536 B Poisson allocation sampling 包含已被 major/minor GC 回收的样本，按 URL 归属的加权分配估计中，本库发布 entry 约406.8 MB、Cesium约277.0 MB、fixture约7.2 MB；不能将采样权重当作精确分配或 retained bytes。原始协议与结果在 `node_modules/.cache/playwright/test-results/main-heap-profile-harness.txt`、`main-heap-profile-terminal.json` 和 `main-allocation-summary.json`。

原始 Native snapshot 沿 `mesh.outlinePaths → Array element → path.positions/tilePositions → internal buffer → backing_store` 去重，得到106,540个实际描边数组、106,540个路径对象及213,080份Float64 view/backing。这些 backing_store 节点的 shallow self-size 合计21,309,600 B。另有一个属性形状指向 `system / Hole`，单独记录，未当作路径数组。这是具体持有路径与唯一 backing 的证据，不是 dominator retained size、物理 RAM 或可与 Runtime 各字段相加的总内存。离线脚本与结果为 `node_modules/.cache/playwright/test-results/fill-outline-backing-analyze.mjs` / `fill-outline-before-backing.json`。

负载中的34块瓦片包含65,570个Worker fill mesh，低zoom二维转换另缓存40,970个mesh，正好对应上述106,540份描边。两层样式均为fill-antialias=false，renderer没有描边消费者，旧实现却在Worker与本地mesh提取时全部生成。当前mesh只记录源polygonIndex和原subdivision；实际可见描边才从源ring/holes投影，按mesh身份复用。普通未细分mesh不创建点元组，Worker不生成或传输描边数组。低zoom球面/二维mesh仍各有真实用途，本批没有改动其所有权。

真实WorkerChannel集成用例先RED（wire mesh仍含outlinePaths）后GREEN，并覆盖传输后启用描边、源UV、共享图层、低zoom MORPH与原细分粒度。ESLint、完整TypeScript、75文件667单测、库/demo构建通过。首轮硬件定向32通过、1失败：栅格源URL切换出现两帧白屏，实际Primitive ready但Material仍是1×1默认纹理，原始失败保留在 `node_modules/.cache/playwright/test-results/fill-outline-targeted/`。这个批次仍记为失败。

修复栅格首帧上传后，同一新材质第一帧只调用一次真实Native Material.update的换源用例三次RED→三次GREEN，逐帧coverage断言保持。当前组合版33项硬件定向和正式ABBA通过，345冻结及发布归档终态不变；当前主线程CPU没有一致收益。详见 [当前验收与计量](performance-baseline.md#当前验证)。

另外以原协议在两个新context执行Native→MapLibre主线程诊断。GC后Native JS used176,300,024→144,126,672 B、backingStorageSize98,848,853→77,540,158 B，MapLibre JS used45,354,324→45,366,692 B。独立扫描全部具有closed及两份Float64投影属性的路径对象，106,540→0、Float64 view总数376,980→163,900；对应213,080份唯一backing、21,309,600 B shallow self-size消失。该扫描不依赖被删除的outlinePaths键，覆盖WeakMap持有的同形状路径。Color270,942与PickId73,762保持，说明仍有其它真实持有成本。源请求集合、34 featureIndexes、8活跃/26退役、669探针、硬件与FPS已核对；见 [前后诊断](../../node_modules/.cache/playwright/test-results/fill-outline-memory-summary.json)。主线程post-GC终态、结构backing和Poisson分配估计分开报告，不外推全部isolate峰值、物理RAM或最小生产环境。临时TS诊断已归档移除。

## 删除逐要素样式镜像（2026-10-04）

上述版本的原始快照沿`styleCache.styles → Map table → layer Map table → feature value → color/outlineColor`找到34个record的102个Map、65,570个样式值及131,140个Color。有效缓存已经跳过整个要素遍历，失效缓存总是重新求值；Native packed material/attributes和PointPrimitive setter已接管颜色，额外Map没有独立消费者。当前删除这条Map和值的构造、seed、传递和paint helper，只保留输入与revision标记。标准面的entry仍用于比较和更新实际Native属性，没有新建颜色codec或兼容路径。

既有综合用例复现另一处时序问题：点conversion已生成旧蓝色，组装暂停时feature-state变为橙色，surface先刷新至当前标记；随后追加旧点，3D paint误命中该标记。原版2D通过、3D实际Native颜色失败；append无条件失效后两种模式通过，并保留缓存命中不重复求值。初始harness误读2D集合层级及要求实现求值次数的失败另行保留，未当作产品RED。原始核心SHA与有效颜色RED见 [复现](../../node_modules/.cache/playwright/test-results/paint-cache-red-evidence.json)。

相同主线程协议复测：Map/样式值/镜像Color持有链均为0，独立扫描颜色加描边的样式对象65,571→1，全快照Color270,942→139,802，PickId73,762保持。GC后Native JS used144,126,672→131,644,520 B，MapLibre45,366,692→45,366,340 B；backingStorageSize未降低。源码、fixture、精确发布字节、请求完整集合、8活跃/26退役、669探针与FPS核对通过，临时TS已归档并移除。见 [内存证据及范围](../../node_modules/.cache/playwright/test-results/paint-cache-memory-summary.json)。这是单次主线程GC后诊断，不外推全部isolate峰值、retained dominator大小或物理RAM。

ESLint、完整TypeScript、75文件668单测、库/demo构建与38项独占硬件回归通过，覆盖实际15m白模；正式ABBA同条件通过但未证明整体CPU收益。生产级目标仍开放，当前数值和后续范围见 [性能基线](performance-baseline.md)。

## 接收消息对象树的所有权（2026-10-04）

随后主线程allocation记录把deserialize自身85.1MB和entries47.4MB采样权重指向WorkerChannel消息恢复：浏览器已经结构克隆出独立wire图，registry又以map/Object.create/逐属性descriptor恢复了一份。生产WorkerChannel三个接收入口均先取得唯一任务或response lease，每个payload仅恢复一次；没有下游复用原wire的合同。原版三个真实bucket/expression/generated-array综合用例在根身份检查RED，29项其它传输/覆盖行为通过。另一个既有覆盖用例记录两个稳定postRender仍读取并克隆4份Native rectangle。见 [原始核心SHA与RED](../../node_modules/.cache/playwright/test-results/wire-ownership-red-evidence.json)。

当前接收端原位恢复数组与普通对象，类在字段恢复后删除wire标记、设置本地注册原型并运行原restore；static StructArray codec仍创建必要实例/view。shallow用户值、嵌套BigInt、表达式overload、稀疏holes、buffer去重/真实detach与Worker/runtime原型合同保留。发送端仍独立生成wire，Worker源数据继续供reload使用。没有新增循环图、对象别名或兼容协议；恢复输入被消费，发生错误也不重用半恢复图。Globe快照只延后到原有变化判断之后，真实变化仍复制冻结坐标，camera补充覆盖的交接帧保持。

同协议诊断的Native加权分配估计773.8→654.0MB、发布entry327.9→246.9MB，deserialize自身85.1→5.4MB，entries归属47.4→3.0MB；权重不是精确分配。GC后Native JS used131,644,520→131,757,608 B、backingStorageSize77,542,137→77,542,241 B，没有常驻内存下降结论。请求完整集合、34源记录、8活跃/26退役、669探针、硬件、FPS及345个冻结文件核对通过，临时TS按SHA归档移除；见 [协议和前后实测](../../node_modules/.cache/playwright/test-results/wire-ownership-memory-summary.json)。没有Worker或无GC总体峰值声明。

668单测、类型/ESLint、库/demo构建、43项独占硬件回归及两次正式ABBA通过。第一次新断言错误要求FillLayoutArray别名子类，实际原协议恢复共同StructArrayLayout2i4；按真实codec合同校正后的668通过。两次当前fast尾部仍略高于前版，不能把分配减少当作CPU改善；具体数值和未完成项见 [性能基线](performance-baseline.md)。

## 标准面颜色状态（2026-10-04）

根样式快照修复版的冷/预热 heap snapshot 沿 `VectorTileRenderer._records / _retired._entries → record.standard.polygons → entry.color` 找到库重复保存的 Color：冷态 8 个 record、8,200 份；完整预热后 34 个 record，其中 26 个退役、65,570 份。Native 同时保有实际实例颜色、拾取 Color 和包围球。库的 entry 颜色只用于比较下一次 paint，不需要浮点 Color 实例。

当前以 Cesium `Color.toRgba()` 保存实际颜色字节，并独立保存 show。更新沿原实例属性接口；属性写入后才提交对应缓存值。共享 Uint8Array 由 Native 构建属性或 batch-table setter 同步复制。既有综合单测先在旧实现上 RED，再覆盖首次准备前更新、颜色字节跨界、同字节不写入及 alpha 为零/微小正值时的 show 区别；不增加维护测试案例或诊断接口。

两版实际发布入口各在新的 Native→MapLibre context 中执行相同诊断，分别完成 cold-ready 和完整 360 步预热后的显式 GC/快照。前后版本、临时 TS harness、fixture、浏览器、硬件、34 个请求集合、669 个地理探针和源/缓存 stats 都已核对。库的上述 Color 持有链 **65,570→0**；全主线程 Color **139,802→74,232**，PickId **73,762** 保持。标准面 owner 的 98 个 Primitive/batch-table、65,570 个 Native pick Color、65,570 个实例 bounds 和原缓存数量保持，未删除 Native 实际消费者。

| 主线程显式 GC 后 JS used，B | 修改前 | 修改后 | 差值 |
| --- | ---: | ---: | ---: |
| Native cold-ready | 56,069,520 | 55,539,788 | −529,732 |
| Native 完整预热后 | 131,944,512 | 127,603,440 | −4,341,072 |
| MapLibre cold-ready | 43,582,192 | 43,586,928 | +4,736 |
| MapLibre 完整预热后 | 45,794,224 | 45,794,420 | +196 |

预热后的 Native JS used 减少约 **4.14 MiB**。backingStorageSize 仅减少 2,533 B，不能声称 TypedArray/GPU 容量改善。cold 快照改变了后续 warm 的诊断包络，两版采用完全相同流程；每版仅一组 context，只测主线程显式 GC 保留状态，未测 Worker、无 GC 加载峰值、RSS、VRAM 或帧 CPU。对象 shallow size、external-string bookkeeping 与 Runtime 字段分开记录，不计算排他 retained 大小。见[原始身份与持有链核验](../../node_modules/.cache/playwright/test-results/standard-owner-memory-summary.json)。临时 TS 已按 SHA 归档并移除，维护测试没有增加。

## 道路宽度的唯一消费者（2026-10-04）

`LineStyleLayer.recalculate` 原先为 MapLibre GL 的 `line-floorwidth` 再求值一次宽度。`ProgramConfiguration` 枚举所有 paint 值，会额外创建 source/composite binder、写入每 paint slot 4/8 B 数组，并随正常 WorkerChannel 链路传到主线程；feature-state 又更新这份数组。当前 Cesium `lineStyleForFeature` 仅消费 `line-width`，全生产、生成器与注册搜索没有 floorwidth 消费者。

因此整条合成 property、模块缓存、额外 recalculate、重复 binder/数组及仅它使用的 `useIntegerZoom` 字段已删除。真实宽度继续求值一次，composite 使用实际分数 zoom；pattern/dash 的整数层级 crossfade 和 gradient 行为不经过该字段。没有新增兼容分支或传输协议。

既有传输综合单测在同一个实际 Worker bucket 放入 source/composite 两个共享几何图层，经过 `serialize → structuredClone(transfer) → deserialize`。宽度分别验证 2→12、分数 zoom 2.5 的 3→18；更新后每图层只有真实宽度 binder，实际数组为 4/8 B，几何与 feature ranges 身份和内容保持。旧实现 **4通过、1失败**，失败为恢复出无人消费的额外 binder；随后既有传输、solid line、dash、paint slots **49通过**，完整 **668通过**。见[原始RED及源码身份](../../node_modules/.cache/playwright/test-results/line-width-owner-red-evidence.json)和[完整检查](../../node_modules/.cache/playwright/test-results/line-width-owner-checks.json)。

库 main **475,235→474,555 B**，Worker **430,340→429,660 B**；合计减少 **1,360 raw B、348 gzip6 B**。这是死路径删除与实际发布字节证据，未测全部 isolate heap 收益。正式二维性能负载使用常量宽度，没有这份 data-driven 数组，不能用该计时推断真实城市数据驱动宽度的内存/CPU收益。见[精确发布版本](../../node_modules/.cache/playwright/test-results/line-width-owner-bundle.json)。

## 实体建筑与轮廓的 Native 所有权（2026-10-04）

实体工厂及3D填充轮廓复用已有 GeometryPrimitive 的 `native` 布局和 context combine Worker；保留 Native 原属性、Appearance、实例 ID 与 feature generation。转移的是 Native 新建的 packed 缓冲，源 Geometry/中心线不被 detach；Native 继续拥有 batch table、VA、pick 和 ready。成功排队后单独让出一次 update，下一次初始化 Native，旧内容在替代可绘制前保持。

轮廓的 paint owner 只保存实际实例 ID 与 zoom 依赖，不另存比较颜色副本。construction setter 与 Native setter 均复制颜色 scratch，合并回调不覆盖最新 paint。外圈/洞的同 featureIndex 只共享样式求值，各实例真实 ID 保持独立；透明轮廓由原 shader/pick alpha 处理。水面/道路组合与小数 zoom antialias 先 RED 后 GREEN，维护案例数不增加。该轮廓复用阶段完成 668 单测、28 项硬件回归和两次固定城市全 pre-ready 诊断；其 44.7–50.5ms 整帧长尾、全部 isolate 峰值及整体体积未闭环。当前版本另见[验收基线](performance-baseline.md)。

## 建筑几何与实时 paint（2026-10-05）

实体与表面/图案仍使用同一个提取 kernel。`solid` 输出最终 ECEF、FLOAT 面法线、FLOAT top 权重和索引，不保存没有消费者的 tile 坐标、高度中间数组或 CPU 光照 RGBA。默认表面输出继续保证图案 UV 所需坐标与原有颜色。法线保留 packed 源值，以 FLOAT 存储避免 Native 日期线分割将整型插值误差截断一单位；top 保留细分与分割产生的连续权重。输入仍由 Native Geometry/GeometryInstance 持有至批表、拾取与 VA 上传完成，不能提前 detach 或截断。

build-local 轴缓存保存 sin/cos 与纬度法向半径，直接写最终位置，WGS84 运算顺序、wrap 和极点分支保持。细分按已知顶点数分配 typed arrays，未共享顶点不维护 dictionary。普通建筑始终提取球面拓扑，Native 管理投影、日期线、双坐标属性与模式包围球。

ExtrusionPrimitive 保存原实例 ID 和实际 height/base 签名，颜色、透明度、渐变写 Native instance table，光照写同一 Appearance uniform 对象。光照不逐要素求值，paint 不重建 ECEF/create/combine/VA，高度或基底变化才替换。初始 opacity=0 延后第一次上传；首次显示构建一次，之后隐藏/显示复用资源。实例属性变化仍使 Native 上传批表纹理。透明外表面使用背面剔除的单 pass，恢复不透明时关闭混合并写深度。

GPU 使用 MapLibre 光照公式分别计算源底/顶的 rounded 颜色，再按 top 权重插值；保留 Native gamma、拾取和深度。旧 CPU 输出曾在细分和 Native 日期线阶段两次截断颜色，现在连续权重合成后量化，日期线细分处可能有一个颜色字节的舍入差异，不能再宣称旧 RGBA 逐字节一致。此前 50 组旧提取输出的[对照结果](../../node_modules/.cache/playwright/test-results/extrusion-output-diagnostic/comparison-terminal.json)只代表那次 CPU 输出重构；当前像素、日期线、资源身份及验证证据见[性能基线](performance-baseline.md)。

## 最终道路缓冲与预算报告（2026-10-04）

3D `prevOffsets/nextOffsets` 仅由 preparation 复制到最终 records，故整条中间 backing 删除，直接从 retained DOUBLE centreline 写最终 Float32；保持端点 DOUBLE reflection 后再相减，不改为负差值。无重复点时恒等 retained Uint32 也不创建，非 round join 不创建 fan 两数组；当前统一道路布局保留完整 incoming/outgoing 角色，已删除二维 aliases/compaction。实际 expanded Native position、source topology、indices、bounds、batch IDs、pick 和纹理上传仍有消费者，继续保留。

此前单轨准备清理捕获了 200 组 Native preparation/combine 输出，包含日期线、闭环虚线、重复点、厘米短段、负零、折返、端帽、两种投影和 2D/CV/3D；该次修改的最终 records、attributes、indices、bounds、modelMatrix 和 pickOffsets 字节相同，源 Geometry 未被修改。当前双轨布局的容量、模式交接与独立 FLOAT GPU 对照另见[当前性能基线](performance-baseline.md)。现有厘米/日期线/闭环断言改读实际最终 records，FLOAT oracle 独立从 DOUBLE 坐标计算；没有增加维护测试用例。初次 throwaway 比较断言因显式 undefined 与 JSON 省略字段失败，输出已相同；原失败保留，统一序列化比较后通过，见[精确对照与边界](../../node_modules/.cache/playwright/test-results/direct-render-inputs-diagnostic/native-equality.json)。

预算报告只保留 `visitMemoryEntries` 一条生产路径，直接更新已有 tracked map；删除原 renderer 数组接口、host 二次 entries、retained/evicted Set。Pattern 仍按 Primitive 身份去重；symbol held/fading pinned、完整 seen、pinned recency、retired 顺序及真实 Native 容量仍保持。测试需要观察时自行物化报告，不让生产继续承担诊断数组。

## 原装 create 与 combine 的完整任务链（2026-10-04）

主线程不再调用 `packCreateGeometryResults`。安装版 createGeometry 在 subTask 未指定 moduleName/modulePath 时原样消费已构建的 Geometry，并在 Worker 内执行同一 Native serializer。主线程克隆输入，保留 source position/indices；每次原生结果的独立 Float64 缓冲才加入最终 combine 的 transfer list。Native packCombine 返回同一 createGeometryResults 数组，按连续片顺序追加结果；Native unpack 使用全局实例索引，最终 batchId、pick offsets 和 GeometryInstance 顺序保持。公开 Primitive.modelMatrix 在首次准备时 clone，避免 create 等待期间原位修改影响提交快照。

两条 logical chain 共用唯一 pending Map/id；全部 create 片及最终 combine 持续占槽。每片最多512实例与512KiB逻辑属性/索引字节，单超限 Geometry 独立且不拆拓扑。取消在真实回复后解槽，create阶段停止剩余片，combine阶段等待已发结果；最后 context reference 终止两个原装 Worker 并回收CDN bootstrap。

现有两槽综合用例在未分片实现上先 RED（首片513实例而应512），随后验证512+1片顺序、完整槽位、唯一combine、实例ID及共享数组；取消用例在1025实例的中间片停止。首轮试验曾一次发送整批2713实例，普通城市仍 RED 20.4ms，约19.869ms的区间采样落在postMessage调用路径；分片是对该真实克隆阻塞的修正。原失败保留，见[最小RED](../../node_modules/.cache/playwright/test-results/native-create-chunks-diagnostic/red-evidence.json)与[整批克隆窗口](../../node_modules/.cache/playwright/test-results/native-create-worker-city-owner-overruns.json)。

同一200组Native输出再次逐字节相同，包含final records、attributes、indices、bounds、modelMatrix和pickOffsets，源Geometry保持不变。见[精确对照](../../node_modules/.cache/playwright/test-results/native-create-chunks-diagnostic/native-equality.json)。门限计量逐geometry occurrence的逻辑view字节，不是去重的克隆backing、wire payload、Worker CPU或全部isolate峰值。
