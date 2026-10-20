<script lang="ts" setup>
import type { ErrorDetail } from './debug-status';
import type { SetRow } from './use-debug-fanout';

import type { IotCommandApi } from '#/api/iot';

import {
  Alert,
  Button,
  Checkbox,
  Input,
  InputNumber,
  Select,
  SelectOption,
  Textarea,
  Tooltip,
} from 'ant-design-vue';

import { $t } from '#/locales';

/**
 * 「在线调试」的下发区（动作 + 参数 + 下发按钮 + 校验/后端失败提示）。
 *
 * 从 `detail-debug.vue` 拆出（2026-10-20 架构审查 §2.2）：本块是 230 行纯展示 + 双向绑定，
 * 状态与校验都在 `use-debug-command` / `use-debug-fanout` 里；组件本身只负责**把控件接起来**。
 *
 * 纪律（原样保留）：
 * - `data-testid` 是行为用例的锚点（`debug-set-identifier-N`/`debug-set-value-N`/
 *   `debug-write-desired`/`debug-send`），不得改名；
 * - **客户端校验（warning）与后端失败（error）分开**：后者必须原样展示后端 `message`，
 *   并可展开看 `code` 与原始信封；
 * - 达 fanout 上限时按钮禁用**并说明上限**（否则用户只看到「点不动」）；
 * - `writeDesired` 只在属性设置下出现（其它 kind 后端会显式拒绝）。
 */
withDefaults(
  defineProps<{
    /** 下发按钮权限（`iot:debug:send`）。 */
    canSendCommand?: boolean;
    /** 服务调用可选命令。 */
    commandOptions?: { label: string; value: string }[];
    /** 客户端校验提示（warning，不是后端失败）。 */
    formError?: string;
    /** 属性读取可选点位。 */
    getPropertyOptions?: { label: string; value: string }[];
    /** 属性读取已选点位（空 = 全部可读）。 */
    getSelection?: string[];
    /** 当前动作。 */
    kind?: IotCommandApi.CommandKindCode;
    /** 一次下发最多拆几条（与纯函数上限同源）。 */
    maxFanout?: number;
    /** 后端超时上限（毫秒）。 */
    maxTimeoutMs?: number;
    /** 服务调用 params（JSON 对象文本）。 */
    paramsText?: string;
    /** 后端失败详情（原样 message + 可展开 code/信封）。 */
    sendError?: ErrorDetail;
    /** 是否在途（按钮 loading）。 */
    sending?: boolean;
    /** 服务调用选中的命令标识。 */
    serviceIdentifier?: string;
    /** 属性设置的目标点位候选。 */
    setPropertyOptions?: { label: string; value: string }[];
    /** 属性设置的点位 → 值行。 */
    setRows?: SetRow[];
    /** 超时（毫秒；空 = 后端默认）。 */
    timeoutMs?: number;
    /** 是否同时写影子期望值（仅 `property_set`）。 */
    writeDesired?: boolean;
  }>(),
  {
    canSendCommand: false,
    commandOptions: () => [],
    formError: '',
    getPropertyOptions: () => [],
    getSelection: () => [],
    kind: 'property_set',
    maxFanout: 20,
    maxTimeoutMs: 60 * 60 * 1000,
    paramsText: '',
    sendError: undefined,
    sending: false,
    serviceIdentifier: undefined,
    setPropertyOptions: () => [],
    setRows: () => [],
    timeoutMs: undefined,
    writeDesired: false,
  },
);

const emit = defineEmits<{
  addRow: [];
  getSelectionChange: [value: string[]];
  kindChange: [];
  paramsTextChange: [value: string];
  removeRow: [index: number];
  send: [];
  serviceIdentifierChange: [value: string | undefined];
  timeoutChange: [value: null | number | string | undefined];
  updateKind: [value: IotCommandApi.CommandKindCode];
  updateRow: [row: SetRow, field: 'identifier' | 'value', value: string | undefined];
  writeDesiredChange: [value: boolean];
}>();

/** 属性设置行的点位/值走 `update:row` 事件（不直接改 prop 里的对象，保持单向数据流）。 */
function onRowIdentifierChange(row: SetRow, value: unknown) {
  emit('updateRow', row, 'identifier', value as string | undefined);
}

function onRowValueChange(row: SetRow, value: unknown) {
  emit('updateRow', row, 'value', value as string);
}
</script>

<template>
  <div class="rounded border border-solid p-3">
    <div class="mb-2 font-semibold">
      {{ $t('page.iot.debug.sendTitle') }}
    </div>

    <div class="mb-3 flex flex-wrap items-center gap-2">
      <span>{{ $t('page.iot.debug.kind') }}</span>
      <Select
        :value="kind"
        style="width: 160px"
        @change="
          (value) => {
            emit('updateKind', value as IotCommandApi.CommandKindCode);
            emit('kindChange');
          }
        "
      >
        <SelectOption value="property_set">
          {{ $t('page.iot.debug.kindPropertySet') }}
        </SelectOption>
        <SelectOption value="property_get">
          {{ $t('page.iot.debug.kindPropertyGet') }}
        </SelectOption>
        <SelectOption value="service_call">
          {{ $t('page.iot.debug.kindServiceCall') }}
        </SelectOption>
      </Select>

      <span class="ml-2">{{ $t('page.iot.debug.timeout') }}</span>
      <InputNumber
        :value="timeoutMs as number"
        :max="maxTimeoutMs"
        :min="1"
        :placeholder="$t('page.iot.debug.timeoutPlaceholder')"
        style="width: 150px"
        @update:value="(value) => emit('timeoutChange', value)"
      />
    </div>
    <div class="mb-3 text-xs text-muted-foreground">
      {{ $t('page.iot.debug.timeoutHint') }}
    </div>

    <!-- 属性设置：点位 → 值（后端一条指令只接一个标识，多行会拆成多条） -->
    <template v-if="kind === 'property_set'">
      <div
        v-for="(row, index) in setRows"
        :key="row.key"
        class="mb-2 flex flex-wrap items-center gap-2"
      >
        <Select
          :value="row.identifier"
          :options="setPropertyOptions"
          :placeholder="$t('page.iot.debug.propertyPlaceholder')"
          :data-testid="`debug-set-identifier-${index}`"
          option-filter-prop="label"
          show-search
          style="width: 380px"
          @update:value="(value) => onRowIdentifierChange(row, value)"
        />
        <Input
          :value="row.value"
          :placeholder="$t('page.iot.debug.valuePlaceholder')"
          :data-testid="`debug-set-value-${index}`"
          style="width: 220px"
          @update:value="(value) => onRowValueChange(row, value)"
        />
        <Button
          v-if="setRows.length > 1"
          danger
          size="small"
          @click="emit('removeRow', index)"
        >
          {{ $t('page.iot.debug.removeRow') }}
        </Button>
      </div>
      <!-- 达上限禁用并说明上限（否则用户只会看到「按钮点不动」） -->
      <Tooltip
        :title="
          setRows.length >= maxFanout
            ? $t('page.iot.debug.fanoutHint', [String(maxFanout)])
            : ''
        "
      >
        <span
          :tabindex="setRows.length >= maxFanout ? 0 : -1"
          class="inline-block"
        >
          <Button
            :disabled="setRows.length >= maxFanout"
            size="small"
            @click="emit('addRow')"
          >
            {{ $t('page.iot.debug.addRow') }}
          </Button>
        </span>
      </Tooltip>
      <div class="mt-1 text-xs text-muted-foreground">
        {{ $t('page.iot.debug.valueHint') }}
      </div>
      <div v-if="setRows.length > 1" class="mt-1 text-xs text-warning-text">
        {{ $t('page.iot.debug.fanoutHint', [String(maxFanout)]) }}
      </div>
      <!--
        writeDesired：仅属性设置提供。勾选后命令下发成功的同时把该值写入影子 desired，
        便于用「期望 vs 上报」核对设置是否真的生效。不勾选则不带该字段。
      -->
      <div class="mt-2 flex flex-col gap-1">
        <Checkbox
          :checked="writeDesired"
          data-testid="debug-write-desired"
          @update:checked="(value) => emit('writeDesiredChange', Boolean(value))"
        >
          {{ $t('page.iot.device.batchCommand.writeDesired') }}
        </Checkbox>
        <span class="text-xs text-muted-foreground">
          {{ $t('page.iot.debug.writeDesiredHint') }}
        </span>
      </div>
    </template>

    <!-- 属性读取：可多选；留空 = 全部可读属性 -->
    <template v-else-if="kind === 'property_get'">
      <Select
        :value="getSelection"
        :options="getPropertyOptions"
        :placeholder="$t('page.iot.debug.getPropertiesPlaceholder')"
        mode="multiple"
        option-filter-prop="label"
        show-search
        style="width: 100%"
        @update:value="(value) => emit('getSelectionChange', value as string[])"
      />
      <div v-if="getPropertyOptions.length === 0" class="mt-1 text-xs">
        {{ $t('page.iot.debug.noProperty') }}
      </div>
      <Alert
        :message="$t('page.iot.debug.getAllHint')"
        class="mt-2"
        show-icon
        type="info"
      />
      <div v-if="getSelection.length > 1" class="mt-1 text-xs text-warning-text">
        {{ $t('page.iot.debug.fanoutHint', [String(maxFanout)]) }}
      </div>
    </template>

    <!-- 服务调用：命令标识 + params（必须是 JSON 对象） -->
    <template v-else>
      <Select
        :value="serviceIdentifier"
        :options="commandOptions"
        :placeholder="$t('page.iot.debug.servicePlaceholder')"
        option-filter-prop="label"
        show-search
        style="width: 100%"
        @update:value="(value) => emit('serviceIdentifierChange', value as string)"
      />
      <div v-if="commandOptions.length === 0" class="mt-1 text-xs">
        {{ $t('page.iot.debug.noCommand') }}
      </div>
      <div class="mt-2 mb-1 text-xs text-muted-foreground">
        {{ $t('page.iot.debug.params') }}
      </div>
      <Textarea
        :value="paramsText"
        :placeholder="$t('page.iot.debug.paramsPlaceholder')"
        :rows="4"
        class="font-mono"
        @update:value="(value) => emit('paramsTextChange', String(value))"
      />
      <div class="mt-1 text-xs text-muted-foreground">
        {{ $t('page.iot.debug.paramsHint') }}
      </div>
    </template>

    <div class="mt-3 flex flex-wrap items-center gap-2">
      <Button
        v-if="canSendCommand"
        data-testid="debug-send"
        :loading="sending"
        type="primary"
        @click="emit('send')"
      >
        {{ sending ? $t('page.iot.debug.sending') : $t('page.iot.debug.send') }}
      </Button>
    </div>

    <!-- 客户端校验（warning）：与「后端失败」分开，后者一定原样展示后端 message -->
    <Alert
      v-if="formError"
      :message="formError"
      class="mt-2"
      show-icon
      type="warning"
    />

    <!-- 后端失败（error）：原样展示 message，并保留原始 code / 信封供展开查看 -->
    <Alert
      v-if="sendError"
      :message="sendError.message"
      class="mt-2"
      show-icon
      type="error"
    >
      <template #description>
        <div>
          {{ $t('page.iot.debug.rawEnvelope') }}:
          <span class="font-mono">{{ sendError.code || '-' }}</span>
        </div>
        <pre
          class="mt-1 max-h-[240px] overflow-auto text-xs break-all whitespace-pre-wrap"
          >{{ sendError.raw }}</pre>
      </template>
    </Alert>
  </div>
</template>
