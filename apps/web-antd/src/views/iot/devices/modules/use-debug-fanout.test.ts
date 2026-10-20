import type { FanoutFormState } from './use-debug-fanout';

import { createApp } from 'vue';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  buildFanoutTargets,
  MAX_FANOUT,
  parseParamsObject,
  parseValue,
} from './use-debug-fanout';

/**
 * 多点位拆分（fanout）的**纯函数**用例。
 *
 * 为什么单独测这一层：后端 `CommandPayloads` 对 `property_get` 只放一个标识 ⇒ 多条指令
 * 必须由前端拆（各自 `requestId`、各自可重发）。拆错的表现是「用户选了 3 个点位、只发出去 1 条」
 * 或「一次轰出几十条」，两者在页面上都不报错 ⇒ 只能靠这一层守门。
 *
 * 本文件用**真实 i18n**（`全部可读属性` 这条文案会进目标表展示，桩 `$t` 证明不了键存在）。
 */
beforeAll(async () => {
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

const CONTEXT = { deviceId: '9300012', productId: '9100001' };

/** 默认表单：属性设置、1 行空目标。 */
function form(overrides: Partial<FanoutFormState> = {}): FanoutFormState {
  return {
    getSelection: [],
    kind: 'property_set',
    paramsText: '',
    serviceIdentifier: undefined,
    setRows: [{ identifier: 'temperature', key: 1, value: '25.5' }],
    timeoutMs: undefined,
    writeDesired: false,
    ...overrides,
  };
}

describe('buildFanoutTargets：前置条件', () => {
  it('无设备 ⇒ 拒绝组装（errorKey，不发请求）', () => {
    const result = buildFanoutTargets(form(), { productId: '9100001' });
    expect(result).toEqual({ errorKey: 'page.iot.debug.noDevice', ok: false });
  });

  it('无产品 ⇒ 拒绝组装（没有物模型就没有可选目标）', () => {
    const result = buildFanoutTargets(form(), { deviceId: '9300012' });
    expect(result).toEqual({ errorKey: 'page.iot.debug.noProduct', ok: false });
  });

  it('属性设置：全部行都没选点位 ⇒ noTarget', () => {
    const result = buildFanoutTargets(
      form({ setRows: [{ key: 1, value: '25.5' }] }),
      CONTEXT,
    );
    expect(result).toEqual({ errorKey: 'page.iot.debug.noTarget', ok: false });
  });
});

describe('buildFanoutTargets：属性设置（多点位拆分）', () => {
  it('两行 ⇒ 两条独立指令，每条只带一个 identifier', () => {
    const result = buildFanoutTargets(
      form({
        setRows: [
          { identifier: 'temperature', key: 1, value: '25.5' },
          { identifier: 'humidity', key: 2, value: '"dry"' },
        ],
        timeoutMs: 6000,
      }),
      CONTEXT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.targets).toHaveLength(2);
    expect(result.targets[0]).toEqual({
      identifier: 'temperature',
      req: {
        identifier: 'temperature',
        kind: 'property_set',
        params: { value: 25.5 },
        timeoutMs: 6000,
      },
    });
    // 第二行字符串走 JSON 解析 ⇒ 字符串原样
    expect(result.targets[1]?.req.params).toEqual({ value: 'dry' });
  });

  it('空目标行被跳过（用户加了一行但没选，不应派一条空指令）', () => {
    const result = buildFanoutTargets(
      form({
        setRows: [
          { identifier: 'temperature', key: 1, value: '1' },
          { key: 2, value: '2' },
        ],
      }),
      CONTEXT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.targets).toHaveLength(1);
  });

  it('writeDesired 只在勾选时出现在请求体（不写用户没要求的期望值）', () => {
    const off = buildFanoutTargets(form(), CONTEXT);
    expect(off.ok && Object.hasOwn(off.targets[0]?.req ?? {}, 'writeDesired')).toBe(
      false,
    );

    const on = buildFanoutTargets(form({ writeDesired: true }), CONTEXT);
    expect(on.ok && on.targets[0]?.req.writeDesired).toBe(true);
  });

  it('超 fanout 上限 ⇒ 前端先拒，并带「上限/实际条数」参数', () => {
    const rows = Array.from({ length: MAX_FANOUT + 1 }, (_, index) => ({
      identifier: `p${index}`,
      key: index + 1,
      value: '1',
    }));
    const result = buildFanoutTargets(form({ setRows: rows }), CONTEXT);
    expect(result).toEqual({
      args: [String(MAX_FANOUT), String(MAX_FANOUT + 1)],
      errorKey: 'page.iot.debug.fanoutTooMany',
      ok: false,
    });
  });
});

describe('buildFanoutTargets：属性读取', () => {
  it('空选 = 全部可读属性（后端既定语义：一条指令不带 identifier）', () => {
    const result = buildFanoutTargets(
      form({ getSelection: [], kind: 'property_get' }),
      CONTEXT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.targets).toHaveLength(1);
    // 目标表的「标识」列显示人话，请求体不带 identifier
    expect(result.targets[0]?.identifier).toBe('全部可读属性');
    expect(Object.hasOwn(result.targets[0]?.req ?? {}, 'identifier')).toBe(false);
  });

  it('多选 ⇒ 每个点位一条', () => {
    const result = buildFanoutTargets(
      form({ getSelection: ['a', 'b', 'c'], kind: 'property_get' }),
      CONTEXT,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.targets.map((item) => item.identifier)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});

describe('buildFanoutTargets：服务调用', () => {
  it('未选命令 ⇒ noCommand', () => {
    const result = buildFanoutTargets(
      form({ kind: 'service_call' }),
      CONTEXT,
    );
    expect(result).toEqual({ errorKey: 'page.iot.debug.noCommand', ok: false });
  });

  it('params 不是 JSON 对象 ⇒ paramsInvalid（前端先拦，不白跑一次请求）', () => {
    const invalidJson = buildFanoutTargets(
      form({ kind: 'service_call', paramsText: '{', serviceIdentifier: 'reboot' }),
      CONTEXT,
    );
    expect(invalidJson).toEqual({
      errorKey: 'page.iot.debug.paramsInvalid',
      ok: false,
    });
    const array = buildFanoutTargets(
      form({ kind: 'service_call', paramsText: '[1,2]', serviceIdentifier: 'reboot' }),
      CONTEXT,
    );
    expect(array).toEqual({
      errorKey: 'page.iot.debug.paramsInvalid',
      ok: false,
    });
  });

  it('params 留空 ⇒ 视为 {}；合法对象原样透传', () => {
    const empty = buildFanoutTargets(
      form({ kind: 'service_call', serviceIdentifier: 'reboot' }),
      CONTEXT,
    );
    expect(empty.ok && empty.targets[0]?.req.params).toEqual({});

    const withParams = buildFanoutTargets(
      form({
        kind: 'service_call',
        paramsText: '{"level":3}',
        serviceIdentifier: 'reboot',
      }),
      CONTEXT,
    );
    expect(withParams.ok && withParams.targets[0]?.req.params).toEqual({
      level: 3,
    });
  });
});

describe('parseValue / parseParamsObject（输入口径）', () => {
  it('parseValue：JSON 优先，解析失败按字符串下发（不丢用户输入）', () => {
    expect(parseValue('25.5')).toBe(25.5);
    expect(parseValue('true')).toBe(true);
    expect(parseValue('"text"')).toBe('text');
    expect(parseValue('{"a":1}')).toEqual({ a: 1 });
    expect(parseValue('  ')).toBe('');
    expect(parseValue('not-json')).toBe('not-json');
  });

  it('parseParamsObject：空 = {}、非法 = false、数组 = false', () => {
    expect(parseParamsObject('')).toEqual({ ok: true, value: {} });
    expect(parseParamsObject('null')).toEqual({ ok: false });
    expect(parseParamsObject('"str"')).toEqual({ ok: false });
    expect(parseParamsObject('[1]')).toEqual({ ok: false });
  });
});
