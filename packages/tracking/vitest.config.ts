import { configDefaults, defineConfig } from 'vitest/config';

/**
 * 本包自带的 vitest 配置。
 *
 * 为什么必须单独放一份、而不能只依赖仓库根的 vitest.config.ts：
 * vitest 5 起不再向祖先目录查找配置文件（官方 v5.0.0 破坏性变更
 * "Don't lookup config file from ancestor directories"，vitest-dev/vitest#10428）。
 * 本包 package.json 的 test 脚本是 vitest run，在 packages/tracking 下执行；
 * 少了本文件就会落到 vitest 默认的 node 环境，SDK 用例里的 document/history
 * 全部 ReferenceError（CI 表现为“单元测试（埋点 SDK）”整文件 28 条失败）。
 *
 * 环境口径与仓库根配置保持一致（happy-dom + happyDOM.settings），避免两处行为漂移。
 */
export default defineConfig({
  test: {
    environment: 'happy-dom',
    environmentOptions: {
      happyDOM: {
        settings: {
          // happy-dom v20+ 默认关闭 JS 求值（安全修复），与根配置同口径。
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
    exclude: [...configDefaults.exclude, '**/dist/**'],
  },
});
