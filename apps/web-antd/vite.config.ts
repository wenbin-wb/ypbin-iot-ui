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
            // 为什么需要：three 约 600KB（压缩后 ~150KB），且只有进入 /iot/twin 才用得到。
            // 让它独立成 chunk 后：① 首屏主包不含它；② 版本不变时切页面不重复下载
            // （浏览器长期缓存）；③ 便于在构建报告里单独看它的体积。
            //
            // 注：本仓构建链是 rolldown（见 internal/vite-config 的 `build.rolldownOptions`），
            // 不是 rollup ⇒ 用 `advancedChunks` 而非 `manualChunks`。
            // addons（GLTFLoader/CSS2DRenderer 等）不单独分组：它们由引擎层
            // 动态 import 引入，会被自动并入对应的动态 chunk。
            advancedChunks: {
              groups: [
                {
                  name: 'three-core',
                  test: /node_modules[\\/]three[\\/]build[\\/]three\.(module|core)\.js$/,
                },
                {
                  name: 'three-bvh',
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
