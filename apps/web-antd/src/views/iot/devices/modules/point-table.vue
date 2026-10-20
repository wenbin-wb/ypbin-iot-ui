<script lang="ts" setup>
import type { MergedRow } from './use-point-mapping';

import type { IotPointApi } from '#/api/iot';

import { Alert, Button, Empty, Popconfirm, Tag } from 'ant-design-vue';

import { $t } from '#/locales';

import {
  accessModeLabel,
  addressTypeLabel,
  dataTypeLabel,
  pointRefTypeLabel,
} from '../../shared/display';
import { registerDecodeSegments } from './point-mapping-state';

/**
 * 「属性与点位」三张表：属性↔点位连接表、设备级原始映射表、孤儿映射表。
 *
 * 为什么单独成组件：三张表都是**纯展示 + 行操作入口**（新增/编辑/删除/看曲线），
 * 数据与权限由宿主持有并透传（窄 props）。表格里的「解码」可读文本与启用色是纯展示
 * 换算，跟着表格走——宿主只管数据与权限，不再承载 12 列表格的细节。
 *
 * 布局契约：12 列（min-w-[900px]）与 9 列（min-w-[720px]）表格必须由**自身**
 * `overflow-x-auto` 承载横向滚动，窄屏不压扁列、也不让整页横滚。
 */
const props = defineProps<{
  canCreate: boolean;
  canDelete: boolean;
  canUpdate: boolean;
  /**
   * 是否绑定了产品：没绑产品时左侧「属性↔点位连接表」无从展示（与拆前口径一致），
   * 但设备级原始映射/孤儿映射仍必须可见。
   */
  hasProduct: boolean;
  /** 属性↔点位连接行（含未映射标记）。 */
  mergedRows: MergedRow[];
  /** 引用了已不存在属性的映射。 */
  orphanPoints: IotPointApi.PointMappingResp[];
  /** 设备级点位映射原始列表。 */
  points: IotPointApi.PointMappingResp[];
}>();

const emit = defineEmits<{
  create: [propertyId?: string];
  edit: [point: IotPointApi.PointMappingResp];
  openSeries: [identifier: string];
  remove: [point: IotPointApi.PointMappingResp];
}>();

/** 启用位配色：只有显式 false 才算停用（与列表页口径一致）。 */
function tagColor(enabled?: boolean) {
  return enabled === false ? 'default' : 'success';
}

/**
 * 列表「解码」列：可读文本（如 `32 位（2 个寄存器） · 有符号 · 低字在前（CDAB）`、
 * `32 位浮点 · 低字在前（CDAB）`、`位域：bit 3..5（3 位）`）。
 * 非 Modbus 寄存器点位显示 `-`，与既有 `'-'` 风格一致。
 */
function registerDecodeText(point: {
  addressType?: string;
  bitLength?: number;
  bitOffset?: number;
  byteOrder?: string;
  registerFormat?: string;
  signed?: boolean;
  wordCount?: number;
}): string {
  const segments = registerDecodeSegments(point);
  if (segments.length === 0) {
    return '-';
  }
  return segments
    .map((segment) =>
      segment.params ? $t(segment.key, segment.params) : $t(segment.key),
    )
    .join(' · ');
}
</script>

<template>
  <template v-if="hasProduct">
    <!-- 属性 ↔ 点位 连接表（含地址列与「未映射」标记） -->
    <Empty
      v-if="mergedRows.length === 0"
      :description="$t('page.iot.product.noProperty')"
    />
  <!-- 12 列：窄屏必须由表格自身横向滚动（min-w 保证列不被压扁） -->
  <div v-else class="overflow-x-auto">
    <table
      class="w-full min-w-[900px] text-sm"
      data-testid="point-join-table"
    >
      <thead>
        <tr class="text-left text-muted-foreground">
          <th class="py-1">{{ $t('page.iot.point.property') }}</th>
          <th class="py-1">{{ $t('page.iot.point.service') }}</th>
          <th class="py-1">{{ $t('page.iot.point.dataType') }}</th>
          <th class="py-1">{{ $t('page.iot.point.accessMode') }}</th>
          <th class="py-1">{{ $t('page.iot.point.unit') }}</th>
          <th class="py-1">{{ $t('page.iot.point.rawAddress') }}</th>
          <th class="py-1">{{ $t('page.iot.point.addressType') }}</th>
          <th class="py-1">{{ $t('page.iot.point.decode') }}</th>
          <th class="py-1">{{ $t('page.iot.point.pollIntervalMs') }}</th>
          <th class="py-1">{{ $t('page.iot.point.scaleFactor') }}</th>
          <th class="py-1">{{ $t('page.iot.point.enabled') }}</th>
          <th class="py-1">{{ $t('common.action') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="row in mergedRows"
          :key="row.propertyId"
          class="border-t"
        >
          <td class="py-1">{{ row.identifier }}</td>
          <td class="py-1">{{ row.serviceId }}</td>
          <td class="py-1">{{ dataTypeLabel(row.dataType) }}</td>
          <td class="py-1">{{ accessModeLabel(row.accessMode) }}</td>
          <td class="py-1">{{ row.unit || '-' }}</td>
          <td class="py-1">
            <template v-if="row.point">
              {{ row.point.rawAddress }}
            </template>
            <Tag v-else color="orange">
              {{ $t('page.iot.point.unmapped') }}
            </Tag>
          </td>
          <td class="py-1">
            {{ row.point ? addressTypeLabel(row.point.addressType) : '-' }}
          </td>
          <td class="py-1">
            {{ row.point ? registerDecodeText(row.point) : '-' }}
          </td>
          <td class="py-1">{{ row.point?.pollIntervalMs ?? '-' }}</td>
          <td class="py-1">{{ row.point?.scaleFactor ?? '-' }}</td>
          <td class="py-1">
            <Tag v-if="row.point" :color="tagColor(row.point.enabled)">
              {{ row.point.enabled === false ? 'off' : 'on' }}
            </Tag>
            <span v-else>-</span>
          </td>
          <td class="py-1">
            <template v-if="row.point">
              <div class="flex gap-1">
                <Button
                  v-if="canUpdate"
                  :data-testid="`point-edit-${row.propertyId}`"
                  size="small"
                  type="link"
                  @click="emit('edit', row.point)"
                >
                  {{ $t('page.iot.point.edit') }}
                </Button>
                <Popconfirm
                  v-if="canDelete"
                  :cancel-text="$t('page.iot.point.cancel')"
                  :ok-text="$t('page.iot.point.okText')"
                  :title="
                    $t('page.iot.point.deleteConfirm', [row.point.rawAddress])
                  "
                  @confirm="emit('remove', row.point)"
                >
                  <Button
                    :data-testid="`point-delete-joined-${row.propertyId}`"
                    size="small"
                    type="link"
                    danger
                  >
                    {{ $t('page.iot.point.delete') }}
                  </Button>
                </Popconfirm>
              </div>
            </template>
            <Button
              v-else-if="canCreate"
              :data-testid="`point-add-for-${row.propertyId}`"
              size="small"
              type="link"
              @click="emit('create', row.propertyId)"
            >
              {{ $t('page.iot.point.addPointFor') }}
            </Button>
            <Button
              :data-testid="`point-series-${row.propertyId}`"
              size="small"
              type="link"
              @click="emit('openSeries', row.identifier)"
            >
              {{ $t('page.iot.series.title') }}
            </Button>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
  </template>

  <div class="mt-4 mb-2 font-semibold">
    {{ $t('page.iot.point.rawList') }}
    <span class="text-xs text-muted-foreground">
      （{{ $t('page.iot.point.readonlyHint') }}）
    </span>
  </div>
  <Empty v-if="points.length === 0" :description="$t('page.iot.point.empty')" />
  <div v-else class="overflow-x-auto">
    <table class="w-full min-w-[720px] text-sm" data-testid="point-raw-table">
      <thead>
        <tr class="text-left text-muted-foreground">
          <th class="py-1">{{ $t('page.iot.point.propertyId') }}</th>
          <th class="py-1">{{ $t('page.iot.point.refType') }}</th>
          <th class="py-1">{{ $t('page.iot.point.rawAddress') }}</th>
          <th class="py-1">{{ $t('page.iot.point.addressType') }}</th>
          <th class="py-1">{{ $t('page.iot.point.decode') }}</th>
          <th class="py-1">{{ $t('page.iot.point.pollIntervalMs') }}</th>
          <th class="py-1">{{ $t('page.iot.point.rw') }}</th>
          <th class="py-1">{{ $t('page.iot.point.enabled') }}</th>
          <th class="py-1">{{ $t('common.action') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="point in points" :key="point.id" class="border-t">
          <td class="py-1">{{ point.propertyId }}</td>
          <td class="py-1">{{ pointRefTypeLabel(point.refType) }}</td>
          <td class="py-1">{{ point.rawAddress }}</td>
          <td class="py-1">{{ addressTypeLabel(point.addressType) }}</td>
          <td class="py-1">{{ registerDecodeText(point) }}</td>
          <td class="py-1">{{ point.pollIntervalMs ?? '-' }}</td>
          <td class="py-1">{{ accessModeLabel(point.rw) }}</td>
          <td class="py-1">
            <Tag :color="tagColor(point.enabled)">
              {{
                point.enabled === false
                  ? $t('common.disabled')
                  : $t('common.enabled')
              }}
            </Tag>
          </td>
          <td class="py-1">
            <div class="flex gap-1">
              <Button
                v-if="canUpdate"
                :data-testid="`point-edit-raw-${point.id}`"
                size="small"
                type="link"
                @click="emit('edit', point)"
              >
                {{ $t('page.iot.point.edit') }}
              </Button>
              <Popconfirm
                v-if="canDelete"
                :cancel-text="$t('page.iot.point.cancel')"
                :ok-text="$t('page.iot.point.okText')"
                :title="$t('page.iot.point.deleteConfirm', [point.rawAddress])"
                @confirm="emit('remove', point)"
              >
                <Button
                  :data-testid="`point-delete-raw-${point.id}`"
                  size="small"
                  type="link"
                  danger
                >
                  {{ $t('page.iot.point.delete') }}
                </Button>
              </Popconfirm>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>

  <template v-if="orphanPoints.length > 0">
    <div class="mt-4 mb-2 font-semibold">
      {{ $t('page.iot.point.orphanTitle') }}
    </div>
    <Alert
      :message="$t('page.iot.point.orphanHint')"
      show-icon
      type="warning"
    />
    <div class="mt-2 overflow-x-auto">
      <table
        class="w-full min-w-[480px] text-sm"
        data-testid="point-orphan-table"
      >
        <tbody>
          <tr v-for="point in orphanPoints" :key="point.id" class="border-t">
            <td class="py-1">{{ point.propertyId }}</td>
            <td class="py-1">{{ pointRefTypeLabel(point.refType) }}</td>
            <td class="py-1">{{ point.rawAddress }}</td>
            <td class="py-1">
              <Popconfirm
                v-if="canDelete"
                :cancel-text="$t('page.iot.point.cancel')"
                :ok-text="$t('page.iot.point.okText')"
                :title="$t('page.iot.point.deleteConfirm', [point.rawAddress])"
                @confirm="emit('remove', point)"
              >
                <Button size="small" type="link" danger>
                  {{ $t('page.iot.point.delete') }}
                </Button>
              </Popconfirm>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>
</template>
