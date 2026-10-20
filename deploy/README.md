# 前端部署配置在哪？

**本仓不保存部署配置。** 生产部署的唯一事实源在后端仓 `ypbin-iot`：

| 内容 | 位置（后端仓 `ypbin-iot`） |
|---|---|
| 一条命令部署前端 | `deploy/ui-up.sh` |
| 容器定义与端口/产物挂载 | `deploy/docker-compose.yml` 的 `ypbin-iot-ui` 服务 |
| nginx 配置（静态托管 + `/api/` 反代网关 + SSE + 压缩/安全头） | `deploy/nginx-microservice.conf` |
| 部署说明（含「生产必须 TLS」） | `docs/DEPLOY-UI.md` |

## 为什么删掉本仓原来的 `deploy/Dockerfile` 与 `deploy/nginx.conf`

- 它们是**过期副本**：`nginx.conf` 把 `/api/` 反代到 `http://admin:8080/`（生产上游应是网关
  `ypbin-gateway:18080`），且缺 SSE 必需的 `proxy_buffering off` / `proxy_http_version 1.1`
  —— 误用会让实时状态/告警「看起来不实时」；
- 生产路径明确是「后端仓构建产物 + nginx 挂载后端仓 `nginx-microservice.conf`」
  （`deploy/docker-compose.yml`），本仓再留一份配置只会继续漂移；
- 同理删除了 `scripts/deploy/`（上游 vben 模板遗留：构建的是 `playground`、含 CORS `*`、
  且 `build:docker` 脚本指向不存在的根 `Dockerfile`，`package.json` 的 `build:docker` 入口已移除）。

需要改部署行为时，请改后端仓 `ypbin-iot/deploy/`，不要在本仓重新引入副本。
