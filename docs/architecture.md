# Primitive MVT 适配结构

公开入口是 `CesiumVectorTileset`，负责样式与渲染资源生命周期；瓦片解析、样式求值、几何构建和绘制各自集中在以下目录，不向用户暴露内部调度对象。配置合同集中在 `tileset-options.ts`，图片输入与统计结果使用 `tileset-types.ts` 中的命名类型。URL 工厂调用 `style/load-style.ts` 处理请求转换、取消与响应结构检查，Style 继续负责完整样式语义验证；公开类保留初始化与帧内协调顺序。

发布包只有一个公开 ESM 入口及其类型声明。tsdown 分别处理主线程入口和 Worker 多入口构建：主线程将 Cesium 保持为外部 peer；瓦片 `worker.mjs` 和几何 `geometry-worker.mjs` 打包其 CPU 处理所需的依赖，使用默认代码拆分共享模块，不依赖文档的 import map。各线程分别拥有运行期对象，Worker 入口和其余发布模块保持相对位置。Node 22.13+ 的 `import` 与 `require()` 加载同一公开入口，构造器和 Worker 池不会因模块格式分裂。主线程拾取和 feature-state 使用 Worker 生成的 FeatureSnapshot，不再保存原始瓦片字节并重复解码。MLT 依赖在构建时纳入发布产物，避免其扩展名缺失的内部导入交给消费者运行时解析。

| 位置 | 职责 |
| --- | --- |
| `style/`、`source/`、`tile/` | MapLibre 样式语义、数据请求、瓦片父子替代与缓存 |
| `data/`、`symbol/` | Worker 中的 bucket 构建、文字整形与符号数据 |
| `data/bucket-runtime.ts` | 主线程与 Worker 共用的传输数据、paint 更新和运行时方法 |
| `assets/` | 样式图片、字形来源、图集及共享 GPU 图集纹理 |
| `worker/` | Worker 创建、通信、共享池与显式传输注册；不在导入时修改第三方构造器 |
| `render/scene/` | 场景覆盖、图层索引、帧预算、发布队列、驻留、命令准备与资源交接 |
| `render/vector/` | 矢量瓦片的转换、分步构建、paint 更新及 Primitive 所有权 |
| `render/line/` | 道路线条、几何布局、裁剪及位置纹理 |
| `render/symbol/` | 符号几何、碰撞排布、可见性提交与绘制 |
| `render/pattern/`、`render/raster/` | 图案和栅格的几何、材质、绘制及退役缓存 |
| `render/geometry/` | 各类渲染共用的坐标转换、细分及 Primitive 准备 |
| `util/` | 按用途命名的错误、数学、对象、图片、事件与请求函数 |
| 根目录 `src/` | Vue 演示、CesiumWidget 配置与地图层加载；不属于发布库入口 |

`TilePyramid` 选择每个来源的理想瓦片，管理加载、父子替代与离屏缓存；`ActiveTiles` 保存仍参与调度的瓦片，包含加载中、替代和等待淡出的瓦片。`SourceRenderSync.updateSource()` 更新来源选择与 feature-state，按栅格、图案、驻留的顺序同步渲染输入，并缓存输入身份与修订；栅格图片尚未就绪时继续重试。`TileResidency` 负责场景资源的显示、暂留、退役、恢复与替换交接，不保存栅格或图案的输入修订。`VectorTileRenderer` 提供开始、推进、丢弃、提交构建及 paint 更新的方法；构建器和 paint 更新器是私有实现，调用方不直接操作它们。请求转换使用可选 `RequestTransformFunction` 和 `transformRequest()` 函数，默认沿用原 URL。图片请求保留并发队列、取消及解码，不维护没有调用者的额外节流控制。

模块的实际调用方、状态归属及保留或合并理由见 [模块职责核对](module-responsibilities.md)。

3D 面与圆点按样式图层使用 Cesium 原生 Buffer collection。线、图案、建筑与符号使用 Primitive；普通建筑在各模式共用 Native Geometry 管线，面、点与图片图案保留各自的模式路径。Cesium 1.146 的原生 Buffer collection 仍有模式与实验性接口限制，因此不能直接删除这些路径。MVTDataProvider 的 vector glTF/3D Tiles 路径也不能替代 MapLibre 样式求值和符号排布。

bucket-geometry 集中拥有面/线/点的投影、缓存和 Worker 分派，不再另设只转调这些函数的投影模块。普通面直接产出位置和索引，不生成无人消费的图案坐标，也不在传输前重建一份删字段的对象图。图案显式请求 tile XY；已有普通面时复用它的位置和索引。细分器已经生成去重后的顶点与索引，投影直接写最终 typed arrays，不再创建动态坐标数组、第二份坐标字典和索引重排。

投影几何和原始线坐标使用按 bucket 打包的 owner 与 typed metadata 传输，wire 对象及 view 数量不随要素数增加。主线程先恢复 owner list，消费要素时才创建稳定的共享子视图。填充轮廓在 Worker 预计算，平面原环与球面舍入细分环分别拥有真实模式消费者；不能以“额外采样共线”为由混用。轮廓高度偏移与道路共用 shader 位移，保留源坐标及包围球扩展。

paint binder 只传输要素属性与求值参数，不重复传输表达式 AST。瓦片发布前绑定场景当前编译图层。来源的解析代次在结构性样式修改时立即失效，load/reload 共享一个可取消请求租约，旧响应不能先卸载当前内容再绑定新结构；Worker 图层确认和当前 paint 结构一致后才能消费最新结果。默认过渡中数据驱动值变为常量时，旧 paint 保留期间不会提前发布常量 bucket。取消信号沿 WorkerChannel、load/reload、parse 和依赖请求传递，旧租约清理只影响其实际 owner；共享素材缓存的生命周期独立于单个瓦片。

线条编译的同步与分帧调用使用同一生成器，长路径按 32 点推进，短路径由源与 chunk 边界计费；未完成几何不进入缓存。填充径向位移和 Buffer polygon 装配也可在一个要素或一个图层内部暂停，只有完整阶段才交给发布队列，取消时销毁已分配但未发布的集合。相机覆盖和样式准备计入同一物理帧的 tile 工作预算，多个 Cesium viewport 复用 deadline；该预算不等于整个 Scene 的耗时上限。

GeometryPrimitive 的冷准备只由 SceneCollections 的预算上传阶段推进。主线程按预算复制并传输独立几何输入，几何 Worker 执行 Native combine、坐标记录编码、属性压缩与位置纹理打包；回复只保存结果，后续预算推进 Native VA、shader 与上传。普通 collection traversal 只绘制可用的 owner。paint 与首次准备共同获得执行许可，paint 耗尽 deadline 后仍推进一个有界准备单位，避免连续相机变化造成停滞。实际 WebGL 资源创建和单次 Native Buffer add/update 仍是不可中断调用；新代次只有在完整上传及 Native afterRender ready 后才接管旧 owner。缓存瓦片恢复时，尚未 ready 的集合重新加入首次准备队列；已上传集合保留原 owner 并直接绘制。

初始加载和公开样式替换共用全样式验证：先用 MapLibre 校验，再用其 `derefLayers` 解析继承类型，拒绝没有 Primitive 渲染消费者的 `line-gradient`，在创建或修改任何来源、图层之前通过上游 `ValidationError` 报错。初始 readiness 拒绝，已加载样式保持完整。生成器排除该属性；不再构造 ColorRampProperty、注册其 Worker 传输类或维护无人读取的梯度版本状态。

`WorkerChannel` 自己持有 MessageChannel，每个消息轮次启动一个队列项，让取消消息有机会到达；异步处理可以并行等待，后续响应能解除前面请求的等待。移除通道时关闭两个端口并取消请求。共享池的惰性入口直接位于 `worker-pool.ts`，不另设只有一个 getter 的文件。

WorkerChannel 接收端消费浏览器已经克隆的消息对象树：数组与普通对象原位恢复，注册类在字段恢复后设置本地原型并运行现有 restore。专用 StructArray codec 仍创建必要的实例与 view，FeatureSnapshot 的 shallow 用户值仍按原生克隆传输；发送端继续构造独立 wire 图，保留 Worker reload 所需源数据。恢复不支持重复消费同一 wire，没有额外循环图协议或全局注册状态。

事件只描述样式、来源与图片实际发出的信号，不承接 Cesium 场景的相机、terrain、projection 或 WebGL 生命周期。具体事件直接继承 Event；来源直接使用 SourceEventType，不增加类型适配层。内部只接受事件对象，公开错误统一为 Error，已有 Error 保持身份。无人消费的 MapLibre 相机/求交工具、VideoFrame/OffscreenCanvas 像素读取链和空样式更新钩子已删除。

Buffer 面的透明度变化直接更新原生 `blendOption`。Buffer 圆点始终使用 Native `TRANSLUCENT` 混合：原生 shader 把抗锯齿覆盖率写入 alpha，即使填充和描边都是不透明色，边缘仍需要混合。圆点 paint 只更新原集合的材质与可见性，不再维护不透明分类。Native renderer 根据自己的 command.pass 判断混合状态变化；样式顺序规划使用缓存的 Native DrawCommand.shallowClone，保持原命令的 pass/renderState 所有权。源命令 dirty 时刷新该缓存，稳定帧复用同一个规划命令及派生拾取命令。圆点的可见性同时考虑填充和有效描边宽度；最终零透明度的颜色清为零 RGBA，避免 Native 描边插值带入透明颜色的旧 RGB。

命令规划和 line family 共用 `ReplayDrawCommand` 的 Native 字段结构，分别保留自己的更新策略：规划副本比较源字段并保护最终提交状态，family 副本保留自己持有的 uniforms、owner 与 batch table。每个 tileset 持有一个 DrawCommands。第一遍过滤交接遮罩并准备 Native 命令，第二遍原位裁剪符号并收集排序项；不再通过反复 splice 移动后续命令。排序记录以实际输入 command 为弱引用 key，每帧刷新图层与瓦片排名；临时数组复用后在 finally 清空，不持有退役 owner。可见性直接保存图层 ID 与布尔值，不使用分隔符编码；状态未变时保持快照身份，避免无效重发布。光照值未变时复用已有值对象。

Native BufferPoint / PointPrimitive 的填充与描边原本分别插值 RGB 和 alpha，两个透明度不同时会产生颜色交叉项。命令规划在 Cesium 1.146 的原 fragment shader 上派生颜色插值：先混合预乘贡献，再除以合成 alpha，以继续使用 Native 的 straight-alpha blend。保留原几何、抗锯齿覆盖、discard、gamma、pick 与 log-depth；原命令和原 shader 不被替换。衍生 shader 通过 Native ShaderCache 挂到原 shader，随其最终释放递归销毁。依赖的 shader 语句变化会明确失败，需要更新适配及像素回归。SDR 的逐通道覆盖语义有真实 framebuffer 验证；HDR 保留 Native gamma / tonemapping，其颜色比例不使用 SDR 的线性断言。

标准 PointPrimitive 的颜色更新直接赋给 Native setter，让它自行 clone 并标脏。先 clone 到 getter 返回的 Color 会让 setter 误判为相同颜色，CPU 已变而 GPU 不更新。Native 二维点集合在 paint 后可自动改变 buffer usage 并替换 VAF；生命周期验证检查旧 VAF 释放，而非要求它跨更新保持同一对象。BufferPoint 的原 VA 则继续复用。

## 所有权与更新

符号相机输入由 `render/symbol/symbol-frame.ts` 从同一冻结 CameraFrameSnapshot 构造，集中处理地球遮挡、ECEF→实际 Scene 投影、2D 世界 wrap 和 scratch 复用。公开类只安排 renderer 更新、排布预算与后续帧唤醒，不再内联这些坐标规则。

预算同步直接遍历各 renderer 的 live/held/fading/retired 所有者，通过 `visitMemoryEntries` 报告给预算已有的 tracked map；主线程不再创建 renderer entry 数组、第二份命名空间 entry 数组或 retained/evicted 镜像 Set。Scene tile 清理查询同一 tracked map；完整报告的 seen Set、pinned recency 和 retired oldest-first 顺序仍是预算合同。

同坐标的旧代次可以与新代次共存。结构样式变更冻结旧代次的 paint；新内容提交后仍正常接受 paint 更新。交接先完成数据构建、Primitive 更新及符号排布，再在帧后释放旧资源。连续切换时，尚未显示的中间代次应取消并释放。

面构造记录在surface轨道完成后即断开，Native Geometry或Buffer集合已接管其输入；建筑直接由自身 bucket 构建，不再转换成另一份平面 polygon 列表。点构造记录由vector build持有至对应构建完成。日常 paint 直接使用 Native Buffer 的公开 get/pickObject 或 standard entry/PointPrimitive 的 id，不保存第二份拾取索引。必要道路中心线继续保留，以便宽度与虚线变化时重建。Surface record 不接收尚未发布的道路；最终 append 交接运行期数据，取消 detail 保留已发布 surface 的资源与 paint。偏移几何缓存属于一次 convert/pattern build，同次构建共享，完成或取消后断开；不清空 Native/source 仍拥有的数组。

Pattern staging 不自动销毁 Primitive，取消构建负责销毁已封装但未发布的 Primitive 并断开悬停输入。每个 pending geometry group 已持有一条 material 引用，seal 直接交接，abandon/跳过失效输入时归还；材质最后一条 live 引用移除不会提前销毁另一个 pending group 正在使用的材质。Atlas build hold 独立保有共享纹理；commit 交接 entries 数组后替换 build 字段，不截断 live tile 的数组。

栅格已解码图片在私有Material子类的第一次update中创建Native Texture/Sampler，再调用原生Material.update立即接管纹理；不依赖同一帧的第二次update消费Native图片上传队列。sampler读取当前原生过滤属性，纹理翻转与alpha保留Native默认值。未绘制的取消仅释放pending source，不分配GPU资源；已接管的纹理由原生Material.destroy销毁。动态copyFrom与视频的Native更新路径保持，几何ready不替代图片纹理就绪。Texture/Sampler及Material.update的缺失类型只在raster-renderer局部声明，不做全局扩展或能力猜测。

源准备、首次 Native 更新、几何构建和普通 paint 遍历共用每个物理帧的 12 ms 协作预算。同一 frameNumber 的日期线双视口继续使用同一个 deadline；图像 render callback 的 beginFrame 也只执行一次。源覆盖确定后先准备已提交资源，再用剩余时间构建新资源；队列深度不增加时间额度。新资源入队时请求下一帧，避免 publication、paint 或 raster 替换在按需渲染中停住。必要的显示前 paint 与首次 Native 调用是一个推进单元，不能在两者之间因截止时间而永久放弃上传。原子更新、符号排布及稳定内容绘制仍可能越界，这不是整个帧的硬上限。

首次更新队列区分待准备子项和已可绘制子项。Native ready 在 afterRender 才变为 true；当前调用实际提交过命令的物理 Primitive 已能绘制，因此即使队列尚未完成，也在每个视口提交它的当前命令，不再次执行其首次准备。仍异步 pending 的子项继续受预算限制，整集合原子更新过的视口不重复重放；隐藏替换和隐藏父集合只准备资源，保留原 show 状态并丢弃提前产生的命令。交接与上传字节采集仍等待正式 ready。

符号图像与 sampler 在 Native 命令提交前刷新，避免命令继续引用已释放的旧图集。符号排布完成后单独结算可见性交接，不再执行第二次首次更新；最终父子覆盖仲裁和命令排序仍在全部内容更新之后执行。

符号碰撞由 `SymbolPlacementScope` 统一保存不可变输入、冻结视图、修订和完整结果。当前显示代次、未来替代瓦片与局部交接后的所有者分别有独立 occupancy；三个范围共享每帧 2 ms 时钟，不再限制每帧只能处理固定数量的符号。当前显示范围优先推进；相机变化不丢弃正在计算的代次，完成后再追赶最新视图。空显示范围直接取消过时工作，稳定空帧不重复激活。

`SymbolTileRenderer` 按瓦片内容代次保存当前显示 entry；同一瓦片 ID 的新版内容不会提前代替仍在绘制的旧版碰撞输入。`TileResidency` 独立维护符号显示所有者和地表退役：替代地表准备完成即可交接，符号等待 GPU 上传及整个拟显示范围的碰撞结果后原子切换。覆盖同一区域的旧标签直接退役，平移离开的标签仍可淡出。隐藏图层退出碰撞和命令提交，但保留已构建几何；恢复显示只补齐缺失内容。贴地填充向 VectorProvider 同步实时可见性及样式层顺序；只有集合或顺序变化时重新登记。

按需渲染由 Cesium 的 `prePassesUpdate` 发现挂载和 `show` 变化，异步来源、发布、排布及过渡请求后续帧；移除时唤醒最后一帧并解除原场景监听。稳定状态不再请求绘制。`fromUrl()` 返回前完成初始化，`destroy()` 返回 `undefined` 并使后续公开操作遵守 Cesium 的已销毁对象约束。


同一绘制表示中的道路 paint 原位更新 Primitive 的 uniform 或实例属性，恢复退休几何时先应用当前 paint；单纯修订号变化不重建道路。常量与数据驱动表达式之间的切换需要新的 Worker 属性绑定，使用 MapLibre 已有的 layer update 信号进入代次交接，不能用新表达式更新旧 bucket。

恢复缓存与日常 paint 遍历共用同一个单 record 刷新实现。恢复所有权时先刷新当前 paint，再显示资源；首次上传、部分已上传子项的绘制与已上传代次的可见性交接也在 Native 命令前刷新对应当前 record。必要的材质与实例 paint 写入可以在 publication 耗尽预算后完成；几何重建共享帧预算，并通过 ready 返回是否准备完成。集合到 tile ID 使用弱引用映射，并核对当前 record 仍拥有该集合，避免触碰旧代或退役资源。标准面和道路使用同一个实例属性接口：Native 批表创建前复制到构建属性，批表创建后直接使用 Native accessor，无需等待 ready 或额外 paint 重试状态。Native 会在 afterRender 设置 ready 之前提交第一批命令，所以当前颜色和 show 必须在首次命令前写入。真正的几何替换继续由既有 replacement/firstUpdate 交接隐藏；普通多 record paint 遍历仍受帧预算限制。

日常 paint 遍历先核对冻结、输入与当前求值缓存，再对确实需要的要素工作检查预算。首次上传准备已刷新全部 record 时，下一帧即使预算耗尽，也能完成廉价缓存核对并清除 continuation，让新源在帧后交接；仍有未刷新的 record 时继续保留 dirty 与旧覆盖。单 record 强制刷新不自行清除全局 continuation，不建立第二套待处理记录状态。

StyleEvaluation 每次 evaluate 产生一个独立身份，日常更新、恢复和首次上传准备共享它。record 仅在身份及 zoom、styleRevision、paintRevisions、pixelRatio、lightRevision 全部匹配时跳过重复 force；预算跳过和冻结记录不写已处理身份，新增 detail 的未定义 styleRevision 仍触发刷新。刷新一个 record 不再无条件设置全局 dirty；commit、append、restore 和 feature-state 继续在实际所有权或数据变化时 invalidate。常量道路构建不逐 feature 求被丢弃的 paint，按 chunk 设置初始 uniform；数据驱动实例仍逐 feature 求值。

构建开始时按唯一 bucket 保存 paint revision，提交时复用该快照标记已求值样式。转换与 Native 准备跨帧期间若 feature-state 改变，首次上传据此识别旧缓存并应用当前颜色；不能在提交时用最新 revision 标记先前构建的值。标准集合保留首次 paint 遍历，detail 追加继续使旧 record 的样式状态失效。构建只持有一份 TileRenderResult，已消费的 polygons/points 在对应阶段结束后清空；commit/append 接管后释放结果，live record 只保留实际需要的中心线和图层信息。

廉价输入检查直接比较 bucket 修订号，不创建比较用数组；修订未变时复用已有快照，实际变化时才取得新快照。修订包含各图层的普通 paint 修改、过渡求值和 ProgramConfiguration 的 feature-state 更新。标准和 Buffer paint 完成后共用一次状态记录。同一 evaluation 内的修改仍须重新应用，不能只按 evaluationId 跳过读取。挤出缓存只比较 FillExtrusionBucket 的修订、相关 zoom 和光照，不绑定全局 styleRevision；其他图层的普通样式和 feature-state 修改均不重建建筑。

paint 缓存只保存求值输入与修订标记，不再按图层和要素保存另一份样式对象及 Color。命中时跳过要素遍历；失效时直接求值并写入 Native material、实例属性或 PointPrimitive setter。标准面 entry 保存 Native Color.toRgba() 的整数值，用于比较实际上传的四个颜色字节；show 独立比较，保留零 alpha 与小于一个字节的正 alpha 的可见性区别。只在值变化时调用实例属性接口；Native 构建属性和 batch-table setter 同步复制共用 scratch，不持有该 scratch，也不需要每要素 Color 克隆。detail append 无条件使该 record 的 paint 缓存失效：surface 在构建间隙已刷新到最新 feature-state，也不能证明刚追加的点使用了最新颜色。

样式引入不同 source ID 来替换旧源时，TileResidency 保留旧可见资源、样式顺序与拾取索引，并过滤新源尚未整体完成的命令。数据、Native 上传与 paint 完成后，在颜色帧 afterRender 释放旧源并请求新帧，避免提前销毁旧标签 atlas。连续切换会清理尚未显示的中间源，恢复旧 ID 会重新保护其加载期间的覆盖；仅删除来源或切到背景样式仍立即清理。该交接不建立任意来源间的 tile ID 别名。

同一来源 URL 的结构更新也需要源级交接。宿主复用 MapLibre 的 source reload 标记，保留旧视野覆盖；新 LOD 的 Worker 重解析空窗不能仅凭暂时没有发布任务便视为可替代。CPU 瓦片和场景资源都就绪后再释放旧覆盖。

地表替换按父子覆盖集合交接：父瓦片仍被调度器需要，或覆盖它的子瓦片尚有地表构建、首次 GPU 更新时，保留父地表。调度器新选中的父瓦片自身尚未就绪时，不能反过来遮蔽现有子覆盖；否则双向替代会把双方同时隐藏。完整替代集合可绘制后一起切换，避免半透明父子同时显示造成颜色加深。首次 GPU 更新前同步可见性，隐藏集合上传时不向该帧提交绘制命令；符号排布不阻塞已经完整的地表交接。

覆盖交接还必须遵守实际图层所有权：旧父只有水面时，不能遮蔽子瓦片新增的建筑。集合构建、追加与替换时缓存 DrawBatch 的 layerId；完全被遮蔽的集合使用外层 show，混合集合在帧命令计划中剔除相应图层的 render/pick 命令。内层 Primitive 保持可上传，避免隐藏状态阻止首次 GPU 更新。同层覆盖继续原子切换，新增图层可以独立显示。

多个保留层级按粗到细仲裁；已被祖先遮蔽的同层不能反过来遮蔽祖先，否则三个就绪层级可能全部消失。粗 owner 的共享层遮罩也传播到已离开 renderables 的旧 held descendants，避免后者反向遮蔽粗 owner。SceneCollections 根据现有首次更新队列和代次交接提供实际可绘制资源：尚未准备的新集合不取得覆盖所有权，部分上传仅提供已可绘制子项，pending replacement 保留旧代次；上一帧 show 不作为上传就绪依据。发布队列按当前视点到瓦片矩形的最近距离排序，同距时先处理细级别；日期变更线取最近世界副本，极点相机投影到 Mercator 边界。地表阶段仍先于详情，沿用现有帧预算与提交上限；空队列不读取相机或计算优先级。

覆盖查询直接遍历 renderer 的资源所有者，由 SceneCollections 排除未交接的新代次、展开可绘制子项并访问同瓦片的全部旧资源。存在性查询可提前结束，图层收集完整遍历；地表与符号就绪分别检查，不复制资源数组或创建就绪结果对象。发布和退役仍取得必要的资源快照。层掩码是隐藏地表的唯一状态，符号独立管理；held 变化保留源覆盖记录，manager、可渲染集合或模式变化才使祖先查询缓存失效。祖先 key 使用 TileID 的现有直接计算方法，保留世界副本语义；无父子重叠的瓦片不查询 drawable。

TileResidency 保存一份地表层遮罩与符号隐藏集合；每次策略计算后，SceneCollections 通过 `syncTileVisibility(current, previous)` 遍历一次待替换资源 registry。当前受遮罩及需要恢复的瓦片都处理，同瓦片每个独立旧 owner 均保留；未涉及的 owner 保持原状态。相同遮罩也重新应用，以覆盖两次策略调用间新增的 owner。部分遮罩继续由帧命令计划逐层过滤，隐藏的新代次完成上传后按原交接语义显示。源同步重置共用该恢复路径，不建立第二份可见性缓存。

退役 GPU 缓存的容量来自源的瓦片缓存容量，并受 GPU 驻留预算限制，不随某一帧的可渲染瓦片数量缩小。3D 相机变动后的首帧可以用视锥内已加载的同级瓦片补充上一帧地球覆盖，下一次地球渲染后回到实际地形选择；该补充不请求尚未加载的瓦片。相机位置精确比较，方向使用 Cesium 的小量容差，避免归一化舍入误差使静止场景持续重绘。

Globe postRender 先比较 Native 瓦片 keys 与 Globe 身份；选择未变时不读取并克隆 rectangle。真正变化时仍复制和冻结坐标，不能借用随后会变化的 Native 对象；即使 keys 未变，相机补充覆盖的结束仍按原合同请求交接帧。

各渲染轨道的退役缓存可以独立失效。曾实际发布符号的瓦片，回视时若只有地表缓存恢复，必须补建同一代次的符号详情；历史“全部发布完成”不能代表当前 GPU 资源仍完整。空符号瓦片不重复进入构建，恢复详情也不替换已有地表几何。

共享图集拥有真实 Texture，Material 持有不负责销毁的采样引用；最后一份图集引用释放时销毁 Texture。Style 销毁通知不等待已移除的 WorkerChannel 响应；Worker 按源取消下载、解析依赖与共享父瓦片请求，再释放缓存和 map 状态。其它 Style 可继续使用共享 Worker，最后一个 Style 销毁时释放池；全局资源请求 dispatcher 不长期占有池。`tilesLoaded` 同时考虑数据加载、发布任务、首次 GPU 更新、paint 续作与符号排布。

样式快照保留已接受的 JSON 根属性，sources 和 layers 则由当前源管理器及 StyleLayer 序列化。根属性白名单会漏掉原有 sky 等配置，使 MapLibre diff 把未改变的设置误判为新操作。保留声明不表示新增天空渲染能力：Native 相机、投影与天空继续由宿主管理，真正不支持的样式操作仍在任何变更前明确拒绝。全局 state 保留声明的默认值，不用运行时覆盖值替换它。

Sprite 请求由 Style 的一个 AbortController 拥有；切换、移除和销毁都会取消或替换它。已排队的旧回调按请求身份失效，不修改当前图片、加载状态或广播。多个 sprite namespace 也使用完整当前声明加载，避免把追加误当成全量替换后删除其它图片。

## 引擎耦合与验证范围

2D 使用 preRender 的完整正交相机四角与 CSS 尺度选择 MVT；日期线分屏共享同一快照，不以地形几何 LOD 限制源层级。3D/Columbus 覆盖继续读取 Cesium 地球实际渲染的 `_surface._tilesToRender`，相机快照读取 `_frameState`；地形贴合使用 `scene.vectorProvider`。Texture、Context 和 ContextLimits 在运行时导出，但部分缺失于 Cesium 类型声明。这些耦合集中在 backend，升级引擎时需运行覆盖、地形贴合、纹理所有权与发布产物浏览器回归。

同一 scene 改变模式时撤销 globe readiness，MORPHING 与新模式首次 Globe.render 之前保留原源覆盖。新模式 postRender 完成后请求一次交接帧，即使前后地形瓦片 ID 完全相同，也必须重新确认；正常静止帧不继续请求。

Worker 的五类 bucket 构建器继承共用 runtime，由 `worker-tile.ts` 按图层类型创建；StyleLayer 不再拥有创建几何的工厂。传输注册使用共用 runtime 的构造器与原有 wire 名，Worker 子类沿构造器原型找到同一注册，主线程反序列化后保留 paint/state 方法。主线程静态依赖图不再引入多边形构建、线条布局或文字整形算法。

共享 MVT Worker 池统一监听 error/messageerror，锁存首个失败并只终止一次。每个 WorkerDispatcher 订阅所属 Worker 的失败，WorkerChannel 用同一个普通 Error 拒绝所有待处理与后续请求，Style 通过已有 ErrorEvent 报告；后来加入的客户端收到已记录的失败。正常销毁继续使用 AbortError，健康 Worker 继续工作；失败 Worker 不重试或重选。Vite 启动前扫描 Worker 入口，避免运行中重新优化依赖使已启动的 Worker 收到旧模块 URL 的 504。

演示在 `src/app.vue` 直接展示 CesiumWidget 创建、`CesiumVectorTileset.fromUrl` 与 `scene.primitives.add/remove`。当前实例、加载取消、错误、credits 和卸载清理由该入口持有；移除也取消尚未完成的加载。`preset-catalog.ts` 保存统一的相机姿态与样式目录，`demo-selection.ts` 只解析与序列化配置 URL，`scene-config.ts` 保存原生选项与坐标转换。CesiumWidget 管理 canvas、渲染循环、resize 和浏览器事件，FPS 始终开启。

`config-panel.vue` 选择预设、地图样式和场景模式，支持自定义样式地址及添加、移除；视角可通过 Cesium 相机手势继续调整。`camera-readout.vue` 在真实 postRender 后读取当前相机经纬度与 heading/pitch/roll，不把预设值当作当前状态，也不为读数请求渲染。2D 的 camera.positionCartographic.height 按 Native 语义显示为正交视野宽度；切换模式的中间状态不显示旧坐标。

demo 保持 `unplugin-cesium` 的原有集成，由插件管理 `CESIUM_BASE_URL` 与 Workers、ThirdParty、Assets、Widgets 静态目录。样式只引入 shared.css 和 CesiumWidget.css，保留原生 FPS、canvas/touch 与 credits 样式。必要引擎资源保持完整，包括 Globe 地形 Worker、拾取 Worker、天空与默认署名图片；生产浏览器回归检查资源响应、FPS 数字及样式和署名图片加载。

道路使用统一的 Native Primitive 布局。唯一源 ECEF、canonical 展开经度、源顶点索引和闭环信息由 geometry 的 WeakMap 持有；保留完整 incoming/outgoing 角色，供三维近裁面裁剪使用。开放端点分别在 ECEF 和实际 Scene projection 中先镜像 DOUBLE 点，再写最终 FLOAT 邻点；不创建普通 join 索引或二维 alias/remap 数组。

`geometry-primitive.ts` 将实例矩阵通过 Native GeometryPipeline 折入独立的世界坐标输入，保留调用方 geometry 和 matrix。道路的 Native combine 保持 encode-only，防止日期线插值生成分数 record ID 或角色；面保留 Native 日期线分割与 scene3DOnly 合同。投影实例包围球在主线程保留 DOUBLE 中心，并按实际 FLOAT 编码的最大误差扩展半径，避免 Worker 的 FLOAT 球传输损失；Native BoundingSphere.fromBoundingSpheres 形成组合 CV 球，随后由 Primitive 管理轴交换、WC/2D/CV/morph 命令、深度分区、拾取和销毁。batchId 保存为未归一化 UNSIGNED_SHORT，实例数上限为 65,536；道路仍按 512 实例及顶点预算拆块。已验证基线为 Cesium 1.146.0 / engine 26.4.0；包声明的 Cesium peer 范围为 `^1.146.0`，后续引擎变化仍需对应回归。

`render/geometry/surface-position.ts` 在 Native 日期线分割、重排与索引拆分完成后，按整个 Primitive 的最终位置计算各通道共同前缀。high/65536 精确表示 signed 16-bit code；low 直接读取 FLOAT 的 Uint32 位模式，不量化坐标。共同前缀、变动位宽和位偏移属于该 owner 的 uniforms，只有变动位上传为未归一化 UBYTE 属性。所有 Geometry 使用相同字段和属性布局，shader 只随 planar/morph 与 byte lane 数变化，不嵌入瓦片坐标。每个 owner 克隆 Appearance 和 uniforms，保留原 Material，解码后继续使用原 RTE 计算。MORPHING 保留两组位置并用原生 czm_columbusViewMorph 插值，结束后进入 3D Buffer collection。high 不保留零的符号，与原 SHORT 合同一致；low 的位模式逐位保留。

面位置容量取决于最终几何的变动位宽，不再固定为 20/38 B/顶点；上限仍为 planar 20、morph 38 B/顶点，包含 2 B batchId。实际 1024 地块用例为 9 B/顶点。独立 Native FLOAT 全 framebuffer 对照覆盖 2D、CV、真实中间 morph、日期线切分与不同高度，同时验证 paint、pick、owner 隔离、共享 shader 与销毁。该版本完整硬件套件165项通过；当前性能与限制见 [性能基线](./research/performance-baseline.md)。

标准面的拆批成本包含 Native 两份 Float64 输入的头部、逐几何元数据、实例矩阵、位置与索引：`8 × (2 + 40N + Σpositions.length + Σindices.length)` 字节。图层与层内实例顺序保持不变；小几何可以合批，少量复杂轮廓也会拆开。它控制的是序列化输入，不是 GPU 容量或连续工作时间的硬上限。初始闭环 MVT 的 1024 个地块保留五个源顶点，输入为 499,728 B；Native vertexCacheOptimize 删除未引用的闭环末点后，实际 VA 仍为 4096 个 20 B 顶点。数据驱动表达式变更继续遵守 MapLibre 的绑定重解析与代次交接；原位 paint 与身份验证使用常量变化或保持表达式不变的 feature-state 更新。

Native 面批次内部的图层归组、GeometryInstance 与 paint entry 准备逐要素检查同一预算，平面 extrusion 的筛选与已有 paint entries 合并也可恢复。拆批公式、Native 输入、批次数量和全部 fill 完成后才发布 surface 的条件保持一致。未完成 Primitive 立即归 detached collection 所有，封批后才登记完整输入容量；取消会销毁已封批及部分准备的所有 Primitive。单要素 bounds 扫描、构造与封批登记仍是原子工作。

道路转换只准备源拓扑，实际draw owner负责paint求值，不往fill/point运行期style cache写入无人读取的道路样式。planar miter/bevel不创建round fanPoints，也不构造仅3D offsets消费的endpoint mirror。Fill、Circle、Extrusion 和 Line 的 Worker paint 数组按要素存一份值，source feature index 可以稀疏，paint slot 连续。几何归属不从 paint 范围推断：Fill 的每个 polygon/Uint16 分片记录 featureIndex，Circle 和 Extrusion 保存独立几何 ranges。Circle 每个点只传一个 4 B tile-local 中心，不生成 Native PointPrimitive 不使用的 quad、索引或 segment；排序、多点、边界过滤、feature-state、composite 和 pattern crossfade 继续使用原语义。Symbol 的 paint 数组仍按其 glyph/section 顶点组织。

ProgramConfiguration仅保存有实际消费者的source/composite表达式与CPU paint数组；常量留在StyleLayer，不建立空binder或携带MapLibre GL uniform/vertex attribute元数据。Pattern与dash只保留Cesium实际读取的min→mid crossfade数组，feature-state继续更新同一数组。Symbol使用真实CollisionBoxArray与placement，不构建debug框、debug vertex/index或传播恒为false的开关。生成器和main/Worker共同传输注册只保留被使用的数组类型；fill与extrusion直接引用生成的TriangleIndexArray。

道路宽度只求值和传输真实的 `line-width`；原 MapLibre GL shader 使用的 `line-floorwidth` 合成副本没有 Cesium 消费者，已连同专用 property、重复 recalculate、数组和整数 zoom 标记删除。普通 composite paint 继续按相机的分数 zoom 插值；pattern/dash 的 crossfade 整数层级语义由它们自己的 property/binder 负责，不经过这条删除路径。

纯色与图案建筑都注册为挤出几何。3D 实体建筑的颜色和拾取命令保留 Native OPAQUE/TRANSLUCENT pass，不参与地表排序；不透明建筑写入深度，透明建筑使用 Native 混合及拾取流程。图案 Material 在创建时检查其 atlas 内矩形的实际 alpha，不因图集其它位置透明而把不透明建筑误判为透明；3D 图案建筑通过公开 Appearance renderState 开启背面剔除，2D/CV 和平面图案保持原路径。最高的符号图层在颜色帧使用 OVERLAY；当前符号 Primitive 关闭拾取，不能将它的显示顺序等同于已支持标签拾取。

投影几何由唯一 runtime Bucket 的 `projectedGeometry` 持有，类型定义在 `data/projected-geometry.ts`。Worker 解析后直接填入该 owner，WorkerChannel 随 Bucket 转移；主线程的存活图层共用同一个 Bucket。独立的 `layerId → geometry` 映射、Tile.geometry 和跨 publication/build/converter 的 geometry 参数已删除。完整 reload 创建新 Bucket 和 map，publication 继续用 buckets 身份取消旧任务；主线程按模式重建的细分网格留在本地 WeakMap，不覆盖 Worker 的 globe owner。

标准道路先用共用网格遍历计数，再直接写入两块 Bucket 所有的 Float64 缓冲区（ECEF XYZ、源 tile XY）。每条路径只创建一次 subarray，保留其独立范围和原稀疏 featureIndex；family 与 paint 更新复用相同 view 身份。不同世界副本与 overscale 继续共享 canonical 网格。原 linePaths 仍用于 Pattern 和低 zoom planar 网格，未混入 Symbol、Raster 或按层 height/base 构建的 Extrusion。

展开后的道路只在一次构建的 LineGeometryCache 中缓存，family 在构建内共享，提交或取消后释放构建缓存；Primitive 持有上传输入直至 Native 释放。live/retired record 保留必要中心线，普通 paint 与 GPU 缓存恢复不依赖展开数组。Worker fill payload 不携带仅本地 pattern 消费的顶层 tilePositions，也不提前计算描边。标准 line 保留与每个 ECEF 源点配对的 tilePositions，供源经度分支、邻点、虚线相位及端帽使用。

填充 mesh 记录原 polygonIndex 和生成该 mesh 的 subdivision。只有实际可见的描边消费者才从 Bucket 的源 ring/holes 生成路径，并按具体 mesh 身份缓存；共享图层复用同一份路径。描边保留每个 ECEF 点对应的 tilePositions；低 zoom 已细分 mesh 的 holes 不再描述源环，因此描边读取原 Bucket 拓扑。MORPHING 继续使用该 Worker mesh 的原 subdivision，未将二维粒度套到球面网格上。普通未细分 fill 只扫描原坐标检查瓦片边界，不建立没人消费的点元组数组。

道路几何集中在 `line-geometry.ts`，从packed ECEF与源tile坐标直接生成一项Cesium Geometry，不再暴露LineStripBake中间结构或单元素Geometry数组。LineGeometryCache固定canonical tile上下文，按两份源数组身份、布局与实际planar状态在一次构建内共享。连续源点复用原backing，闭环末点通过view去除；内部重复过滤才复制存活源点。全局最大点数Cartesian缓存、逐点role对象与动态索引数组已删除，虚线距离和经度逐点计算，round fan使用固定Cartesian scratch；索引采用Native IndexDatatype精确预分配，顶点与三角形同遍发射，保持原triangle顺序及round end的provoking vertex。展开DOUBLE ECEF仍参与Native bounds，不把它当作未消费数据删除。

道路始终构建单位宽 strip，实际宽度和 miter limit 在 Native instance table/uniform 更新。emit 直接生成最终 UBYTE flags，fan 参数先按原合同 Math.fround。所有模式保留独立 incoming/outgoing 角色，保证同一已上传几何在三维近裁面仍可绘制；短段、折返、closed dash 首点与端帽/fan 保留原角色。最终属性在 Native combine 返回后压缩。输入为 ECEF 与明确源拓扑，实例矩阵由 Native 转换独立世界坐标；表面保留球裁剪，道路按扩张语义关闭。

道路、标准平面面、实体建筑与 3D 填充轮廓共用按 Cesium context 管理的 TaskProcessor 和几何准备队列。主线程按最多 512 个实例及 512 KiB 逻辑数据组织复制单位，生成独立 packed owner；队列按实际 transfer 字节合并同一微任务内的小请求，最多保留两批，超限的单请求完整保留且独占一批。容量检查先于原始输入复制，等待时保留已有输入并由首次更新队列重试。几何 Worker 与主线程共用 `primitive-pipeline.ts` 的实际 pack/unpack/combine 合同。Worker 在 unpack 前检查 packedInstances 的 Float64 类型、整数实例数与实际包长度，并核对解包后的实例数；不以 Scene 与 Worker 的 Cesium 版本字符串是否相等判定兼容性。每个请求的 combine 与布局编码在几何 Worker 内完成；批内错误逐请求返回，取消结果不会重新发布。复制单位与批次门限都不是单次原子调用或整个 Scene 耗时的硬上限。

几何 Worker 入口由相对模块 URL 定位，Cesium 的其他静态资产仍由宿主部署。TaskProcessor 负责消息、任务 ID、传输能力探针和 Native 错误还原。CDN 几何任务使用库拥有的局部 Blob import，避免 Native shim 的 URL 生命周期泄漏。主线程冻结公开 modelMatrix，打包实例 metadata，并传输独立的几何 owner；共享源数组不 detach。Worker 通过 Native PrimitivePipeline 合并并按布局编码，保留原有几何隔离。道路仅重排与编码，表面仍可日期线分割；结果进入 Native VA 上传与 afterRender ready。

实体建筑与普通3D轮廓使用 `native` 几何布局，保留原属性类型、实例属性、batchId、indices、bounds 和 Appearance，不进入道路/平面面的格式转换及16-bit实例限制。成功排队的首次调用只完成实例 metadata 与几何请求调度，下一次 Native update 创建 batch table，回复后继续 Native VA、shader、绘制、拾取及 ready。队列未准备完成时保留旧可见内容。

普通建筑始终提取球面拓扑，投影、日期线分割、双坐标属性及 2D/CV/morph 包围球交由 Native PrimitivePipeline 生成；只有宿主实际配置 scene3DOnly 时省略投影轨。已上传建筑与道路一起留在模式交接中，直至替代代次可绘制。平面样式顺序只改变缓存的 Native DrawCommand 副本，3D 继续使用原命令的深度与透明度 pass。初始零透明度跳过几何提取，只记录实际延后上传的图层；非空源保留集合，首次显示时构建一次。以后隐藏/显示保留 Native owner、VA 与拾取 ID。无建筑、空 bucket 和排除图层不创建这个所有者。

建筑提取使用同一个 kernel 的实体/表面输出合同。实体直接写入最终 ECEF、面法线与连续 top 插值权重，不保存无消费者的 tile 坐标、高度中间数组或 CPU 光照颜色。法线值源于 packed layout，使用 FLOAT 存储避免 Native 日期线插值后的整数截断；top 权重必须保留细分后的连续值。图案表面继续保有 UV 所需坐标及原 CPU 光照颜色。build-local 轴缓存保存 trig 与纬度法向半径，细分按已知顶点数分配最终数组；未共享顶点不维护 dictionary。最终输入保持 Native 所有权、原 bounds 与实例 ID。

实体 ExtrusionPrimitive 让 Native instance table 管理颜色、透明度和垂直渐变，Appearance uniforms 管理光照。光照变化不遍历要素；纯 paint 更新不重新提取 ECEF、不发送 create/combine 任务、不重建 VA。高度/基底改变才替换几何。MapLibre 光照公式在顶点 shader 中分别计算源底/顶颜色再插值，Native 继续管理 gamma、拾取与深度。使用背面剔除的单面绘制，透明时不进入 Native closed volume 的双 pass；恢复不透明时由 Native 恢复深度写入及关闭混合。实例属性改变仍会触发 Native BatchTable 纹理上传，不声称零上传或整帧吞吐已追平 MapLibre。

3D填充轮廓登记真实实例ID，加入既有线 paint owner；改变道路宽度或颜色不会因同集合中的水面轮廓而重建全部道路。已有轮廓源在零透明度期间保留，颜色通过construction/Native属性更新；camera `fill-antialias` 同样触发更新。

真正改变 dash/layout 或属性表达形式时，重建复用已有逐 feature 构建器与共享工作预算。准备结果同时返回 replacements 与 ready；无预算不启动几何构建。未完成时保持旧 renderer owner，不写入已应用 paint cache；完成后统一最新 paint，再沿用 Native ready 交接。连续 paint 变化不取消几何，几何签名变化重开；回到原布局取消待建结果。退役、移除与冻结断开未提交 CPU 状态。等待会阻止新上传和最终交接，但旧集合已上传的可见部分继续绘制。单个 feature 和输入校验仍不能抢占，预算是合作式推进。

`GeometryPrepareWorker` 按 context 引用计数，负责惰性 TaskProcessor、CDN bootstrap、浏览器致命失败锁存和最后引用销毁。`GeometryPrepareQueue` 唯一持有已接收请求的 Promise 结算，不再另设 owner pending 注册表。单个 Primitive 销毁保留批次容量至真实结果结束并丢弃迟到结果；最后一个持有者使队列失败、销毁 TaskProcessor 并释放几何 Blob URL。Worker 加载或反序列化失败结算整个队列，合法批回复中的任务级错误只结算对应请求；局部观察 Native processor 的 Worker 错误，补足其浏览器致命失败不会拒绝 Promise 的行为。正常部署须保留完整 Cesium 静态 Workers，包括原生 transferTypedArrayTest；unplugin-cesium 负责发布。支持 GeographicProjection 与 WebMercatorProjection 及其 ellipsoid，拒绝 Native 异步协议无法保存的其它投影。共享输入回归核对源数据未改写与输出一致，成本与限制见 [异步接入记录](./research/native-line-combine.md)。

圆头采用 MapLibre 的四边形与片元距离裁剪，每端只增加两个顶点，与线宽无关；圆角连接继续保留扇形。实线与虚线共用圆头距离语义，端头四边形和线身只共享边，不叠加半透明颜色。仅圆角连接的细分影响布局缓存键。屏幕扩张后的道路不能由中心线包围球界定，GeometryPrimitive 的道路布局关闭此球的空间裁剪，由 MVT covering 管理瓦片可见性；Native 的球仍用于视锥深度分段，深度测试和 shader 近裁剪仍保留。真实 WebGL 回归检查扩张圆头的拾取与透明四边形角落，避免狭窄拾取视锥漏掉有颜色的道路。

道路抗锯齿按物理设备像素计算：paint 半宽外 0.5px 是覆盖边界，向内使用 1px 的线性覆盖坡度。几何额外向外延伸 1px 的透明区，使边缘像素的 MSAA 样本均被覆盖，避免几何采样覆盖率再次压暗 shader 已计算的透明度；不改变宿主 MSAA 设置。边缘与圆头距离坐标在顶点乘 clip w，在片元乘 gl_FragCoord.w，消除透视插值对窗口空间距离的偏移；虚线图集法线还原到原 AA 包络，相位继续使用原来的距离语义。扩张不增加顶点或索引，但会增加部分透明片元工作，需要整体性能对照。

实线与虚线由同一个 line renderer、vector builder 和 paint updater 管理。常量宽度和颜色使用 uniform，数据驱动 paint 使用 Native instance table；纯 paint 变化复用单位宽几何，零宽与透明实例可恢复。复用核对全部线层的中心线、布局和 dash row，包括首次省略的 feature；dash row、布局或 paint 表示改变时仅替换 lines 集合，并沿用已有 Native 上传交接。Pattern renderer 只管理图片图案，不再保存虚线 paint 等待、布局缓存或另一份几何构建状态。

多个实线图层共享同一 LineBucket 时，2D、CV、3D 都使用 LineFamilyChunk，共享一个 GeometryPrimitive、物理 VA 和位置纹理，各层保留独立 Native batch table、paint uniform、拾取 ID 与绘制顺序。转换器只交接原中心线，各层高度在 shader 中沿投影 x 或 WGS84 法线偏移；3D 使用 Cesium 的 geodeticSurfaceNormal，模型变换后按世界米制移动中心及邻点。Native 命令的世界包围球另扩充最大图层偏移，保留深度分段，不修改原球。单层直接使用 GeometryPrimitive；dash 的图集行仍属于各层，不加入实线 family。道路的模式回归同时核对普通建筑；符号、图案和栅格的来源/paint 交接由各自回归覆盖，不据此声称全部真实城市的连续性。

Worker 符号只传输静态 layout、索引、paint、placement/collision、glyph/line 等实际消费的数据。屏幕位移和透明度由 Cesium 后端按 render generation 创建、由 placement 更新并上传；不再在 Worker 构造和转移没有读取者的 MapLibre dynamic layout/opacity 数组。建筑仅保留实际 layout、索引和 feature geometry ranges；旧 terrain-centroid 数组及累积遍历已删除，Cesium extrusion 几何使用自身的高度/基底和顶点来源。

每个库实例使用 Style 的同一份 `DashAtlas` 和一个 `DashMaterial`。`DashAtlas` 保存 CPU SDF 行数据；`render/line/dash-material.ts` 中的 `DashMaterial` 惰性创建 Native Material，管理图集上传、uniform 更新与最终销毁。数据驱动 dash row 来自 Worker 的实际属性绑定；常量 row 来自同一 CPU atlas，圆头按 feature 的真实布局选择。CPU 图集修订后使用新的 canvas 身份通知 Native Material，宿主在首次上传队列前排入 canvas，Primitive 首次命令前消费纹理。材质在所有活动、退役和待销毁 Primitive 释放后销毁，避免按道路重复创建材质或依赖额外引用计数。

GPU 驻留统计混合容量预留与已上传资源：Primitive 上传前预留输入，Native ready 后按 VA Buffer 身份去重读取 sizeInBytes，并计入道路位置纹理的实际容量（含 padding），family 别名读取同一物理所有者；采集只发生一次。Buffer collection 按原生容量预留，图案与符号使用上传输入，栅格使用 RGBA 尺寸。共享图集、feature batch-table 纹理、驱动开销及 Cesium 自有的地形贴合纹理不计入该数值；预算不会强制销毁仍可见的瓦片。它不等于整个 context 的 bufferData 容量或实际显存。

确定性浏览器测试使用本地 MVT 和真实 WebGL；联网测试独立验证公共服务。性能和体积数据见 [性能记录](./research/performance-baseline.md)，引擎能力与服务条款见 [研究记录](./research/cesium-and-public-mvt.md)。

性能诊断在测量帧外遍历 MapLibre 当前瓦片和所有离屏缓存版本，按实际 WebGLBuffer 去重，包括跨淡入淡出 paint 的闲置缓冲。共同容量按各类 buffer target 的实际绑定追踪，并在帧外用 getBufferParameter(BUFFER_SIZE) 逐项核验。逻辑顶点、三角形数量与上传容量分别记录；未归属瓦片的容量单列，不推断为泄漏或 renderer 固定开销。

运行时缺失的 Cesium 类型用 backend 内局部契约描述，构造器与常量均从根入口静态读取单个成员。禁止把整个 Cesium namespace 赋给 runtime/internals 对象或用值解构；当前 Rolldown 会因此保留整个 namespace 和无关 Widgets/数据格式加载器。静态成员读取仍使用同一个 Native 符号，没有深路径导入或全局类型扩充。

道路按唯一源点编码位置；每个展开顶点只携带 FLOAT record ID、UBYTE flags 和 USHORT batchId，共 7 B/顶点，dash 另有 28 B 相位属性。Native 的展开 DOUBLE ECEF 中心供 batchId、重排和 bounds 使用，上传前删除编码位置属性。完整模式 Scene 始终准备三维、投影两组 48 B CPU records；只有真实 scene3DOnly Scene 省略投影记录。坐标模式与拓扑属于同一个 owner，不在相机变化时重新投影或改写位置纹理。

`line-position-texture.ts` 对两轨分别计算 12 个 FLOAT word 通道的共同前缀，将变动位紧密打包到同一 Native RGBA32UI Texture，两轨起点按 texel 对齐。11-word stride 补到 12；其余 stride 在任意 record 偏移下至多跨三个 texel。稳定模式只读取活跃轨道，morph 用 Native czm_columbusViewMorph 混合两轨。descriptors、stride 和 prefix 属于各 owner 的 ivec4 uniforms，shader 不包含瓦片位置；FLOAT low、邻点、负零和 subnormal 的位模式保持。纹理需要 Native WebGL2、NEAREST sampler；容量按真实变动位和 padding 计量。

物理 Primitive 独占位置纹理及 Appearance uniforms，family 重放共享 VA/纹理/shader，各层拥有独立 feature table、paint 和 pick IDs。Native 上传后释放 CPU records，FAILED 和 destroy 同样释放。投影准备复用最终 record 的前 24 B 暂存 DOUBLE xyz、后 24 B 写 FLOAT 邻点，最终逐点读完 xyz 再写 high/low；不保存额外邻点 backing。miter limit 来自 Native 实例 FLOAT 属性；fan 的 23 种精确 Float32 参数由角色字节索引，不上传 cornerParam。

角色压缩依赖 encode-only 道路组合；Native genericInterpolate 可能生成分数角色，因此道路禁用其跨日期线三角形切分，保留原始离散 flags。标准 line 的 Worker payload 保留逐点 tilePositions；填充边线使用自身 subdivision、clipX 后的对应坐标，不能借用重排过的 fill mesh 坐标。planar bake 由源坐标判重复与闭环、计算 join 方向；3D 仍清理 ECEF 短段。dash 相位采用真实 canonical Mercator 距离，不折叠为最近世界周长。

FLOAT 对照由真实 LineBucket 提取来源，使用 E2E fixture 中冻结的原始 bake、角色拓扑及 GLSL，独立清洗、投影、镜像和构建 FLOAT 属性；不读取生产 WeakMap、packed 属性或 prepared geometry。回归核对整个 framebuffer、厘米短段、日期线、近裁面、不同视角下的存储身份、公开拾取及销毁。测试结果和实际资源成本见性能基线。

瓦片驻留以实际 SceneMode 判断 live/retired geometry 能否复用，CV 与 2D 不再共用生命周期键。模式变化重做 hydration，已提交旧 generation 保持可见直至 successor 就绪。冻结状态直接归 VectorPaintState 所有；冻结或未完成的 generation 不能进入可恢复缓存，也不能满足 live hydration，避免快速折返与晚退役恢复永久旧 paint。取消只丢弃未提交构建，旧 VA、纹理与 Native owner 在交接结束或离开覆盖后归 scene 移除队列销毁。
