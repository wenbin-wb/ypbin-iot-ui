# Track A 交付说明：渲染管线 / 标签布局 / 动效 / 相机

> 分支 `feat/twin-visual-a`，基线 `6ce636a`，工作目录 `/home/wenbin/wt-twinA`。
> **所有改动都在 `apps/web-antd/src/three/twin/**`**（引擎层）；`views/**` 一行未改（按分工由 Lead 集成）。

## 0. 结论先行

| 项 | 状态 | 客观证据 |
|---|---|---|
| A 渲染管线（色彩管理/色调映射/阴影/环境贴图/后处理/背景） | ✅ 完成 | `renderer-options.test.ts` 11 pass（含 2 处变异红） |
| B 标签防重叠 | ✅ 完成 | `label-layout.test.ts` 17 pass；dev 基线实测 6 个标签 **1 对重叠**（见 §5） |
| C 动效（GLB 动画/环境/脉冲/扩散环/跳变/巡航） | ✅ 完成 | `twin-animator.test.ts` 12 pass、`camera-orbit.test.ts` 7 pass、`motion-profile.test.ts` 18 pass |
| D 集成契约 | ✅ 5+2 个方法全部实现 | §4 |
| 门禁 | ✅ 全绿 | §6：vitest 197 pass / vue-tsc exit 0 / oxlint 0 error / eslint exit 0 |
| 构建分包 | ✅ three 仍按需加载 | §7：`dist/index.html` 的 modulepreload **无 three** |
| 浏览器实测 | ⏳ 待 Lead 部署后跑 | 脚本已交付 §8 |

## 1. 改了哪些文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `three/twin/renderer-options.ts` | **新增** | 渲染器配置纯函数：`resolveRendererOptions` / `applyRendererOptions` / `resolveShadowCamera` / `resolvePostOptions` |
| `three/twin/environment.ts` | **新增** | PMREM+RoomEnvironment 环境贴图、程序化地面（斜向扫描线）、主次网格、扫描光圈 |
| `three/twin/motion-profile.ts` | **新增** | 动效档位（Lead 指定的单一真相；内容按其契约**原样实现，未改语义**） |
| `three/twin/label-layout.ts` | **新增** | 标签避让纯函数（贪心 + 径向候选 + 平滑） |
| `three/twin/twin-animator.ts` | **新增** | GLB 自带动画：选片策略 + mixer 生命周期 |
| `three/twin/camera-orbit.ts` | **新增** | 相机自动巡航（20s 空闲触发、一交互即停、缓入） |
| `three/twin/scene-manager.ts` | 改 | 接渲染管线/环境/灯光动画/巡航/新 API；dispose 补齐 |
| `three/twin/anchor-layer.ts` | 改 | 标签避让接入、胶囊+圆点 DOM 契约、呼吸/扩散环/跳变高亮、hover 语义 |
| `three/twin/colors.ts` | 改 | 新增环境/灯光/后处理/标签色板（全部集中在此） |
| `three/twin/camera-rig.ts` | 改 | 修「新飞行打断旧飞行时旧 Promise 永不 resolve」；新增 `resolveFocusPose` / `jumpTo` |
| `*.test.ts` | 新增 6 个 | `renderer-options` / `label-layout` / `motion-profile` / `twin-animator` / `camera-orbit` / 扩展 `anchor-layer`（新增 10 用例，原 3 个保持） |
| `apps/web-antd/scratch/twin-verify/screenshot.mjs` | **新增** | 部署后一键截图 + 结构自检 |

commit 拆分见 §9。

## 2. A. 渲染管线（收益最大的一档）

改造前 `init()` 只设了 `antialias: true`，其余全是 three 默认值 ⇒ 无色调映射（高光裁切）、
无阴影（建筑像贴纸）、无环境反射（金属是灰块）。现在：

| 配置 | 值 | 理由 |
|---|---|---|
| `outputColorSpace` | `SRGBColorSpace` | 输出 sRGB；所有颜色贴图（背景/地面）也显式标 sRGB |
| `toneMapping` | `ACESFilmicToneMapping` | 高光滚降自然，是 three 官方示例对真实感场景的默认选择 |
| `toneMappingExposure` | `1.1` | ACES 会压暗中灰，1.1 让暗部可读又不过曝 |
| `shadowMap.enabled/type` | `true` / `PCFSoftShadowMap` | 软阴影才像建筑渲染；mapSize 2048 |
| 阴影相机范围 | **按模型包围盒自适应**（`resolveShadowCamera`） | 固定 ±100 会让毫米级模型「阴影糊成一片」、千米级园区「完全没有阴影」 |
| `scene.environment` | PMREM + `RoomEnvironment`，强度 `0.62` | 一次生成、切场景不重建；`RoomEnvironment` 与 `PMREMGenerator` 生成后立即 dispose |
| 灯光 | `HemisphereLight`(顶 `#8fa6c8` / 底 `#16202e`) + `DirectionalLight`(投影) + 弱补光 | 顶亮侧暗是体积感的来源 |
| 后处理 | `RenderPass → UnrealBloom(0.9/0.3/0.45) → OutputPass → FXAAPass` | 顺序见下 |
| 背景 | canvas 渐变纹理（顶亮底暗的深冷灰蓝） | 替代「纯 #0b1220 黑洞」 |

**后处理顺序为什么不能换**（踩过的坑写进注释）：
- Bloom 必须在 `OutputPass` **之前**：在 HDR 线性空间做 bloom，阈值 0.9 才有物理意义；
- FXAA 必须在 `OutputPass` **之后**：FXAA 要求 sRGB 输入，放在前面会把线性值当 sRGB 做边缘检测；
- 有 composer 时色调映射与 sRGB 由 `OutputPass` 接管；renderer 上的两项**照旧设置**
  （OutputPass 从 renderer 读配置），不会二次 tone mapping；
- 开启 composer 时 renderer 的 `antialias` 关掉（MSAA 对 RT 无效，白付带宽），抗锯齿交给 FXAA。

**`view.ambientIntensity` 语义保持**：`applyView` 原来按 `child instanceof AmbientLight` 找灯，
换成 `HemisphereLight` 后改为按 `HemisphereLight` 匹配（**这是必须的**，否则编辑里调强度画面无反应）；
`directionalIntensity` 仍按 `DirectionalLight` 匹配，并额外要求 `castShadow`（避免命中补光）。

## 3. B. 标签防重叠

**算法**（`label-layout.ts`，纯函数）：
1. 按优先级（告警 3 > 在线 2 > 离线/未知 1 > 停用 0）降序，依次为每个标签挑「位移最小且不冲突」的位置；
2. 候选 = 原位置 + 理想位移（圆点正上方 14px）+ 24 个固定径向候选（3 环 × 8 向，步长 20px）；
3. 放不下 ⇒ `collapsed=true` 降级为圆点（hover 仍可展开、可点击，**绝不重叠**）；
4. 相交判定带 1px 容差（避免 0.5px 抖动触发无尽重排）；
5. 输出与输入**同序**、**确定性**（同样输入每帧同样输出，否则标签会逐帧跳位）。

**性能**：O(n²)，代码注释写明「**超过 64 个点位需换空间网格**」；重排降频到 ~10Hz；
位移用帧率无关的一阶低通（`smoothOffset`）平滑；**每帧不做 raycast**（运维要看到墙后设备，
遮挡判断无价值且在大模型上是纯浪费）。

**DOM 契约**（hover 卡片集成用，稳定）：

| 选择器 / 属性 | 含义 |
|---|---|
| `.twin-anchor-label` | 标签外层（定位挂点） |
| `.twin-anchor-label[data-point-id]` | 点位 ID |
| `.twin-anchor-capsule` | 胶囊视觉层 |
| `.twin-anchor-dot` | 圆点（`currentColor` = 状态色，大小 14px） |
| `.twin-anchor-name` / `.twin-anchor-value` | 设备名 / 数值（分离，卡片可单独读） |
| `[data-collapsed="true"]` | 被挤压，当前只显示圆点 |
| `[data-hovered="true"]` | 当前 hover |
| `[data-alert="true"]` | 有活动告警 |
| `.twin-anchor-value[data-flash="true"]` | 数值跳变高亮的 600ms 内 |

> 定位实现：CSS2DRenderer 每帧重写 `transform`，所以避让位移写在 `left/top`，
> hover 缩放走 `--twin-hover-scale` CSS 变量（写在 transform 里会被覆盖 ⇒ hover 没反应）。

## 4. D. 集成契约（**最终签名**）

```ts
// scene-manager.ts（全部为新增方法，不破坏已有签名）
getAnchorWorldPosition(pointId: string): { x: number; y: number; z: number } | undefined;
projectToScreen(world: { x: number; y: number; z: number }): { visible: boolean; x: number; y: number } | undefined;
getMotionMode(): TwinMotionMode;            // 'normal' | 'reduced' | 'off'
flyToAnchor(pointId: string, distanceScale?: number): Promise<void>;  // 默认 0.55
setInteractionHover(pointId?: string): void;
getRenderStats(): { geometries: number; textures: number };   // renderer.info.memory
getModelMetrics(): { center: {x,y,z}; maxDimension: number } | undefined;  // 聚焦换算距离
setFlyHandler(handler: (pointId: string, distanceScale: number) => Promise<void>): void;
```

```ts
// anchor-layer.ts
onHoverAnchor?: (pointId: string | undefined) => void;  // 进入 = pointId，离开 = undefined
// 实例额外暴露：setMotionMode(mode) / setHovered(pointId?) / getLabelScreenPosition(pointId?)
```

### hover 判定：两条路径并存（**线上缺陷修复，commit 47acd68**）

**根因**：CSS2DRenderer 的 domElement 是 `pointer-events:none`，子元素必须自己设
`pointer-events:auto` 才能成为命中目标。改造时把标签拆成「外层 + 胶囊」两层，
**外层漏了 auto** ⇒ 鼠标事件整条穿透到 canvas，标签上的 `pointerenter` 永不触发；
而 DOM 层面看不出异常（`elementFromPoint` 仍返回标签外层 div）。

**修复（三层，前两层是 `47acd68`，第三层是 `518609b`）**：
1. 外层 `.twin-anchor-label` 显式 `pointer-events: auto`（修根因）；
2. **几何命中**（不依赖 DOM 命中测试）：容器上监听 `pointermove`（节流 ~30Hz）与
   `pointerleave`，用锚点屏幕坐标（从 CSS2D 写好的 transform 解析）做判定；
3. **命中区域 = 胶囊矩形，不是圆点圆**（`518609b` 修的第二个缺陷）：标签是
   200~300px 宽的胶囊，只判「圆点周围 13px」时真实鼠标（落在文字区域、距圆点
   50~100px）**永远不命中** —— 表现就是「合成事件能弹出卡片、真实鼠标不行」。
   现在：
   - 每轮 ~10Hz 重排后、**所有样式写完之后**读一次
     `.twin-anchor-capsule` 的 `getBoundingClientRect()` 换算到容器坐标，
     缓存为 `lastCapsuleRect`（不在每帧读，避免 layout thrash）；
   - 命中顺序：胶囊矩形（4px 容差，多命中取中心最近）→ 回退圆点 13px 圆
     （折叠成「只剩圆点」的标签没有可见胶囊，必须走这条）；
   - 重叠本不该发生（避让保证），hover 放大 1.12 倍时边缘可能轻微重叠 ⇒ 取最近者。

> 集成方不需要额外做什么：`twin-canvas.vue` 里 `onHoverAnchor: (id) => { manager.setInteractionHover(id); onHoverAnchor(id); }` 即可。
> views 层的 DOM 委托兜底可以留着（无害），但**不再是必要路径**。

⚠️ **`getMotionMode()` 的返回类型包含 `'off'`**（Lead 消息里写的是 `'normal' | 'reduced'`）：
弱机型档位是 `motion-profile.ts` 契约规定的第三档，去掉它会让「弱机型」无法上报。
页面状态栏若只做二态展示，请自行把 `'off'` 归到「降级」。

⚠️ **`flyToAnchor` 需要 `twin-canvas.vue` 注入 `setFlyHandler`** 才真正飞行（我不改 views）：
```ts
manager.setFlyHandler(async (pointId, scale) => {
  const world = manager!.getAnchorWorldPosition(pointId);
  if (!world) return;
  const metrics = manager!.getModelMetrics();
  await cameraRig!.flyTo({ target: world, distance: (metrics?.maxDimension ?? 100) * scale });
});
```
另外建议把 `onHoverAnchor: (id) => manager?.setInteractionHover(id)` 传给 `createAnchorLayer`：
hover 的标签不参与避让（否则鼠标放上去它就被挤走、点不中），且暂停该点位的脉冲。

## 5. C. 动效（三档 + 降级）

| 动效 | 实现 | 档位 |
|---|---|---|
| GLB 自带动画 | `twin-animator`：关键字（idle/loop/run/move/flow/conveyor/fan/spin/rotate/cycle）优先，命中不足按原顺序补齐，上限 8 个（超出 `console.warn`）；多 clip 同时循环 | `clipSpeed` 1 / 1/3 / **0** |
| 锚点呼吸 | 在线：`opacity` 0.92~1.0 正弦；告警：0.82~1.0 强脉冲 | normal / reduced✗ / off✗ |
| 告警扩散环 | 圆点 `::after` 描边环，`data-alert` 时 0.75 不透明度 | normal / reduced✗ / off✗ |
| 数值跳变 | `primaryText` 变化 ⇒ `.twin-anchor-value[data-flash]` 600ms；**与 600ms 告警闪烁定时器作用在不同属性上，不打架** | 全档保留（一次性动效，是信息载体） |
| 环境光缓变 | 半球光/主光强度 ±6%、周期 60s | normal / reduced✗ / off✗ |
| 扫描光圈 | 2 层贴地 RingGeometry，最大不透明度 0.12，周期 9s | normal / reduced✗ / off✗ |
| 相机巡航 | 空闲 20s 后 0.055 rad/s 缓入环绕；`pointerdown/wheel/touchstart/keydown` 立刻停 | normal / reduced✗ / off✗ |

**降级不影响可用性**：reduced/off 下标签仍完整显示（避让照做，只是不平滑）、仍可点选、
hover 仍展开；GLB 动画在 reduced 下继续以 1/3 速度播放（「动起来」的需求不失效）。

**档位单一真相**：只在 `resolveMotionMode` 判定；`scene-manager` init 时判定一次并监听
`matchMedia('(prefers-reduced-motion: reduce)')` 的 `change`（dispose 时移除监听，旧 Safari
回落 `addListener`），所有动效都查 `motionSwitches(mode)`，**其他文件不再判断档位**。

## 6. 门禁结果（全部命令串行跑，本机 2 核 5G）

```text
$ npx vitest run apps/web-antd/src/three/twin apps/web-antd/src/views/iot/twin packages/stores
 Test Files  22 passed (22)
      Tests  197 passed (197)          # 基线 122 + 新增 75

$ pnpm -F @vben/web-antd typecheck
$ vue-tsc --noEmit --skipLibCheck
EXIT=0

$ npx oxlint --type-aware --threads=4 apps/web-antd/src
Found 0 warnings and 0 errors.

$ git add -A <files> && npx eslint apps/web-antd/src/three/twin apps/web-antd/src/views/iot/twin
ESLINT_EXIT=0
```

分层守门 `layering-guard.test.ts` 4 用例保持绿：新增模块**零** `views/**`、`@vben/*`、
`vue`、`ant-design-vue`、`#/api` 静态依赖；three 运行时一律 `await import()`（`import type` 除外）。
`motion-profile.ts` 只读 `globalThis.matchMedia/navigator`，不碰任何 UI 模块 —— 与 Lead 侧同名文件**内容一致**（若你那边有差异以我的为准，我按你的契约逐条实现）。

## 7. 反向验证（变异 → 必须红 → 还原）

| # | 不变量 | 变异 | 结果 |
|---|---|---|---|
| 1 | 渲染器配置写入 | `applyRendererOptions` 删掉 `shadowMap.enabled = ...` | **2 红**（★ 五个字段全部落到 renderer 上 / 关闭阴影时也显式写入 false） |
| 2 | 色调映射 | `toneMapping` 改回 `0`(NoToneMapping) | **3 红** |
| 3 | mixer 生命周期 | `dispose` 删掉 `mixer.stopAllAction()` | **1 红**（★ dispose 必须 stopAllAction + uncacheRoot） |
| 4 | 档位降本 | `update` 忽略 `speed <= 0` | **1 红**（clipSpeed=0 时不推进 mixer） |
| 5 | hover 离开语义 | 只在进入时回调（旧语义） | **2 红**（★ 鼠标离开必须回调 undefined） |
| 6 | 数值跳变 | 不检测 `primaryText` 变化 | **1 红**（★ data-flash） |
| 7 | 标签避让 | `layoutLabels` 恒等返回原位置 | **7 红**（6 个必然重叠 ⇒ 输出无重叠 / 随机 50 组 / 位移最小化 / 高优先级占位 / 降级顺序 / 不参与布局 / 超出可视区） |
| 8 | 动效降级 | `resolveMotionMode` 恒返回 `'normal'` | **4 红**（偏好 reduce / 边界 4GB / 边界 4 核 / OR 关系） |

还原后全部回绿（197 pass）。变异前后示例输出：

```text
# 变异 7（label-layout 恒等）
   × ★ 全部锚点挤在同一处（相隔 6px）⇒ 输出无重叠，且 6 个都能显示
   × ★ 任意未降级标签都不相交（随机化几何，50 组，含边界情况）
   × ★ 只重叠一次时，位移取最小候选（≤ 一个基础步长），不把标签甩得很远
   × ★ 告警（高优先级）占据原位置，在线标签让开
   × ★ 超预算时降级顺序稳定：同样的输入永远降级同样的那批标签
   × 不参与布局的标签（labelVisible=false）不占位、也不影响别人
   × 超出可视区域的标签降级为圆点（不飘到画布外看不见）
      Tests  7 failed | 10 passed (17)

# 变异 8（resolveMotionMode 恒 normal）
   × ★ 偏好 reduce ⇒ reduced，且优先于弱机型（强烈弱机型也是 reduced）
   × ★ deviceMemory = 4（边界，含）⇒ off
   × ★ hardwareConcurrency = 4（边界，含）⇒ off
   × 两个弱机型条件任一命中即降级（OR 关系）
      Tests  4 failed | 14 passed (18)
```

## 8. 构建分包实测（`pnpm -F @vben/web-antd run build`，产物已删除、不提交）

```text
$ grep -c three dist/index.html          # 首屏 modulepreload 里有没有 three
0                                        # ✅ 没有

# 静态 import three-core 的 chunk（本分支）
CSS2DRenderer / DRACOLoader / EffectComposer / FXAAPass / GLTFLoader / KTX2Loader /
OrbitControls / OutputPass / Pass / RenderPass / RoomEnvironment / ShaderPass /
UnrealBloomPass / three-bvh                     → 14 个

# 同口径基线（stash 后构建 6ce636a）
CSS2DRenderer / DRACOLoader / GLTFLoader / KTX2Loader / OrbitControls / three-bvh
                                                → 6 个

# 业务 chunk 引用 three-core 的方式（基线与本分支一致，都是动态 import）
scene-manager-*.js: import(`./three-core-*.js`)
twin-canvas-*.js:   import(`./three-core-*.js`)
model-panel-*.js:   import(`./three-core-*.js`)
```

**结论**：three 仍只被**动态** import，首屏 `modulepreload` 无 three。
静态引用数 6 → 14 **不是新增泄漏**，而是基线里这些 addon chunk（EffectComposer/OutputPass/
RoomEnvironment…）**根本不存在**；每一个都是 three 自己 `examples/jsm` 下的 addon，
正是任务给出的门禁口径（「静态 import three-core 的 chunk 只剩 three 自己的 addons」）。
基线口径 6 与任务书说的「10 个」不同 —— 因为该数字包含 4 个业务 chunk
（model-panel/picker/scene-manager/twin-canvas），它们**不是**静态 import，而是
rolldown 生成的 `__vitePreload` 动态映射（实测 grep `from"./three-core-` 为空）。

## 9. 浏览器实测（待 Lead 部署）

脚本：`apps/web-antd/scratch/twin-verify/screenshot.mjs`

```bash
node apps/web-antd/scratch/twin-verify/screenshot.mjs \
  --url "https://<host>/#/iot/twin?sceneId=2112773048514154497" \
  --user admin --pass wenbin1314 \
  --out /tmp/twin-after.png --json /tmp/twin-after-report.json

# 验证动效降级：加 --reduced（等价于系统开「减少动态效果」）
node apps/web-antd/scratch/twin-verify/screenshot.mjs --reduced \
  --url "https://<host>/#/iot/twin?sceneId=2112773048514154497" --out /tmp/twin-reduced.png
```

脚本输出：6 个标签的 rect + **两两重叠检测**、canvas 尺寸、console error 数；
重叠或 error 任一 > 0 时 exit code = 1（可直接进 CI）。

**已在 dev（线上旧版）跑过作为基线（2026-10-21）**：

```text
[结论] 标签 6 个｜重叠 1 对｜console error 0 个｜截图 /tmp/twinwork/before-a.png
重叠对：x=710,y=482 ("演示-设备-未分组 --") × x=715,y=522 ("演示-设备-可用率 100%（无断档） 21.5 °C")
```

即「挤成一团」在真实数据上是**可复现**的（6 个里 1 对重叠，视觉上完全压住）。
部署后跑同一脚本，预期**重叠 0 对**。

## 10. 给 Lead 的合并/集成注意清单

1. **必做**：`twin-canvas.vue` 里补 `manager.setFlyHandler(...)`（见 §4），否则 `flyToAnchor` 是空操作。
2. **建议**：把 `onHoverAnchor` 接到 `manager.setInteractionHover`；它同时承担「hover 标签不避让」与「暂停脉冲」。
3. `getMotionMode()` 可能是 `'off'`（弱机型）；状态栏展示请处理第三态。
4. `motion-profile.ts` 我按你的契约**原样实现**；两份合并后若 diff 不为空，请以你合并后的版本为准并告诉我，我再对齐测试。
5. 引擎层新增文件 6 个，全部在 `three/twin/` 下，`layering-guard` 扫描目录自动覆盖（`sources.length >= 8` 断言不会误伤）。
6. **性能提示**：Bloom 在集成显卡上是主要帧时间来源；弱机型（`off` 档）整链关闭。
   若用户反馈低端机卡顿，最快的开关是 `renderer-options.ts` 的 `DEFAULT_POST_OPTIONS.enabled`。
7. 阴影 `shadowMapSize = 2048`：若目标环境是移动端/集显，降到 1024 是可见收益（画面几乎无差）。
8. `RoomEnvironment` 生成成本约 10~40ms，已放在 init（只一次），**不要在 enterScene 里调用**。

## 11. 未做 / 风险

| 项 | 说明 |
|---|---|
| 浏览器端「改造后」实测 | **未做**：dev 跑的是线上旧版，需 Lead 部署本分支后才能跑 §9 脚本。已提供脚本 + 基线数据。 |
| 地面镜面反射 | **刻意不做**：Reflector 要整场景二次渲染（帧率减半），收益远小于成本。改用阴影 + 网格 + 扫描线纹理表达地面。 |
| 标签遮挡剔除 | **刻意不做**：运维需要看到墙后设备。 |
| 标签 > 64 个点位 | 仍用 O(n²)（当前 6 个）。注释已写明需换空间网格；换法：已放置矩形按格子索引，查询只比邻居。 |
| `twin-animator` 的 clip 选择 | 关键字命中的 clip 优先；命中不足按原顺序补齐；上限 8。若模型带几十个 clip 会 `console.warn`（不静默）。**未做**「按设备节点路径交叉引用 clip」（clip 名与节点名无可靠对应关系，猜会错）。 |
| 弱机型阈值 | 沿用 `motion-profile` 的 4GB/4 核；`navigator.deviceMemory` 在 Safari/Firefox 不存在 ⇒ 只会退回 normal（不会误降级）。 |
| `getAnchorWorldPosition` 的时效性 | 缓存于「模型挂载 / 锚点刷新」时；锚点本身不会被 motion 改位置，因此不会过期。若将来给锚点加抖动动效需改成 per-frame 并按需失效。 |
