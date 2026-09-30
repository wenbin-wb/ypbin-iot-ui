<script lang="ts" setup>
import { computed, ref } from 'vue';

import { useAccess } from '@vben/access';

import { Button, Input, message, Modal } from 'ant-design-vue';

import { updateDeviceShadow } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { desiredToEditableText, parseDesiredJson } from './shadow-state';

/**
 * 设备影子「期望值」编辑器（看板 #13：影子写入接线）。
 *
 * 后端 PUT /devices/{deviceId}/shadow（iot:shadow:update）整体替换 desired；
 * 输入为 JSON 文本，保存前由 parseDesiredJson 校验（必须对象，空文本 = 清空）。
 *
 * ⚠️ desired 是**目标配置**：保存后平台把它作为目标下发（消费方见后端设计）。
 * 界面只负责"编辑并保存"，成功与否的反馈必须明确；JSON 非法在**保存前**拦截。
 */
const props = defineProps<{
  deviceId: number | string;
  /** 当前期望值（编辑前回显）。 */
  initialDesired?: null | Record<string, unknown>;
}>();

const emit = defineEmits<{ saved: [] }>();

const { hasAccessByCodes } = useAccess();
const canUpdate = computed(() => hasAccessByCodes(['iot:shadow:update']));

const open = ref(false);
const saving = ref(false);
const text = ref('{}');

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
  if (!parse.value.ok) {
    message.error(parse.value.message);
    return;
  }
  saving.value = true;
  try {
    await updateDeviceShadow(String(props.deviceId), parse.value.value ?? {});
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
</script>

<template>
  <Button v-if="canUpdate" size="small" @click="openEditor">
    {{ $t('page.iot.shadow.editDesired') }}
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
        {{ parse.message }}
      </div>
      <div class="text-xs text-muted-foreground">
        {{ $t('page.iot.shadow.desiredHint') }}
      </div>
    </div>
  </Modal>
</template>
