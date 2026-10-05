# 开发与发布

本文档面向仓库维护者。库的安装与使用见 [README](../README.zh-CN.md)。

## 运行演示

使用 **Node.js 24.x LTS（24.15 或更新版本）**和 pnpm。在仓库根目录执行：

```bash
pnpm install
pnpm dev
```

打开 Vite 输出的本地地址。演示默认使用 OpenFreeMap Liberty 样式和上海视角。可以通过控件切换样式、相机和场景模式，也可以输入自己的样式 JSON URL。

通过 URL 参数分享视角：

```text
/?source=liberty&view=shanghai&mode=3d&angle=oblique
/?scenario=manhattan&height=60
/?source=bright&view=world&mode=2d
```

`source` 选择样式预设；`style` 指定自定义样式 URL；`mode` 支持 `3d`、`2d` 和 `cv`；`angle` 支持 `top`、`oblique` 和 `horizon`。可用样式、城市和场景，以及 `widgetOptions`、`sceneOptions`、`tilesetOptions`，统一定义在 [src/demo-config.ts](../src/demo-config.ts)。Vue 负责切换这些配置，渲染循环和尺寸变化由 CesiumWidget 管理。

预设从外部服务请求数据。自定义样式引用的数据源、sprite 和字形必须可访问，并为应用所在域配置 CORS。请展示数据提供方要求的署名，在演示之外使用预设前核对其服务条款。

## 开发

| 命令                     | 用途                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `pnpm dev`               | 启动 Vite 演示服务器                                                                       |
| `pnpm build`             | 类型检查并构建演示，产物位于根目录 `dist/`                                                 |
| `pnpm preview`           | 预览构建后的演示                                                                           |
| `pnpm build:mvt`         | 构建库模块、worker、source map 和类型声明，产物位于 `packages/cesium-vector-tileset/dist/` |
| `pnpm lint:eslint`       | 运行 ESLint 并自动修复                                                                     |
| `pnpm lint:eslint:check` | 检查 ESLint，不修改文件                                                                    |
| `pnpm lint:tsc`          | 运行 workspace TypeScript 检查                                                             |
| `pnpm test`              | 运行 Vitest 单元测试                                                                       |
| `pnpm test:e2e`          | 构建库和演示，再运行默认 Playwright 测试集                                                 |
| `pnpm test:e2e:live`     | 构建库并运行标有 `@live` 的 Playwright 外部服务测试                                        |

运行浏览器测试前，通过 `pnpm exec playwright install chromium` 安装 Chromium。Playwright 报告与失败产物位于 `node_modules/.cache/playwright/`。

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

发布时，将 `packages/cesium-vector-tileset/package.json` 更新为尚未发布的版本，运行 `pnpm install` 更新锁文件并提交，然后推送对应标签，例如版本 `0.0.2` 使用 `v0.0.2`。标签与包版本不一致时，工作流会失败。正式版本发布到 `latest`，`0.0.3-beta.1` 这样的预发布版本发布到 `next`。工作流使用 pnpm 打包构建产物、文档和许可证，再使用 npm CLI 通过 OIDC 发布 tarball。

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
