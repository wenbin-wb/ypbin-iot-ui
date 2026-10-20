import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from 'vue';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  accessModeLabel,
  addressTypeLabel,
  dataFormatLabel,
  dataTypeLabel,
  displayOrFallback,
  formatDateTime,
  formatRelativeTime,
  maintenanceState,
  maintenanceStateLabel,
  modelStatusLabel,
  onlineStatusLabel,
  openApiScopeLabelKey,
  platformHealthRuleLabelKey,
  pointRefTypeLabel,
  prettyJson,
  protocolLabel,
  qualityLabel,
  serviceOptionLabel,
} from './display';

/**
 * 展示层纯函数的边界用例。
 *
 * 这里刻意加载**真实 i18n**（与页面同一条 `$t` 路径）：展示层返回值会直接渲染到界面，
 * 用桩替换 `$t` 只能证明调用成功，证明不了「键存在且能编译」。
 */
beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

describe('枚举码 → 展示文案', () => {
  it('协议码翻译为中文名称，未知码保留原码', () => {
    expect(protocolLabel('modbus')).toBe('Modbus TCP');
    expect(protocolLabel('TCP')).toBe('TCP 透传');
    expect(protocolLabel('opcua')).toBe('OPC UA');
    expect(protocolLabel('lorawan')).toBe('未知（lorawan）');
    expect(protocolLabel('')).toBe('-');
  });

  it('在线状态与物模型状态都有中文映射', () => {
    expect(onlineStatusLabel('online')).toBe('在线');
    expect(onlineStatusLabel('offline')).toBe('离线');
    expect(onlineStatusLabel('unknown')).toBe('未知');
    expect(modelStatusLabel('draft')).toBe('草稿');
    expect(modelStatusLabel('PUBLISHED')).toBe('已发布');
    expect(dataFormatLabel('BINARY')).toBe('二进制');
  });

  it('物模型/点位/服务枚举与读数质量都有中文映射', () => {
    expect(dataTypeLabel('date_time')).toBe('日期时间');
    expect(dataTypeLabel('JSON_OBJECT')).toBe('JSON 对象');
    expect(accessModeLabel('RW')).toBe('读写（RW）');
    expect(serviceOptionLabel('mandatory')).toBe('必选服务');
    expect(pointRefTypeLabel('command')).toBe('命令（command）');
    expect(addressTypeLabel('holding')).toBe('保持寄存器（holding）');
    expect(qualityLabel('NOT_CONNECTED')).toBe('未连接');
    expect(qualityLabel('bad')).toBe('坏值');
    expect(qualityLabel('mystery')).toBe('未知（mystery）');
  });

  it('平台规则码与开放作用域码不做动态拼键（未知码给专门文案）', () => {
    expect(platformHealthRuleLabelKey('PLATFORM_NOTIFY_FAILING')).toBe(
      'page.iot.platformAlert.ruleLabel.notifyFailing',
    );
    expect(platformHealthRuleLabelKey('PLATFORM_NOT_EXIST')).toBe(
      'page.iot.platformAlert.ruleLabel.unknown',
    );
    expect(openApiScopeLabelKey('iot:series:get')).toBe(
      'page.iot.openApiKey.scope.seriesGet',
    );
    expect(openApiScopeLabelKey('iot:nope')).toBe(
      'page.iot.openApiKey.scope.unknown',
    );
  });
});

describe('时间展示', () => {
  it('空值与非法值不输出 Invalid Date', () => {
    expect(displayOrFallback('')).toBe('-');
    expect(formatDateTime('')).toBe('-');
    expect(formatDateTime('not-a-date')).toBe('-');
    expect(formatDateTime(null)).toBe('-');
  });

  it('兼容后端两种时间形态：空格分隔与 ISO T 分隔', () => {
    expect(formatDateTime('2026-10-14 09:30:00')).toBe('2026-10-14 09:30:00');
    expect(formatDateTime('2026-10-14T09:30:00')).toBe('2026-10-14 09:30:00');
  });

  it('数字型时间按毫秒/秒解析（最新值 ts 是 epoch 毫秒）', () => {
    expect(formatDateTime(1_760_000_000_000)).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(formatDateTime('1760000000')).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('近期时间给相对人话，超过 30 天回落绝对时间', () => {
    const recent = Date.now() - 5 * 60 * 1000;
    expect(formatRelativeTime(recent)).toBe('5 分钟前');
    expect(formatRelativeTime(Date.now() - 3 * 60 * 60 * 1000)).toBe(
      '3 小时前',
    );
    expect(formatRelativeTime('2020-01-01 00:00:00')).toBe(
      '2020-01-01 00:00:00',
    );
  });

  it('维护窗口状态按起止时刻推导', () => {
    const past = '2020-01-01 00:00:00';
    const past2 = '2020-01-02 00:00:00';
    const future = '2999-01-01 00:00:00';
    expect(maintenanceState(past, past2)).toBe('ended');
    expect(maintenanceState(past, undefined)).toBe('ongoing');
    expect(maintenanceState(future, undefined)).toBe('upcoming');
    expect(maintenanceStateLabel(future, undefined)).toBe('未开始');
  });
});

describe('json 展示', () => {
  it('美化 JSON；非法 JSON 原样返回；空值给占位符', () => {
    expect(prettyJson('{"b":1,"a":2}')).toBe('{\n  "b": 1,\n  "a": 2\n}');
    expect(prettyJson('not-json')).toBe('not-json');
    expect(prettyJson('')).toBe('-');
  });
});

// ==================== 空值占位口径（静态门禁） ====================

/**
 * 静态门禁：iot 视图内「裸占位」行数必须持续下降并保持在阈值以下。
 *
 * 背景（2026-10-20 审查）：iot 视图里 `'-'` / `'—'` 裸写约 70 处，与
 * `shared/display.ts` 的 `EMPTY_TEXT` 并存 —— 同一个「空值」在不同页面用了不同字形，
 * 且新页面容易继续抄裸字符串。渲染层测不出这类「口径漂移」，只能做源码级断言。
 *
 * 判定口径（窄口径，避免误报）：
 * - 扫描 `views/iot/**` 的 `.vue` 与 `.ts`（排除 `*.test.ts`）；
 * - 跳过注释行（含 `//` `*` `/*` `<!--` 开头的行）—— 注释里提到占位符是正常文档；
 * - 命中这些「占位写法」才算：
 *   `>-<`（模板直接写字符）、`?? '-'`、`|| '-'`、`? '-' :`、`: '-'`、`'—'`；
 * - 白名单（{@link BARE_PLACEHOLDER_ALLOWLIST}）逐条登记：负号判断、时间格式化内部。
 *
 * 阈值 {@link MAX_BARE_PLACEHOLDER_LINES} 的来源：
 * - 批次 8 统一前实测约 **70 行**，按语义替换 39 处后 **29 行**（当时阈值 32）；
 * - 批次 9 再替换 17 处（诊断项 12 处 → `NOT_APPLICABLE_TEXT`、业务字段 5 处 → `EMPTY_TEXT`）后
 *   实测 **12 行**，阈值同步下调到 **12**（**只减不增**）。
 * 剩余 12 行均为已登记例外：alerts 目录（并行任务在改，留给下一批）6 行 + 格式化/映射
 * 函数内部 6 行（规则 2 明确不改；其单测直接断言 `'-'`）。新增页面必须用三个具名常量
 * （`EMPTY_TEXT` / `PENDING_TEXT` / `NOT_APPLICABLE_TEXT`）。
 */
const MAX_BARE_PLACEHOLDER_LINES = 12;

/** 允许保留裸占位的行（逐条给理由；禁止文件级豁免）。 */
const BARE_PLACEHOLDER_ALLOWLIST: Array<{
  file: string;
  reason: string;
  test: (line: string) => boolean;
}> = [
  {
    file: 'devices/modules/shadow-state.ts',
    reason: '负号判断（startsWith("-") ? "-" : ""），与空值占位无关',
    test: (line) => line.includes("startsWith('-')"),
  },
  {
    file: 'devices/modules/series-utils.ts',
    reason:
      '时间格式化函数内部（占位规则明确不改格式化函数内部）；语义为「时间未设置」，登记下批随格式化口径统一',
    test: (line) => line.includes("'—'"),
  },
];

/** 命中「裸占位写法」的正则（与文件头说明一一对应）。 */
const BARE_PLACEHOLDER_PATTERNS: RegExp[] = [
  />\s*-\s*</, // 模板里直接写字符：`<span>-</span>`
  /\?\?\s*'-'/, // nullish 兜底
  /\|\|\s*'-'/, // 逻辑或兜底
  /\?\s*'-'\s*:/, // 三元
  /:\s*'-'/, // 三元/默认值分支
  /'—'/, // 全角破折号占位
];

/** iot 视图根目录（本测试位于 `views/iot/shared/`）。 */
const IOT_VIEWS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 递归收集扫描范围内的源码文件。 */
function collectIotSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (entry.name.endsWith('.test.ts')) {
        continue;
      }
      if (entry.name.endsWith('.vue') || entry.name.endsWith('.ts')) {
        files.push(fullPath);
      }
    }
  };
  walk(IOT_VIEWS_ROOT);
  return files;
}

/** 行是否属于注释（注释里提到占位符是文档，不算违规）。 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('<!--')
  );
}

describe('空值占位口径（静态门禁）', () => {
  it('iot 视图裸占位行数 ≤ 阈值（只减不增）', () => {
    const violations: string[] = [];
    for (const file of collectIotSourceFiles()) {
      const relPath = relative(IOT_VIEWS_ROOT, file).replaceAll('\\', '/');
      // 常量定义文件本身必须出现 `'-'` / `'—'`（事实源），跳过
      if (relPath === 'shared/display.ts') {
        continue;
      }
      const allowlist = BARE_PLACEHOLDER_ALLOWLIST.filter(
        (entry) => entry.file === relPath,
      );
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (isCommentLine(line)) {
          return;
        }
        if (allowlist.some((entry) => entry.test(line))) {
          return;
        }
        if (BARE_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(line))) {
          violations.push(
            `${relPath}:${index + 1}  ${line.trim().slice(0, 100)}`,
          );
        }
      });
    }

    if (violations.length > MAX_BARE_PLACEHOLDER_LINES) {
      // 失败时把逐行清单塞进错误信息，方便直接定位（vitest 的 expect 第二参
      // 在 oxlint 的 valid-expect 规则下不被允许，故显式抛错）
      throw new Error(
        `iot 视图裸占位 ${violations.length} 行超过阈值 ${MAX_BARE_PLACEHOLDER_LINES}（新页面请用 EMPTY_TEXT / PENDING_TEXT，见 shared/display.ts）：\n${violations.join('\n')}`,
      );
    }
    expect(violations.length).toBeLessThanOrEqual(MAX_BARE_PLACEHOLDER_LINES);
  });

  it('页面已实际采用 EMPTY_TEXT / PENDING_TEXT（不是只定义常量）', () => {
    const files = collectIotSourceFiles();
    const pageFiles = files.filter(
      (file) => !file.endsWith('shared/display.ts'),
    );
    const readers = pageFiles.map((file) => readFileSync(file, 'utf8'));

    const emptyTextConsumers = readers.filter((source) =>
      source.includes('EMPTY_TEXT'),
    );
    const pendingTextConsumers = readers.filter((source) =>
      source.includes('PENDING_TEXT'),
    );

    // 统一后至少有 10 个文件在用 EMPTY_TEXT（当前 14 个），且 PENDING_TEXT 至少 1 个页面在用
    expect(emptyTextConsumers.length).toBeGreaterThanOrEqual(10);
    expect(pendingTextConsumers.length).toBeGreaterThanOrEqual(1);
  });
});
