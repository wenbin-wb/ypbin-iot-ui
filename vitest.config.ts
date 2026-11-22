import Vue from '@vitejs/plugin-vue';
import VueJsx from '@vitejs/plugin-vue-jsx';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [Vue(), VueJsx()],
  test: {
    environment: 'happy-dom',
    environmentOptions: {
      happyDOM: {
        settings: {
          // happy-dom v20+ disables JS evaluation by default (security fix).
          // Treat disabled script loading as success to preserve test behavior.
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
    exclude: [
      ...configDefaults.exclude,
      '**/e2e/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/node_modules/**',
      '**/{stylelint,eslint}.config.*',
      '**/{oxfmt,oxlint}.config.*',
      // 🔴 2026-11-22 加：CI 里会为「fork 同步门禁」把上游 admin-ui 检出到 `ypbin-admin-ui/`，
      // 而 vitest 默认按 include 扫全仓 **/*.test.ts ⇒ 会把上游自己的测试也拉进来跑。
      // 实测后果（run #480）：上游的 store/message.test.ts 在本仓 node_modules 解析不到 pinia
      // （它属于另一个 pnpm workspace），整份测试套件因此变红。
      // 检出目录不是本仓源码，必须排除——否则「加一个门禁」会顺带打红单测。
      '**/ypbin-admin-ui/**',
    ],
  },
});
