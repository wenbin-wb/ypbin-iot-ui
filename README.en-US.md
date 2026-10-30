<div align="center">

# 🏭 Ypbin IoT UI

**IoT Platform Frontend**

> The frontend for `ypbin-iot`: IoT pages built on top of `ypbin-admin-ui` (devices, products/thing models, points, shadows, alerts, online debugging), while keeping the base platform's RBAC, messaging, jobs and AI chat.

**Vue 3.5 · TypeScript · Vite · Ant Design Vue 4 · Pinia · Vben Admin 5**

[![CI](https://github.com/wenbin-wb/ypbin-iot-ui/actions/workflows/ci.yml/badge.svg)](https://github.com/wenbin-wb/ypbin-iot-ui/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[Backend ypbin-iot](https://github.com/wenbin-wb/ypbin-iot) · [Upstream ypbin-admin-ui](https://github.com/wenbin-wb/ypbin-admin-ui) · [Docs](https://ypbin.cn/)

[中文](./README.md) | **English**

</div>

---

## Introduction

This repository is a **fork** of [`ypbin-admin-ui`](https://github.com/wenbin-wb/ypbin-admin-ui) and provides the frontend for [`ypbin-iot`](https://github.com/wenbin-wb/ypbin-iot). The base platform supplies RBAC, multi-tenancy, dynamic routes, messaging and AI chat; the IoT layer adds devices, products/thing models, point mappings, shadows, alerting and online debugging.

- Menus, routes and permission codes are driven by the backend `sys_menu`; the frontend never invents them.
- IoT code lives in `apps/web-antd/src/api/iot/**` and `apps/web-antd/src/views/iot/**`.
- Upstream sync rules: see [`SYNC.md`](SYNC.md).

## Quick start

Start the backend first (see [`ypbin-iot`](https://github.com/wenbin-wb/ypbin-iot); the gateway defaults to `18080`), then:

```bash
corepack enable
corepack prepare pnpm@11.16.0 --activate   # pnpm version pinned by this repo
pnpm install
pnpm dev:antd                              # http://localhost:5666
```

The dev server proxies `/api` to `http://localhost:8080` by default (the upstream vben default). For local work against `ypbin-iot`, change the target in `apps/web-antd/vite.config.ts` to `http://localhost:18080`. In production nginx reverse-proxies `/api` to the gateway; see `deploy/nginx-microservice.conf` in the backend repository.

## Production build

```bash
pnpm -F @vben/web-antd build
# output: apps/web-antd/dist
```

Deployment and reverse-proxy wiring live in the backend repository's `deploy/`. In production `VITE_GLOB_API_URL` defaults to `/api`, which nginx forwards to the gateway.

> 🔐 `VITE_APP_STORE_SECURE_KEY` is the pinia persistence encryption key: the development default lives in `apps/web-antd/.env.development`; **production must inject it from the deployment environment**. If it is missing or still a placeholder, the guard in `packages/stores` refuses to start the app — no silent "fake encryption".

## Checks

```bash
pnpm -F @vben/web-antd run typecheck
pnpm exec vitest run --dom apps/web-antd/src/views/iot apps/web-antd/src/utils
node scripts/check-iot-i18n-keys.mjs
node scripts/check-i18n-message-compile.mjs
```

The full gate (typecheck + unit tests + build) runs in CI.

## Layout

```
apps/web-antd/                 # main app (Vue 3 + Ant Design Vue)
  src/api/iot/                 # IoT API clients
  src/views/iot/               # IoT pages (devices/products/alerts/groups/maintenance…)
  src/locales/langs/*/page.json# copy (IoT under the iot section, runtime namespace page.*)
packages/                      # shared libraries (layouts, common-ui, preferences…)
internal/                      # build tooling (vite-config, eslint-config…)
deploy/                        # IoT-related proxy/static hosting wiring
```

## Contributing

Read [`SYNC.md`](SYNC.md) first: modifying upstream files requires whitelist registration and a reason; prefer new files for IoT work. Use Conventional Commits (`type(scope): description`).

## License

[MIT](./LICENSE). Derived from [vue-vben-admin](https://github.com/vbenjs/vue-vben-admin) (MIT, Copyright (c) 2024-present, Vben) and [ypbin-admin-ui](https://github.com/wenbin-wb/ypbin-admin-ui); upstream copyright and license notices are retained. IoT additions are Copyright (c) 2026-present, ypbin-admin authors.
