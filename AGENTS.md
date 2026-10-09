# 项目定位与实现策略

本项目大量使用 MapLibre GL JS 相关代码和设计，结合 Cesium 提供的 Buffer\*Collection、各类 Primitive 等能力混合实现。

## 关键命令

```bash
pnpm dev            # Vite 开发服务器
pnpm test           # vitest run
pnpm lint:eslint    # eslint --fix
pnpm lint:tsc       # vue-tsc --build --force
pnpm build          # 构建库与 Vite 演示；类型检查使用 lint:tsc
```

命令链顺序（修改后）：`lint:eslint` → `lint:tsc` → `test`（若有新增测试）。

TypeScript 固定在 `6.0.x`：`vue-tsc` 需要 `typescript/lib/tsc`（TS 7 已移除该子路径），
`typescript-eslint` 的 peer 上限也是 `<6.1.0`。升级 TS 前先确认两者都已支持。

样式代码生成（`src/**/*.g.ts`，勿手改）：

```bash
pnpm codegen                # 样式属性 + struct array
pnpm generate-unicode-data  # Unicode 属性表
```

生成物需跑一次 `pnpm lint:eslint` 才会与提交态一致。

## 设计与编码约定

- 禁止临时兼容层、猜测式编码、新旧双轨逻辑
- 文件名使用 `kebab-case`
- 命名简洁但勿滥简写（`value` 勿 `val`）
- 单次使用且只转调函数、构造器或读取属性的包装直接内联；独立模块应承载算法、状态、资源生命周期或实际复用的规则。删除接口前核对生产代码、测试、构建脚本和公开导出。

## 测试

- 测试文件放在被测试文件同级的 `__test__/` 目录下
- Vitest，jsdom 环境，配置文件 `vitest.config.ts`
- 运行：`pnpm test`

## Agent skills

临时脚本、实验文件放在 `node_modules/.cache/temp/`；测试产物放在 `node_modules/.cache/playwright/`。

### Triage labels

The five canonical triage roles use English labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` at the repo root + `docs/adr/`. See `docs/agents/domain.md`.
