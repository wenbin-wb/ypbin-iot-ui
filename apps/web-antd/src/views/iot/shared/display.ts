/**
 * IoT 前端**展示层**统一入口：枚举码 → 中文文案、后端时间 → 人话时间、
 * JSON/空值等「原始数据变可读展示」的纯函数。
 *
 * 为什么必须有这一层：
 *   ① 后端接口传的是**码**（`modbus` / `online` / `draft` / `BINARY` 等），
 *      以前散落在各页面的列定义和模板里直接 `{{ row.protocol }}`，界面上就是英文码；
 *   ② 时间字段后端返回 `yyyy-MM-dd HH:mm:ss` 或 ISO（`T` 分隔），直接把原始串贴到表格里
 *      会出现 `2026-10-14T09:30:00` 这种工程师才认的形态；
 *   ③ 写一份映射在多个页面各复制一遍，迟早出现「这页说在线、那页还显示 online」的口径漂移。
 *
 * 约定：**未知码不伪装成已知值**——返回「未知（原码）」而不是猜一个中文；空值统一显示 `-`。
 */

import dayjs from 'dayjs';

import { $t } from '#/locales';

/** 可能来自接口的展示值（Long 会以字符串返回，时间可能是毫秒串）。 */
export type DisplayValue = null | number | string | undefined;

/**
 * 空值占位规则（**iot 视图统一口径**，新增页面请遵守）。
 *
 * | 语义 | 常量 | 字形 | 典型场景 |
 * | --- | --- | --- | --- |
 * | **数据缺省**（字段 null/undefined/空串，但这一行/这张卡本身有效） | {@link EMPTY_TEXT} | `-` | 设备备注为空、属性单位未填、错误码为空 |
 * | **尚未加载 / 尚未上报 / 不适用**（数据源还没给，页面在等或该指标不适用） | {@link PENDING_TEXT} | `—` | 可用率指标 `reported=false` 时的占位数 |
 *
 * 为什么区分两个字形：
 * - `-` 是「值为空」的通用占位（也是表格/Descriptions 的多数口径），占宽小、不抢眼；
 * - `—` 更宽、更像「暂无」，专门表示「系统还没上报/还没加载」，避免用户把「后端没给」
 *   误读成「这个字段本来就是空」；只有一种混用场景时才需要区分，所以规则只允许这两种。
 *
 * 禁止事项：
 * - 不要在时间/单位/枚举映射等格式化函数内部各自造占位（调用方统一用这两个常量）；
 * - 不要把占位当「加载中」用（那是 Spin/Skeleton 的职责），更不能用占位掩盖请求失败
 *   （失败必须走可见错误态，见 `shared/list-error-alert.vue`）。
 *
 * 历史：2026-10-20 审查发现 iot 视图内 `-` / `—` 混用且大量裸写；本批按语义逐处替换，
 * 并由 `display.test.ts` 的静态断言把「裸占位数」压到阈值以下，防止回潮。
 */
export const EMPTY_TEXT = '-';

/**
 * 「尚未加载 / 尚未上报 / 不适用」占位符（全角破折号，比 {@link EMPTY_TEXT} 更宽）。
 *
 * 使用前先判断语义：**数据缺省**用 `EMPTY_TEXT`；只有「数据源还没给」才用本常量。
 * 后端 `reported=false`、页面首次加载中这类场景适用（加载中优先用 Spin/Skeleton，
 * 占位只用于「指标卡已有壳、值还没上报」这种位置）。
 */
export const PENDING_TEXT = '—';

/** 展示空值兜底：`null` / `undefined` / 空串 / 纯空白都返回 `fallback`。 */
export function displayOrFallback(
  value?: DisplayValue,
  fallback = EMPTY_TEXT,
): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  const text = String(value).trim();
  return text === '' ? fallback : text;
}

/** 枚举码归一化（trim + 小写，空值转空串）。 */
function normalizedCode(value?: DisplayValue): string {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value).trim();
}

/** 未知枚举码的展示：`未知（原码）`；真正的空值显示 `-`。 */
function unknownCode(value?: DisplayValue): string {
  const code = normalizedCode(value);
  return code === ''
    ? EMPTY_TEXT
    : $t('page.iot.display.unknownWithValue', [code]);
}

// ==================== 接入协议 ====================

/** 协议码 → 中文名称。 */
export function protocolLabel(value?: DisplayValue): string {
  switch (normalizedCode(value).toLowerCase()) {
    case 'modbus': {
      return $t('page.iot.display.protocol.modbus');
    }
    case 'mqtt': {
      return $t('page.iot.display.protocol.mqtt');
    }
    case 'opcua': {
      return $t('page.iot.display.protocol.opcua');
    }
    case 'tcp': {
      return $t('page.iot.display.protocol.tcp');
    }
    default: {
      return unknownCode(value);
    }
  }
}

/** 新增/编辑/筛选表单共用的协议下拉选项（所有页面同一份，避免各自硬编码中文）。 */
export function protocolOptions() {
  return [
    { label: protocolLabel('modbus'), value: 'modbus' },
    { label: protocolLabel('tcp'), value: 'tcp' },
    { label: protocolLabel('mqtt'), value: 'mqtt' },
    { label: protocolLabel('opcua'), value: 'opcua' },
  ];
}

// ==================== 设备在线状态 ====================

/** 在线状态码 → 文案。 */
export function onlineStatusLabel(value?: DisplayValue): string {
  switch (normalizedCode(value).toLowerCase()) {
    case 'offline': {
      return $t('page.iot.display.onlineStatus.offline');
    }
    case 'online': {
      return $t('page.iot.display.onlineStatus.online');
    }
    case 'unknown': {
      return $t('page.iot.display.onlineStatus.unknown');
    }
    default: {
      return unknownCode(value);
    }
  }
}

/** 在线状态 → Tag 颜色（与 CellTag / a-tag 的 color 取值一致）。 */
export function onlineStatusColor(value?: DisplayValue): string {
  switch (normalizedCode(value).toLowerCase()) {
    case 'offline': {
      return 'default';
    }
    case 'online': {
      return 'success';
    }
    default: {
      return 'default';
    }
  }
}

/** 在线状态下拉选项（设备列表筛选用）。 */
export function onlineStatusOptions() {
  return [
    { label: onlineStatusLabel('online'), value: 'online' },
    { label: onlineStatusLabel('offline'), value: 'offline' },
    { label: onlineStatusLabel('unknown'), value: 'unknown' },
  ];
}

// ==================== 物模型状态 ====================

/** 物模型状态码 → 文案。 */
export function modelStatusLabel(value?: DisplayValue): string {
  switch (normalizedCode(value).toLowerCase()) {
    case 'draft': {
      return $t('page.iot.display.modelStatus.draft');
    }
    case 'published': {
      return $t('page.iot.display.modelStatus.published');
    }
    default: {
      return unknownCode(value);
    }
  }
}

/** 物模型状态 → Tag 颜色。 */
export function modelStatusColor(value?: DisplayValue): string {
  switch (normalizedCode(value).toLowerCase()) {
    case 'draft': {
      return 'warning';
    }
    case 'published': {
      return 'success';
    }
    default: {
      return 'default';
    }
  }
}

/** 物模型状态下拉选项（产品列表筛选用）。 */
export function modelStatusOptions() {
  return [
    { label: modelStatusLabel('draft'), value: 'draft' },
    { label: modelStatusLabel('published'), value: 'published' },
  ];
}

// ==================== 数据格式 ====================

/** 数据格式码 → 文案（后端存储大小写不统一时按小写归一）。 */
export function dataFormatLabel(value?: DisplayValue): string {
  switch (normalizedCode(value).toLowerCase()) {
    case 'binary': {
      return $t('page.iot.display.dataFormat.binary');
    }
    case 'json': {
      return $t('page.iot.display.dataFormat.json');
    }
    default: {
      return unknownCode(value);
    }
  }
}

/** 数据格式下拉选项（产品表单用）。 */
export function dataFormatOptions() {
  return [
    { label: dataFormatLabel('json'), value: 'JSON' },
    { label: dataFormatLabel('binary'), value: 'BINARY' },
  ];
}

// ==================== 维护窗口 ====================

/** 维护窗口来源 → 文案。 */
export function maintenanceSourceLabel(value?: DisplayValue): string {
  switch (normalizedCode(value)) {
    case 'LEASE_HANDOVER': {
      return $t('page.iot.maintenance.sourceHandover');
    }
    case 'MANUAL': {
      return $t('page.iot.maintenance.sourceManual');
    }
    default: {
      return unknownCode(value);
    }
  }
}

/**
 * 维护窗口状态：未开始 / 进行中 / 已结束。
 *
 * 判定只看后端给的起止时刻 + 当前时间；`endTs` 为空表示「手动关闭前一直有效」，
 * 这正是页面文案 `ongoing` 的语义。
 */
export function maintenanceState(
  startTs?: DisplayValue,
  endTs?: DisplayValue,
): 'ended' | 'ongoing' | 'unknown' | 'upcoming' {
  const start = parseDateTime(startTs);
  const end = parseDateTime(endTs);
  if (!start) {
    return end ? 'ended' : 'unknown';
  }
  const now = dayjs();
  if (end && end.isBefore(now)) {
    return 'ended';
  }
  return start.isAfter(now) ? 'upcoming' : 'ongoing';
}

/** 维护窗口状态 → 文案。 */
export function maintenanceStateLabel(
  startTs?: DisplayValue,
  endTs?: DisplayValue,
): string {
  switch (maintenanceState(startTs, endTs)) {
    case 'ended': {
      return $t('page.iot.display.maintenanceState.ended');
    }
    case 'ongoing': {
      return $t('page.iot.display.maintenanceState.ongoing');
    }
    case 'upcoming': {
      return $t('page.iot.display.maintenanceState.upcoming');
    }
    default: {
      return $t('page.iot.display.maintenanceState.unknown');
    }
  }
}

/** 维护窗口状态 → Tag 颜色。 */
export function maintenanceStateColor(
  startTs?: DisplayValue,
  endTs?: DisplayValue,
): string {
  switch (maintenanceState(startTs, endTs)) {
    case 'ended': {
      return 'success';
    }
    case 'ongoing': {
      return 'processing';
    }
    case 'upcoming': {
      return 'warning';
    }
    default: {
      return 'default';
    }
  }
}

// ==================== 时间 ====================

/**
 * 宽松解析后端时间：
 *   - 数字 / 纯数字字符串：按 epoch 毫秒（≥ 1e11）或 epoch 秒处理；
 *   - 其它字符串：交给 dayjs（兼容 `yyyy-MM-dd HH:mm:ss` 与 ISO `T` 形态）。
 *
 * 解析失败返回 `undefined`，绝不返回 Invalid Date 让 `format` 输出 `Invalid Date`。
 */
export function parseDateTime(value?: DisplayValue): dayjs.Dayjs | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value).trim();
  if (text === '') {
    return undefined;
  }
  if (typeof value === 'number' || /^\d{10,}$/.test(text)) {
    const numeric = Number(text);
    if (!Number.isFinite(numeric)) {
      return undefined;
    }
    // 10 位为秒、13 位为毫秒；这里用阈值分界并保留对更早绝对时间的兼容。
    const millis = numeric < 1e11 ? numeric * 1000 : numeric;
    const fromEpoch = dayjs(millis);
    return fromEpoch.isValid() ? fromEpoch : undefined;
  }
  const parsed = dayjs(text);
  return parsed.isValid() ? parsed : undefined;
}

/** 后端时间 → `yyyy-MM-dd HH:mm:ss`；空值/非法值给 `fallback`。 */
export function formatDateTime(
  value?: DisplayValue,
  fallback = EMPTY_TEXT,
): string {
  const parsed = parseDateTime(value);
  return parsed ? parsed.format('YYYY-MM-DD HH:mm:ss') : fallback;
}

/**
 * 后端时间 → 相对人话（刚刚 / N 分钟前 / …）。
 *
 * 超过 30 天或解析失败时回落成绝对时间；未来时间（时钟漂移）也按绝对时间展示，
 * 不写成「-3 分钟前」这种自相矛盾的文案。
 */
export function formatRelativeTime(
  value?: DisplayValue,
  fallback = EMPTY_TEXT,
): string {
  const parsed = parseDateTime(value);
  if (!parsed) {
    return fallback;
  }
  const diffSeconds = dayjs().diff(parsed, 'second');
  if (diffSeconds < 0) {
    return parsed.format('YYYY-MM-DD HH:mm:ss');
  }
  if (diffSeconds < 60) {
    return $t('page.iot.display.time.justNow');
  }
  const minutes = Math.floor(diffSeconds / 60);
  if (minutes < 60) {
    return $t('page.iot.display.time.minutesAgo', [String(minutes)]);
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return $t('page.iot.display.time.hoursAgo', [String(hours)]);
  }
  const days = Math.floor(hours / 24);
  if (days <= 30) {
    return $t('page.iot.display.time.daysAgo', [String(days)]);
  }
  return parsed.format('YYYY-MM-DD HH:mm:ss');
}

// ==================== JSON / 值 ====================

/**
 * JSON 文本美化（用于指标快照、回执等「原样存储」字段的展示）。
 *
 * 解析失败时**返回原文而不是空**：后端已经存了的字符串，展示出来总比藏起来强。
 */
export function prettyJson(
  value?: DisplayValue,
  fallback = EMPTY_TEXT,
): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  const text = String(value).trim();
  if (text === '') {
    return fallback;
  }
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 布尔值 → 是 / 否（三态的空值给 `fallback`）。 */
export function yesNoLabel(value?: boolean | null, fallback = EMPTY_TEXT) {
  if (value === undefined || value === null) {
    return fallback;
  }
  return value ? $t('page.iot.display.yes') : $t('page.iot.display.no');
}

// ==================== 平台自告警规则 ====================

/**
 * 平台健康规则码 → 文案键。
 *
 * 规则码来自后端 `PlatformHealthRule` 枚举，是固定集合；这里显式 switch 而不是动态拼字符串，
 * 将来后端新增规则时不会渲染出 `page.iot.platformAlert.ruleLabel.xxx` 原始键。
 */
export function platformHealthRuleLabelKey(value?: DisplayValue): string {
  switch (normalizedCode(value).toUpperCase()) {
    case 'PLATFORM_EVALUATOR_ROUND_FAILED': {
      return 'page.iot.platformAlert.ruleLabel.evaluatorRoundFailed';
    }
    case 'PLATFORM_EVALUATOR_STALLED': {
      return 'page.iot.platformAlert.ruleLabel.evaluatorStalled';
    }
    case 'PLATFORM_INGEST_DROPPING': {
      return 'page.iot.platformAlert.ruleLabel.ingestDropping';
    }
    case 'PLATFORM_INSTANCE_UNREACHABLE': {
      return 'page.iot.platformAlert.ruleLabel.instanceUnreachable';
    }
    case 'PLATFORM_LEDGER_BUMP_FAILING': {
      return 'page.iot.platformAlert.ruleLabel.ledgerBumpFailing';
    }
    case 'PLATFORM_NOTIFY_FAILING': {
      return 'page.iot.platformAlert.ruleLabel.notifyFailing';
    }
    case 'PLATFORM_RECONCILE_DEFERRED': {
      return 'page.iot.platformAlert.ruleLabel.reconcileDeferred';
    }
    case 'PLATFORM_TICK_SLOW': {
      return 'page.iot.platformAlert.ruleLabel.tickSlow';
    }
    default: {
      return 'page.iot.platformAlert.ruleLabel.unknown';
    }
  }
}

// ==================== 开放 API 作用域 ====================

/**
 * 开放作用域码 → 文案键。
 *
 * 后端存的是权限码（`iot:device:list` 这类）；直接把它塞到界面里，非技术用户看不懂。
 * 键按权限名逐项列出，未知码仍原样展示（见调用方）。
 */
export function openApiScopeLabelKey(value?: DisplayValue): string {
  switch (normalizedCode(value)) {
    case 'iot:alert:list': {
      return 'page.iot.openApiKey.scope.alertList';
    }
    case 'iot:availability:get': {
      return 'page.iot.openApiKey.scope.availabilityGet';
    }
    case 'iot:debug:send': {
      return 'page.iot.openApiKey.scope.debugSend';
    }
    case 'iot:device:latest': {
      return 'page.iot.openApiKey.scope.deviceLatest';
    }
    case 'iot:device:list': {
      return 'page.iot.openApiKey.scope.deviceList';
    }
    case 'iot:product:list': {
      return 'page.iot.openApiKey.scope.productList';
    }
    case 'iot:series:get': {
      return 'page.iot.openApiKey.scope.seriesGet';
    }
    default: {
      return 'page.iot.openApiKey.scope.unknown';
    }
  }
}

// ==================== 物模型 / 点位枚举 ====================

/** 物模型数据类型码 → 文案（后端 ThingModelDataType）。 */
export function dataTypeLabel(value?: DisplayValue): string {
  switch (normalizedCode(value).toLowerCase()) {
    case 'array': {
      return $t('page.iot.point.dataTypeArray');
    }
    case 'bool': {
      return $t('page.iot.point.dataTypeBool');
    }
    case 'date_time': {
      return $t('page.iot.point.dataTypeDateTime');
    }
    case 'decimal': {
      return $t('page.iot.point.dataTypeDecimal');
    }
    case 'enum': {
      return $t('page.iot.point.dataTypeEnum');
    }
    case 'int': {
      return $t('page.iot.point.dataTypeInt');
    }
    case 'json_object': {
      return $t('page.iot.point.dataTypeJsonObject');
    }
    case 'long': {
      return $t('page.iot.point.dataTypeLong');
    }
    case 'string': {
      return $t('page.iot.point.dataTypeString');
    }
    default: {
      return unknownCode(value);
    }
  }
}

/** 物模型数据类型下拉（顺序与后端 ThingModelDataType 一致）。 */
export function dataTypeOptions() {
  return [
    'int',
    'long',
    'decimal',
    'string',
    'bool',
    'enum',
    'date_time',
    'json_object',
    'array',
  ].map((value) => ({ label: dataTypeLabel(value), value }));
}

/** 读写权限码 → 文案（R / W / RW；点位映射与物模型属性共用）。 */
export function accessModeLabel(value?: DisplayValue): string {
  switch (normalizedCode(value).toUpperCase()) {
    case 'R': {
      return $t('page.iot.point.rwRead');
    }
    case 'RW': {
      return $t('page.iot.point.rwReadWrite');
    }
    case 'W': {
      return $t('page.iot.point.rwWrite');
    }
    default: {
      return unknownCode(value);
    }
  }
}

/** 读写权限下拉。 */
export function accessModeOptions() {
  return ['R', 'W', 'RW'].map((value) => ({
    label: accessModeLabel(value),
    value,
  }));
}

/** 服务选项码 → 文案（后端 ServiceOption）。 */
export function serviceOptionLabel(value?: DisplayValue): string {
  switch (normalizedCode(value).toLowerCase()) {
    case 'mandatory': {
      return $t('page.iot.product.serviceOptionMandatory');
    }
    case 'master': {
      return $t('page.iot.product.serviceOptionMaster');
    }
    case 'optional': {
      return $t('page.iot.product.serviceOptionOptional');
    }
    default: {
      return unknownCode(value);
    }
  }
}

/** 服务选项下拉。 */
export function serviceOptionOptions() {
  return ['master', 'mandatory', 'optional'].map((value) => ({
    label: serviceOptionLabel(value),
    value,
  }));
}

/** 点位引用类型码 → 文案（后端 PointRefType：property / command）。 */
export function pointRefTypeLabel(value?: DisplayValue): string {
  switch (normalizedCode(value).toLowerCase()) {
    case 'command': {
      return $t('page.iot.point.refTypeCommand');
    }
    case 'property': {
      return $t('page.iot.point.refTypeProperty');
    }
    default: {
      return unknownCode(value);
    }
  }
}

/** 地址类型码 → 文案（后端 AddressType）。 */
export function addressTypeLabel(value?: DisplayValue): string {
  switch (normalizedCode(value).toLowerCase()) {
    case 'coil': {
      return $t('page.iot.point.addressCoil');
    }
    case 'discrete': {
      return $t('page.iot.point.addressDiscrete');
    }
    case 'holding': {
      return $t('page.iot.point.addressHolding');
    }
    case 'input': {
      return $t('page.iot.point.addressInput');
    }
    case 'nodeid': {
      return $t('page.iot.point.addressNodeId');
    }
    case 'topic': {
      return $t('page.iot.point.addressTopic');
    }
    default: {
      return unknownCode(value);
    }
  }
}

// ==================== 读数质量 ====================

/** 读数质量码 → 文案（后端 ReadingQuality：GOOD/UNCERTAIN/BAD/STALE/NOT_CONNECTED/CONFIG_ERROR）。 */
export function qualityLabel(value?: DisplayValue): string {
  switch (normalizedCode(value).toUpperCase()) {
    case 'BAD': {
      return $t('page.iot.display.quality.bad');
    }
    case 'CONFIG_ERROR': {
      return $t('page.iot.display.quality.configError');
    }
    case 'GOOD': {
      return $t('page.iot.display.quality.good');
    }
    case 'NOT_CONNECTED': {
      return $t('page.iot.display.quality.notConnected');
    }
    case 'STALE': {
      return $t('page.iot.display.quality.stale');
    }
    case 'UNCERTAIN': {
      return $t('page.iot.display.quality.uncertain');
    }
    default: {
      return unknownCode(value);
    }
  }
}
