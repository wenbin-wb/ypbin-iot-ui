import type { VbenFormSchema as FormSchema } from '#/adapter/form';
import type { VxeTableGridColumns } from '#/adapter/vxe-table';
import type { IotMaintenanceApi } from '#/api/iot';

import dayjs from 'dayjs';

import { getDeviceOptions } from '#/api/iot';
import { $t } from '#/locales';

import {
  displayOrFallback,
  EMPTY_TEXT,
  formatDateTime,
  maintenanceSourceLabel,
  maintenanceState,
  maintenanceStateColor,
  maintenanceStateLabel,
  parseDateTime,
} from '../shared/display';

/** 展示层派生的维护窗口状态码（`maintenanceState(startTs, endTs)` 的返回值）。 */
export type MaintenanceState = ReturnType<typeof maintenanceState>;

/**
 * 维护窗口行 = 后端 DTO + 展示层补的派生字段。
 *
 * `deviceIdName` 来自后端 `@RefText("device")` 注解名（可能缺失，见 api/iot/maintenance.ts）；
 * `deviceName` / `maintenanceState` 只用于展示，不进 api 层 DTO，后端字段名保持不变。
 * 名称优先级：`deviceIdName` → 批量解析的 `deviceName` 映射 → 裸 `deviceId` → 租户级文案。
 */
export type MaintenanceWindowRow = IotMaintenanceApi.MaintenanceWindowDto & {
  deviceName: string;
  maintenanceState: MaintenanceState;
};

/**
 * 状态列的 CellTag 选项：`value` 是 index.vue 用 `maintenanceState(startTs, endTs)` 派生的状态码。
 * 文案/颜色不在此重写映射，而是在「过去/未来」的代表时刻上调用 shared/display.ts 的
 * `maintenanceStateLabel/Color` 求值（同一套判定规则，新增状态时不会口径漂移）。
 */
function maintenanceStateOptions(): Array<{
  color: string;
  label: string;
  value: MaintenanceState;
}> {
  const past = '2000-01-01 00:00:00';
  const future = '2999-01-01 00:00:00';
  return [
    {
      color: maintenanceStateColor(past, future),
      label: maintenanceStateLabel(past, future),
      value: 'ongoing',
    },
    {
      color: maintenanceStateColor(past, past),
      label: maintenanceStateLabel(past, past),
      value: 'ended',
    },
    {
      color: maintenanceStateColor(future),
      label: maintenanceStateLabel(future),
      value: 'upcoming',
    },
    {
      color: maintenanceStateColor(),
      label: maintenanceStateLabel(),
      value: 'unknown',
    },
  ];
}

/**
 * 时长粗算：`endTs` 为空表示窗口仍在进行，计到当前时刻；
 * 不足 1 分钟、开始/结束非法时如实回落为 `-`，不编造时长。
 */
function durationText(row: MaintenanceWindowRow): string {
  const start = parseDateTime(row.startTs);
  if (!start) {
    return EMPTY_TEXT;
  }
  const end = row.endTs ? parseDateTime(row.endTs) : dayjs();
  if (!end || end.isBefore(start)) {
    return EMPTY_TEXT;
  }
  const totalMinutes = end.diff(start, 'minute');
  if (totalMinutes < 1) {
    return $t('page.iot.maintenance.durationLessThanMinute');
  }
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push($t('page.iot.maintenance.durationDays', [String(days)]));
  }
  if (hours > 0) {
    parts.push($t('page.iot.maintenance.durationHours', [String(hours)]));
  }
  if (minutes > 0) {
    parts.push($t('page.iot.maintenance.durationMinutes', [String(minutes)]));
  }
  return parts.join(' ');
}

/** 维护窗口列表列。 */
export function useColumns(): VxeTableGridColumns {
  return [
    {
      // 展示的是**设备名**：窗口表里存的是 deviceId，裸雪花 ID 对用户毫无意义。
      // 名称优先取后端 `deviceIdName`（@RefText 注解名，列表页写进行的 `deviceName`）；
      // 仅对注解名缺失的行才按页批量解析（见 index.vue，绝不逐行查、全有注解名时不发请求）；
      // 仍解析不到时回落成裸 ID（不编造名字）；deviceId 为空是「租户级窗口」，由列表页填该文案。
      field: 'deviceName',
      title: $t('page.iot.maintenance.device'),
      minWidth: 160,
    },
    {
      field: 'startTs',
      title: $t('page.iot.maintenance.start'),
      width: 170,
      formatter: ({ cellValue }: { cellValue?: string }) =>
        formatDateTime(cellValue),
    },
    {
      field: 'endTs',
      title: $t('page.iot.maintenance.end'),
      width: 170,
      // 结束为空仍是「进行中」（后端语义：手动关闭前一直有效）
      formatter: ({ cellValue }: { cellValue?: string }) =>
        cellValue
          ? formatDateTime(cellValue)
          : $t('page.iot.maintenance.ongoing'),
    },
    {
      // 状态为展示层派生列（列字段名不映射后端字段），行值由 index.vue 计算
      field: 'maintenanceState',
      title: $t('page.iot.maintenance.status'),
      width: 100,
      cellRender: { name: 'CellTag', options: maintenanceStateOptions() },
    },
    {
      // 时长是展示层派生列：formatter 直接读 row.startTs / row.endTs，不做字段改名映射
      field: 'duration',
      title: $t('page.iot.maintenance.duration'),
      width: 150,
      formatter: ({ row }: { row: MaintenanceWindowRow }) => durationText(row),
    },
    {
      field: 'source',
      title: $t('page.iot.maintenance.source'),
      width: 120,
      formatter: ({ cellValue }: { cellValue?: string }) =>
        maintenanceSourceLabel(cellValue),
    },
    {
      field: 'reason',
      title: $t('page.iot.maintenance.reason'),
      minWidth: 200,
      formatter: ({ cellValue }: { cellValue?: string }) =>
        displayOrFallback(cellValue),
    },
    {
      title: $t('common.action'),
      field: 'action',
      fixed: 'right',
      width: 140,
      align: 'center',
      slots: { default: 'action' },
    },
  ];
}

/** 搜索表单（设备/时间范围，后端 `getMaintenanceWindowList` 已支持这三个查询参数）。 */
export function useGridFormSchema(): FormSchema[] {
  return [
    {
      component: 'ApiSelect',
      componentProps: {
        allowClear: true,
        api: getDeviceOptions,
        class: 'w-full',
        labelField: 'deviceName',
        placeholder: $t('page.iot.maintenance.searchDevicePlaceholder'),
        showSearch: true,
        valueField: 'id',
      },
      fieldName: 'deviceId',
      label: $t('page.iot.maintenance.device'),
    },
    {
      component: 'DatePicker',
      componentProps: {
        class: 'w-full',
        placeholder: $t('page.iot.maintenance.searchStart'),
        showTime: true,
        valueFormat: 'YYYY-MM-DD HH:mm:ss',
      },
      fieldName: 'from',
      label: $t('page.iot.maintenance.searchStart'),
    },
    {
      component: 'DatePicker',
      componentProps: {
        class: 'w-full',
        placeholder: $t('page.iot.maintenance.searchEnd'),
        showTime: true,
        valueFormat: 'YYYY-MM-DD HH:mm:ss',
      },
      fieldName: 'to',
      label: $t('page.iot.maintenance.searchEnd'),
    },
  ];
}

/** 声明维护窗口表单（设备留空=该租户全部设备）。 */
export function useFormSchema(): FormSchema[] {
  return [
    {
      component: 'ApiSelect',
      componentProps: {
        allowClear: true,
        api: getDeviceOptions,
        class: 'w-full',
        labelField: 'deviceName',
        placeholder: $t('page.iot.maintenance.devicePlaceholder'),
        showSearch: true,
        valueField: 'id',
      },
      fieldName: 'deviceId',
      label: $t('page.iot.maintenance.device'),
    },
    {
      component: 'DatePicker',
      componentProps: {
        class: 'w-full',
        showTime: true,
        valueFormat: 'YYYY-MM-DD HH:mm:ss',
      },
      fieldName: 'startTs',
      label: $t('page.iot.maintenance.start'),
    },
    {
      component: 'DatePicker',
      componentProps: {
        class: 'w-full',
        showTime: true,
        valueFormat: 'YYYY-MM-DD HH:mm:ss',
      },
      fieldName: 'endTs',
      label: $t('page.iot.maintenance.end'),
      help: $t('page.iot.maintenance.endHelp'),
    },
    {
      component: 'Textarea',
      componentProps: { maxlength: 255, rows: 3 },
      fieldName: 'reason',
      label: $t('page.iot.maintenance.reason'),
      rules: 'required',
    },
  ];
}
