<script lang="ts" setup>
import type { PropertyCardModel } from './property-card-model';

import type { IotTwinApi } from '#/api/iot';
import type { AnchorRuntimeState, TwinSceneState } from '#/three/twin/types';

import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';

import { useAccessStore } from '@vben/stores';

import { Alert, Button } from 'ant-design-vue';

import { resolveModelUrl } from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

import { isAnchorVisible, placeCard } from './property-card-layout';
import { buildPropertyCard } from './property-card-model';
import TwinPropertyCard from './twin-property-card.vue';

/**
 * three.js 画布宿主（**唯一直接 import 引擎层的组件**）。
 *
 * ## 为什么引擎层必须在这里动态 import
 *
 * `three` 压缩后约 740KB，且只有进入孪生页才用得到。若在页面顶层 import，它会被打进主包
 * （首屏多下 740KB + 解析时间）。因此引擎层全部走 `await import()`，
 * 配合 vite 的高级分包，`three` 会独立成 chunk，只在进入本组件时才被请求。
 *
 * ## 职责边界
 *
 * 本组件**只做装配**：建 manager → 建锚点层 → 建 picker → 接 props → 转发事件
 * → 把「锚点屏幕坐标」交给属性卡片。 「什么时候加载哪个场景」由父组件决定，
 * 「怎么渲染」由引擎层决定，「卡片里显示什么」由 `property-card-model` 决定。
 *
 * ## 悬浮卡片的定位来源（关键设计）
 *
 * 卡片的锚点是 **3D 锚点的屏幕投影**，每帧都会变（相机一动就变）。若在 Vue 里每帧
 * `setState`，会让整个组件树每帧重渲染（CPU 打满、卡片文字跳）。
 * 因此：
 * - 引擎层提供 `projectToScreen`（纯计算，不需要渲染）；
 * - 本组件维护一个**只给卡片用的**位置 `ref`，并且**只在像素变化 ≥2px 时更新**
 *   （静止相机 = 零渲染）。
 */
const props = defineProps<{
  /** 从根到当前场景的祖先链（含自身，世界矩阵的合成依据）。 */
  ancestry: IotTwinApi.SceneResp[];
  /** 祖先链是否断裂（父场景已被删除）。 */
  ancestryBroken: boolean;
  /** 当前场景的点位。 */
  anchors: IotTwinApi.PointResp[];
  /** 模型资产列表（父组件从模型面板块共享而来）。 */
  assets: IotTwinApi.ModelAssetResp[];
  /** 编辑模式：`place` 时点击模型表面会发出 `place` 事件。 */
  editorMode: 'browse' | 'place';
  /**
   * 卡片取值器（**由父组件注入**，画布不自己拉数据）。
   *
   * 为什么用函数而不是传整个值表：值表是「节流后可能每 200ms 变一次」的大对象，
   * 传引用会让画布在整个树上重渲染；传取值函数则只在卡片可见时**按需读**。
   *
   * @param pointId 点位 ID
   * @returns 该点位的原始值（在线状态/告警数/属性值）
   */
  getLiveValues?: (pointId: string) =>
    | undefined
    | {
        alertCount: number;
        deviceId: string;
        onlineStatus?: null | string;
        status?: null | number;
        values: Record<string, IotTwinApi.RuntimeValueResp>;
      };
  /** 当前场景（undefined = 场景不存在）。 */
  scene?: IotTwinApi.SceneResp;
  /** 当前场景 ID。 */
  sceneId: string;
}>();

const emit = defineEmits<{
  /** 飞行模式被回退时的原因（**已本地化**；引擎层只给 key，这里用 $t 渲染）。 */
  fallback: [reason: string];
  /** 动效档位（引擎层判定后回调；页面状态栏展示，保证「说的和做的一致」）。 */
  motionMode: [mode: 'normal' | 'off' | 'reduced'];
  /** 卡片内「设备详情」按钮。 */
  openDevice: [pointId: string];
  /** 卡片内「点位配置」按钮。 */
  openPoint: [pointId: string];
  /** 钉住目标变化（父组件据此改写 URL `?pointId=` 与高亮右侧列表）。 */
  pinChange: [pointId?: string];
  /**
   * 配置态拾取到模型表面交点（父组件据此打开点位表单）。
   *
   * `local` 已是**本场景局部坐标**（落库口径）。
   */
  place: [
    payload: {
      local: { x: number; y: number; z: number };
      normal: { x: number; y: number; z: number };
    },
  ];
  /** 画布装配完成（父组件据此补推最新运行态）。 */
  ready: [];
  /** 渲染统计（供底部状态栏展示）。 */
  renderStats: [stats: { geometries: number; textures: number }];
  /** 点击已有锚点（父组件据此高亮该点位）。 */
  select: [pointId: string];
  /** 画布状态变化。 */
  stateChange: [state: TwinSceneState, error?: string];
}>();

const containerRef = ref<HTMLDivElement | null>(null);
const loadError = ref('');
const state = ref<TwinSceneState>('disposed');

/** 引擎层引用（动态 import 后赋值）。 */
let manager: import('#/three/twin/scene-manager').TwinSceneManager | undefined;

/**
 * 引擎层的**可选**扩展能力（相机投影 / 渲染统计）。
 *
 * 为什么用可选读取而不是直接调用：这些能力由渲染管线 track 提供，
 * 页面必须能在它们尚未就绪时正常工作（卡片不显示、状态栏少一项），
 * 而不是整个画布报错。用显式能力探测替代「靠 try/catch 兜」。
 */
interface EngineOptionalCapabilities {
  flyToAnchor?: (pointId: string, distanceScale?: number) => Promise<void>;
  getAnchorWorldPosition?: (
    pointId: string,
  ) => undefined | { x: number; y: number; z: number };
  /** 模型尺度（聚焦距离按模型大小换算，不能写死世界单位）。 */
  getModelMetrics?: () =>
    | undefined
    | {
        center: { x: number; y: number; z: number };
        maxDimension: number;
      };
  /** 动效档位（引擎层判定，页面只展示）。 */
  getMotionMode?: () => 'normal' | 'off' | 'reduced';
  getRenderStats?: () => { geometries: number; textures: number };
  projectToScreen?: (world: {
    x: number;
    y: number;
    z: number;
  }) => undefined | { visible: boolean; x: number; y: number };
  /** 注入「相机飞行」实现（引擎只算目标点，飞行由 CameraRig 执行）。 */
  setFlyHandler?: (
    handler: (
      pointId: string,
      distanceScale?: number,
    ) => Promise<void> | void,
  ) => void;
  /** 悬停交互提示（悬停中的锚点不参与避让、暂停脉冲）。 */
  setInteractionHover?: (pointId?: string) => void;
}

/** 把 manager 当作「带可选能力」的对象访问。 */
function engine(): EngineOptionalCapabilities | undefined {
  return manager as unknown as EngineOptionalCapabilities | undefined;
}
let anchorLayer:
  | import('#/three/twin/anchor-layer').AnchorLayerInstance
  | undefined;
let picker: import('#/three/twin/picker').TwinPicker | undefined;
let cameraRig: import('#/three/twin/camera-rig').CameraRig | undefined;

/** 资产索引（资产 id → 资产详情）：决定模型地址与飞行模式判断。 */
const assetById = computed(() => {
  const map = new Map<string, IotTwinApi.ModelAssetResp>();
  for (const asset of props.assets) {
    map.set(asset.id, asset);
  }
  return map;
});

/** 点位索引（卡片组装需要绑定信息）。 */
const pointById = computed(() => {
  const map = new Map<string, IotTwinApi.PointResp>();
  for (const point of props.anchors) {
    map.set(point.id, point);
  }
  return map;
});

/**
 * 模型地址（由资产决定；场景未绑模型时为 undefined）。
 *
 * **必须按资产类型分流**：`upload` 走平台下载端点（同源、带鉴权、走浏览器缓存），
 * `external` 用登记的外链原文（对 upload 端点调 content 会返回 409）。
 * `contentUrl` 已由后端按类型算好，这里优先用它。
 */
const modelUrl = computed(() => {
  const assetId = props.scene?.modelAssetId;
  if (!assetId) {
    return undefined;
  }
  const asset = assetById.value.get(assetId);
  if (asset?.contentUrl) {
    return resolveModelUrl(asset.contentUrl);
  }
  // assets 尚未加载：先按平台内端点回退，并留痕（外链模型此时会失败，属预期）
  console.warn(
    `[iot/twin] 未取到模型资产 ${assetId} 的详情，按平台内上传端点回退；` +
      '若该模型是外链登记，加载将失败（需先加载资产列表）',
  );
  return resolveModelUrl(`/iot/twin/model-assets/${assetId}/content`);
});

// ---------------- 卡片状态 ----------------

/** 当前悬停的点位（临时态）。 */
const hoveredPointId = ref<string>();
/** 当前钉住的点位（持久态，由父组件的 `?pointId=` 同步）。 */
const pinnedPointId = ref<string>();
/** 卡片锚点（锚点投影后的画布内像素坐标）。 */
const cardAnchor = ref<{ x: number; y: number }>();
/** 画布尺寸（卡片定位用）。 */
const canvasSize = ref({ height: 0, width: 0 });
/** 现在（驱动卡片里的相对时间刷新）。 */
const now = ref(Date.now());

/** 卡片当前展示哪个点位：钉住优先于悬停。 */
const activePointId = computed(() => pinnedPointId.value ?? hoveredPointId.value);

/** 卡片数据（依赖 `now`：相对时间随实时刷新）。 */
const cardModel = computed<PropertyCardModel | undefined>(() => {
  const pointId = activePointId.value;
  if (!pointId) {
    return undefined;
  }
  const point = pointById.value.get(pointId);
  if (!point) {
    return undefined;
  }
  void now.value;
  const live = props.getLiveValues?.(pointId);
  return buildPropertyCard({
    point,
    runtime: live,
    values: live?.values,
  });
});

/** 卡片放置结果。 */
const cardPlacement = computed(() => {
  const anchor = cardAnchor.value;
  if (!anchor) {
    return undefined;
  }
  return placeCard({
    anchor,
    canvas: canvasSize.value,
    card: { height: 280, width: 320 },
  });
});

/** 卡片可见性：有数据 + 锚点在画面内 + 不在放置模式。 */
const cardVisible = computed(() => {
  if (!cardModel.value || !cardPlacement.value || !cardAnchor.value) {
    return false;
  }
  if (props.editorMode === 'place') {
    return false;
  }
  return isAnchorVisible(cardAnchor.value, canvasSize.value);
});

/** 上一次更新的像素位置（用于 2px 阈值）。 */
let lastAnchorPx: undefined | { x: number; y: number };
/** 位置采样是否已排队。 */
let sampleQueued = false;

/**
 * 采样当前卡片锚点的屏幕位置（**不会每帧调用**：只在需要时排队一次 rAF）。
 */
function sampleCardPosition(): void {
  if (sampleQueued) {
    return;
  }
  sampleQueued = true;
  requestAnimationFrame(() => {
    sampleQueued = false;
    const pointId = activePointId.value;
    const container = containerRef.value;
    if (!pointId || !manager || !container) {
      return;
    }
    const caps = engine();
    const world = caps?.getAnchorWorldPosition?.(pointId);
    const screen = world ? caps?.projectToScreen?.(world) : undefined;
    if (!screen || !screen.visible) {
      // 锚点被移出画面：卡片隐藏（钉住态保留，转回来会重新出现）
      cardAnchor.value = undefined;
      return;
    }
    canvasSize.value = {
      height: container.clientHeight,
      width: container.clientWidth,
    };
    const next = { x: screen.x, y: screen.y };
    // 2px 阈值：相机微动（阻尼回弹）时不触发 Vue 更新
    if (
      lastAnchorPx &&
      Math.abs(lastAnchorPx.x - next.x) < 2 &&
      Math.abs(lastAnchorPx.y - next.y) < 2
    ) {
      return;
    }
    lastAnchorPx = next;
    cardAnchor.value = next;
  });
}

/**
 * 处理锚点悬停（进入/离开）。
 *
 * @param pointId 点位 ID（undefined = 离开）
 */
function onHoverAnchor(pointId?: string): void {
  if (pointId) {
    hoveredPointId.value = pointId;
    lastAnchorPx = undefined;
    sampleCardPosition();
  } else if (hoveredPointId.value !== undefined) {
    hoveredPointId.value = undefined;
  }
}

/**
 * 点击锚点 ⇒ 钉住（父组件同步 URL 并聚焦相机）。
 *
 * @param pointId 点位 ID
 */
function onPinAnchor(pointId: string): void {
  pinnedPointId.value = pointId;
  lastAnchorPx = undefined;
  sampleCardPosition();
  emit('pinChange', pointId);
  emit('select', pointId);
}

/** 关闭钉住（卡片右上角关闭 / 点击画布空白）。 */
function unpinCard(): void {
  if (pinnedPointId.value === undefined) {
    return;
  }
  pinnedPointId.value = undefined;
  emit('pinChange', undefined);
}

/**
 * 点击画布空白（非锚点）。
 *
 * 语义：有钉住则取消钉住；没有钉住则清掉悬停。
 */
function onCanvasBlankClick(): void {
  if (pinnedPointId.value !== undefined) {
    unpinCard();
    return;
  }
  hoveredPointId.value = undefined;
}

/** 一次性加载引擎并装配。 */
async function mountEngine(): Promise<void> {
  const container = containerRef.value;
  if (!container) {
    return;
  }
  try {
    const THREE = await import('three');
    const { TwinSceneManager } = await import('#/three/twin/scene-manager');
    const { createAnchorLayer } = await import('#/three/twin/anchor-layer');
    const { TwinPicker } = await import('#/three/twin/picker');
    const { CameraRig } = await import('#/three/twin/camera-rig');
    const CSS2D = await import('three/addons/renderers/CSS2DRenderer.js');

    // 令牌由**画布层**注入给引擎层：引擎层不直接依赖 @vben/stores，
    // 否则会形成静态依赖边把 three 提回首屏（工单 #125）。
    const accessStore = useAccessStore();
    manager = new TwinSceneManager({
      container,
      getAccessToken: () => accessStore.accessToken,
      // detail 来自 fetch/loader 的异常文本（第三方，英文为主）；整句用本语言的模板包住，
      // 保证「句子是当前语言」，而不是把中文模板与英文 detail 生硬拼接。
      errorMessages: {
        downloadFailed: (detail) =>
          $t('page.iot.twin.modelDownloadFailed', { detail }),
        parseFailed: (detail) => $t('page.iot.twin.modelParseFailed', { detail }),
      },
      onStateChange: (next, error) => {
        state.value = next;
        loadError.value = error?.message ?? '';
        emit('stateChange', next, error?.message);
      },
    });
    await manager.init();

    anchorLayer = createAnchorLayer(THREE, CSS2D, container, {
      onClickAnchor: (pointId) => {
        onPinAnchor(pointId);
      },
      onHoverAnchor: (pointId) => {
        // 同步给引擎：悬停中的标签不参与避让、暂停脉冲（否则卡片位置与标签来回跳）
        engine()?.setInteractionHover?.(pointId);
        onHoverAnchor(pointId);
      },
    });
    manager.attachAnchorLayer(anchorLayer);

    const camera = manager.getCamera();
    const controls = manager.getControls();
    if (!camera || !controls) {
      throw new Error('引擎初始化未产出相机或控制器');
    }
    cameraRig = new CameraRig(THREE, camera, controls);

    /*
     * 把「相机飞行」注入引擎层（引擎只算目标点，飞行由 CameraRig 执行）。
     *
     * 为什么不让引擎层自己插值相机：聚焦距离必须相对**模型尺度**换算
     * （`getModelMetrics().maxDimension × distanceScale`），而相机与控制器
     * 都由画布侧持有；引擎层只暴露目标点，避免两边各持一份相机状态。
     */
    engine()?.setFlyHandler?.((pointId, scale) => {
      const caps = engine();
      const world = caps?.getAnchorWorldPosition?.(pointId);
      if (!world || !cameraRig) {
        return undefined;
      }
      const metrics = caps?.getModelMetrics?.();
      return cameraRig.flyTo({
        distance: (metrics?.maxDimension ?? 100) * (scale ?? 0.55),
        target: world,
      });
    });

    // 动效档位：引擎层是唯一判据（用户偏好 + 机型能力），页面只负责展示
    const mode = engine()?.getMotionMode?.();
    if (mode) {
      emit('motionMode', mode);
    }

    picker = new TwinPicker({
      THREE,
      camera,
      controls,
      domElement: container,
      getModelRoot: () => manager?.getModelRoot(),
      onClick: (result) => {
        if (!result) {
          // 点空白：取消钉住的卡片（与「点锚点钉住」对称）
          onCanvasBlankClick();
          return;
        }
        if (props.editorMode !== 'place') {
          return;
        }
        // 只有命中模型表面才允许放置；命中已有锚点由锚点层自己处理
        if (result.kind !== 'surface') {
          return;
        }
        if (!manager) {
          return;
        }
        const local = manager.worldToLocal(result.point);
        // 法线也必须换算到本场景局部系（直传世界法线会让父场景有旋转时的朝向存错）
        const localNormal = manager.worldNormalToLocal(result.normal);
        emit('place', { local, normal: localNormal });
      },
      useBvh: props.editorMode === 'place',
    });
    // 通知父组件「画布已就绪」：此前 `onFlush` 用 `canvasRef.value?.` 静默丢弃，
    // 而画布就绪晚于运行态首帧 ⇒ 首屏的 6 个状态永久丢失，标签全空（实测）。
    emit('ready');
  } catch (error) {
    loadError.value = extractErrorMessage(
      error,
      $t('page.iot.twin.engineInitFailed'),
    );
  }
}

/** 加载当前场景到引擎。 */
async function loadScene(): Promise<void> {
  if (!manager || !props.scene || !modelUrl.value) {
    return;
  }
  const asset = props.scene.modelAssetId
    ? assetById.value.get(props.scene.modelAssetId)
    : undefined;
  const ancestryTransform = props.ancestry.map((item) => ({
    rx: Number(item.anchorRx ?? 0),
    ry: Number(item.anchorRy ?? 0),
    rz: Number(item.anchorRz ?? 0),
    scale: Number(item.anchorScale ?? 1),
    x: Number(item.anchorX ?? 0),
    y: Number(item.anchorY ?? 0),
    z: Number(item.anchorZ ?? 0),
  }));
  const own = ancestryTransform.at(-1) ?? {
    rx: 0,
    ry: 0,
    rz: 0,
    scale: 1,
    x: 0,
    y: 0,
    z: 0,
  };
  const url = modelUrl.value;
  try {
    const result = await manager.enterScene({
      anchor: own,
      ancestry: ancestryTransform,
      anchors: props.anchors.map((point) => ({
        deviceId: point.deviceId,
        deviceName: point.deviceIdName ?? point.deviceId,
        icon: point.icon ?? null,
        labelVisible: point.labelVisible,
        local: {
          x: Number(point.localX),
          y: Number(point.localY),
          z: Number(point.localZ),
        },
        normal: {
          x: Number(point.normalX),
          y: Number(point.normalY),
          z: Number(point.normalZ),
        },
        pointId: point.id,
        sort: point.sort ?? 0,
      })),
      basePath: url.slice(0, url.lastIndexOf('/') + 1),
      // ⚠️ 后端 `Long fileSize` 序列化为字符串 ⇒ 必须显式转数：
      //    直接透传会让 scene-manager 里 `bytes > FLY_MAX_MODEL_BYTES` 变成字符串比较
      //    （"5000000" > "20971520" 为 true），从而静默误判「模型过大」禁用飞行模式。
      modelBytes:
        asset?.fileSize === null || asset?.fileSize === undefined
          ? undefined
          : toBackendNumber(asset.fileSize),
      modelUrl: url,
      sceneId: props.sceneId,
      view: parseViewJson(props.scene.viewJson),
    });
    if (result.fallbackReason) {
      // 引擎层不本地化（拿不到 $t）⇒ 在这里用 key + params 渲染，避免英文界面中英混杂
      emit(
        'fallback',
        $t(result.fallbackReason.key, result.fallbackReason.params ?? {}),
      );
    }
    cameraRig?.captureHome();
    picker?.resetForNewModel();
    picker?.buildBvh();
    reportRenderStats();
    if (activePointId.value) {
      lastAnchorPx = undefined;
      sampleCardPosition();
    }
  } catch (error) {
    // ⚠️ 这条 catch 有两个不同来源，必须分开处理（工单 #132 修）：
    //
    // ① 真正的加载失败（下载/解析）：`enterScene` 内部已 setState('failed') 并带上
    //    errorMessages 生成的文案，画布模板会渲染错误态 + 重试按钮 ⇒ 此处不必重复提示。
    // ② 并发切换被拒：`enterScene` 在 `setState('loading')` **之前**就抛
    //    「场景正在切换中」⇒ **没有任何状态变化**。原实现的注释「已通过 onStateChange
    //    上报」在这里不成立，表现为「用户点了完全没反应」（实测确认）。
    //    改为：记录到 loadError，让画布显示可理解的提示。
    const message = error instanceof Error ? error.message : String(error);
    const isBusyRejection = message.includes('正在切换中');
    if (isBusyRejection) {
      loadError.value = message;
      return;
    }
    // ① 类：状态已由 onStateChange 置为 failed，但若文案为空则兜底一次，
    // 避免出现「失败态却没有原因」的空白错误框。
    if (!loadError.value) {
      loadError.value = message;
    }
  }
}

/** 上报渲染统计（底部状态栏的显存泄漏观测口，§5.4）。 */
function reportRenderStats(): void {
  const stats = engine()?.getRenderStats?.();
  if (stats) {
    emit('renderStats', stats);
  }
}

/**
 * 解析 `view_json`。
 *
 * 非法 JSON 不阻塞渲染：用默认视角并留痕（后端保存时已校验，这里是防御）。
 *
 * @param raw 原始 JSON 文本
 * @returns 视角配置或 null
 */
function parseViewJson(
  raw?: null | string,
): import('#/three/twin/types').TwinViewConfig | null {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as import('#/three/twin/types').TwinViewConfig;
  } catch (error) {
    console.warn(
      '[iot/twin] 场景视角配置不是合法 JSON，已使用默认视角：',
      error,
    );
    return null;
  }
}

/**
 * 把运行态状态推给锚点层（父组件通过组件引用调用）。
 *
 * @param states 点位 ID → 运行态
 */
function updateAnchorStates(states: Map<string, AnchorRuntimeState>): void {
  manager?.updateAnchorStates(states);
  // 卡片开着时同步刷新它的位置与数值
  if (activePointId.value) {
    sampleCardPosition();
  }
}

/**
 * 由父组件同步钉住态（URL `?pointId=` 是唯一真相）。
 *
 * 不回调 `pinChange`（避免 URL 写入形成环）。
 *
 * @param pointId 点位 ID
 */
function syncPinnedPoint(pointId?: string): void {
  pinnedPointId.value = pointId;
  lastAnchorPx = undefined;
  sampleCardPosition();
}

/** 重试加载（错误态下的按钮）。 */
async function retry(): Promise<void> {
  loadError.value = '';
  await loadScene();
}

onMounted(async () => {
  await mountEngine();
  await loadScene();
});

/** 场景切换（sceneId 变化说明场景变了）。 */
watch(
  () => props.sceneId,
  async () => {
    await loadScene();
    reportRenderStats();
  },
);

/**
 * 资产列表到达后重新评估（#130）。
 *
 * 为什么需要：`loadScene` 在挂载时就跑了，而 `assets` 由「模型资产」面板异步加载，
 * 此时可能还是空数组 ⇒ `modelBytes` 恒 `undefined` ⇒ 「模型过大禁用飞行」这条保护
 * **永远不生效**（只剩 deviceMemory 那条）。
 * 资产到达后重跑一次 `loadScene`：引擎内部会正确 dispose 旧模型，不会泄漏。
 */
watch(
  () => props.assets,
  async (assets, previous) => {
    // 只在「从无到有」时重跑：避免每次资产刷新都重建模型
    if (assets.length > 0 && (previous?.length ?? 0) === 0) {
      await loadScene();
    }
  },
);

/**
 * 点位变化（增删改）时**只重建锚点层**，不重载模型。
 *
 * ⚠️ 这里曾是线上缺陷：原先直接 `await loadScene()` ⇒ 每次都重新下载并解析整个 GLB、
 * 重建整条祖先链与全部锚点。而 `props.anchors` 是父组件的 `points` 数组，
 * 运行态刷新会让它被重新赋值 ⇒ **锚点被高频重建**，
 * 新元素文本为空、旧元素（带着文本）刚被移除 ⇒ 画布上**永远看不到标签**。
 * 实测证据：`textContent` 被正确写入 108 次，但每次读到的 6 个元素都是空元素。
 *
 * 模型没变就没必要重载：锚点只是挂在模型上的子节点。
 */
watch(
  () => props.anchors,
  () => {
    if (!manager || !props.scene) {
      return;
    }
    manager.refreshAnchors(
      props.anchors.map((point) => ({
        deviceId: point.deviceId,
        deviceName: point.deviceIdName ?? point.deviceId,
        icon: point.icon ?? null,
        labelVisible: point.labelVisible,
        local: {
          x: Number(point.localX),
          y: Number(point.localY),
          z: Number(point.localZ),
        },
        normal: {
          x: Number(point.normalX),
          y: Number(point.normalY),
          z: Number(point.normalZ),
        },
        pointId: point.id,
        sort: point.sort ?? 0,
      })),
    );
  },
  { deep: false },
);

/** 卡片相对时间刷新（每 5s 一次：人眼不需要更细，省 CPU）。 */
const ageTimer = setInterval(() => {
  if (activePointId.value) {
    now.value = Date.now();
  }
}, 5000);

/** 画布尺寸变化时同步卡片定位基准。 */
let resizeObserver: ResizeObserver | undefined;

onMounted(() => {
  const container = containerRef.value;
  if (!container) {
    return;
  }
  canvasSize.value = {
    height: container.clientHeight,
    width: container.clientWidth,
  };
  resizeObserver = new ResizeObserver(() => {
    canvasSize.value = {
      height: container.clientHeight,
      width: container.clientWidth,
    };
    if (activePointId.value) {
      lastAnchorPx = undefined;
      sampleCardPosition();
    }
  });
  resizeObserver.observe(container);
});

onBeforeUnmount(() => {
  clearInterval(ageTimer);
  resizeObserver?.disconnect();
  resizeObserver = undefined;
  picker?.dispose();
  picker = undefined;
  anchorLayer?.dispose();
  anchorLayer = undefined;
  cameraRig?.cancelFly();
  cameraRig = undefined;
  manager?.dispose();
  manager = undefined;
});

/**
 * 页面 → 3D 的方向：点右侧列表某行 ⇒ 钉住该锚点并聚焦相机。
 *
 * 与「点锚点 ⇒ 高亮列表」配对，保证双向一致（用户不会怀疑自己点错了地方）。
 *
 * @param pointId 点位 ID
 */
async function focusPoint(pointId: string): Promise<void> {
  pinnedPointId.value = pointId;
  lastAnchorPx = undefined;
  await nextTick();
  sampleCardPosition();
  await engine()?.flyToAnchor?.(pointId);
}

defineExpose({
  focusPoint,
  retry,
  syncPinnedPoint,
  updateAnchorStates,
});
</script>

<template>
  <div class="relative h-full w-full">
    <div ref="containerRef" class="h-full w-full"></div>

    <!-- 悬浮/点击属性卡片（浮层，跟随 3D 锚点） -->
    <TwinPropertyCard
      v-if="cardVisible && cardModel && cardPlacement"
      :card="cardModel"
      :now="now"
      :pinned="pinnedPointId !== undefined"
      :placement="cardPlacement"
      @close="unpinCard"
      @open-device="emit('openDevice', activePointId!)"
      @open-point="emit('openPoint', activePointId!)"
      @pointer-enter="hoveredPointId = activePointId"
      @pointer-leave="() => {}"
    />

    <!-- 加载中：骨架式遮罩（比纯转圈更能说明「正在建模型」） -->
    <div
      v-if="state === 'loading'"
      class="pointer-events-none absolute inset-0 flex items-center justify-center bg-background/60"
    >
      <div class="flex flex-col items-center gap-2">
        <div
          class="size-8 animate-spin rounded-full border-2 border-border border-t-primary motion-reduce:animate-none"
        ></div>
        <span class="text-sm text-muted-foreground">
          {{ $t('page.iot.twin.loadingModel') }}
        </span>
      </div>
    </div>

    <!-- 失败 -->
    <div
      v-if="state === 'failed' && loadError"
      class="absolute inset-0 flex items-center justify-center bg-background/85 p-6"
    >
      <Alert :message="loadError" type="error">
        <template #action>
          <Button size="small" type="primary" @click="retry">
            {{ $t('page.iot.twin.retry') }}
          </Button>
        </template>
      </Alert>
    </div>

    <!-- 场景不存在 -->
    <div
      v-if="!scene"
      class="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground"
    >
      {{ $t('page.iot.twin.sceneNotFound') }}
    </div>
  </div>
</template>
