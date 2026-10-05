# Native Primitive 的异步几何接入

更新于 2026-10-05，基于安装的 Cesium 1.146.0 / engine 26.4.0。实现集中在 `render/geometry/geometry-primitive.ts`；[性能基线](./performance-baseline.md)保留当前容量、计时和未完成项。本页记录实现合同，不再重复每轮实验和旧布局的验收数字。

## 原生能力与库的责任

普通 `Primitive` 的异步入口要求输入几何具有 `_workerName` 或 `_workerPath`。已经构建好的 MVT Geometry 不满足该入口，因此适配器在 Native COMBINING/COMBINED 之间接入原装 createGeometry、combineGeometry，并继续使用原 Primitive 的批表、VA、shader、拾取、包围球、ready 和销毁。

| 工作 | 所有者 |
| --- | --- |
| Worker 消息、任务 ID、传输能力探针、序列化错误还原 | Cesium TaskProcessor |
| Geometry 打包、解包、合并、重排与 Native 编码 | 原装 createGeometry / combineGeometry |
| 两条完整任务链的准入、有序分片、取消结果与 context 生命周期 | GeometryPrimitive |
| 道路源拓扑、位置纹理和上传属性格式 | Primitive 适配层 |
| 首次当前 paint、旧代可见性、替换与帧后释放 | SceneCollections 与 TileResidency |

库不再自行维护消息协议、全局任务 ID、回复分发或 Native Error 构造器。每个 context 惰性共享两项 TaskProcessor；并发限制由库的完整任务链计数执行，不修改 Cesium 的全局处理器。

## 输入、分片与取消

准入检查先于源投影和输入准备。最多两条任务链在途，满额时保持 READY 输入，由现有首次更新队列在下一帧重试。

create 输入按连续 Geometry 顺序分片，每片最多 512 个实例、512 KiB 属性及索引逻辑字节。单个超限 Geometry 不拆拓扑，独占一片。前片回复后才发送后片，最后一次 combine 消费原序的全部创建结果。该门限不是完整 backing、wire 大小或原子步骤的耗时保证。

源 Geometry 通过浏览器克隆进入 create，不转移共享源数组。Native create 在 Worker 中产生独立 Float64 packedData，随后只把这些结果及实例 metadata 转移给 combine。逐实例 Native pack/unpack 保留可变属性和索引的隔离，不能用同源 Geometry 身份消除这种隔离。

单个 Primitive 销毁后不续发片、不安装迟到结果；其槽位等当前任务回复后释放。最后一份 context 引用销毁时拒绝库的待处理链，销毁两个原生处理器。普通任务错误只结束该链。原生 TaskProcessor 不处理 Worker 的浏览器 error/messageerror，因此适配器只局部监听这些致命事件，结束整个 context owner；失败后不重建处理器。

## 资产与 Native 限制

正常部署包含完整 Cesium 静态 Workers，包括原生 transferTypedArrayTest。unplugin-cesium 负责复制与定位；库不修改 TaskProcessor._canTransferArrayBuffer，不通过硬编码传输能力绕开它。

TaskProcessor 会把 blob URL 也判断为跨源，自动创建的 CDN shim 没有 URL 释放逻辑。仅 CDN 几何任务由库创建一个 import Blob Worker，安装到原生 processor 的运行期 Worker 槽；调度和销毁仍交给 TaskProcessor，库在销毁后 revoke 自己的 URL。同源任务完全沿用原生 Worker 创建。

Native 全局 transfer probe 在资产缺失时没有失败拒绝机制，其 CDN probe 的 Blob URL 也由 Native 持有。这是上游已有行为，当前适配不声称解决；正常资产回归分别记录它的真实传输、回复和终止，不把它计为库的几何 Worker。此前对缺失 probe 的库级补偿及手写消息协议已删除。

异步协议只保存 GeographicProjection / WebMercatorProjection 与 ellipsoid。其它投影在调度前拒绝。实例 matrix 冻结在任务输入，不随后续 paint 或相机变化。

## 几何与显示

道路在完整模式 Scene 中保存三维与投影两轨，Native combine 仅编码，不对 record ID 与离散角色做日期线插值。原始经度分支、投影后端点镜像、FLOAT 舍入和近裁面角色由道路输入保留。投影包围球在主线程保留 DOUBLE 中心，再按实际编码误差扩半径；Native 继续管理 WC/2D/CV/morph 的命令与深度分区。

表面保留原生日期线分割和 scene3DOnly 合同。普通建筑也使用原生日期线分割、投影、双坐标属性和模式包围球，不再经过 3D 专用集合或另建平面面。压缩返回属性后重新生成 attributeLocations，不能沿用压缩前的映射。Native 首个命令早于 afterRender ready；当前 color/show 必须在这个命令前写入，替换交接仍等待实际上传与显示阶段就绪。

跨来源替换保留旧来源的可见资源和拾取，新来源的全部命令在完整准备前隐藏。完成后在颜色帧 afterRender 释放旧来源；符号图集与拾取索引不能在旧命令绘制之前销毁。道路模式切换复用已上传两轨 owner，其它模式专用轨道继续按各自合同重建。

## 验证与测量边界

维护单测使用真实 Native pack/unpack/combine，Worker mock 只替代浏览器传输边界。它核对源数组、完整 Native 数值、分片顺序、两槽位、取消、错误类型、CDN 与 context 销毁。根目录 `e2e/native-worker.spec.ts` 使用实际原装资产，核对传输 probe、513 实例的 512+1 分片、共享输入和缺失几何 Worker 的错误；`e2e/native-combine.spec.ts` 验证实际 WebGL 中的 paint、代次交接与迟到销毁。

这些正确性检查不证明整体性能改善。主线程仍负责源投影、部分 metadata 和返回属性压缩；Native Worker 仍复制输入与输出，VA、批表和 shader 仍需上传准备。Worker wall 包含排队、加载、执行、转移及主线程交付，不能等同纯 Worker CPU。整体性能与资源取舍见性能基线；全部 isolate 瞬时峰值属于额外研究，不作为本次重构收尾条件。
