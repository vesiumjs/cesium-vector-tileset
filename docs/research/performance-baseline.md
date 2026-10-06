# 性能与验收基线

更新于 2026-10-05。Cesium 1.146.0 / engine 26.4.0、MapLibre GL JS 6.11.2、TypeScript 6.0.x。保持 Primitive 扩展库定位、unplugin-cesium、Native FPS、Globe 与 OIT。主线程和 Worker 共用多入口构建。本文保留当前结论和可核对原始证据，历史诊断不再逐批重复罗列。

主体重构、全球来源、压力预设与维护测试已经落地，但不能宣称整体性能追平 MapLibre。几何任务直接复用 Cesium TaskProcessor；普通建筑各模式统一走 Native 管线，颜色/透明度/渐变通过实例属性、光照通过 uniforms 更新，高度/基底变化才重建几何。初始零透明度的建筑仍需首次显示时构建一次。此前四次模式切换共 112 帧，道路与建筑均无空帧；其它轨道的九条来源/paint 交接也已通过。最近正式 ABBA 仍落后于 MapLibre，高负载城市存在长帧，双轨增加实际资源成本。已通过的交接、预设链或额外的全部 isolate 峰值研究不再重复列为收尾任务。

## 复现与计量

```bash
pnpm lint:eslint
pnpm lint:tsc
pnpm test
pnpm build
E2E_GPU=hardware pnpm exec playwright test --grep-invert '@live|@performance'
E2E_GPU=hardware E2E_PERF_GPU=1 E2E_PERFORMANCE=1 pnpm exec playwright test e2e/performance-comparison.spec.ts --grep '@performance'
```

维护用例位于根目录 `e2e/`，辅助代码在 `e2e/fixtures/`，使用 TypeScript 并纳入完整类型检查。正式性能入口默认跳过，必须设置 `E2E_PERFORMANCE=1`；`E2E_PERF_GPU=1` 请求并核验实际硬件 renderer，`E2E_GPU=hardware` 控制其它用例。SwiftShader 结果不能外推硬件吞吐。

正式计时通过 Vite 变换库源码 entry 和正常 Worker 链路。冻结 dist、归档和散列用于版本核对，不表示计时执行了归档入口。主线程保留内存诊断另行路由到实际发布入口，两种协议分别报告。

CPU 测量按 Cesium / MapLibre / MapLibre / Cesium 顺序，每轮使用独立 context。固定 1280×720、DPR1、二维正射 Mercator、俯视相机和相同三层样式。全球 z14 网格每瓦片有 1 个 ground、1024 个 parcel、128 条各 33 点道路；z13/z12 包含四/十六份参考几何。完整 360 步平移缩放预热后测静止 180 步、慢移 360 步和快移 120 步。Native Globe、OIT 与 Cesium FPS 保持开启。

双方核对投影及 669 个地理像素探针，不能仅凭相同 tile-local 数据或截图比例认定负载相等。每轮实际请求 34 个瓦片（24 个 z14、10 个 z13），Native 终态 8 活跃/26 缓存。性能运行期间不修改源码、fixture 或配置；本批另核对三项发布 JS 在正确性回归与性能运行后保持原字节。正式计时仍执行源码入口。

- 帧 CPU 是同步 `Scene.render` / `Map._render` 的主线程包含时间，排除 Worker、异步加载、compositor 和 GPU 完成；不是 FPS 或 GPU 时间。
- cold wall 包含模块、设置、加载、编译及稳定帧等待。Worker task wall 也包含启动、排队、转移和主线程交付，不能当作纯 Worker CPU。
- 嵌套阶段不能相加；`firstUploads` 包含 paint、投影/打包、纹理、Native batch table、VA、shader 和命令准备。
- 共同 WebGL buffer 容量按实际绑定和 `bufferData/deleteBuffer` 跟踪，帧外逐项通过 `getBufferParameter(BUFFER_SIZE)` 核验。包含 renderer baseline 和 uniform buffer，排除纹理、heap、驱动与实际 VRAM 驻留。
- 库 `gpuMemory` 是上传前输入预留与上传后实际资源的混合预算，不包括全部 Native/atlas/terrain 纹理，不能与共同 buffer 或 CDP heap 互换。旧 UNIFORM_BUFFER 错误归类形成的比值已废弃。
- 每版不同引擎、插桩包络、GPU、压缩工具和负载的值不能直接比较。正式 CPU 不混入 heap snapshot、allocation 或 isolate 采样。

## 最近同条件性能

最近正式计时属于 TaskProcessor 复用之前的统一道路版，独占硬件 ABBA **1 通过、0 失败/跳过/重试后通过，约 140 秒**。同一 Intel Vulkan 硬件、固定二维负载、完整空间探针与各级请求核验通过。见[正式测量与边界](../../node_modules/.cache/playwright/test-results/line-modes-performance-summary.json)。当前仅替换重复传输协议，未重跑性能或声称计时改善。

| 主线程同步 CPU 指标，ms | Native 两轮 | MapLibre 两轮 |
| --- | ---: | ---: |
| cold wall | 2742.1 / 2826.2 | 1727.8 / 1665.5 |
| cold CPU P95 | 15.1 / 14.3 | 6.1 / 3.6 |
| cold CPU 最大帧 | 21.8 / 72.2 | 9.5 / 5.6 |
| stationary CPU P95 | 1.5 / 1.5 | 0.6 / 0.6 |
| slow CPU P95 | 1.6 / 1.7 | 0.7 / 0.7 |
| fast CPU P95 | 2.0 / 1.9 | 0.7 / 0.7 |

前一 paint/构建状态版 cold wall 为 2684.6/2756.9ms、fast CPU P95 为 1.8/1.7ms，见[前版测量](../../node_modules/.cache/playwright/test-results/tile-paint-ownership-performance-summary.json)。当前结果没有证明稳定整体改善。72.2ms 冷帧的 tileset 包含时间仅约 0.8ms，其余 Scene 工作没有在这次测量中进一步归因；不得据此推测具体驱动或 GC 原因。每轮 cold 仍为 32 次 create、24 次 combine；主线程 packCreate 和 source buffer transfer 为 0。

## 模式切换与资源成本

旧实现有两个独立问题：只有创建模式的坐标数据，以及球面/平面切换时直接销毁活动集合。当前完整模式 Scene 的道路与普通建筑保留三维/投影两轨，在既有 publication 中继续绘制，直至替代内容上传。建筑的投影、日期线分割、模式包围球与 morph 由 Native 管理；模式专用的面、点和图片图案仍按其合同重建。平面建筑的样式排序只改 Native 命令副本，返回 3D 时保留原生命令的深度写入及透明度 pass。

| 瞬时模式切换 | 当前观测帧 | 道路/casing 空帧 | 建筑空帧 |
| --- | ---: | ---: | ---: |
| 2D → CV | 35 | 0 | 0 |
| CV → 2D | 28 | 0 | 0 |
| 2D → 3D | 21 | 0 | 0 |
| 3D → 2D | 28 | 0 | 0 |

[当前逐帧附件](../../node_modules/.cache/playwright/test-results/extrusion-gpu-paint-e2e/line-family-solid-line-buf-45d87-cking-and-destruction-in-2d/line-mode-transitions.json)同时验证道路、casing 与建筑拾取、旧 VA/纹理/owner 销毁及 Native FPS，四次切换共 112 帧零空帧。建筑 VA 保留 Native 四项坐标属性，加上 GPU 光照的 FLOAT3 法线和 FLOAT top 权重，这个 fixture 为 **68 B/顶点**，前一 CPU 颜色版为 56 B。以 12 B/顶点的增加换取 paint/light 不重建几何，不声称 GPU 容量下降。表面中间 morph 和 FLOAT 对照另有回归，不外推全部真实城市。帧数受加载和 readPixels 影响，不用其变化推导性能。

同一 3D family 数据有 32 条各 33 点道路、casing + 主线、六个瓦片。当前共享 6 个物理 Primitive，VA 顶点容量 172,032 B、位置纹理容量 361,184 B、24,576 个上传顶点。见[当前资源附件](../../node_modules/.cache/playwright/test-results/line-modes-e2e/line-family-solid-line-buf-2628d-cking-and-destruction-in-3d/line-native-layout.json)。共享前为 12 个 Primitive、344,064 B VA、363,552 B 单轨纹理。VA 仍减半，但双轨已抵消此前大部分纹理减半收益；当前不能继续宣称纹理减半。

正式二维固定负载的整个 context buffer 容量由 10,314,471 B 增至 13,869,799 B，道路位置纹理由 9,754,304 B 增至 18,818,160 B；两者合计由 20,068,775 B 增至 32,687,959 B。这是保留两轨及三维近裁面所需完整角色的实际成本，不是全部显存或 heap。MapLibre 当前共同 buffer 为 10,364,760 B，不能与含 Native 纹理的合计直接比较。两轨均有实际模式消费者，不能据容量数字直接删除；当前没有新的冗余数据证据，不继续增加压缩实验、诊断框架或兼容分支。

## 真实城市与测量边界

曼哈顿固定公开数据、149 个建筑 Primitive 的原装 create/combine Worker 分片已把单次准备控制在既有 12ms 门限内；最近可见性/paint 诊断最长准备为 10.5/8.0ms，但实际 Scene P95 仍为 30.1/23.8ms，最大 62.7/42.4ms。60m 两次未就绪，15m 首次未就绪、复测就绪；加载和请求状态不同，不作整体吞吐收益结论。见[首次重放](../../node_modules/.cache/playwright/test-results/visibility-paint-city-summary.json)、[复测](../../node_modules/.cache/playwright/test-results/visibility-paint-city-repeat-summary.json)。

已有调用栈证明水面轮廓缺少 paint owner 导致道路整集合重建，修复后该重建采样消失；Native shader、上传、GC 和加载交付仍有长帧。一次已排队 RAF 约 1.27 秒的交付空档原因未确认。已有低空白模墙面回归不能替代真实城市完整吞吐/闪屏验收；停止追加同类探针，优先修复可复现的坐标布局和资源重复。

当前 GPU paint 版真实 OpenFreeMap 曼哈顿 60m / 15m 浏览器用例通过，使用实际服务数据、建筑像素与 Native FPS，耗时 17.6 秒，见[实网回归](../../node_modules/.cache/playwright/test-results/extrusion-gpu-paint-live-e2e.json)。它验证当前建筑管线能够显示，不能替代同条件整帧吞吐测量；前述诊断重放的就绪状态和长帧边界仍保留。

主线程显式 GC 后保留状态、单 isolate sampled peak 和非原子跨 isolate 集合之和分别计量。此前 create/combine Worker 等已发现 target 至少取得一次样本，尚无瞬时总体峰值结论，见[全部 isolate 测量与限制](./all-isolate-memory.md)。这属于额外研究范围，当前不重跑，也不作为原重构目标的完成条件。

## 当前发布体积

Node v24.14.0、zlib 1.3.1-e00f703，gzipSync(level:6)；Cesium peer、sourcemap、声明另计。

| 执行产物 | raw B | gzip6 B |
| --- | ---: | ---: |
| main ESM | 380,976 | 111,533 |
| Worker 入口 | 182,018 | 55,787 |
| 共享 ESM | 256,524 | 66,184 |
| 合计 | 819,518 | 233,504 |

见[当前完整产物容量](../../node_modules/.cache/playwright/test-results/extrusion-gpu-paint-bundle.json)。GPU 建筑 paint 比前一统一管线版增加 4,324 raw B / 1,260 gzip6 B，共享模块与 Worker 入口字节未变；这是复用 Native 动态属性和 shader 的实现成本。发布字节不能当作运行期 heap。

## 当前验证

ESLint → TypeScript → [73 文件 670 单测](../../node_modules/.cache/playwright/test-results/extrusion-gpu-paint-unit.json) → 库/demo 构建通过，日志使用 node_modules/.cache/playwright/test-results/extrusion-gpu-paint- 前缀。复用既有建筑用例覆盖三个模式、Native 几何身份、初始零透明度及可见兄弟层、光照不逐要素求值、feature-state/opacity/gradient 原地更新、height/base 重建、细分与日期线法线/top 插值。没有新增单测文件；日期线用例发现整型属性截断后改用 FLOAT 法线，端点权重的微小 Native 浮点误差由 shader clamp。

[当前 14 项回归全部通过](../../node_modules/.cache/playwright/test-results/extrusion-gpu-paint-e2e.json)，耗时 73.2 秒，0 失败/跳过/重试。硬件浏览器串行覆盖六条道路与建筑模式/paint/拾取、15m 街景、demo 60m/15m 及 minified 入口；另外验证五条发布包消费者。15m 墙面初始 3,900 个中性色像素、亮缝 0；改色、改光照、opacity 1→0.5→0→1 保留相同 collection/Primitive/VA/实际拾取对象，不重新请求源瓦片。半透明只产生每 VA 一个 Native color command，恢复不透明时混合关闭、深度写入恢复。真实 ROI 均值由白模 [110,110,110] 变为蓝色 [32,46,75]，改变光照及恢复显示后为 [74,107,174]，不是只检查 JavaScript 的 paint 值。其余已通过轨道没有重复运行。

前一轮[22 项定向回归全部通过](../../node_modules/.cache/playwright/test-results/scoped-extrusion-e2e.json)，耗时 126.7 秒，0 失败/跳过/重试后通过，硬件用例串行执行。覆盖九条 3D/2D/CV 异步 paint/来源交接、Buffer paint、图案/栅格/图片交接、15m 白模及五条发布包消费者。九条交接均为 staleFrames/replacementHoles/partialSourceFrames=0、coverageMinimum=1；Native FPS 开启。15m 墙面初始 3,900 个中性色像素、亮缝 0；无关圆点 feature-state 和透明度变化保留实际建筑 owner，建筑自身改色能更新 framebuffer 并销毁旧 owner。这不证明真实城市整体帧时间改善。此前 [TaskProcessor 回归](../../node_modules/.cache/playwright/test-results/native-processor-e2e.json)另覆盖正常/CDN/加载失败、原生 1 B transfer probe 的实际 detach/99 回复/终止以及四条表面与 morph。

此前统一道路版的[70/74 首轮](../../node_modules/.cache/playwright/test-results/line-modes-e2e.json)与[6 项修复后回归](../../node_modules/.cache/playwright/test-results/line-modes-followup-e2e.json)保留原失败证据：三项旧容量门限与一项模式整批销毁。12 组冻结 FLOAT 均为 0 像素变化，完整两侧日期线、各轴边界、z0/z1、厘米短段、近裁面及密集道路已验证。当前传输复用没有改动几何格式或 oracle；二维密集场景仍有 132,000 个完整角色顶点。

此前实网验证七家来源、八个区域，离线综合用例逐项验证 12 个压力预设，见[Cesium 与公开源研究](./cesium-and-public-mvt.md)。交接、预设链、实际低空白模与发布入口已经验证，不再作为未完成项重复循环。整体 CPU/cold wall 与高负载城市长帧仍有性能差距；新增 GPU 存储成本明确保留，不宣称当前全面追平 MapLibre。
