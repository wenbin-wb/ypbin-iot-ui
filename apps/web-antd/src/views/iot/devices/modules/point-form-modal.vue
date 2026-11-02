<script lang="ts" setup>
import type { PointForm } from './point-mapping-state';

import type { IotPointApi } from '#/api/iot';

import { computed, reactive, ref } from 'vue';

import {
  Input,
  InputNumber,
  message,
  Modal,
  Radio,
  Select,
  Switch,
} from 'ant-design-vue';

import { createDevicePoint, updateDevicePoint } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import {
  applyRegisterFormat,
  buildPointPayload,
  emptyPointForm,
  formFromPoint,
  isModbusRegisterAddressType,
  normalizeRegisterFormat,
  POINT_ADDRESS_TYPES,
  POINT_BYTE_ORDERS,
  POINT_REF_TYPES,
  POINT_REGISTER_FORMATS,
  POINT_RW_OPTIONS,
  POINT_SIGNED_OPTIONS,
  POINT_WORD_COUNTS,
  resolvePointFormCheckMessage,
  validatePointForm,
} from './point-mapping-state';

/**
 * 点位映射「新增/编辑」弹窗（表单 + 寄存器联动 + 校验回显）。
 *
 * 为什么整块抽成组件：**26 个 computed 里有 18 个是寄存器表单联动**
 * （`isIntFormat/…/byteOrderEnabled/wordCountOptions`），它们只服务这一张表单。
 * 外置后宿主只剩「表格 + 数据 + 权限」，而表单联动仍保持一处、可独立演进。
 *
 * 表单校验与后端 `IotPointMappingReq` 逐条同口径（见 point-mapping-state）；
 * **联动语义只允许原样搬迁**（`applyRegisterFormat` 是纯函数，condition 语义未改）。
 *
 * 对外接口：`openCreate(propertyId?)` / `openEdit(point)` + `emit('saved')`
 * （保存成功后由宿主重新加载列表，本组件不碰列表数据）。
 */
const props = defineProps<{
  /** 设备 id（新增/编辑接口的路径参数）。 */
  deviceId: string;
  /** 属性下拉候选（值=属性主键；label 显示 identifier + 类型）。 */
  propertyOptions: { label: string; value: string }[];
}>();

const emit = defineEmits<{ saved: [] }>();

const modalOpen = ref(false);
/** null = 新增；否则为编辑中的点位。 */
const editing = ref<IotPointApi.PointMappingResp | null>(null);
const form = reactive<PointForm>(emptyPointForm());
const saving = ref(false);

const formOk = computed(() => validatePointForm(form).ok);
const formError = computed(() =>
  resolvePointFormCheckMessage(validatePointForm(form)),
);

const modalTitle = computed(() =>
  editing.value
    ? $t('page.iot.point.editTitle', [editing.value.propertyId])
    : $t('page.iot.point.createTitle'),
);

/**
 * 寄存器解码字段是否展示：只有保持/输入寄存器（holding|input）参与解码；
 * coil/discrete（位）与 nodeid/topic（非 Modbus）都不展示，也不下发。
 */
const showRegisterDecode = computed(() =>
  isModbusRegisterAddressType(form.addressType),
);

/** 形态兜底：缺字段按后端默认 int 回落（与 point-mapping-state 一致）。 */
const registerFormat = computed(() =>
  normalizeRegisterFormat(form.registerFormat),
);
const isIntFormat = computed(() => registerFormat.value === 'int');
const isFloatFormat = computed(() => registerFormat.value === 'float');
const isDoubleFormat = computed(() => registerFormat.value === 'double');
const isBitsFormat = computed(() => registerFormat.value === 'bits');
const isStringFormat = computed(() => registerFormat.value === 'string');

/**
 * int 下宽度可选（1|2）；float 固定 2、double 固定 4、bits 固定 1 ⇒ 置灰不可改
 * （string 走可编辑的数字输入）。
 */
const wordCountEditable = computed(() => isIntFormat.value);

/**
 * 宽度下拉的可选项：固定形态只给「它那一个」值（避免 int 用户误选 4）；
 * int 才给 1|2 两个选项。
 */
const wordCountOptions = computed(() => {
  if (isDoubleFormat.value) {
    return [{ labelKey: 'page.iot.point.wordCount4', value: '4' }];
  }
  if (isFloatFormat.value) {
    return [POINT_WORD_COUNTS[1]];
  }
  if (isBitsFormat.value) {
    return [POINT_WORD_COUNTS[0]];
  }
  return POINT_WORD_COUNTS;
});

/** 宽度字段标签：string 下语义是「寄存器个数」（1..32），其余是「寄存器宽度」。 */
const wordCountLabelKey = computed(() =>
  isStringFormat.value
    ? 'page.iot.point.wordCountString'
    : 'page.iot.point.wordCount',
);

/** 数值符号只属于 int（float/double/bits/string 后端要求 false 且不下发）。 */
const signedVisible = computed(
  () => showRegisterDecode.value && isIntFormat.value,
);

/** 字序：int（且 32 位）、float、double 生效；bits/string 后端忽略 ⇒ 不展示。 */
const byteOrderVisible = computed(
  () =>
    showRegisterDecode.value &&
    (isIntFormat.value || isFloatFormat.value || isDoubleFormat.value),
);

/** 位域输入只在 bits 展示。 */
const bitsVisible = computed(
  () => showRegisterDecode.value && isBitsFormat.value,
);

/** 字序在「float 固定 2 寄存器 / double 固定 4 寄存器」或「int 且 wordCount=2」时生效。 */
const byteOrderEnabled = computed(
  () =>
    byteOrderVisible.value &&
    (isFloatFormat.value || isDoubleFormat.value || form.wordCount === '2'),
);

/**
 * 字序下拉选项：double 的 little 是 **4 寄存器整体翻转（DCBA）**，与 2 寄存器的 CDAB 不同，
 * 故换成专用文案；big 两处共用（高字在前 ABCD）。
 */
const byteOrderOptions = computed(() =>
  POINT_BYTE_ORDERS.map((option) => ({
    ...option,
    labelKey:
      isDoubleFormat.value && option.value === 'little'
        ? 'page.iot.point.byteOrderLittleDouble'
        : option.labelKey,
  })),
);

/** 字序提示：double 需点明 DCBA（整体翻转）与「不支持 BADC/CDAB」。 */
const byteOrderHintKey = computed(() =>
  isDoubleFormat.value
    ? 'page.iot.point.byteOrderHintDouble'
    : 'page.iot.point.byteOrderHint',
);

/**
 * 形态切换：走纯函数 applyRegisterFormat 做联动清理（float 固定 2 寄存器 + 清 signed、
 * double 固定 4 寄存器 + 清 signed（保留字序）、bits 固定 1 寄存器 + 清字序、int 清位域），
 * 保证**界面所见即所发**。
 */
function onRegisterFormatChange() {
  Object.assign(form, applyRegisterFormat(form, form.registerFormat));
}

/**
 * 宽度切回 16 位时清掉已选字序（仅 int 需要；float 固定 2 不受影响）：
 * wordCount=1 时后端不接收 byteOrder，留着一个「看着像已保存」的值会误导用户。
 */
function onWordCountChange() {
  if (isIntFormat.value && form.wordCount !== '2') {
    form.byteOrder = undefined;
  }
}

function openCreate(propertyId?: string) {
  editing.value = null;
  const next = emptyPointForm();
  if (propertyId) {
    next.propertyId = propertyId;
  }
  Object.assign(form, next);
  modalOpen.value = true;
}

function openEdit(point: IotPointApi.PointMappingResp) {
  editing.value = point;
  Object.assign(form, formFromPoint(point));
  modalOpen.value = true;
}

async function save() {
  if (!formOk.value) {
    message.error(formError.value);
    return;
  }
  saving.value = true;
  try {
    if (editing.value) {
      await updateDevicePoint(
        String(props.deviceId),
        editing.value.id,
        buildPointPayload(String(props.deviceId), form),
      );
      message.success($t('page.iot.point.updateSuccess'));
    } else {
      await createDevicePoint(
        String(props.deviceId),
        buildPointPayload(String(props.deviceId), form),
      );
      message.success($t('page.iot.point.createSuccess'));
    }
    modalOpen.value = false;
    emit('saved');
  } catch (error) {
    message.error(extractErrorMessage(error, $t('page.iot.point.saveFailed')));
  } finally {
    saving.value = false;
  }
}

/** 宿主通过模板 ref 打开弹窗（不把表单状态暴露给宿主）。 */
defineExpose({ openCreate, openEdit });
</script>

<template>
  <!-- 新增/编辑 Modal（表单校验与后端同口径，见 point-mapping-state） -->
  <Modal
    v-model:open="modalOpen"
    :cancel-text="$t('page.iot.point.cancel')"
    :confirm-loading="saving"
    :ok-button-props="{ disabled: !formOk }"
    :ok-text="$t('page.iot.point.okText')"
    :title="modalTitle"
    @ok="save"
  >
    <div class="space-y-3">
      <div>
        <div class="mb-1 text-sm">
          {{ $t('page.iot.point.propertyId') }} /
          {{ $t('page.iot.point.refType') }}
        </div>
        <div class="flex gap-2">
          <Select
            v-model:value="form.propertyId"
            :options="propertyOptions"
            allow-clear
            class="w-full"
            data-testid="form-property-id"
            show-search
            :placeholder="$t('page.iot.point.propertyPlaceholder')"
          />
          <Select
            v-model:value="form.refType"
            class="w-36"
            data-testid="form-ref-type"
          >
            <Select.Option
              v-for="option in POINT_REF_TYPES"
              :key="option.value"
              :value="option.value"
            >
              {{ $t(option.labelKey) }}
            </Select.Option>
          </Select>
        </div>
      </div>
      <div>
        <div class="mb-1 text-sm">
          {{ $t('page.iot.point.rawAddress') }}
        </div>
        <Input
          v-model:value="form.rawAddress"
          data-testid="form-raw-address"
          :maxlength="128"
          :placeholder="$t('page.iot.point.rawAddressPlaceholder')"
        />
      </div>
      <div class="flex gap-2">
        <div class="w-1/2">
          <div class="mb-1 text-sm">
            {{ $t('page.iot.point.addressType') }}
          </div>
          <Select
            v-model:value="form.addressType"
            class="w-full"
            data-testid="form-address-type"
          >
            <Select.Option
              v-for="option in POINT_ADDRESS_TYPES"
              :key="option.value"
              :value="option.value"
            >
              {{ $t(option.labelKey) }}
            </Select.Option>
          </Select>
        </div>
        <div class="w-1/2">
          <div class="mb-1 text-sm">
            {{ $t('page.iot.point.pollIntervalMs') }}
          </div>
          <InputNumber
            v-model:value="form.pollIntervalMs"
            class="w-full"
            data-testid="form-poll-interval"
            :min="0"
            :placeholder="$t('page.iot.point.pollPlaceholder')"
          />
        </div>
      </div>
      <div class="flex gap-2">
        <div class="w-1/2">
          <div class="mb-1 text-sm">
            {{ $t('page.iot.point.scaleFactor') }}
          </div>
          <Input
            v-model:value="form.scaleFactor"
            data-testid="form-scale-factor"
            :placeholder="$t('page.iot.point.decimalPlaceholder')"
          />
        </div>
        <div class="w-1/2">
          <div class="mb-1 text-sm">
            {{ $t('page.iot.point.offsetValue') }}
          </div>
          <Input
            v-model:value="form.offsetValue"
            data-testid="form-offset-value"
            :placeholder="$t('page.iot.point.decimalPlaceholder')"
          />
        </div>
      </div>
      <!-- Modbus 寄存器解码 v2：仅保持/输入寄存器展示；位类型与非 Modbus 地址不展示 -->
      <div v-if="showRegisterDecode" class="space-y-3">
        <!-- 值形态 + 寄存器宽度（float 固定 2、double 固定 4、bits 固定 1 ⇒ 置灰不可改） -->
        <div class="flex gap-2">
          <div class="w-1/2">
            <div class="mb-1 text-sm">
              {{ $t('page.iot.point.registerFormat') }}
            </div>
            <Select
              v-model:value="form.registerFormat"
              class="w-full"
              data-testid="form-register-format"
              @change="onRegisterFormatChange"
            >
              <Select.Option
                v-for="option in POINT_REGISTER_FORMATS"
                :key="option.value"
                :value="option.value"
              >
                {{ $t(option.labelKey) }}
              </Select.Option>
            </Select>
          </div>
          <div class="w-1/2">
            <div class="mb-1 text-sm">
              {{ $t(wordCountLabelKey) }}
            </div>
            <!-- string：寄存器个数 1..32（多寄存器拼 UTF-8），可编辑数字输入 -->
            <InputNumber
              v-if="isStringFormat"
              v-model:value="form.wordCount"
              class="w-full"
              data-testid="form-word-count"
              :max="32"
              :min="1"
            />
            <Select
              v-else
              v-model:value="form.wordCount"
              class="w-full"
              data-testid="form-word-count"
              :disabled="!wordCountEditable"
              @change="onWordCountChange"
            >
              <Select.Option
                v-for="option in wordCountOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ $t(option.labelKey) }}
              </Select.Option>
            </Select>
            <div
              v-if="isFloatFormat"
              class="mt-1 text-xs text-muted-foreground"
            >
              {{ $t('page.iot.point.floatFixedTwoWords') }}
            </div>
            <div
              v-if="isDoubleFormat"
              class="mt-1 text-xs text-muted-foreground"
            >
              {{ $t('page.iot.point.doubleFixedFourWords') }}
            </div>
            <div
              v-if="isStringFormat"
              class="mt-1 text-xs text-muted-foreground"
            >
              {{ $t('page.iot.point.stringWordCountHint') }}
            </div>
          </div>
        </div>

        <!-- 数值符号（仅 int）/ 字序（int 32 位 与 float） -->
        <div v-if="signedVisible || byteOrderVisible" class="flex gap-2">
          <div
            v-if="signedVisible"
            class="w-1/2"
            data-testid="form-signed-group"
          >
            <div class="mb-1 text-sm">
              {{ $t('page.iot.point.signed') }}
            </div>
            <Radio.Group
              v-model:value="form.signed"
              button-style="solid"
              class="w-full"
            >
              <Radio.Button
                v-for="option in POINT_SIGNED_OPTIONS"
                :key="String(option.value)"
                :value="option.value"
              >
                {{ $t(option.labelKey) }}
              </Radio.Button>
            </Radio.Group>
          </div>
          <div v-if="byteOrderVisible" class="w-1/2">
            <div class="mb-1 text-sm">
              {{ $t('page.iot.point.byteOrder') }}
            </div>
            <Select
              v-model:value="form.byteOrder"
              allow-clear
              class="w-full"
              data-testid="form-byte-order"
              :disabled="!byteOrderEnabled"
              :placeholder="$t('page.iot.point.byteOrderPlaceholder')"
            >
              <Select.Option
                v-for="option in byteOrderOptions"
                :key="option.value"
                :value="option.value"
              >
                {{ $t(option.labelKey) }}
              </Select.Option>
            </Select>
            <div class="mt-1 text-xs text-muted-foreground">
              {{ $t(byteOrderHintKey) }}
            </div>
            <div
              v-if="!byteOrderEnabled"
              class="mt-1 text-xs text-warning-text"
            >
              {{ $t('page.iot.point.byteOrderOnlyFor32') }}
            </div>
          </div>
        </div>

        <!-- 位域（仅 bits）：起始位 + 位宽，后端必填 -->
        <template v-if="bitsVisible">
          <div class="flex gap-2">
            <div class="w-1/2">
              <div class="mb-1 text-sm">
                {{ $t('page.iot.point.bitOffset') }}
              </div>
              <InputNumber
                v-model:value="form.bitOffset"
                class="w-full"
                data-testid="form-bit-offset"
                :max="15"
                :min="0"
                :placeholder="$t('page.iot.point.bitOffsetPlaceholder')"
              />
            </div>
            <div class="w-1/2">
              <div class="mb-1 text-sm">
                {{ $t('page.iot.point.bitLength') }}
              </div>
              <InputNumber
                v-model:value="form.bitLength"
                class="w-full"
                data-testid="form-bit-length"
                :max="16"
                :min="1"
                :placeholder="$t('page.iot.point.bitLengthPlaceholder')"
              />
            </div>
          </div>
          <div class="text-xs text-muted-foreground">
            {{ $t('page.iot.point.bitsHint') }}
          </div>
        </template>
      </div>

      <!-- 读写权限 -->
      <div class="flex gap-2">
        <div class="w-1/2">
          <div class="mb-1 text-sm">
            {{ $t('page.iot.point.rw') }}
          </div>
          <Select v-model:value="form.rw" class="w-full" data-testid="form-rw">
            <Select.Option
              v-for="option in POINT_RW_OPTIONS"
              :key="option.value"
              :value="option.value"
            >
              {{ $t(option.labelKey) }}
            </Select.Option>
          </Select>
        </div>
      </div>
      <div class="flex items-center justify-between">
        <div class="text-sm">
          {{ $t('page.iot.point.enableSwitch') }}
        </div>
        <Switch v-model:checked="form.enabled" data-testid="form-enabled" />
      </div>
      <div
        v-if="!formOk"
        class="text-xs text-destructive-text"
        data-testid="form-error"
      >
        {{ formError }}
      </div>
    </div>
  </Modal>
</template>
