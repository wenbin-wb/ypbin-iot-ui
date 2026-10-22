# 设备呈现改造（选中高光 / 拖拽放置）—— 集成计划与接口契约

> 用户原话（2026-10-22）：
> 1. 「现在都是在设备上标记一个圆点，默认显示设备的名称显得页面有点混乱，我不想要这种表现形式」
> 2. 「可以不要圆点吗？直接选择具体的设备，会有选中效果，比如具体选中某个柜子，会有高光，然后显示设备详情卡片之类的效果」
> 3. 「可以在资料库拖动某个设备到画布里」
> 4. 拖拽改位置：**只改草稿，点「保存」才落库**

## 一、目标形态

| 状态 | 画布表现 |
|---|---|
| 默认 | **不显示任何圆点、不显示任何文字标签**；只有模型本身 |
| 悬停 | 光标下的设备模型**弱高亮**（emissive） |
| 选中 | 该设备模型**强高亮**（描边/发光）+ 其余设备压暗（可选）+ **设备详情卡片**弹出 |
| 拖入 | 从资料库拖设备到画布，落点显示**预览标记**，松手生成草稿点位 |
| 拖拽改位置 | 选中后拖动，**只改草稿**；「保存」才写库（与现有配置态口径一致） |

## 二、引擎层契约（Track A 实现，`three/twin/**`）

```ts
// scene-manager 新增（签名冻结，视图层已按此接线）
setSelectedPoint(pointId?: string): void        // 选中/取消选中（模型节点高亮 + 锚点层持久显示该点）
getSelectedPoint(): string | undefined
setHoveredPoint(pointId?: string): void         // 悬停弱高亮（undefined 清除）
hasNodeForPoint(pointId: string): boolean       // 该点位能否在模型上找到节点（false ⇒ 卡片提示）
screenToLocal(x: number, y: number): { x: number; y: number; z: number } | undefined  // 屏幕像素 → 场景局部
setDropPreview(local?: { x: number; y: number; z: number }): void                     // 拖拽落点预览
```

```ts
// anchor-layer 新增
setSelected(pointId?: string): void             // 选中时持久显示该点的圆点与数值标签；默认不显示
setLightTheme(light: boolean): void             // 已合入 main（浅色主题白底深字）
```

回调语义（`AnchorLayerCallbacks`）：
- `onHoverAnchor(pointId | undefined)`：进入/离开（DOM 权威，几何仅补充）；
- `onClickAnchor(pointId)`：点击锚点标签/圆点 ⇒ 视图层**选中**；
- `onDismissAnchor()`：Esc ⇒ 取消选中。

## 三、视图层（Lead 实现，`views/iot/twin/**`）

| 组件 | 职责 |
|---|---|
| `modules/device-detail-panel.vue` | 选中设备的详情卡：身份 / 状态 / 全部属性实时值 / 设备详情 / 点位配置 |
| `modules/device-library.vue` | **拖拽源**：已放置点位 + 未放置设备候选；HTML5 DnD（`text/plain` 协议 `twin-device:<id>`） |
| `modules/twin-canvas.vue` | 接收拖放：`drop` ⇒ `screenToLocal` ⇒ 生成草稿；`dragover` ⇒ `setDropPreview`；选中芯片与卡片定位 |
| `composables/use-twin-drag.ts` | 拖拽状态机（拖入/落点/草稿/脏标记/保存）——纯状态，可单测 |
| `index.vue` | 把「设备资料库」接入左车道；选中 → `?pointId=`（URL 唯一真相）；保存走既有 `PUT points/{id}` |

## 四、验收口径

1. 画布默认**无圆点、无标签**（截图对比改造前）；
2. 点击设备 ⇒ 模型高亮 + 详情卡出现（卡片里有该点位全部绑定属性的实时值）；
3. 资料库拖设备到画布 ⇒ 新点位草稿 + 表单预填落点坐标；已有点位可拖拽改位置（草稿）；
4. 点「保存」才落库（刷新后位置保持）；未保存时切场景有提示；
5. `prefers-reduced-motion` 下高亮不做脉冲；亮/暗主题下高光与卡片都清晰；
6. 门禁全绿（vitest / oxlint / eslint / typecheck / i18n×3）。

## 五、已知取舍

- **不再默认显示数值**：用户明确要求去掉常驻标签；数值移到「选中后的详情卡」，仍满足
  「点击能看到实时属性值」的原始诉求；
- **没有设备时**：画布空白（不画占位圆点），由资料库与提示文案引导放置；
- **拖拽落点**：命中模型表面才有坐标；落在天空/空白处时保持拖拽态并提示重新放置。
