import type * as THREE_NS from 'three';

import {
  TWIN_COLOR_GRID_LINE,
  TWIN_COLOR_GRID_LINE_MINOR,
  TWIN_COLOR_GROUND,
  TWIN_COLOR_SCAN_LINE,
  TWIN_COLOR_SCAN_RING,
} from './colors';

/**
 * 场景环境（**「有质感」的主要来源之一**）：环境贴图 + 程序化地面 + 网格 + 扫描光圈。
 *
 * ## 为什么需要环境贴图
 *
 * 没有 `scene.environment` 时，`MeshStandardMaterial` 的金属度（metalness）几乎看不出效果：
 * 金属的观感**全部来自反射**，没有环境可反射就只剩一个灰块（这正是「像 demo」的典型表现）。
 *
 * 用 `RoomEnvironment`（three 自带）经 `PMREMGenerator` 预滤波成环境贴图：
 * 一次生成、全程复用，运行期零成本。**不需要加载 HDR 文件**（省一个网络请求与数 MB 体积，
 * 也不引入新依赖）。
 *
 * ⚠️ 生命周期：`RoomEnvironment` 是一次性输入，生成后必须 `dispose()`（它内部有几何体与
 * 灯光）；`PMREMGenerator` 用完也要 `dispose()`。**只有生成的贴图要长期保留**，
 * 并在管理器 dispose 时释放。
 *
 * ## 为什么地面是程序化生成的
 *
 * 模型里通常**没有地面**（厂房模型只有构件），于是建筑像「悬在虚空里」。补一块程序化地面：
 * - 接受阴影 ⇒ 模型有「落在地上」的重量感；
 * - 细网格线 ⇒ 提供尺度参照（工业风）；
 * - 斜向扫描线纹理（透明度 <5%）⇒ 参考图里那种「科技感氛围」，但不抢主体。
 *
 * 纹理用 canvas 现画（512×512），`colorSpace = SRGBColorSpace`（颜色贴图必须标 sRGB，
 * 否则在 sRGB 输出管线里会被当成线性值，颜色偏亮发白）。
 */

/** 地面纹理的画布边长（像素，正方形）。 */
const GROUND_TEXTURE_SIZE = 512;

/** 扫描线纹理里线条的间隔（像素）。 */
const SCAN_LINE_SPACING_PX = 16;

/** 扫描线纹理里线条的宽度（像素）。 */
const SCAN_LINE_WIDTH_PX = 2;

/** 网格主线的世界单位间距（相对模型尺寸的比例，在 `buildEnvironment` 里换算）。 */
const GRID_MAJOR_RATIO = 0.1;

/** 网格次线相对主线的间距比例。 */
const GRID_MINOR_RATIO = 0.2;

/** 扫描光圈基础半径（相对模型尺寸）。 */
const SCAN_RING_RADIUS_RATIO = 0.9;

/** 扫描光圈在场景里同时存在的层数（多层错开相位 ⇒ 有「扫描推进」的层次）。 */
export const SCAN_RING_LAYERS = 2;

/** 扫描光圈的一圈耗时（毫秒，极慢：这是「氛围」不是「特效」）。 */
export const SCAN_RING_PERIOD_MS = 9000;

/** 环境对象（由 scene-manager 持有并负责释放）。 */
export interface TwinEnvironment {
  /** 环境贴图（赋给 `scene.environment`）。 */
  environmentTexture: THREE_NS.Texture;
  /** 地面（含网格与扫描纹理）。 */
  ground: THREE_NS.Object3D;
  /** 扫描光圈对象（是否可见/动画由 manager 控制）。 */
  scanRings: THREE_NS.Object3D[];
  /**
   * 更新扫描光圈动画（**只更新时间变量，不做几何重建**）。
   *
   * @param elapsedSeconds 自场景挂载以来的秒数
   * @param intensity 0~1 的总强度（降级档直接不给调用即可）
   */
  updateScanRings: (elapsedSeconds: number, intensity: number) => void;
  /** 释放全部 GPU 资源（贴图/几何/材质）并把对象从场景移除。 */
  dispose: () => void;
}

/** `buildEnvironment` 的选项。 */
export interface BuildEnvironmentOptions {
  /** 模型包围盒（决定地面大小、网格间距、阴影相机范围）。 */
  box: THREE_NS.Box3;
  /** 是否创建扫描光圈（`motionSwitches(mode).scanRing`；reduced/off 时传 false）。 */
  createScanRings: boolean;
}

/**
 * 生成环境贴图（PMREM + RoomEnvironment）。
 *
 * 只应在**初始化时调用一次**（切场景不重建：生成成本约 10~40ms，且内容与场景无关）。
 *
 * @param renderer 渲染器（PMREM 需要它编译着色器）
 * @param roomEnvironment RoomEnvironment 构造器（由调用方动态 import 注入）
 * @param PMREMGenerator PMREMGenerator 构造器（由调用方动态 import 注入）
 * @returns 预滤波后的环境贴图
 */
export function buildEnvironmentTexture(
  renderer: THREE_NS.WebGLRenderer,
  PMREMGenerator: new (renderer: THREE_NS.WebGLRenderer) => {
    dispose: () => void;
    fromScene: (
      scene: THREE_NS.Scene,
      sigma?: number,
      near?: number,
      far?: number,
    ) => { texture: THREE_NS.Texture };
  },
  roomEnvironmentFactory: () => THREE_NS.Scene & { dispose?: () => void },
): THREE_NS.Texture {
  const pmrem = new PMREMGenerator(renderer);
  // 一次性输入：生成后立刻释放（内部有几何/材质/灯光）
  const room = roomEnvironmentFactory();
  let target: undefined | { texture: THREE_NS.Texture };
  try {
    // sigma = 0.04：轻微模糊，让反射不至于把房间里的方块形状反射得太清楚
    target = pmrem.fromScene(room, 0.04);
  } finally {
    (room as unknown as { dispose?: () => void }).dispose?.();
    pmrem.dispose();
  }
  if (!target) {
    throw new Error('环境贴图生成失败：PMREMGenerator.fromScene 未返回目标');
  }
  return target.texture;
}

/**
 * 构建场景环境（地面 + 网格 + 可选扫描光圈）。
 *
 * @param THREE three 命名空间
 * @param options 构建选项
 * @returns 环境对象
 */
export function buildEnvironment(
  THREE: typeof THREE_NS,
  options: BuildEnvironmentOptions,
): Omit<TwinEnvironment, 'environmentTexture'> {
  const size = options.box.getSize(new THREE.Vector3());
  const center = options.box.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);
  const safeDimension =
    Number.isFinite(maxDimension) && maxDimension > 0 ? maxDimension : 100;

  // 地面覆盖模型水平投影的 4 倍：留出「地平线」的余地，且足够大以至于看不到边界
  const groundSize = Math.max(size.x, size.z, safeDimension * 0.5) * 4;
  const groundY = Number.isFinite(options.box.min.y)
    ? options.box.min.y
    : center.y - safeDimension / 2;

  const groundTexture = createGroundTexture(THREE);
  // 贴图在水平面重复：每 1/4 地面尺寸重复一次，保证细碎纹理在不同尺度模型上都清晰
  groundTexture.wrapS = THREE.RepeatWrapping;
  groundTexture.wrapT = THREE.RepeatWrapping;
  const repeats = 4;
  groundTexture.repeat.set(repeats, repeats);

  const groundMaterial = new THREE.MeshStandardMaterial({
    color: new THREE.Color(TWIN_COLOR_GROUND),
    // 粗糙度高（混凝土），金属度极低：地面不该有镜面反射（真实感来自阴影与漫反射）
    metalness: 0.05,
    roughness: 0.92,
    // 透明地面 + 轻微体积感：让扫描线纹理透出来（贴图本身带 alpha）
    map: groundTexture,
    transparent: true,
  });

  const groundGeometry = new THREE.PlaneGeometry(groundSize, groundSize);
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  ground.name = '__twin_ground__';
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(center.x, groundY, center.z);
  ground.receiveShadow = true;
  // 用户不需要点地面（拾取只针对模型表面），但射线仍会命中它 ——
  // 由 picker 的 `getModelRoot()` 限定在模型根上，地面不在其中，所以不会有副作用。

  const group = new THREE.Group();
  group.name = '__twin_environment__';
  group.add(ground);

  const grid = createGrid(THREE, safeDimension, groundSize);
  grid.position.set(center.x, groundY + safeDimension * 0.0005, center.z);
  group.add(grid);

  const scanRings: THREE_NS.Object3D[] = [];
  const scanRingMeshes: Array<{
    material: THREE_NS.MeshBasicMaterial;
    phase: number;
  }> = [];
  if (options.createScanRings) {
    const radius = safeDimension * SCAN_RING_RADIUS_RATIO;
    for (let index = 0; index < SCAN_RING_LAYERS; index++) {
      const material = new THREE.MeshBasicMaterial({
        color: new THREE.Color(TWIN_COLOR_SCAN_RING),
        depthWrite: false,
        opacity: 0,
        side: THREE.DoubleSide,
        transparent: true,
      });
      // 圆环做成极细的环形平面（RingGeometry），贴地
      const geometry = new THREE.RingGeometry(radius * 0.98, radius, 96, 1);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(center.x, groundY + safeDimension * 0.001, center.z);
      mesh.renderOrder = 2;
      mesh.name = `__twin_scan_ring_${index}__`;
      group.add(mesh);
      scanRings.push(mesh);
      scanRingMeshes.push({ material, phase: index / SCAN_RING_LAYERS });
    }
  }

  const disposed = { value: false };
  const environment: Omit<TwinEnvironment, 'environmentTexture'> = {
    dispose: () => {
      if (disposed.value) {
        return;
      }
      disposed.value = true;
      groundGeometry.dispose();
      groundMaterial.dispose();
      groundTexture.dispose();
      for (const child of group.children) {
        child.removeFromParent();
      }
      group.clear();
      group.removeFromParent();
    },
    ground,
    scanRings,
    updateScanRings: (elapsedSeconds, intensity) => {
      if (disposed.value) {
        return;
      }
      const clamped = Math.max(0, Math.min(1, intensity));
      for (const { material, phase } of scanRingMeshes) {
        // 相位错开的呼吸：0 → 1 → 0，永远不出现「突跳」
        const progress = (elapsedSeconds * 1000) / SCAN_RING_PERIOD_MS + phase;
        const wave = 0.5 - 0.5 * Math.cos(progress * Math.PI * 2);
        // 最大不透明度 0.12：贴着地面的「扫描光」，不能抢主体
        material.opacity = wave * 0.12 * clamped;
      }
    },
  };
  return environment;
}

/**
 * 程序化地面纹理（冷灰底 + 极淡斜向扫描线）。
 *
 * @param THREE three 命名空间
 * @returns 贴图（已标 `SRGBColorSpace`）
 */
function createGroundTexture(THREE: typeof THREE_NS): THREE_NS.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = GROUND_TEXTURE_SIZE;
  canvas.height = GROUND_TEXTURE_SIZE;
  const context = canvas.getContext('2d');
  if (context) {
    // 底色：极深的冷灰（地面本体颜色由材质 color 叠乘）
    context.fillStyle = TWIN_COLOR_GROUND;
    context.fillRect(0, 0, GROUND_TEXTURE_SIZE, GROUND_TEXTURE_SIZE);
    // 斜向扫描线：45°，线宽 2px、间距 16px、透明度约 4%（需求要求 <5%）
    context.strokeStyle = TWIN_COLOR_SCAN_LINE;
    context.globalAlpha = 0.04;
    context.lineWidth = SCAN_LINE_WIDTH_PX;
    context.beginPath();
    for (
      let offset = -GROUND_TEXTURE_SIZE;
      offset < GROUND_TEXTURE_SIZE * 2;
      offset += SCAN_LINE_SPACING_PX
    ) {
      context.moveTo(offset, 0);
      context.lineTo(offset - GROUND_TEXTURE_SIZE, GROUND_TEXTURE_SIZE);
    }
    context.stroke();
    context.globalAlpha = 1;
  }
  const texture = new THREE.CanvasTexture(canvas);
  // 颜色贴图必须标 sRGB，否则在 sRGB 输出管线里会被当成线性值 ⇒ 颜色偏亮发白
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 工业风网格：主线 + 次线（比地面纹理更粗的尺度，提供建筑尺度的参照）。
 *
 * 用 `LineSegments` 而不是 `GridHelper`：`GridHelper` 只有一种线宽与一种颜色，
 * 没法做主/次两级线（主次对比是「专业渲染」与「游戏网格」的差别）。
 *
 * @param THREE three 命名空间
 * @param modelDimension 模型最大尺寸（决定网格间距）
 * @param groundSize 地面边长
 * @returns 网格对象
 */
function createGrid(
  THREE: typeof THREE_NS,
  modelDimension: number,
  groundSize: number,
): THREE_NS.Object3D {
  const majorStep = modelDimension * GRID_MAJOR_RATIO;
  const minorStep = majorStep * GRID_MINOR_RATIO;
  const half = groundSize / 2;
  const steps = Math.min(200, Math.floor(groundSize / minorStep));

  const majorPositions: number[] = [];
  const minorPositions: number[] = [];
  for (let index = -steps; index <= steps; index++) {
    const offset = index * minorStep;
    if (Math.abs(offset) > half) {
      continue;
    }
    const isMajor = Math.abs(index % Math.round(1 / GRID_MINOR_RATIO)) === 0;
    const target = isMajor ? majorPositions : minorPositions;
    // 沿 X 的线 + 沿 Z 的线，一次 push（避免多次调用带来的数组扩容）
    target.push(
      -half,
      0,
      offset,
      half,
      0,
      offset,
      offset,
      0,
      -half,
      offset,
      0,
      half,
    );
  }

  const group = new THREE.Group();
  group.name = '__twin_grid__';
  const build = (positions: number[], color: string, opacity: number): void => {
    if (positions.length === 0) {
      return;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(positions, 3),
    );
    const material = new THREE.LineBasicMaterial({
      color: new THREE.Color(color),
      depthWrite: false,
      opacity,
      transparent: true,
    });
    const lines = new THREE.LineSegments(geometry, material);
    lines.renderOrder = 1;
    group.add(lines);
  };
  build(minorPositions, TWIN_COLOR_GRID_LINE_MINOR, 0.28);
  build(majorPositions, TWIN_COLOR_GRID_LINE, 0.45);
  // 地面是透明的：网格要在它之上绘制，但不写深度（避免地面透明排序把网格盖掉）
  return group;
}

/**
 * 释放环境里的全部资源（`twin-canvas` 卸载时由 manager 调用）。
 *
 * @param environment 环境对象
 */
export function disposeEnvironment(environment?: TwinEnvironment): void {
  environment?.dispose();
}
