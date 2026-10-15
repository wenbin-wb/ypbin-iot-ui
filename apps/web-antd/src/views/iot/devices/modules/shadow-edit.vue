<script lang="ts" setup>
import { computed, ref } from 'vue';

import { useAccess } from '@vben/access';

import { Button, Input, message, Modal } from 'ant-design-vue';

import { updateDeviceShadow } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import {
  buildDesiredFromReported,
  desiredToEditableText,
  parseDesiredJson,
  resolveDesiredParseMessage,
  shadowDiffRows,
} from './shadow-state';

/**
 * 设备影子「期望值」编辑器 + 「以上报为准」一键应用（影子写入接线，本页唯一的 desired 写入口）。
 *
 * 后端 PUT /devices/{deviceId}/shadow（iot:shadow:update）整体替换 desired；
 * 输入为 JSON 文本，保存前由 parseDesiredJson 校验（必须对象，空文本 = 清空）。
 *
 * ⚠️ desired 是**目标配置**：保存后平台把它作为目标下发（消费方见后端设计）。
 * 界面只负责"编辑并保存"，成功与否的反馈必须明确；JSON 非法在**保存前**拦截。
 *
 * 一键应用刻意与手工编辑放在**同一个组件**里：两条路径都调同一支 PUT（整体替换），
 * 写口径只有一处；「以上报为准」的语义与理由见 `buildDesiredFromReported`。
 */
const props = defineProps<{
  deviceId: number | string;
  /** 当前期望值（编辑前回显）。 */
  initialDesired?: null | Record<string, unknown>;
  /** 当前上报值（一键应用的收敛依据）。 */
  reported?: null | Record<string, unknown>;
}>();

const emit = defineEmits<{ saved: [] }>();

const { hasAccessByCodes } = useAccess();
const canUpdate = computed(() => hasAccessByCodes(['iot:shadow:update']));

const open = ref(false);
const saving = ref(false);
const text = ref('{}');

/** 一键应用的二次确认弹窗（有损操作，必须显式确认）。 */
const applyOpen = ref(false);
const applying = ref(false);

/**
 * 打开编辑器（每次打开都以当前 desired 重新回显，避免 stale）。
 */
function openEditor() {
  text.value = desiredToEditableText(props.initialDesired);
  open.value = true;
}

/** 保存前校验（可实时提示，不等到提交）。 */
const parse = computed(() => parseDesiredJson(text.value));

async function save() {
  const result = parse.value;
  if (!result.ok) {
    message.error(resolveDesiredParseMessage(result));
    return;
  }
  saving.value = true;
  try {
    await updateDeviceShadow(String(props.deviceId), result.value);
    message.success($t('page.iot.shadow.desiredSaved'));
    open.value = false;
    emit('saved');
  } catch (error) {
    message.error(
      extractErrorMessage(error, $t('page.iot.shadow.desiredFailed')),
    );
  } finally {
    saving.value = false;
  }
}

/**
 * 待应用的 desired（以上报为准）。
 *
 * 与当前 desired 无变化时 {@link buildDesiredFromReported} 原样返回入参 ⇒ 这里按引用判等，
 * 命中就不再发无意义的 PUT（后端也会整体覆盖成同一份）。
 */
const applyTarget = computed(() => {
  const next = buildDesiredFromReported(props.reported, props.initialDesired);
  return next === props.initialDesired ? null : next;
});

/** 确认弹窗要展示的 reported 键数（与 buildDesiredFromReported 同一份数据）。 */
const reportedKeyCount = computed(
  () => Object.keys(props.reported ?? {}).length,
);

/** 与当前 desired 不一致的键数（0 表示已收敛，无需应用）。 */
const diffCount = computed(
  () =>
    shadowDiffRows(props.reported, props.initialDesired).filter(
      (row) => row.status !== 'match',
    ).length,
);

/** 点「一键应用」：无变化直接提示（不发请求），有变化才弹二次确认。 */
function openApply() {
  if (!applyTarget.value) {
    message.info($t('page.iot.shadow.diffNoChange'));
    return;
  }
  applyOpen.value = true;
}

/** 确认后以上报为准整体替换 desired（与手工编辑同一支 PUT）。 */
async function applyFromReported() {
  const next = applyTarget.value;
  if (!next) {
    applyOpen.value = false;
    message.info($t('page.iot.shadow.diffNoChange'));
    return;
  }
  applying.value = true;
  try {
    await updateDeviceShadow(String(props.deviceId), next);
    message.success($t('page.iot.shadow.diffApplied'));
    applyOpen.value = false;
    emit('saved');
  } catch (error) {
    message.error(
      extractErrorMessage(error, $t('page.iot.shadow.desiredFailed')),
    );
  } finally {
    applying.value = false;
  }
}
</script>

<template>
  <Button v-if="canUpdate" size="small" @click="openEditor">
    {{ $t('page.iot.shadow.editDesired') }}
  </Button>

  <!--
    一键应用：与手工编辑同一权限码、同一 PUT；有差异才可点（无差异置灰并给出原因），
    点击后必须经二次确认 —— 该操作会剔除 reported 中没有的期望键，是有损的。
  -->
  <Button
    v-if="canUpdate"
    data-testid="shadow-apply-button"
    :disabled="diffCount === 0"
    size="small"
    @click="openApply"
  >
    {{ $t('page.iot.shadow.diffApply') }}
  </Button>

  <Modal
    v-model:open="open"
    :title="$t('page.iot.shadow.editDesiredTitle')"
    :ok-text="$t('page.iot.shadow.update')"
    :cancel-text="$t('page.iot.shadow.cancel')"
    :ok-button-props="{ disabled: !parse.ok }"
    :confirm-loading="saving"
    @ok="save"
  >
    <div class="space-y-2">
      <Input.TextArea
        v-model:value="text"
        :rows="10"
        :placeholder="$t('page.iot.shadow.desiredPlaceholder')"
      />
      <div v-if="!parse.ok" class="text-xs text-red-500">
        {{ resolveDesiredParseMessage(parse) }}
      </div>
      <div class="text-xs text-muted-foreground">
        {{ $t('page.iot.shadow.desiredHint') }}
      </div>
    </div>
  </Modal>

  <Modal
    v-model:open="applyOpen"
    :cancel-text="$t('page.iot.shadow.cancel')"
    :confirm-loading="applying"
    :ok-text="$t('page.iot.shadow.diffApplyOk')"
    :title="$t('page.iot.shadow.diffApplyTitle')"
    @ok="applyFromReported"
  >
    <p>
      {{ $t('page.iot.shadow.diffApplyConfirm', [reportedKeyCount]) }}
    </p>
  </Modal>
</template>
