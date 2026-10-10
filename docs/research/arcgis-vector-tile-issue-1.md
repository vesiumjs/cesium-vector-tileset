# Issue #1：ArcGIS VectorTileServer 与 MapLibre 接入边界

研究日期：2026-10-10。对照本仓库当前实现、已安装的 MapLibre GL JS 6.12.0 源码、Esri 官方文档及公开 World_Basemap_v2 服务。用户未提供实际 PGIS 服务地址，因此以下结论不能视作该服务的端到端验收。[原 issue](https://github.com/vesiumjs/cesium-vector-tileset/issues/1)

## 结论

用户给出的 `currentVersion`、`type: indexedVector`、`defaultStyles: resources/styles`、`tileInfo`、`tiles: [tile/{z}/{y}/{x}.pbf]` 是 **ArcGIS 服务元数据**，符合 Esri 定义的资源格式。它不包含 Style JSON 的 `version: 8`、`sources`、`layers`，不能直接作为 MapLibre 或本库的样式入口；这不代表该 JSON 损坏。[Esri Vector Tile Service](https://developers.arcgis.com/rest/services-reference/enterprise/vector-tile-service/)、[本库样式判定](/home/xiankq/git/cesium-vector-tileset/packages/cesium-vector-tileset/src/style/load-style.ts:31)

MapLibre 可以消费相应的矢量瓦片和版本 8 样式，但 **6.12.0 没有自动把这份服务元数据转换为样式、追踪 `defaultStyles` 或解析 ArcGIS 相对资源的内建步骤**。本库已经补充了一部分 ArcGIS source 元数据处理及样式资源 URL 解析；目前缺少的是将服务元数据作为顶层样式入口时的样式发现。不能归因为“MapLibre 原生支持，而本库漏移植”。[MapLibre source 加载](/home/xiankq/git/cesium-vector-tileset/node_modules/maplibre-gl/src/source/load_tilejson.ts:27)、[MapLibre style 加载](/home/xiankq/git/cesium-vector-tileset/node_modules/maplibre-gl/src/style/style.ts:439)、[本库 source 加载](/home/xiankq/git/cesium-vector-tileset/packages/cesium-vector-tileset/src/source/load-tilejson.ts:35)

## MapLibre 实际处理什么

| 场景 | MapLibre 6.12.0 行为 | 本库当前行为 |
| --- | --- | --- |
| 把服务元数据 URL 当作完整 style URL | 获取 JSON 后按样式校验；不跟随 `defaultStyles` | 明确拒绝缺少版本 8、sources、layers 的对象 |
| 已有 style 的 vector source 指向 VectorTileServer | 当作 TileJSON 获取；只提取 tiles、minzoom、maxzoom 等标准字段 | 检测 VectorTileServer 路径、补 `f=json`、服务目录尾斜杠、解析相对 tiles、从 tileInfo.lods 取级别 |
| style 中 `../../`、`../sprites/sprite`、`../fonts/…` | 不自动用所下载 style 的 URL 重写这些引用 | 用最终 style 响应 URL 解析 source、tiles、sprite、glyphs |
| metadata 的 `minLOD`、`maxLOD`、`tileMap` | loadTileJson 不处理 | loadTileJson 当前也不处理；不要宣称已完整支持 indexedVector |

源码依据：MapLibre [loadTileJson 27–45](/home/xiankq/git/cesium-vector-tileset/node_modules/maplibre-gl/src/source/load_tilejson.ts:27)、[style.loadURL 439–464 / _load 485–506](/home/xiankq/git/cesium-vector-tileset/node_modules/maplibre-gl/src/style/style.ts:439)、[RequestManager 30–35](/home/xiankq/git/cesium-vector-tileset/node_modules/maplibre-gl/src/util/request_manager.ts:30)；本库 [loadStyle 23–28](/home/xiankq/git/cesium-vector-tileset/packages/cesium-vector-tileset/src/style/load-style.ts:23)、[resolveStyleUrls](/home/xiankq/git/cesium-vector-tileset/packages/cesium-vector-tileset/src/style/resolve-style-urls.ts:7)、[loadTileJson 38–69](/home/xiankq/git/cesium-vector-tileset/packages/cesium-vector-tileset/src/source/load-tilejson.ts:38)。

MapLibre 的 `transformStyle` / `transformRequest` 是应用接入工具，不等于内建 ArcGIS 转换。特别是 sprite：`new URL(url)` 要求绝对地址，校验发生在 transformRequest 之前；仅靠 transformRequest 修正相对 sprite 不能成功。该行为与官方 [相对路径 issue #182](https://github.com/maplibre/maplibre-gl-js/issues/182)、[PR #4962](https://github.com/maplibre/maplibre-gl-js/pull/4962) 一致。[本地 normalizeSpriteURL / loadSprite](/home/xiankq/git/cesium-vector-tileset/node_modules/maplibre-gl/src/style/load_sprite.ts:17)

## 正确的入口与 URL 基准

Esri 当前服务指南给出的常见样式入口是：

```text
https://host/.../VectorTileServer/resources/styles/root.json
```

应获取该 style，并保留它声明的 source-layer、filter、字体和图标名称，再获取 source 元数据及瓦片。元数据只描述服务，无法单独恢复这些绘制规则。[Esri 服务入口](https://developers.arcgis.com/documentation/portal-and-data-services/data-services/vector-tile-services/introduction/)、[Esri 样式资源](https://developers.arcgis.com/rest/services-reference/enterprise/vector-tile-style/)

设 `S = https://host/.../VectorTileServer/`，以 `S + resources/styles/root.json` 为基准，公开服务的路径解析如下：

| 声明位置 | 原值 | 正确结果 |
| --- | --- | --- |
| style source.url | `../../` | `S` |
| style sprite | `../sprites/sprite` | `S + resources/sprites/sprite` |
| style glyphs | `../fonts/{fontstack}/{range}.pbf` | `S + resources/fonts/{fontstack}/{range}.pbf` |
| 服务元数据 tiles | `tile/{z}/{y}/{x}.pbf` | `S + tile/{z}/{y}/{x}.pbf` |

样式引用以 **样式文件 URL** 为基准；元数据 tiles 以 **服务目录 URL** 为基准。当前本库分别处理两者，并保留模板花括号。[本库 URL 解析](/home/xiankq/git/cesium-vector-tileset/packages/cesium-vector-tileset/src/style/resolve-style-urls.ts:3)、[服务目录修正](/home/xiankq/git/cesium-vector-tileset/packages/cesium-vector-tileset/src/source/load-tilejson.ts:47)

注意：公开 World_Basemap_v2 的 `resources/styles` 也返回同一 style，但该 URL 缺少尾斜杠，普通文件 URL 解析会让 `../sprites` 落到错误目录。明确使用 `resources/styles/root.json` 可避免这个歧义。Esri 旧 REST 样式文档列出 `resources/style`，而此公开服务的该地址实测返回 HTTP 200 错误 JSON，因此不能只看 HTTP 状态或强推单一旧路径。实际服务仍应核对返回内容。[公开 root.json](https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/resources/styles/root.json)、[公开 styles](https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/resources/styles)、[公开 style](https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/resources/style)

Sprite 是无扩展名的基址：加载器请求 `.json` 和 `.png`，高像素比时请求 `@2x.json` 与 `@2x.png`。glyphs 则是含 `{fontstack}` 与 `{range}` 的 PBF 模板，不能以 sprite URL 代替。[Esri sprite](https://developers.arcgis.com/rest/services-reference/enterprise/vector-tile-sprite/)、[Esri font](https://developers.arcgis.com/rest/services-reference/enterprise/vector-tile-font/)、[本库 sprite 加载](/home/xiankq/git/cesium-vector-tileset/packages/cesium-vector-tileset/src/style/load-sprite.ts:37)、[glyph range 加载](/home/xiankq/git/cesium-vector-tileset/packages/cesium-vector-tileset/src/style/load-glyph-range.ts:9)

## 瓦片顺序、zoom 与 indexedVector

`tile/{z}/{y}/{x}.pbf` 中行列的排列是 URL 模板格式。MapLibre 和本库按具名占位符替换，支持这种顺序，不应改写为 `{z}/{x}/{y}`；也不能因为顺序是 y/x 就设置 TMS，`scheme: tms` 会额外翻转 y。512 tileSize 是两者 vector source 的标准默认值，本身不是异常。[Esri 瓦片入口](https://developers.arcgis.com/rest/services-reference/enterprise/vector-tile/)、[MapLibre tile URL](/home/xiankq/git/cesium-vector-tileset/node_modules/maplibre-gl/src/tile/tile_id.ts:38)、[本库 tile URL](/home/xiankq/git/cesium-vector-tileset/packages/cesium-vector-tileset/src/tile/tile-id.ts:35)、[MapLibre vector source 默认值](/home/xiankq/git/cesium-vector-tileset/node_modules/maplibre-gl/src/source/vector_tile_source.ts:92)

用户的 `maxzoom: 18` 和 `maxLOD: 15` 可以同时成立，不能据此断言数据矛盾。Esri 索引文档说明 `minLOD` / `maxLOD` 记录索引的级别范围，索引最大 LOD 可小于 tiling scheme 最大 LOD；叶节点可在更细级别 overzoom。公开 World_Basemap_v2 同样实测 `maxzoom: 22`、`tileInfo.lods: 0–22`、`minLOD: 0`、`maxLOD: 16`。[Esri Create Vector Tile Index](https://pro.arcgis.com/en/pro-app/latest/tool-reference/data-management/create-vector-tile-index.htm)、[公开服务元数据](https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer?f=json)

用户样本还有三个不同上限：`tileInfo.lods` 为 0–19、`maxzoom` 为 18、`maxLOD` 为 15。当前本库会先以 lods 得到 `maxzoom: 19`，覆盖元数据的 18；只有样式 source 显式提供 maxzoom 才会在后续合并中再覆盖。MapLibre 则直接读取元数据的 maxzoom，忽略 lods。这是确定的处理差异，需要结合服务实际瓦片与样式核实；本次没有证据把它认定为顶层加载失败的根因。[本库 level 提取与合并](/home/xiankq/git/cesium-vector-tileset/packages/cesium-vector-tileset/src/source/load-tilejson.ts:51)、[MapLibre 字段提取](/home/xiankq/git/cesium-vector-tileset/node_modules/maplibre-gl/src/source/load_tilejson.ts:37)

`indexedVector` 使用随数据复杂度变化的四叉树，不保证每个位置有每一层瓦片。Esri tilemap 的 `1` 表示叶节点、`0` 表示无瓦片、`2` 表示另一个索引文件。把最大 zoom 设为 maxLOD 只能约束全局上限，不能解决较浅叶节点；而只使用 lods 的上限也不证明那些层级存在实体瓦片。[Esri Vector Tilemap](https://developers.arcgis.com/rest/services-reference/enterprise/vector-tilemap/)、[Esri Indexed / Flat 区别](https://pro.arcgis.com/en/pro-app/latest/tool-reference/data-management/create-vector-tile-package.htm)

本库已有 tile pyramid 的父子替代逻辑，但 vector source 在 404 时调用 `_afterTileLoadWorkerResponse(tile, undefined)` 并返回；不能仅凭 pyramid 的 404 注释认定 ArcGIS 稀疏缓存已正确回退。本次未进行稀疏服务的渲染验证。[vector source 404 路径](/home/xiankq/git/cesium-vector-tileset/packages/cesium-vector-tileset/src/source/vector-tile-source.ts:318)、[pyramid 404 路径](/home/xiankq/git/cesium-vector-tileset/packages/cesium-vector-tileset/src/tile/tile-pyramid.ts:281)

用户提供的 3857 / 102100、512、原点约 `(-20037508.34, 20037508.34)`、零级 resolution 约 `78271.52` 及逐级减半，与标准 512 像素 Web Mercator 网格相符；其中没有明显的投影或行列编号异常。fullExtent 也已给出，是区域覆盖。Esri 允许自定义 tiling scheme，但不能据此把该样本归为自定义网格；仍未验证实际服务是否按声明发布瓦片及其认证情况。[Esri tiling scheme 约束](https://pro.arcgis.com/en/pro-app/latest/tool-reference/data-management/create-vector-tile-package.htm)、[本库 canonical 网格约束](/home/xiankq/git/cesium-vector-tileset/packages/cesium-vector-tileset/src/tile/tile-id.ts:17)

## 已执行验证与边界

2026-10-10，对公开 World_Basemap_v2 执行只读 GET：元数据、root.json、sprite JSON、@2x sprite JSON/PNG、Arial Regular 的 `0-255.pbf`、`tile/0/0/0.pbf`、tilemap 均返回 200，带 `Origin: http://localhost:5173` 的上述成功请求返回 CORS `*`。root.json 为版本 8、916 层，类型为 fill/line/symbol；source、sprite、glyphs 分别为上表的相对值。普通 sprite PNG 一次出现 SSL EOF，只记录为此次网络观测，不作为兼容性结论。[样式样本](https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/resources/styles/root.json)、[sprite JSON](https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/resources/sprites/sprite.json)、[glyph 样本](https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/resources/fonts/Arial%20Regular/0-255.pbf)、[tile 样本](https://basemaps.arcgis.com/arcgis/rest/services/World_Basemap_v2/VectorTileServer/tile/0/0/0.pbf)

主代理把真实元数据与 style 响应作为 fetch fixture 调用当前 `loadStyle` / `loadTileJson`，验证：元数据作为 style 明确拒绝；root.json 的 source、sprite、glyphs 正确绝对化；source 请求补 `/?f=json`；瓦片模板绝对化；minzoom / maxzoom 得到 0 / 22。探针位于 `node_modules/.cache/temp/arcgis-issue-1/probe.mts`，属于可丢弃验证，不是浏览器端到端测试。

尚未验证：用户实际 PGIS 服务资源是否存在、其认证与 CORS、所声明样式能否全部渲染、indexedVector 稀疏瓦片回退。现有证据足以回答“MapLibre 是否原生接收这份顶层元数据作为 style”：没有；如果用户将它传给本库 fromUrl，也会因入口类型不符而被拒绝。issue 未给出实际调用方式，不能认定这就是其全部加载问题的根因，也不能断言“用户元数据坏了”或“整个 ArcGIS 已完全兼容”。
