import { defineConfig } from '@vben/vite-config';

export default defineConfig(async () => {
  return {
    application: {},
    vite: {
      build: {
        rolldownOptions: {
          output: {
            // 数字孪生用的 three.js 单独切 chunk。
            //
            // 为什么需要：three 约 740KB（gzip ≈186KB），且只有进入 /iot/twin 才用得到。
            // 让它独立成 chunk 后：① 首屏不加载它；② 版本不变时切页面不重复下载；
            // ③ 便于在构建报告里单独看它的体积。
            //
            // 本仓构建链是 rolldown（见 internal/vite-config 的 `build.rolldownOptions`），
            // 不是 rollup。
            //
            // ⚠️ 这里有两个**实测踩过的坑**（工单 #125），改配置前务必读完：
            //
            // 坑 1：`includeDependenciesRecursively` 默认是 **true** —— 该组会把 three 的
            //   **全部递归依赖**一起吸进 `three-core`，其中包含被 UI 组件共用的
            //   `@babel/helpers` 之类模块。结果：`three-core` 里混入了非 three 的导出，
            //   而 `DialogTitle` / `AlertBuilder` 等纯 UI chunk 反过来
            //   `import { _n, vn } from './three-core-*.js'` ⇒ 231 个 chunk 静态依赖它、
            //   首屏 `index.html` 直接 `modulepreload` 740KB 的 three。
            //   **必须显式设为 false**，让分组只收 three 自己的文件。
            //
            // 坑 2：isolate 的判据**不是**「有没有单独的 chunk 文件」，而是：
            //   ① 首屏 `dist/index.html` 的 `modulepreload` 里没有 three；
            //   ② 静态 import 它的 chunk 数为 0（只剩动态 import）。
            //   `advancedChunks` 只决定「切到哪个文件」，**不决定「谁在何时加载」**。
            //
            // 另：引擎层（`src/three/twin/**`）**不得** import `src/views/**`，
            // 否则会形成静态依赖环把 three 拉回首屏（`anchor-layer` 曾反向 import 视图层的
            // 调色板，已把调色板下沉为 `src/three/twin/colors.ts`）。
            advancedChunks: {
              includeDependenciesRecursively: false,
              groups: [
                {
                  name: 'three-core',
                  priority: 20,
                  test: /node_modules[\\/]three[\\/]build[\\/]three\.(module|core)\.js$/,
                },
                {
                  name: 'three-bvh',
                  priority: 20,
                  test: /node_modules[\\/]three-mesh-bvh[\\/]/,
                },
              ],
            },
          },
        },
      },
      server: {
        proxy: {
          '/api': {
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/api/, ''),
            // 后端地址（本仓后端是 ypbin-iot；其网关默认端口 18080）。
            // 这里保留上游 vben 的 8080 默认值不改（生产由部署 nginx 反代 /api → ypbin-gateway:18080，
            // 见 ypbin-iot/deploy/nginx-microservice.conf）；本地联调 ypbin-iot 时按需把 target 改成 18080。
            target: 'http://localhost:8080',
            ws: true,
            configure: (proxy) => {
              // SSE 长连接（设备实时状态/告警刷新 /iot/realtime/stream）：Node 会因请求带
              // Connection: close 而给响应同样标记 close，Chrome 收到后会在首帧前的空闲期中止连接；
              // 强制响应保持连接，保证流式输出稳定送达。
              proxy.on('proxyRes', (proxyRes) => {
                proxyRes.headers.connection = 'keep-alive';
              });
            },
          },
          // 接口文档（knife4j/swagger）：页面与其相对资源都在后端，不 rewrite 原样转发，
          // 否则 /webjars、/v3/api-docs 等资源在前端端口 404 导致文档页白屏
          ...Object.fromEntries(
            [
              '/doc.html',
              '/webjars',
              '/v3/api-docs',
              '/swagger-ui',
              '/swagger-resources',
            ].map((p) => [
              p,
              { changeOrigin: true, target: 'http://localhost:8080' },
            ]),
          ),
        },
      },
    },
  };
});
