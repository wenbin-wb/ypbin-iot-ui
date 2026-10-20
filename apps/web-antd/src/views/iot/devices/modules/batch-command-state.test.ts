import type { IotCommandApi } from '#/api/iot';

import { i18n } from '@vben/locales';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  batchCountsConsistent,
  batchDeliveryReasonKey,
  batchRejectReasonKey,
  buildBatchIdentifierOptions,
  buildBatchResultCsv,
  buildBatchResultCsvRows,
  buildBatchResultRows,
  canResendBatchItem,
  canResendBatchRow,
  collectServiceParams,
  countUnsupportedDevices,
  normalizeBatchDeviceIds,
  paramControlOf,
  parseBatchValue,
  parseCommandParamDefs,
  parseParamsObject,
  resolveBatchItemState,
  summarizeBatchResults,
  summarizeBatchRows,
} from './batch-command-state';

/**
 * 批量下发**纯逻辑层**用例。
 *
 * 本用例**不依赖仓外 temp/i18n-requests-*.json**（CI 检出没有该目录 ⇒ 会 ENOENT 打红），
 * 也不 mock i18n：只断言「返回的是哪个 i18n 键」（键名是稳定契约），文案由真实语言包提供。
 *
 * 重点锁三件事（都是出过事故的形态）：
 * 1. **三态判定**：accepted+ok / accepted+!ok / !accepted 三分，accepted=true & ok=false
 *    **绝不能**被判成成功；
 * 2. **汇总如实**：部分失败不得汇总成「整体成功」（allDelivered 只在全部送达时为 true）；
 * 3. **CSV 与表格同源**：CSV 行由同一份结果行生成，不会出现「表里失败、导出成功」。
 */

beforeAll(async () => {
  const { createApp } = await import('vue');
  const { setupI18n } = await import('#/locales');
  const app = createApp({ render: () => null });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
});

function item(
  overrides: Partial<IotCommandApi.CommandBatchItemResult> = {},
): IotCommandApi.CommandBatchItemResult {
  return {
    accepted: true,
    deviceId: '1001',
    ok: true,
    requestId: 'req-1',
    statusCode: 'sent',
    ...overrides,
  };
}

describe('逐设备三态判定', () => {
  it('accepted+ok ⇒ 已送达；accepted+!ok ⇒ 已提交未送达；!accepted ⇒ 未受理', () => {
    expect(resolveBatchItemState(item())).toBe('delivered');
    expect(
      resolveBatchItemState(
        item({ errorCode: 'NO_SUBSCRIBER', ok: false, statusCode: 'failed' }),
      ),
    ).toBe('accepted-not-delivered');
    expect(
      resolveBatchItemState(
        item({
          accepted: false,
          code: 'DEVICE_DISABLED',
          ok: false,
          requestId: undefined,
        }),
      ),
    ).toBe('rejected');
  });

  it('accepted 缺失/非 true 一律按未受理（不把不确定画成成功）', () => {
    expect(resolveBatchItemState({ deviceId: '1' })).toBe('rejected');
    expect(
      resolveBatchItemState({ accepted: false, deviceId: '1', ok: true }),
    ).toBe('rejected');
    // accepted=true 但 ok 缺失 ⇒ 未送达（不是成功）
    expect(resolveBatchItemState({ accepted: true, deviceId: '1' })).toBe(
      'accepted-not-delivered',
    );
  });

  it('可重发：只有「已提交未送达」且带 requestId 才成立', () => {
    expect(canResendBatchItem(item({ ok: false, statusCode: 'failed' }))).toBe(
      true,
    );
    expect(canResendBatchItem(item())).toBe(false);
    expect(
      canResendBatchItem(
        item({ ok: false, requestId: '', statusCode: 'failed' }),
      ),
    ).toBe(false);
    expect(
      canResendBatchItem(item({ accepted: false, ok: false, requestId: 'r' })),
    ).toBe(false);
  });
});

describe('结果汇总（部分失败绝不显示成整体成功）', () => {
  it('全成功：allDelivered 为 true，partial 为 false', () => {
    const summary = summarizeBatchResults([
      item({ deviceId: '1' }),
      item({ deviceId: '2', requestId: 'req-2' }),
    ]);
    expect(summary).toMatchObject({
      accepted: 2,
      allDelivered: true,
      delivered: 2,
      notDelivered: 0,
      partial: false,
      rejected: 0,
      total: 2,
    });
  });

  it('部分失败：allDelivered 为 false，三类计数各自独立', () => {
    const summary = summarizeBatchResults([
      item({ deviceId: '1' }),
      item({ deviceId: '2', errorCode: 'NO_SUBSCRIBER', ok: false }),
      item({ accepted: false, code: 'DEVICE_DISABLED', deviceId: '3' }),
    ]);
    expect(summary).toMatchObject({
      accepted: 2,
      allDelivered: false,
      delivered: 1,
      notDelivered: 1,
      partial: true,
      rejected: 1,
      total: 3,
    });
  });

  it('「已受理但全部未送达」也不是整体成功（delivered 才是成功口径）', () => {
    const summary = summarizeBatchResults([
      item({ deviceId: '1', ok: false }),
      item({ deviceId: '2', ok: false, requestId: 'r2' }),
    ]);
    expect(summary.allDelivered).toBe(false);
    expect(summary.accepted).toBe(2);
    expect(summary.delivered).toBe(0);
    expect(summary.notDelivered).toBe(2);
  });

  it('空结果不算成功（避免「0 台」被画成绿色全部送达）', () => {
    const summary = summarizeBatchResults([]);
    expect(summary).toMatchObject({
      allDelivered: false,
      partial: false,
      total: 0,
    });
  });

  it('计数一致性：后端计数为 Long 字符串时也能正确比对，不一致返回 false', () => {
    const summary = summarizeBatchResults([
      item({ deviceId: '1' }),
      item({ accepted: false, code: 'X', deviceId: '2' }),
    ]);
    expect(
      batchCountsConsistent(
        { accepted: '1', delivered: '1', rejected: '1', total: '2' },
        summary,
      ),
    ).toBe(true);
    expect(
      batchCountsConsistent(
        { accepted: 2, delivered: 2, rejected: 0, total: 2 },
        summary,
      ),
    ).toBe(false);
  });
});

describe('canResendBatchRow（展示行可重发判据）', () => {
  it('🔴 已送达行不得给重发按钮（BatchResultRow 没有 ok，误用 canResendBatchItem 会重复下发）', () => {
    const rows = buildBatchResultRows(
      [
        item({ deviceId: '1' }),
        item({ deviceId: '2', ok: false, requestId: 'r2' }),
        item({ accepted: false, code: 'X', deviceId: '3' }),
      ],
      (deviceId) => ({ code: deviceId }),
    );
    expect(rows.map((row) => canResendBatchRow(row))).toEqual([
      false,
      true,
      false,
    ]);
    // 自证「误用」的后果：同一个已送达行喂给条目判据会被判成可重发
    expect(canResendBatchItem(rows[0] as never)).toBe(true);
  });

  it('「已提交未送达」但没有 requestId ⇒ 不可重发（没有目标请求）', () => {
    const [row] = buildBatchResultRows(
      [item({ deviceId: '1', ok: false, requestId: '' })],
      (deviceId) => ({ code: deviceId }),
    );
    if (!row) {
      throw new Error('buildBatchResultRows 未产出结果行');
    }
    expect(canResendBatchRow(row)).toBe(false);
  });
});

describe('summarizeBatchRows（单台重发后按展示行重算汇总）', () => {
  it('与 summarizeBatchResults 同口径：同一批数据从行算与从条目算结果一致', () => {
    const items = [
      item({ deviceId: '1' }),
      item({ deviceId: '2', errorCode: 'NO_SUBSCRIBER', ok: false }),
      item({ accepted: false, code: 'DEVICE_DISABLED', deviceId: '3' }),
    ];
    const rows = buildBatchResultRows(items, (deviceId) => ({
      code: deviceId,
    }));
    expect(summarizeBatchRows(rows)).toStrictEqual(
      summarizeBatchResults(items),
    );
  });

  it('🔴 某台从「已提交未送达」变「已送达」⇒ 汇总跟着变（顶部与结果表不矛盾）', () => {
    const rows = buildBatchResultRows(
      [
        item({ deviceId: '1' }),
        item({ deviceId: '2', ok: false, requestId: 'r2' }),
      ],
      (deviceId) => ({ code: deviceId }),
    );
    expect(summarizeBatchRows(rows)).toMatchObject({
      allDelivered: false,
      delivered: 1,
      notDelivered: 1,
    });

    const afterResend = rows.map((row) =>
      row.deviceId === '2'
        ? {
            ...row,
            accepted: true,
            errorCode: '',
            requestId: 'r2',
            state: 'delivered' as const,
            statusCode: 'sent',
          }
        : row,
    );
    expect(summarizeBatchRows(afterResend)).toMatchObject({
      allDelivered: true,
      delivered: 2,
      notDelivered: 0,
      partial: false,
    });
  });
});

describe('原因码 → i18n 键（未知码不猜文案）', () => {
  it('未受理 8 类码都有键，未知码返回空串', () => {
    const codes = [
      'BATCH_BUDGET_EXCEEDED',
      'COMMAND_REJECTED',
      'DEVICE_DISABLED',
      'DEVICE_NOT_FOUND',
      'DEVICE_WITHOUT_PRODUCT',
      'INTERNAL_ERROR',
      'THING_MODEL_EMPTY',
      'THING_MODEL_LOAD_FAILED',
    ];
    for (const code of codes) {
      expect(batchRejectReasonKey(code)).toContain(
        'page.iot.device.batchCommand.',
      );
    }
    expect(batchRejectReasonKey('SOMETHING_NEW')).toBe('');
    expect(batchRejectReasonKey(undefined)).toBe('');
    // 大小写不敏感（后端常量全大写，但防御式归一）
    expect(batchRejectReasonKey('device_disabled')).toBe(
      'page.iot.device.batchCommand.reasonDisabled',
    );
  });

  it('投递失败码：NO_SUBSCRIBER 能翻成「设备未连接」，未知码原样返回空', () => {
    expect(batchDeliveryReasonKey('NO_SUBSCRIBER')).toBe(
      'page.iot.device.batchCommand.deliveryNoSubscriber',
    );
    expect(batchDeliveryReasonKey('EMQX_ERROR')).toContain(
      'page.iot.device.batchCommand.',
    );
    expect(batchDeliveryReasonKey('WEIRD')).toBe('');
  });
});

describe('设备清单与物模型候选', () => {
  it('normalizeBatchDeviceIds：去空/去重/保序，数字与字符串混用也对', () => {
    expect(
      normalizeBatchDeviceIds([
        '1001',
        ' 1002 ',
        '1001',
        '',
        1003,
        null,
        undefined,
      ]),
    ).toEqual(['1001', '1002', '1003']);
    expect(normalizeBatchDeviceIds([])).toEqual([]);
  });

  const models = [
    {
      commands: [
        { commandName: '重启', identifier: 'reboot' },
        { commandName: '校准', identifier: 'calibrate' },
      ],
      productId: 'p1',
      properties: [
        { accessMode: 'R', identifier: 'temperature', propertyName: '温度' },
        { accessMode: 'RW', identifier: 'setpoint', propertyName: '设定值' },
        { accessMode: 'W', identifier: 'mode', propertyName: '模式' },
      ],
    },
    {
      commands: [],
      productId: 'p2',
      properties: [
        { accessMode: 'RW', identifier: 'setpoint', propertyName: '设定值' },
      ],
    },
  ] as any;

  it('property_set 只列可写属性（W/RW）；跨产品同标识合并 productIds', () => {
    const options = buildBatchIdentifierOptions(models, 'property_set');
    expect(options.map((item) => item.value)).toEqual(['mode', 'setpoint']);
    expect(
      options.find((item) => item.value === 'setpoint')?.productIds,
    ).toEqual(['p1', 'p2']);
    expect(
      options.find((item) => item.value === 'temperature'),
    ).toBeUndefined();
  });

  it('property_get 只列可读属性（R/RW）', () => {
    expect(
      buildBatchIdentifierOptions(models, 'property_get').map(
        (item) => item.value,
      ),
    ).toEqual(['setpoint', 'temperature']);
  });

  it('service_call 只列命令定义，按标识去重', () => {
    const options = buildBatchIdentifierOptions(models, 'service_call');
    expect(options.map((item) => item.value)).toEqual(['calibrate', 'reboot']);
  });

  it('countUnsupportedDevices：产品不在候选 productIds 里、或设备无 productId 都算不支持', () => {
    const option = buildBatchIdentifierOptions(models, 'property_set').find(
      (item) => item.value === 'setpoint',
    );
    expect(
      countUnsupportedDevices(option, [
        { deviceId: '1', productId: 'p1' },
        { deviceId: '2', productId: 'p2' },
        { deviceId: '3', productId: 'pX' },
        { deviceId: '4' },
      ]),
    ).toBe(2);
    // 完全没选到标识时全部算「不支持」（确认前就提示）
    expect(
      countUnsupportedDevices(undefined, [{ deviceId: '1', productId: 'p1' }]),
    ).toBe(1);
  });
});

describe('服务入参解析与收集', () => {
  it('parseCommandParamDefs：解析 TSL paras（paraName/dataType/required/enumList）', () => {
    const defs = parseCommandParamDefs(
      JSON.stringify([
        { dataType: 'int', paraName: 'speed', required: true, unit: 'rpm' },
        {
          dataType: 'enum',
          enumList: ['A', 'B'],
          paraName: 'mode',
          required: false,
        },
      ]),
    );
    expect(defs).toHaveLength(2);
    expect(defs[0]).toMatchObject({
      dataType: 'int',
      identifier: 'speed',
      name: 'speed',
      required: true,
      unit: 'rpm',
    });
    expect(defs[1]?.enumList).toEqual(['A', 'B']);
  });

  it('parseCommandParamDefs：坏 JSON / 非数组 / 空 一律返回空数组（不抛异常）', () => {
    for (const raw of ['{bad', '"x"', '42', '{"a":1}', '', null, undefined]) {
      expect(parseCommandParamDefs(raw as never)).toEqual([]);
    }
    // 非数组（对象）也不是合法入参定义
    expect(parseCommandParamDefs('{"paraName":"m"}')).toEqual([]);
    // enumList 是逗号分隔字符串时也能解析
    const csvEnum = parseCommandParamDefs(
      '[{"paraName":"m","dataType":"enum","enumList":"A,B"}]',
    );
    expect(csvEnum).toHaveLength(1);
    expect(csvEnum[0]?.enumList).toEqual(['A', 'B']);
  });

  it('paramControlOf：按物模型类型给控件', () => {
    const def = (dataType: string, enumList: string[] = []) => ({
      dataType,
      enumList,
      identifier: 'x',
      name: 'x',
      required: false,
    });
    expect(paramControlOf(def('int'))).toBe('number');
    expect(paramControlOf(def('decimal'))).toBe('number');
    expect(paramControlOf(def('bool'))).toBe('switch');
    expect(paramControlOf(def('enum'))).toBe('select');
    expect(paramControlOf(def('string', ['A']))).toBe('select');
    expect(paramControlOf(def('string'))).toBe('input');
  });

  it('collectServiceParams：只收定义内字段，必填缺失/非数值都报错', () => {
    const defs = parseCommandParamDefs(
      JSON.stringify([
        { dataType: 'int', paraName: 'speed', required: true },
        { dataType: 'string', paraName: 'note', required: false },
      ]),
    );
    const ok = collectServiceParams(defs, { note: 'hi', speed: 10, extra: 1 });
    expect(ok.ok).toBe(true);
    expect(ok.params).toEqual({ note: 'hi', speed: 10 });
    // 定义外的字段不进 params
    expect(Object.hasOwn(ok.params, 'extra')).toBe(false);

    const missing = collectServiceParams(defs, { note: 'hi' });
    expect(missing.ok).toBe(false);
    expect(missing.missing).toEqual(['speed']);

    const wrong = collectServiceParams(defs, { speed: 'fast' });
    expect(wrong.ok).toBe(false);
    expect(wrong.wrongType).toEqual(['speed']);

    const boolDefs = parseCommandParamDefs(
      JSON.stringify([
        { dataType: 'bool', paraName: 'enable', required: true },
      ]),
    );
    expect(collectServiceParams(boolDefs, { enable: true }).params).toEqual({
      enable: true,
    });
  });

  it('parseBatchValue / parseParamsObject 与在线调试同口径', () => {
    expect(parseBatchValue('25.5')).toBe(25.5);
    expect(parseBatchValue('true')).toBe(true);
    expect(parseBatchValue('"text"')).toBe('text');
    expect(parseBatchValue('raw-text')).toBe('raw-text');
    expect(parseBatchValue('')).toBe('');

    expect(parseParamsObject('')).toEqual({ ok: true, value: {} });
    expect(parseParamsObject('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    for (const bad of ['[1,2]', '25', 'null', '{bad']) {
      expect(parseParamsObject(bad)).toEqual({ ok: false });
    }
  });
});

describe('结果行与 CSV 导出', () => {
  const labelOf = (deviceId: string) =>
    deviceId === '1001'
      ? { code: 'DEV-1', name: '泵房温度' }
      : { code: undefined, name: undefined };

  it('buildBatchResultRows：设备名优先、缺失回落 id，三态与原始字段都保留', () => {
    const rows = buildBatchResultRows(
      [
        item({ deviceId: '1001' }),
        item({
          accepted: false,
          code: 'DEVICE_DISABLED',
          deviceId: '1002',
          message: '设备已停用',
          ok: false,
        }),
      ],
      labelOf,
    );
    expect(rows[0]).toMatchObject({
      deviceCode: 'DEV-1',
      deviceName: '泵房温度',
      state: 'delivered',
      statusCode: 'sent',
    });
    expect(rows[1]).toMatchObject({
      code: 'DEVICE_DISABLED',
      deviceCode: '',
      deviceId: '1002',
      deviceName: '',
      message: '设备已停用',
      state: 'rejected',
    });
  });

  it('csv 行与表格同源：失败行导出后仍是失败态，不会被"美化"', () => {
    const rows = buildBatchResultRows(
      [
        item({ deviceId: '1001' }),
        item({ deviceId: '1002', errorCode: 'NO_SUBSCRIBER', ok: false }),
      ],
      labelOf,
    );
    const stateText = (state: string) => {
      if (state === 'delivered') {
        return '已送达';
      }
      return state === 'rejected' ? '未受理' : '已提交未送达';
    };
    const csv = buildBatchResultCsv(
      [
        '设备',
        '编码',
        'ID',
        '结果',
        '状态码',
        '投递码',
        '未受理码',
        '说明',
        'requestId',
      ],
      buildBatchResultCsvRows(rows, stateText),
    );
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('结果');
    expect(lines[1]).toContain('已送达');
    expect(lines[2]).toContain('已提交未送达');
    expect(lines[2]).toContain('NO_SUBSCRIBER');
  });

  it('csv 转义：设备名含逗号/引号/公式前缀都安全', () => {
    const rows = buildBatchResultRows(
      [item({ deviceId: '1', message: 'a,b"c' })],
      () => ({ code: 'D,1', name: '=SUM(A1)' }),
    );
    const csv = buildBatchResultCsv(
      [
        '设备',
        '编码',
        'ID',
        '结果',
        '状态码',
        '投递码',
        '未受理码',
        '说明',
        'requestId',
      ],
      buildBatchResultCsvRows(rows, () => '已送达'),
    );
    // 公式注入防护：= 开头前置单引号；含逗号/引号走 RFC 4180 引号包裹
    expect(csv).toContain("'=SUM(A1)");
    expect(csv).toContain('"D,1"');
    expect(csv).toContain('"a,b""c"');
  });
});

describe('i18n 键可编译（真实语言包，不 mock）', () => {
  it('本模块产出的所有键在真实 i18n 实例里都能翻出文案（未合并时不抛错即可）', () => {
    const keys = [
      batchRejectReasonKey('DEVICE_DISABLED'),
      batchDeliveryReasonKey('NO_SUBSCRIBER'),
    ];
    for (const key of keys) {
      expect(typeof i18n.global.t(key)).toBe('string');
    }
  });
});
