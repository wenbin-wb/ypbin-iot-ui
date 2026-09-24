# ypbin-iot-ui 同步纪律（与 ypbin-iot 后端同一套路）

本仓 = `ypbin-admin-ui`（vben admin 派生）的 **IoT 前端**。上游只跟 `main`。

## 硬规则

1. **只跟 main**：`upstream` 指向 `wenbin-wb/ypbin-admin-ui`，只同步它的 `main`；不合其它分支。
2. **改动白名单**（IoT 页面必须落在这些位置，其余一律**新增文件**）：
   - `apps/web-antd/src/api/iot/**`（IoT 接口客户端）
   - `apps/web-antd/src/views/iot/**`（IoT 页面）
   - `apps/web-antd/src/locales/langs/*/page.json` 的 **`iot` 段**（菜单/字段文案）
   - `deploy/**` 里与 IoT 服务相关的反代/静态托管接线
   除上述位置外修改上游文件，必须在 PR 说明里写明**为什么必须改上游**（例如通用缺陷修复），并尽量反向移植给 upstream。
3. **菜单与权限码由后端提供**：页面路径必须与 `ypbin-iot` 的 `deploy/sql/007-iot-data.sql` 里
   `sys_menu.component` 一致（例如 `/iot/devices/index` ⇄ `apps/web-antd/src/views/iot/devices/index.vue`）；
   权限码一律用后端已登记的（`iot:device:*` / `iot:product:*` / `iot:group:*` / `iot:availability:get` /
   `iot:maintenance:*`），前端不得自造。
4. **门禁**：PR 必须过 `CI`（lint + typecheck + build）与 `CodeQL`；改菜单/权限的 SQL 由后端仓的门禁兜住。
5. **本机不跑全量前端构建**（低配机器约定）⇒ 前端验证以 CI 为准，PR 说明里附 CI 结论。

## 与后端仓的关系

- `ypbin-iot`（后端）：菜单/权限/接口契约的唯一事实源；
- 本仓：只做展示与交互，接口契约以后端 DTO 为准（Long/BigDecimal 后端按字符串序列化，前端按需 `Number()`）。
