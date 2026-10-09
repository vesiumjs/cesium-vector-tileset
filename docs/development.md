# 开发与发布

本文档面向仓库维护者。库的安装与使用见 [README](../README.zh-CN.md)。

## 运行演示

使用 **Node.js 24.x LTS（24.15 或更新版本）**和 pnpm。在仓库根目录执行：

```bash
pnpm install
pnpm dev
```

打开 Vite 输出的本地地址。演示默认使用 OpenFreeMap 建筑白模样式和上海视角。可以通过控件选择统一的视角预设、地图样式和场景模式，也可以输入自己的样式 JSON URL。相机手势可继续调整视角，实时读数显示实际经纬度与 heading/pitch/roll。

通过 URL 参数分享视角：

```text
/?preset=shanghai&source=buildings&mode=3d
/?preset=manhattan&source=buildings&mode=3d
/?preset=barcelona&source=liberty&mode=2d
```

`preset` 选择视角预设，`source` 选择地图样式，`style` 指定自定义样式 URL，`mode` 支持 `3d`、`2d` 和 `cv`，`resolutionRatio` 设置渲染分辨率比例。相机高度与 heading/pitch/roll 来自预设及实际相机操作，URL 分享的是所选预设配置。

可用视角和样式定义在 [preset-catalog.ts](../src/demo/preset-catalog.ts)。[app.vue](../src/app.vue) 直接展示 Widget 创建、`fromUrl` 加载以及 `scene.primitives.add/remove`；选择状态、相机切换和卸载清理也在此入口。URL 解析与相机参数转换是纯配置函数，渲染循环和尺寸变化由 CesiumWidget 管理。

预设从外部服务请求数据。自定义样式引用的数据源、sprite 和字形必须可访问，并为应用所在域配置 CORS。请展示数据提供方要求的署名，在演示之外使用预设前核对其服务条款。

## 开发

| 命令                     | 用途                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `pnpm dev`               | 启动 Vite 演示服务器                                                                       |
| `pnpm build`             | 依次构建库和演示                                                                           |
| `pnpm build:lib`         | 委托库包构建模块、worker、source map 和类型声明，产物位于 `packages/cesium-vector-tileset/dist/` |
| `pnpm build:demo`        | 构建 Vite 演示，产物位于根目录 `dist/`                                                     |
| `pnpm preview`           | 预览构建后的演示                                                                           |
| `pnpm lint`              | 依次检查 ESLint 和 TypeScript，不修改文件                                                   |
| `pnpm lint:eslint`       | 运行 ESLint 并自动修复                                                                     |
| `pnpm lint:eslint:check` | 检查 ESLint，不修改文件                                                                    |
| `pnpm lint:tsc`          | 运行 workspace TypeScript 检查                                                             |
| `pnpm test`              | 运行 Vitest 单元测试                                                                       |
| `pnpm test:watch`        | 以 watch 模式运行单元测试                                                                  |
| `pnpm test:e2e`          | 构建库和演示，再运行默认 Playwright 测试集                                                 |
| `pnpm test:e2e:live`     | 运行标有 `@live` 的外部服务测试，使用 Vite 源码服务器                                      |
| `pnpm test:e2e:install`  | 安装 Chromium；CI 追加 `--with-deps` 安装系统依赖                                           |
| `pnpm taze`              | 更新依赖，保留 TypeScript `6.0.x`                                                          |
| `pnpm release`           | 委托库包选择新版本、提交、创建 `v*` 标签并推送                                              |
| `pnpm publish:ci`        | 委托库包校验标签、构建、打包并发布，供 npm 发布工作流调用                                   |

运行浏览器测试前，通过 `pnpm test:e2e:install` 安装 Chromium。Playwright 报告与失败产物位于 `node_modules/.cache/playwright/`。构建命令只负责生成产物，类型检查由 `pnpm lint` 或 `pnpm lint:tsc` 执行。

完整预设的真实数据动态回归可单独运行：

```bash
E2E_GPU=hardware E2E_LIVE=1 pnpm exec playwright test e2e/demo-presets.spec.ts
```

该回归连续执行缩放、绕目标旋转、倾斜与返回，并保存实际相机、渲染统计和五阶段画面。[预设筛选与实景校验记录](./research/demo-preset-validation.md)说明保留理由、被删除视图和已验证范围。

修改代码后，依次运行 `pnpm lint:eslint`、`pnpm lint:tsc` 和相关测试。单元测试放在被测试代码同级的 `__test__/` 目录，浏览器测试位于 `e2e/`。

生成的样式属性、struct array 和 Unicode 表应通过命令重新生成，不要手工编辑：

```bash
pnpm --filter cesium-vector-tileset codegen
pnpm --filter cesium-vector-tileset generate-unicode-data
pnpm lint:eslint
```

在 `vue-tsc` 和 `typescript-eslint` 支持下一版本之前，TypeScript 保持在 `6.0.x`。

## CI 与发布

向 `main` 推送或创建以 `main` 为目标的 PR 时，GitHub Actions 会执行 lint、类型检查、单元测试、库与演示构建，以及四分片的默认 Playwright 测试集。`dev` 推送不会触发工作流；来源为 `dev` 的 PR 和在 `dev` 上的手动运行会跳过任务。现有测试配置会排除外部服务 live 测试和需要显式启用的性能测试。浏览器测试失败时会上传报告与失败产物。

推送 `v*` 标签后，工作流先执行同一套检查，再通过 [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) 将 **cesium-vector-tileset** 发布到 npm。在 npm 包设置中添加 GitHub Actions trusted publisher：

| 字段                 | 值                      |
| -------------------- | ----------------------- |
| Organization or user | `vesiumjs`              |
| Repository           | `cesium-vector-tileset` |
| Workflow filename    | `publish.yml`           |
| Environment          | `Publish Package`       |

允许该 publisher 直接发布，无需配置 `NPM_TOKEN` secret。配置所用 npm 账号必须具有该包的权限。如果包尚不存在，先手动发布首个版本，再配置 publisher。

在已同步的 `main` 分支完成检查后，运行：

```bash
pnpm release
```

库包使用 [bumpp](https://github.com/antfu-collective/bumpp) 交互选择尚未发布的新版本。也可以直接指定版本，例如 `pnpm release 0.0.2`。命令要求工作区干净，更新 `packages/cesium-vector-tileset/package.json`，创建版本提交和对应的 `v0.0.2` 标签，然后推送当前分支及标签。根目录是私有演示 workspace，其版本号不参与发布。

标签推送后，CI 调用 `pnpm publish:ci`。库包校验标签与版本是否一致，通过 `pnpm pack` 触发 `prepack`，先构建最新代码，再准备双语 README 和许可证，最后使用 npm CLI 通过 OIDC 发布 tarball。正式版本发布到 `latest`，`0.0.3-beta.1` 这样的预发布版本发布到 `next`。本地核对发布产物时，可以运行 `pnpm --filter cesium-vector-tileset pack`；它同样会自动构建。

演示在推送到 `gh-pages` 时部署到 GitHub Pages，也可手动运行 `deploy-github-pages`。仓库 Pages 的 Source 需设置为 **GitHub Actions**。手动运行时选择要部署的演示所在分支；选择 `dev` 时跳过部署任务。

## 项目结构与延伸阅读

```text
packages/cesium-vector-tileset/
  index.ts           库的公共导出
  src/               样式、数据源、Worker、瓦片和 Cesium 渲染
  build/             代码生成器
src/                 Vue 演示、CesiumWidget 配置和样式
e2e/                 浏览器集成与渲染测试
docs/                架构与研究记录
CONTEXT.md           领域术语
```

- [架构说明](./architecture.md)：瓦片生命周期、渲染和资源所有权。
- [模块职责](./module-responsibilities.md)：模块边界与调用方。
- [领域术语](../CONTEXT.md)：代码库使用的统一词汇。

以上内部文档目前以中文编写。
