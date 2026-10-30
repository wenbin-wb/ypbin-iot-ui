<div align="center">

# 🏭 Ypbin IoT UI

**物联网平台前端 · IoT Platform UI**

> `ypbin-iot` 的前端：在 `ypbin-admin-ui` 基座上增量构建的 IoT 页面（设备台账、产品/物模型、点位、影子、告警、在线调试），同时保留基座的组织权限、消息、任务与 AI 对话界面。

**Vue 3.5 · TypeScript · Vite · Ant Design Vue 4 · Pinia · Vben Admin 5**

[![CI](https://github.com/wenbin-wb/ypbin-iot-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/wenbin-wb/ypbin-iot-ui/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[后端 ypbin-iot](https://github.com/wenbin-wb/ypbin-iot) · [上游 ypbin-admin-ui](https://github.com/wenbin-wb/ypbin-admin-ui) · [文档](https://ypbin.cn/)

**中文** | [English](./README.en-US.md)

</div>

---

## 📌 项目简介

本仓是 [`ypbin-admin-ui`](https://github.com/wenbin-wb/ypbin-admin-ui) 的 **fork**，为 [`ypbin-iot`](https://github.com/wenbin-wb/ypbin-iot) 提供前端。基座提供 RBAC、多租户、动态路由、消息中心与 AI 对话；IoT 增量提供设备、产品与物模型、点位映射、影子、告警中心与在线调试。

- 菜单、路由与权限码由后端 `sys_menu` 驱动，前端不自造。
- IoT 代码集中在 `apps/web-antd/src/api/iot/**` 与 `apps/web-antd/src/views/iot/**`。
- 与上游的同步纪律见 [`SYNC.md`](SYNC.md)。

## 🚀 快速开始

后端先启动（见 [`ypbin-iot`](https://github.com/wenbin-wb/ypbin-iot)，网关默认 `18080`），然后：

```bash
corepack enable
corepack prepare pnpm@11.16.0 --activate   # 仓库锁定的 pnpm 版本
pnpm install
pnpm dev:antd                              # http://localhost:5666
```

开发服务器默认把 `/api` 代理到 `http://localhost:8080`（上游 vben 的默认值）；本地联调 `ypbin-iot` 时，把 `apps/web-antd/vite.config.ts` 的 target 改成 `http://localhost:18080`。生产由 nginx 反代 `/api` 到网关，配置见后端仓 `deploy/nginx-microservice.conf`。

## 📦 生产构建

```bash
pnpm -F @vben/web-antd build
# 产物：apps/web-antd/dist
```

部署与反向代理接线见后端仓的 `deploy/`；生产环境 `VITE_GLOB_API_URL` 默认 `/api`，由 nginx 转发到网关。

## 🧪 校验

```bash
pnpm -F @vben/web-antd run typecheck
pnpm exec vitest run --dom apps/web-antd/src/views/iot apps/web-antd/src/utils
node scripts/check-iot-i18n-keys.mjs
node scripts/check-i18n-message-compile.mjs
```

完整门禁（typecheck + 单测 + 构建）在 CI 中执行。

> 🔐 `VITE_APP_STORE_SECURE_KEY` 是 pinia 持久化加密密钥：开发默认值在 `apps/web-antd/.env.development`；**生产必须由部署环境注入**。缺失或仍是占位符时，应用启动会被 `packages/stores` 的守卫直接拒绝——不允许「假加密」静默运行。

## 📁 目录结构

```
apps/web-antd/                 # 主应用（Vue 3 + Ant Design Vue）
  src/api/iot/                 # IoT 接口客户端
  src/views/iot/               # IoT 页面（设备/产品/告警/分组/维护…）
  src/locales/langs/*/page.json# 文案（IoT 在 iot 段，运行时命名空间 page.*）
packages/                      # 共享库（layouts、common-ui、preferences 等）
internal/                      # 构建工具链（vite-config、eslint-config 等）
deploy/                        # 与 IoT 服务相关的反代/静态托管接线
```

## 🤝 贡献

先读 [`SYNC.md`](SYNC.md)：修改上游既有文件需要白名单登记与理由，IoT 页面优先用新文件实现。提交遵循 Conventional Commits（`type(scope): 描述`）。

## 📄 许可证

[MIT](./LICENSE)。本项目派生自 [vue-vben-admin](https://github.com/vbenjs/vue-vben-admin)（MIT，Copyright (c) 2024-present, Vben）与 [ypbin-admin-ui](https://github.com/wenbin-wb/ypbin-admin-ui)；按 MIT 要求保留原作者版权与许可声明，IoT 新增部分版权归 Copyright (c) 2026-present, ypbin-admin authors。
