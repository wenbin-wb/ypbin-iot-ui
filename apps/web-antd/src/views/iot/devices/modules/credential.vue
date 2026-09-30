<script lang="ts" setup>
import type { IotCredentialApi } from '#/api/iot';

import { computed, onMounted, ref } from 'vue';

import { useAccess } from '@vben/access';

import {
  Alert,
  Button,
  Empty,
  message,
  Modal,
  Popconfirm,
  Spin,
  Tag,
} from 'ant-design-vue';

import {
  getDeviceConnection,
  getDeviceCredential,
  issueDeviceCredential,
  revokeDeviceCredential,
} from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import {
  brokerLabel,
  canReissue,
  resolveCredentialState,
  versionLabel,
} from './credential-state';

/**
 * 设备凭据区块（看板 #13：死能力接线最后一项，MQTT 接入）。
 *
 * **安全契约（一次性做到位）**：
 *   ① 明文 password 只出现在签发响应当次 —— 组件不持久化、不二次回读；
 *   ② 查看只展示元信息与连接参数（后端哈希存储，回读不了密码）；
 *   ③ 重置签发 / 吊销均为破坏性动作，一律 Popconfirm；
 *   ④ 入口分别按 iot:credential:issue/get/revoke 权限显示。
 */
const props = defineProps<{
  deviceId: number | string;
}>();

const { hasAccessByCodes } = useAccess();
const canIssue = computed(() => hasAccessByCodes(['iot:credential:issue']));
const canGet = computed(() => hasAccessByCodes(['iot:credential:get']));
const canRevoke = computed(() => hasAccessByCodes(['iot:credential:revoke']));

const loading = ref(false);
const errorMessage = ref('');
const credential = ref<IotCredentialApi.CredentialResp>();
const connection = ref<IotCredentialApi.ConnectionResp>();

const state = computed(() =>
  resolveCredentialState(loading.value, errorMessage.value, credential.value),
);

// ---------- 签发结果 Modal（明文仅此一次） ----------
const issuedOpen = ref(false);
const issuedResult = ref<IotCredentialApi.IssuedResp>();

// ---------- 查看/连接参数 Modal ----------
const viewOpen = ref(false);

async function load() {
  if (!props.deviceId) {
    return;
  }
  loading.value = true;
  errorMessage.value = '';
  const [credentialResult, connectionResult] = await Promise.allSettled([
    getDeviceCredential(String(props.deviceId)),
    getDeviceConnection(String(props.deviceId)),
  ]);
  if (credentialResult.status === 'fulfilled') {
    credential.value = credentialResult.value;
  } else {
    credential.value = undefined;
    errorMessage.value = extractErrorMessage(
      credentialResult.reason,
      $t('page.iot.credential.loadFailed'),
    );
  }
  connection.value =
    connectionResult.status === 'fulfilled'
      ? connectionResult.value
      : undefined;
  loading.value = false;
}

async function issue() {
  try {
    issuedResult.value = await issueDeviceCredential(String(props.deviceId));
    issuedOpen.value = true;
    message.success($t('page.iot.credential.issueSuccess'));
    await load();
  } catch (error) {
    message.error(
      extractErrorMessage(error, $t('page.iot.credential.issueFailed')),
    );
  }
}

async function revoke() {
  try {
    await revokeDeviceCredential(String(props.deviceId));
    message.success($t('page.iot.credential.revokeSuccess'));
    await load();
  } catch (error) {
    message.error(
      extractErrorMessage(error, $t('page.iot.credential.revokeFailed')),
    );
  }
}

function openView() {
  viewOpen.value = true;
}

/** 复制（password 附带一次性警示文案）。 */
async function copyText(text: string, isPassword: boolean) {
  try {
    await navigator.clipboard.writeText(text);
    message.success(
      isPassword
        ? $t('page.iot.credential.passwordCopied')
        : $t('page.iot.credential.copied'),
    );
  } catch {
    message.error($t('page.iot.credential.copyFailed'));
  }
}

onMounted(() => {
  if (canGet.value) {
    void load();
  }
});
</script>
<template>
  <Spin :spinning="loading">
    <div class="mb-2 flex items-center justify-between">
      <span class="font-semibold">
        {{ $t('page.iot.credential.title') }}
      </span>
      <div class="flex gap-1">
        <Button
          v-if="canGet && state !== 'none' && state !== 'error'"
          size="small"
          @click="openView"
        >
          {{ $t('page.iot.credential.view') }}
        </Button>
        <Button
          v-if="state === 'none' && canIssue"
          size="small"
          type="primary"
          @click="issue"
        >
          {{ $t('page.iot.credential.issue') }}
        </Button>
        <Button
          v-if="canReissue(state) && canIssue"
          size="small"
          @click="issue"
        >
          {{ $t('page.iot.credential.reissue') }}
        </Button>
        <Popconfirm
          v-if="state === 'issued' && canRevoke"
          :title="$t('page.iot.credential.revokeConfirm')"
          :ok-text="$t('page.iot.credential.revoke')"
          :cancel-text="$t('page.iot.credential.cancel')"
          @confirm="revoke"
        >
          <Button size="small" type="link" danger>
            {{ $t('page.iot.credential.revoke') }}
          </Button>
        </Popconfirm>
      </div>
    </div>

    <Alert
      v-if="state === 'error'"
      :message="$t('page.iot.credential.loadFailed')"
      show-icon
      type="error"
    />

    <Alert
      v-if="state === 'none'"
      :message="$t('page.iot.credential.noneHint')"
      show-icon
      type="info"
    />

    <Alert
      v-if="state === 'revoked'"
      :message="$t('page.iot.credential.revokedHint')"
      show-icon
      type="warning"
    />

    <div
      v-if="state === 'issued' || state === 'revoked'"
      class="space-y-1 text-sm"
    >
      <div class="flex items-center gap-2">
        <Tag :color="state === 'issued' ? 'success' : 'default'">
          {{
            state === 'issued'
              ? $t('page.iot.credential.valid')
              : $t('page.iot.credential.revoked')
          }}
        </Tag>
        <span>
          {{ $t('page.iot.credential.username') }}:
          {{ credential?.username ?? '-' }}
        </span>
        <span>
          {{ $t('page.iot.credential.version') }}:
          {{ versionLabel(credential?.credentialVersion) }}
        </span>
      </div>
      <div class="text-xs text-muted-foreground">
        {{ $t('page.iot.credential.issuedAt') }}:
        {{ credential?.credentialIssuedAt ?? '-' }}
      </div>
    </div>

    <Empty
      v-if="!canGet"
      :description="$t('page.iot.credential.noPermission')"
    />
  </Spin>

  <!-- 签发结果 Modal：明文仅此一次 -->
  <Modal
    v-model:open="issuedOpen"
    :title="$t('page.iot.credential.issueResult')"
    :footer="null"
  >
    <Alert
      :message="$t('page.iot.credential.oneTime')"
      show-icon
      type="warning"
    />
    <div class="mt-3 space-y-2 text-sm">
      <div>
        {{ $t('page.iot.credential.username') }}:
        <span class="font-mono">{{ issuedResult?.username }}</span>
      </div>
      <div>
        {{ $t('page.iot.credential.password') }}:
        <span class="font-mono text-base">{{ issuedResult?.password }}</span>
        <Button
          size="small"
          class="ml-2"
          @click="copyText(issuedResult?.password ?? '', true)"
        >
          {{ $t('page.iot.credential.copy') }}
        </Button>
      </div>
      <div>
        {{ $t('page.iot.credential.version') }}:
        {{ versionLabel(issuedResult?.credentialVersion) }}
      </div>
      <div>
        {{ $t('page.iot.credential.issuedAt') }}:
        {{ issuedResult?.credentialIssuedAt ?? '-' }}
      </div>
      <div v-if="connection" class="border-t pt-2">
        <div class="font-semibold">
          {{ $t('page.iot.credential.connection') }}
        </div>
        <div>
          {{ $t('page.iot.credential.broker') }}: {{ brokerLabel(connection) }}
        </div>
        <div>
          {{ $t('page.iot.credential.clientId') }}:
          <span class="font-mono">{{ connection.clientId }}</span>
        </div>
        <div>
          {{ $t('page.iot.credential.topicUp') }}:
          <span class="font-mono">{{ connection.topicUpPrefix }}</span>
        </div>
        <div>
          {{ $t('page.iot.credential.topicDown') }}:
          <span class="font-mono">{{ connection.topicDownPrefix }}</span>
        </div>
      </div>
    </div>
  </Modal>

  <!-- 查看 Modal：元信息 + 连接参数（不含明文） -->
  <Modal
    v-model:open="viewOpen"
    :title="$t('page.iot.credential.view')"
    :footer="null"
  >
    <div class="space-y-2 text-sm">
      <div>
        {{ $t('page.iot.credential.username') }}:
        {{ credential?.username ?? '-' }}
      </div>
      <div>
        {{ $t('page.iot.credential.version') }}:
        {{ versionLabel(credential?.credentialVersion) }}
      </div>
      <div>
        {{ $t('page.iot.credential.issuedAt') }}:
        {{ credential?.credentialIssuedAt ?? '-' }}
      </div>
      <div>
        {{ $t('page.iot.credential.revokedAt') }}:
        {{ credential?.credentialRevokedAt ?? '-' }}
      </div>
      <div class="border-t pt-2">
        <div class="font-semibold">
          {{ $t('page.iot.credential.connection') }}
        </div>
        <template v-if="connection">
          <div>
            {{ $t('page.iot.credential.broker') }}:
            {{ brokerLabel(connection) }}
          </div>
          <div>
            {{ $t('page.iot.credential.clientId') }}:
            <span class="font-mono">{{ connection.clientId }}</span>
          </div>
          <div>
            {{ $t('page.iot.credential.topicUp') }}:
            <span class="font-mono">{{ connection.topicUpPrefix }}</span>
          </div>
          <div>
            {{ $t('page.iot.credential.topicDown') }}:
            <span class="font-mono">{{ connection.topicDownPrefix }}</span>
          </div>
          <div
            v-if="!connection.emqxEnabled"
            class="mt-2 text-xs text-muted-foreground"
          >
            {{ $t('page.iot.credential.emqxDisabled') }}
          </div>
        </template>
        <div v-else class="text-xs text-muted-foreground">
          {{ $t('page.iot.credential.connectionUnavailable') }}
        </div>
      </div>
    </div>
  </Modal>
</template>
