# 最新上游渲染语义复核

核实日期：2026-10-13；仓库 HEAD：`4f9032bb7239fd838ffec1199b37b537623055cc`，检查对象是当前工作区（包含上一轮审计尚未提交的修复）。初轮仅新增此记录；2026-10-14获得两项实施授权后，修复第1/2项并新增限定回归，下文分别记录修复前证据和修复后验证。本记录区分实际生产函数复算、源码确认及尚待 GPU 验证的推论。

## 2026-10-14 当前状态（历史证据下文保留）

| 初轮项 | 当前状态 |
| --- | --- |
| 1 高zoom图案UV/尺度 | 已修复；zoom20.25/24.25、pitch70的真实双色与80px相位剖面通过。精确整数floor资格问题独立保留。 |
| 2 最高raster级别fade配对 | 已修复对应边界，真实Tile状态回归通过。 |
| 3 父子独立alpha合成 | 已改一次图像mix及同scope实际ready子图覆盖去重；不透明、半透明、彩色透明PNG和未覆盖父图quarter通过，实际GPU draw在结束后2→1。短deadline跨walk、duration0与requestRenderMode post-sync清理wake已通过真实CPU合同及13项GPU整合。 |
| 4 extrusion墙纹理轴 | 连续wall edge/height及Native压缩契约已修复；剩9个条纹边缘采样RGB差异未解释，未放宽验收。 |
| 5 pattern lighting | map-anchor白图及viewport bearing90/pitch65的solid/pattern实测通过，实际旋转时原NativeVA保持、lightRevision不变。held rawlight/livecamera有CPU证据；球面solid normal/globe light转换与gradient动态画面独立待验。 |
| 6 line gap/offset/blur | 已实现真实消费链，三个独立GPU规则与tilt/outline/family/clip回归通过。 |
| 7 pattern提取器预算 | 同步耗尽检查点仍未修；其浏览器整帧占比还需资格，按收益优先级排在实际漏绘/加载失败后。 |

另外修复实际Raster首次upload共享Bitmap提前close、HTML decode回退提前换透明图、ImageSource缓存引用、coarse terrain被来源minzoom挡住造成覆盖清空、200相同etag响应的并发加载槽停滞及Departing=0错误判断。详细红/绿证据与限制见 [累计记录](comprehensive-audit.md)。另修圆角挤出重复fillet和人工裁切边假墙；俯视/65°倾斜完整silhouette与MapLibre一致。circle-translate已有公开实际GPU红→绿，覆盖两种anchor、倾斜、zoom0/24.25/25、跨纬度独立投影、多视锥和旧代paint。南北极冠正式硬件production Native回归均通过，100×100绿色ROI双方10000；近垂直相机用公开向量精确复制，排除setView的heading/roll重建损失。低zoom曲面墙接缝已修，完整中央720行颜色剖面通过；全图98个边界差异仍登记。建筑translate已通过实体/图案首次、动态、zoom25及真实球面硬件回归，覆盖改变时仅保留owner资源身份检查也已核实。合法MLT safe BigInt属性已通过真实浏览器Worker与MVT对照的硬件红→绿，raw拾取保留BigInt。跨tile circle-sort-key、fill/outline translate、细微采样差异仍待处理；命名和低收益局部改动后置。上述状态不代表全部源码或整个目标完成。

追加审查已修正CLAMP polygon环/孔洞及符号segment local/global索引，后者两个排序键的四种point/line姿态已有实际硬件红→绿。文字短run竖排/CRLF也有真实字体与全mask回归；组合字素的字体链差异仍未接受。合法名称字典及style-spec diff重建已修，发布构建补丁资格待核对。实际HTTP304刷新仍有独立加载失败，倾斜高zoom短距离移动仍有视图误判，正在处理。带background的地形填充被覆盖已有实际framebuffer前后取证，透明有序surface pass正在正式接入；原型绿不代替生产验收。完整证据见累计记录，所有低收益清理排在已复现错绘之后。

## 版本与取证范围

本轮再次执行 `rtk proxy npm view maplibre-gl version dist-tags --json`、`rtk proxy npm view cesium version dist-tags --json`，latest 仍分别为 **6.14.0 / 1.146.0**；官方 release 页面也标记为 Latest：[MapLibre v6.14.0](https://github.com/maplibre/maplibre-gl-js/releases/tag/v6.14.0)、[Cesium 1.146](https://github.com/CesiumGS/cesium/releases/tag/1.146)。通过 `git ls-remote` 核实固定提交：

| 来源 | release commit | 本轮 main commit |
| --- | --- | --- |
| MapLibre GL JS | `72927301b7594536630d896c45c64c4d0d4c587f` | `a6976b2d21ad4f88439a6fde4e5255101b5b6507` |
| Cesium | `b8d3a36fe98a3e432eb89253c95d5f20e605e0f1` | `201f20f232f7fb046a43568fc51324acb4a846cc` |

MapLibre main 已比 [旧研究](upstream-rendering-research.md) 的 main 前进；本轮在内存中读取这个固定 main 的 `draw_raster.ts`、`draw_fill_extrusion.ts`、`raster.fragment.glsl`、`fill_extrusion_pattern.vertex.glsl`、`fill_pattern.vertex.glsl`、`_prelude.vertex.glsl`，与安装的 6.14.0 六文件逐字比较全部相同。因此下述这些路径的差异不是参考依赖版本过旧。其他上游源码优先使用已经安装的 release 及现存缓存，引用均指向 release 固定 commit。

已先核对 [全面审计](comprehensive-audit.md) 的修复表与后续进展；不再报告已修复的 surface 高度偏移、optical zoom、slash source fade key、旧来源层序、circle、symbol paint/CJK 分支问题。README 明确拒绝 `line-gradient`，本轮不把它报告为漏实现。

## 1. 已修复 P1：图案全局 UV 转 Float32，极高 zoom 时纹理坐标坍缩

**位置：** [pattern-geometry.ts](../packages/cesium-vector-tileset/src/render/pattern/pattern-geometry.ts#L77)，尤其 L93–100；上传入口为 [pattern-renderer.ts](../packages/cesium-vector-tileset/src/render/pattern/pattern-renderer.ts#L415)。

`patternUVs` 把 `worldOffset + tilePosition` 的完整世界 repeat 数直接写入 Float32Array，然后 fragment 才 `mod(..., 1)`。原点很远或 zoom 很高时，局部坐标差已在 CPU 转 Float32 时丢失，fragment 无法恢复。影响 fill-pattern 以及使用同一 surface UV 的 extrusion roof；world wrap/overzoom 还会增加数值量级。

**实际复算：**直接 import 当前生产 `patternUVs`，16×16px 图案、pixelRatio=1、canonical x/y=`2^(z-1)`；局部正方形四角为 `[0,0],[128,0],[128,128],[0,128]`（tile extent8192，边长8个 tile pixels）。结果如下：

| z | 左上 UV | 实际边长 UV 差 | 正确局部差 |
| --- | --- | --- | --- |
| 14 | `[262144,262144]` | 0.5 | 0.5 |
| 20 | `[16777216,16777216]` | 0 | 0.5 |
| 24 | `[268435456,268435456]` | 0 | 0.5 |

z20/24 四角两个分量全部相同，三角形整片采样同一个 texel；这是生产返回值的失败信号，尚未把它冒称为 GPU 截图验收。[上游 get_pattern_pos](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/shaders/glsl/_prelude.vertex.glsl#L61-L83) 先把世界原点拆成 upper/lower 并模 pattern size，再与小的局部位置相加，目的正是避免这类精度损失。

**复现建议：**使用有区别的棋盘/条纹 sprite，在相同高 zoom tile 上绘制小多边形，核对完整 repeat 与相邻 tile 边缘连续性；纯函数回归应验证局部增量及世界相位，而不是固定内部 Float32 字段布局。修复可在 Float64 CPU 中先对世界像素原点取余，再上传局部 repeat 坐标，保留跨 tile/非整数 pattern size/wrap/overzoom 相位。

**2026-10-14修复：**只对共享瓦片世界像素原点求正余数，然后加连续局部像素坐标并除以sprite显示尺寸；各顶点没有分别fract，跨repeat的三角形插值仍连续。真实z24的8px小方形回归修前差0（应0.5）、修后通过；同一生产函数z20/24再次复算均为 `[0,0,0.5,0,0.5,0.5,0,0.5]`。另一代表用例使用pixelRatio1.5、14×10CSS px图案、source z20/overscaled z22、负wrap，在日期线东邻及南邻验证同一相位，同时保留buffer负坐标与多个完整repeat。测试位于 [pattern-geometry.test.ts](../packages/cesium-vector-tileset/src/render/pattern/__test__/pattern-geometry.test.ts)。该修复消除世界原点放大造成的精度损失，仍不宣称无限overscale/极小sprite尺寸下局部Float32 repeat数也无限精确，或世界像素量级超过Float64精确范围时仍保持全域相位；实际GPU验收留给主任务。

主任务随后报告的真实GPU探针（`audit-pattern-high-zoom-red/green`）进一步区分两个缺陷：修复前z20是红/蓝mask均0的纯紫单色，而参考各4608；origin修复后z20通过。z24仍为Native红4032/蓝4608、参考红蓝各4608，Native周期32px/参考16px；不能据上述纯函数回归宣称全部高zoom pattern语义已完成。这里还需独立核查来源LOD与style zoom的repeat尺度：上游 `Z=max(0,floor(styleZoom))`，`O=tileID.overscaledZ`，`L=tile.tileSize`，实际tile-to-pixel ratio为 `L/8192*2^(Z-O)`；普通512px矢量来源的 `L=512*2^(O-C)`，因此简化为 `512/8192*2^(Z-C)`，当前UV仍固定在 `512/8192*2^(O-C)`。Z比O大1时参考repeat密度×2，可以解释该周期信号，但必须以主任务捕获的真实Z/O资格确认。上游每draw同时更新world-origin phase与fromScale/toScale采样，source tile不换也会更新；缩小时仅缩放已去掉整数repeat的UV还可能丢失相位，不能只补一个常量倍率。[patternUniformValues](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/webgl/program/pattern.ts#L45-L67)、[pixelsToTileUnits](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/source/pixels_to_tile_units.ts#L18-L28)、[crossfade参数](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/style/evaluation_parameters.ts#L59-L69)。主任务后续实际相机取证发现Native的requested24最终求值为23.99999999992071、pattern styleZoom/source canonical/overscaled均23，而参考zoom24；因此最初32px/16px这一信号受floor边界污染，不能据此直接归因sourceLOD公式。验收须改用远离整数边界的20.25/24.25，并强制来源maxzoom更低以取得真实style/source级别分离。

**追加repeat尺度实施：**获得独立实施授权后，真实source canonical20/overscaled22固定不变、style24.25的8个source像素回归先返回2repeat（应8）；真实renderer共享一个material的两个不同级别owner在livezoom3.25仍返回256repeat（应512）。随后把surface GPU属性保留为局部repeat，用每owner的Native appearance uniforms应用 `2^(floor(styleZoom)-canonical.z)` 和按实际style floor重新求模的world phase；图集/material继续共享，floor不变时不重复重算，既有owner不重建。held旧sprite七像素、fresh三像素在zoom-out中分别取得4/7和1/3的正确origin phase，避免只缩放旧UV丢失被消去整数repeat的奇偶信息；旧owner释放仍真实销毁。没有合并pattern crossfade/wall-lighting实现，也没有修改line的重复规则。scoped eslint → `pnpm lint:tsc` →4相关测试文件 **23 tests**全部通过（1.76s），两条新增失败信号均在实施前取得；严格非整数相机及逐行RGB GPU资格由主任务另行记录，当前不宣称其已通过。

## 2. 已修复 P2：最高来源级别的 raster 子瓦片被错误排除出 zoom-out crossfade

**位置：** [tile-fade.ts](../packages/cesium-vector-tileset/src/tile/tile-fade.ts#L102)。

项目条件为 `childIDs[0].overscaledZ >= sourceMaxZoom`，最新版上游条件为 `> sourceMaxZoom`。恰好 source maxzoom 的子瓦片合法，项目多排除一整个正常来源级别。[上游 updateFadingChildren](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/tile/tile_manager_raster.ts#L142-L180)

**实际复算：**使用真实 `ActiveTiles`、`Tile`、`OverscaledTileID` 和生产 `updateFadingTiles`；ideal tile z13 loaded，其四个 z14 child loaded，fade duration300ms。source maxzoom14 时，ideal/children 的 fadingRole 全部 unset，retain0；仅把 source maxzoom 改15，四个 child 全部成为 Departing/Base、保存 parent ID，retain4。由此确认从 source 最高级别缩小一级时跳过正常淡出配对。该缺陷与已修复的 slash source ID 解析无关。

**复现建议：**先加载 maxzoom14 的 raster，缩小到13并让父瓦片加载完成；用父子不同颜色及较长 fade duration 观察连续过渡。回归应断言真实合法 maxzoom 子瓦片被保留/配对并按时间退役，不复制 guard 表达式。

**2026-10-14修复：**把排除条件改为 `> sourceMaxZoom`。真实Tile/ActiveTiles最高级子瓦片测试修前parent Incoming为undefined、修后子瓦片全部保留/Departing并关联parent，300ms区间内报告活动transition、结束后不再报告；独立保留source maxzoom之外的overzoom子瓦片不参加fade的边界，避免直接删guard。测试位于 [tile-fade.test.ts](../packages/cesium-vector-tileset/src/tile/__test__/tile-fade.test.ts)。没有把这个状态配对修复冒称第3项双draw raster合成候选也已解决。

两项实施按scoped eslint → `pnpm lint:tsc` →相关tests执行，全部通过；pattern-geometry、pattern-renderer、tile-fade、tile-pyramid-mixed-lod共 **4 files /20 tests**（1.54s），未重复全套。两项各自失败日志先于生产修复取得，未降低已有断言。

## 3. P1 候选：raster 父子图像独立 alpha 淡入淡出，不能等价于同片元 crossfade

**位置：** [raster-renderer.ts](../packages/cesium-vector-tileset/src/render/raster/raster-renderer.ts#L215) 的单 image shader 与 L1056–1064 每瓦片 `u_fade`；[tile-pyramid.ts](../packages/cesium-vector-tileset/src/tile/tile-pyramid.ts#L1176) 返回 incoming t/departing1−t；[tile-fade.ts](../packages/cesium-vector-tileset/src/tile/tile-fade.ts#L39) 同时保留两者。Surface ownership 排他门控只查询 vector/pattern，不包含 raster（`tile-residency.ts:_surfaceLayers`）。

项目分别提交两个只采样自己图片的 alpha draw；上游在同一 fragment 中采样 child 与 parent、mix 两份 straight colors/alpha，然后只输出一次 layer opacity。[上游 drawRaster](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/webgl/draw/draw_raster.ts#L114-L140)、[raster fragment](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/shaders/glsl/raster.fragment.glsl#L21-L35)

**影响推论：**两张相同、不透明白图在黑底、t=0.5 时，独立正常 alpha blend 得 `0.5 + 0.5*(1−0.5)=0.75` 白，而一次 mix 应一直为1白；若父子任意一张被其他 depth/visibility 路径挡掉，更不能达到正确的1白。不同颜色时还引入 draw 顺序偏置。当前已有 slash-source fade 用例只覆盖单瓦片 self-fade，不能检验父子合成。

**复现建议：**用父子同色图消除分辨率/图片内容影响，长 duration、zoom-in/out各一个代表用例，逐帧捕获像素和真实 parent/child material fade；上游输出应恒定而项目可能先变暗再恢复。本轮未运行此 GPU 用例，故仍为源码和合成方程支持的候选，未标记像素确认。

## 4. P1：extrusion pattern 墙面丢失高度/边距坐标，纹理沿垂直方向退化

**位置：** [extrusion-geometry.ts](../packages/cesium-vector-tileset/src/render/vector/extrusion-geometry.ts#L364) 仅把 x/y 写入 `tilePositions`；[pattern-renderer.ts](../packages/cesium-vector-tileset/src/render/pattern/pattern-renderer.ts#L1269) 把墙面和屋顶统一交给 `surfaceGeometry → patternUVs`。

顶部和底部墙顶点拥有相同 x/y，于是 UV 完全相同；没有读取 bucket 中真实保留的 `a_normal_ed.w` edgedistance，也没有把 elevation 用作墙面第二纹理轴。上游 roof 使用 a_pos，wall 使用 `(edgedistance, elevation*u_height_factor)`，明确区分两个面。[上游 pattern extrusion vertex](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/shaders/glsl/fill_extrusion_pattern.vertex.glsl#L104-L115)

**实际复算：**真实 `FillExtrusionStyleLayer`、`FillExtrusionBucket.addFeature` 构建 z14 的80m四边建筑，真实 `extrusionBucketPrimitives` 输出21顶点/10三角形；对真实 top/base pair 执行生产 `patternUVs`，多组 pair 的 UV 均完全相同，例如两端皆 `[262145.1875,262144.375]`。这是0–80m垂直纹理轴的退化证据，与高 zoom Float32 精度问题独立（即使双精度也退化）。

**复现建议：**非纯色 sprite、斜视80m建筑，比较墙面竖直条纹重复和拐角水平相位；不要使用现有1×1纯色 pattern fixture 验收纹理映射。保留 roof 的世界相位，wall 单独使用 source edgedistance/elevation，并考虑 globe subdivision 对这些源量的插值。

## 5. P2：extrusion pattern 绕开 light 与 vertical-gradient

**位置：** [pattern-renderer.ts](../packages/cesium-vector-tileset/src/render/pattern/pattern-renderer.ts#L247) 直接 `material.diffuse=patternColor.rgb`，L445 使用 `flat:true` 的 `EllipsoidSurfaceAppearance`；L1269 调用 extrusion 提取时未传 lighting；pattern geometry key 也没有 light/vertical-gradient。

项目只把 pattern RGB/alpha/opacity 交给扁平 surface appearance，既没有导出 face lighting stream，也没有 light uniforms；改变 style light/intensity、vertical-gradient 对这条轨道没有对应作用。上游 pattern shader 按 face normal/light 算 directional term，wall 再应用 vertical gradient，然后 texture 与 `v_lighting` 相乘。[上游 pattern lighting](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/shaders/glsl/fill_extrusion_pattern.vertex.glsl#L117-L136)、[上游 pattern fragment](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/shaders/glsl/fill_extrusion_pattern.fragment.glsl#L39-L41)

**复现建议：**使用白色 sprite（单独隔离 lighting），改变 light方向/intensity及vertical-gradient，对比同建筑墙面/屋顶真实像素；这是与 solid extrusion 不同的 shader 公式，不应把 solid 的 luminance/ambient公式直接复制过去。本轮为源码确认，未取得 GPU 对比。

## 6. P1/P2：公开接受的 line gap/offset/blur 没有进入渲染契约

**位置：** [feature-attributes.ts](../packages/cesium-vector-tileset/src/render/vector/feature-attributes.ts#L308) 仅返回 color/widthPx；[frozen-line-paint.ts](../packages/cesium-vector-tileset/src/render/line/frozen-line-paint.ts#L20) 只保存 width/color/opacity；[line-renderer.ts](../packages/cesium-vector-tileset/src/render/line/line-renderer.ts#L224) 几何 margin 只依赖 width，coverage L487 使用固定 AA blur。全 render 目录没有读取 `line-gap-width`、`line-offset`、`line-blur`（注释和临时变量的 offset 不是 paint属性）。

**实际复算：**真实 `validateStyleAndEmit` 接受 `line-width:2,line-gap-width:8,line-offset:12,line-blur:4`，无errors；真实 `LineStyleLayer.recalculate` 得 gap8/offset12/blur4，真实 `LineBucket.addFeature` 后 `lineStyleForFeature` 只返回红色/width2。上游 shader gap 决定 inset/outset、offset 参与 projected centerline、blur 决定 alpha ramp，三个是独立真实输出分支。[上游 line vertex](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/shaders/glsl/line.vertex.glsl#L63-L81)、[上游 line fragment](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/shaders/glsl/line.fragment.glsl#L23-L26)

**影响：**gap应形成中空双边道路，项目得到中心实线（P1）；offset12应移动道路中心却不动（P1）；blur4应扩大过渡边缘却仍只有固定AA（P2）。这些属性已有声明及求值、也未像line-gradient被拒绝，故属于静默丢失语义。旧 upstream 研究提到项目支持 offset 的一句话与当前生产消费链不符，不能以该描述代替代码证据。

**复现建议：**每个独立分支一个代表设置，顶视直线先比较中空覆盖/中心位移/alpha剖面；再复用既有倾斜、dash/pattern家族用例验证共用契约。扩展实现前确认产品范围；若暂时不支持应像line-gradient在入口明确拒绝，避免“接受但忽略”。

## 7. P2 性能候选：pattern extrusion 同步耗尽可暂停提取器

**位置：** [pattern-renderer.ts](../packages/cesium-vector-tileset/src/render/pattern/pattern-renderer.ts#L1269) 调用 `extrusionBucketPrimitives`；[extrusion-geometry.ts](../packages/cesium-vector-tileset/src/render/vector/extrusion-geometry.ts#L199) wrapper 同步循环 `iterateExtrusionBucketPrimitives` 并跳过 undefined yield。`stepPatternBuild` 的 resume目前只覆盖fill，extrusion整层仍在一个调用内走完并构造全部primitive。

这会把提取器本来每4096个triangle/vertex的主动检查点消耗成普通同步循环，frame budget只能在整层返回后恢复控制；与上一轮“Native cold resource upload不可中断”的候选不同，这个尖峰发生在调用Native update之前。上游 bucket/Worker布局提供构建和渲染边界，Cesium `asynchronous` 参数也不能暂停项目自己已执行的同步CPU循环。[MapLibre extrusion bucket](https://github.com/maplibre/maplibre-gl-js/blob/72927301b7594536630d896c45c64c4d0d4c587f/src/data/bucket/fill_extrusion_bucket.ts)、[Cesium Primitive update](https://github.com/CesiumGS/cesium/blob/b8d3a36fe98a3e432eb89253c95d5f20e605e0f1/packages/engine/Source/Scene/Primitive.js#L2084-L2146)

**实际复算：**3000个真实bucket四边建筑，CV/z14输出63000 vertices；可暂停iterator返回3000 geometry和7次undefined检查点，wrapper在同一调用返回全部3000 geometry，丢弃7次暂停。一次warm Node运行16.714ms；这只是该机器该输入的一次算法样本，不能视作浏览器P95、帧率或优化收益。

**复现建议：**高负载非纯色pattern建筑，用现有frame profiler记录 `stepPatternBuild` 整次耗时及输入triangle/vertex规模，再保存iterator进度并以预算停点推进。取消/完整提交/旧generation交接需要复用既有协议，不能先发布半层。

## 当前结论边界

上文保留首次取证及各阶段资格，以下2026-10-14进展替代旧的“尚未修复/尚未GPU验证”状态；全部原始数据与限制见 [累计审计记录](comprehensive-audit.md)，不能将某一局部通过扩大成完整项目验收。

| 已登记项 | 当前状态与边界 |
| --- | --- |
| 图案世界相位/实际style zoom尺度 | 已修并有独立非整数zoom、source/style级别分离的真实GPU证据；高zoom Float32精度与整数资格分别记录。 |
| maxzoom raster配对及父子混合 | 已修，父子单draw混合、合法部分缺图、公开opacity与退休资源有CPU和真实GPU证据；原双draw候选已取得红→绿，不能继续列成未实施。 |
| extrusion pattern墙纹理/lighting | 已实现并有实际非纯色sprite和Native几何/GPU资格；少量过渡边缘残差保留，不能声明全部像素完全一致。 |
| line gap/offset/blur | 已进入solid/dash/pattern与live/frozen paint合同并有对应GPU回归；原静默丢失已修。 |
| pattern同步提取尖峰 | 已纳入可暂停构建与现有预算/取消/交接合同；局部样本不作为完整帧率收益。完整场景公平数据单独记录。 |
| 合法名称及上游style diff | 本项目字典已修；按用户要求移除上游补丁，保留原版 style-spec 的特殊名称 diff 重建限制。此前带补丁发布包的 identity 验收不再适用于当前无补丁产物。 |
| variable-anchor漏放/多justify重复绘制 | 五生产文件的四组严格隔离硬件红→绿；预算内同mask切anchor动态同步和optional fit icon的text overlap预检也已真实CPU红→绿。最终六项正式symbol硬件集成通过；mixed text/icon plane及真实球面其他残差仍未资格。 |
| 高zoom相机交接覆盖爆量 | 已修cached nadir LOD配current tilted frustum的爆量；deferred保留确认IDs，postRender用本帧同算法刷新并唤醒。连续相机及恒定zoom平移CPU通过；zoom25/pitch85三组隔离硬件mask/中心差均0，无Set溢出。 |
| fill/outline translate | 静态消费者缺口仍未修；需覆盖真实buffer移入/原tile裁剪、pattern相位和CLAMP lookup域，不以仅内部多边形控制替代完整语义。 |
