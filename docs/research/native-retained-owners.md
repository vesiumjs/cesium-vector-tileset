# Cesium 销毁后 Native 对象保留路径

2026-10-03，固定 Cesium 1.146.0、Intel ANGLE Vulkan、1280×720/DPR1、SCENE2D、默认 Globe 和开启的 FPS。对 source-only minified 库进行实际 destroy、解除 fixture hooks/owner 闭包、两个 animation callbacks、GC 后，Viewer/tileset/bucketRenderer 的 WeakRef 已清空，Scene 和实际 WebGL context 仍存在。

原始失败和快照保留在 `node_modules/.cache/playwright/test-results/line-memory-release-second/line-memory-profile-diagno-b7647-d-fixture-reference-release/retained-owners.heapsnapshot`。快照有540661节点、1812729条边；以下节点编号仅属于这一份快照。排除 `weak` 和 WeakMap 的 `part of key … -> value … pair` 条件边，避免把 ephemeron 当作无条件强根。

实际 Scene 是 `#656153`，实际 GL 是 native WebGL2RenderingContext `#110881`；同名 object `#772141` 是接口对象缓存，不是被观察的 GL。

共同根路径：

```text
root #1
→ (GC roots) #3
→ (Global handles) #23
→ NativeContext #7271
→ Window #930329
→ protobuf Object #234593
→ Writer closure #233541
→ Context #233557
→ previous #233617
→ previous #233621
→ Cesium bundled module Context #106003
```

实际 Vite Cesium 脚本为 `node_modules/.cache/playwright/test-results/.cache/vite/1533967-0/deps/cesium.js?v=b004c27d`，其 `protobuf.util.global.protobuf = protobuf` 在94781行、Writer在97005行。模块根正常存活；业务对象被其 scratch/cache 保留的链如下。

| 模块根之后的实际强链 | Native primary 位置 |
| --- | --- |
| `preloadTilesetPassState #365405 → camera #365407 → _scene #656153` | `Source/Scene/Scene.js:1973,5077`；`Camera.js:90` |
| `surfaceShaderSetOptionsScratch #361945 → frameState #167077 → camera #365407 → _scene #656153` | `Source/Scene/GlobeSurfaceTileProvider.js:2466,2726–2728` |
| 同一 `frameState → context #105999 → _originalGLContext #110881` | 同上，实际Context属性在快照中 |
| `regularGridAndSkirtAndEdgeIndicesCache #354713 → [16] #354715 → [16] #610067 → indices #115125 → indexBuffers #570419 → [context UUID] Buffer #168097 → _gl #110881` | `Source/Core/TerrainProvider.js:180,197–199,229`；`GlobeSurfaceTile.js:496–510`；`Renderer/Buffer.js:68` |

Native primary 文件位于 `node_modules/.pnpm/@cesium+engine@26.4.0/node_modules/@cesium/engine/`。地形释放路径 `GlobeSurfaceTile.js:525–545` 减少引用计数，不删除 `indices.indexBuffers` 的属性。快照中缓存 Buffer 的 referenceCount.value 为54，仍有WebGLBuffer；此处不是GPU allocator证据，不能推断VRAM泄漏或已全部释放。

Scene 和 Context 均有自有 `isDestroyed → returnTrue #106189`。Scene的 `_context/_globe/_primitives`、Context的 `_shaderCache` 已清空，说明销毁执行过。`Scene.destroy` 位于 `Scene.js:5513–5577`；`CesiumWidget.destroy` 位于 `Widget/CesiumWidget.js:1023–1047`。

Native scratch 的 FrameState还保留 `commandList #657213 → [17] DrawCommand #150425 → _owner GeometryPrimitive Et #641595`。该 Primitive 已destroy，`_va/_sp/_combineOwner` 清空。它作为WeakMap key的真实保留来自 Native commandList，不能从WeakMap条件value边倒推库有独立根。

排除弱/ephemeron条件边并停止遍历Cesium module Context `#106003` 后，Scene、实际GL及上述Primitive均不再从root可达。`(Debugger)#15`、`(Handle scope)#25`、`(Traced handles)#55` 出边为0；未发现独立的console/CDP或fixture owner根链。

为验证区别，另做三个独立 Native-only context：保持同一Viewer/camera/Globe/GL/FPS设置，route删除动态库import和tileset构造，禁止任何dist库/Worker请求，实际没有source请求、MVT或combine Worker。每轮只有main和两个terrain的3个isolate；解除18个fixture hooks（17恢复、1已由destroy替换）后，Viewer三轮均收集、Scene和GL三轮均保留。终态1综合case通过，9.9秒；记录 `node_modules/.cache/playwright/test-results/native-memory/`、`native-memory-summary.json`，运行器归档 `native-memory-profile-harness.txt`，临时spec已删除。

这证实Scene/GL保留在没有库渲染时也存在，并支持快照中的Native保留路径。Native-only没有采集第二份heap snapshot，故没有独立核对地形Buffer referenceCount=54的对照；该细节仍未关闭。也未清空Native scratch/cache、关闭FPS/Globe或调用prepareForLeakDetection。主线程GC后字节不是RSS、VRAM或整个浏览器物理内存，不能把模块缓存与Vite字符串差异全部解释为业务对象泄漏。
