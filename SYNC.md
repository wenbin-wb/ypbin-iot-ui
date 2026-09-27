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
4. **门禁**：PR 必须过 `CI`（typecheck + 单元测试 + 构建；**注意本仓 CI 没有 lint 步骤**）与 `CodeQL`；改菜单/权限的 SQL 由后端仓的门禁兜住。
5. **本机不跑全量前端构建**（低配机器约定）⇒ 前端验证以 CI 为准，PR 说明里附 CI 结论。
6. **IoT 文案键必须过 `node scripts/check-iot-i18n-keys.mjs`**（CI 已接）：`page.json` 的运行期命名空间是 `page.*`
   ⇒ 页面里写 `$t('page.iot.xxx')`。缺键/写错前缀会让界面显示原始 key——实测过一次（95 处），当时 CI 全绿也发现不了。
   为补这个盲区，本仓**故意修改了上游文件** `.github/workflows/ci.yml`（加一步校验），属于「白名单外的必要改动」，
   已在 PR 说明里注明理由。
7. **文案里禁止出现未逃逸的字面 `{` `}`**：vue-i18n 在**运行期**编译消息，消息里一个裸 `{`
   会被当成占位符解析 ⇒ **`$t(...)` 直接抛 `SyntaxError: Message compilation error`**。
   渲染函数里抛异常 = 整块页面空白，而 typecheck/构建/键存在性门禁**全绿**（因为键是存在的、只是编译不过）。
   - 实测事故（2026-09-27）：`page.iot.debug.valueHint` 写成 `…{"a":1} → 对象…` ⇒ 设备详情「在线调试」页签整块空白；
     生产埋点 `sys_track_event` 抓到 `web.error.js` + `SyntaxError`（栈落在 locale chunk 的 `$t` 上）才定位到根因。
   - **写法**：字面花括号必须用 vue-i18n 的字面量插值语法 —— `{'{'}` 与 `{'}'}`（例如 `{'{'}"arg": 1{'}'}`）。
   - **回归门禁**：`apps/web-antd/src/views/iot/devices/modules/detail-debug.test.ts` 用**真实 i18n 实例**
     逐条编译 `page.iot.*` 文案（含 zh/en），并挂载真实组件断言三态；
     该页签另套 `panel-error-boundary.vue`，任何 setup/render 异常都落成 Alert（原样显示错误栈），**绝不留空白**。
   - 教训：**组件级用例里 mock 掉 `#/locales` 会结构性地漏掉这类 bug**——必须用真实 i18n 跑。

## 与后端仓的关系

- `ypbin-iot`（后端）：菜单/权限/接口契约的唯一事实源；
- 本仓：只做展示与交互，接口契约以后端 DTO 为准（Long/BigDecimal 后端按字符串序列化，前端按需 `Number()`）。
