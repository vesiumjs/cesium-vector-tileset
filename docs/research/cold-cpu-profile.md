# 冷加载与稳态主线程调用栈

更新于2026-10-04。当前新增瓦片驻留查询重构的配对分配采样及城市长帧分析；保留此前建筑提取与固定版本 shader 归属。正式计时入口的完整调用栈仍来自 Worker 接收所有权版、平面道路 construction 数组删除之前，下面保留其版本边界。采样用于选择改动位置，不是性能改善证据。正式、不采样的计时及验收以[性能基线](./performance-baseline.md)为准。

## 分帧道路重建版的真实城市长帧

本轮原城市重放的 521 个实际渲染帧中，Scene 最大 44.7ms、P95 25.9ms；15 个像素探针帧单列排除。最初摘要遗漏 `pixel-probe-15m` 标签而误报 962.8ms，错误摘要和原始数据均保留，修正摘要见[城市核验](../../node_modules/.cache/playwright/test-results/line-rebuild-budget-city-summary.json)。1ms CPU 样本按前一采样区间与真实 Scene 窗口的交集计权；最大帧约 22.832ms 的 self 采样归于 GC，5.449ms 归于 WGS84 转换。GC 节点没有分配祖先，不能排他归因给建筑、道路或某个临时数组。见[分析代码](../../node_modules/.cache/playwright/test-results/line-rebuild-budget-city-cpu-analysis.mjs)与[逐帧输出](../../node_modules/.cache/playwright/test-results/line-rebuild-budget-city-cpu-analysis.json)。这不是正式 ABBA，也不是所有 isolate 的分配或 GPU 完成测量。

## 固定 Cesium 1.146.0 的 shader 源码核对

核对安装的 `@cesium/engine@26.4.0/Source`：`Renderer/ShaderProgram.js:186–219` 同步调用 compileShader、linkProgram 后查询 LINK_STATUS；`vertexAttributes` getter（112 行）触发 initialize，`Scene/Primitive.js:1115` 的 validateShaderMatching 读取它。异步 combineGeometry 不代表 shader 异步编译。该版本 Source 没有 KHR_parallel_shader_compile 或 COMPLETION_STATUS_KHR 路径；Context 的 validateShaderProgram 默认已为 false，关掉属性匹配也只能将初始化移动到首次绑定，不能据此宣称消除 driver 等待。

`Renderer/ShaderCache.js:94–107` 已按顶点源码 key、片元源码 key 与排序后的 attributeLocations 共享 program。Appearance 实例身份和 paint uniform 不进入该 key；本库位置纹理的共同前缀与 stride 属于 uniform。当前没有证据证明瓦片前缀、颜色或冗余 define 引起重复编译，不能新增一套库级 shader 缓存。PLANAR、LINE_TILE_CLIP、LOG_DEPTH、OIT 与 pick 路径仍有真实消费者。

这份静态核对不能定位历史 getProgramParameter 长等待属于哪个 program。后文独立探针取得了本次 GL 枚举、program/cache key 和 Native owner，但没有复现历史等待或记录全部 cache 命中；这些证据不支持修改编译协议或关闭渲染能力。源码散列和定位见[固定版本核对](../../node_modules/.cache/playwright/test-results/line-rebuild-budget-shader-source-audit.json)。

## 建筑最终输出重构：分配采样与 program 归属

本轮在同一城市资产重放中增加独立的主线程 HeapProfiler 分配采样：32KiB 间隔，并包含随后被 major/minor GC 回收的对象。修改前后各一组 context，均有 149 个建筑 owner、18,989 个实例、3,394,529 个输入顶点，采样协议与硬件保持。提取函数子树的估算分配量 **605,164,692→122,427,156 B**；旧光照 RGBA tuple writer 的 self 估算为 192,157,840 B，新实现已没有该分配点。两项互相包含，不能累加。见[配对核验及执行差异](../../node_modules/.cache/playwright/test-results/extrusion-direct-output-allocation-comparison.json)。

这些是分配量估算，不是保留 heap、峰值、Worker/GPU 或某一 GC 暂停的排他来源。两次请求、帧数、准备调用数和 60m 未完成任务数不同；fixture 自身也分配约 461MB。分配采样的新版本仍有 66ms 帧，另一次未启用 HeapProfiler 的原始城市重放有 79ms 帧，不能把局部分配减少换算为整体 CPU 改善。新版本 79ms 最大帧的 self 统计采样约 41.271ms 归于 GC，同帧没有建筑 owner 准备调用；GC 没有分配祖先，不作排他归因。见[当前逐帧分析](../../node_modules/.cache/playwright/test-results/extrusion-direct-output-city-cpu-analysis.json)。新提取器直接写入 Native 消费的最终数组，具体所有权与旧输出核对见[几何合同](./geometry-and-feature-ownership.md)。

另一组独立运行只增加 program 归属探针，记录 Native cache key、Primitive/DrawCommand owner 与实际 getProgramParameter 枚举。观察到 19 个 program，全部取得 Native key；安装探针后共 21 次查询，7 次达到 1ms。最长为道路 GeometryPrimitive 的基础 program 查询 LINK_STATUS，8.9ms；对应 LOG_DEPTH 查询为 5.2ms。水面轮廓与建筑的基础/LOG_DEPTH 路径也有记录。见[program 原始归属](../../node_modules/.cache/playwright/test-results/extrusion-direct-output-program-summary.json)。这次没有复现历史 25.7ms 等待，未计 cache 的全部命中/释放历史，也不等同于 compiler 内部计时；没有据此修改 shader 编译、关闭 Globe/OIT 或增加预热后备路径。

## 瓦片驻留查询重构

`_replacementReady` 原先合并三个 renderer 的数组，再创建地表/符号结果对象；`drawableCollections` 也复制覆盖资源。现在只读查询直接遍历资源所有者，地表与符号就绪分别计算，SceneCollections 继续管理 successor suppression、部分上传和同瓦片的全部 predecessor。无严格父子关系的瓦片先退出，held 变化保留祖先缓存的 owner，TileID 直接计算 wrapped ancestor key；重复隐藏地表 Set 已删除，使用现有层掩码恢复和清理。

同一 32KiB 分配协议、硬件和建筑输入下，TileResidency 子树估算分配量 **463,660,816→213,565,120 B**；祖先查询子树 **29,962,304→2,723,724 B**，其中原 `scaledTo` 的 **25,321,912 B** 分配点已消失。这些子树互相包含，不能累加。两次准备调用为 4,110/3,865，实际渲染帧为 513/512，60m pending 为 27/29，请求和加载状态也不同，不能把整体分配差值当成排他收益。见[配对分配与限制](../../node_modules/.cache/playwright/test-results/residency-owner-queries-allocation-comparison.json)。

独立普通城市重放有 149 个建筑 owner、4,209 次准备更新，无一次超过 12ms，最长 6.7ms。522 个实际渲染帧（排除 15 次像素探针）Scene P95 **26.8ms**，最大 **135.7ms**；60m pending 13，15m 已加载。最大帧 self 采样约 **86.282ms** 归于 GC，窗内没有建筑 owner 准备调用；GC 不带分配祖先，不能归因给某个函数。该尾帧比前版更长，局部分配精简没有证明 CPU、闪屏或低空吞吐目标完成。见[城市核验](../../node_modules/.cache/playwright/test-results/residency-owner-queries-city-summary.json)与[窗口对齐分析](../../node_modules/.cache/playwright/test-results/residency-owner-queries-city-cpu-analysis.json)。FPS、Globe、Native 异步 combine 和两次可见性交接保持；这些诊断仍不是正式 ABBA、峰值或全部 isolate 测量。

## 道路construction精简前的最新调用栈

按Cesium / MapLibre / MapLibre / Cesium独占硬件运行，1通过、143.8秒、0失败/跳过/重试后通过；主线程CDP Profiler间隔250µs，从导航前采样到cold、完整warm(360)、stationary/slow/fast结束。四份profile与page时基对齐；浏览器、Intel RKL GT1 / ANGLE Vulkan、瓦片SHA、完整样式、34请求和669地理探针与正式入口核对，Globe、OIT和Native FPS保持。采样终态345个冻结文件未变；临时根目录TS harness按SHA归档后移除。见[终态记录](../../node_modules/.cache/playwright/test-results/frame-cpu-profile-terminal.json)、[分析代码](../../node_modules/.cache/playwright/test-results/frame-cpu-analysis.mjs)与[完整分析](../../node_modules/.cache/playwright/test-results/frame-cpu-analysis.json)。

本入口和正式计时均使用Vite变换的库源码entry及正常Worker链路。冻结发布字节用于版本核对，不表示这份CPU profile执行了归档dist；独立分配诊断的实际发布entry属于另一条协议。未采样Worker CPU或GPU完成，采样中的帧计时也有Profiler开销，不能替代正式ABBA。

以下是两轮Native各120个fast帧中的累计近似归属。采样点法把端点落在帧内的整个timeDelta计入；区间交集法只计前一采样到当前采样与帧的交集。后者会将帧尾一部分归给idle，二者都有边界误差。类别互斥，具名owner/内部操作另行记录并相互嵌套，不能累加。

| fast采样累计ms | 采样点：首轮 / 末轮 | 区间交集：首轮 / 末轮 |
| --- | ---: | ---: |
| MVT库 | 30.3 / 32.3 | 24.4 / 25.4 |
| Globe / terrain | 47.4 / 46.3 | 44.7 / 44.1 |
| Native draw / WebGL / state / uniforms | 47.9 / 50.4 | 45.8 / 47.8 |
| 其它Scene / fixture | 31.5 / 28.4 | 29.7 / 27.3 |
| program / idle / 边界不确定 | 3.4 / 2.2 | 16.4 / 14.0 |

真实同步帧CPU累计162.1 /160.8ms。不能把Globe与绘制成本直接归为MVT库；`syncMemoryBudget`、source sync和child Native preparation比transition、held reconciliation和command分类更突出，但也只是库内成本的一部分。当前稳态信号不支持盲目继续添加style/covering缓存。

cold区间交集的库成本为214.0 /294.6ms，在真实462.6 /588.7ms帧CPU累计中仍最大。`createLineGeometry` self10.7 /18.4ms、`lineInstance` self10.2 /11.3ms、`compactLineVertices` self6.6 /6.8ms。这些self时间不是某一可删除循环的收益。采样之后已核对消费者并删除planar construction中会被实际投影完整替换的expanded ECEF数组，保留有Native消费者的ECEF sphere、最终DOUBLE投影centres、encode/bounds、CV/morph、pick和3D路径。该采样属于修改前版本；新版本的正式计时与验收另见[性能基线](./performance-baseline.md)，不能以本页self时间宣称收益。

## records暂存复用版的历史采样

以下来自更早的records暂存复用版，早于packed源点直接Geometry构建、描边/样式镜像和WorkerChannel对象树精简；`bakeLineStripCore`已移除，旧成本不能标为新实现实测。

## 原始证据与边界

独占硬件诊断按Cesium / MapLibre / MapLibre / Cesium运行，1通过、143.969秒、0失败/跳过/重试后通过。实际renderer为Intel RKL GT1 / ANGLE Vulkan，四份main-isolate CPU profile采用1000µs采样间隔。源码、fixture、配置及发布字节的344项冻结散列终态未变；瓦片SHA、请求和样式与正式测量保持，仅本地fixture端口不同。FPS、Globe和OIT保持开启。原始报告、profile路径及核验见[诊断摘要](../../node_modules/.cache/playwright/test-results/line-cold-cpu-profile-summary.json)。

采样从导航之前到页面产生cold测量结果结束，包含模块加载和场景初始化，不能把整个profile时长当作cold wall或Scene CPU。未采样Worker CPU、GPU完成、驱动内部或所有isolate的内存峰值。诊断代码位于忽略目录`node_modules/.cache/playwright/test-results/`，没有加入生产接口或维护中的E2E。

时间转换为：

```text
samplePageMs = (profile.startTime + cumulative timeDeltas) / 1000
               - Performance.NavigationStart * 1000
frameWindow = [frame.time, frame.time + frame.cpuMs]
```

四轮`(Timestamp - NavigationStart) * 1000`均落在获取CDP metrics前后的`performance.now()`之间。复现脚本为[分析代码](../../node_modules/.cache/playwright/test-results/line-cold-cpu-analysis.mjs)，输出为[两种计权结果](../../node_modules/.cache/playwright/test-results/line-cold-cpu-analysis.json)。执行`rtk proxy node node_modules/.cache/playwright/test-results/line-cold-cpu-analysis.mjs`只读取已有采样并重新生成分析JSON，不启动浏览器。

采样点归属法把落在frameWindow内的样本整个timeDelta计入；区间交集法把前一样本到当前样本的区间与frameWindow相交，近似归给当前调用栈。二者都受约1ms采样边界影响，区间交集法尤其会把帧结束之后的idle样本部分归入帧尾。以下两种方法分别记录，不能称为精确阶段计时。

## 冷帧中的成本

下表类别互斥，按GC、unknown、shader、draw、库、Globe、其它Scene的顺序匹配实际调用栈。shader包括具名的创建、组装和cache路径；draw包括JS state/uniform与WebGL入口，不能称为纯driver时间。GC没有分配祖先，不能归因给道路临时数组。

| 采样累计ms | 采样点归属：Native首轮 / 末轮 | 区间交集：Native首轮 / 末轮 |
| --- | ---: | ---: |
| MVT库 | 236.7 / 266.6 | 225.6 / 255.2 |
| Globe / terrain | 85.8 / 130.2 | 77.8 / 119.9 |
| shader创建、组装、cache | 24.6 / 17.7 | 24.6 / 17.7 |
| Native draw / WebGL / state / uniforms | 44.7 / 45.3 | 43.6 / 43.6 |
| GC | 18.3 / 15.3 | 18.2 / 15.3 |
| 其它Scene | 72.2 / 76.5 | 58.3 / 64.8 |
| program / idle / 边界不确定 | 0.0 / 1.1 | 34.5 / 35.4 |
| 合计 | 482.4 / 552.6 | 482.6 / 551.9 |

真实86 / 95个cold frame的同步CPU累计为482.6 / 551.9ms。两种归属法均显示库自身是最大的可实施优化项，但这不解释整个cold wall差距；后者还包含异步加载与稳定帧等待。[原始帧与profile](../../node_modules/.cache/playwright/test-results/line-cold-cpu-profile-summary.json)

库内两个不重叠道路阶段分别是publication中的`stepLineBuild`和firstUploads中的`lineInstance`。采样点归属累计37.7 / 45.3ms及35.3 / 37.4ms，合计73.0 / 82.7ms；区间交集合计72.7 / 82.7ms。前者内部`bakeLineStripCore`为31.8 / 34.9ms；后者内部`compactLineVertices`为13.9 / 21.4ms。这些内部项不能再次相加。`advanceTileConversion`为25.4 / 28.8ms、`stepStandardPolygonBuild`为30.2 / 32.2ms。完整predicate和逐阶段结果见[分析代码及输出](../../node_modules/.cache/playwright/test-results/line-cold-cpu-analysis.json)。

publication `drain`累计103.2 / 121.5ms、firstUploads `pumpFirstUpdates`累计101.7 / 103.1ms是包含内部操作的owner时间，与上表及道路阶段都有嵌套关系。不能将它们加到上表合计，也不能把firstUploads叫作纯buffer上传。

## 最大帧与匿名回调

本次诊断最大帧为23.7 / 23.9ms，实际tileset阶段只有0.3 / 0.6ms，buffer uploads为0。采样点归属中Globe约8.5 / 11.7ms、shader路径7.5 / 6.9ms；区间交集的这两个类别保持相同。此结果只归因本次诊断的这两帧，不替代正式ABBA最大帧，也不解释历史44.3ms帧。[最大帧原始记录](../../node_modules/.cache/playwright/test-results/line-cold-cpu-analysis.json)

实际Native调用链包含`Scene.render → executeCommands → Context.draw → beginDraw → ShaderProgram._bind → initialize$15 → reinitialize → createAndLinkProgram`。可确认shader初始化路径，但无法区分compiler CPU与driver等待；不能凭此将全部cold wall差距归于shader。完整祖先保留在两份Native原始`.cpuprofile`中。

URL为空的匿名节点559 / 565累计39.0 / 44.5ms。同scriptId=6还出现`window.Worker`及`postMessage`，对应诊断运行器在[Worker message listener](../../node_modules/.cache/playwright/test-results/line-cold-cpu-profile.spec.ts:194)读取`event.data?.id`并记录task wall的代码。它没有Scene或shader祖先，采样时刻均在冷帧窗口之外；区间交集法在边界分配0.9 / 1.5ms，不能说整段区间都在帧外。首次读取event.data可能包含消息数据materialization，因此也不能认定39.0 / 44.5ms都是纯诊断开销。

## 后续实施与边界

采样之后已将道路构建移入`line-geometry.ts`，直接读取packed源点并返回Geometry，删除全局Cartesian缓存、flatMap复制、逐顶点角色对象、动态JS索引列表及bake包装。最终索引精确分配，dash/longitude一并累计，顶点/三角形同遍发射，2D compaction根据后继aliases反向一次完成。保留Native bounds、DOUBLE centre、邻点FLOAT舍入、2D合并角色、3D近裁面、pick和Worker combine合同；已有独立FLOAT像素参考及72种旧版Geometry快照通过。该改动对应新的345项冻结版本，不能用本页344项版本的采样量化它的CPU收益。

新实现的独占硬件ABBA已完成，整体冷加载和同步CPU仍没有一致改善；具体计时见[当前验收](./performance-baseline.md)。现有证据不足以删除有真实消费者的ECEF centres或bounds扫描。本页采样没有建立所有isolate内存峰值收益，也未覆盖倾斜3D或15m建筑吞吐；整体生产级目标保持未完成。

## 道路最终 records 与预算报告（2026-10-04）

同一 32KiB main-isolate 分配协议、硬件及 149 owners / 18,989 instances / 3,394,529 输入顶点，`createLineGeometry` 子树估算分配量 **192,446,780→151,212,032 B**，self **119,116,664→84,696,632 B**；`lineInstance` 子树 **60,427,432→47,270,248 B**；`syncMemoryBudget` 子树 **31,362,780→20,818,832 B**。预算原 `update` 子树与新 visitor 子树不能直接解释为相同阶段：报告求和现在位于 update 内；比较包含完整报告的 syncMemoryBudget。调用链子树互相包含，不能相加。前后准备更新为 3,865/3,512，实际渲染帧 512/525，60m pending 29/27，请求 122/126、不同 URL 85/83；不是 retained/peak/all-isolate 内存或排他 CPU 收益。见[配对原始树与限制](../../node_modules/.cache/playwright/test-results/direct-render-inputs-allocation-comparison.json)。

未采分配的普通城市两次重放均 **RED**：单次建筑 owner 首次更新 **12.2 / 15.8ms**，超过原有 12ms 阈值；149 owners 的准备更新分别 5,188/5,084 次。实际 Scene P95 均约 **27.3ms**、最大 **40.5 / 85.8ms**；60m 仍未加载完成，15m 已加载。原失败、两次终态和源码身份均保留，不能拿分配 sampler 的通过替代普通回放。见[首次失败](../../node_modules/.cache/playwright/test-results/direct-render-inputs-city-summary.json)和[重复失败](../../node_modules/.cache/playwright/test-results/direct-render-inputs-city-repeat-summary.json)。

首次超限是 16 instances / 239,409 vertices / 379,791 indices 的 state0→3；该 owner 实际调用窗内约 **11.525ms** 的 1ms 区间采样落在原 Native `packCreateGeometryResults`。区间计权不是逐函数 stopwatch，也不建立 GC 分配来源。见[owner 窗口](../../node_modules/.cache/playwright/test-results/direct-render-inputs-city-owner-overruns.json)和[完整 Scene 窗口](../../node_modules/.cache/playwright/test-results/direct-render-inputs-city-cpu-analysis.json)。

安装版原 `createGeometry` Worker 在 subTask 没有 moduleName/modulePath 时直接消费真实 Geometry，并在 Worker 调同一个 Native serializer；普通 Primitive READY 的 debug 合同仍要求 workerName/path。该合同已用于同一 GeometryPrimitive 的原装 create→combine 链，见[原生源码调查](../../node_modules/.cache/playwright/test-results/direct-render-inputs-diagnostic/native-create-seam.json)。首轮一次发送整批 raw Geometry，普通城市仍 **RED：20.4ms**，2713实例owner窗内约 **19.869ms** 的区间采样落在postGeometry。Native Float64打包离开主线程，但structured-clone仍阻塞发送端；这不是已完成性能修复，见[原始失败与调用窗](../../node_modules/.cache/playwright/test-results/native-create-worker-city-owner-overruns.json)。

随后按连续Geometry顺序限512实例/512KiB逻辑属性与索引字节，真实create回复后才发下一片，最后一次combine消费有序Native结果。单Geometry保持完整；整条链最多两条在途，任意片取消不续发。主线程冻结实例metadata/modelMatrix；source数组保持，Native逐实例独立pack/unpack继续负责几何隔离。现有综合用例先复现未分片513实例首片的RED，再验证完整槽位、512+1片顺序、中间片取消和唯一combine；200组最终Native输出再次逐字节相同，见[原始红绿](../../node_modules/.cache/playwright/test-results/native-create-chunks-diagnostic/red-evidence.json)与[精确几何对照](../../node_modules/.cache/playwright/test-results/native-create-chunks-diagnostic/native-equality.json)。Worker启动/往返、全部isolate峰值、主线程消息物化、Native上传和shader仍分别计量，不从分片门限推断固定耗时。

分片版原场景两次普通重放最长owner **7.4/5.4ms**，149owners、19,400/19,554次准备更新；真实Scene最大仍 **46.1/40.7ms**，60m固定步数内未加载完成，15m已加载。当前Scene窗口仍包含postGeometry、lineInstance、paint、tile管理与draw等成本，1ms采样只用于定位，不能推导排他CPU或Worker收益。见[两次原复现](../../node_modules/.cache/playwright/test-results/native-create-chunks-city-summary.json)、[重复](../../node_modules/.cache/playwright/test-results/native-create-chunks-city-repeat-summary.json)和[时钟对齐调用窗](../../node_modules/.cache/playwright/test-results/native-create-chunks-city-cpu-analysis.json)。正式ABBA cold wall与整体CPU仍未证明改善，具体表及观测变化见[当前基线](./performance-baseline.md)。
