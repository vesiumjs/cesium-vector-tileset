# 全面审计与优化记录

日期：2026-10-13。审计起点：`4f9032bb7239fd838ffec1199b37b537623055cc`。目标仍在进行；本记录不替代全部验收，也不把已有文档的完成标记或测试通过当作项目正确性的证明。

当前明确的范围、交付物与完成条件见 [目标与验收](audit-goal.md)。

## 验收要求

2026-10-14 用户再次明确补充：比较必须包含 MapLibre 三维模式的倾斜效果及极限高低 zoom。相机校准、实际 GPU 投影分支资格、建筑与道路/文字/图标的尺寸朝向遮挡属于必验项；CPU 性能或俯视画面通过不能替代这项验收。自动 globe 高 zoom 的 Mercator 分支与真正球面分支分别记录。

结合最新版 MapLibre 与 Cesium 源码发现缺陷，优化渲染性能、简化代码和统一职责；检查已有测试并删除低价值覆盖；以相同样式、视口、相机与经纬高比较实际画面和性能。

用户进一步明确：性能验收比较 MapLibre 的实际耗时数值，尽可能缩小差距。机器配置仅用于同条件测量，不以某台机器达到 60 FPS 或低于 16.67ms 宣布验收完成。

用户追加要求：除了平面/俯视，还必须比较 MapLibre 三维模式下的倾斜渲染。纳入 globe 投影与带建筑的倾斜透视，核对道路、圆点、建筑、文字、图标的形状、大小、朝向与遮挡；相机位置、方向、FOV、视口与地面投影必须先独立校准。这个验收项目尚未完成，不能以其他场景通过替代。

用户再次追加极限场景：超低/超高 zoom 和高负载性能场景。覆盖 zoom 下界与过度放大、近地/高空、近地平线俯角、密集建筑/符号、大几何与快速连续缩放/平移，比较实际形状尺寸、漏绘/闪烁、CPU P50/P95/长帧、加载/呈现延迟及资源驻留。代表组合用于触发各独立路径，避免铺满无意义的参数笛卡尔积。此项也仍待完成。

上游版本与固定提交证据见 [源码研究](upstream-rendering-research.md)。MapLibre 开发参考依赖已从 6.12.0 更新为 6.14.0；Cesium 保持最新稳定版 1.146.0。参考依赖升级本身不是本库性能改善。

## 已确认的缺陷与修复

| 问题 | 真实失败信号 | 修复与验证 |
| --- | --- | --- |
| GeoJSON 来源移除后重建 | 等待中的 `loadData` 加排队 `setData`，移除后仍出现 `loadData → removeSource → loadData`；异步请求转换结束后也会再发送数据 | 清除排队更新，在参数/通道等待结束后检查来源生命周期；两个回归先失败再通过 |
| 删除未知要素的状态属性抛异常 | `removeFeatureState('roads', 7, 'selected')` 后 `coalesceChanges` 抛 TypeError | 对没有已存状态的属性删除执行空操作，验证其他要素更新继续提交 |
| 整要素/整层删除保留排队旧状态 | 已提交旧字段，排队新字段，删除后再设置不同字段；旧 `label` 或 `queued` 仍返回 | 删除同时清理该范围的排队更新；验证删除前后与合并后结果 |
| 迟到 Worker 清理重建来源 | 完成 `removeSource` 后接收 `removeTile` / `abortTile`，重新创建 Vector/GeoJSON worker source | 清理仅操作已经存在的来源；扩展已有真实消息往返取消回归，旧实现两项失败 |
| 图片子视图错色与克隆失败 | 1×1 图片使用偏移 4 的 clamped 子数组，读取到前缀像素；Worker 图片克隆抛 RangeError | 保留 byteOffset/byteLength；动态回调直接交给同一图片替换逻辑；真实 atlas/Worker 路径及公开 addImage/updateImage 像素验证 |
| 视频移除后迟到播放/发布 | `getVideo` 未结束时移除来源，迟到结果仍绑定 playing、播放并发布 | 用加载代次覆盖转换、加载及播放结果；过时结果不发布；暂停/拒绝自动播放不阻塞 metadata/content；接管时释放旧视频监听与播放 |
| 已取消的初始化仍等待并执行帧回调 | 预先 abort 的 controller 传入 frameAsync，实际返回 resolved 而非 AbortError | 删除未独立使用的 callback 包装，排帧前检查取消；保留等待中取消和正常完成回归，验证 owning window |
| 全局 paint 过渡被忽略 | 真实 Style → StyleEvaluation 中，默认 300ms 和显式 delay/duration 都直接跳到终态 | 传递已有 Style.getTransition()；两种全局过渡的起点、中点、结束均先失败再通过 |
| 同一驻留瓦片的符号 paint 冻结 | 同整数 zoom 内变相机高度，GPU 像素与独立 MapLibre 不一致；数据 opacity 与 composite 颜色也不一致 | 更新常量 uniform 与真实 feature/composite 顶点属性；保留格式文字分段颜色，颜色与 opacity 只组合一次；五项硬件 GPU 回归通过 |
| 共享 symbol bucket 使用错误图层的 paint | 第一层常量透明、第二层数据蓝色与 0.4 opacity，却绘制白色全不透明图标 | 静态几何缓存不再携带第一层 paint，每代按实际 layer.id 绑定配置，可变属性由该代拥有；新增第六项 MapLibre 硬件像素对比先失败再通过，独立 review 与相关 27 项单测通过 |
| circle 忽略 map pitch/scale，半径量化与大小截断 | 75° 倾斜中 Native 仍为圆而 MapLibre 为椭圆；分数半径和半径 140 无法正确显示 | 统一 quad 路径，删除原两个 point collection 分支及派生 shader；实际 GPU 分数半径/描边/blur、三种独立对齐缩放、feature-state 与同 bucket 连续 zoom 的绿色加权面积逐值对齐 MapLibre |
| 三维样式 zoom 被 nadir 高度覆盖 | 相同实际相机和地面焦点，Native 15.24 / MapLibre 14，线与图标大小不同 | 使用实际 optical hit 或真实地平线焦点及距离；独立上游 sphere 变换的正常/倾斜/miss oracle 验证，65° 线宽差消失；后续实际 GPU 顶点与模型采样诊断解释图标/建筑残差，automatic globe11 严格比较通过，forced14 不宣称逐像素相等 |
| 高空虚拟 focus 造成过细覆盖并卡死 | 跨洲飞行相机高度 1624km，却用 10km 虚拟 focus 选择全可见地球 zoom 12，265087 个 ideal tile；主页面停在瓦片创建 | 实际地平线焦距约 4837km、zoom≈3.75，同一输入覆盖 64 个 z3 tile，没有硬数量上限；原跨洲与 60/15m 实际建筑流程 20.8s 通过 |
| 表面抬升造成近地巨大视差 | zoom23/75° 圆点偏移约108px，道路也错位 | 删除 raster/vector/pattern 地面 1m 与层序 epsilon 的高度排序，直接复用 worker/grid 地面几何；zoom23 圆点中心与面积对齐，模式切换/alpha/pick 回归通过 |
| 后置 surface 被建筑深度遮挡 | 同 globe 相机、后置线条，MapLibre 红，Native 蓝 | 按上游首个 3D 样式层 cutoff 决定后续 surface painter order；保留旧样式时 cutoff 和 order 同一代拥有；同像素对比及后续真实 depth/source handoff/移除释放硬件回归通过 |
| 重排后 color/pick 深度策略分叉 | 跨 cutoff 同一 command 的 color false，但普通/log-depth pick 都保持 true | 同步实际颜色深度策略到 Native 缓存 pick state，保留 Native 其他设置；真实 Native 派生缓存的下→上→下回归先红后绿 |

与上游相同也不代表正确：SourceFeatureState 的部分删除缺陷同样出现在当前 MapLibre 实现，仍按本项目的公开状态语义修复。图标沿线旋转候选则与上游行为一致，已撤回，未作猜测式修改。

## 已测量的局部优化

- 过渡属性代次固定自己的 paint 键和活动 prior 引用，避免每次 `hasTransition` 分配 Object.keys。真实样式交替基准的查询耗时下降 62.6%–69.8%，保留默认属性、延迟、中断、结束及 data-driven snap 语义。
- 几何传输打包在复制预算容得下整条属性时直接 `TypedArray.set(source)`，减少子数组视图分配。256 份几何、352256 字节包、每轮 150 次，9 轮交替中位数约 64.80ms → 57.90ms，下降约 10.6%。完整包字节和 yield 数量一致，已有大包分段/取消测试保留。
- `ActiveTiles` 改用 Map，`loaded()` 直接遍历并在首个 pending tile 停止，不再每次新增瓦片后的状态事件都复制整个列表。真实暂停 profile 中旧复制占 8.833s/20.014s；3000 个真实 Tile 连续插入与判定的 7 轮交替局部基准中位数约 623.78ms → 0.65ms。这个增量列表基准不是完整城市加载或 FPS。
- 同一原始相机快照的 placement scope 副本共享 line projection 结果；完整矩阵、回调 identity、尺寸、zoom、viewport、距离和投影输入变化仍隔离，独立原始视图及 geometry 代次也不合并。真实 CV line 红转绿，三 scope 的局部9轮交替基准调用18000→6000、输出checksum一致，中位耗时29.00→22.48ms（约22.5%）；相关31项通过，不能将局部比例宣称为整体 FPS。
- 城市 motion 的实际 CDP profile 中，原始文字图集 `writeAtlasCanvas` 累计 self 479.10ms、当前第一检查点 401.70ms；该热点是既有成本，不能解释新增退化。每个 SDF 字节的四通道复制改为一次 Uint32 写入（四字节相同，与字节序无关），并正确使用共享 registry 的 lazy canvas。提取两版实际函数、保留真实 node-canvas createImageData/putImageData 的9轮交替局部实验（每轮16个512×256新图集）输出像素字节完全相同，中位36.93→10.85ms，下降70.6%；这不含浏览器、图集缓存或 GPU，不是帧率提升。证据：`node_modules/.cache/temp/comprehensive-audit/glyph-atlas-benchmark.{mjs,json}`。
- 常量/source 符号 paint 在 revision 不变时跳过与 zoom 无关的工作；camera/composite、transition prior 链与 feature-state revision 仍更新，复用已有 layer 索引。整段 motion 的 `_updatePaint` inclusive 仅10.58ms，不能将城市放大退化归因于它。第二检查点 lint→类型检查、31项相关单测和6项硬件符号像素对比通过（35.3s），已单独冻结290文件继续三轮隔离重放。
- 删除物理高度排序后不再复制 per-layer 地面位置，也不再为每个高度保存 raster grid 或 pattern/vector 径向缓存。不同图层共享实际地面几何，command 顺序负责 paint 层序。

这些都是局部基准，不能换算为场景 FPS 提升。城市比较需要单独重放。

## 测试精简

删除 scene-frame-budget 中只检查函数引用的用例；去掉精确对象/视图数量、表达式内部引用和字段布局的断言。保留零拷贝、表达式真实求值、拓扑和渲染数据更新。分段转换只要求跨帧完成与上界，不再强制慢到超过 100 帧。瓦片代次测试改为检查实际圆点尺寸，保留等待、过时响应和取消路径。单项参数循环直接展开。

清理前受影响 5 文件 27 项通过，清理后 26 项通过。mvt-worker 的相同 postMessage 分支实际承担 TypeScript 重载窄化，保留。截图只保存而不检查的演示测试不能证明所有图层正确绘制，需联合像素、连续性和实际画面审查。

删除了只要求废弃 radial offset walk 跨帧执行的 `radial-conversion-budget` 测试；真实 worker 几何、upload 与 publication 的预算/取消回归继续保留。旧 nadir horizon 测试的“固定高度就必须不变 zoom/尺寸”不是 MapLibre 物理相机语义，改用公共 `Map.unproject` 地平线 oracle、真实建筑/文字/道路像素与 layer minzoom 控制，不声称自由 miss 场景道路的全域逐像素等价。

代码收敛：线轨道和线 family 的重复 uniform 状态/closure 构造合并到现有 line-family，pattern 使用同一规则；没有新增转调模块。browser.frame 原本无外部调用，原 RAF/取消实现直接移入 frameAsync。资源池、图层集合和 raster/pattern 的不同释放规则确有多个消费轨道及不同语义，保留。

旧 paint 的 expression/prior/global-state snapshot 归入实际拥有过渡算法的 `Transitioning`，Line/Circle 复用这一规则；删除 Line 的另一套递归过渡插值和 Circle 的节点复制实现，统一处理延迟、中断、data-driven snap 和精确结束边界。现有真实算法、global state/schema 变更与交接回归10项通过，没有为方法名称或私有字段新增镜像断言。

## 性能比较方法

`e2e/city-performance.spec.ts` 使用独立 browser context 先完整运行并关闭一个渲染器，再运行另一个，重放同一相机轨迹。固定同一资源响应，瓦片延迟 80ms；1280×720、DPR=1、关闭抗锯齿；原生场景启动地球已稳定后开始计时。基线库源码已归档到缓存，避免比较期间被后续改动污染。该用例已在精简时移除，下面的复现命令不再可执行。

输出包含 cold、zoom-out、zoom-in、pan、orbit、settle 的完整场景 CPU 帧耗时、idle tick 和首次呈现延迟；新增相对 MapLibre 的 P50/P95 比值。上海 CV 使用 MapLibre 公共物理相机转换；地球 3D 和 MapLibre 平面投影存在曲率差异，不声称远地平线能做到逐像素等价。相机资格与画面验证另行运行，避免把诊断探针计入正式性能结果。

冷加载采用第一次 loaded renderer update；相机呈现延迟是 CPU 提交完成时间，不等同于显示器扫描或 GPU fence 延迟。按需渲染帧间隔含主动省略帧，不能直接取倒数宣称渲染极限 FPS。

复现命令：

```bash
E2E_CITY_PERFORMANCE=1 E2E_GPU=hardware E2E_CESIUM_BUILD=production \
  pnpm exec playwright test e2e/city-performance.spec.ts --grep 'independent real-city'

E2E_CITY_PERFORMANCE=1 E2E_GPU=hardware E2E_CESIUM_BUILD=production \
  E2E_CITY_VIEW=shanghai E2E_CITY_MODE=cv \
  pnpm exec playwright test e2e/city-performance.spec.ts --grep 'independent real-city'
```

首次回放缺一块瓦片而失败，已用 capture 补齐；capture 和 profiler 运行只作为准备/诊断，不计入正式前后比较。两个冻结源码检查点分别完成三轮交替 A/B，历史汇总与第二检查点完整数据分列如下，不混合两次运行的样本。

硬件支持 `EXT_disjoint_timer_query_webgl2`。新增可选 GPU 命令区间测量，异步读取 query，禁止 `finish` 和像素读取，记录尚未返回与 disjoint 丢弃；GPU 计时作为单独诊断，不混入无探针 CPU A/B。它测量该帧 GPU 命令区间，不能当作 GPU 纯运算或实际显示延迟。

### 第一检查点历史汇总：原始数据部分丢失

第一检查点汇总保存在 `node_modules/.cache/playwright/comprehensive-audit/checkpoint-one-partial/summary.json`，同目录保留仍存的原始记录和原日志。第二检查点运行脚本的路径替换错误覆盖了第一检查点的部分原始 JSON；不能再声称第一检查点12次运行的全部 raw data 可复算，也不能把旧 `records[].artifact` 指向的路径当作未受影响的原始证据。下面的比值来自保存的历史 summary；CPU/pose、工作量和冷加载表述是在覆盖前读取完整记录得到的历史计算，现有残存数据不足以独立重算全部总量。

当时上海 CV 与密集四轨两场景各做 before/after 三轮，共12次独立运行；顺序为 before/after、after/before、before/after。City 记录 `fairTiming=true`、`diagnosticOnly=false`、`profiling=false`，无内部阶段或逐帧命令分类探针。下面的比值是每轮 Native/MapLibre CPU 分位数比值的三轮中位数，不是把所有帧混合后重新计算的分位数。

| 场景/阶段 | P50 比值 before→after | P95 比值 before→after |
| --- | --- | --- |
| City zoom-out | 2.512→2.439 | 4.826→4.788 |
| City zoom-in | 3.207→4.000 | 8.619→10.519 |
| City pan | 2.694→2.686 | 4.345→5.490 |
| City orbit | 3.687→3.441 | 5.309→4.472 |
| Dense stationary | 1.250→1.250 | 1.143→1.095 |
| Dense pan | 2.000→1.882 | 3.000→2.550 |
| Dense zoom | 1.941→1.833 | 4.267→4.214 |

城市 zoom-in 的相对 P50/P95 分别退化24.73%/22.05%，pan P95 退化26.35%；orbit P95 改善15.77%，dense pan P95 改善15.00%。本轮不满足“整体已尽可能贴近 MapLibre”的性能验收，也不能把部分阶段改善宣称为所有场景提速。

逐帧原始 `motion.frames` 与 `motion.ticks` 另外按同一 phase 求和，再除以 JSON `poses` 中该 phase 的数量。三轮各有24个 zoom-out、24个 zoom-in、24个 pan、36个 orbit pose。下表所有总量均为三轮合计、单位ms；tick 总量包含未渲染时的 CPU，不能再与 frame 总量相加。

| City 阶段/三轮 pose 数 | Native frame CPU 总量 before→after | Native tick CPU 总量 before→after | Native frame CPU/pose before→after | MapLibre CPU 总量 before→after | MapLibre CPU/pose before→after |
| --- | --- | --- | --- | --- | --- |
| zoom-out /72 | 1832.7→1756.0 | 1833.5→1756.8 | 25.454→24.389 | 310.6→312.2 | 4.314→4.336 |
| zoom-in /72 | 1923.3→2123.7 | 1923.3→2123.7 | 26.713→29.496 | 255.8→233.3 | 3.553→3.240 |
| pan /72 | 1573.9→1568.5 | 1573.9→1568.5 | 21.860→21.785 | 331.4→318.8 | 4.603→4.428 |
| orbit /108 | 3036.6→2789.8 | 3036.6→2789.8 | 28.117→25.831 | 587.0→578.2 | 5.435→5.354 |

四个运动 phase 合计 Native frame CPU 为8366.5→8238.0ms（减少1.54%），MapLibre 为1484.8→1442.5ms（减少2.85%）。Native 两版都绘制642帧、执行648ticks；MapLibre 为526→523帧，记录的 ticks 与绘制帧相同。zoom-in 的 Native 总量增加10.42%，同时参考端减少8.80%，两者共同扩大相对比值。pan 的 Native 总量近乎持平，P95 退化反映尾分布变化。每轮最后还有一个 `initial` replay pose：三轮 Native CPU32.9→30.1ms、MapLibre9.5→9.4ms，未混入上述四个运动 phase。

首屏与最终活跃规模相同：六个 City runs 都有6个 renderable/bucket/symbol/pattern tiles、18个 vector collections、37个 symbol primitives、303个 submitted commands。首尾 commandKinds 同为 background1、fill46、line162、dash57、symbol30、pattern6、extrusion1，加18个 Native 命令。但逐帧 `commands` 揭示运动中的提交工作不等价：zoom-in 总提交33513→35461（增加5.81%），每轮平均 commands/frame 为221.146/236.875/240.167→230.813/245.708/262.250；pan32571→32769、orbit35316→34537、zoom-out35301→35262。这个计数是库提交命令数，不是实际 GPU draw、三角形或 glyph 数，不能据此指定某一轨道或把差异全部归因于投影缓存。

退休缓存历史也不同：final symbol retired 数量为9/8/9→11/8/6，pattern 为12/13/14→13/6/10，featureIndexes 为18/19/18→20/15/13，方向并不一致。每轮 cold GPU memory 为20045813→20284549 bytes（增加238736 bytes，约1.19%）；这不是活跃 tile 数增加。六轮 `symbols` 诊断均为空，未记录逐 phase 的 Worker、glyph、placement pair 或命令分类规模，所以首尾一致不能代替运动期间等价工作量的证明。

City 冷加载使用 `cold.milestones.loaded` 的首次 loaded 观测；`coldObservedElapsed` 是轮询返回后的快照时间。`coldStats` 也在轮询返回后采集，不能当作 milestone 瞬间的统计。Native 三轮 loaded 为3653.8/4170.5/4388.3→4136.4/4306.3/4538.0ms，逐轮更晚；而截止 loaded 的 frame CPU 合计3611.3→3561.1ms、tick CPU3660.4→3621.6ms。对应帧数433→460、ticks676→723，尚需独立 profile 分清等待、启动、上传与发布成本。MapLibre loaded 为734.1/723.5/733.1→726.9/735.4/719.0ms，cold CPU328.2→316.8ms，两版均22帧。Native 快照比 loaded 晚878.3/615.1/849.0→22.9/919.7/741.2ms，该轮询尾段未计入冷加载里程碑或冷 phase CPU。

没有新 pose 的固定窗口另行统计：stationary 每轮60ticks，Native 均绘制30个完整303-command帧，三轮 frame CPU346.4→366.3ms、tick CPU359.2→378.4ms；settle 每轮120ticks，Native 绘制204→210帧，CPU869.7→881.2ms、tick CPU884.3→897.3ms。MapLibre 两种固定窗口均未绘制，不为零 pose 的窗口计算 CPU/pose。

Dense 双方每轮都输入6400个 features、无 readback/internal probes、无 errors；stationary/pan/zoom 各记录90samples。三轮 Native CPU 总量分别578.4→549.7、974.3→919.1、1179.2→1174.3ms，每个90-step窗口合计除270后的均值为2.142→2.036、3.609→3.404、4.367→4.349ms；对应 MapLibre 总量454.9→443.1、453.4→453.8、514.1→516.0ms。Dense 无 City 的 `poses` 数组或命令/资源规模统计，90-step均值不冒充已校准的 pose 指标。十二个 renderer 结果的 `loadedAtEnd` 都为false：最后一次相机更新后直接结束，没有 settle，因此不能声称末尾来源与发布已全部完成。Dense cold 包含引擎设置与来源激活，和 City 稳定裸地球后起计的 cold 定义不同。

Dense Native 首次 loaded 为4505.5/4622.6/4429.6→4433.1/4479.3/4547.3ms，MapLibre 为950.7/952.9/953.3→957.1/953.8/958.0ms。cold samples 合计 Native798→792、MapLibre均168，cold CPU3496.1→3536.7、442.3→473.4ms；这些包含冷启动过程的样本，不与后续各90sample阶段混合求分位数。

### 第二检查点 v2：完整三轮隔离 CPU 比较

完整12次记录在 `node_modules/.cache/playwright/comprehensive-audit/isolated-performance-v2/summary.json` 与其 `records[].artifact`，对应固定的 `baseline-source` 和 `measured-source-v2`。两场景、三轮顺序和无探针计时方法与第一检查点相同；v2 的所有 artifact 都在本目录内，逐帧总量可从这些记录复算。以下不使用第一检查点残存 raw data，也不把不同检查点的 before 样本混在一起。

| 场景/阶段 | Native/MapLibre P50 比值 before→after | P95 比值 before→after |
| --- | --- | --- |
| City zoom-out | 2.415→2.302 | 5.507→3.083 |
| City zoom-in | 3.357→3.577 | 9.857→4.042 |
| City pan | 2.971→2.757 | 4.750→2.926 |
| City orbit | 3.706→3.229 | 5.981→3.593 |
| Dense stationary | 1.313→1.312 | 1.143→1.045 |
| Dense pan | 1.941→1.937 | 2.591→2.476 |
| Dense zoom | 1.941→1.833 | 4.852→4.536 |

这些仍是三轮配对比值的中位数。City zoom-in P50 相对退化6.55%，P95 改善59.00%；zoom-out、pan、orbit 的相对 P95 分别改善44.01%、38.40%、39.92%。尾耗时改善不代表每阶段都更快，更不代表已完成性能验收：after 的城市 P50 仍为 MapLibre 的2.30–3.58倍，P95 为2.93–4.04倍。

下表给出实际 CPU 毫秒：分别取各渲染器每轮 P50/P95 的三轮中位数。这个绝对分位数的中位数不能相除后冒充上表的配对比值中位数。

| 场景/阶段 | Native P50 before→after (ms) | Native P95 before→after (ms) | MapLibre P50 before→after (ms) | MapLibre P95 before→after (ms) |
| --- | --- | --- | --- | --- |
| City zoom-out | 9.9→9.9 | 39.1→18.5 | 4.0→4.2 | 7.1→6.2 |
| City zoom-in | 9.4→9.5 | 48.3→19.4 | 2.7→2.7 | 4.7→4.8 |
| City pan | 10.4→10.2 | 26.6→15.8 | 3.5→3.7 | 5.5→5.4 |
| City orbit | 12.6→11.9 | 31.1→21.2 | 3.3→3.5 | 5.4→5.9 |
| Dense stationary | 2.1→2.1 | 2.3→2.3 | 1.6→1.6 | 2.1→2.2 |
| Dense pan | 3.3→3.2 | 5.6→5.1 | 1.7→1.7 | 2.2→2.1 |
| Dense zoom | 3.4→3.2 | 12.7→12.6 | 1.7→1.8 | 2.6→2.8 |

逐 phase 的帧 CPU、tick CPU 与 JSON `poses` 使用同一归属求和。三轮 pose 数与第一检查点相同；下表单位ms，tick 包含非绘制更新，不能与 frame CPU 再相加。

| City 阶段/三轮 pose 数 | Native frame CPU 总量 before→after | Native tick CPU 总量 before→after | Native frame CPU/pose before→after | MapLibre CPU 总量 before→after | MapLibre CPU/pose before→after |
| --- | --- | --- | --- | --- | --- |
| zoom-out /72 | 1732.3→1488.6 | 1732.7→1489.0 | 24.060→20.675 | 323.1→311.2 | 4.487→4.322 |
| zoom-in /72 | 1966.3→1577.3 | 1966.3→1577.3 | 27.310→21.907 | 234.1→246.7 | 3.251→3.426 |
| pan /72 | 1723.0→1474.3 | 1723.1→1474.3 | 23.931→20.476 | 327.5→333.4 | 4.549→4.631 |
| orbit /108 | 3181.9→2729.1 | 3181.9→2729.1 | 29.462→25.269 | 564.2→587.0 | 5.224→5.435 |

四个 movement phase 合计 Native frame CPU8603.5→7269.3ms（减少15.51%）、tick CPU8604.0→7269.7ms；MapLibre1448.9→1478.3ms（增加2.03%）。Native 绘制641→642帧、两版均648ticks，MapLibre426→424帧。参考端耗时也发生变化，不能把相对比值的全部改善都归因于 Native 优化。总量下降与 zoom-in P50 稍升可以同时成立，反映不同样本权重与尾分布；上述合计不包含最后 `initial` replay、cold、stationary 或 settle。

运动期间的命令工作量也不完全等价：zoom-out 提交35252→35044、zoom-in35660→35161、pan32339→32734、orbit36406→33147，合计139657→136086（减少2.56%）。首屏与最终规模则一致：六轮均6个 renderable/bucket/symbol/pattern tiles、18个 vector collections、37个 symbol primitives、303个 submitted commands；首尾 commandKinds 均为 background1、fill46、line162、dash57、symbol30、pattern6、extrusion1，加18个 Native 命令。提交命令数不是 GPU draw 或实际 glyph 数；首尾统计不能证明每个 pose 的内容相同。

v2 final 退休 symbol 为10/12/6→4/9/12，pattern13/12/2→6/10/10，featureIndexes19/19/12→13/17/19；缓存历史没有一致增减方向。cold GPU memory 仍为20045813→20284549 bytes（增加1.19%），final total GPU memory 为26697210/27721930/24812962→24369346/26283954/28161834 bytes。六轮 `symbols` 诊断仍为空，缺少逐 phase 的 glyph、Worker、placement pair 与 commandKinds，不能从这些统计给某一个局部优化分配整场景收益。

v2 City Native 首次 loaded 为4136.3/4504.1/4288.4→4054.6/4521.2/4336.5ms，MapLibre731.3/729.5/758.1→740.1/744.0/757.2ms。截止 loaded 的 Native cold frame CPU3488.2→3113.1ms、tick CPU3557.0→3180.3ms，帧436→458、ticks723→729；MapLibre cold CPU323.3→343.4ms、帧23→24。冷 frame CPU下降不能冒充首屏延迟普遍改善。`coldStats` 仍在 ready 轮询返回后采样，晚于首次 loaded update，不是里程碑瞬间资源规模。

固定窗口单列：stationary 的 Native 三轮 frame CPU358.2→359.4ms、tick369.5→372.0ms，两版均90帧/180ticks/27270提交命令；settle 为879.8→867.7ms、tick893.9→885.7ms、207→206帧、两版360ticks、提交63086→62564。MapLibre 两个窗口均不绘制。这些没有新 pose 的更新仍有成本，不计 CPU/pose。

v2 Dense 使用默认 zoom14.5，每轮仍输入6400个 features，stationary/pan/zoom 各90个计时 samples，无 readback/internal probes。三轮 Native CPU总量566.7→557.9、952.4→927.7、1158.5→1137.8ms；除各阶段270 samples 得2.099→2.066、3.527→3.436、4.291→4.214ms/sample。MapLibre总量432.9→446.2、460.5→462.1、501.5→516.3ms，对应1.603→1.653、1.706→1.711、1.857→1.912ms/sample。这是固定 step 的工作量均值，不能冒充 City 的独立 pose 指标。

Dense Native 首次 ready 轮询观测为4603.7/4430.1/4577.7→4560.9/4512.5/4484.8ms，MapLibre957.2/958.4/951.4→960.9/957.0/959.0ms；它不是帧回调内首次 loaded 的精确时刻。cold CPU Native3728.1→3509.0ms、samples801→797；MapLibre431.3→409.8ms、samples167→169。Dense cold 包含引擎设置和来源激活，与 City 稳定裸地球后的起计方式不同。

十二个 Dense renderer 结果的 `loadedAtEnd` 仍全部false，结束时未 settle；v2 没有逐层实际绘制数量、后置像素资格或实际 camera 统计，不能用输入6400声明实际绘制6400，也不能证明全部计时 step 已完成来源发布。后续单独加入 zoom2/25 参数与无计时的前后资格采样，只能用于新一轮证据，不能倒填到 v2 结果。两检查点的结果均不构成全项目、全部极限场景或整体性能已验收的结论。

### 第二检查点 v2：独立 GPU 命令区间诊断

硬件 query 分别完成两组三轮交替 A/B：完整 render 区间保存在 `node_modules/.cache/playwright/comprehensive-audit/gpu-checkpoint-v2/`，首个实际 GL draw 到 render 返回的区间保存在 `gpu-checkpoint-v2-draw/`。后者排除 draw 前的 CPU 准备和先行 clear/upload，仍包含 draw 之间的命令流空隙；两者都不是 GPU 纯运算时间或显示延迟，也不混入上述无探针 CPU 数据。全部运行 `disjoint=0`，pending 数保留在各原始快照。

下表是 draw 区间 after 三轮结果。绝对 P50 为各端分位数的中位数，相对列是三轮配对比值中位数，两者不混算。

| City 阶段 | Native P50 (ms) | MapLibre P50 (ms) | Native/MapLibre P50 比值 |
| --- | --- | --- | --- |
| zoom-out | 25.906 | 1.951 | 13.280 |
| zoom-in | 25.218 | 2.156 | 11.763 |
| pan | 13.307 | 2.573 | 5.171 |
| orbit | 12.736 | 2.479 | 5.140 |

完整 render 区间结果接近，CPU 尾耗时改善不能宣称已改善 GPU 或 FPS。独立关闭 tileset、保留完整 Native 场景并重放同一相机的 bare 区间约5.05–5.14ms；`bare-derived.json` 按 CPU reset 后的实际帧时间筛选 GPU 样本，没有混入前一段运动。不同运行的区间不能相减后称为本库纯 GPU 成本。后续取得同帧实际 VA、索引数量、pass/framebuffer/frustum 的 census 和逐轨道 omission 对照，详见下面的新证据；历史其他城市的 census 不代替本轮上海数据。

后续固定 v2 的 zoom-out13.550736 warm 姿态取得同帧 query/census/实际 GL ledger。完整→省略 line/dash→省略建筑几何/composite→完整的 P50 为40.815/6.525/40.809/40.635ms。四组相同9个 canonical/overscaled13 tiles、448提交命令、43,188,033 bytes，没有 pending/fading；实际 line288 draws/233 VAs/369386个 triangle inputs，dash52/3251。stroke 全部只有一个 depth bin/pass9，没有同 VA/range 跨 bin 重复。该姿态没有建筑 draw/offscreen bytes，所以建筑组只是零负担控制，不能作为建筑优化结论。省略效果包含命令流空隙与 observer 自身成本，不能称为34ms纯 GPU运算成本。原始证据：`node_modules/.cache/playwright/comprehensive-audit/gpu-warm-ladder-v2/`。

针对动态 bit 解码，独立试验只把共享 point record 改为固定12words/3对齐 RGBA32UI texels，保留全部原FLOAT bits/record IDs、其余VS/FS及几何。冻结 v2 与只覆盖两个 packing 文件的实验快照按 A→B→B→A 运行，60个真实frame/query每组：P50为40.739/40.053/39.981/40.790ms，均值改善1.83%；resident 显存43,188,033→47,331,457 bytes（增加9.59%），活跃位置纹理增加30.78%。四轮完整 framebuffer SHA逐字节相同，每轮285张实际使用的纹理全部 uint GPU回读无位错误/GL错误，瓦片/draw/triangle/pass/frustum逐值一致。这个显存交换不足以解释主要 stroke 成本，决定撤回生产原型和其专用布局测试，保留冻结源码与完整证据。结果：`node_modules/.cache/playwright/comprehensive-audit/packing-warm-summary.json`；不能把被撤回的原型列为最终性能优化。

随后仅将实际 line/dash draw 的 scissor 设为屏幕中心1×1，完整→限域stroke→恢复完整各20帧warm+60帧query，P50为40.8332→10.6216→40.8035ms，P95为41.0368→10.8046→41.0138ms。各组draw/triangle/VA/program/viewport/framebuffer、9瓦片/448提交命令/43,188,033 bytes均保持一致；真实GL scissor资格通过，恢复后完整RGBA SHA与初始完整画面相同，中间画面不同且无GL错误。这支持主要成本与stroke像素覆盖、栅格/backend或fragment路径有关；scissor不能隔离纯fragment运算，不把30.2ms差值称为纯fragment时间。285个VA的真实层级width为0.2434–6.5548、alpha为0.6945/0.7/1，没有全层零宽/透明绘制；实例级透明性仍未知。诊断不进入正式CPU计时，生产代码没有scissor省略。原始数据及控制结果：`node_modules/.cache/playwright/comprehensive-audit/scissor-warm-v2/`。

按用户要求及时止损，对当前冻结v3仅做一次独立短A/B：solid/dash的精确零coverage输出改为discard，其余数学、几何、paint和资源不变。各20warm+60query，P50为40.8669→42.4253ms，完整framebuffer SHA相同，9瓦片/448提交命令/47,788,201 bytes及line288/dash52真实绘制保持一致；实际linked GLSL记录在raw。单轮不用于断言稳定退化幅度，但没有提速证据，生产未采用且不再扩展该实验。v3与v2资源历史和CJK几何不同，不跨快照相减；直接切planar fill-outline为Native LINES还存在tile裁剪/高zoom精度资格风险，仅留实验快照，未运行或采用。证据：`stroke-short-v3-retry/summary.json`。

新密集资格运行分别使用固定 v2 的 zoom14.5/2/25、6400个输入features，四轨像素与两端实际640×720视口、pitch60/FOV45均通过。每项只有一次测量，属于新资格运行，不能替代三轮最终性能比较。计时结束即刻两端 `loadedAtEnd=false` 如实保留，随后等待实际 loaded 的资格采样排除在 CPU样本之外。相对 MapLibre CPU P50/P95：zoom2 stationary0.786/0.737、pan1.357/1.588、zoom1.250/4.059；zoom25为1.588/1.304、2.667/3.200、2.500/3.321。高 zoom 的差距仍未解决。Map query 可能包含瓦片碎片，不能与输入feature数量或GPUdraw数量等同。证据：`dense-extremes-qualified-v2/`；后续增强了计时前资格，未倒填本轮。

增强后的独立pre/post资格在同一冻结v2的zoom14.5/2/25全部通过。计时前实际zoom分别为14.500000000002/2/24.99999999992025；计时后settle为14.4314482496/1.9314482496/24.8657241267，与Map相差不足2e-9。两端pitch60/FOV45、640×720视口、四轨实际像素、来源loaded和errors均资格通过；每次readback/资格采样前后计时样本数完全不变。所有计时结束的`loadedAtEnd=false`保留，随后loaded不能倒填结束状态。这六个renderer运行仍只是新资格证据，不能替代最终三轮测量。输入6400与Mapquery碎片数不作为draw数，Native实际命令/瓦片/collection规模及前后四色pixel counts均在原始资格JSON保留：`dense-extremes-prepost-v2/`。

## 整合验证与新发现

首轮全套单测 58 文件 306 项通过；整合后的 lint、类型检查、库构建与演示构建通过。后续整合单测曾有 307 项通过、1 项失败：新 globe LOD 在 covering zoom >4 时允许随相机变化的 source detail，旧用例错误地要求该分支没有新确认帧。已复算两个真实相机 pose 的 source selection，原“已消费旧 debt”控制改在真实低 zoom 常量 LOD 分支运行，另保留高 zoom 分支一次确认后静止的回归；相关 14 项与全套 58 文件 309 项均通过（14.46s）。全套硬件功能 e2e 首轮 42 项通过、3 项失败；三个原失败均已有各自硬件复跑证据，最终全套仍待运行。

- style/source 切换的“空帧”失败已证实是测试只认可过渡两端的颜色。改为逐像素匹配完整不透明颜色线段，仍检查所有帧及最终颜色；硬件复跑通过，没有禁用全局过渡或放宽空帧覆盖要求。
- Manhattan 原卡死由高空 source LOD 缺陷引起，已修复且实际跨洲、60/15 米、CV/2D/3D 切换和移除建筑像素控制通过。
- 四瓦片角落的倾斜虚线断言同样在原始源码基线失败。修复真实 optical style scale 后原四个样本、单次混合/picking/所有权断言均通过，没有放宽像素容差或缩小采样偏移；只将已删除的高度抬升预测改为实际地面坐标。
- CV 地平线水/道路的 6 种代表配置、共 120 帧没有真实像素孔洞；测试中旧 1/1.01 米断言改为物理地面 0，整合硬件复跑通过（19.6s）。
- 真 globe shader 与 transition=1、实际相机矩阵、FOV、地面投影和 worker anchor 资格通过后，最初 65° 倾斜下 Native 线厚约 1.66px、MapLibre 5.22px，圆点高度约 30.91/13.07px，图标约 19.07×7.56/27.55×10px。真实 optical focus 修复后 style zoom 15.24→14，线厚与圆点倾斜差异消除；当时剩余图标/建筑小残差仍使严格比较失败。后续实际上传几何与 GPU 顶点诊断解释了模型采样和参考精度残差，automatic globe11 的严格比较已通过，详见下述最终资格结果。默认 globe 在 zoom14 的实际 GPU 分支是 Mercator，不能冒充球面验收。
- zoom23 近地偏移与圆点倾斜已修复。完整 source/layer ID 替换的来源归属排序修复后，真正球面的形状/精度资格、遮挡、阻塞新来源期间保留旧画面、完成交接及移除后释放 buffer 的4项硬件复跑全部通过（36.8s）。

### 后续极限审查的新红信号

- 含 `/` 的 raster source 使用首个分隔符截取 tile key，使真实 TilePyramid fade 被替换为1。修复为最终分隔符；实际8000ms初始自淡入 GPU 红信号 `[51,102,170]` 转为与实际淡入系数一致的 `[4,8,13]→[5,10,16]`。`tile-residency` 的固定 `vector/` 前缀解析语义不同，保留。
- symbol camera/composite paint 改为保留真实 Worker 两端，在 GPU 使用各属性自己的插值因子。现有16个 active attributes 已满，通过已有属性打包维持数量；只在实际 paint revision 变化时复制端点，zoom 更新不重写每个 glyph。颜色先按上游 premultiplied 端点插值，再与独立 opacity 组合；普通图片按 Worker 的真实 SDF 标志绘制。全仓 lint→类型检查、58文件309项单测、库和演示构建通过；13项硬件符号/globe组合中12项先通过，剩下一项随后定位为下述参考图片重复混合问题，不能当作整体最终验收。
- 内联图片配 `text-halo-width=2` 时，MapLibre 6.14.0 实际画两遍相同图片，图片 fragment 分支不区分 halo，两次混合使其过亮。实际相同 quad、size、opacity 端点与插值已独立确认。保留该参考缺陷诊断，并在同一驻留 owner/相机公开切换 halo2→0：本库图片像素不变，halo0 与 MapLibre 匹配，两个高度仍分别验证 composite opacity。没有复制参考缺陷或提高本库 alpha 来迎合画面。固定上游证据：[draw_symbol.ts](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/webgl/draw/draw_symbol.ts#L464-L493)、[symbol_text_and_icon.fragment.glsl](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/shaders/glsl/symbol_text_and_icon.fragment.glsl#L26-L35)。
- held/fading symbol 仍在绘制，但 camera paint 因子只更新 live tiles。实际旧 owner 的 GPU 红信号 `[14,0,35]`，独立旧样式 MapLibre 为 `[5,0,153]`。现按各 drawable owner 自己的 config 更新五个因子，保留旧 schema/source 端点，不读取新样式替换旧数据。真实 retire/commit 生命周期回归分别通过；此 fixture 有内部 owner 生命周期控制，不能声称它单独覆盖全部公开来源切换行为。
- 上述修复最初只覆盖 source/composite 的 GPU 因子；独立审查继续发现 held/fading 的 camera uniform color/opacity/halo 更新被跳过。同整数 zoom15.367→15.882的实际单旧owner取得颜色 `[117,0.062,68]` 冻结红信号，MapLibre为 `[10,0.235,76]`；跨整数zoom的初试有新live/双draw，明确排除。现保存最后提交的 tree/time/globals，并随zoom更新旧uniform；同schema共享、语义分叉才隔离材质并对称转移 atlas/material引用。有效硬件复跑颜色完全一致，halo面积38.11765/38.05490，误差0.165%；五个实际uniform与Map一致。17项相关单测、scoped lint→类型检查通过；prior→constant/global/schema另由真实算法回归验证，完整符号套件待整合。证据 `node_modules/.cache/playwright/symbol-fading-camera-{qualified-red,green}/`。
- 通用 paint 过渡在 `duration=0, delay=100, now=100` 精确边界进行0/0插值：真实 layer 返回 NaN，冻结旧 circle 会持续保留错误。复用既有延迟边界用例增加实际 live paint 断言取得20→NaN的红信号；在 Transitioning 根处按 `now>=end` 完成过渡，避免为每种轨道加边界补丁。scoped lint→类型检查、10项相关算法/交接用例通过。
- 阻塞替换 source 后继续 zoom14→14.06，旧 circle camera paint 冻结，Native 面积176.08、MapLibre旧样式1193.82。现冻结旧 transition 时刻/global state/数据端点，并继续按相机更新实际9个 circle paint 属性；纯 constant/source 无 snapshot，camera 尺寸只更新 uniform。包含颜色 alpha/opacity 的对照面积762.7294/762.8235，误差0.0123%；完成交接后新 constant paint 生效，原 circle owners 全部实际销毁。18项相关单测、scoped lint→e2e类型检查和硬件回归通过。证据目录 `node_modules/.cache/playwright/circle-held-camera-{red,green,final}/`。
- 上海同样式截图出现中文道路字形朝向差异：MapLibre 随相机选择水平/垂直 shaping，本库沿线 geometry 固定优先水平。独立CJK的0→90→0→-90→0取得竖向mask差83.8%/84.6%的红信号；真实相机/zoom/FOV/anchor资格一致。现保留横竖 Worker 顶点各自真实 paint slot，同view选glyph与opacity，未选候选由实际shader折叠。硬件五pose全绿，竖向mask约0.05%，28项相关单测通过；原九字形近地回归改为计算实际非退化GPU输出，保留九字/finite/edge/convex/orthogonality门槛，没有把两套候选索引误称18个可见glyph。SymbolGpuResources仍明确allowPicking=false，此项没有取得symbol picking验收证据。另有 North Zhongshan/Inner Ring 候选胜出差异，已确认是不同 source features；未取得当前v3城市像素与逐候选碰撞证据前不猜测原因。
- 再次核对上游发现独立语义差异：MapLibre6.14沿线碰撞始终使用centerJustifiedTextSymbolIndex的横排glyph offsets，且碰撞projection不flip；当前Native随竖排选项使用竖排path。已有CJK画面用例允许overlap并忽略placement，不能证明碰撞策略正确，现有竖排span单测也不能充当上游oracle。临时真实正交blocker硬件probe在bearing0/90均一致（8.9s），但该全宽字样例的横竖glyph offsets均为[-24,0,24]，不能区分两种策略，没有取得红信号。停止扩展此无区分力样例，保留raw并移出正式fixture的临时诊断；既不认定城市胜出差异根因，也不称沿线碰撞语义已验收。
- 倾斜CJK另补pitch60/bearing45与−90两个代表pose，不铺满横竖参数矩阵。实际物理相机/地面焦点、direction/up、zoom、FOV与源中心资格通过，保留0.5px和10%原门槛。45°mask差0.00124%，−90°mask逐值相同，原俯视五pose也通过；七姿态硬件回归14.5s。首次矩阵完整求逆的位置读法出现0.37m消减误差，独立归为fixture测量失败；位置恢复实际Map transform camera读取，矩阵只反解旋转，没有放宽画面门槛。最终证据 `node_modules/.cache/playwright/comprehensive-audit/line-writing-mode-pitch60-final/`。
- 删除道路始终为0的内部高度偏移参数/uniform、三处零位移normal计算和从未触发的 expanded-bounds replay；核对了生产、测试、脚本与公开导出，没有实际偏移输入。Line/CV已有模式常量会消除3D死支路，此项是代码收敛，不宣称解释CV的GPU热点。horizon测试删除由fixture常量或被删uniform推导的高度断言，继续独立用物理地面ray、真实road-only/combined framebuffer检查覆盖。相关14项单测和固定v2只覆盖6个生产文件的3项硬件horizon、日期线family、3D四角虚线/pick回归通过（29.0s）；最终整合硬件仍待运行。

- 真 globe zoom0 的 `tan+normalize` 旋转规则与上游16点细分已修复；只在globe+map增加细分，viewport/CV/2D继续4点。实际viewport→map→viewport图层切换经过已有预算调度和完整generation交接，未加入已发布record内的无准入重建。轮廓46×46；声明的WGS84/球面模型条件下map面积残差0.674%，viewport面积完全相同。
- 2D 日期线问题取得真实半径减半、面积约四分之一的红信号；按实际子viewport测量并校验同帧frustum缓存后，面积3469.62、height46与MapLibre完全相同。公开关闭log-depth的多视锥配置同样取得半圆缺失红信号；命令bounds包含shader角点范围后两个实际depth frustum均绘制，面积450.5725/450.5882，轮廓46×12。22项相关单测及最终circle/alpha/pick/释放10项硬件回归通过（1.5min）。
- MapLibre 与本项目允许 zoom25 后，MapLibre 四轨可见而 Native 四轨全空。共同原因是 `StyleLayer` 给未指定的 `maxzoom` 补24，所有图层在 `zoom>=24` 被隐藏；已按上游构造规则保留未设置状态，并修复移除范围与序列化时显式24被省略的问题。相关24项回归通过。相机还有独立资格问题：Cesium默认碰撞保护将亚米高度抬到地面上1m；纯函数证明实际高度变化正确解释 zoom25→24.087，未发现该姿态的额外 `cameraZoom` 错误。后续fixture关闭碰撞以维持同一实际相机，zoom25四轨硬件复跑已通过，纳入上述10项circle/alpha/pick/释放回归。
- 连续 A→B→C 来源交接中，复用的当前背景 ID 从首层移动到最后仍保留 B 的 rank。新增实际 GPU 回归在替换来源阻塞时取得白色覆盖 `[0,0,0]`，明确失败。现已按命令实际来源归属选择原保留样式或当前样式，删除混合 rank 合并；动态 raster 记录真实 source ID，含 `/` 的来源按最终分隔符拆分。硬件复跑12.3s通过，相关8项单测与整合类型检查通过。

最新整合的全仓eslint→类型检查、58文件312项单测（13.38s）、库/Worker/类型声明构建与演示构建均通过。精确过渡终点修复后，两项旧来源交接用例要求now400仍处于结束于400的过渡，先取得310通过/2失败；改为检查399保留旧payload、400完成发布，继续保留真实generation/schema/color/radius断言，没有回退生产边界修复。当前232个生产源码冻结为`measured-source-v3`并记录SHA256，最终检查后SHA漂移为空；旧v2含290源码/测试文件的快照和原始证据独立保留。MapLibre6.14.0/Cesium1.146.0固定；最终69项硬件功能整合正在运行，不能由单测绿色代替。

最终69项硬件套件首启出现磁盘ENOSPC和Worker加载错误，保留`final-functional-v3/`后停止；仅删除可重生成Vite缓存。恢复后三个相机动态用例通过，buffer-paint暴露依赖Cesium压缩前constructor.name的无价值断言，删除名称枚举并用实际注册kind分支，保留像素、buffer上传/identity和真实pick生命周期。scoped lint→类型检查通过。完整重跑`final-functional-v3-recovered/`取得64通过、5失败（7.4min），5项均为独立启动浏览器时chromium_headless_shell1243文件缺失，未到达渲染断言；补齐官方浏览器/ffmpeg后只复跑该演示及发布包文件，结果另列，不能将初始5项直接记为通过。

补齐浏览器后的`final-functional-v3-browser-recheck/`演示及发布包8项全部通过（14.4s），包含原5项及同文件3项重复控制，因此原69项均有有效通过证据。没有将环境失败改记为初次通过或再跑完整套件。CJK临时collision inspector归档后从正式fixture删除77行；单测删除假定竖排碰撞span必正确的无上游oracle断言，保留真实glyph切换/返回/缓存无重复更新回归。scoped lint→类型检查、相关12项单测通过；这些变更不改变冻结生产v3。

### 当前 v3 对 MapLibre 的三轮比较

`node_modules/.cache/playwright/comprehensive-audit/final-maplibre-v3-20261013/`完整12个新case，三轮各City CV、Dense14.5/2/25。场景顺序轮换，各case依赖Native生成相机，renderer仍固定Native→Map；不称renderer顺序交替。无profiler/GPU query/阶段/census/上传/Worker探针，Dense计时前后实际camera/四轨像素/loaded资格保留并排除计时。Native与Map全部timed`loadedAtEnd=false`保留；后置loaded不改写结束状态。此轮只比较当前源码与同时运行的Map，不拼旧v2数据宣称本轮优化收益。

单位ms；每端绝对P50/P95分别是三轮分位数的中位数，相对列是每轮配对比值的中位数。

| 场景/阶段 | Native P50 | Map P50 | 相对P50 | Native P95 | Map P95 | 相对P95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| City zoom-out | 9.6 | 4.2 | 2.548 | 17.9 | 6.3 | 2.632 |
| City zoom-in | 10.4 | 2.5 | 3.926 | 19.5 | 4.7 | 4.149 |
| City pan | 9.8 | 3.5 | 2.800 | 15.9 | 6.1 | 2.607 |
| City orbit | 12.7 | 3.3 | 3.969 | 24.8 | 5.4 | 4.593 |
| Dense14.5 stationary | 2.1 | 1.7 | 1.235 | 2.3 | 2.0 | 1.150 |
| Dense14.5 pan | 3.2 | 1.7 | 1.882 | 5.0 | 2.2 | 2.182 |
| Dense14.5 zoom | 3.2 | 1.7 | 1.882 | 11.5 | 2.6 | 4.423 |
| Dense2 stationary | 1.2 | 1.4 | 0.857 | 1.5 | 1.7 | 0.882 |
| Dense2 pan | 1.8 | 1.4 | 1.286 | 2.7 | 1.9 | 1.421 |
| Dense2 zoom | 2.0 | 1.7 | 1.176 | 13.5 | 2.8 | 4.857 |
| Dense25 stationary | 2.7 | 1.6 | 1.687 | 3.1 | 1.9 | 1.632 |
| Dense25 pan | 4.3 | 1.8 | 2.389 | 5.8 | 2.3 | 2.500 |
| Dense25 zoom | 4.1 | 2.0 | 2.050 | 5.3 | 2.8 | 1.857 |

City cold为4106.4/742.8ms（配对比5.501）；Dense14.5/2/25为4456.7/952.9、4554.9/954.1、4650.6/948.4ms（配对比4.680/4.774/4.904）。两类cold定义不同且本轮library是source，不称first-pixel、发布包性能或FPS。CPU尾耗时/冷启动/城市GPU差距仍大，不构成性能验收。

独立City实景诊断保留Native/Map cold-settled及motion-return-ready原图，当前两者仍有Inner Ring Road标签缺失差异：Map可同时画North Zhongshan及Inner Ring，本库只画前者。没有用旧不同要素的描述解释当前缺失。初始/返回pose相机严格资格通过；完整109pose诊断在Map orbit中发现参考公开camera converter的实际Mercator高度偏差0.184–1.839m，最大ground probe差0.247px（direction差<1.4e-10），超过诊断原0.1m/0.05px门槛，未放宽。故上述City为相同输入轨迹的无探针CPU比较，尚不满足所有orbit pose严格同物理相机验收；Dense资格独立通过。运动中取消不可见tile的`net::ERR_ABORTED`按实际tile URL单独记录，不将正常取消当加载失败；其他failed requests/page/render errors仍保留检查。原始诊断：`city-final-diagnostic-v3-shanghai-cold-return-3/`，完整原失败记录保留。下一步校准相机转换并直接处理有像素证据的标签缺失，不继续扩展无区分力的CJK样例。

最终 `globe-final-qualified` 四项硬件 GPU 用例全部通过（36.8s）：默认城市 globe 的实际 flat 分支资格、forced城市globe14的 TF 精度资格、真实 depth/source handoff/new-ready/remove 与 GPU 资源释放、automatic globe11 严格模型/形状比较。automatic globe11 在 pitch0/65 保持0.5px门槛；建筑比较实际上传 WGS84/sphere 几何的连续尺寸，再分别核对各自模型的 pixel-center coverage，保留位置、宽高和完整轮廓检查，没有通过扩大容差消除历史红信号。

forced vertical-perspective zoom14 保留为精度诊断：原始 line 长度1px、icon ink宽0.694/0.667px残差仍在 JSON `differences` 中，不宣称逐像素相等。相同实际VAO/UBO、真实GPU顶点及Float64复算证实参考端图标 envelope 宽度放大约0.729–0.739px，TF/非TF 的双方完整 framebuffer SHA256一致。结论仅覆盖已校准的赤道两个姿态、当前硬件及无DEM模型；证据、规范建筑模型测量和最终复现命令见 [源码研究的最终形状资格](upstream-rendering-research.md)。

## 相机资格、实景缺失与描边实验补充

使用 MapLibre 公共 `calculateCameraOptionsFromTo` 保留相机与目标各自的 Mercator 高度，ground focus 与 finite horizon target 采用统一转换。新的独立 City109姿态诊断通过，Map实际位置最大误差0.00003852m、方向误差1.10e-10、地面误差0.000007794px，FOV差为0；Native最大位置误差9.09e-7m、地面1.01e-8px。原0.1m/0.05px门槛不变。证据：`city-final-diagnostic-v3-camera-exact-1/`。这是后续相机资格证据，不能反向将前述旧converter的12个CPU case改记为完全同物理相机。

Inner Ring Road的真实worker数据、几何和GPU range均存在。精确join到source `openmaptiles/transportation_name`、tile14/13719/6692、feature470967410、layer `highway-name-major`、ordinal15，双方21glyph及offset一致；Native原collision调用3次实际返回true、两个orientation opacity和真实GL range opacity均0，Map公开ROI查询与截图中同feature可见。已定位到碰撞决定，具体blocker与双方碰撞形状还需直接证据，不能用priorOwners候选列表代替。原始证据：`city-label-candidate-v3-cold-1-retry/`。

后续决定性cold探针（21.6s）直接记录原predicate返回true处的实际owner，证实North Zhongshan Road(feature522055690/ordinal7)阻挡Inner Ring：Native最近碰撞圆距离17.540816370px，小于半径和19.600056611px；Map真实GridIndex同feature对返回false，对应距离21.634553611px，大于19.600000381px。双方半径一致，Inner圆端点位置差约4.334px。Native使用keep-upright翻转后的placement path做collision；Map6.14的collision_index.ts:232–244显式使用flip=false的水平代理，placement.ts:710–733与其配套。根因不是priorOwners猜测，实际相机和四点投影误差均在原门槛内。证据：`city-label-candidate-v3-cold-blocker-1/`；正在独立修复collision路径，不改变可见glyph的正向翻转。

近地平线64姿态资格完成：缺失公共font通过单独显式捕获补齐，随后一次capture补完其余未捕获资源，再用严格replay通过（31.9s）。`city-camera-exact-horizon-1/`、`-2/`保留资源缺失失败，`city-camera-exact-horizon-capture-1/`标记capture，不冒充replay；最终证据`city-camera-exact-horizon-3/`。Map实际位置最大误差0.000031511m、direction3.62e-10、ground0.000008732px，Native位置1.49e-8m、ground2.22e-8px；0.1m/0.05px和styleZoom1e-5门槛全部维持。使用独立不可变发布文件`camera-exact-published-v3`及源码v3，此结果为相机资格，不宣称已验收该实景全部符号/形状。

Native LINES填充描边的单轮短实验P50为29.495ms，相同v3短控制为40.8669ms，资源47,788,201→43,249,073 bytes；该数据仅支持进一步检查，不构成正式性能结论。添加真实片元tile clip后单轮P50约33.5ms，但6条矩形边的独立MapLibre近/远、pitch0/60/70画面探针发现赤道瓦片边界横线全部消失。未clip的Native LINES与Map18个profile一致；旧strip方案也在倾斜边界丢线，并有宽度差异。三个原始控制分别保留在`outline-perspective-v4-1/`、`outline-perspective-native-unclipped-1/`、`outline-perspective-v3-control-1/`，不是无错误资格的性能验收。当前生产恢复v3，两个Native LINES版本只在不可变实验快照中保留，先解决边界所有权再采用；不以取消clip或扩大epsilon掩盖问题。

## 演示高分屏与紧凑移动布局

高清显示默认开启，通过Cesium公共 `useBrowserRecommendedResolution=false` 使用屏幕DPR，关闭后为true；现有 `resolutionRatio` 独立保留，设置变化resize并requestRender，URL `hd=0`、预设切换与重新打开链接保留设置。桌面面板宽272px，常用label/select横排，移除大标题、品牌装饰卡片和说明段落；相机与自定义Style折叠。手机默认收起，触控至少44px、展开内容限半屏内滚动并保留安全区。网页 `<title>cesium-vector-tileset</title>` 未改。

scoped ESLint→全项目vue-tsc及独立e2e类型检查通过。实际硬件浏览器3项demo-controls通过（33.1s），保留原异步错误/移除取消两项，新增一个真实DPR2用户流程覆盖画布分辨率、切换、分享、preset和移动布局。390×844 CSS视口默认GPU画布780×1688；关闭后390×844；ratio1.25关闭高清为487×1055，重新开启为975×2110；桌面1440×900、同ratio及DPR为3600×2250。各阶段无横向溢出、page errors，保留实际画面正控制及title断言；没有仅断言CSS或私有字段布局。证据与已查看桌面/手机截图：`demo-compact-hidpi-v1/`。截图使用冻结纯色MVT验证显示/交互，不作为实景视觉一致性验收。

## 未完成的验收与后续工作

- 扩展已通过的符号 paint 对比到真实球面投影，检查静止/平移时没有无效顶点重传。
- 增加并校准 MapLibre globe 与倾斜三维场景，检查近地/高俯角/近地平线的形状、尺寸、朝向与遮挡，修复有证据的差异。
- 完成极低/高 zoom、近地/高空和密集几何/符号的性能与画面差异比较，记录快速相机变化、LOD交接、缓存淘汰和上传长帧。
- 按 lint:eslint → lint:tsc 顺序完成整合，再执行相关单元、GPU 像素/连续性、真实 Worker、发布包和构建验证。
- 针对 v2 仍退化的城市 zoom-in P50、各阶段相对 MapLibre 的剩余差距及冷加载继续定位，并用无 profiler/诊断探针的交替 A/B 复测；保留完整 v2 原始结果，第一检查点仅作明确标注的历史汇总，不以一次波动或局部改善宣称整体提速。
- 继续审计大模块的实际重复规则与单次转调，收敛有证据的职责问题。生产非生成 TypeScript 仍约 5.2 万行，本轮不声称已解决全部规模/复杂度问题。
- 继续定位冷加载单个 Native 上传单元、Worker 几何转换和大量 draw submission 的成本；预算切分不能中断单次 Native update，需测量后选改进。


## 2026-10-14 本轮继续审查与高收益优先级

范围和完成条件见 [明确目标](audit-goal.md)，文件级状态见 [覆盖台账](audit-coverage.md)。按用户补充，优先实际漏绘、样式失效、加载失败和完整帧热点；命名、纯风格、小包装和缺乏整帧收益证据的局部优化后置。当前仍只有部分源码完成审查，以下验证不代表整体完成。

本轮已复现并修复：合法 GeoJSON 属性 `constructor/$name/__proto__` 在真实 Worker 往返中的破坏、单瓦片失败误判整个来源加载完成、sprite JSON 早期失败因 PNG transform 尚未结束而成为未处理拒绝、图案大世界坐标 Float32 丢失相位及来源 LOD 与样式 zoom 混用、最高 raster zoom 子瓦片错过父子淡出、符号 camera/composite/step/零端点/大尺寸规则丢失。各修复保留实际修前失败与限定回归，没有按旧文档完成标记跳过。

整合硬件画面对比已有 30 项通过，包含真正 globe 两个倾斜姿态、forced globe 精度诊断、深度交接与移除、CJK、zoom0/2/25、日期线、多视锥、符号实时 paint 和六种真实尺寸规则。产物 `node_modules/.cache/playwright/audit-integrated-symbol-globe-extremes-20261014/`。全套单测当时 61 文件333项中332通过，1项 Worker lifecycle 在并发负载下超时；该文件单独复跑5项通过，没有扩大超时或删掉失败用例。后续新的 line 和 bounds 改动需要单独整合验证，不能沿用该成绩。

线条 gap/offset/blur 原真实画面分别出现26px、20px、4px的独立差异，入口接受而 shader 未消费。当前三个代表性规则已在硬件生产 Cesium 对比 MapLibre 中通过；原 ground width/near-far perspective、倾斜 fill outline 也通过（共3个测试，22.3s）。证据 `audit-line-paint-red/`、`audit-line-shape-complete-regression/`。family/dash/pattern和保留旧样式的数据链验证仍在进行。

图案证据不只比较红蓝总面积，还检查实际80像素条纹序列；zoom20.25、24.25及pitch70对比通过。精确整数zoom24的初试存在 Native重建值23.99999999992071与MapLibre24的 floor 分支差异，未当作已解决；没有加入任意epsilon绕过。墙面图案UV和lighting的独立问题仍待实际三维画面复现与修复。

文字图集直接上传 R8，消除了每个 glyph atlas 的灰度→RGBA→canvas转换。首次真实 Context.draw 及公开更换文字后的首次绘制均验证：实际 active sampler引用R8图集、尺寸匹配、资源存活、不是默认纹理；后续文字颜色像素仍与MapLibre一致。复用原 formatted text 用例，没有增加只断言内部布局的单独测试。产物 `audit-glyph-first-draw-native-count/`。最初两次探针失败分别是探针误读无owner的Native背景命令、误把Native可省略的count当0，已按实际Context.draw契约修正；这些不是生产渲染红信号。

### 图集优化的当前完整帧测量

固定232份生产源码，before/after只有 shared-atlas-textures.ts 和 symbol-renderer.ts 不同；3对AB/BA/AB、固定资源replay、同一109姿态物理相机、硬件生产Cesium，不启用profile/query/诊断。每个case内部按Native→MapLibre运行，没有宣称两引擎交替。原始证据 `node_modules/.cache/playwright/comprehensive-audit/glyph-direct-ab-20261014-isolated/{records,summary}.json`。

| 阶段 | Native CPU P50 after/before配对中位 | P95配对中位 |
| --- | ---: | ---: |
| zoom-out | 0.947 | 0.896 |
| zoom-in | 1.138 | 0.895 |
| pan | 0.870 | 0.994 |
| orbit | 1.146 | 0.939 |

冷加载配对中位1.018（没有加快）。只有zoom-out三对P50/P95方向一致；zoom-in/orbit P50波动，没有整体收益结论，不能用局部转换消除掩盖。最初受到类型检查并发干扰的一组已明确排除，保留 invalid-measurement.json，不混入上述样本。后续profile仅用于热点归因，不用于公平耗时；after cold profile还与一项功能用例重叠，不比较其冷加载绝对耗时。before motion采样的TinySDF/measureText/getImageData和Worker消息仍明显可见，图集canvas writer的消除只解释对应局部成本。按新优先级先完成高收益画面/加载缺陷，再处理占比和可避免工作有证据的热点。


### 新缺陷收尾与下一轮实际红信号

大图标漏绘修复后硬件比较通过，Native/MapLibre均覆盖460800像素。修前真实Worker布局端点已超出int16并反转（x1/y1=1694，x2/y2=-1694），anchor在921.071,360、640×720视口之外；该entry resident/placed/visible都成立，但opacity全0。现按上游allow-overlap语义绕过不可放入网格的盒筛选，普通符号仍保留合理筛选；GPU command包围体按真实frustum与尺寸展开，避免固定40m/px和逐帧累加。raw `audit-symbol-large-offscreen-actual-geometry/`、`audit-symbol-large-offscreen-overlap-green/`。临时offscreen内部诊断已从fixture删除，永久回归保留真实像素比较。

family生命周期最初失败是合成32条24px道路casing覆盖整tile，冻结before也完全同样失败。已把道路集中到独立边缘走廊，建筑和outline均有可观察区域；拾取、2D/CV/3D交接、实际数组/纹理稳定和释放断言不变，完整测试通过（12.1s），证据 `audit-line-family-separate-visible-corridor/`。没有把被遮挡图形当成此轮新增line回归。

assets新增三个实际修复：一个缺图resolver同步抛错或异步拒绝不再阻断同批成功图片，每个失败仍报告error；sprite同id尺寸变化不往旧atlas的小rect越界复制，不标记已成功更新，旧代保留像素与布局直到Worker新代就绪；替换64张未用256×256 lazy sprite，旧版64次readback/16MiB变为0次/0bytes，新版图片真正消费时才读回。4文件14有效测试绿；这些量是消除无用工作证据，没有对应整帧FPS结论。

合法不含URL的image source在onAdd/load于try外抛错、serialize同样拒绝；现允许空来源初始化并发布metadata，再接受已解码内容。新增一个合法工作流回归覆盖load、serialize、后续decoded image→真实Tile.prepare，先红后绿；相关source/tile三文件14项通过。

当前整合全仓ESLint、类型检查、独立e2e类型检查、63文件346项单测、库/Worker/类型声明发布构建和演示构建通过。该检查点没有包含后续待修的墙纹理和HTML回退问题，也不表示未审源码通过验收。

下一项实际GPU红信号：zoom14.25、pitch65、水平红蓝sprite、light intensity0/verticalGradient false，双方屋顶与建筑轮廓对齐，但本库墙面整片[32,0,223]，MapLibre墙面保持垂直红蓝重复。240像素中心剖面67像素不一致；两端floor样式zoom均14，源码LOD不同不影响此项资格。已查看并列截图，证据 `audit-pattern-wall-vertical-red/`。新增有区分力的wall回归保持失败，等待正确的edgeDistance/height_factor和lighting实现，没有改阈值绕过。


### 图片首上传与共享像素生命周期（2026-10-14）

HTML decode 回退路径原先在 resolve 图片后下一 RAF 将 src 改成透明 1×1；消费者等慢 JSON 或真实 Native 上传时已拿不到原图。已删除这个提前替换，保留 Blob URL revoke。独立已知 PNG 是 oracle，MapLibre 同版本也含相同旧逻辑，不能用它迎合错误。硬件 Intel Vulkan red/green 原 PNG 都是16×8，修前 Native 实际 sampler 为1×1、红像素0；修后 sampler16×8、红像素5476/45000；延迟读取与慢 JSON sprite RGBA 正确、无 page/render errors。证据 `html-decode-fallback-hardware-{red,green}/result.json` 和 `html-decode-fallback-hardware-summary.json`。探针使用真实 Native 开发模块，未称发布包性能；13项关联 CPU 回归与类型检查通过。不据此宣称 Safari 长期内存或 FPS 收益。

ImageSource unload 会遗留 source.tiles 的旧 Tile及textureData。现按 Tile 身份清除所有 wrap 别名，避免旧代延迟卸载删除同 wrap 的新 Tile；onRemove清空来源引用，仍持有的 generation/消费者像素不关闭。真实 TilePyramid 缓存淘汰与 updateImage 重建回归先红后绿，含 wrap 跳变、相同 wrap 新代与 held generation，相关4文件23测试通过。

RasterTileSource reload/unload 原本显式 close 已发布 ImageBitmap；旧 generation/排队 material仍共享它。原真实 protocol PNG→TilePublishQueue→预算阻塞 Native 首次 update 中，reload 将旧 Bitmap16×16变0×0，Texture.update抛 width必须>0；未 reload 控制能成功上传，提前 drain 新代 publication 控制仍失败。最小修复仅撤掉已发布图片的2处 close，保留取消/过期未发布响应的独占 close。原三分支复跑全部 Bitmap16×16、actual Texture adopted=true、pending0且无错误，保留 red，green 为 `audit-raster-bitmap-first-upload-green/result.json`。scoped ESLint→全仓类型检查→5文件25测试通过。共享像素最后一个引用释放后由 GC 回收，没有确定性 close 或内存硬上限承诺。

挤出图案新几何路径首轮白图 lighting 比较通过，但条纹墙面仍有58像素差异，未记为绿。真实 production Native linked shader/VA 确认 GeometryPrimitive.compressVertices=true、st被 FLOAT1 compressedAttributes替代并经 czm_decompressTextureCoordinates 解码；该 codec 仅适合0..1，破坏负数高度与多次重复UV。旧 pattern primitive原本明确 compressVertices:false。真实 Native combine CPU 回归同样先红，正在恢复此纹理坐标契约，UV数学不改。raw `audit-pattern-linked-red/result.json`。


### 缩放时来源覆盖被地形级别清空（实际 GPU 红）

已知16×16不透明白图，raster minzoom12/maxzoom13、tileSize256、bounds0.099..0.101；CV双屏中心0.1,0.1，height5000→20000，最终Native style zoom11.2528217484421、MapLibre11.2528217484545，双方请求旧source13及新source12。MapLibre中心每个render均255白；Native旧13首帧255，随后多帧active=[]且黑0，父12首次加载被self fade，0.305时灰78、最后恢复255。不是同色内容变化或正常初次edge fade。raw `audit-raster-parent-white-map-matched-red/result.json`。

独立逐帧terrain取证 `audit-raster-parent-white-terrain-red/result.json` 明确：缩放后Cesium暂选terrainZoom8/10→9/10→10→10/11，来源camera目标12仍合法，但cached primary/tileIds=[]；旧source13被cleanup。只有terrainZoom12进入对应区域后才重新得到父source12。globe-covering.ts的seed阶段`terrainZoom<sourceMinZoom`直接return[]，阻断已有frustum约束的collectCovering下钻。本轮优先修复这个实际清空链，不能误改正常retainLoadedChildren或tile-fade规则。新永久像素回归覆盖相同白图整个缩放，能同时发现覆盖清空与后续双draw合成变暗；尚待修复后实际复测。

双屏初试沿用单屏40000m使Native zoom落到10.2528/source期望低于min12，不能用于同source12父子fade结论；保留 `audit-raster-parent-white-map-qualified-red/`但已由上述20000m、同实际styleZoom资格的重跑取代。单屏原始证据独立保留。

墙面纹理压缩契约修复后，Native/MapLibre墙与屋顶重复图形对齐、白图lighting通过；240像素剖面剩9个条纹过渡RGB差异（4墙、5屋顶），仍未记录全部画面通过。独立CV射线/平面/LINEAR采样模型预测Native这12个边缘红值与actual误差≤1；Map-only fragment mediump改highp实验仍差9，否定仅默认fragment精度的初步推论。生产未降精度，原阈值未放宽，证据 `audit-pattern-wall-light-uv-green/`（该名称是attempt，只有light绿）及 `audit-pattern-reference-highp-experiment/`。按高收益优先级暂停扩大这项细微采样差异实验，先处理覆盖清空和加载停滞。


### 304 加载槽停滞与实际父子合成暗闪

真实VectorTileSource/load/parse gate/actor消息回归：20个expired revalidation占满slot，已加载coarse parent覆盖的20个新ideal被延后；304只释放dispatched key，不递增selection revision或发tile data事件，静止requestRenderMode不能再启动这些ideal。旧码与仅移动revision两次均20/40请求红。现把revision移到304return前，且仅active unmodified completion于finally真正释放slot后调用既有deferred drain（paused跳过）；无新tile data/bucket publication、无feature-state重置。最终无需人工camera/update即可40请求、复用同cover不重复、全部loaded。scoped ESLint→全仓tsc→4文件30测试通过。

coarse terrain seed修复后原opaque白图用例139Native/123Map frames始终255，empty draw0，黑帧消除；但父子pair对中合法Departing枚举0被`!fadingDirection`误认unset，旧child的u_fade始终1。半透明层的新实际probe证明Native147→192而参考每帧128，不能据opaque绿称合成正确。现明确undefined判断，真实TilePyramid配对原起点[0,undefined]红→[0,1]→[.5,.5]→[1,0]绿；4文件21回归通过。

修复该guard后真实GPU首次完整父子互补fade：opaque Native191..255、Map固定255；opacity.5 Native111..128、Map固定128，双方实际中点fade约.517/.483、没有空draw。两条有独立意义的正式像素回归均红，raw `audit-raster-parent-child-real-fades-red/`。根因仍为两份独立alpha blend，不等价于一次同片元图像mix；下一步必须同时处理parent/child同层覆盖去重，不能把parent全局隐藏（部分子tile未ready会漏绘）或只改shader双sampler就宣称完成。未通过GPU项保留失败，不降低opacity或像素断言。


最新整合检查点（含HTML decode、ImageSource引用、Raster共享bitmap、pattern新appearance、coarse terrain、304与Departing枚举修复）：全仓ESLint→全仓类型检查、独立e2e类型检查，以及64文件358项单测全部通过（14.35s）。仍有三个针对性GPU验收失败（两个raster opacity、一个pattern边缘采样）；单测全绿没有改变这三项状态，发布构建与后续合成器变更验收尚未沿用旧检查点。


该358项检查点的库/Worker/声明构建与演示构建也通过；只证明该检查点可构建，未解决上述3个GPU失败。后续一次合成器/纹理lease实施需另行验证。

按收益排序，主帧只读复核没有为每次sort、pending owner扫描、纯worker等待时的memory report重写代码。已有City规模仅约303命令、18–39内存条目，warm7.7s内整个DrawCommands.prepare self约37–41ms、Replay约5.5ms、_inspectBuilds约2ms，排序只是prepare的一部分；visited/uploadTurn与settled快路径已避免重复真实上传。候选登记后置，没有据采样数虚构调用次数或帧率收益。字形缓存也已按font/codepoint合并并发TinySDF生成，8批×2码点现有真实回归只draw2次；当前CPU采样不足以认定重复字形生成，取消后无用RPC回复比例尚未测，不优先实施。

静止覆盖缓存还确认一个后续CPU生命周期问题：含SymbolBucket的旧tile被hold后，sameUpdate会在symbolFadeFinished/removeTile之前return，source/worker payload越过fadeDuration留active，直到覆盖/加载等再次变更。不能称永久GPU pinned：getRenderableIds排除hold tile，Residency与SymbolTileRenderer独立fade/retire，旧GPU可被预算淘汰。该项登记待后续，当前先完成实际raster合成失败。


### 父子图像一次混合与来源移除回归（2026-10-14）

Raster 已将同层独立两次 alpha blend 改为同片元混合 child/parent 图像后再应用一次 layer opacity。只由真实 ready、可见、同 source 身份、样式与几何 scope 的子图覆盖父图；部分未就绪子图不能全局隐藏父图。新 raster-textures lease 按 generation/filter 共享 physical texture，Material 只持 non-owning sampler，最后 lease 释放再销毁，保持真实 Native Texture 身份；源 Bitmap 不提前 close。Renderer producer 保留 video readyState、播放/seek 的实际更新语义，没有增加独立 RAF。相关 CPU Native Material 生命周期、coverage 与 Source publication 回归通过，未据此认定 GPU 验收。

真实硬件 Intel Vulkan + production Native：原正式 opaque/opacity.5 两项及带斜杠source self-fade共3项绿，原白图阈值不变；新增代表性的 opacity.5 opaque red child / alpha128 blue parent，真实中间像素遵循 straight RGBA mix→alpha→layer opacity 的独立颜色曲线，旧red128、新blue64都出现，Native/MapLibre各自fade时钟不必相同。该新增1项也绿。证据 `audit-raster-once-mix-first-green/`、`audit-raster-once-mix-color-alpha/`。仍未宣称所有 raster/globe/倾斜交接通过。

原 Bitmap 首上传探针是在 SwiftShader 上运行；另保留新的 hardware + production Native 资格重跑 `audit-raster-bitmap-first-upload-lease-hardware/result.json`：真实 protocol PNG→TilePublishQueue→预算阻塞首次update，未reload、reload但B未publication、B提前publication三分支全部16×16，immutable generation 仍持同图片，actual Native sampler adopted、pending0，无 page/render errors。按新 lease binding 合同更新探针，不把构造期 uniforms.image 必须是 Bitmap 当成公共行为。

一次混合后的实际fade末帧仍能观察到 old13 和 new12 两份 draw。已确认 TilePyramid.sameUpdate 快路径越过 deadline、helper重配旧 pair 的问题；正在增加一次到期清理和真实 GPU 未ready fallback hold。必须同时保留部分缺图覆盖，并让父图mask独立于仍active fade descriptor。此项尚未修复验证，当前不能称 renderer 退休或性能验收完成。

Vector source onRemove 原先只逐tile清理，WorkerSources 中 source 对象、parent decoded cache和overzoom结果保留。真实 Style/Dispatcher/TileWorker/structured clone 回归先红：同一tick删除并重建同ID、同URL，响应内容已改变，仍输出旧point bucket；修复同步取消旧加载并广播removeSource到全部Worker后，重新下载、建立独立source，旧payload不发布，新西半球子图为空。不同URL串数据未确认。scoped ESLint→全仓tsc→5文件28回归通过，未运行该项GPU。

静态确认但按收益后置：合法 constructor/__proto__ source ID被普通{}字典读取继承属性误报重复，初始化异常被Style.loadJSON catch吞掉，readiness可能长期pending；WorkerSources和StyleLayerIndex同名字典需整链核对。SourceFeatureState接受__proto__ feature ID时可写Object.prototype；顶层SDK目前未导出feature-state API，按内部状态风险登记，不夸大为已触发Native渲染故障。尚未实施这些字典修复。


### 过渡退休、视口灯光与圆角建筑实际验收

正式4项硬件/production Native raster回归通过，包含self-fade、opaque/opacity.5、彩色透明PNG和父图未覆盖quarter。到期后只剩父tile12；进一步hook实际GL.drawElements，按linked shader的raster材质识别真实draw，133帧里120帧两draw、末帧一draw，half PNG像素仍blue63（64±2 oracle）。证据 `audit-raster-once-mix-retirement-partial/`、`audit-raster-retirement-actual-gpu-draws/`。这是消除过渡后多余提交的事实，不是整帧FPS测量。短fade跨walk deadline以及idle requestRenderMode正在补强，尚未沿用此GPU绿验收后续改动。

额外Native SCENE3D斜视的128帧 half-white PNG全部128、父子13→12无缺图，probe `audit-raster-parent-3d-tilt/`。其reference由旧syncReference/cameraZoom求值，最终Native style11.17531177而Map11.17210936，差0.003202，未达到同camera/stylezoom资格，因此只记录Native独立已知图像oracle，不列为同相机三维双屏验收，也未把camera.heading与globe光学focus ENU混为一致。

Viewport light：此前取azimuth0/bearing90的白墙预测不成立，实际两引擎都灰128，是无效lit-wall资格；保留 `audit-extrusion-viewport-light-red/`但不用它称项目红。改已知light position[1.15,180,90]、intensity.5、gradientfalse、bearing90/pitch65，轮廓及map-anchor控制均一致，Map viewport可见墙255、Native128，62剖面pixel红，`audit-extrusion-viewport-light-qualified-red/`。主源码确认使用Rz(+bearing)，未猜负号。

修复owner冻结raw light/anchor，camera共享稳定vec2供两种shader旋转；bearing不进入lightRevision。硬件production3tests（原map白sprite、viewport pattern、viewport solid）通过，`audit-extrusion-viewport-light-first-green/`。进一步公开相机从bearing0→90，actual Native vertex-array identities保持、lightRevision不变，同时两条solid/pattern像素验收均通过：`audit-extrusion-live-bearing-qualified/`。首轮solid资源检查错误地检查外层PrimitiveCollection，count0，已按实际extrusions collection孩子修正观察，不改生产迎合该错误。现有pattern held generation CPU新增capture-control保证raw light冻结而holder相同live；CV Geographic/WebMercator、3D zero-roll nadir/tilt和物理帧snapshot同帧/下帧资格，6files63CPU tests通过。MapLibre solid globe额外normal/light转换仍待验，不能由这些CV绿覆盖。

Rounded extrusion：populate已fillet后addFeature再fillet，solid和异步pattern两路都改变轮廓、扩顶点。真实bucket单次圆角字面坐标oracle先红49点→17点、每feature2次→1次；保留人工buffer-cut原端点，避免给裁切边制造斜墙；双精度Point弧计算后round/snap/相邻去重，子网格弧不生成零长度墙。仅两生产文件和一个同级几何回归，scopedlint→全tsc→3files26tests通过。

独立Vite load plugin冻结这两原HEAD文件作before，不修改当前生产。硬件production Native、相同zoom14.25/FOV45/640×720/0与65°倾斜，使用无方向光影响的白solid，对完整silhouette阈值127取边：before roof Native10486/Map10816、330px不同；tilt Native9713/Map9954、241px不同。after两姿态分别10816/9954，与Map计数相同、different0，无errors，`rounded-extrusion-{before,after}/`。对应正式完整silhouette回归正在收尾；这不验收圆角smooth normal光照或全场景性能。

全源码审查新增确认circle translate/anchor被接受但当前无renderer消费者；跨tile circle-sort-key在投影数据路径丢失只保留bucket内排序，需独立双tile交错key像素红。MapLibre viewport translate也转到地面Mercator offset，不能误按倾斜下固定屏幕xy实现。登记后续高收益画面修复。覆盖台账目前235生产文件，132完整阅读、9局部、94待查；变化中的deadline文件登记仍需此次实施完成后复核，未宣称全仓审计结束。


### 本批整合检查点（2026-10-14）

包含一次 raster mix/共享纹理lease、实际ready部分mask/GPU first-update hold、deadline与duration0清理、sourceSync后清理wake（静止paint recalculate0）、Worker来源移除缓存、viewport light/livecamera、rounded geometry。全仓 ESLint→全仓类型检查，67文件380CPU测试通过（15.20s），库/Worker/声明构建与演示构建通过。13项硬件production Native GPU整合回归全部通过（1.5m），包含solid/pattern paint替换、canvas→vector、image lines 2D/CV/3D、同source新URL、slash self-fade、opaque/half/colored PNG父子fade及partial quarter与真实GL退休、public icon更新、solid/pattern viewport light livebearing与VA稳定、rounded roof/tilt完整silhouette。raw `audit-raster-light-rounded-integration/`。仍未通过的条纹9过渡像素和新circle translate未归入这些13项，目标继续进行中。

正式rounded silhouette回归1项（包含0/65°）也通过，`audit-rounded-building-formal/`。已删除失去production/公开export/build消费者的tile-fade timepredicate helper及只覆盖它的旧断言；保留实际pair、互补weights、missing sibling fallback、deadline cleanup、duration0切换、真实FrameOwner requestRenderMode wake与稳定层不重算回归。测试数量仅表示检查点，不作整体验收标记。

后续极区全读新增独立风险链：真实terrain完全处于89..90°极冠时globe-covering clamp后直接空source rows；3D tile sphere只含Mercator边纬85.051°而漏实际pole cap，真实PerspectiveFrustum在北极高度407533m对z4 north row原sphere16/16 OUTSIDE，含pole sphere16/16 INTERSECT；tiled RasterGeometry当前无pole顶点，Map primary tiled allowPoles=true而Image=false并生成cap rows。需分别对terrain seeds、sphere和mesh做CPU红，并统一实际Map GLOBE/North camera进行GPU资格，正在独立授权范围实施；当前构建/GPU检查点没有覆盖其后改动。不能凭NorthPole在球外一个数值就声称实际屏幕漏绘。

### 极冠与圆点平移：新的硬件红→绿

极冠三项生产修复已落地：完全超过Mercator边纬的terrain rectangle仍seed对应极边source row；3D row包围体纳入实际pole；仅tiled SCENE3D raster mesh增加pole cap row，纹理保持合法边行，Image四角和CV不改变。6文件47关联CPU回归、scoped ESLint和全tsc通过。

真实16×16绿色PNG、Map vertical-perspective、source0..4/tileSize512/fade0、640×720/FOV45；从实际Map矩阵复制Native位置/方向/up，GLOBE linked raster shader的actual transition=1。Map public requested90°被clamp到85.051129°；本例验收相机可见的极冠，不能称public Map精确90°中心。Native可见terrain含85.78125..87.1875°的整块极区。production Native + hardware Intel Vulkan，100×100中央ROI修前Native4214/参考10000，修后双方10000，截图修前半屏大片黑色、修后消失；positionError0、direction/up约4.13e−13、无page/render errors。证据 `polar-raster-{before,after}/`。Native stylezoom3.91883477、参考4（球/椭球同实际pose），常量PNG独立颜色oracle有效，不据此宣称严格同样式zoom或所有极区图层完全一致。

最初从HEAD提取的RasterGeometry保留旧height参数，与当前已改API不符，产生tileCoordinates.map错误；这个失败已排除，不是项目红。有效before从当前绿版本只逆移除三处pole改动，保留之前API及coarse-terrain修复。另一次在postRender外读Native default framebuffer为0的观察也已排除，最终像素缓存来自真实postRender。

Circle公开paint translate/anchor原先被接受但没有renderer消费。合格最小圆点fixture排除道路遮挡后，viewport anchor/bearing90的[80,40]位移：Native中心320,360、参考400,400，相差89.4427px，`audit-circle-translation-qualified-red/`。逐anchor稳定Mercator→椭球差分、先移动再投影/地平线判定，所有owner共享连续zoom/bearing，绑定发生于直接cold child first-update之前；depth bounds从原Native sphere重算，不累加、不逐帧扫描所有features。旧代保存原paint树与translate/anchor，仍使用当前物理相机。零translate viewport circle不进入新的三角/指数差分计算。

5文件29关联CPU回归通过，包含首上传、held constant/camera paint、bearing-only变化与depth bound。原2姿态硬件production Native通过，`audit-circle-translation-after/`；后续4代表姿态（map/viewport、bearing90、pitch0/60、zoom14/24.25/25）通过，`audit-circle-translation-extreme-after/`。zoom25 [3,1]对应不到一厘米的地面位移，实际两引擎中心320.99550208,358.50367810一致，stylezoom差小于1e−6。低zoom真球面、跨纬度、日期线split和多anchor范围另做独立投影oracle，不由这4姿态代替。测试资格新增nativeStyleZoom最初未在circle capture输出导致断言NaN，是观察器缺字段，已修fixture输出，不能当作生产错误。

后续circle整合10项硬件production Native全绿（1.5m），`audit-circle-translate-integration/`：包含原有形状、map/viewport scale、fractional/blur/state、continuous camera/composite、source handoff、globe0大圆、2D日期线split、map-pitched depth boundary，以及新translate和球面投影两项。新增第5个translate姿态为focus depth1001、pitch75、[0,80]，移位后viewport圆点跨到Native近depth分区；保留新shader而仅退回bounds guard的消融，Native仍只draw near999.9..1e6/R0，area0，Map area176.5176，`audit-circle-translation-depth-no-bounds/`。当前正确版本该姿态也绿，断言实际near partition draw，不仅看owner.show。heading360与0按循环角误差校准，不当作生产错误。

球面zoom0、equator与第二latitude两姿态以独立double Mercator→Cartesian投影核对实际Worker anchor，shader差分不用于oracle。实际Native/Map中心各自距对应模型<.025px；第一姿态椭球/参考球面预测y差.12549px、实际.12558px，剩差<.001px；第二姿态也符合独立模型。没有增大像素容差迎合WGS84差异。1600个大跨度anchor的临时probe整体mask/centroid接近、2D平移split精确一致，但其最初nearest Native anchor对任意first Map feature的workerAnchorError216px是错误配对，未把该诊断列为逐anchor验收，仍需合格独立采样。

### 曲面挤出墙细分与下一项高收益样式缺口

退化tile-space墙三角形原仅细分最长边后fan到固定原opposite vertex，邻接源tri的共享diagonal切点与屋顶切点不一致。真实FillExtrusionBucket→extrusionBucketPrimitives→Native combine/cache optimize→SHORT+FLOAT packing/解码的独立三角面距离：roof grid点到墙39.999897m，共享diagonal点到另一半墙39.999479m；不是长边数量或仅私有布局断言。修复沿所有x/y grid参数裁剪三个源边，保留重心属性、绕序、base/top，移除旧edgePointAt纯局部算法，真实闭合误差<.02m。仅surface-subdivision.ts和新同级测试改变；extrusion-geometry.ts未变。scoped eslint→全tsc→4文件26关联CPU回归绿。

硬件production Native球面对照：source canonical6(32,32)、GeoJSON maxzoom6、north边y0赤道、base3000/height3080，避免原低zoom chord近似被terrain遮挡；Map实际center2.8125,0、zoom12.25、pitch65（显式maxPitch85）、bearing180，640×720/FOV45、actualGLOBE1。实际pose误差position0、dir/up<2e−14、Native stylezoom12.25000000000017。修前中心720-row RGB剖面6连续black/参考[8,255,8]；修后该完整剖面0不同。全图silhouette差3421→98，尚未由此标全图精确；Map GLOBE_RADIUS与椭球高度映射等独立模型正在核对剩余边界差。raw `extrusion-wall-{before,after}/`，before从此次当前API版本只冻结surface-subdivision，不取旧HEAD。第一组未显式maxPitch85实际被Map clamp60，已由上述真实65重跑替代，不冒称旧组65。

另一项高收益实际红：合法fill-extrusion-translate/anchor在solid和pattern全路径被忽略。公开白色building/白sprite、light0、zoom14.25、pitch65、bearing90、viewport[80,40]，Native中心320,332.42385，参考407.22961,349.40421，相差88.86697px；pattern同差，真实加载、物理相机、样式zoom、视口、硬件及errors资格通过。`audit-extrusion-translation-qualified-red/`两项保持失败，下一步仅修owner级保高度的逐顶点地面平移，连续zoom/bearing、旧代snapshot、first-update、command bounds和共享Material/UV需同时覆盖。fill面及outline也忽略translate，但3D Native Buffer/CLAMP投影缓存是不同设计缺口，不能只改direct shader或迁移全部fill掩盖成本；登记另外处理。

geometry worker链新的只读候选按收益后置：packet-copy尚未预约两个dispatch slot，可在多个budget受阻owner间产生多个整包副本峰值，未证明泄漏或真实场景成本；派发后取消丢弃回复但不终止同步旧任务，尚无实际等待归因。packSurfacePositions一次同步不能yield，但已有City cold self6.87ms/10.724s、warm15.442ms/7.726s占比低，不以局部优化优先级打断画面修复。来源reply取消/销毁后不复活owner、最后context释放终止Worker和撤销URL、发布Worker入口/导出链均已完整核对。覆盖台账已158完整、7局部、70未读，仍未完成全仓审查。

### 建筑平移与MLT数值属性：实施及最终整合前证据

建筑translate采用稳定Mercator→WGS84差分和已有base/height/top恢复地面法线，保留物理高度及Native RTE；solid/pattern共享算法，新增顶点属性0 bytes。零translate分支跳过高度及法线计算。owner独立uniform保留pattern Material/UV，首次cold upload前取得连续stylezoom/bearing，held owner保留旧paint树但使用当前物理相机。包围体按已有实例缓存最大高度，每帧从原sphere重算padding，不扫描全体顶点或累加半径。circle复用同一差分规则。四步法线恢复的独立Float32 Cartographic oracle共210例，包含1亿米高度、zoom4/14.25/25和两种偏移，最差约0.000282px；这是数值模型，不能代替GPU。scoped ESLint、全tsc、7文件52关联CPU回归通过。

最终shader硬件production Native首次、公开paint更新、bearing变化的solid/pattern画面对比均取得小于.006px的中心差，宽高一致。第一轮仅translate/anchor paint更新，全部4个owner及其实际Native VA/Material/sampler完全复用。第二轮bearing90→0有2个tile退出live覆盖，另外2个保留；旧4个owner的VA/Material/sampler仍完全不变，退出者进入retired pool。初版e2e要求旋转后所有旧tile仍在live maps，因此报stable false；该断言已按覆盖变化修正，没有修改生产迎合观察错误。证据 `audit-extrusion-translation-resource-probe/`；正式回归最终结果另记。

新极限/球面硬件探针 `audit-extrusion-translation-extremes-probe/`：zoom25/map[3,1]/pitch65/bearing90，实体Native/Map silhouette均9921px、中心完全相同；pattern中心差约.00067px。城市球面12.25/source6、低球面4/source4，实际GLOBE linked extrusion shader/transition1，实际相机position误差0、dir/up<4e−15、FOV45、stylezoom误差<1e−6；两种材质中心差分别约.287/.196px，宽高差至多1px，符合已有阈值。未把这些球面残差全部解释为椭球，也不以形状阈值通过声称逐像素完全一致。

MLT 1.3.0真实INT64/UINT64解码把80n、12n、1n保留为BigInt，样式表达式的数值类型检查原把它们当ObjectType：真实Worker半径5、stroke0、分类false、state更新后仍5；MVT同数据应80/12/true/85。修复只在filter/layout/paint求值入口提供顶层safe整数的copy-on-write Number视图，WeakMap只缓存不可变properties而不缓存后续会赋geometry的Feature。raw properties、ID、unsafe BigInt及拾取值保持原样。常量属性/无binder路径不扫描；真实合法null/缺省feature维持原表达式默认行为，没有改旧测试fixture。修后真实Worker与MVT输出一致，主线程feature-state更新85也正确。三个生产文件、两个有效同级回归，4文件37测试、scoped ESLint与全tsc通过；未直接修上游依赖，也未冒称MLT专用GPU图像已验收。

南北极冠正式回归 `audit-polar-raster-qualified-basis/` 双方ROI10000/10000、positionError0、directionError约1.12e−16/up0。南向近垂直Camera.setView会经过ENU heading/pitch/roll提取，并在EPSILON3条件下把roll置0，原造成direction/up约.00115076的资格误差；fixture改为公开lookAtTransform(IDENTITY)后复制position/direction/up/right，没有改容差、私有缓存或生产渲染。curve wall正式before/after冻结同一生产检查点，只替换surface-subdivision；before真实wall row172.5黑色、参考绿色，after真实roof/wall内部行及720行剖面全部匹配。独立模型提示Map GLOBE_RADIUS导致3080m高度映射到WGS坐标约3083.446m，front top边预测差.2364px、base差.2290px；并未据此宣称解释全部98个全图边界差。

本批实施检查点：全仓ESLint→全tsc、73文件399CPU/真实Worker测试通过（19.56s），库/Worker/声明与演示构建通过。硬件production Native整合30项中28项通过，另外2项viewport light因同一“旋转后必须所有tile仍live”观察假设中止；trace显示4个旧owner所有VA/Material/sampler保持身份，2个按覆盖退出。修正成非空retained owners资源身份检查后，这2项也通过（23s），并保留实际lightRevision和map/viewport颜色oracle。没有修改生产或放宽画面阈值。证据 `audit-circle-pole-wall-extrusion-mlt-integration/` 及 `audit-extrusion-light-retained-coverage/`；合计30项通过，不称原一次运行30全绿。GPU包含新pole/wall、circle共享差分、建筑首次/live/极限/实际球面、pattern高zoom、rounded/light，以及raster once-mix/retirement/partial和公开source/icon交接；仍未通过的wall条纹9像素没有归入这些通过项。

只读测试审查完整阅读23个同级测试和2个helper。399项检查点通过之后，合并planar-fill相同Shanghai薄面的两个用例，保留内部/外部包含、反向边、重复chunk和字面fractional crossing全部有效断言；删除同一water矩形的单独重复用例，保留多chunk版及真实bucket seam/transfer回归。移除worker-fill-outlines helper中没有调用方消费的backing/byte/transfer统计，真实structuredClone transfer和生产输出断言保留。未按数量删除scene发布竞争、合法空布局退休、circle/extrusion旧代paint、墙面多轴切点或实际frustum/GPU资格；这些覆盖不同真实错误。

追加全读6个vector/residency辅助文件及planar-fill算法，覆盖台账236生产文件、175完整、6局部、55未读，哈希仅更新实际复读范围。CLAMP路径另登记可避免工作：markDrapedCollections任一集合变化就remove+mark所有region，Native VectorProvider登记无关region dirty，GlobeSurfaceTileProvider随后释放vectorData并重生成网格/纹理。最长同序prefix+仅变化suffix可满足当前Native预发现及隐藏恢复生命周期；默认NONE不经过该路径，尚无完整场景占比或FPS证据，先不打断以下错绘修复。

新的高收益确认缺陷：FillBucket的细分/clip mesh不具有外环顺序，holes也被设为[]；该数据直接交给BufferPolygonCollection。实际Native VectorPipeline.packPolygonRings只读连续ring和holes、不读triangles，因此CLAMP source13矩形部分内部漏填，带洞矩形会误填洞内。真实Parser FillBucket→VectorTileRenderer.begin/advance/commit→exact Native BufferPolygonCollection→Native pack coverage，source17内部baseline正确；source13 [2600,2800]应true却false；同级新增draped-fill-topology两项实际红（1.40s），source/stylezoom分离、UV由真实ECEF投影且v朝北，没有拿顶点数量当coverage。图案/非贴地网格仍需曲面三角细分，必须分开draw mesh与terrain ring；当前正在设计实施及硬件资格，尚未修复。MLT专用浏览器Worker/GPU也正在补强，以上CPU检查点不包括这两个后新增的贴地红测试。

### MLT浏览器红→绿与CLAMP拓扑实施（2026-10-14）

MLT专用硬件production Native回归已取得合格红→绿，`audit-mlt-numeric-gpu-{before,after}/`。同literal MVT Number既作Native控制也作Map参考；实际浏览器Worker传输source canonical14/8192/8192、ID100、640×720、pitch60/FOV45、实际位置误差4.15e−9m、stylezoom差1.32e−7、真实circle draw及20个就绪帧均有资格。before先采齐MVT/MLT initial/state四组再断言：MVT控制通过，MLT原始属性80n/12n/1n保留，但green30.7098px而参考10004.8863px、blue/red均0，state后仍不变。after四组全部通过，MLT/参考green初始10004.8863、更新11320.2824；blue3292.4863→3491.4、red分类20.1098，宽高一致、无refetch、原始传输属性仍BigInt。为避免并发贴地实施污染A/B，冻结236生产文件，两个snapshot仅MLT三文件不同，其余保持前检查点；不是拿前后两份移动工作区直接比较。

最初Node直接加载MLT published dist的extensionless imports失败，未进入浏览器，已作为fixture平台问题排除；正式encoder改由Vite浏览器模块执行，把真实MLT bytes交route，无依赖改动或extension兼容拦截。实际linked-program识别使用GLSL结构标记并容忍minified空白，不依赖文本排版。fixture禁用公开atmosphere/sky/fog，whole-frame RGB oracle没有混入天色。

CLAMP拓扑四文件已实施：clipPlanarFill显式返回closedouter/holes/components，CLAMP按bucket/canonical缓存一次恢复；独立components保留feature lineage。Native exact BufferPolygonCollection接收闭环位置及hole offsets、triangles为空，避免复制细分索引；Worker mesh保持原值，nonclamped/pattern继续curved path。原2项Native coverage红→绿，另增加真实forced parser chunks及clip后分离components；6关联文件37CPU回归、scoped ESLint→全tsc通过。未声称冷同步O(source triangles)已有整体性能收益，极冠/3DTiles仍待GPU。

首次drape GPU控制未合格：Native drapeReady/loaded为true、referenceFrames0，实际Map已画green；classifier未识别真实minified fill program，已改实际vertex/fragment main标记并保留program诊断。原13物理大矩形还跨source14四child，即使granularity1也触发clip，不能以canonical≥14声称控制没有拓扑错误。fixture改为13local[4608..5632]外环、[4864..5376]hole，同实际camera、高控制14/8193/8193强验inside/holes1；低控制仍13。此轮不列为生产红/绿。

修订的high控制已具备实际GLOBE1、精确pose、terrain texture与draw资格，original及Native holes1、无outside；但Native全图green0、参考7432，四个内部25px patch全black，而hole正确black。真实Native vectorData rings/4纹理全部生成并被terrain draw消费，因此发现独立合成路径问题：style BackgroundGround的OPAQUE全屏ground-depth层可能覆盖此前GLOBE pass的draped颜色。证据 `audit-draped-fill-topology-qualified-before/`；正在无background消融及实际command前后像素取证，尚未据静态Pass顺序直接宣称根因或GPU拓扑验收。当前覆盖236生产文件、177完整、6局部、53未读。

### 贴地背景覆盖的GPU根因与优先级（2026-10-14）

后续合格硬件消融 `draped-fill-background-{before,after}/` 已区分两个独立缺陷。before高来源无background：Native green7248、参考7432，四个绿色内部patch各25正确、洞内25黑色正确；before低来源无background：Native4927，西北/西南内部漏填且孔洞错误绿色。仅替换四个拓扑生产文件后，低来源无background也达到7248，全部内部及孔洞patch恢复正确。该结果验证拓扑修复，不表示完整silhouette逐像素一致；两种地球/地形模型的独立投影采样中心仍有约2.14px差，不能据此解释全部184个覆盖差或扩大阈值。

高来源保留background时，在实际command.draw目标framebuffer2读取主RGBA texture，terrain draw后green7248，BackgroundGround draw前仍7248、draw后0，最终四个内部patch全黑。readback使用实际command.framebuffer或passState.framebuffer并恢复GL读取状态，不再用默认framebuffer推断。Native surface接收真实vectorData/四纹理，Map实际GLOBE1、pose/stylezoom合格，无page/render errors。故背景覆盖是已复现的生产合成缺陷，当前拓扑修复后的正式有背景drape回归仍红。

不能通过取消背景、修改全局Globe.baseColor或固定黑色背景绕过。正在验证每owner连续贴地图层批次独立provider/lookup、复用Native实际surface几何和官方shader生成、以透明底色输出覆盖色，再纳入样式顺序的方案；terrain、外部模型遮挡、透明3D Tiles和owner资源生命周期需分别验证。原型只用于回答工程接口及成本问题，不算生产修复，也不声明三维验收。

此检查点全仓ESLint→全tsc、74文件401CPU/真实Worker回归通过（15.83s），库/Worker/声明和演示构建通过。包含拓扑四文件与两处测试简化，不包含随后文字/名称字典的实施。追加完整阅读文字shaping/bidi/tagged-string/script-detection/quads/transform-text/arabic-shaping七文件，当前覆盖236生产文件、184完整、6局部、46待查。

文字生产输出另确认三个独立缺陷：반포대로21길、国道A号中的短数字/Latin未按Map竖排规则旋转，改变glyph quad与碰撞包围范围（长ISHIKAWA串为保持横排的控制）；AB\r\nCD被排成三行而非两行；窄行宽下文+组合重音被拆到不同两行。已有实际shapeText/getGlyphQuads字面输出及上游对照，真实font/atlas/GPU影响仍需进一步资格。正在先保留这些实际失败再实施，不盲目照搬上游对combining cluster内部section style的合并行为。TaggedString重复码点遍历的O(N²)候选尚未取得City完整场景占比，不作为当前主要性能成果。

### 文字正式硬件验收与组合字素的剩余后端缺口

shaping/bidi/tagged-string三文件已修：竖排短code与数字run规则按字素判别、实际quad方向正确；CRLF不在中间产生段落边界；换行只在完整字素后候选，仍按每码点保留项目已有独立font/scale。四项真实布局/quad回归先红，修后关联14项绿。真实硬件production Native，固定236生产文件的A/B仅这三文件不同，`text-shaping-{before,after}/`；实际TinySDF Latin字母生成标准PBF、两引擎正常glyph request/parser/atlas/Worker链，CJK仍相同浏览器local font，没有mock quad或shader。

国道A号的horizontal控制mask difference .000656；竖排bearing90修前.673910、修后.000318，pitch60修前.651210、修后.000137；长ISHIKAWA串控制两版本均0。CRLF point两个姿态修前.937594/.934450、修后两项0。实际pose/stylezoom/FOV/视口与已绘制Map label资格通过。初版point探针误传嵌套coordinates、双引擎均空，已排除；合法Point重跑才作为上述生产红。正式`line-text-zoom.spec.ts`三个硬件production回归均绿（41.6s），含原近地缩放/双向CJK旋转及新六组混排/CRLF，`audit-text-shaping-formal-hardware/`。重复相机/完整mask检查集中到同一helper，静态Latin PBF子集有字体生成说明；新混排/CRLF的mask阈值为.01，原CJK阈值.1保持。该用例已在精简时移除。

组合字素断行CPU回归已绿，但真实文+组合重音的GPU仍约.0861 mask difference，不能按已有CJK .1阈值宣称已验收。最新Map GlyphManager会为整个grapheme调用TinySDF，浏览器排版把mark与base作为一体；项目glyph dependency/atlas仍按numeric codepoint，逐字绘制。已进一步确认这是独立字体链能力缺口，后续需在统一字体/格式契约下实现，而不能删除组合mark或照搬上游合并掉不同section样式。当前正式新测试仅验收已有红→绿的短run/CRLF，未把该残差写成通过。

### 合法样式名称与上游diff的无效重建

合法constructor/__proto__名称修复覆盖九个实际生产字典：Style source/layer/更新及序列化、StyleLayerIndex families、Worker source、Parser buckets、Tile buckets、反序列化与programConfigurations、overzoom source-layer。使用明确的无原型名称字典、own source entries/fromEntries；不重命名用户ID、不新增保留词兼容分支。TransferRegistry将无原型plain dictionary纳入已有Object codec，现有安全own键wire/原位decode及typed-buffer传输格式保持。真实双向structuredClone→Style/Dispatcher/Worker/Parser/Tile、MVT共享family/overzoom、remove后同ID fresh cache均有修前红及修后绿，`legal-style-names-before/`包含分阶段及最终冻结两项红。scoped ESLint→全tsc→20 suites/100 tests绿；不将这些CPU结果当浏览器渲染验收。

额外真实Style.setState确认上游style-spec26.4.4的diff也有同类问题：完全相同constructor来源样式输出removeLayer/addLayer；__proto__背景仅改color也输出重建。TilesetRenderer真实消费者将其当relayout，冻结paint、清publication、淘汰retired并重建track。直接固定补丁修上游三处名称字典（src/diff.ts及实际ESM/CJS发行入口），pnpm-workspace记录patch，未新增本库diff副本或ID映射。现有style-state-change合并一个公共契约回归，检查不变样式undefined、仅setPaintProperty及source/layer身份和实际blue求值；eslint→全tsc→3文件20CPU回归通过。库与Worker构建设置alwaysBundle非Cesium依赖，仍需最终发布构建验证补丁实际进入产物。

### 符号segment及后续高收益发现

完整阅读SymbolBucket及attributes、SymbolStyleLayer/生成属性与生成器、variable anchor/overlap等，新增确认普通两个可重叠feature、不同symbol-sort-key即可产生第二segment。Worker triangle及placed.vertexStartIndex为segment local；Native提取却作为global，第二个point标签重复第一个geometry，沿线还错误读取其UV/paint。只修改symbol-geometry按真实segment offsets处理索引及每placed record范围，保留Worker合同。point/line两项真实populate→performSymbolLayout→symbolBucketGeometry先红→绿，再验证同key容量切段、horizontal/vertical跨段；6文件54CPU回归绿。最终全tsc正在等待并行贴地接口收尾，不能将早先tsc绿写成当前全仓绿。硬件浏览器两标签A/B正在进行。

其余已证明静态消费者缺口尚未修复：variable-anchor/offset数据未被placement读取，多行多个justify同时画；point仅vertical writing-mode仍走固定horizontal；viewport-y没有按物理camera方向排序；symbol-height-offset/anchor有生成属性但没有实际height求值/传输/Native位置消费。各需独立行为红及GPU资格，不由shaping级绿或旧CJK测试替代。mergeLines concat及TaggedString重复遍历等局部性能候选继续后置，未取得完整场景占比。

贴地原型`draped-run-prototype/results/`三项硬件用例通过，使用官方GlobeSurfaceShaderSet、真实terrain VA及私有VectorProvider，global owner0；高/低来源有background均Native7248/参考7432、五个25px patches正确；半透明红background.5/greenfill.5输出[64,128,0]、孔洞[128,0,0]，与Map一致。稳定帧无新lookup/command/rebake，单实际相交tile产生一个overlay。最初spread Native surface丢renderedMesh getter造成原型异常，已按确切Native合同修；并行字典中间态曾阻断传输，正式A/B改固定全生产检查点隔离。这些不是新的生产红。原型仍未覆盖3D Tiles、外部遮挡、多owner；正式按owner及样式批次接入正在实施，尚未将有background正式drape回归标绿。


### 两个标签的正式GPU红→绿及新的相机、HTTP缺陷

符号segment硬件production Native回归已完成，`audit-symbol-segment-gpu-{before,after}/`。固定236生产文件的两份检查点，仅symbol-geometry不同，其余包含最终文字与合法名称修复。两个真实Worker label、8顶点、segment offsets[0,4]、正常PBF/font atlas、相同物理相机及样式zoom均已资格。修前point/倾斜point/line/倾斜line四组全掩码差分别.587659/.584559/.808905/.783385，实际Native只画A，Map画A及B；采齐四组后断言失败。修后一项正式四组回归通过（17.2s）：point差.000092、中心差.000497px，另外三组mask及中心差均0。这个结果替代上节“正在进行”，没有扩大.01阈值。

另完整审查symbol-renderer/placement/pass与shared atlas，真实公共Cesium矩阵已复现高zoom倾斜视图误判。WGS84锚点0/0、640×720/FOV45/pitch60、zoom21对应focus distance32.437847523m，焦点向北实际.099330562m后，独立投影移动1.334235px；sameViewProjection却返回true。原按ECEF MVP元素1e-5相对误差，巨大translation把实际变化淹没，实时line投影和selected collision filter会跳过更新。正在最小接缝修复并验证静止及clip-Z-only控制，最终framebuffer资格仍待完成。

HTTP304也已有生产链CPU红：Vitest/jsdom的网络边界返回真实Response(status:304)，实际Request构造、Scheduler→双向structuredClone TileWorker/Parser→TilePyramid，先200发布MVT，再expired并round-robin另一Worker，If-None-Match和304响应后旧tile.isRenderable(false)变为false。此项不是HTTP server或浏览器Worker/GPU验收；未stub getArrayBuffer、Source或Parser。早先200响应相同etag回归没有覆盖HTTP状态304；不能根据文档“304已处理”验收。正在显式notModified响应与已发布数据资格合同中修复，首次无旧数据304仍应错误。

新源码覆盖为237生产TS文件、235完整阅读审查、2局部（生成数组与新增贴地合成）；各哈希保留真正审阅版本，实施中的文件将在最终复核后更新。完整阅读本身不作无缺陷结论。符号text/icon translate绘制与碰撞均没有消费也已确认，需单独GPU回归；局部concat、包装、命名与微优化继续排在这些实际错绘后。


正式贴地接入首次硬件运行 `audit-draped-formal-background-alpha/` 的高/低来源不透明background两组均恢复Native7248/参考7432，内部及hole五个25px patch全部正确、真实private provider→texture→terrain VA draw资格通过。半透明公开red background.5/greenfill.5仍红：Nativefill[0,128,0]、holeblack，而参考[64,128,0]/[128,0,0]。追加实际target framebuffer诊断 `audit-draped-alpha-diagnostic/` 证明background command的depthTest被改为true，background draw前后仍全black，后续drape才画green128。

确定根因为DrawCommands.surfaceState的输出state反向缓存：Native RenderState canonical cache让私有slot的overlay(false-depth)与BackgroundGround原始false-depth成为同一对象，反向登记覆盖角色，后续BG取到true-depth ground state。原型没有经过这次相同slot prepare/state别名，所以其alpha绿不能代替正式接入。正在保存command原始深度状态并修缓存边界；新增两fill之间插入背景的顺序oracle，仍不改变RGB阈值、Globe.baseColor或blend语义。

符号translate另已取得真实GPU红 `symbol-translate-before/`：固定236生产检查点（含已修复segment/文字/名称），真实PBF文本及公开addImage的RGBA图标，CV/pitch60/bearing90/627×710/FOV36.875112943、物理相机与样式zoom资格通过。两种零translate控制的全mask及中心差均0。公开setStyle只改[30,0]及viewport anchor，text中心差29.971214px/mask1，icon30px/mask.967681；map anchor分别14.624884/14.640475px。双方实际Map label1、完整ink、资源与加载无错误。当前Native仍原位置，正在先调查统一draw/collision/live paint合同。公开纯paint后的owner/VA/material/sampler联合身份也变化，已保存观察，但尚未归因、未宣称四者都重建。首次脚本在最后联合身份断言失败之前已保存六组所有实际像素；画面资格独立于此身份检查。


304六生产文件及一个已有CPU测试已修，scoped ESLint→全tsc→16 suites/71 tests通过。综合同一生产链行为覆盖200→跨Worker304保留bucket/index/expiry且不重新发布、公开layout变更由原decoded owner重parse且无新fetch、合法empty内容→304、首次cold304错误→fresh200 retry，以及pending clearTiles取消/晚响应不能复活、旧owner remove后reload拒绝。源加载request明确区分active request channel与已发布decoded owner channel，正常新payload才切换owner，不复制旧payload到另一Worker、不引入兼容路径。四份独立red日志保留http-304-before。资格仍为受控真实Response的CPU链；正在另补本地HTTP server与未stub fetch的运输层probe，不能据当前CPU绿声称浏览器或真实服务器请求已验。


### 正式地形半透明/层序通过与真实HTTP运输资格

DrawCommands缓存别名修复已取得真实Native RenderState CPU红→绿；移除输出state反向登记，每entry保存原始和上次prepared state，producer的新blend/state仍被消费，没有背景类别特判。6文件21相关CPU、eslint及全tsc通过。正式硬件production回归 `audit-draped-formal-alpha-order-after/` 一项四组全部通过（16.4s）：高/低来源不透明background、red background.5/greenfill.5、两fill之间插入red background.5。每组全部五个25px patch均与Map匹配；最后组fill[80,32,128]、hole[192,0,0]，两个private provider lookup均被真实terrain draw消费。全图内部目标RGB计数Native7248/参考7432保持，仍没有以此接受全silhouette差。

两个tileset共场景叠加、一个移除后另一个保留纹理/地形VA、最后owner恢复scene hooks的正式GPU验证正在补强。扩展fixture时最初读取了不存在的bucket.type，并混淆Worker完整Bucket与主线程精简runtime Bucket，导致观察器自身抛错停止渲染；这些失败已排除，不作为生产红。观察器已改为实际data/bucket-runtime.FillBucket且按drawBatch.layerId匹配原Worker数据，未改生产迎合观察错误。

304独立真实运输probe `audit-http-304-node-transport/result.json` 已通过：本地Node HTTP server、未stub Node fetch、生产Scheduler/Dispatcher/TileWorker/Parser/TilePyramid，EventTarget worker endpoint仍不是浏览器Worker/GPU。首次42字节MVT/200、ETag server-v1；服务器实际收到matching If-None-Match并返回0字节304。ETag、max-age60→120及Expires均通过Worker通道，notModified没有replacement body。原bucket、FeatureIndex和decoded owner保持、仍renderable，parse1→1、tile数据event0、expiry增加60029ms。全局/每服务器一槽，两个请求期间各1，完成都0；无失败或取消，服务器已关闭。原71项受控网络CPU链与本探针的资格分开记录。

生成数组15底层layout的全824行、生成器436行及struct-array/attrs/transfer入口已全文审查，未发现当前布局/stride/codec错配；未执行生成，不能称字节复现已验。旧237生产文件均有完整阅读版本，新实施的symbol-translation正在审阅，台账为238文件/237完整/1待查，变更中的symbol哈希将以最终复核更新。超密bucket placed-symbol Int16溢出仅静态容量候选，无真实Worker红及场景占比，继续低优先。GeoJSON data/video urls的样式目录解析经README公开限制和Map最新源码核对，不是现有合同回归，登记后置能力扩展。


### 双贴地owner生命周期/拾取及符号平移CV硬件验收

正式production Native硬件 `audit-draped-six-textures-picking/` 两项通过（21.5s）：原四组背景/alpha/层序不变；两个实际tileset叠加fill[32,64,128]，移除upper后fill[64,128,0]。公共Scene.pick与tileset.pick确认绿色内部均返回upper-fill，移除后返回fill及marker原属性；孔洞不命中。最后一个owner移除时共12个真实私有texture已destroy，借用Native terrain VA仍live，scene hooks回到确切原函数。读取Native打包器发现polygon仍生成widthTexture，已将其纳入私有资源字节计数及完整六类texture观察；未以此前仅四/五类texture观察声称完整释放。ESLint→全tsc及两相关CPU文件6tests通过，不作为FPS证据。

符号translate八生产文件已实施，新增48行统一输入/地面投影模块。CPU真实Worker点box对独立blocker及沿线路径51.83655px错位红→绿，保留MapLibre故意使用原worker-anchor的CPU透视尺度。纯translate更新复用resident paint，held代冻结旧paint输入并以当前zoom/bearing求值，不新增顶点attribute或draw。scoped ESLint→全tsc→5相关文件48tests通过。固定236旧生产检查点再仅替换该八文件，`symbol-translate-after/result.json`：真实CV/pitch60/bearing90的text/icon各零、viewport[30,0]、viewport[0,30]、map[30,0]共8组通过；最大中心差0.000199971px、mask .000020168，其余均0。此前viewport-Y约15.34px错位、viewport-X约30px错位均消除；原primitive/VA/material/sampler联合身份全部保持。实际三维globe、高低zoom、GPU碰撞及日期线仍需资格，不将CV近似画面作为这些场景通过。

RequestPerformance同URL并发另有真实Node Performance API红：第一个finish清除了另一个请求的同名start，第二个SyntaxError且end mark遗留。实际单Worker的Style→Scheduler→TileWorker→Parser→TilePyramid三合法canonical tile共用URL的受控运输链得到loaded/errored/errored；冻结before插件日志 `request-timing-before/worker-single-realm-red.log`。修后实例仅保留numeric开始时间，fallback用独有measure名/数值区间并立即清理自己的measure；公开name/JSON保持URL，真实resource entry分支不碰无关measure。三tile均renderable、500失败及挂起cancel无timeline遗留。5 suites27CPU tests、ESLint→全tsc通过；Node结果 `audit-request-timing-{red,green}/result.json`，尚未声称浏览器/GPU验收。

新增symbol模块已全文审查，生产台账238/238保留精确审阅hash；完整阅读仍不代表缺陷已全部修复。正在当前固定238文件检查点进行CV真实City line/dash屏外提交候选的只读观察，禁止把带诊断的耗时作公平性能A/B。


### 日期线平移、外部模型遮挡与当前集成检查点

日期线及MAX纬度的连续plane三生产文件已修：非零输入携带original Mercator anchor+metres与ECEF；CV投影保留原worldcopy及clamp外Y，普通零translate与2D unwrap保持；sphere line occlusion改查translatedworld，CPU font perspective仍取original anchor。四项真实Worker/Cesium Camera/GeometryPipeline/MapCollision行为先红→绿，用Native实际styleZoom，CV与Map差8.54e-8；最终6文件66CPU绿。硬件固定238检查点，仅三生产文件不同，`symbol-date-line-{before,after}/result.json`；near+180的默认never-overlap图标，control双area1024.125/mask0，map80修前Native0/Map1024.125，修后双1024.125/mask0、旧primitive/VA/material/sampler均保留。此硬件pose误差1.4e-5m、direction1e-14、ground anchor误差6.4e-6px，但styleZoom差1.79e-6略超过既有1e-6资格；不将其写成全部严格pose资格通过，强CPU资格与实际漏绘红分别记录。

真正原生opaque Box在同physicalcamera下的单独控制：隐藏tileset→magenta2519，开启背景+贴地fill→0，再隐藏→2519。`draped-foreign-model/result.json`三实际capture完整；初版deepEqual两个全mask失败输出巨量断言使探针SIG9，已改只报scalar差，不是额外生产故障。temp candidate只改BackgroundGround，将packed globe depth原值写gl_FragDepth并启用LESS_OR_EQUAL；`draped-foreign-model-candidate/`三capture silhouette逐pixel相同2519。Native PassThroughDepth/LOG_DEPTH_READ_ONLY与同frustum普通及log-buffer合同核对后，两行正式实施。没有改变depthMask、PMA blend、Globe.baseColor或样式切断policy。正式hardware `audit-draped-formal-depth-model-picking/`3tests全绿52.9s，包括原四组半透明/插入背景层序、双owner释放/真实Scene.pick、foreign primitive普通及log深度两组完整mask。透明外部模型、3D Tiles及含own extrusion后的后置ground overlay仍未验收。

符号沿线新正式回归最初exact90红，并未删除该证据。实际production Native与Map minbundle observer记录first/last：90 control Native screen dx=-5.78e-11px而Map clip dx=+3.96e-9（像素差约1.24e-6），strict keep-upright相反，glyph方向改变产生约46px。viewportX30两端clipX均有真实非零负斜率、同时flip后mask0；其他两平移仍在近零边界。89/91各四组非零margin controls全过（最大mask .00037746/center .0016201px），`symbol-orientation-boundary/result.json`保留全部12组、实际二端判定与原始截图。没有增加epsilon猜补，也未把off-axis透视下正确flip称上游错误。正式translation沿线选择有实际非零margin的89度，point/icon仍90；exact90作为独立未解决数值边界保留，不能称所有姿态通过。

当前库/Worker/min/dts及演示构建均通过；全suite首轮76文件427tests中424绿、三tile-residency失败来自旧fake half缺translationOffset。仅补测试夹具合法零输入和Cartesian2偏移，生产不加兼容defensive branch；ESLint→全tsc→该文件5tests绿，76文件的成功由两轮相关证据构成，不称新一轮全套一次全绿。真实可变锚点另确认Worker输出未被消费：dense双point ABC/DEF Map可放2而Native1，多行justify-auto Map可见8三角形而Native16；已先真实Worker/MapPlacement/Cesium Camera红，开始授权实施，不能把上述旧427检查点当该后续改动通过。

### 符号平移正式回归、发布语义与真实球面资格

`audit-symbol-translate-formal-stable-orientation/` 正式硬件 production Native 回归一项通过（1.5m）：point text、viewport icon 均 bearing90，along-line bearing89，全部 pitch60；每种零平移、viewportX30、viewportY30、mapX30，共12组。原相机、zoom、完整 mask、宽高及资源身份断言保持；沿线角度选择依据是上节独立记录的89/91非零判定 margin，exact90仍未解决，不能将本项写成全姿态通过。原近地、CJK方向、混排/CRLF和两标签回归尚未在后续variable-anchor改动后集成复跑。

冻结238生产文件、含日期线及背景depth修复、尚未variable-anchor的完整五项符号正式硬件回归，`audit-symbol-pre-variable-integration/`，全部通过（3.4m）：近地quad、双向CJK、混排/CRLF、排序键segments及12组paint平移。此检查点与后续可变锚点版本分开，不能继承为该改动后通过。

发布产物语义另在真实浏览器通过，`published-style-contract-probe/result.json`：已构建的 `dist/index.mjs`/`worker.mjs` 和 min 版本，均使用实际默认三个浏览器Worker；公开创建合法constructor GeoJSON来源、__proto__背景，whenReady、相同样式setStyle、仅blue颜色setStyle及destroy。实际LD请求/回复和metadata/content事件完整，来源与layer/style身份保持，paint变化无额外LD；所有六个Worker终止，来源移除，错误为空。没有Viewer、Scene或WebGL，不能当渲染或tilesLoaded验收；未render的Style.loaded仍false。原始dist文件hash与Vite实际HTTP响应hash分别记录，HTTP转换后字节不是原始发行文件字节。

真实SCENE3D、实际Map linked GLOBE=1/transition=1的低zoom0图标在 `symbol-globe-translate-after-extremes/result.json` 三组零/viewportY30/mapX30均有实际Worker、draw、ink、硬件、同physical pose及实际styleZoom资格，全mask与中心差均0。球面zoom14的map-pitched point AB在 `symbol-globe-translate-after/result.json` 三组同样严格资格，但mask差 .139493/.076381/.124858，中心差 .165965/.106592/.141624px，未接受。独立相同PBF字形与WGS84/sphere投影模型 `symbol-globe-city-text-cpu-model.json` 解释约.274px最大角点差，Native零平移CPU模型与实际mask差.001117；单独椭球差模型仅解释部分实际残差，Map实际GPU float32与平移后Native仍需闭环。沿线pitch75同physical pose的残差也未验收。

强制球面zoom25在来源0及22均出现参考symbol draw/label/ink为0，资格失败，不能用空参考图验证Native；automatic高zoom控制首次相机转换随后触发covering RangeError，尚未核实临时fixture的物理相机，亦未据此登记生产缺陷。高zoom对照继续先验证真实transform、TileManager及可见opacity再解释像素。

CV City line/dash四side-plane只读观察记录5978个候选实际draw/68 owners，stationary/pan/orbit约8.71%/6.61%/5.69% Native draw，但triangle占比约.864%/.700%/.657%。没有这些draw的独立CPU/GPU成本或公平A/B，不能报FPS收益；与明显variable-anchor漏放/重复绘制相比先后置。原探针的motion loaded筛选导致phase断言失败，实际所有帧draw及错误记录已保存；不能把有诊断的探针时间当无诊断性能测量。

### 可变锚点的真实GPU修前证据

`variable-anchor-gpu-before/result.json` 已采齐四组 hardware production Native，固定238生产文件及所有实际loaded hashes。同真实GeoJSON Worker、Latin PBF、CV bearing0/pitch60、实际styleZoom14及physical pose/FOV/viewport资格；各组双方都有实际symbol draw、非空完整ink，错误为空。Dense ABC/DEF在同一Point：关闭variable时Native/Map area248.329/248.349且各放1；开启left/right及radial.5时Native仍248.329、Map492.376，实际放置1/2。单Point多行ABC换行A：关闭variable时双方area322.411完全一致；开启时Native469.427、Map322.584。此项补足CPU两个红的实际map-pitched GPU证据，修后尚未运行；观察器仅记录draw、opacity/placement与pixels，未替换生产布局或放宽mask阈值。

自动投影zoom25的临时相机单位及render-phase校准已修正，`symbol-globe-translate-after-auto-qualified/result.json` 实测Native WC[.216487887,-2.474467829,0]、Map归一化Mercator转Native长度[.216487883,-2.474467828,0]，direction/up误差约1e-16，styleZoom25.0000000002/25，参考确实linked非globe/transition0、实际bucket opacity可见且有draw。覆盖Set overflow仍在before-frame状态已出现，可能早于该最终85度姿态；继续记录初始化帧与实际LOD/culling，不能把最终pose资格反推为异常触发帧资格。

### 高zoom相机交接的覆盖爆量根因已确认

先排除了临时相机单位及Map自动projection未完成的混用；Native `preRender` 先于当前 `updateFrameState`，该事件里旧culling并非生产错误。真实公共Camera及正确freshculling的独立CPU控制 `automatic-high-covering-diagnosis/result.json` 中，nadir仅341次visibility/4tiles，pitch85也341次/46tiles；默认及临时near/far均不会指数爆量。此控制没有经历cached视角交接，不能代替它验收。

生产覆盖入口观察 `symbol-globe-translate-after-auto-covering-failure-frame/result.json` 抓到实际失败frame43：当前p85正确位置/方向、fresh p85 culling、current LOD variable=true，但deferred/confirmed均true；cached nadir LOD variable=false、恒定source zoom25。现代码 `confirmed ? cached.lod : lod` 用旧俯视LOD配当前地平线frustum，对上一Globe的90度授权区域按22级细分。诊断在20000可见性调用后停止，避免再次耗尽资源；这个阈值仅在临时观察器，不进入生产，也不作修复。最初无生产observer的Set maximum size exceeded仍保留，观察器版本另记录实际loaded hash及diagnostic标记。

CPU公共Camera生命周期再闭环 `automatic-high-covering-diagnosis/cached-nadir-current-tilt.json`：相同四个真实terrain rectangles，nadir覆盖→postRender→p85及freshculling，冻结生产经过cached支路在20001次中断，已有14170个22级eligible节点、desired均25；同p85/同terrain的fresh covering仅320次/44tiles。由此已登记真实缓存交接缺陷，正在验证保留已确认IDs到postRender的最小修复及连续相机/唤醒合同，不再将其作为未资格的fixture猜测。


### 高收益两项修复的隔离硬件结果与独立复查

高 zoom cached covering 已修复：deferred 更新保留确认过的 primary IDs，postRender 用本帧实际相机及完成后的 terrain 重算 pending pyramid；不再组合旧俯视 LOD 和当前倾斜 frustum。连续倾斜及恒定 zoom 平移的独立 CPU 控制证明，仅保留 IDs 而不刷新会停在旧覆盖，故未采用该中间候选。最终同一 covering 算法在 postRender 刷新，IDs 变化时唤醒；请求与发布仍在正常 update。没有生产节点上限或额外 frustum 近似。

固定238文件，仅 scene-tile-covering.ts 不同的 hardware A/B，修后 `symbol-globe-translate-after-auto-covering-fixed/result.json` 三组 control/viewportY30/mapX30 全通过：actual automatic Map projection 为 Mercator，Native CV，zoom25/pitch85/bearing90/source22，双方真实 Worker、draw、完整 icon；mask 和中心差均0，资源身份保持，错误为空。物理位置误差4.17e-9m、方向/up约3.7e-16、实际 zoom 差2.09e-10，FOV/viewport一致。原 Set maximum size exceeded 已消除；没有将这项内存/正确性修复声称为 FPS 测量。

可变锚点五生产文件消费 Worker 候选及 justification 范围，选择后仅绘制对应 shaping，并更新真实动态位移/保守 bounds；完整238文件隔离仅该五文件不同。`variable-anchor-gpu-after/result.json` 四组严格硬件资格通过：dense-on 两端实际放2，mask从 .960473 降至 .000207074、中心差 .002154px；multiline-on 只绘制一个 justification，mask从 .952164 降至 .000170171、中心差从43.636px降至 .002989px。两个关闭 variable 的控制保持原结果。原大小、相机及 mask 阈值没有放宽。

当前六生产文件合并检查点在 ESLint→完整类型检查后，完整 Vitest 一次76文件442项通过（17.49s）；两项修复的最终正式硬件集成尚未完成。独立全文复查又找到可变锚点两个真实分支风险：预算内 selected-only filter 切 anchor 后 opacity 已发布而 dynamic 仍旧，固定 justify 的同 mask 分支也受影响；fitted optional icon 的预检错误使用 never，阻挡允许 overlap 的文字。已优先授权 CPU 红与修复；前述四组静态 GPU 通过不能覆盖这两项，也不作为该后续改动的验收。


新增正式硬件回归 `audit-variable-anchor-formal-initial/` 一项通过（34.2s）。复用原 line-writing-mode 的公共相机 API 与 2000m ground distance，实际 zoom15.34683436、source13、pitch60，627×710/FOV保持；dense-off/on 与 multiline-off/on 四组完整 glyph mask 均0差，真实PBF由两端同一运输响应提供。相机/样式 zoom/宽高/非空完整 ink 与原 .01 掩码阈值均保持。该检查点冻结可变锚点和 covering 六生产文件，尚未包含独立复查的两个分支修复。保留一项代表正式回归，临时观察器作为红/绿证据归档；没有把静态四组扩充为无意义参数矩阵。


可变锚点独立复查的两项后续已逐项真实 CPU 红→绿：实际 Worker 固定 center justify，zoom14完成 left+30选择，缩至真实zoom13后官方 MapPlacement 选择 right；新完整 pass 预算耗尽尚未完成时，相同 opacity mask 的实际 owner dynamic 原仍+30，修后−30且 GPU dirty。候选发布后 variable 路径同步动态，普通路径不增加这次调用。另真实 Worker text always/icon never/optional fit both/padding60 撞已有真实box，Map text=true/icon=false，旧 Native 连文字也false；候选预检改用当前 text trial mode，最终 icon 自身碰撞模式及 optional 合并保持。仅 renderer/placement 与既有 collision test 三文件修改；scoped ESLint→完整 tsc→3 suites60 tests通过。修前两份红、最终 diff/SHA 在 `variable-anchor-followup-before/`。root已全文复核增量，冻结最终238源码；正式全部六项 symbol 硬件整合正在运行。

上述最终源码的库 ordinary/min、Worker/geometry-worker、类型声明和 demo 构建通过，build:ci约2.4s/demo2.01s；构建只是发行链资格，不作为加载或 FPS 收益。


最新构建后的发布公开语义已重新验证，`published-style-contract-probe-reviewed/result.json` 两种实际 dist main/min 入口及各自默认三个浏览器 Worker 都通过：真实 LD 对应回复、constructor sourceLoaded、__proto__ layer、相同样式及 paint-only identity 保持、无额外 LD、destroy 全部终止 Worker。错误为空且 WebGL 请求数0，仍不扩大为渲染资格。磁盘 dist SHA 与 Vite HTTP 转换后实际模块 SHA 分开保存，旧发布检查点证据未覆盖。


最终合并生产源码正式硬件集成 `audit-symbol-variable-coverage-reviewed/` 六项一次全部通过（5.6m）：近地 CJK quad、双向及倾斜 writing mode、混排/CRLF、point/line sort-key segments、四组 variable anchors、多类12组 paint translation。冻结238生产源包含 covering 最终修复及可变锚点两个独立复查修复；四组 variable mask 均为0。所有现有 actual camera/zoom/FOV/完整 mask 和资源身份断言保持；不把硬件测试执行时间作公平渲染性能样本。该结果替代前述“尚未最终硬件整合”，没有扩大为真实球面全部姿态或未验收 mixed fit plane。

源码台账剩七个旧版本登记已由独立全文2142行审查更新；root全表校验238文件没有缺项/多项，所有审阅 SHA 与当前冻结源码一致，未发现额外确定新缺陷。新增模块及后续变更仍要重新审阅。


### 当前高收益：fill/outline paint 平移失效及资源完成顺序导致漏轮廓

原始完整238生产检查点 `fill-translate-probe/before-qualified/result.json` 有严格普通 CV 硬件红：同一个真实 GeoJSON 带孔面、显式双色 outline，source13、pitch60/bearing90、实际 zoom15.34683436、同 physical pose/FOV/627×710，Native/Map actual GL fill24及outline16索引、两端 Worker 孔洞/有效数据、错误为空。零平移两色 full mask/中心差均0；两端实际 paint 求值同为[48,16]及对应anchor，viewport 时 fill中心50.728px/mask .464188、outline50.414px/mask1；map时fill29.179px/.471444、outline17.742px/mask1。Native所有像素保持 control，Map真实移动，Native owner/VA/command均稳定。实际加载228份源码均与完整冻结238manifest一致，含真实Worker入口与FillBucket；仅证明普通CV solid fill及显式outline，pattern/CLAMP仍是此前静态缺口与独立后端待验。

第一轮 `fill-translate-probe/before/result.json` 另出现实际 Context draw先outline后fill：Native outline仅12.196/Map392.737，两色mask .019533/.968946。原观察器错误把合法 command.count undefined 当无绘制，资格已修为实际 GL 调用关联；原红画面及loaded SHA保留、不覆盖。仅冻结 draw-commands.ts 改角色顺序的 `order-candidate/` 先全部fill再outline，两色control完整mask/中心差均0、轮廓面积392.737。原生产在第二轮也偶然出现正确次序：这是缺少同层绘制阶段排序、资源完成顺序影响输出，不能说生产每次必红或把一次候选当公平性能提速。

官方Map6.14 `src/webgl/draw/draw_fill.ts` 全文复核：opaque fill先绘制；translucent fill遍历全部coords后，再遍历全部coords绘制outline。故phase应先于同层tileRank。root新增一个既有Native command准备接缝的代表回归，反向/正向发布及两tile ranks，旧生产确定红（期望fill近/远→outline近/远，实际outline与fill按tile交错）。默认隐式outline及半透明AA与显式颜色的depth子层合同另行资格；生产排序修复尚未实施，不以临时候选绿代替它。


隐式 outline 独立临时候选资格已完成，`fill-translate-probe/implicit/order-comparison.json`：强制全before及全after各两个opacity控制，实际GL顺序、raw fill-outline-color undefined、source/pose/hardware均合格。opacity1整RGBA与Map逐值0差；opacity.5两个Native方向彼此整RGBA完全一致，两个Map方向也一致，但Native共有9pixel green+1，greenmask .0000014683，零差断言未放宽、两run因旧透明基线细差exit1。结论仅单feature同green带孔，不外推多色邻界。此微差按用户收益优先级后置，没有将其写为已接受。

官方隐式子层0/显式2区别及当前 Native 缺同等depth处理再次核对。正式先修显式阶段：owner携带真实raw paint presence，构造与实时paint revision更新，held保持已提交身份；同layer显式phase先于tileRank，其他kind及implicit维持原相对序。正在实施并用原确定 Native2tile反向发布红回归；不由颜色相同推断身份，不在DrawCommands每帧读live style污染held。


显式 outline phase 四生产文件已正式实施并全文增量复核：DrawBatch 对 fill-outline 强制 explicit boolean，真实声明 presence 共享规则删除旧 optional-method 猜测，实际 outline group 持有注册的同一 batch 对象；force paint revision 在早退之前刷新，同颜色声明变化不遗漏，held freeze 保留旧角色。DrawCommands 每条记录缓存 phase，按 layer→explicit phase→tileRank→order 的统一总键排序；不改其他kind及implicit原相对顺序。root确定2tile Native正反输入红及真实Worker→VectorTileRenderer同RGBA declaration变化红均绿，去除声明及冻结后live变更也通过，owner collection未替换。Scoped ESLint→完整 tsc→7风险文件32tests通过；最终硬件尚待串行进行。最终完整238检查点 `current-head-20261014-explicit-outline-phase/` 比上一最终symbol检查点仅四文件不同，精确hash/diff/red保存 `explicit-fill-outline-before/`。


### 续接：普通填充平移、缓冲区与无补丁依赖

原冻结238源码的 fill/outline 平移已在当前聊天重新运行真实 production Native/Worker/hardware 对照：control 两色零差；viewport [48,16] 时 Native 仍原位，fill 中心误差50.728px、outline50.414px。`fill-translate-probe/resumed-before/result.json` 保留原红。正式接入每 owner 独立 camera uniform，实时 zoom/bearing 在 feature paint 预算前更新，held 快照冻结旧表达式/transition时间并继续响应相机。render/pick command 保持稳定身份，并从原始球扩大 translated bounds，零平移不执行新增三角函数。

跨四个 source13 瓦片、buffer128、带孔面指出独立边缘缺陷：旧预裁剪已丢掉可平移进入 tile 的 buffer。55°实际同相机资格下，`fill-translate-boundary/before-buffer-qualified-p55/result.json` 即使control也有outline中心3.638px/掩码.093746红，不能用其译后图接受基线。保留完整 planar fill/outline buffer，并复用 outline 的固定像素平面裁剪后，`after-buffer-stable-p55/result.json` control 最大中心.003404px/掩码.000044885，viewport两色全掩码/中心零差，map fill零差、outline中心.001012px/掩码.000005757。所有 owner/VA/command身份保持，错误为空。仅证明普通 CV solid fill/explicit outline；pattern、globe Buffer 和 CLAMP translation仍是待完成后端。跨瓦片pitch60加载长时间publish4/pending4不归因于平移，55°控制隔离了60° LOD浮点边界；pitch60卡住的根因尚未确认，不能称已解决。

独立增量复查找出的 pattern rawbuffer无mask回归已修，只有实际承担固定 pixel mask 的 solid planar mesh 保留缓冲，pattern/3D/drape仍按各自拓扑合同裁剪，缓存键分离。复查发现的整tile主线程投影回退也已修：Worker 预计算/packed transfer新增 fillPlanar，CV/2D直接消费，globe/morph继续各自mesh，不在预算admission前同步重做整tile。复用现有 structuredClone transfer 用例验证 exact topology/稳定 views；删除内部 typed-view数量必须<=12 的冗余固定布局断言，保留 small/dense 数量不随feature增长的核心回归。旧 planar预裁边缘交点用例已删除，保留实际 ring buffer/closed/globe mask 合同。只新增一项代表正式硬件回归（跨4tiles/55°，zero/viewport/map三阶段）及一项已有Worker接缝的camera/held回归，未增加参数矩阵。

当前源码一次完整 Vitest为76文件446项中443绿、3失败：固定view数量断言以及无draw生命周期里多余的bounds计算。前者删除已无公共意义的常数断言，后者在实际无command输出时返回；两个受影响文件6项复跑绿。正式硬件 `fill-translate-final-formal/` 一项新增fill＋三项已有line/outline，一次4项通过（1.0m）。最终tsc修正了新fixture的5处类型推导/union narrowing，未改像素阈值。新增源码总239个，增量12文件均已独立复核。后续无补丁检查另列，不把此前通过继承为最终无补丁产物通过。

用户明确要求删除patches、即便库有问题也尊重原实现。已删除style-spec26.4.4补丁文件及目录、pnpm-workspace patchedDependencies，pnpm install恢复根及workspace原版依赖，lockfile无patch_hash/补丁声明；没有修改上游node_modules或增加diff副本/ID映射。原上游constructor/__proto__差分重建已再次由真实Style.setState复现，失败保留 `fill-translate-no-patches-related.log`；移除仅用于验证已删除上游补丁的special-name diff用例，本项目名称字典/Worker安全测试仍保留。旧带补丁发布产物的special-name identity证据撤回为历史检查点，已重构建ordinary/min/Worker/dts及demo来消除旧补丁产物。


最终无补丁检查点：`current-head-20261014-fill-no-patches/manifest.json` 的239源码逐项与当前台账/磁盘一致；已核实上游实际加载路径无patch_hash，dist/diff.mjs恢复两个reduce空对象原实现，根patches不存在且三配置无补丁声明。ESLint→完整tsc通过；库ordinary/min、Worker/geometry Worker/dts及demo构建通过。最终无补丁正式硬件 `fill-translate-no-patches-formal/` 唯一fill跨四瓦片回归通过（40.0s/总42.7s），保留原相机、mask及资源身份断言。没有把测试耗时当FPS收益。

最终完整Vitest76文件445项中444通过、一项style-worker-lifecycle合法名称Worker生命周期用例5000ms超时；该文件在硬件套件结束后独立复跑6项通过（1.82s），未改变用例/timeout，没有宣称全套一次全绿或断言唯一超时原因。移除上游补丁后本项目安全名称及Worker生命周期仍有实际原版依赖验证；唯一移除的是专门验证已删除上游diff补丁的special-name setState用例。其差分重建限制仍保留，不借移除测试宣称已修。

### 图案填充平移（原版依赖）

临时探针复用现有跨四瓦片 fill fixture，注入本地16×16双色棋盘sprite，两端实际图集/Worker及硬件GL均参与。完整无补丁239源码冻结的 `pattern-fill-translate/before-actual/result.json`：zero中心差.00673px、完整棋盘mask差.000404；viewport [48,16]中心误差50.71966px、mask .590880；map中心32.67435px、mask .600185。两端真实camera/FOV/zoom相同，错误为空；早期探针访问错误私有字段的两份启动失败不作为资格证据。

pattern-renderer复用FillGeometryPrimitive的独立owner平移、冻结paint、稳定command及保守bounds；仅改变顶点位置，保留原图案st。普通CV pattern加入现有固定pixel tile mask、保留原tile buffer，drape/globe/morph维持原拓扑。材质坐标uniform绑定到实际appearance的同一对象，实时zoom和held schema切换维持已有所有权。去除Native Geometry中值为undefined的无用属性。两个生产文件由独立只读代理全文增量复查，无确定阻塞问题；未修改依赖。

`pattern-fill-translate/after/result.json` 三阶段：zero中心.004816px/mask .000336978；viewport中心.001221px/mask .000272654；map中心.005294px/mask .000239117。四瓦片两端实际pattern GL索引均24，owner/VA/command身份跨阶段不变。该对照验证整个棋盘相位，不能仅以外轮廓相同替代。GPU冻结与最终源码只有两处类型断言不同；最终 `current-head-20261014-pattern-fill-reviewed/manifest.json` 全239审阅SHA与台账一致。

ESLint→完整tsc通过；4份现有相关单测28项通过（2.12s），已有正式硬件public solid/pattern切换场景通过（11.5s总执行），ordinary/min/Worker/dts库构建通过。本轮没有新增测试或扩大参数矩阵，没有重复全套单测；探针和测试执行时长不作为公平性能样本。当前资格限普通CV，globe Buffer/CLAMP平移及图案球面/morph固定裁剪仍待完成。

用户追加近水平相机POI符号放大的两图调查：实际报告相机(121.49099,31.23782,5.95m,heading104.3,pitch-2)光轴海平面焦距170.55479m；第二(121.49173,31.23765,73.55m,heading103.9,pitch-87.3)为73.63174m。第一光轴实际命中地面，没有进入miss-horizon回退。现行viewport text/icon共用shader与固定MapLibre一致的 `clamp(.5+.5*D/clipW,0,4)`：近处锚点相对远焦点增大，俯视锚点与焦点距接近则约1。独立源码复查没有确定缩放错误；两图也改变位置与高度，尚未提取真实Haagen-Dazs锚点/基础paint，故不把截图的具体倍数写为已完成像素资格。复用既有正式硬件globe-pitch-scale测试一次通过（11.1s总执行），保留独立公开球面相机oracle及实际文字尺寸断言，没有新增测试或改缩放规则。该用例已在精简时移除。

### 球面实色及 CLAMP fill-translate

新增唯一代表Worker→真实Native collection回归，覆盖NONE/CLAMP两种独立消费路径、两个共享Worker图层、视口anchor、连续zoom、零恢复、held表达式和原record移除后继续更新。旧239生产源码确定红：期望平移后的公开positions仍停在原位，位置误差195.349m（`buffer-fill-native-red.log`）。用公开positions及孔洞验证实际输出，不断言私有字段布局；重复同一delta没有额外setPositions调用，避免静止帧反复重烘贴地数据。

原版Cesium公开setPositions会标记GEOMETRY dirty；Buffer GPU可原地更新VA，VectorProvider依据dirty/version重抽ring、holes、material和pick ids，并重建旧/新范围lookup。builder的预计算bounds不会自动随positions更新，项目必须从初始不可变sphere重新扩展。独立复核还发现provider以constructor精确查packer表，首个subclass候选确实在硬件上抛出不支持draping；已删除该候选生产模块，改为原版BufferPolygonCollection加项目FillBufferPaint组合，不修改依赖、constructor或provider。两处上游Cartesian3 typed-array声明限制改为直接读写坐标。

FillCameraPaint集中GPU、Native及outline的相机平移/held快照规则。Native每owner借用只读原始Worker/drape ring positions，首次非零才分配Mercator/输出缓存；相同有效delta直接返回，恢复零逐值复制原始positions，极点保持极点，其他纬度不使用Cesium的85°投影clamp。更新公开bounds与setPositions，保持原holes/triangles/material/pick身份；Native纳入预算前mandatory paint，旧record删除后，held callback仍持续到Scene销毁实际collection。六个生产文件独立只读复查通过，全部241生产源码SHA与台账匹配。

球面对照不能借用CV的球/椭球相同投影假设。现有drape fixture原source13/zoom14.25/pitch65零偏移同物理camera下，两端full mask差.12898/中心2.136px；这不是translation红。独立原始多边形WGS84/球面投影揭示模型差异，参考球面shader相对double角点投影也有残差，未放宽容差或把其写成已接受。探针保留原数据、改为zoom15.25/pitch55/bearing90，按各自实际矩阵投影原始rings，并用独立像素中心even-odd完整掩码验证Native；MapLibre仍提供真实GLOBE/transition1/硬件/源tile和画面诊断，但该记录不宣称Native/Map跨模型full mask一致。早期探针的错误API调用/三帧内默认300ms transition未完成已修，相关启动失败及中间画面保留，最终qualification显式关闭transition。

完整239无补丁生产冻结的 `buffer-fill-translate/before-p55/result.json` 八帧：两Native后端zero对WGS84 oracle合格；viewport中心误差约51.08/51.09px、mask约.568，map约33.86/33.88px、mask约.583；恢复zero与初始逐像素相同，错误为空。最终241组合实现冻结的 `after-composition/result.json` 同数据/真实camera/FOV/实际sphere分支八帧：solid viewport/map中心和完整mask均0；drape viewport中心.063547px/mask .00164530，map中心.022936px/mask .00159740，zero中心.029606px/mask .00196770。两后端恢复zero都与其原control逐像素相同；原Native collection、实际VA及command identity各阶段完全复用。CLAMP上游lookup纹理需要重建，未承诺其identity复用。

ESLint→完整tsc通过；5份现有风险单测36项通过（2.30s），其中唯一新增Native回归。补入同一用例的record移除后held更新/销毁清理后，该文件5项复跑通过（1.64s）。现有正式硬件CV跨四瓦片fill/outline一项通过（29.2s总执行）、public solid/pattern切换通过（10.9s）、drape两owner叠加/独立移除/真实拾取/六类纹理释放通过（9.9s）；这些owner拾取证据是现有零平移场景，未扩大为平移后的拾取资格。库ordinary/min/Worker/dts构建通过。未新增GPU测试、重跑全套或改变原阈值，所有执行时长仅记录验证成本。

剩余资格明确保留：Native非零delta仍需O(vertices) CPU转换/上传，CLAMP还会触发原版lookup重烘，需要完整帧重复性能测量；当前移动已驻留预裁剪片段，不恢复source buffer或扩大source获取，固定tile边界及实际极区/极限zoom平移仍待硬件核定。图案球面/morph裁剪、混合透明遮挡、球面文字残差及完整帧性能目标仍进行中。


### 收尾性能、组合字素与透明模型（2026-10-14）

最终整段采样使用原版依赖与独立发布包，审计起点229源码和Native fill修后241源码三对AB/BA/AB；raw源码混当前fixture的首次export mismatch无效，未计入结果。`final-city-published-ab-20261014/{manifest,records,summary}.json`保存全部六轮源码、入口、资源及fixture SHA。双方实际物理上海CV相机与视口固定，profiler/GPU query/内部observer关闭。

| 阶段 | Native P50修前→修后 ms | Native P95修前→修后 ms | 修后MapLibre P50/P95 ms |
| --- | --- | --- | --- |
| zoom-out | 9.4→9.5 | 32.9→16.6 | 4.3/6.1 |
| zoom-in | 10.6→10.6 | 53.4→18.6 | 2.6/4.7 |
| pan | 9.7→10.7 | 26.2→16.2 | 3.5/5.5 |
| orbit | 13.1→12.9 | 31.9→19.7 | 3.5/5.9 |

数值为三轮同阶段统计量中位数，非合并采样分位。四运动阶段总CPU8867.3→7547.4ms（−14.88%）；pan各轮48帧总CPU均下降，合计−5.76%，但P50升高不能隐去。冷首次loaded墙钟中位2770.7→3410.5ms（+23.1%，单轮方向混合），截止首次loaded tick CPU合计+7.94%；stationary363.0→559.9ms、settle925.3→1414.1ms，仍有退化。首尾同为6tiles/18vector collections/37symbol primitives/303commands，冷采样之后显存20,045,813→21,399,965bytes（+6.76%）；该资源捕获不是loaded瞬间。逐项源码核对没有已证实的高收益调度缺陷，新增CJK/真实paint工作未有公平阶段归因，不把整体冷退化全部归为正确性成本。当前profile仅诊断，不能混入公平结果。字体链随后有变更，此批性能不是包含后续改动的最终发布资格。

已确认组合字素能力缺口修复：GlyphSource→Worker→atlas→shaping统一实际grapheme string key，普通PBF只在缓存接入转字符key，仍保留原wire格式与range缓存；TinySDF整cluster使用3em canvas，不合并不同formatted section样式。独立review发现GB11 `👩` / `ZWJ+👩`的section fragment二次分段会漏第二section，已修为对选定fragment直接收集原文及镜像。既有formatted字体控制红→绿，没有新增数量。scoped ESLint→全tsc→6相关suites68项通过，GB11后续2suites13项通过，最终独立复查无阻塞。真实hardware+Worker `grapheme-glyph-candidate/result.json`原文+U0301同相机mask .086097→.000806、中心差约.00047px；CRLF俯视和倾斜均mask0，没有沿用旧CJK .1门槛。临时探针未加入正式测试集合。

真实透明Model与3D Tiles均取得实际unlit BLEND .5、GL translucent pass10、正VA/indices和精确同camera；style false→true→false三阶段magenta轮廓2519px、R/B贡献逐像素完全一致，true时856px实际透绿色，错误为空。`mixed-model-probe-qualified/`的Model、`mixed-model-probe-tiles-qualified/`的真实tiles分别记录。隐藏会正常退休ground纹理，资源验收需重显再捕获，六类ground纹理均销毁、terrain借用VA保留、hooks恢复。3D Tiles content与Model实际destroy，但全部历史观察VA即时destroy断言未通过，暂不宣称外部SDK完整VA释放。零geometricError tiles最初被上游root SSE早退而未绘制，合法整体error100/leaf0后真实draw资格通过；没有改依赖。

跨四source13瓦片的实体/CLAMP fill、带孔外形控制、viewport/map平移及零恢复，`buffer-fill-boundary/buffer128/result.json`八捕获均符合各自WGS84 pixel-center模型：solid零中心约.0045px、mask .000024，平移中心/mask0；drape各阶段中心小于.07px、mask小于.002。实际4owners与GL draw存在；source buffer0参考端固定tile mask会截掉移入buffer的内容，不拿该未合格的参考译后图归因本库错误。buffer128的参考端仍有实际sphere float渲染残差，保留原始数值，不宣称双端逐像素相同。

图案球面控制与viewport平移符合Native WGS84模型，map-anchor阶段仍为1.3059px/.016095 mask红；`pattern-fill-globe/native-qualified/result.json`保留原始证据，未放宽门槛。正式球面文字残差、沿线exact90数值取向边界、图案map/morph及完整性能限制仍未标为已完成。


### 用户要求的代码、测试和 Demo 收敛（2026-10-14）

已使用writing-for-agents与codebase-design重写根AGENTS.md：测试不再是默认必要项，永久用例须有真实可复发风险依据，临时小诊断验证后移出正式集合；已有模块契约继续沿用，跨模块重构须有新证据，内部可信状态不以缺省值掩盖错误。原版依赖、真实取消/竞争、资源所有权和生成代码约束保留。

结构巡视沿既有241文件覆盖台账重点复核公开入口、Worker、发布/驻留/来源同步和拾取调用链，没有重新声称241文件再次逐一全文审查。仅实施三处有证据的收敛：RasterStyleLayer直接读取已生成的强类型标量（上游除法可产生Infinity，保留finite保护与两resampling别名）；zoom paint检查直接使用StyleLayer构造保证的Transitionable契约，删除可选影子类型/false fallback；拾取依真实raster/pattern标签收窄，删除假vector断言，保留代次与失效feature检查。现有发布/驻留/唤醒/帧准备模块承载真实状态和复用，没有为偏好重切接口或建立新兼容层。

测试清理接手快照107→95suites、498→455条test/it声明、21,887→20,752行（期间字体链改动计入净值），删除10unit薄包装/探针suite和2e2e巡检/重复MLT用例。永久camera-focus32姿态→8、extrusion projection6→2、symbol sizes6→3、retained translate2→1、highzoom pattern3→2；不是把所有不同风险为了数目合并。必要延迟transition控制移入style-state-change，null GeoJSON输入边界保留，假type:circle的vector pick fixture按真实契约修正。最终11受影响unit suites85项全通过；六受改e2e文件注册43项成功，不代替浏览器执行。无引用的demo-preset-audit及MLT numeric .ts/.html三份fixture移除。临时库存和删除依据仅在缓存 `test-cleanup-{before,after,actions}.json`，不成为正式测试负担。

Demo保留七个仅定义相机的典型场景，camera与style分别更新，无styleId联动。桌面面板常展开，相机两行、自定义URL常显、原生高清checkbox；标题/添加移除/说明反馈/已加载提示删除，只保留GitHub。移动顶部整体展开/收起。以公开stats显示可渲染瓦片和提交命令，公开preUpdate→postRender记录最近60个实际绘制帧CPU均值、500ms刷新，无GPU等待和额外requestRender。CPU数字不声称纯库或GPU耗时。CSS和状态保持直观，保留加载取消、候选销毁与旧map交接。

README中英改为安装、直接接入、常用操作、独立URL选择和实际图库，审计及内部实现留在开发记录。第一轮截图发现尚在加载的地图不适合作为最终图库，因此改为等待真实loading结束后截图；原初始图仅保留缓存诊断，最终图与移动两态结果另行记录。


最终静止相机检查发现伦敦场景90s仍未loaded：style和source均已loaded，publish及首次上传为0，pending属性集为0，但target/visible placement反复dirty。真实采样bearing约8.4e-16→1.0e-15，同时ECEF viewProjection[12]每秒漂移约4e-10；只放宽bearing不能修复矩阵重组漂移，该候选与临时断言已撤销。最终复用既有CameraCache的完整world view/bearing；position严格比较、direction/right/up采用已有EPSILON14及focus边界检查，实际移动/滚转/frustum/模式/画布变化创建新缓存。projectionMatrix、frameNumber、绘图缓冲与pixelRatio每帧仍更新。独立review补齐真实upWC失效输入，未修改SDK或放宽placement投影阈值。

最终现有camera-focus14项通过；demo-controls仅保留的真实移动DPR/resize/独立URL场景样式用例hardware通过（16.4s），没有新增正式测试。ESLint→完整tsc、库ordinary/min/Worker/dts与Vite演示构建通过；Vite保留既有大chunk提示。241生产源码最新SHA与覆盖台账全部一致，冻结到缓存current-head-20261014-close-reviewed。

八个桌面组合均等待真实tilesLoaded后捕获，pageerror为空，伦敦加载结束且实际16tiles/644commands；七个代表场景加伦敦2D能显示地图总览、密集街区、高层、桥梁、放射路网与球面。移动390×844真实loaded后展开/收起面板分别472.5px/46px高，宽366px，无水平溢出；内部图在demo-mobile-review-ready。按用户最新要求，README图库重拍为纯地图，不含控制面板，保留数据版权；旧九张无引用截图移除。场景截图中的CPU值是demo读数，不作为公平性能证据。


用户随后要求保留Cesium FPS且显示场景量级：demo显式启用原生debugShowFramesPerSecond，面板以可渲染瓦片、驻留实色矢量集合、驻留符号Primitive批次、瓦片缓存显存估算与场景CPU均值替换提交命令。集合/批次不声称独立地物或标签数量，显存不声称整个Scene精确GPU驻留。stats读取与UI刷新均限500ms，不再每帧遍历驻留集合；保留原生按需渲染。图库临时隐藏面板及FPS覆盖层，实际demo保留两者；版权保留。


**此段最终版本归属已撤回，见下文“性能构建来源更正”。** 三对AB/BA/AB实际再次测量了buffer-fill-reviewed构建，而非包含字体链、三处结构收敛和完整相机姿态缓存的最终源码。源码、原版依赖、固定物理相机、fixture和资源SHA存于final-city-close-ab-20261014/manifest.json，六轮均通过；before/after为分别独立构建发布包与Worker。每阶段三轮中位Native P50/P95(ms)：zoom-out9.8/41.1→10.4/14.8；zoom-in10.5/52.3→10.0/17.5；pan10.4/25.5→10.6/18.1；orbit12.1/31.4→12.4/18.9。after MapLibre对应4.1/7.7、2.6/4.8、3.6/5.7、3.6/5.8ms。四运动阶段总CPU8667.7→7514.6ms（−13.30%），P95明显下降，部分P50仍略高。冷首次loaded中位2537.5→3156.8ms（+24.41%），冷tick CPU3446.5→4409.1ms（+27.93%），stationary352.7→562.3ms、settle884.2→1479.0ms；冷后驻留20,045,813→21,399,965bytes（+6.76%）。不能将新增正确性工作或局部提速直接当作冷退化完整归因，也不宣称全部最优。CPU/GPU没有混入demo统计和诊断探针；图库在六轮结束后单独运行。

图案球面最终源码临时uniform探针仍复现map阶段1.3059px/.016095mask，而control约.0077px/.000048、viewport0、restore同control。独立只读核对identity模型、高低位置编码、差分Mercator/椭球公式未发现确定错误；八ring顶点逐步Float32舍入模型delta最大误差约1.27e-5米。记录仅为command.uniformMap getter，尚缺实际linked program uniform和VA输入证据，不能按猜测修改公式或把残差写为已处理；保持旧目标未完成状态。

README最终纯地图图库8张均来自真实loaded画面、没有pageerror，临时隐藏控制面板及原生FPS覆盖层，版权署名保留；文件docs/images/demo-*.jpg对应独立URL组合，内部采集记录demo-gallery-clean/results.json。


最终移动截图实采fpsEnabled=true，两态宽366px且无水平溢出，收起46px、展开513px；性能5项与当前stats一致，提交命令已从UI移除。gallery八图没有控制面板和性能覆盖层；采图的临时CSS不进入demo代码。最终检查原版依赖配置无patchedDependencies、无patches目录，241冻结生产SHA仍与当前文件一致。


### 实际 GPU 小角度平移精度（2026-10-14）

上轮图案球面map偏差现已查明，未依赖猜测改公式。actual-gpu-input采实际linked program uniforms和VA高低位置；actual-gpu-feedback把原Native vertex shader的gl_Position经transform feedback读回，独立按实际indices rasterize：viewport/map TF模型与原framebuffer掩码逐像素相同，证明没有把其他shader输出或CPU getter当成实际draw。对原VA坐标反解，map delta.y比独立WGS84 inverse-Mercator少约0.6104m，viewport约0.2038m，其他轴差异远小于此。

actual-gpu-math进一步读回中间值：map angle.x=1.5116313079488464e-5，GPU sin=1.5020598766568583e-5（比值.993668）；viewport angle.x=-5.0388048293825705e-6、sin=-5.0068665586877614e-6；normal长度1。该Intel RKL Mesa/Vulkan硬件的小角度sin近似误差被地球半径放大，不是原差分Mercator数学错误、错传uniform或帧后回读模型。此结论限实测硬件，未声称全部GPU都会出现相同比例。

只修改项目共享mercator-translation shader：|angle|<.01使用五阶sin展开式，其他角度仍用sin；sinHalfX与旋转项同时应用。展开的截断误差低于Float32舍入误差。原版依赖未修改，没有新增常驻测试/兼容层。独立readonly复核所有fill/pattern/outline、symbol、circle、solid/pattern extrusion消费者，未发现确定问题；二维Mercator线性分支、bounds、高度与生命周期规则保留。

完整241候选冻结current-head-20261014-small-sine的small-sine-fixed/result.json，原同物理camera/source13/actual sphere/图集/Worker/硬件GL四阶段：control中心.0076946px/mask .0000480677；viewport和map中心/mask均0；restore与control相同。原primitive/VA/command身份保持，GL errors0，门槛未放宽。ESLint→全tsc通过；既有circle实际低zoom球面平移代表用例通过（10.5s），没有扩大旧组合或新增测试。final-city-close-ab构建来源随后确证错配，不能承接为包含字体、相机缓存或本shader改动的最终性能资格。


### 性能构建来源更正（2026-10-14）

冷加载诊断的严格bundle SHA校验发现，final-city-close-ab.py虽然记录close-reviewed源码，却仍从final-city-published读取bundle并传给E2E_CITY_LIBRARY_DIR。六个records的真实入口一致指向该旧目录，241份复制生产源码逐项SHA等于buffer-fill-reviewed；真正close-published的复制源码等于close-reviewed，两者相差13文件。故运动−13.30%、冷加载+24.41%是旧buffer-fill-reviewed的重复测量，撤回其最终源码归属；不能用它解释后来新增字素处理的成本。旧产物完整保留，不篡改manifest。

新final-city-small-sine-ab冻结完整small-sine源码，重新独立构建双方bundle及Worker；脚本同时核对冻结源码、用于构建的复制源码、bundle SHA和真实运行目录。三对测量六轮已完成，正式数据不含临时冷加载探针；结果如下。


### 匹配最终源码的性能与冷加载诊断（2026-10-14）

`final-city-small-sine-ab-20261014/{manifest,records,summary}.json`记录229起点对241最终small-sine源码。独立复制源码、构建输入和runtime目录严格一致；普通入口after SHA为d8be0ab6…，包含实际字素链及cvt_sin。三对AB/BA/AB、双方独立Native→Map contexts，六轮通过；original依赖、同物理上海CV相机、固定回放资源、无profiler/observer/GPUquery。三轮阶段统计中位(ms)：

| 阶段 | Native P50 前→后 | Native P95 前→后 | 最终 MapLibre P50/P95 | 最终 Native/Map P50/P95 |
| --- | --- | --- | --- | --- |
| zoom-out | 9.5→10.2 | 34.1→17.2 | 4.1/6.1 | 2.49/2.82 |
| zoom-in | 9.3→11.2 | 44.1→18.1 | 2.7/4.7 | 4.15/3.85 |
| pan | 11.0→10.0 | 29.8→16.7 | 3.4/5.5 | 2.94/3.04 |
| orbit | 12.8→13.8 | 31.0→19.4 | 3.5/6.4 | 3.94/3.03 |

四运动阶段逐tick总CPU三轮合计8604.4→7735.1ms（−10.10%，单轮总量中位−8.88%）；不忽略zoom-in/orbit P50上升。首次loaded中位2437.2→3126.5ms（+28.28%，三对方向一致），截止各自loaded的tick CPU合计3240.6→3771.2ms（+16.37%）。静止总CPU中位122.8→196.1ms，settle298.8→469.6ms。CPU截点明确按ticks.at<=loaded milestone，避免把loaded之后冷采样窗口纳入该指标。最终冷后均6tiles/18vector/37symbol/303commands，瓦片GPUbytes20,045,813→21,399,965（+6.76%）。该资格不能宣称冷加载或所有阶段整体最优。

独立串行临时`cold-glyph-probe-small-sine`使用同一published SHA/Worker/资源与物理相机，以内存load transform诊断；有探针的数据不混入公平样本。两端实际同481个fontstack+grapheme各调用/绘制一次、无重复、全部普通单字形、零cluster，canvas均72/padding6，输出尺寸及合计1,623,905 bytes相同，GG真实回复均6次。同步SDF draw CPU157.8→143.4ms；字体await墙钟最多2.1ms。不能把新组合字素、3em画布或重复请求归为本场景冷退化原因。阶段CPU可嵌套，不直接相加；reply后Worker、geometry消费与首次Native绘制的未观察段仍待归因，诊断绝对墙钟不作为公平A/B。

沿线exact90独立复核：项目symbol-placement的horizontal first.x>last.x与原版MapLibre projection规则一致，vertical比较亦符合坐标Y转换；上游规定等号不flip，但没有跨投影near-zero tie规则。已实测相反的微小非零方向，不是项目另加错误判定。保留原90画面失败、真实斜率viewportX30 mask0及89/91的8组通过；登记为取向零附近的数值一致性限制，不增加epsilon或声称所有姿态像素通过。


冷加载gate临时探针`cold-glyph-probe-small-sine-gates`进一步闭环：after1904.6ms所有首次Native更新完成、303命令、动态/opacity/paint待写均0，但target/visible无job且dirty、runnable=false，等recency直到2090.4ms；before1887.6ms首次更新清零即loaded。`cold-glyph-probe-small-sine-views/after`补采实际incoming与冻结view：zoom/centerDistance/结构字段保持，bearing约2.21285663404276e-16发生极小漂移，真实公开positionWC.x每帧约减少7.45e-9m，对应clip-W矩阵常数变化；并非只有near/far clip-z变化。原版Camera._updateCameraChanged包含HPR getter，getter暂时切换/恢复transform，可能涉及该漂移；目前没有通过隔离调用确证全部来源，因此不把它宣称为已修或全部冷退化根因，不猜改position容差。阶段数据均为诊断，不替代三对公平结果。

最终small-sine球面城市文字TF探针两次均未取得初始化/相机资格，90s等待失败，零capture；分别保留symbol-globe-feedback-small-sine-city与small-sine-city-ready。后者仅改缓存fixture的reference.loaded事件订阅，不改生产或依赖。两份启动失败不作为画面红/绿、CPU或资源验收，球面文字与morph原剩余资格保持。
