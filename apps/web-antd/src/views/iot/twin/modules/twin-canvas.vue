<script lang="ts" setup>
import type { IotTwinApi } from '#/api/iot';
import type { AnchorRuntimeState, TwinSceneState } from '#/three/twin/types';

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { useAccessStore } from '@vben/stores';

import { Alert, Button } from 'ant-design-vue';

import { resolveModelUrl } from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

/**
 * three.js 画布宿主（**唯一直接 import 引擎层的组件**）。
 *
 * ## 为什么引擎层必须在这里动态 import
 *
 * `three` 压缩后约 150KB，且只有进入孪生页才用得到。若在页面顶层 import，它会被打进主包
 * （首屏多下 150KB + 解析时间）。因此引擎层全部走 `await import()`，
 * 配合 vite 的高级分包，`three` 会独立成 chunk，只在进入本组件时才被请求。
 *
 * ## 职责边界
 *
 * 本组件**只做装配**：建 manager → 建锚点层 → 建 picker → 接 props → 转发事件。
 * 「什么时候加载哪个场景」由父组件决定，「怎么渲染」由引擎层决定。
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
  /** 当前场景（undefined = 场景不存在）。 */
  scene?: IotTwinApi.SceneResp;
  /** 当前场景 ID。 */
  sceneId: string;
}>();

const emit = defineEmits<{
  /** 飞行模式被回退时的原因（**已本地化**；引擎层只给 key，这里用 $t 渲染）。 */
  fallback: [reason: string];
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
        emit('select', pointId);
      },
    });
    manager.attachAnchorLayer(anchorLayer);

    const camera = manager.getCamera();
    const controls = manager.getControls();
    if (!camera || !controls) {
      throw new Error('引擎初始化未产出相机或控制器');
    }
    cameraRig = new CameraRig(THREE, camera, controls);
    picker = new TwinPicker({
      THREE,
      camera,
      controls,
      domElement: container,
      getModelRoot: () => manager?.getModelRoot(),
      onClick: (result) => {
        if (props.editorMode !== 'place' || !result) {
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
  },
);

/** 锚点变化（点位增删改）时重建场景（引擎内部会 dispose 旧模型，保证显存干净）。 */
watch(
  () => props.anchors,
  async () => {
    await loadScene();
  },
  { deep: false },
);

onBeforeUnmount(() => {
  picker?.dispose();
  picker = undefined;
  anchorLayer?.dispose();
  anchorLayer = undefined;
  cameraRig?.cancelFly();
  cameraRig = undefined;
  manager?.dispose();
  manager = undefined;
});

defineExpose({ retry, updateAnchorStates });
</script>

<template>
  <div class="relative h-full w-full">
    <div ref="containerRef" class="h-full w-full"></div>

    <!-- 加载中 -->
    <div
      v-if="state === 'loading'"
      class="absolute inset-0 flex items-center justify-center bg-background/70 text-sm text-muted-foreground"
    >
      {{ $t('page.iot.twin.loadingModel') }}
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
