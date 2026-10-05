# 加载与预热期的全部 isolate 内存采样

更新于 2026-10-05。当前发布入口独立 cold + `warm(360)` 诊断得到 1,331 条样本，8 个持久 isolate 与一个短命 transfer-test 均有有效数据。此前六个 context 的 5,342 条样本另列为历史对照。**尚未完成总体瞬时峰值验收，也没有证明整体内存下降。** GC 后 retention、单 isolate 最大观测与非原子集合之和分别保留，不能互换。

## 当前发布入口：新增 create Worker 后

当前冻结 346 项，main/Worker SHA 与梯度清理版一致；通过正常 Vite 模块处理执行实际 `dist/index.mjs` 和对应 `dist/worker.mjs`。一个独立 hardware context 完成 cold 和全部 `warm(360)`，22.0 秒，0 失败/跳过/重试后通过。8 个持久 isolate 为 main、3 个 MVT、Native create、Native combine、heightmap、terrain picker；全部有稳定的实际 `Runtime.getIsolateId`，其中 create/combine 分别有 15/14 个 cold 与各 145 个 warm 样本。另一个约 23ms 的 transfer-test 采到 1 个有效 RPC；该次发现的 9 个 target 都有样本，不意味着完整生命周期的连续采样或精确峰值。其启动前约 17ms、结束前约 1.7ms 未采区间仍保留。

| 当前 warm 的单 isolate 最大观测，MiB | JS used | JS total | embedder | external/backing |
| --- | ---: | ---: | ---: | ---: |
| main | 157.47 | 206.64 | 10.61 | 125.53 |
| Native create | 13.29 | 27.50 | 0.75 | 4.99 |
| Native combine | 8.61 | 28.00 | 0.72 | 12.50 |

四格可能来自不同时间，不能相加；其余 MVT/terrain 样本、每字段 cold/warm 峰值、实际 RPC 区间和缺口在[完整汇总](../../node_modules/.cache/playwright/test-results/native-memory-current-diagnostic/summary.json)。分类新增 native-create 和明确的 terrain 身份，持久总数从历史 7 变为 8。原始 discovery、归属事件、最新 CDP info、包含空值的 URL history 与 context 退出记录均保留；空 URL 安全标为未知，分类只引用同 target 已观察到的最后非空 URL。早期 lint 失败和空 URL review 修复没有改写成生产实现收益，见[检查](../../node_modules/.cache/playwright/test-results/native-memory-current-diagnostic/check.json)、[首轮失败](../../node_modules/.cache/playwright/test-results/native-memory-current-diagnostic/first-check-failure/check.json)、[终态与清理](../../node_modules/.cache/playwright/test-results/native-memory-current-diagnostic/terminal.json)及[精确诊断档案](../../node_modules/.cache/playwright/test-results/native-memory-current-diagnostic/README.md)。

本次没有 GC、heap snapshot、CPU profiler、任务时间戳插桩或同时运行的其它 GPU 任务；fixture 仍保留来源资源检查包络。阶段按整个 RPC 起止区间归属，共 baseline 2、cold 145、warm 1,160、settled 24，0 跨边界样本。所有四个 Runtime 字段独立报告，集合和附非原子跨度。main 最大单字段观测可以提供全范围峰值观测下界，不能替代瞬时总体峰值；也不能把这一次 main 157.47MiB 与历史 218MiB 对照推导收益。下一步仍按实际 owner 定位 main 的缓存/发布对象和 backing 存活期，不能仅提高 Native 并发。

## 历史六次交替对照

固定顺序为原始、MapLibre、当前、当前、MapLibre、原始；Chromium `151.0.7922.34`，Intel RKL GT1 / ANGLE Vulkan 1.4.318，1280×720 / DPR 1。复用正式 performance fixture 的 source、style、tile 字节与全部 `warm(360)` 路径。每个 context 请求 34 个相同本地 MVT；全部地理像素探针通过，Native 保持 8 个活动瓦片、26 个缓存瓦片和 FPS 显示。诊断过程没有 GC、heap snapshot 或同时运行的 build/test/profile/browser；终态校验 345 个冻结文件和下面四个发布档案均未改变。

命令终态 exit 0，Playwright 一个诊断 case 通过，耗时 106.830 秒，0 skipped/flaky/errors。这个通过表示采集程序完成并保留覆盖限制，**不表示所有 Worker 的内存或真实峰值均已测到**。临时 TypeScript harness 在根 `e2e/` 执行 ESLint→TSC 后运行；采样完成后归档到忽略的 `node_modules/.cache/playwright/test-results/`，不增加维护中的小型 E2E。生产实现、生成物、fixture、配置与发布文件在本阶段没有修改，无需重复单测和构建。

| 顺序 / 版本 | warm 主线程 JS used MiB | warm 主线程 total MiB | warm 主线程 embedder MiB | warm 主线程 external/backing MiB | 生命周期 target 已采 / 已发现 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 / 原始 | 231.35 | 282.60 | 20.98 | 149.32 | 7 / 8 |
| 1 / MapLibre | 60.11 | 76.47 | 1.70 | 59.07 | 2 / 2 |
| 2 / 当前 | 217.78 | 268.89 | 19.67 | 148.42 | 8 / 8 |
| 3 / 当前 | 218.32 | 268.64 | 19.69 | 148.41 | 7 / 8 |
| 4 / MapLibre | 60.52 | 76.47 | 1.71 | 59.07 | 2 / 2 |
| 5 / 原始 | 220.93 | 270.14 | 20.69 | 150.18 | 7 / 8 |

每格是该字段、该主线程 isolate、warm 窗口内的 **observed sampled peak**，四格不相加，也可能出现在不同时间。MiB = 1,048,576 B。current 的主线程观测值略低；当前两个 context 的各 MVT Worker JS used 最大观测值却有 21.85–43.01 MiB 的波动，Native combine 为 13.79–14.16 MiB。不能由两个重复样本或先前 256→2 backing owner 的结构结果宣称整体 heap 收益。

只作诊断参考的 warm 跨 isolate 非原子 JS used 集合之和最大值为：原始 273.64 / 263.86 MiB，当前 279.36 / 259.08 MiB，MapLibre 80.10 / 79.91 MiB。当前前后有升有降，不能称总体峰值或稳定整体改进。四个 Native 运行的同轮采样跨度最大 74.99–90.13 ms；按 Worker 的实际相邻采样缺口可达 216.19 ms，首个原始运行的主线程缺口达 3,164.35 ms，随后五个主线程最大缺口为 341.02–398.30 ms。名义 100 ms 不表示实际连续无缺口采样。

## 覆盖和边界

每个 Native context 的生命周期账本发现 8 个 target：main、3 个档案 MVT Worker、Native combine、heightmap、terrain picker，以及短命的 `transferTypedArrayTest`。终态的全部 7 个存活 target 都有有效样本，并与 Playwright Worker URL 列表校对。MapLibre 的 main 和唯一 dedicated Worker 全部采到。

三个早期的严格验证失败已保留：第一次的 transfer-test 只存活约 24 ms；加 attachment 即时采样后仍可能在 heap RPC 回包前退出。正式六次对照中只有第 2 次 Native 运行采到了该 Worker，其余三个 Native 运行明确记录未采 target、创建/退出时间和 RPC detach 错误。没有暂停 Worker 启动、补零、忽略账本或将仅终态覆盖冒充完整生命周期内存覆盖。

阶段按发送/接收区间是否完整落在实际 `[navigationStarted,coldFinished]` 或 `[warmStarted,warmFinished]` 归属，跨边界样本单列；导航前 baseline、cold 完成后 ready 与 warm 返回后 settled 分开。不能只按发送时记录的 phase 分类。第二次早期失败档案的三个所谓 warm 最大值实际上出现在 `warmFinished` 之后，已经在正式 harness 和分析器中修正。正式数据没有跨边界或 isolate 身份歧义样本。

每轮按 `Runtime.getIsolateId` 去重并验证当前身份。main/iframe 在 heap RPC 前后检查身份，导航期间变化的样本保留为歧义、排除峰值；dedicated Worker 本身不导航，销毁重建用新的 target。创建时额外即时采样单列，不混入周期集合之和。

## 结论与下一步

这组数据把下一轮优先级指向 Native 主线程在预热、瓦片缓存与发布期间保留的对象和 external/backing。当前主线程 warm JS used 观测下限仍约 218 MiB，而同 fixture 的 MapLibre 约 60 MiB。它包含 Cesium、fixture hooks 与模块开销，不能全部归因于本库；下一步需要独立 retention/allocation 归属证据定位大对象 owner，再决定删除或复用哪些数据。不能仅继续缩减小 DTO 就宣布性能问题解决。

后续 heap snapshot 或 allocation profile 要在新的独立诊断中执行，不混入本轮无 GC 的加载/预热数据；正式 CPU/帧耗时仍使用此前无 CDP 采样的 ABBA，不能拿本轮 wall time 代替。

后续独立的标准面颜色诊断已沿真实 record→entry 持有链删除 65,570 个库 Color 克隆；同协议实际发布入口的 warm 后主线程显式 GC JS used 为 131,944,512→127,603,440 B，约减少 4.14 MiB，Native 拾取、bounds、批表及缓存数量保持。该诊断在 cold-ready 也取得快照，包络与本页无 GC 采样不同，不能用其替换本页 218 MiB sampled peak 或宣称全部 isolate 峰值下降。见[颜色持有者与测量范围](./geometry-and-feature-ownership.md#标准面颜色状态2026-10-04)和[前后原始核验](../../node_modules/.cache/playwright/test-results/standard-owner-memory-summary.json)。

原始证据：

- [六次采样原文](../../node_modules/.cache/playwright/test-results/all-isolate-memory-comparison/all-isolate-memory-diagnos-1cc2f-solate-cold-and-warm-memory/all-isolate-memory.json)、[按真实阶段归属的完整汇总](../../node_modules/.cache/playwright/test-results/all-isolate-memory-summary.json)。
- [命令终态和冻结身份](../../node_modules/.cache/playwright/test-results/all-isolate-memory-comparison-terminal.json)、[Playwright 原文](../../node_modules/.cache/playwright/test-results/all-isolate-memory-comparison.json)、[精确 harness](../../node_modules/.cache/playwright/test-results/all-isolate-memory-comparison-harness.txt)、[运行器](../../node_modules/.cache/playwright/test-results/all-isolate-memory-run.mjs)、[分析器](../../node_modules/.cache/playwright/test-results/all-isolate-memory-analyze.mjs)。
- [最终 ESLint/TSC](../../node_modules/.cache/playwright/test-results/all-isolate-memory-checks.json)；早期失败保存在 `node_modules/.cache/playwright/test-results/all-isolate-memory-smoke-{first,second,third}-failure*`，没有删除或改写为成功。

## 使用精确发布版本

本地两个发布档案可以在同一 fixture 中作原始与当前对照，无需修改或回滚生产源码：

| 版本与文件 | raw B | SHA256 |
| --- | ---: | --- |
| `line-texture-prefix-published-snapshot/index.mjs` | 474852 | `3f0767dfa44fa7000d4132583db74684630f12521b1699c2bfff41da6a5dbc93` |
| `line-texture-prefix-published-snapshot/worker.mjs` | 430982 | `87cc86cbbeee996d7e43e00690a484a0290df6ddbb272a53f5b912c1f33efa7c` |
| `projected-owner-published-snapshot/index.mjs` | 474848 | `2d18b243795860875e34e95565e1b86b7ebe21c38fb32f7883128659128e571b` |
| `projected-owner-published-snapshot/worker.mjs` | 431059 | `622240612ff3768ff741b337b965ba1557798f24da3e8c37cf83ff40e71b0d5a` |

目录位于根 `node_modules/.cache/playwright/test-results/`。`performance-fixture.ts` 的 renderer query 只区分 Cesium/MapLibre，Cesium 仍动态导入源码入口，没有 published query。旧临时 `line-memory-release-final-harness.txt` 已通过拦截 Vite 变换后的 fixture 模块替换该入口；可以分别指向上述档案的 index。两份 index 的 Worker URL 都相对自身模块，因此 worker 应从同一档案目录加载，需要记录实际请求验证。

让 Vite 正常处理档案模块，不能 raw fulfill 含有 `cesium` bare import 的 index。Vite 会将 bare imports 转成浏览器可加载的 URL。[Vite 官方说明](https://vite.dev/guide/features.html#npm-dependency-resolving-and-pre-bundling)

## 采样范围

复用旧 harness 的 browser context/frame 归属、完整 target inventory、Worker RPC 和 isolate 去重。删除 GC、HeapProfiler、WeakRef/hook restoration 与销毁阶段 machinery。采样从导航前开始，覆盖 cold settle 与完整 `warm()`；source、style、fixture hooks、viewport、DPR、Cesium、FPS 保持相同。原始和当前版本在独立 cold contexts 中交替顺序重复；这组内存诊断不替代无 CDP 采样的正式 CPU/帧耗时对照。

Target 事件账本记录创建、属性变化和退出，并周期性用 `getTargets` 与 frame tree 校对；不能只采终态存活的七个 targets。按 browserContextId 与 frame ancestry 纳入 main 和全部 dedicated Workers，包含 MVT、combine、terrain。更新旧 `/dist/worker.mjs` 分类规则，使档案 Worker 正确归属。任何缺归属、attach 失败或退出前没有有效样本都必须写入覆盖结果。[CDP Target 协议](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json)

Playwright 的公共 `newCDPSession` 接受 Page/Frame；旧 harness 的 non-flat Target RPC 可连接 Worker，但该路由已废弃。需记录并固定已验证 Chromium 版本，协议失败不能改用仅主线程数据。[Playwright API](https://playwright.dev/docs/api/class-browsercontext#browser-context-new-cdp-session)、[CDP Target 协议](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/browser_protocol.json)

每个 target 读取 `Runtime.getIsolateId`，同一 isolate 只计一次。每次 `Runtime.getHeapUsage` 记录 harness 单调时钟的发送/接收区间、实际间隔、最长缺口与首次样本延迟；并行 RPC 可以缩短一轮跨度，仍不构成原子快照。Worker 退出记录事件和最后有效样本，不伪造零值。[CDP Runtime 协议](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json)

## 字段与峰值定义

四个字段独立保留：`usedSize` 是 JS heap 使用量，`totalSize` 是其分配容量，`embedderHeapUsedSize` 是 embedder GC heap，`backingStorageSize` 的协议范围包含 ArrayBuffer/external string backing。V8 实现读取 `external_memory()`，不能将最后一项改称纯 TypedArray 字节。字段不跨项相加，也不代表 RSS、物理总内存、WebGL 容量或 VRAM。[CDP Runtime 协议](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json)、[V8 实现](https://raw.githubusercontent.com/v8/v8/main/src/inspector/v8-runtime-agent-impl.cc)

可以报告每个 isolate、字段、阶段的 observed sampled peak，它是该 isolate 阶段峰值的观测下限。每轮同字段跨 isolate 的相加值只能称为非原子采样集合之和，须附采样跨度；它及各 isolate 峰值之和都不能称为瞬时总体峰值。

上述非原子限制是推论：Worker 采样后转移一个 buffer，主线程稍后采样时，同一 backing 可能在一轮中被计算两次；因此集合之和的最大值甚至不保证是总体瞬时峰值的下限。全范围瞬时峰值的安全观测下限可取同字段全部单 isolate 样本的最大值。采样还可能遗漏短暂分配，应保留全部原始样本与覆盖缺口，不能通过字段相加或遗漏 Worker 宣称已完成总体内存验收。
