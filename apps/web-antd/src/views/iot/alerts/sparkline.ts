import type { IotSeriesApi } from '#/api/iot';

/**
 * 告警展开行里的「该点位近期曲线**缩略**」的纯计算（用户口径 ③ 的可展开内容之一）。
 *
 * 为什么自己画一条 SVG 折线而不是复用 echarts：
 * 1. 缩略图要在一张列表的**每一行**里出现，echarts 每行一个实例的开销与复杂度都不成比例；
 * 2. 数据源与「历史曲线」页签**完全一致**（`GET /iot/devices/{id}/series`），点「查看完整曲线」就是同一份数据
 *    ——不新造查询、不新造口径；
 * 3. 换算（时间→x、值→y、阈值线位置）是纯函数，能被用例钉住（下面是 `sparkline.test.ts`）。
 */
export interface SparklineInput {
  points: IotSeriesApi.TimeSeriesPointResp[];
  /** 阈值（触发时的快照数值；可空 = 不画阈值线）。 */
  threshold?: number;
  width?: number;
  height?: number;
}

export interface SparklineResult {
  /** SVG `d` 属性（`M x,y L x,y …`）；点数不足时为空串（页面据此显示「数据不足」）。 */
  path: string;
  /** 阈值线的 y 坐标（不在值域内或没有阈值时为 null）。 */
  thresholdY: number | null;
  /** 纵轴范围（用于在图旁标最小/最大值）。 */
  min: number;
  max: number;
  /** 实际参与绘制的点数（坏质量/非数值已被丢弃）。 */
  plotted: number;
  /** 是否丢掉了非数值点（页面据此提示「已跳过 N 个非数值点」）。 */
  skipped: number;
}

const DEFAULT_WIDTH = 220;

const DEFAULT_HEIGHT = 48;

/** 质量位是否可用于绘图（与后端判定口径一致：非 GOOD 不参与）。 */
function isGood(quality: null | string | undefined): boolean {
  return typeof quality === 'string' && quality.toUpperCase() === 'GOOD';
}

/**
 * 把时序点换算成缩略折线。
 *
 * 口径（与后端「不可判定」语义一致，**不美化**）：
 * 1. 非 GOOD 质量与非数值点**丢弃**并计数（不当作 0，也不插值）；
 * 2. 时间轴按**实际 ts** 线性映射（不是等距索引——等距会造出假的时间关系）；
 * 3. 值域取 [min, max]，上下各留 4px 边距；全部值相同时给一条居中的水平线（不产生除零）。
 */
export function buildSparkline(input: SparklineInput): SparklineResult {
  const width = input.width ?? DEFAULT_WIDTH;
  const height = input.height ?? DEFAULT_HEIGHT;
  const usable: { ts: number; value: number }[] = [];
  let skipped = 0;
  for (const point of input.points ?? []) {
    const value = Number(point.value);
    const ts = Number(point.ts);
    if (!isGood(point.quality) || !Number.isFinite(value) || !Number.isFinite(ts)) {
      skipped += 1;
      continue;
    }
    usable.push({ ts, value });
  }
  if (usable.length < 2) {
    return {
      path: '',
      thresholdY: null,
      min: 0,
      max: 0,
      plotted: usable.length,
      skipped,
    };
  }
  let min = usable[0]!.value;
  let max = usable[0]!.value;
  for (const item of usable) {
    min = Math.min(min, item.value);
    max = Math.max(max, item.value);
  }
  const threshold = Number.isFinite(input.threshold ?? Number.NaN)
    ? Number(input.threshold)
    : null;
  const lower = Math.min(min, threshold ?? min);
  const upper = Math.max(max, threshold ?? max);
  const span = upper - lower;
  const pad = 4;
  const plotHeight = Math.max(1, height - pad * 2);
  const yOf = (value: number) =>
    span === 0
      ? height / 2
      : pad + ((upper - value) / span) * plotHeight;
  const firstTs = usable[0]!.ts;
  const lastTs = usable[usable.length - 1]!.ts;
  const tsSpan = lastTs - firstTs;
  const xOf = (ts: number) =>
    tsSpan === 0 ? 0 : ((ts - firstTs) / tsSpan) * width;
  const path = usable
    .map((item, index) => `${index === 0 ? 'M' : 'L'}${xOf(item.ts).toFixed(1)},${yOf(item.value).toFixed(1)}`)
    .join(' ');
  return {
    path,
    thresholdY: threshold === null ? null : Number(yOf(threshold).toFixed(1)),
    min,
    max,
    plotted: usable.length,
    skipped,
  };
}

/**
 * 从阈值快照文本里抽出数值（快照形如 `> 80`、`<= 10（回差 0.5）`）。
 *
 * 抽不出来就返回 `null`（不画阈值线）——**不猜**：把「> 80」解析成 80 是安全的，
 * 把任意文本硬解析成数字则会让缩略图出现一条不存在的阈值线。
 */
export function parseThresholdSnapshot(snapshot?: string): number | null {
  if (!snapshot) {
    return null;
  }
  const match = /(-?\d+(?:\.\d+)?)/.exec(snapshot);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}
