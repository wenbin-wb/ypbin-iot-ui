import type * as THREE_NS from 'three';

import type { TwinAutoOrbit } from './camera-orbit';
import type { DeviceFocus } from './device-focus';
import type { TwinEnvironment } from './environment';
import type { LoadedModel, LoadModelOptions } from './model-loader';
import type { TwinMotionMode } from './motion-profile';
import type { TwinPostOptions, TwinRendererOptions } from './renderer-options';
import type { ShellNodes } from './shell-visibility';
import type { TwinAnimator } from './twin-animator';
import type {
  AnchorDescriptor,
  AnchorRuntimeState,
  AnchorTransform,
  TwinSceneError,
  TwinSceneState,
  TwinViewConfig,
} from './types';

import { applyAnchorToObject, buildAncestryPivots } from './ancestry';
import { createAutoOrbit } from './camera-orbit';
import {
  TWIN_COLOR_BACKGROUND_BOTTOM,
  TWIN_COLOR_BACKGROUND_BOTTOM_LIGHT,
  TWIN_COLOR_BACKGROUND_TOP,
  TWIN_COLOR_BACKGROUND_TOP_LIGHT,
  TWIN_COLOR_FILL,
  TWIN_COLOR_HEMI_GROUND,
  TWIN_COLOR_HEMI_SKY,
  TWIN_COLOR_SCAN_RING,
  TWIN_COLOR_SUN,
} from './colors';
import {
  createDeviceFocus,
  findNodesByPointName,
  pickHighlightNodes,
} from './device-focus';
import { disposeSubtree } from './disposal';
import {
  buildEnvironment,
  buildEnvironmentTexture,
  disposeEnvironment,
} from './environment';
import { attachKtx2, loadModel } from './model-loader';
import {
  motionSwitches,
  readMotionProfileInput,
  reducedMotionMediaQuery,
  resolveMotionMode,
} from './motion-profile';
import {
  applyRendererOptions,
  resolvePostOptions,
  resolveRendererOptions,
  resolveShadowCamera,
} from './renderer-options';
import { applyShellVisibility, collectShellNodes } from './shell-visibility';
import { createTwinAnimator } from './twin-animator';

/**
 * 场景生命周期管理（**「方便切换场景」这一需求的核心实现**）。
 *
 * ## 三个职责
 *
 * 1. **世界坐标链**：沿父场景链递归合成 `worldMatrix`，把「本场景局部坐标」映射到
 *    「顶层世界坐标」。子场景通过 `anchor_*` 变换嵌进父场景 —— 这是「整栋楼平移一次，
 *    楼上所有点位自动跟着走」的唯一正确姿势。
 * 2. **切换状态机**：`disposed → loading → ready → disposing → disposed`，失败进 `failed`。
 *    每次迁移都通过 `onStateChange` 暴露，页面据此渲染进度/错误/禁用操作。
 * 3. **两种切换模式**：`switch`（默认，单场景驻留）与 `fly`（可选，父子同驻留）。
 *    不满足飞行条件时**显式回退并给出原因**（不静默）。
 *
 * ## 为什么渲染器/相机/控制器只建一次
 *
 * WebGL 上下文重建代价高（需重新上传全部材质与着色器），且浏览器在活跃 WebGL 上下文
 * 超过约 16 个后会开始丢弃最旧的（`webglcontextlost`）。因此「切场景」只换场景内的
 * 模型节点，**不重建 renderer**。
 */

/** 场景切换模式。 */
export type TwinSwitchMode = 'fly' | 'switch';

/** 飞行模式允许的最大模型字节数（超过则禁用飞行：双场景驻留会耗尽显存）。 */
export const FLY_MAX_MODEL_BYTES = 20 * 1024 * 1024;

/** 设备内存阈值（GB）：`navigator.deviceMemory <= 4` 时禁用飞行模式。 */
export const FLY_MIN_DEVICE_MEMORY_GB = 4;

/** 内存自检：切换多次后 `geometries` 超过基线的该增量即告警（开发期观测）。 */
export const MEMORY_LEAK_GEOMETRY_THRESHOLD = 20;

/** 画布背景色（深色：设备状态色在深底上对比度更好）。 */
const SCENE_BACKGROUND = TWIN_COLOR_BACKGROUND_BOTTOM;

/**
 * 背景渐变画布尺寸。
 *
 * 背景用 canvas 生成渐变纹理而不是纯色：纯色底（改造前的 `#0b1220`）在暗色屏幕上
 * 像「黑洞」，模型的边缘与地面没有分离感；顶部略亮的渐变能造出「天光从上方来」的
 * 空间感（参考图的核心氛围来源）。
 *
 * 512×512 足够（渐变没有细节，拉伸到全屏看不出差别），且显存占用可忽略。
 */
const BACKGROUND_TEXTURE_SIZE = 512;

/** 背景纹理顶部/底部分界（0~1：渐变从顶部亮过渡到底部暗）。 */
const BACKGROUND_GRADIENT_SPLIT = 0.55;

/** 相机默认俯视角（弧度；约 35°，对齐参考图的「略俯视」机位）。 */
const DEFAULT_CAMERA_ELEVATION_RAD = (35 * Math.PI) / 180;

/** 相机默认方位角（弧度；45°：从西南方向看，能看到两个立面）。 */
const DEFAULT_CAMERA_AZIMUTH_RAD = (Math.PI * 4) / 3;

/** 默认机位距离系数（相对模型最大尺寸；1.9 倍让模型占画面约 2/3）。 */
const DEFAULT_CAMERA_DISTANCE_RATIO = 1.9;

/**
 * `projectToScreen` 的越界容差（像素）。
 *
 * 锚点贴在画布边缘时（标签会被夹紧到 4px 留边），浮点误差 + 画布/容器尺寸的 1~2px 差
 * 会把它判成「越界」⇒ 调用方隐藏卡片 ⇒ 表现为「卡片闪一下就没了」。
 * 这里给容差，把「离边缘多少算越界」的决策留给调用方。
 */
const PROJECT_CLIP_TOLERANCE_PX = 24;

/** 环境贴图对场景的强度（RoomEnvironment 偏亮，直接给强会让金属发白）。 */
const ENVIRONMENT_INTENSITY = 0.62;

/** 主方向光强度（按模型尺寸自适应时的默认值）。 */
const DEFAULT_SUN_INTENSITY = 2.6;

/** 半球光强度。 */
const DEFAULT_HEMI_INTENSITY = 1.15;

/** 补光强度（很弱，只勾轮廓）。 */
const DEFAULT_FILL_INTENSITY = 0.35;

/** 主方向光相对模型尺寸的距离倍数。 */
const SUN_DISTANCE_RATIO = 2.2;

/**
 * 生成背景渐变纹理（顶部略亮 → 底部更暗的深冷灰蓝）。
 *
 * 为什么不用 CSS 背景：画布是 WebGL 渲染的，`scene.background` 必须是纹理/颜色；
 * 用 canvas 生成渐变纹理是零依赖、零网络请求的做法。纹理也必须标
 * `SRGBColorSpace`（颜色贴图），否则会被当成线性值 ⇒ 颜色偏亮发白。
 *
 * @param THREE three 命名空间
 * @returns 背景纹理
 */
function createBackgroundTexture(
  THREE: typeof THREE_NS,
  light = false,
): THREE_NS.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = BACKGROUND_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createLinearGradient(
      0,
      0,
      0,
      BACKGROUND_TEXTURE_SIZE,
    );
    const top = light
      ? TWIN_COLOR_BACKGROUND_TOP_LIGHT
      : TWIN_COLOR_BACKGROUND_TOP;
    const bottom = light
      ? TWIN_COLOR_BACKGROUND_BOTTOM_LIGHT
      : TWIN_COLOR_BACKGROUND_BOTTOM;
    gradient.addColorStop(0, top);
    gradient.addColorStop(BACKGROUND_GRADIENT_SPLIT, top);
    gradient.addColorStop(1, bottom);
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** 环境光缓慢缓变的周期（毫秒）与幅度。 */
const AMBIENT_DRIFT_PERIOD_MS = 60_000;
const AMBIENT_DRIFT_AMPLITUDE = 0.06;

/** 锚点层契约（由 `anchor-layer.ts` 实现，画布组件装配）。 */
export interface AnchorLayer {
  /** 把锚点挂到模型上（每次进入场景调用一次）。 */
  attach: (modelRoot: THREE_NS.Object3D, anchors: AnchorDescriptor[]) => void;
  /** 卸载全部锚点（切场景/销毁时调用）。 */
  detach: () => void;
  /**
   * 在渲染循环里绘制锚点层（CSS2D 渲染器需要每帧绘制一次）。
   *
   * 为什么由 manager 调用而不是锚点层自己开循环：一个画布只应有一个 rAF 循环。
   * 两个循环（3D + CSS2D）会在不同帧提交，标签与模型之间出现一帧的错位抖动。
   */
  render: (scene: THREE_NS.Scene, camera: THREE_NS.Camera) => void;
  /** 画布尺寸变化时同步 CSS2D 渲染器（否则标签位置在缩放后偏移）。 */
  resize: (width: number, height: number) => void;
  /** 批量更新运行态（rAF 合并后调用）。 */
  update: (states: Map<string, AnchorRuntimeState>) => void;
  /**
   * 可选：下发动效档位（锚点层据此开关呼吸/扩散环/数值闪烁）。
   *
   * 设为可选是为了向后兼容：单测与旧装配代码传入的对象没有这个方法时，
   * 管理器不应崩溃（`?.` 调用）。
   */
  setMotionMode?: (mode: TwinMotionMode) => void;
  /** 可选：设置 hover 点位（hover 的标签不参与避让，避免鼠标放上去它被挤走）。 */
  setHovered?: (pointId?: string) => void;
  /** 可选：设置选中点位（选中时持久显示圆点与数值标签）。 */
  setSelected?: (pointId?: string) => void;
}

/** 场景管理器构造选项。 */
export interface SceneManagerOptions {
  /** 挂载容器的 DOM 元素。 */
  container: HTMLElement;
  /** 错误文案工厂（引擎层不做 i18n，由页面注入本地化文案）。 */
  errorMessages: {
    downloadFailed: (detail: string) => string;
    parseFailed: (detail: string) => string;
  };
  /** 状态变化回调。 */
  onStateChange: (state: TwinSceneState, error?: TwinSceneError) => void;
  /**
   * 取访问令牌（由画布组件注入，引擎层不直接依赖状态库）。
   *
   * 目的：让引擎层保持「零首屏依赖」，three 才能被真正按需加载（工单 #125）。
   */
  getAccessToken?: () => null | string | undefined;
  /**
   * 渲染器工厂（**仅供测试注入替身**；生产不传 ⇒ 内部 `new WebGLRenderer`）。
   *
   * 为什么留这个口子：`init()` 里「渲染器配置是否真的被设置」（输出色彩空间 /
   * 色调映射 / 阴影）是一次「测试全绿但功能无效」的高发区——纯函数单测只能证明
   * 「配置算对了」，不能证明「配置写进了 renderer」。用替身 renderer 跑真实的
   * `init()` 才能钉住后者（见 `scene-manager-pipeline.test.ts`）。
   */
  rendererFactory?: (THREE: typeof THREE_NS) => THREE_NS.WebGLRenderer;
}

/** 一个场景的加载描述（由页面从场景响应 + 资产响应转换而来）。 */
export interface SceneLoadRequest {
  /** 场景 ID。 */
  sceneId: string;
  /** 模型绝对地址（已由 `resolveModelUrl` 拼好）。 */
  modelUrl: string;
  /** glTF 内部相对资源的基准路径（分离资源模型必传）。 */
  basePath: string;
  /** 该场景自身的锚点变换。 */
  anchor: AnchorTransform;
  /** 从根到本场景的完整祖先链（**含自身**，按根→叶顺序）。 */
  ancestry: AnchorTransform[];
  /** 默认视角配置（可空 ⇒ 用引擎默认）。 */
  view?: null | TwinViewConfig;
  /** 场景内设备锚点。 */
  anchors: AnchorDescriptor[];
  /** 模型文件字节数（用于判断飞行模式是否允许）。 */
  modelBytes?: null | number;
}

/**
 * 飞行模式回退原因（**结构化，不在引擎层本地化**）。
 *
 * <p>引擎层不做 i18n：它拿不到 `$t`，返回中文字符串会导致英文界面出现中英混杂
 * （工单 #131 的实测问题）。这里只返回「用哪个 key、带什么参数」，
 * 由画布层用 `$t(key, params)` 渲染。</p>
 */
export interface TwistFallbackReason {
  /** i18n key（`page.iot.twin.*`）。 */
  key: string;
  /** 插值参数（`$t` 的第二个参数）。 */
  params?: Record<string, number | string>;
}

/** `enterScene` 的返回值：实际使用的模式与（可选的）回退原因。 */
export interface EnterSceneResult {
  /** 因不满足条件而未启用飞行模式时的原因（页面要展示，不能静默）。 */
  fallbackReason?: TwistFallbackReason;
  /** 实际使用的切换模式。 */
  mode: TwinSwitchMode;
}

/** 模型**解析**阶段的错误（与下载失败区分，给用户不同文案）。 */
export class ModelParseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'ModelParseError';
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * 场景管理器（每个画布一个实例）。
 *
 * 生命周期：`new TwinSceneManager(opts)` → `await init()` → 反复 `enterScene(...)` →
 * `dispose()`。
 */
export class TwinSceneManager {
  /**
   * 当前场景的祖先链 pivot（嵌套 Group）。
   *
   * 存下来是为了 dispose 时整条移除：只摘模型根会把 pivot 留在场景图里，
   * 下次进入场景又会叠一层，反复切换后场景图无限增长（形状上也表现为模型越走越远）。
   */
  private ancestryPivots: THREE_NS.Object3D[] = [];

  /** 最近一次收到的点位描述（ID → 描述），供节点匹配与兜底拾取用。 */
  private anchorDescriptors = new Map<string, AnchorDescriptor>();

  private anchorLayer?: AnchorLayer;

  /**
   * 锚点世界坐标缓存（供 {@link getAnchorWorldPosition}）。
   *
   * 为什么缓存而不是每次遍历场景：hover 卡片在鼠标移动时高频取坐标，
   * 一次 `getWorldPosition` 需要沿父链更新矩阵。缓存只在「模型挂载/锚点刷新」时重算，
   * 成本被摊到低频路径上。
   */
  private anchorPositionCache = new Map<
    string,
    { x: number; y: number; z: number }
  >();

  /** 当前模型自带的动画数（HUD 展示「有动画但未播放」时要用原始数量）。 */
  private animationCount = 0;

  private animationFrameId = 0;

  /**
   * 模型动画管理器（GLB 自带动画）。
   *
   * 切场景必须 `dispose()`（内部 `stopAllAction` + `uncacheRoot`），否则 mixer 仍持有
   * 已释放的节点/骨骼 ⇒ 内存与显存双泄漏。
   */
  private animator?: TwinAnimator;

  /** 上一次切换建立的内存基线（geometries 数量）。 */
  private baselineGeometries = 0;

  private camera?: THREE_NS.PerspectiveCamera;

  private container: HTMLElement;

  private controls?: import('three/addons/controls/OrbitControls.js').OrbitControls;

  /** 当前已挂载的场景 ID（用于区分「同场景重建」与「真的换场景」）。 */
  private currentSceneId?: string;

  /** 当前场景的世界变换矩阵（局部坐标 → 世界坐标）。 */
  private currentWorldMatrix?: THREE_NS.Matrix4;

  /** 默认机位（`applyView` 里记下来，供投影/聚焦兜底）。 */
  private defaultTarget?: { x: number; y: number; z: number };

  /** 设备聚焦控制器（选中/悬停高亮）。 */
  private deviceFocus?: DeviceFocus;

  private disposed = false;

  /**
   * 相机巡航的时间基准（秒）：用于环境光缓变的相位。
   *
   * 不直接用 `performance.now()`：切场景时重置相位，避免「新场景一进来就是缓变中段」。
   */
  private driftSeconds = 0;

  /** 拖放落点预览对象（未拖拽时为 undefined）。 */
  private dropPreview?: THREE_NS.Object3D;

  /**
   * 当前**实际生效**的画布背景色（CSS 颜色串）。
   *
   * 初始为主题默认渐变（深色）；`applyView` 若读到 `viewJson.background` 则更新为它。
   * 环境（地面/网格）在它之后重建，因此换算出的浅色标记才是对的。
   */
  private effectiveBackground: string = TWIN_COLOR_BACKGROUND_TOP;

  /** 场景环境（地面/网格/扫描光圈）。切场景重建（地面尺寸依赖模型包围盒）。 */
  private environment?: Omit<TwinEnvironment, 'environmentTexture'>;

  /** 环境贴图（**只在 init 建一次**，切场景不重建）。 */
  private environmentTexture?: THREE_NS.Texture;

  private errorMessages: SceneManagerOptions['errorMessages'];

  private fadeOverlay?: HTMLDivElement;

  private fillLight?: THREE_NS.DirectionalLight;

  /**
   * 相机聚焦飞行的实现（由 `twin-canvas` 注入 `CameraRig`）。
   *
   * 为什么注入而不是在引擎层 new：`twin-canvas` 已经建了 `CameraRig`（它还要管
   * `captureHome` 与 `picker`）。两处各建一个会互相覆盖 home 位姿，且 rAF 循环重复。
   */
  private flyHandler?: (
    pointId: string,
    distanceScale: number,
  ) => Promise<void>;

  /** 取访问令牌（注入，见 SceneManagerOptions#getAccessToken）。 */
  private getAccessToken?: () => null | string | undefined;

  /** 场景是否显式配置了背景色（`viewJson.background`）⇒ 不随主题覆盖。 */
  private hasExplicitBackground = false;

  /** 半球光/方向光的基准强度（缓变围绕它上下浮动，`applyView` 改的就是它）。 */
  private hemiBaseIntensity = DEFAULT_HEMI_INTENSITY;

  private hemiLight?: THREE_NS.HemisphereLight;

  private hoveredPointId?: string;

  private initialized = false;
  /**
   * 最近一次收到的锚点描述（模型就绪前到达的**暂存**在此）。
   *
   * 为什么必须有：`refreshAnchors` 在 `modelRoot` 尚未就绪时无法挂载锚点，
   * 若直接丢弃，而此后 `props.anchors` 又不再变化（静态场景的常态），
   * 锚点就**永远不会被创建** ⇒ 画布上只有模型、没有任何设备点与标签。
   * 实测表现：同一页面刷新多次，有时 6 个标签正常、有时全空（时序竞态）。
   */
  private lastAnchors?: AnchorDescriptor[];

  /**
   * 最近一次收到的运行态（锚点层就绪前到达的数据**暂存**在此）。
   *
   * 为什么必须有：`onFlush` 在 `runtime.loadSnapshot()` 完成时触发，而画布此时
   * 可能仍在 `await manager.init()` 里（`anchorLayer` 还没 attach）⇒
   * `this.anchorLayer?.update()` 静默丢弃 ⇒ **锚点标签永远是空文本**。
   * 实测现象：`onFlush` 已收到 6 个状态，而 6 个 `.twin-anchor-label` 的
   * textContent 全为空、childNodes 为 0。
   */
  private lastAnchorStates?: Map<string, AnchorRuntimeState>;

  /**
   * 是否「亮色主题」（由页面按主题设置注入）。
   *
   * 只在**场景没有配置 `viewJson.background`** 时生效：用户显式配置的背景优先
   * （配置了就必须尊重，不能因为切主题把用户的配色覆盖掉）。
   */
  private lightCanvas = false;

  /** 当前模型的字节数（来自 `SceneLoadRequest.modelBytes`，未知为 0）。 */
  private modelBytes = 0;

  private modelRoot?: THREE_NS.Group;

  /** 上一次 `matchMedia` change 监听的清理函数（dispose 必须调用）。 */
  private motionMediaCleanup?: () => void;

  /** 当前动效档位（页面状态栏读取）。 */
  private motionMode: TwinMotionMode = 'normal';

  private onStateChange: SceneManagerOptions['onStateChange'];

  private orbit?: TwinAutoOrbit;

  private postComposer?: {
    dispose: () => void;
    render: (deltaSeconds?: number) => void;
    setPixelRatio: (ratio: number) => void;
    setSize: (width: number, height: number) => void;
  };

  private postOptions: TwinPostOptions = resolvePostOptions();

  /** 复用 raycaster（`screenToLocal` 用；每次点击都要用，重复 new 会产生垃圾）。 */
  private raycaster?: THREE_NS.Raycaster;

  private renderer?: THREE_NS.WebGLRenderer;

  private rendererFactory?: SceneManagerOptions['rendererFactory'];

  private rendererOptions?: TwinRendererOptions;

  private resizeObserver?: ResizeObserver;

  private scene?: THREE_NS.Scene;

  /** 当前选中 / 悬停点位（UI 状态，纯内存）。 */
  private selectedPointId?: string;

  /**
   * 当前模型的「外壳」节点（roof/wall/truss）。
   *
   * 切场景时必须重新收集（否则缓存指向已 dispose 的旧模型 ⇒ 悬空引用），
   * dispose 时清空。
   */
  private shellNodes?: ShellNodes;

  /**
   * 「剖切 / 完整」状态（true = 完整显示外壳）。
   *
   * **默认剖切**：演示场景的锚点在机柜内部，封闭厂房会把它们全部挡住。
   * 切场景后按该状态重新应用（否则切回来屋顶又冒出来）。
   */
  private shellVisible = false;

  private state: TwinSceneState = 'disposed';

  private sunBaseIntensity = DEFAULT_SUN_INTENSITY;

  private sunLight?: THREE_NS.DirectionalLight;

  private switchCount = 0;

  /** three 命名空间（`init` 时通过动态 import 取得，避免顶层 import 破坏分包）。 */
  private THREE?: typeof THREE_NS;

  constructor(options: SceneManagerOptions) {
    this.container = options.container;
    this.onStateChange = options.onStateChange;
    this.errorMessages = options.errorMessages;
    this.getAccessToken = options.getAccessToken;
    this.rendererFactory = options.rendererFactory;
  }

  /**
   * 注册锚点层（画布装配时调用一次）。
   *
   * @param layer 锚点层实现
   */
  attachAnchorLayer(layer: AnchorLayer): void {
    this.anchorLayer = layer;
    // 重放锚点层就绪前收到的状态：否则那些数据被永久丢弃，标签一直空白
    if (this.lastAnchorStates && this.lastAnchorStates.size > 0) {
      layer.update(this.lastAnchorStates);
    }
  }

  /**
   * 销毁管理器（页面卸载时调用）：停止渲染循环、释放全部 GPU 资源、解绑事件。
   *
   * 幂等：重复调用直接返回。
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = 0;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    // 动效档位监听：addEventListener 持有回调，不移除就是引用泄漏
    this.motionMediaCleanup?.();
    this.motionMediaCleanup = undefined;
    this.orbit?.dispose();
    this.orbit = undefined;
    this.anchorLayer?.detach();
    this.anchorLayer = undefined;
    this.clearCurrentModelSync();
    this.fadeOverlay?.remove();
    this.fadeOverlay = undefined;
    this.controls?.dispose();
    this.controls = undefined;
    // 后处理：composer 的读写缓冲 + 各 pass 自己的渲染目标/材质（必须逐个 pass dispose）
    this.postComposer?.dispose();
    this.postComposer = undefined;
    // 环境贴图（init 建一次，贯穿整个生命周期）
    this.environmentTexture?.dispose();
    this.environmentTexture = undefined;
    // 阴影贴图（renderer.shadowMap 的 RT 由 renderer 持有，但显式释放更稳）
    this.sunLight?.shadow.map?.dispose();
    if (this.sunLight?.shadow.map) {
      this.sunLight.shadow.map = null;
    }
    // renderer.dispose() 释放 WebGL 上下文的 GPU 侧资源；domElement 一并移除
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
    this.renderer = undefined;
    this.scene = undefined;
    this.camera = undefined;
    this.currentWorldMatrix = undefined;
    this.THREE = undefined;
    this.setState('disposed');
  }

  /**
   * 进入（切换）一个场景。
   *
   * 并发保护：`loading`/`disposing` 期间再次调用直接抛错——GPU 资源回收与新场景加载
   * 交叠会造成显存竞态（旧模型已 dispose、新模型已上传，`renderer.info.memory` 会翻倍）。
   *
   * @param request 场景加载描述
   * @param mode 期望的切换模式（默认 `switch`）
   * @returns 实际使用的模式与（可选）回退原因
   */
  async enterScene(
    request: SceneLoadRequest,
    mode: TwinSwitchMode = 'switch',
  ): Promise<EnterSceneResult> {
    if (this.disposed) {
      throw new Error('场景管理器已销毁，不能再加载场景');
    }
    if (!this.initialized) {
      throw new Error('场景管理器未初始化：请先 await init()');
    }
    if (this.state === 'loading' || this.state === 'disposing') {
      throw new Error('场景正在切换中，请稍候');
    }

    const flyCheck = mode === 'fly' ? this.canFly(request) : { allowed: false };
    const effectiveMode: TwinSwitchMode = flyCheck.allowed ? 'fly' : 'switch';

    this.setState('loading');
    try {
      // 换场景判定必须在**加载之前**做，并且只在**真的换场景**时清掉上一场景的锚点快照。
      // 两个坑（都实测踩过）：
      //   ① 若清得太晚，`refreshAnchors` 期间暂存的新场景锚点会被一起清掉；
      //   ② 若对「同场景重建」（资产到达触发的重载）也清，会丢掉加载期间到达的最新点位。
      const sceneChanged =
        this.currentSceneId !== undefined &&
        this.currentSceneId !== request.sceneId;
      this.currentSceneId = request.sceneId;
      if (sceneChanged) {
        this.lastAnchors = undefined;
      }
      const loaded = await this.loadModelOrThrow(request);
      await this.fadeOut();
      await this.clearCurrentModel();
      this.attachModel(loaded, request);
      await this.fadeIn();
      this.setState('ready');
      this.switchCount += 1;
      this.checkMemory();
      if (flyCheck.allowed) {
        return { mode: effectiveMode };
      }
      return {
        fallbackReason: flyCheck.reason,
        mode: effectiveMode,
      };
    } catch (error) {
      const stage = error instanceof ModelParseError ? 'parse' : 'download';
      const detail = error instanceof Error ? error.message : String(error);
      this.setState('failed', {
        message:
          stage === 'parse'
            ? this.errorMessages.parseFailed(detail)
            : this.errorMessages.downloadFailed(detail),
        stage,
      });
      throw error;
    }
  }

  /**
   * 相机飞向某个锚点（点击设备标签后的聚焦）。
   *
   * 飞行实现由 `twin-canvas` 注入（它持有 `CameraRig`，同时管理重置视角）；
   * 未注入时直接返回（不抛错：聚焦是增强功能，不应阻塞主流程）。
   *
   * @param pointId 点位 ID
   * @param distanceScale 距离系数（相对模型尺寸，默认 0.55 ⇒ 近距离观察该设备）
   * @returns 飞行结束时 resolve；被新飞行打断也 resolve（「被打断」不是错误）
   */
  async flyToAnchor(pointId: string, distanceScale = 0.55): Promise<void> {
    // 用户主动聚焦 ⇒ 巡航必须立即让位（否则飞过去后又被转走）
    this.orbit?.notifyInteraction();
    // 兜底：锚点不存在时不飞（飞到一个猜测位置会让用户更困惑），但巡航已被打断
    if (!this.anchorPositionCache.has(pointId)) {
      return;
    }
    if (!this.flyHandler) {
      return;
    }
    await this.flyHandler(pointId, distanceScale);
  }

  // ---------- 公共：设备聚焦（选中 / 悬停高亮）与拖放 ----------

  /**
   * 锚点世界坐标（供 hover 卡片定位）。
   *
   * 用锚点对象的**世界矩阵**而不是「局部坐标 × 场景矩阵」：避让/后续若加锚点抖动
   * 等变换，只有 `matrixWorld` 是与画面同源的真值。
   *
   * @param pointId 点位 ID
   * @returns 世界坐标；点位不存在/模型未加载时 undefined
   */
  getAnchorWorldPosition(
    pointId: string,
  ): undefined | { x: number; y: number; z: number } {
    const position = this.anchorPositionCache.get(pointId);
    return position ? { ...position } : undefined;
  }

  /**
   * 相机（供相机控制器做聚焦飞行与重置）。
   *
   * @returns 透视相机（未初始化时为 undefined）
   */
  getCamera(): THREE_NS.PerspectiveCamera | undefined {
    return this.camera;
  }

  /**
   * 当前相机位姿（供「视角预设」判断选中态）。
   *
   * @returns 位姿；未初始化时 undefined
   */
  getCameraPose():
    | undefined
    | {
        position: { x: number; y: number; z: number };
        target: { x: number; y: number; z: number };
      } {
    if (!this.camera || !this.controls) {
      return undefined;
    }
    return {
      position: {
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z,
      },
      target: {
        x: this.controls.target.x,
        y: this.controls.target.y,
        z: this.controls.target.z,
      },
    };
  }

  /**
   * OrbitControls（供拾取器在拖拽期间临时禁用以避免「拖拽带着相机转」）。
   *
   * @returns 控制器（未初始化时为 undefined）
   */
  getControls():
    | import('three/addons/controls/OrbitControls.js').OrbitControls
    | undefined {
    return this.controls;
  }

  /**
   * 当前模型最大尺寸（供聚焦时换算「距离系数 → 世界单位」）。
   *
   * 返回 `defaultTarget` 存在的意义：相机始终有观察目标，聚焦距离要相对模型尺度，
   * 不能写死世界单位（毫米级模型与千米级园区差 6 个数量级）。
   *
   * @returns 模型最大尺寸与观察中心（未加载时返回 undefined）
   */
  getModelMetrics():
    | undefined
    | {
        center: { x: number; y: number; z: number };
        maxDimension: number;
      } {
    const THREE = this.THREE;
    if (!THREE || !this.modelRoot) {
      return undefined;
    }
    const box = new THREE.Box3().setFromObject(this.modelRoot);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z);
    const target = this.defaultTarget;
    return {
      // 观察中心优先用当前 controls.target（用户可能已平移过视角）
      center: target
        ? { ...target }
        : { x: center.x, y: center.y, z: center.z },
      maxDimension:
        Number.isFinite(maxDimension) && maxDimension > 0 ? maxDimension : 100,
    };
  }

  /**
   * 当前场景的模型根（供拾取器做射线检视）。
   *
   * @returns 模型根（未加载时为 undefined）
   */
  getModelRoot(): THREE_NS.Group | undefined {
    return this.modelRoot;
  }

  /**
   * 当前动效档位（页面状态栏展示用）。
   *
   * 为什么由引擎层提供而不是页面自己查 `matchMedia`：档位判定包含「用户偏好 + 机型能力」
   * 两条判据，必须与画布内实际表现**同源**。页面若能显示 `reduced` 而画布还在脉冲，
   * 就是最典型的「说的和做的不一致」。
   *
   * @returns 动效档位
   */
  getMotionMode(): TwinMotionMode {
    return this.motionMode;
  }

  /**
   * 渲染统计（**状态栏的显存泄漏观测口**）。
   *
   * 直接读 `renderer.info.memory`：`geometries`/`textures` 在反复切换场景后应回到基线附近；
   * 持续上涨说明 dispose 覆盖不全（见 `disposal.ts`）。
   *
   * @returns 几何体/贴图数量；未初始化时返回 0（不返回 null）
   */
  getRenderStats(): { geometries: number; textures: number } {
    const memory = this.renderer?.info.memory;
    return {
      geometries: memory?.geometries ?? 0,
      textures: memory?.textures ?? 0,
    };
  }

  /**
   * 场景概况（供画布 HUD 展示；**纯读取，不渲染任何东西**）。
   *
   * ## 为什么放引擎层而不是页面自己拼
   *
   * 这几个字段（动画是否真在播、是否在巡航、动效档位）都必须与**画布内部的实际状态同源**：
   * 页面若自己拼（例如用「有 clip 数 > 0」判断「动画播放中」），在弱机型档位（clipSpeed=0，
   * mixer 每帧不 update）上就会显示「播放中」而画面完全静止 —— 这正是最典型的
   * 「说的和做的不一致」。因此统一由引擎层给出。
   *
   * ## 为什么返回 undefined 而不是全 0
   *
   * 「没有模型」与「模型 0 字节 / 0 动画」语义完全不同：前者 HUD 应显示「暂无模型」，
   * 后者是合法的「模型没有动画」。返回 undefined 让调用方能把两者区分开。
   *
   * @returns 场景概况；未加载模型（或管理器未初始化）时 undefined
   */
  getSceneSummary():
    | {
        /** 当前模型里可用的动画数（GLB 自带 clip 数量）。 */
        animationCount: number;
        /** 动画是否**真的在推进**（有 clip 且 `clipSpeed>0`）。 */
        animationsRunning: boolean;
        /** 模型文件字节数（未知为 0）。 */
        modelBytes: number;
        /** 当前动效档位。 */
        motionMode: TwinMotionMode;
        /** 相机是否在自动巡航。 */
        orbiting: boolean;
        /** 渲染统计（geometries/textures）。 */
        renderStats: { geometries: number; textures: number };
      }
    | undefined {
    // 没有模型就不给数字：调用方据此显示「暂无模型」而不是「0 字节 / 0 动画」
    if (!this.modelRoot || this.disposed) {
      return undefined;
    }
    return {
      animationCount: this.animationCount,
      animationsRunning: this.animator?.isRunning() ?? false,
      modelBytes: this.modelBytes,
      motionMode: this.motionMode,
      orbiting: this.orbit?.isOrbiting() ?? false,
      renderStats: this.getRenderStats(),
    };
  }

  /**
   * 当前选中点位（页面详情卡片用）。
   *
   * @returns 选中的点位 ID；未选中 undefined
   */
  getSelectedPoint(): string | undefined {
    return this.selectedPointId;
  }

  /**
   * three 命名空间（供相机控制器/拾取器构造，避免它们各自再 import 一次）。
   *
   * @returns three 命名空间（未初始化时为 undefined）
   */
  getThree(): typeof THREE_NS | undefined {
    return this.THREE;
  }

  /**
   * 当前场景的世界矩阵（供拾取器做坐标换算）。
   *
   * @returns 4x4 世界矩阵（未初始化时抛错，不返回假矩阵）
   */
  getWorldMatrix(): THREE_NS.Matrix4 {
    if (!this.currentWorldMatrix) {
      throw new Error('场景管理器未初始化：世界矩阵不可用');
    }
    return this.currentWorldMatrix;
  }

  /**
   * 点位对应的模型节点是否找到（找不到时页面要提示「该点位未绑定模型节点」）。
   *
   * @param pointId 点位 ID
   * @returns 是否命中 ≥1 个可高亮的节点
   */
  hasNodeForPoint(pointId: string): boolean {
    const root = this.modelRoot;
    const descriptor = this.anchorDescriptors.get(pointId);
    if (!root || !descriptor) {
      return false;
    }
    return (
      pickHighlightNodes(findNodesByPointName(root, descriptor.nodeName))
        .length > 0
    );
  }

  /**
   * 初始化渲染器/场景/相机/控制器（**只做一次**）。
   *
   * 重复调用是幂等的（`initialized` 短路）：画布的 `onMounted` 与「重试按钮」都会走这里，
   * 重复建 renderer 会造成上下文泄漏。
   */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    const THREE = await import('three');
    const { OrbitControls } =
      await import('three/addons/controls/OrbitControls.js');
    this.THREE = THREE;

    // ---- 动效档位（在建设备之前判定：弱机型要少建/少渲） ----
    this.motionMode = resolveMotionMode(readMotionProfileInput());
    const switches = motionSwitches(this.motionMode);
    // 弱机型（off 档）关闭后处理：EffectComposer 每帧多两次全屏绘制 + bloom 的
    // 5 级降采样，在 4 核/4GB 机器上是「从能用到不能用」的差别
    this.postOptions = resolvePostOptions({
      // 只有 normal 档开后处理；reduced 档是「用户偏好」，但后处理本身不是「动效」，
      // 它只是静态的画质增强 —— 因此 reduced 档**保留**后处理（否则画面质感断崖式下降）。
      // off 档（弱机型）才关：每帧多两次全屏绘制 + bloom 降采样链，弱机扛不住。
      enabled: this.motionMode !== 'off',
    });
    this.rendererOptions = resolveRendererOptions(THREE, {
      // 弱机型关阴影：PCFSoft 的 PCF 采样在集成显卡上是主要的帧时间来源
      shadowMapEnabled: this.motionMode !== 'off',
    });

    this.scene = new THREE.Scene();
    this.scene.background = createBackgroundTexture(THREE, this.lightCanvas);

    this.camera = new THREE.PerspectiveCamera(50, this.aspect(), 0.1, 20_000);
    // 初始视角：斜上方看向原点（根场景的合理起点；子场景会被 view_json 覆盖）
    this.camera.position.set(40, 30, 40);

    this.renderer = this.rendererFactory
      ? this.rendererFactory(THREE)
      : new THREE.WebGLRenderer({
          // 不透明背景：透明背景 + 大量半透明材质的排序成本很高
          alpha: false,
          // 走 EffectComposer 时 MSAA 失效（渲染目标是普通 RT），抗锯齿由 FXAA 负责；
          // 不开后处理（弱机型）时由画布自带 MSAA 负责。两者都开只是白付 MSAA 带宽。
          antialias: !this.postOptions.enabled,
          powerPreference: 'high-performance',
        });
    // ★ 关键的渲染管线配置：色彩空间 / 色调映射 / 阴影。
    // 改造前这里**一个都没设**（只有 antialias），结果是无色调映射（高光裁切）、
    // 无阴影（建筑像贴纸）。配置本身在纯函数里算（见 renderer-options.ts），
    // 这里只负责「写进 renderer」。
    applyRendererOptions(this.renderer, this.rendererOptions);
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    this.renderer.setSize(
      this.container.clientWidth || 1,
      this.container.clientHeight || 1,
    );
    this.container.append(this.renderer.domElement);

    // ---- 环境贴图（一次生成，全程复用；RoomEnvironment 生成后立即 dispose） ----
    try {
      const [{ PMREMGenerator }, { RoomEnvironment }] = await Promise.all([
        import('three'),
        import('three/addons/environments/RoomEnvironment.js'),
      ]);
      this.environmentTexture = buildEnvironmentTexture(
        this.renderer,
        PMREMGenerator as never,
        () => new RoomEnvironment() as never,
      );
      this.scene.environment = this.environmentTexture;
      // 环境反射强度：RoomEnvironment 偏亮，1.0 会让金属面发白（像镀铬）。0.62 更有质感。
      this.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
    } catch (error) {
      // 环境贴图不是必需品（没有它只是少了反射），但要留痕：否则只会觉得「金属发灰」
      console.warn(
        '[iot/twin] 环境贴图生成失败，金属材质将缺少反射（画面质感下降）：',
        error,
      );
    }

    // ---- 灯光 ----
    // 半球光：天空（冷灰蓝、略亮）/ 地面（深冷灰、暗）→ 顶面亮、侧/底面暗。
    // 这是「有体积感」的最大来源，换成旧的 AmbientLight 就没有这个上下差异。
    this.hemiLight = new THREE.HemisphereLight(
      new THREE.Color(TWIN_COLOR_HEMI_SKY),
      new THREE.Color(TWIN_COLOR_HEMI_GROUND),
      DEFAULT_HEMI_INTENSITY,
    );
    this.hemiLight.name = '__twin_hemi__';
    this.scene.add(this.hemiLight);

    // 主方向光：负责投影（大角度柔光，参考图的主光来自斜上方）
    this.sunLight = new THREE.DirectionalLight(
      new THREE.Color(TWIN_COLOR_SUN),
      DEFAULT_SUN_INTENSITY,
    );
    this.sunLight.name = '__twin_sun__';
    this.sunLight.castShadow = this.rendererOptions.shadowMapEnabled;
    this.scene.add(this.sunLight);

    // 补光：从背面很低强度地补，勾出建筑轮廓（避免暗部一片死灰）
    this.fillLight = new THREE.DirectionalLight(
      new THREE.Color(TWIN_COLOR_FILL),
      DEFAULT_FILL_INTENSITY,
    );
    this.fillLight.name = '__twin_fill__';
    this.fillLight.position.set(-0.6, 0.35, -0.7);
    this.scene.add(this.fillLight);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    // 禁止转到地面以下：从地下看建筑模型没有意义且容易迷失方向
    this.controls.maxPolarAngle = Math.PI / 2;

    this.currentWorldMatrix = new THREE.Matrix4();

    // ---- 后处理（Bloom 只让自发光/告警发光；OutputPass 负责色调映射与 sRGB） ----
    await this.setupPostProcessing(THREE);

    // ---- 相机自动巡航（reduced/off 档不启用） ----
    this.orbit = createAutoOrbit(THREE, {
      camera: this.camera,
      controls: this.controls,
      domElement: this.renderer.domElement,
      enabled: switches.autoOrbit,
    });

    // ---- 监听系统「减少动态效果」的运行时切换（用户中途开启也要生效） ----
    this.watchMotionPreference();

    // 淡入淡出遮罩（切换场景时避免「黑屏一瞬」的突兀感）
    this.fadeOverlay = document.createElement('div');
    this.fadeOverlay.style.cssText = [
      'position:absolute',
      'inset:0',
      `background:${SCENE_BACKGROUND}`,
      'opacity:0',
      'pointer-events:none',
      'transition:opacity 180ms ease',
      'z-index:1',
    ].join(';');
    this.container.append(this.fadeOverlay);

    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    this.resizeObserver.observe(this.container);

    this.startRenderLoop();
    this.initialized = true;
    this.setState('disposed');
  }

  /**
   * 当前模型是否支持剖切（真的找到了可隐藏的 roof/wall/truss 节点）。
   *
   * 页面据此决定是否显示「外观：剖切/完整」开关 —— 避免做一个「点了没反应」的开关。
   *
   * @returns 是否命中 ≥1 个可隐藏节点
   */
  isShellSupported(): boolean {
    return (this.shellNodes?.nodes.length ?? 0) > 0;
  }

  /**
   * 当前是否为剖切视图（页面开关据此显示选中态）。
   *
   * @returns true = 剖切（外壳已隐藏）
   */
  isShellVisible(): boolean {
    return this.shellVisible;
  }

  /**
   * 当前场景的「模型节点 → 点位」映射是否可用（调试/HUD 用）。
   *
   * @returns 已收到且节点匹配成功的点位 ID 列表
   */
  listPointsWithNodes(): string[] {
    return [...this.anchorDescriptors.keys()].filter((pointId) =>
      this.hasNodeForPoint(pointId),
    );
  }

  /**
   * 把世界坐标投到容器像素坐标（相对画布容器左上角）。
   *
   * @param world 世界坐标
   * @returns 屏幕坐标与是否在视锥内；未初始化时 undefined
   */
  projectToScreen(world: {
    x: number;
    y: number;
    z: number;
  }): undefined | { visible: boolean; x: number; y: number } {
    const THREE = this.THREE;
    const camera = this.camera;
    if (!THREE || !camera) {
      return undefined;
    }
    const vector = new THREE.Vector3(world.x, world.y, world.z);
    vector.project(camera);
    // ⚠️ 尺寸必须与 **CSS2DRenderer 同源**：它内部用自己 `setSize` 时的宽高
    // （= 我们 `resize()` 里传的 container 尺寸）。这里优先取 renderer 的绘制尺寸
    // （`getSize`，与画布一致），拿不到再用容器尺寸。
    // 之前只用 `container.clientWidth`：场景切换/容器短暂 0 宽时会算错，且与
    // 画布实际绘制尺寸可能有 1~2px 差（滚动条/边框）⇒ 卡片定位与锚点视觉位置错开。
    const size = this.renderer?.getSize
      ? this.renderer.getSize(new THREE.Vector2())
      : undefined;
    const width =
      size?.x && size.x > 0 ? size.x : this.container.clientWidth || 1;
    const height =
      size?.y && size.y > 0 ? size.y : this.container.clientHeight || 1;
    const x = ((vector.x + 1) / 2) * width;
    const y = ((-vector.y + 1) / 2) * height;
    // `project` 对相机背后的点会给出「镜像」坐标（z > 1），必须用 z 判断可见性，
    // 否则相机背后的锚点会被投到屏幕上并被当成可见。
    //
    // 越界容差 {@link PROJECT_CLIP_TOLERANCE_PX}：锚点贴着画布边缘时（标签被夹紧到
    // 4px 留边）浮点误差会把它判成「越界」，调用方据此隐藏卡片 ⇒ 卡片「闪一下就没」。
    // 这里只排除**真正在视锥外/相机背后**的点，越界多少交给调用方决定。
    const tolerance = PROJECT_CLIP_TOLERANCE_PX;
    const visible =
      vector.z < 1 &&
      vector.z > -1 &&
      x >= -tolerance &&
      y >= -tolerance &&
      x <= width + tolerance &&
      y <= height + tolerance;
    return { visible, x, y };
  }

  /**
   * 批量更新锚点运行态（由页面在 rAF 合并后调用）。
   *
   * @param states 点位 ID → 运行态
   */
  /**
   * 只刷新锚点层（点位增删改时用），**不重载模型**。
   *
   * 为什么不能整场景重建：`attachModel` 会 `detach()` 掉全部锚点元素再重建。
   * 若运行态刷新也走这条路，锚点会被高频重建 —— 新元素文本为空、旧元素刚被移除，
   * 结果就是「标签永远看不见」（线上实测：写入 108 次、读到的 6 个元素全为空）。
   * 点位变化只影响锚点的位置/绑定，模型没变就只该重建锚点。
   *
   * @param anchors 新的锚点描述
   */
  refreshAnchors(anchors: AnchorDescriptor[]): void {
    // 无论能否立刻挂载，都要记住最新值：attachModel 会用它建锚点
    this.lastAnchors = anchors;
    if (!this.modelRoot) {
      return;
    }
    this.rememberAnchorDescriptors(anchors);
    this.anchorLayer?.attach(this.modelRoot, anchors);
    // 点位变了：重新按当前选中/悬停刷新高亮（旧节点可能已被替换）
    this.refreshFocus();
    this.refreshAnchorPositionCache();
    // 重建后立刻重放最近一次运行态，避免标签又空一帧
    if (this.lastAnchorStates && this.lastAnchorStates.size > 0) {
      this.anchorLayer?.update(this.lastAnchorStates);
    }
  }

  /**
   * 画布容器的像素坐标 → 场景局部坐标（**资料库拖拽落点**用）。
   *
   * 射线拾取模型表面：拿到世界交点后换算回本场景局部坐标（落库口径，与点击放置锚点
   * 完全同一套换算）。命中不到模型表面时返回 `undefined`（调用方据此拒绝落下，
   * 不要在虚空里创建点位）。
   *
   * @param screenX 相对画布容器左上角的 X（CSS 像素）
   * @param screenY 相对画布容器左上角的 Y
   * @returns 场景局部坐标；未命中模型表面/未初始化时 undefined
   */
  screenToLocal(
    screenX: number,
    screenY: number,
  ): undefined | { x: number; y: number; z: number } {
    const THREE = this.THREE;
    const camera = this.camera;
    const root = this.modelRoot;
    if (!THREE || !camera || !root) {
      return undefined;
    }
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    // NDC：画布像素 → [-1, 1]（与 picker.ts 同一口径，保证「拖拽落点」与「点击放点」一致）
    const pointer = new THREE.Vector2(
      (screenX / width) * 2 - 1,
      -(screenY / height) * 2 + 1,
    );
    if (!this.raycaster) {
      this.raycaster = new THREE.Raycaster();
    }
    this.raycaster.setFromCamera(pointer, camera);
    const hits = this.raycaster.intersectObject(root, true);
    // 跳过锚点 sprite（它们 depthTest=false，可能挡在模型前面）
    const hit = hits.find((item) => {
      const { isTwinAnchor } = item.object.userData as {
        isTwinAnchor?: boolean;
      };
      return isTwinAnchor !== true;
    });
    if (!hit) {
      return undefined;
    }
    return this.worldToLocal(hit.point);
  }

  /**
   * 立即切到指定机位（**无动画**：预设是构图选择，不是导航）。
   *
   * 同时把「初始视角」更新为这里：否则用户点完预设后再点「重置」会跳回加载时
   * 自适应算出的旧机位（用户会以为预设没生效）。
   *
   * @param pose 机位
   */
  setCameraPose(pose: {
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
  }): void {
    if (!this.camera || !this.controls) {
      return;
    }
    // 用户主动选机位 ⇒ 巡航必须让位（否则 20s 后被转走）
    this.orbit?.notifyInteraction();
    this.camera.position.set(pose.position.x, pose.position.y, pose.position.z);
    this.controls.target.set(pose.target.x, pose.target.y, pose.target.z);
    this.controls.update();
    this.defaultTarget = { ...pose.target };
  }

  /**
   * 拖放落点预览（在落点显示一个临时标记；`undefined` = 清除）。
   *
   * 标记是一个贴地的细圆环（低透明度），只做「将要落在这里」的提示，不参与拾取。
   *
   * @param local 场景局部坐标（与 `screenToLocal` 同口径）；undefined 清除预览
   */
  setDropPreview(local?: { x: number; y: number; z: number }): void {
    const THREE = this.THREE;
    const root = this.modelRoot;
    if (!this.dropPreview || !root) {
      // 没有预览对象也没有模型：先建出预览对象（等模型就绪后再显示）
      if (local && this.scene) {
        this.ensureDropPreview();
      }
      if (!local) {
        this.dropPreview?.removeFromParent();
      }
      if (local && this.dropPreview) {
        this.positionDropPreview(local);
      }
      return;
    }
    if (!local) {
      this.dropPreview.visible = false;
      return;
    }
    if (!THREE) {
      return;
    }
    this.positionDropPreview(local);
  }

  /**
   * 注册聚焦飞行实现（由 `twin-canvas` 在 `init()` 之后调用一次）。
   *
   * @param handler 飞行实现
   */
  setFlyHandler(
    handler: (pointId: string, distanceScale: number) => Promise<void>,
  ): void {
    this.flyHandler = handler;
  }

  // ---------- 公共：集成契约（hover 卡片 / 状态栏 / 聚焦） ----------

  /**
   * 设置悬停点位（弱高亮；`undefined` = 清除）。
   *
   * 弱于选中：只提自发光，不放大、不压暗其余设备（否则鼠标一扫全屏变暗，很吵）。
   *
   * **有选中时悬停不抢占**：用户点选 A 后鼠标扫过 B，高亮仍留在 A 上
   * （否则高亮与详情卡片的内容会不一致）。取消选中后悬停立即恢复生效。
   *
   * @param pointId 点位 ID；undefined 清除悬停
   */
  setHoveredPoint(pointId?: string): void {
    this.hoveredPointId = pointId;
    this.refreshFocus();
  }

  /**
   * 通知「鼠标停在某个锚点上」（hover 卡片打开时调用；传 undefined 表示离开）。
   *
   * 两个作用：
   * 1. 暂停数据驱动脉冲（hover 期间标签在呼吸/闪烁会干扰读数）；
   * 2. 该标签在避让布局里**不再参与移动**（否则鼠标一放上去它就溜走，点不中）。
   *
   * @param pointId 点位 ID；undefined 表示离开
   */
  setInteractionHover(pointId?: string): void {
    // hover 期间巡航必须停（用户在看某台设备，画面不该继续转）
    this.orbit?.notifyInteraction();
    // 转发给锚点层：hover 的点位不参与避让（否则鼠标放上去它就被挤走），
    // 且暂停该点位的脉冲/扩散环（避免干扰读数）
    this.anchorLayer?.setHovered?.(pointId);
  }

  /**
   * 按主题切换画布底色（亮色主题 ⇒ 浅色背景渐变 + 浅色地面/网格）。
   *
   * 为什么由页面传入而不是引擎自己读 `matchMedia`：主题是**应用设置**（用户可在页面里
   * 手动切），不是系统偏好；引擎自己读会与应用的 `theme.mode` 不一致
   * （用户切了亮色、画布仍按系统深色渲染）。
   *
   * 用户为场景显式配置了 `viewJson.background` 时**不覆盖背景**，只让地面/网格跟随主题
   * （见 {@link hasExplicitBackground}）。
   *
   * @param light 是否亮色主题
   */
  setLightCanvasByTheme(light: boolean): void {
    if (this.lightCanvas === light) {
      return;
    }
    this.lightCanvas = light;
    const THREE = this.THREE;
    if (!THREE || !this.scene) {
      return;
    }
    if (!this.hasExplicitBackground) {
      const previous = this.scene.background;
      this.scene.background = createBackgroundTexture(THREE, light);
      // 旧纹理必须释放：每次切主题新建一张 CanvasTexture，不释放会持续占显存
      if (previous instanceof THREE.Texture) {
        previous.dispose();
      }
      this.effectiveBackground = light
        ? TWIN_COLOR_BACKGROUND_TOP_LIGHT
        : TWIN_COLOR_BACKGROUND_TOP;
    }
    // 地面/网格按**新的实际背景**重建（配色必须与背景同一套，否则出现「浅底深地面」）
    if (this.modelRoot) {
      this.rebuildEnvironment(this.modelRoot);
    }
  }

  /**
   * 设置选中点位（高亮模型节点；`undefined` = 取消选中）。
   *
   * 高亮口径（见 `device-focus.ts`）：点位有 `nodeName` 时在模型里找同名节点并高亮
   * （精确优先、宽松匹配兜底）；没有 `nodeName` 或匹配不到时，退化为「锚点位置附近
   * 半径内最近的 mesh」——这样历史点位（未绑节点）也有可见反馈，而不是点了没反应。
   *
   * @param pointId 点位 ID；undefined 取消选中
   */
  setSelectedPoint(pointId?: string): void {
    this.selectedPointId = pointId;
    // 选中时持久显示该点位的圆点与数值（默认态两者都不显示）
    this.anchorLayer?.setSelected?.(pointId);
    this.refreshFocus();
  }

  /**
   * 设置「剖切 / 完整」外观（按节点名隐藏屋顶与近侧墙）。
   *
   * 默认为剖切（{@link shellVisible} 初始 false）：演示场景的锚点在机柜内部，
   * 完整封闭厂房会把它们**全部挡住**（dev 实测：画面只有几个圆点挂在白色屋面上）。
   *
   * @param show true = 完整（显示屋顶/墙/桁架）；false = 剖切（隐藏它们）
   */
  setShellVisible(show: boolean): void {
    this.shellVisible = show;
    if (this.shellNodes) {
      applyShellVisibility(this.shellNodes, show, this.modelRoot);
    }
  }

  updateAnchorStates(states: Map<string, AnchorRuntimeState>): void {
    // 始终先存一份：锚点层可能还没就绪（见 lastAnchorStates 的说明）
    this.lastAnchorStates = states;
    this.anchorLayer?.update(states);
  }

  /**
   * 世界法线 → 当前场景局部法线（拾取结果的落库口径）。
   *
   * 法线必须用**逆转置矩阵**变换（不是直接乘）：非均匀缩放下直接乘会让法线方向失真。
   * 且换算基准必须是 `currentWorldMatrix`（与渲染同源的场景图矩阵），不能用世界法线直传 ——
   * 父场景有旋转时直传会把「世界朝向」当成「本场景朝向」存进库，灯具/贴面朝向就错了。
   *
   * @param normal 世界坐标法线
   * @returns 本场景局部法线（已归一化）
   */
  worldNormalToLocal(normal: { x: number; y: number; z: number }): {
    x: number;
    y: number;
    z: number;
  } {
    const THREE = this.THREE;
    const matrix = this.currentWorldMatrix;
    if (!THREE || !matrix) {
      throw new Error('场景管理器未初始化：法线换算不可用');
    }
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(
      matrix.clone().invert().transpose(),
    );
    const vector = new THREE.Vector3(normal.x, normal.y, normal.z)
      .applyMatrix3(normalMatrix)
      .normalize();
    return { x: vector.x, y: vector.y, z: vector.z };
  }

  /**
   * 世界坐标 → 当前场景局部坐标（拾取结果的落库口径）。
   *
   * @param world 世界坐标
   * @returns 局部坐标
   */
  worldToLocal(world: { x: number; y: number; z: number }): {
    x: number;
    y: number;
    z: number;
  } {
    const THREE = this.THREE;
    const matrix = this.currentWorldMatrix;
    if (!THREE || !matrix) {
      throw new Error('场景管理器未初始化：坐标换算不可用');
    }
    const vector = new THREE.Vector3(world.x, world.y, world.z).applyMatrix4(
      matrix.clone().invert(),
    );
    return { x: vector.x, y: vector.y, z: vector.z };
  }

  // ---------- 私有：加载与装配 ----------

  /**
   * 按模型包围盒调整主光源、阴影相机与补光（**每个场景都要重做**）。
   *
   * 为什么不能只在 init 里设一次：不同场景的模型尺度差异极大（园区 vs 机柜），
   * 固定的阴影相机范围会让「小模型阴影糊成一片」「大模型完全没有阴影」。
   *
   * @param modelRoot 模型根
   */
  private applyLightingToModel(modelRoot: THREE_NS.Object3D): void {
    const THREE = this.THREE;
    const sun = this.sunLight;
    if (!THREE || !sun) {
      return;
    }
    const box = new THREE.Box3().setFromObject(modelRoot);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z);
    const safe =
      Number.isFinite(maxDimension) && maxDimension > 0 ? maxDimension : 100;

    // 主光位置：斜上方（方位 45°，高度约 60°），距离按模型尺寸缩放
    const distance = safe * SUN_DISTANCE_RATIO;
    sun.position.set(
      center.x + distance * 0.45,
      center.y + distance * 0.75,
      center.z + distance * 0.5,
    );
    sun.target.position.copy(center);
    sun.target.updateMatrixWorld();
    if (!sun.parent) {
      this.scene?.add(sun.target);
    }

    const shadow = resolveShadowCamera(size, this.rendererOptions);
    sun.shadow.mapSize.set(
      this.rendererOptions?.shadowMapSize ?? 2048,
      this.rendererOptions?.shadowMapSize ?? 2048,
    );
    const camera = sun.shadow.camera;
    camera.left = -shadow.extent;
    camera.right = shadow.extent;
    camera.top = shadow.extent;
    camera.bottom = -shadow.extent;
    camera.near = Math.max(0.01, safe * 0.01);
    camera.far = shadow.far;
    camera.updateProjectionMatrix();
    sun.shadow.bias = shadow.bias;
    sun.shadow.normalBias = shadow.normalBias;

    // 关闭旧阴影贴图（换场景尺寸后旧贴图分辨率不对；three 会重建，但显式释放更稳）
    sun.shadow.map?.dispose();
    sun.shadow.map = null;

    // 若有材质是自发光指示灯的候选（材质自带 emissive），保持原样；
    // 这里额外把「黑色/深色小件」提亮一档交给 Bloom：只对 **emissive 材质**生效，
    // 不去猜「哪块是机柜灯」（猜错就是给建筑整体加发光，会泛白）。
    this.highlightEmissiveParts(modelRoot);

    // 记录基准强度（缓变围绕它浮动；`applyView` 调整后也会更新基准）
    this.sunBaseIntensity = this.sunLight?.intensity ?? DEFAULT_SUN_INTENSITY;
    this.hemiBaseIntensity =
      this.hemiLight?.intensity ?? DEFAULT_HEMI_INTENSITY;
  }

  /**
   * 应用新的动效档位（系统偏好变化时调用）。
   *
   * @param mode 新档位
   */
  private applyMotionMode(mode: TwinMotionMode): void {
    if (this.motionMode === mode) {
      return;
    }
    this.motionMode = mode;
    const switches = motionSwitches(mode);
    this.animator?.setClipSpeed(switches.clipSpeed);
    this.anchorLayer?.setMotionMode?.(mode);
    // 巡航：从「启用」切到「禁用」需要停掉；反向打开时由下一帧的 update 自然接管
    if (switches.autoOrbit) {
      this.orbit?.resume();
    } else {
      this.orbit?.pause();
    }
    // 阴影：弱机型关闭
    if (this.renderer && this.rendererOptions) {
      const nextShadowEnabled = mode !== 'off';
      if (this.renderer.shadowMap.enabled !== nextShadowEnabled) {
        this.rendererOptions = {
          ...this.rendererOptions,
          shadowMapEnabled: nextShadowEnabled,
        };
        applyRendererOptions(this.renderer, this.rendererOptions);
        // 已有材质需要重新编译（阴影开关属着色器变体）
        this.scene?.traverse((object) => {
          const withMaterial = object as THREE_NS.Mesh;
          if (!withMaterial.material) {
            return;
          }
          const materials = Array.isArray(withMaterial.material)
            ? withMaterial.material
            : [withMaterial.material];
          for (const material of materials) {
            material.needsUpdate = true;
          }
        });
      }
    }
  }

  /**
   * 记录「是否浅色底」。
   *
   * 配色在「重建环境」时生效（`rebuildEnvironment` 是地面/网格的**唯一创建点**）：
   * 切场景会重建环境 ⇒ 一并带上当前底色；`applyView` 早于环境重建，所以这里只记录。
   * 只改颜色不改光照强度：光照与阴影已按模型尺度与色调映射调好，换底不该动它们。
   *
   * @param light 是否浅色底
   */
  private applySurfacePalette(background: string | undefined): void {
    this.effectiveBackground = background ?? TWIN_COLOR_BACKGROUND_TOP;
  }

  /** 应用视角配置（空则按模型包围盒自适应，保证「一进去就能看到模型」）。 */
  private applyView(view?: null | TwinViewConfig): void {
    const THREE = this.THREE;
    if (
      !THREE ||
      !this.scene ||
      !this.camera ||
      !this.controls ||
      !this.modelRoot
    ) {
      return;
    }
    this.hasExplicitBackground = Boolean(view?.background);
    if (view?.background) {
      this.scene.background = new THREE.Color(view.background);
    } else {
      // 未配置 ⇒ 跟随主题（亮色主题用浅色渐变，而不是把深色画布塞进亮色页面）
      // 到这里 this.scene 必然存在（函数开头已 return 空值分支）
      const previous = this.scene.background;
      this.scene.background = createBackgroundTexture(THREE, this.lightCanvas);
      if (previous instanceof THREE.Texture) {
        previous.dispose();
      }
    }
    // 浅色底（亮色主题或用户配置了浅色背景）时切换地面/网格/填充色：
    // 否则「深色地面 + 浅色底」会像贴纸，且网格线对比度不足（看不出来）。
    this.applySurfacePalette(
      view?.background ??
        (this.lightCanvas
          ? TWIN_COLOR_BACKGROUND_TOP_LIGHT
          : TWIN_COLOR_BACKGROUND_TOP),
    );
    // 光照强度可配（场景级差异：室内楼层通常比园区暗）。
    //
    // ⚠️ 这里曾按 `AmbientLight` 找子节点；本次改造把环境光换成了 `HemisphereLight`
    //    （顶底双色的半球光，「天空亮、地面暗」是质感的关键）。若仍只认 AmbientLight，
    //    `view.ambientIntensity` 会**静默失配**——用户在编辑里调了强度，画面毫无反应。
    //    因此改为：环境光 → HemisphereLight（语义不变：仍是「环境光强度」）。
    if (typeof view?.ambientIntensity === 'number') {
      for (const child of this.scene.children) {
        if (child instanceof THREE.HemisphereLight) {
          child.intensity = view.ambientIntensity;
          this.hemiBaseIntensity = view.ambientIntensity;
        }
      }
    }
    if (typeof view?.directionalIntensity === 'number') {
      for (const child of this.scene.children) {
        if (child instanceof THREE.DirectionalLight && child.castShadow) {
          child.intensity = view.directionalIntensity;
          this.sunBaseIntensity = view.directionalIntensity;
        }
      }
    }

    const box = new THREE.Box3().setFromObject(this.modelRoot);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z);

    if (view?.camera?.position && view.camera.target) {
      this.camera.position.set(
        view.camera.position.x,
        view.camera.position.y,
        view.camera.position.z,
      );
      this.controls.target.set(
        view.camera.target.x,
        view.camera.target.y,
        view.camera.target.z,
      );
      if (typeof view.camera.fov === 'number') {
        this.camera.fov = view.camera.fov;
        this.camera.updateProjectionMatrix();
      }
    } else if (Number.isFinite(maxDimension) && maxDimension > 0) {
      // 没有配置视角时按包围盒自适应。
      //
      // 改造前是「固定 +0.6/+0.5/+0.6 方向、距离 1.6 倍」⇒ 机位偏平、模型偏小。
      // 现在按球坐标摆机位：俯视 35°、方位 240°（西南方向）、距离 1.9 倍，
      // 更接近参考图的「略俯视 + 模型充满画面 2/3 + 略带透视」。
      const distance = maxDimension * DEFAULT_CAMERA_DISTANCE_RATIO;
      const horizontal = Math.cos(DEFAULT_CAMERA_ELEVATION_RAD) * distance;
      this.camera.position.set(
        center.x + Math.cos(DEFAULT_CAMERA_AZIMUTH_RAD) * horizontal,
        center.y + Math.sin(DEFAULT_CAMERA_ELEVATION_RAD) * distance,
        center.z + Math.sin(DEFAULT_CAMERA_AZIMUTH_RAD) * horizontal,
      );
      this.controls.target.copy(center);
      // 近远裁剪面按模型尺寸调整：建筑模型的坐标尺度可能是米或毫米，
      // 固定 0.1/5000 在毫米级模型上会整片被裁掉
      this.camera.near = Math.max(0.001, maxDimension / 10_000);
      this.camera.far = maxDimension * 100;
      this.camera.updateProjectionMatrix();
    }
    this.defaultTarget = {
      x: this.controls.target.x,
      y: this.controls.target.y,
      z: this.controls.target.z,
    };
    this.controls.update();
  }

  private aspect(): number {
    const width = this.container.clientWidth || 1;
    const height = this.container.clientHeight || 1;
    return width / height;
  }

  /** 挂载新模型：应用锚点变换、加入场景、通知锚点层。 */
  private attachModel(loaded: LoadedModel, request: SceneLoadRequest): void {
    const THREE = this.THREE;
    if (!THREE || !this.scene) {
      throw new Error('场景管理器未初始化：无法挂载模型');
    }
    const root = loaded.scene;
    this.modelRoot = root;
    // HUD 要展示「模型体积 / 动画数」：在这里记一次（纯读，不影响渲染）
    this.modelBytes =
      typeof request.modelBytes === 'number' &&
      Number.isFinite(request.modelBytes)
        ? Math.max(0, request.modelBytes)
        : 0;
    this.animationCount = loaded.animations.length;

    // 锚点变换：**把整条祖先链建成嵌套 Group**，而不是只设自身变换。
    //
    // ⚠️ 这里曾有一个会系统性偏移坐标的缺陷（独立复核实测发现）：
    //    旧实现只把 `request.anchor`（自身）设到 root，父链从未进场景图；
    //    但 `currentWorldMatrix` 却另外手写合成了一套**含父链**的矩阵（已删除），
    //    `worldToLocal` 又用它的逆换算落库坐标 ⇒ 渲染位置与换算矩阵不是同一套。
    //    后果：父 anchor x=10、子 anchor x=5 时，画布上看到的原点在世界 (5,0,0)，
    //    但矩阵认为在 (15,0,0)；用户点到「看到的原点」，落库局部坐标是 (-10,0,0)（正确应为 0），
    //    且多点几层误差线性放大。
    //
    // 修法：让**渲染与矩阵同源**——沿 ancestry 逐级建 Group（每级一个 anchor 变换），
    // 模型挂在最深那级下面。这样 three 的 `matrixWorld` 自然等于
    // `parentWorld × anchor`，`worldToLocal` 用它取逆即可，不需要前端自己合成一套。
    // ancestry 是「根 → 叶」顺序（含自身）：
    //   scene → pivot(根 anchor) → pivot(第2级 anchor) → … → modelRoot
    // 于是 modelRoot.matrixWorld 自然等于 `parentWorld × anchor`（与后端口径一致），
    // 不需要前端再手写一套矩阵合成。
    // 变换数学全部在 `ancestry.ts`（纯函数，可单测）——这里只负责挂载。
    const { parent, pivots: createdPivots } = buildAncestryPivots(
      THREE,
      this.scene,
      request.ancestry,
    );

    // 模型根不再叠加 anchor：父链最后一环已包含自身 anchor。
    // ancestry 为空时（防御：后端保证至少含自身）退回用 request.anchor 兜底。
    if (createdPivots.length === 0) {
      applyAnchorToObject(root, request.anchor);
    }
    parent.add(root);
    // 必须立刻刷新：matrixWorld 是「上次渲染时」算的，此处要马上用它换算坐标
    root.updateWorldMatrix(true, true);

    // 世界矩阵**直接取渲染图的实际结果**（与渲染同源，不再手写合成）
    this.currentWorldMatrix = root.matrixWorld.clone();

    // 记下 pivot 链：dispose 时整条一起移除（否则留下孤儿 Group 与残留显存）
    this.ancestryPivots = createdPivots;

    // 用**最新**的锚点：`request.anchors` 是 loadScene 开始时捕获的快照，
    // 而模型加载期间 props.anchors 可能已更新（refreshAnchors 暂存了最新值）。
    // 用旧快照会让「加载期间新增的点位」不显示。
    // 优先用加载期间暂存的新值；没有则用本次请求携带的。
    // 两者都为空是合法情况（场景暂无点位）。
    const anchorsToUse = this.lastAnchors ?? request.anchors;
    this.lastAnchors = anchorsToUse;
    this.rememberAnchorDescriptors(anchorsToUse);
    this.anchorLayer?.attach(root, anchorsToUse);
    // 挂载后立刻重放运行态（数据通常比模型先到）
    if (this.lastAnchorStates && this.lastAnchorStates.size > 0) {
      this.anchorLayer?.update(this.lastAnchorStates);
    }
    // 动效档位也要下发一次：锚点层可能是本次新建的（拿不到初始值）
    this.anchorLayer?.setMotionMode?.(this.motionMode);

    // ---- GLB 自带动画（「模型自己会动」那一档） ----
    this.animator?.dispose();
    this.animator = undefined;
    if (loaded.animations.length > 0) {
      this.animator = createTwinAnimator(
        THREE,
        root,
        loaded.animations,
        motionSwitches(this.motionMode).clipSpeed,
      );
    }

    // ---- 光照/阴影按模型尺度自适应（与视角无关，先做） ----
    this.applyLightingToModel(root);

    // ---- 剖切：收集外壳节点并按当前状态应用 ----
    // 必须在 applyView 之前？不需要：visible 不影响包围盒（three 的 Box3.setFromObject
    // 会忽略 invisible 吗？实测**不会**忽略，因此相机自适应仍是「完整模型」的构图，
    // 剖切只改可见性，不会让相机突然拉近/推远）。
    this.shellNodes = collectShellNodes(root);
    applyShellVisibility(this.shellNodes, this.shellVisible, root);

    // ---- 先定视角（含 `viewJson.background`），再重建环境 ----
    //
    // ⚠️ 这两个顺序曾被写反（线上实测）：环境（地面/网格）要按「实际生效的背景」选浅色/
    //    深色调色板，而背景只在 `applyView` 里确定。先重建环境 ⇒ 环境永远拿到主题默认的
    //    深色 ⇒ 用户配了浅色背景时地面仍是深灰，像贴了一层贴纸。
    this.applyView(request.view);
    this.rebuildEnvironment(root);

    // 相机位姿已定，再建锚点位置缓存（缓存依赖最终的世界矩阵）
    this.refreshAnchorPositionCache();
  }

  /** 是否允许飞行模式（不允许时给出**具体原因**，页面要能展示）。 */
  private canFly(request: SceneLoadRequest): {
    allowed: boolean;
    reason?: TwistFallbackReason;
  } {
    const bytes = request.modelBytes ?? 0;
    if (bytes > FLY_MAX_MODEL_BYTES) {
      return {
        allowed: false,
        reason: {
          key: 'page.iot.twin.flyFallbackModelTooLarge',
          params: {
            limitMb: Math.round(FLY_MAX_MODEL_BYTES / 1024 / 1024),
            modelMb: Math.round(bytes / 1024 / 1024),
          },
        },
      };
    }
    const deviceMemory = (
      globalThis.navigator as unknown as { deviceMemory?: number }
    ).deviceMemory;
    if (
      typeof deviceMemory === 'number' &&
      deviceMemory <= FLY_MIN_DEVICE_MEMORY_GB
    ) {
      return {
        allowed: false,
        reason: {
          key: 'page.iot.twin.flyFallbackLowMemory',
          params: { deviceMemory },
        },
      };
    }
    if (request.ancestry.length <= 1) {
      return {
        allowed: false,
        reason: { key: 'page.iot.twin.flyFallbackNoAnchor' },
      };
    }
    return { allowed: true };
  }

  /** 开发期内存自检：切换多次后几何体数量应回到基线附近。 */
  private checkMemory(): void {
    if (!this.renderer) {
      return;
    }
    const { geometries } = this.renderer.info.memory;
    if (this.switchCount === 1) {
      this.baselineGeometries = geometries;
      return;
    }
    if (geometries > this.baselineGeometries + MEMORY_LEAK_GEOMETRY_THRESHOLD) {
      console.warn(
        `[iot/twin] 疑似显存泄漏：切换 ${this.switchCount} 次后 geometries=${geometries}，` +
          `基线=${this.baselineGeometries}。请检查 dispose 是否覆盖了全部 geometry/material/texture`,
      );
    }
  }

  /** 清理当前模型（async：先让出一帧再加载新模型，避免显存瞬时翻倍）。 */
  private async clearCurrentModel(): Promise<void> {
    this.clearCurrentModelSync();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  }

  private clearCurrentModelSync(): void {
    this.anchorLayer?.detach();
    // 高亮必须解除：它改的是**材质**（emissive/color）与**节点缩放**，
    // 不恢复就会跟着共享材质带到下一个场景（表现为「新场景一进来就是被选中的样子」）
    this.deviceFocus?.clear();
    // 选中/悬停属于「当前场景的 UI 状态」：换场景必须清空（旧点位 ID 不属于新场景）
    this.selectedPointId = undefined;
    this.hoveredPointId = undefined;
    this.anchorDescriptors.clear();
    this.disposeDropPreview();
    // 动画必须先停：mixer 内部持有对模型节点的引用与 track 绑定缓存，
    // 先 dispose 模型会留下悬空引用（切场景后内存不降）
    this.animator?.dispose();
    this.animator = undefined;
    disposeEnvironment(this.environment as never);
    this.environment = undefined;
    // 外壳节点缓存指向即将 dispose 的模型：必须清掉（否则下次 setShellVisible 会摸到
    // 已释放的对象）
    this.shellNodes = undefined;
    // HUD 概况同步归零：模型已不在，残留数字会让 HUD 显示上一个场景的动画数
    this.animationCount = 0;
    this.modelBytes = 0;
    if (this.modelRoot) {
      // 先回收模型根的 GPU 资源，再从最深那级 pivot 上摘下来
      disposeSubtree(this.modelRoot);
      this.modelRoot.removeFromParent();
      this.modelRoot = undefined;
    }
    // 逐级回卷移除 pivot（从最深开始）：只摘模型根会把 pivot 链留在场景图里，
    // 反复切换后场景图无限增长，表现为「模型越切越远」。
    for (let index = this.ancestryPivots.length - 1; index >= 0; index--) {
      this.ancestryPivots[index]?.removeFromParent();
    }
    this.ancestryPivots = [];
  }

  /** 销毁拖放预览对象（切场景/销毁时调用）。 */
  private disposeDropPreview(): void {
    const preview = this.dropPreview;
    if (!preview) {
      return;
    }
    const mesh = preview as THREE_NS.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material as THREE_NS.Material | THREE_NS.Material[];
    if (Array.isArray(material)) {
      for (const item of material) {
        item.dispose();
      }
    } else {
      material?.dispose();
    }
    preview.removeFromParent();
    this.dropPreview = undefined;
  }

  /** 创建拖放落点预览（贴地细圆环，低透明度、不参与拾取）。 */
  private ensureDropPreview(): void {
    const THREE = this.THREE;
    if (!THREE || !this.scene || this.dropPreview) {
      return;
    }
    const geometry = new THREE.RingGeometry(0.9, 1, 48, 1);
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(TWIN_COLOR_SCAN_RING),
      depthWrite: false,
      opacity: 0.55,
      side: THREE.DoubleSide,
      transparent: true,
    });
    const ring = new THREE.Mesh(geometry, material);
    ring.name = '__twin_drop_preview__';
    // 标记不参与拾取：`userData.isTwinAnchor` 会被聚焦/拾取逻辑跳过
    ring.userData.isTwinAnchor = true;
    ring.renderOrder = 3;
    this.dropPreview = ring;
    this.scene.add(ring);
  }

  /** 淡入遮罩。 */
  private async fadeIn(): Promise<void> {
    if (!this.fadeOverlay) {
      return;
    }
    this.fadeOverlay.style.opacity = '0';
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 190);
    });
  }

  /** 淡出遮罩。 */
  private async fadeOut(): Promise<void> {
    if (!this.fadeOverlay) {
      return;
    }
    this.fadeOverlay.style.opacity = '1';
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 190);
    });
  }

  /**
   * 只对**已经是 emissive** 的材质做轻微增强（让 Bloom 能捡到）。
   *
   * 判定口径必须严格：`material.emissive` 颜色非黑，才认为是「自发光件」。
   * 不按材质名/尺寸去猜「哪个是机柜灯」——猜错就会让建筑大面积发光（画面泛白，
   * 这正是 Bloom 被滥用时最典型的「demo 感」）。
   *
   * @param modelRoot 模型根
   */
  private highlightEmissiveParts(modelRoot: THREE_NS.Object3D): void {
    modelRoot.traverse((object) => {
      const mesh = object as THREE_NS.Mesh & {
        isMesh?: boolean;
        material?: THREE_NS.Material | THREE_NS.Material[];
      };
      if (!mesh.isMesh || !mesh.material) {
        return;
      }
      const materials = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const material of materials) {
        const standard = material as THREE_NS.MeshStandardMaterial;
        if (!standard.emissive || !standard.emissiveIntensity) {
          continue;
        }
        const { r, g, b } = standard.emissive;
        if (r + g + b <= 0.01) {
          continue;
        }
        // 自发光件提亮 1.4 倍：越过 Bloom 阈值但不刺眼（暖金指示灯的观感）
        const target = 1.4;
        standard.emissiveIntensity = Math.max(
          standard.emissiveIntensity,
          target,
        );
        standard.needsUpdate = true;
      }
    });
  }

  /** 加载模型（把解析异常包成可区分阶段的错误）。 */
  private async loadModelOrThrow(
    request: SceneLoadRequest,
  ): Promise<LoadedModel> {
    const options: LoadModelOptions = {
      basePath: request.basePath,
      getAccessToken: this.getAccessToken,
      url: request.modelUrl,
    };
    try {
      const loaded = await loadModel(options);
      // KTX2 需要 renderer 才能探测纹理支持；装配失败不影响未用 KTX2 的模型
      if (this.renderer) {
        const { GLTFLoader } =
          await import('three/addons/loaders/GLTFLoader.js');
        const probe = new GLTFLoader();
        await attachKtx2(probe, this.renderer);
      }
      return loaded;
    } catch (error) {
      throw new ModelParseError(
        error instanceof Error ? error.message : String(error),
        error,
      );
    }
  }

  /**
   * 把预览标记放到落点（贴在模型包围盒底面附近）。
   *
   * @param local 场景局部坐标
   */
  private positionDropPreview(local: {
    x: number;
    y: number;
    z: number;
  }): void {
    const THREE = this.THREE;
    const root = this.modelRoot;
    const preview = this.dropPreview;
    if (!THREE || !root || !preview) {
      return;
    }
    // 局部坐标 → 世界坐标（与锚点同一套换算：模型根的世界矩阵）
    const world = new THREE.Vector3(local.x, local.y, local.z).applyMatrix4(
      root.matrixWorld,
    );
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z);
    const scale =
      (Number.isFinite(maxDimension) && maxDimension > 0 ? maxDimension : 100) *
      0.03;
    preview.position.set(world.x, world.y + scale * 0.01, world.z);
    preview.scale.setScalar(Math.max(0.001, scale));
    preview.rotation.x = -Math.PI / 2;
    preview.visible = true;
  }

  /**
   * 按模型包围盒重建场景环境（地面/网格/扫描光圈）。
   *
   * @param modelRoot 模型根
   */
  private rebuildEnvironment(modelRoot: THREE_NS.Object3D): void {
    const THREE = this.THREE;
    if (!THREE || !this.scene) {
      return;
    }
    disposeEnvironment(this.environment as never);
    this.environment = undefined;
    const box = new THREE.Box3().setFromObject(modelRoot);
    this.driftSeconds = 0;
    try {
      // 用**实际生效**的背景判定深浅：场景配置了浅色背景（`viewJson.background`）时
      // 地面/网格必须跟着换成浅色调色板，否则「浅底 + 深地面」会像贴纸。
      this.environment = buildEnvironment(THREE, {
        background: this.effectiveBackground,
        box,
        createScanRings: motionSwitches(this.motionMode).scanRing,
      });
      this.scene.add(this.environment.ground.parent ?? this.environment.ground);
    } catch (error) {
      console.warn('[iot/twin] 场景环境（地面/网格）构建失败：', error);
    }
  }

  /**
   * 重算锚点世界坐标缓存（模型挂载、锚点刷新、相机无关时调用）。
   *
   * 锚点对象以 `userData.pointId` 标记（`anchor-layer` 与 `picker` 共用同一口径），
   * 遍历模型根即可，不依赖锚点层的内部结构。
   */
  private refreshAnchorPositionCache(): void {
    this.anchorPositionCache.clear();
    const root = this.modelRoot;
    if (!root) {
      return;
    }
    const vector = this.THREE ? new this.THREE.Vector3() : undefined;
    root.updateWorldMatrix(true, true);
    root.traverse((object) => {
      const { pointId } = object.userData as { pointId?: unknown };
      if (typeof pointId !== 'string' || !vector) {
        return;
      }
      // 同一锚点有 sprite 与 CSS2DObject 两个对象，位置相同；先到者胜
      if (this.anchorPositionCache.has(pointId)) {
        return;
      }
      object.getWorldPosition(vector);
      this.anchorPositionCache.set(pointId, {
        x: vector.x,
        y: vector.y,
        z: vector.z,
      });
    });
  }

  /**
   * 按当前「选中 ∪ 悬停」刷新高亮（**选中优先**：两者都在时用选中样式）。
   *
   * 高亮的节点来源（按优先级）：
   * 1. 点位的 `nodeName` → 模型里同名节点（精确/宽松匹配）；
   * 2. 无 nodeName 或匹配不到 → 「锚点位置半径内最近的 mesh」（兜底，保证有反馈）。
   */
  private refreshFocus(): void {
    const THREE = this.THREE;
    const root = this.modelRoot;
    if (!THREE || !root) {
      return;
    }
    if (!this.deviceFocus) {
      this.deviceFocus = createDeviceFocus(THREE);
    }
    // **选中优先且独占**：已有选中时，悬停别的设备不改变高亮。
    //
    // 为什么不让悬停抢占：用户点选了 A（正在看 A 的详情卡片），鼠标扫过 B 时如果高亮
    // 跳到 B，画面与卡片内容就不一致了（卡片还显示 A）。悬停只在**没有选中**时生效。
    const pointId = this.selectedPointId ?? this.hoveredPointId;
    if (!pointId) {
      this.deviceFocus.clear();
      return;
    }
    const nodes = this.resolveFocusNodes(pointId, root);
    if (nodes.length === 0) {
      this.deviceFocus.clear();
      return;
    }
    this.deviceFocus.focus(nodes, this.selectedPointId ? 'selected' : 'hover', [
      root,
    ]);
  }

  /** 同步清理当前模型与其 GPU 资源。 */
  /**
   * 记住点位描述（ID → 描述），供「点位 → 模型节点」匹配与兜底拾取使用。
   *
   * @param anchors 点位描述
   */
  private rememberAnchorDescriptors(anchors: AnchorDescriptor[]): void {
    this.anchorDescriptors.clear();
    for (const anchor of anchors) {
      this.anchorDescriptors.set(anchor.pointId, anchor);
    }
  }

  private resize(): void {
    if (!this.renderer || !this.camera) {
      return;
    }
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (width === 0 || height === 0) {
      return;
    }
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    // composer 的读写缓冲与各 pass（bloom 的降采样链、FXAA 的 resolution uniform）
    // 都必须跟着改尺寸，否则窗口缩放后画面被拉伸/模糊
    this.postComposer?.setSize(width, height);
    this.anchorLayer?.resize(width, height);
  }

  /**
   * 解析某个点位要高亮的模型节点。
   *
   * @param pointId 点位 ID
   * @param root 模型根
   * @returns 要高亮的节点（可能多个；空数组表示怎么也找不到）
   */
  private resolveFocusNodes(
    pointId: string,
    root: THREE_NS.Object3D,
  ): THREE_NS.Object3D[] {
    const descriptor = this.anchorDescriptors.get(pointId);
    if (!descriptor) {
      return [];
    }
    // 1) 按 nodeName 找（主路径）
    const byName = pickHighlightNodes(
      findNodesByPointName(root, descriptor.nodeName),
    );
    if (byName.length > 0) {
      return byName;
    }
    // 2) 兜底：锚点位置附近半径内最近的 mesh
    const anchor = this.anchorPositionCache.get(pointId);
    const THREE = this.THREE;
    if (!anchor || !THREE) {
      return [];
    }
    const center = new THREE.Vector3(anchor.x, anchor.y, anchor.z);
    // 半径取模型尺度的 8%：既能罩住「点位在设备表面」的情形，又不会扫到隔壁设备
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const maxDimension = Math.max(size.x, size.y, size.z);
    const radius =
      (Number.isFinite(maxDimension) && maxDimension > 0 ? maxDimension : 100) *
      0.08;
    let nearest: undefined | { distance: number; object: THREE_NS.Object3D };
    root.traverse((object) => {
      const mesh = object as THREE_NS.Mesh & { isMesh?: boolean };
      if (!mesh.isMesh || !mesh.geometry) {
        return;
      }
      const { isTwinAnchor } = object.userData as { isTwinAnchor?: boolean };
      if (isTwinAnchor === true) {
        return;
      }
      if (!mesh.geometry.boundingSphere) {
        mesh.geometry.computeBoundingSphere();
      }
      const sphereCenter = new THREE.Vector3()
        .copy(mesh.geometry.boundingSphere?.center ?? new THREE.Vector3())
        .applyMatrix4(object.matrixWorld);
      const distance = sphereCenter.distanceTo(center);
      if (distance > radius) {
        return;
      }
      if (!nearest || distance < nearest.distance) {
        nearest = { distance, object };
      }
    });
    return nearest ? [nearest.object] : [];
  }

  private setState(state: TwinSceneState, error?: TwinSceneError): void {
    this.state = state;
    this.onStateChange(state, error);
  }

  /**
   * 建立后处理链：RenderPass → UnrealBloomPass → OutputPass → FXAAPass。
   *
   * ## 顺序为什么必须是这样
   *
   * - `OutputPass` 负责**色调映射与 sRGB 转换**（它从 renderer 读配置）；
   * - 因此 Bloom 必须在 OutputPass **之前**：在 HDR 线性空间里做 bloom，阈值才有物理意义
   *   （阈值 0.9 在 ACES 之前意味着「比 0.9 亮的东西」，而不是「显示亮度的 90%」）；
   * - FXAA 必须在 OutputPass **之后**：FXAA 需要 sRGB 输入（官方文档明确要求），
   *   放在前面会把线性值当 sRGB 做亮度感知的边缘检测，边缘判断全错。
   *
   * ## 为什么不开 MSAA
   *
   * composer 的渲染目标是普通 RT，`antialias: true` 对它无效；要靠 `FXAAPass`。
   * 因此构造 renderer 时在开后处理的情况下**关掉** MSAA（省带宽）。
   *
   * @param THREE three 命名空间
   */
  private async setupPostProcessing(THREE: typeof THREE_NS): Promise<void> {
    if (
      !this.postOptions.enabled ||
      !this.renderer ||
      !this.scene ||
      !this.camera
    ) {
      return;
    }
    try {
      const [
        { EffectComposer },
        { RenderPass },
        { UnrealBloomPass },
        { OutputPass },
        { FXAAPass },
      ] = await Promise.all([
        import('three/addons/postprocessing/EffectComposer.js'),
        import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js'),
        import('three/addons/postprocessing/OutputPass.js'),
        import('three/addons/postprocessing/FXAAPass.js'),
      ]);
      const width = this.container.clientWidth || 1;
      const height = this.container.clientHeight || 1;
      const composer = new EffectComposer(this.renderer);
      composer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
      composer.setSize(width, height);
      composer.addPass(new RenderPass(this.scene, this.camera));
      const bloom = new UnrealBloomPass(
        new THREE.Vector2(width, height),
        this.postOptions.bloomStrength,
        this.postOptions.bloomRadius,
        this.postOptions.bloomThreshold,
      );
      composer.addPass(bloom);
      composer.addPass(new OutputPass());
      if (this.postOptions.fxaa) {
        composer.addPass(new FXAAPass());
      }
      this.postComposer = {
        dispose: () => {
          // 逐个 pass dispose：composer.dispose 只释放读写缓冲，**不释放 pass 自己的
          // 渲染目标与材质**（这是 three 的已知行为）。漏掉就会在反复挂载页面时累积。
          for (const pass of composer.passes) {
            (pass as { dispose?: () => void }).dispose?.();
          }
          composer.dispose();
        },
        render: (deltaSeconds?: number) => {
          composer.render(deltaSeconds);
        },
        setPixelRatio: (ratio: number) => {
          composer.setPixelRatio(ratio);
        },
        setSize: (nextWidth: number, nextHeight: number) => {
          composer.setSize(nextWidth, nextHeight);
        },
      };
    } catch (error) {
      // 后处理是增强项：装配失败就退回直接渲染（画面稍平，但功能完整）
      console.warn(
        '[iot/twin] 后处理（Bloom/FXAA）装配失败，已退回直接渲染：',
        error,
      );
      this.postComposer = undefined;
    }
  }

  /**
   * 渲染循环（**唯一一个 rAF**）。
   *
   * 顺序：先推进动效（动画/灯光/巡航）→ 再渲染 3D（composer 或直渲）→ 最后画 CSS2D。
   * CSS2D 必须在最后：它读取相机的最终状态做投影，放在前面会慢一帧（拖拽时标签明显滞后）。
   */
  private startRenderLoop(): void {
    let previousTime: number | undefined;
    const tick = () => {
      if (this.disposed) {
        return;
      }
      this.animationFrameId = requestAnimationFrame(tick);
      const now = performance.now();
      // 帧间隔限幅 0.1s：切 tab 回来时 delta 可能是几秒，直接推进会让动画「瞬移」
      const deltaSeconds = Math.min(
        0.1,
        previousTime === undefined
          ? 1 / 60
          : Math.max(0, (now - previousTime) / 1000),
      );
      previousTime = now;

      this.tickMotion(deltaSeconds);
      this.controls?.update();
      if (this.renderer && this.scene && this.camera) {
        if (this.postComposer) {
          // OutputPass 负责色调映射与 sRGB 转换（renderer 上那两项目标照旧设置，
          // 但**不**在 renderer.render 阶段生效——composer 渲染到 RT 时 disable toneMapping）
          this.postComposer.render(deltaSeconds);
        } else {
          this.renderer.render(this.scene, this.camera);
        }
        // CSS2D 标签在同一个帧里绘制，保证与 3D 内容不错位
        this.anchorLayer?.render(this.scene, this.camera);
      }
    };
    this.animationFrameId = requestAnimationFrame(tick);
  }

  /**
   * 每帧推进全部动效（GLB 动画 / 环境缓变 / 扫描光圈 / 相机巡航）。
   *
   * 所有动效都查 `motionSwitches(this.motionMode)`，**不在别处判断档位**。
   *
   * @param deltaSeconds 帧间隔（秒，已限幅）
   */
  private tickMotion(deltaSeconds: number): void {
    const switches = motionSwitches(this.motionMode);
    this.driftSeconds += deltaSeconds;
    // 说明：hover 期间暂停数据驱动脉冲由锚点层自己按 `hovered` 处理（见 anchor-layer
    // 的 `tickMotion`），这里不重复干预 —— 档位判定必须保持单一真相。
    // 1) GLB 自带动画（off 档 clipSpeed=0 ⇒ animator 内部直接 return，不推进 mixer）
    this.animator?.update(deltaSeconds);
    // 2) 环境光极缓慢缓变（±6%，周期 60s：肉眼几乎察觉不到，但画面「活」）
    if (switches.ambientDrift && this.hemiLight && this.sunLight) {
      const phase =
        (Math.sin(
          (this.driftSeconds * 1000 * Math.PI * 2) / AMBIENT_DRIFT_PERIOD_MS,
        ) +
          1) /
        2;
      const factor = 1 + (phase - 0.5) * 2 * AMBIENT_DRIFT_AMPLITUDE;
      this.hemiLight.intensity = this.hemiBaseIntensity * factor;
      this.sunLight.intensity = this.sunBaseIntensity * factor;
    }
    // 3) 扫描光圈（贴着地面、低透明度）
    if (switches.scanRing && this.environment) {
      this.environment.updateScanRings(this.driftSeconds, 1);
    }
    // 4) 相机自动巡航
    this.orbit?.update(deltaSeconds);
  }

  /**
   * 监听「减少动态效果」偏好的运行时变化。
   *
   * 用户中途在系统设置里开启/关闭该选项时必须立刻生效（不必刷新页面），
   * 且 `dispose()` 必须移除监听（`addEventListener` 持有回调 ⇒ 引用泄漏）。
   */
  private watchMotionPreference(): void {
    const scope = globalThis as {
      matchMedia?: typeof globalThis.matchMedia;
    };
    if (typeof scope.matchMedia !== 'function') {
      return;
    }
    const query = scope.matchMedia(reducedMotionMediaQuery());
    const onChange = (): void => {
      this.applyMotionMode(resolveMotionMode(readMotionProfileInput()));
    };
    // 兼容旧 Safari：只有 addListener/removeListener
    const legacy = query as unknown as {
      addEventListener?: (type: 'change', listener: () => void) => void;
      addListener?: (listener: () => void) => void;
      removeEventListener?: (type: 'change', listener: () => void) => void;
      removeListener?: (listener: () => void) => void;
    };
    if (typeof legacy.addEventListener === 'function') {
      legacy.addEventListener('change', onChange);
      this.motionMediaCleanup = () => {
        legacy.removeEventListener?.('change', onChange);
      };
    } else if (typeof legacy.addListener === 'function') {
      legacy.addListener(onChange);
      this.motionMediaCleanup = () => {
        legacy.removeListener?.(onChange);
      };
    }
  }
}
