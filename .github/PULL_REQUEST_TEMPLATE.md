## 📌 Pull Request 描述

<!-- 请简明扼要地描述本次 PR 所做的修改内容与背景原因 -->

### 关联 Issue
- 关联的 Issue 编号：#<!-- 例如：#12 -->

### 变更类型
- [ ] 🐛 Bug 修复（非破坏性变更）
- [ ] ✨ 新功能
- [ ] ⚡ 性能优化 / 架构重构
- [ ] 📝 文档更新
- [ ] 🔧 构建 / CI / 依赖更新
- [ ] 💥 破坏性变更（Breaking Change）

### 质量自查清单

> **本清单已按本仓（vben 前端 monorepo，pnpm + vitest）的真实门禁重写。**
> 原清单是从 Maven/Java 栈的模板复制来的，逐条在本仓**不可能执行**，属于「勾了也证明不了任何事」的假绿：
> - `mvn spotless:apply` —— 本仓**没有 `pom.xml`**，全仓既无 Maven、也无 spotless 配置 ⇒ 该勾选**永不执行**；
> - `mvn test 100% 通过` —— 同理，本仓测试入口是 `pnpm exec vitest`，`mvn` 命令根本不存在；
> - 「没有引入内联全限定类名（FQCN），顶部 import 规范」—— FQCN 是 Java 概念，本仓是 TypeScript ⇒ 不适用；
> - 「若涉及配置项变更，已同步更新**属性类**」—— `@ConfigurationProperties` 属性类属 Java 后端，本仓无此层。
>
> 保留「新增测试」「无冗余 TODO」两类通用项；其余换成下面这些**跑得起来**的命令。
> 勾选前请实际运行，并在 PR 描述里贴出输出（R6：自验不等于验收）。

- [ ] `node scripts/check-iot-i18n-keys.mjs` 通过（IoT 页面用到的 i18n 键在 zh-CN / en-US 两份语言包里都存在）
- [ ] `node scripts/check-i18n-message-compile.mjs` 通过（语言包文案**能编译**：含未转义字面 `{`/`}` 的文案会在**渲染期**抛 `SyntaxError` 让整块白屏，仅「键存在」证明不了这件事）
- [ ] `pnpm -F @vben/web-antd run typecheck` 通过
- [ ] `pnpm exec vitest run --dom apps/web-antd/src/views/iot apps/web-antd/src/utils` 通过（IoT 页面的**运行时**组件级用例）
- [ ] 新增或修改的功能已补充测试，且**经变异验证**能咬人（把被修的那行改回去 ⇒ 对应用例必须转红）
- [ ] 无冗余的 TODO / FIXME 遗留
- [ ] 未引入新的 lint / 类型错误（本仓 CI 不跑 lint，提交前请本地 `pnpm run lint` 自查）
