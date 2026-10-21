/**
 * 数字孪生画布「改造后」截图 + 结构自检脚本（Track A 交付）。
 *
 * 用途：Lead 部署后一键出图，并**自动打印**改造效果的客观证据（不是靠人眼看图）。
 *
 * 运行（在仓库根目录）：
 * ```bash
 * node apps/web-antd/scratch/twin-verify/screenshot.mjs \
 *   --url "https://<host>/#/iot/twin?sceneId=2112773048514154497" \
 *   --out /tmp/twin-after.png
 * ```
 *
 * 可选参数：
 * - `--user admin --pass <pw>` 登录凭据（也可用环境变量 TWIN_USER / TWIN_PASS）
 * - `--wait 18000` 模型加载 + 运行态重放的等待毫秒数（默认 18000，需求要求 ≥15s）
 * - `--reduced` 以 `prefers-reduced-motion: reduce` 打开页面（验证动效降级）
 * - `--json /tmp/twin-report.json` 把结构自检结果也写一份 JSON
 *
 * 输出：
 * 1. 截图（`--out`）；
 * 2. 全部标签的 `getBoundingClientRect()`，并**两两检测矩形是否重叠**
 *    —— 这是「标签挤成一团」缺陷的唯一客观判据；
 * 3. console error 数（含 pageerror）；
 * 4. canvas 尺寸。
 *
 * ⚠️ 必须**普通导航**（`page.goto` 带完整 hash URL），不能只改 hash：
 * 生产构建有菜单白名单，深链刷新走的是另一条路由初始化路径。
 *
 * ⚠️ 依赖解析：playwright 装在工作区根（pnpm 硬链接），本脚本用 `createRequire`
 * 从脚本位置向上解析，不写死绝对路径（换工作树/机器不用改）。
 */

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

/**
 * 动态解析 playwright 的入口文件。
 *
 * pnpm 的 `node_modules/playwright` 是指向 `.pnpm` 的符号链接，`require.resolve`
 * 走的是真实路径（`index.js`，CJS）。用 Node 的模块解析而不是写死绝对路径：
 * 换工作树、换机器都不用改脚本。
 */
async function loadChromium() {
  const errors = [];
  for (const base of [import.meta.dirname, process.cwd()]) {
    try {
      const entry = createRequire(`${base}/`).resolve('playwright');
      const module = await import(entry);
      const chromium = module.chromium ?? module.default?.chromium;
      if (chromium) {
        return chromium;
      }
      errors.push(`${entry}: 未导出 chromium`);
    } catch (error) {
      errors.push(`${base}: ${error instanceof Error ? error.message : error}`);
    }
  }
  throw new Error(
    `无法解析 playwright：\n  ${errors.join('\n  ')}\n` +
      '请在仓库根执行 pnpm install 后重试',
  );
}

/** 解析命令行参数（不引依赖：脚本要能在任意机器上直接跑）。 */
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

/** 输出到 stdout（脚本的产出就是给人/CI 读的，允许 console.log）。 */
function print(line = '') {
  process.stdout.write(`${line}\n`);
}

/** 两两矩形是否重叠（含 1px 容差，与被测实现同口径）。 */
function findOverlaps(labels) {
  const overlaps = [];
  for (let i = 0; i < labels.length; i += 1) {
    for (let j = i + 1; j < labels.length; j += 1) {
      const a = labels[i];
      const b = labels[j];
      if (a.visibility === 'hidden' || b.visibility === 'hidden') {
        continue;
      }
      const overlapX =
        Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width) -
        Math.max(a.rect.x, b.rect.x);
      const overlapY =
        Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height) -
        Math.max(a.rect.y, b.rect.y);
      if (overlapX > 1 && overlapY > 1) {
        overlaps.push({ a: a.pointId, b: b.pointId, overlapX, overlapY });
      }
    }
  }
  return overlaps;
}

/** 主流程。 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url;
  if (typeof url !== 'string' || !url.startsWith('http')) {
    throw new Error(
      '缺少 --url（例：--url "https://host/#/iot/twin?sceneId=1"）',
    );
  }
  const out = typeof args.out === 'string' ? args.out : '/tmp/twin-after.png';
  const waitMs = Number(args.wait ?? 18_000);
  const user =
    typeof args.user === 'string' ? args.user : process.env.TWIN_USER;
  const pass =
    typeof args.pass === 'string' ? args.pass : process.env.TWIN_PASS;
  const reduced = args.reduced === true;

  const chromium = await loadChromium();
  const browser = await chromium.launch();
  const context = await browser.newContext({
    deviceScaleFactor: 1,
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    viewport: { height: 900, width: 1600 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    errors.push(`pageerror: ${error.message}`);
  });

  try {
    if (user && pass) {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      await page.locator('input').first().fill(user);
      await page.locator('input[type=password]').first().fill(pass);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(6000);
    } else {
      print(
        '[warn] 未提供凭据（--user/--pass 或 TWIN_USER/TWIN_PASS），跳过登录',
      );
    }

    // 深链必须普通导航（完整 URL），不能只改 hash
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // 模型加载 + 运行态重放需要 ≥15s
    await page.waitForTimeout(waitMs);

    await page.screenshot({ path: out, fullPage: false });

    const labels = await page.$$eval('.twin-anchor-label', (elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          collapsed: element.dataset.collapsed === 'true',
          pointId: element.dataset.pointId ?? '',
          rect: {
            height: Math.round(rect.height),
            width: Math.round(rect.width),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
          },
          text: (element.textContent ?? '').trim(),
          visibility: style.display === 'none' ? 'hidden' : style.visibility,
        };
      }),
    );
    const overlaps = findOverlaps(labels);
    const canvases = await page.$$eval('canvas', (elements) =>
      elements.map((canvas) => `${canvas.width}x${canvas.height}`),
    );
    const report = {
      canvases,
      errors,
      labels,
      motion: reduced ? 'reduced-requested' : 'default',
      overlaps,
      url,
    };
    print(JSON.stringify(report, null, 2));
    if (typeof args.json === 'string') {
      writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    }
    print(
      `\n[结论] 标签 ${labels.length} 个｜重叠 ${overlaps.length} 对｜` +
        `console error ${errors.length} 个｜截图 ${out}`,
    );
    process.exitCode = overlaps.length === 0 && errors.length === 0 ? 0 : 1;
  } finally {
    await browser.close();
  }
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : error}\n`);
  process.exitCode = 2;
});
