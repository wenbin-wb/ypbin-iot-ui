# smart-park-3d 资产接入记录（2026-10-22）

## 结论

`/home/wenbin/projects/smart-park-3d`（87 个模块化 GLB + 7 层园区 + 总装 5.8MB + 布局 JSON）
**可直接作为数字孪生场景模型使用，零代码改动**——这正是「换模型 = 纯配置」的实证。

## 已上传的资产（dev）

| 资产名 | 文件 | 大小 | 用途 |
|---|---|---|---|
| 智慧园区-总装（smart-park-3d） | `smartpark-site.glb`（原样 = `smart_park_master.glb`） | 5.75 MB | 园区级场景（1232 节点 / 91 mesh / 0 动画） |
| 智慧园区-IoT设备（可选中高光） | `smartpark-iot-focus.glb`（生成） | 5.74 MB | IoT 设备园区：68 个设备实例**就地放大 2.6×**，便于点击选中 |

生成脚本：`/home/wenbin/wt-src/smartpark/gen-scene.mjs`（零第三方依赖：自写 GLB JSON/BIN chunk 读写，
只改节点 `matrix` 的缩放列，不改坐标、不改资源，产物通过 GLB 头校验）。

## 已绑定的场景（dev）

| 场景 | 树位置 | 资产 |
|---|---|---|
| 演示园区 | 根 | 智慧园区-总装（俯视全景相机） |
| 1 号厂房 | 演示园区 / 1 号厂房 | 智慧园区-IoT设备（斜俯视相机） |
| 1 层生产车间 | 演示园区 / 1 号厂房 / 1 层生产车间 | 原「演示厂房 V2」（机柜车间） |

## 已创建的点位（1 号厂房，5 个）

点位坐标来自资产包 `data/layout.json` 的真实实例位置（米、Y 上、Z 南），`localY` 固定 3.2（设备顶）。
`nodeName` 用**多候选**语法对齐资产命名（资产里设备常共享几何、只渲染成 `camera_pole` 这样的节点）：

```
camera_pole_0000|camera_pole
camera_pole_0001|camera_pole
smart_lamp_post_0014|smart_lamp_post
smart_lamp_post_0015|smart_lamp_post
speaker_horn_0025|speaker_horn
```

## 接入里踩到并修掉的两个问题

1. **设备属性绑定的 `serviceIdentifier` 不是属性名**：演示设备的服务标识是 `DemoThService`
   （电压设备是 `DemoPowerService`），写成 `temperature` 会被后端 409 拒绝。
   正确取值来源：`GET /iot/twin/devices/{id}/properties` 的 `serviceIdentifier` 字段。
2. **资产共享几何导致节点名对不上**：`camera_pole_0000` 这类实例名在总装里往往不存在，只有
   `camera_pole`（同一几何被复用 10 次）。已给点位 `nodeName` 增加 `a|b` 多候选匹配（精确优先、
   宽松兜底），详见 `three/twin/device-focus.ts#splitNodeNameCandidates`。

## 已知限制（如实登记）

- 资产包**无动画**（`animations: 0`）⇒ 该场景没有「模型自己动」那一档，其余动效（脉冲/扫描/巡航）不受影响；
- 资产包**无 `Roof*`/`Wall_*`/`Truss*` 命名** ⇒「剖切/完整」开关不出现（设计上的正确行为）；
- 共享几何意味着「选中一个实例」会高亮**所有同型实例**（材质是共享的）。这是资产限制，
  不是渲染缺陷；要精确到单个实例需要资产按实例拆分几何。
- 园区 380×320m 规模下，软件渲染（dev 无 GPU）帧率约 20fps；真实显卡无压力。
