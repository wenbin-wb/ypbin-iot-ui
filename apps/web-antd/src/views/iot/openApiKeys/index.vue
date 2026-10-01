<script lang="ts" setup>
import type { Dayjs } from 'dayjs';

import type { IotOpenApiKeyApi } from '#/api/iot';

import { computed, onMounted, ref } from 'vue';

import { useAccess } from '@vben/access';

import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Empty,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Spin,
  Tag,
} from 'ant-design-vue';

import { createOpenApiKey, getOpenApiKeys, revokeOpenApiKey } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import {
  checkOpenApiKeyForm,
  normalizeOpenApiKeyForm,
  OPEN_API_ALLOWED_SCOPES,
  OPEN_API_DANGEROUS_SCOPE,
  openApiKeyScopesLabel,
  openApiKeyStatusColor,
  openApiKeyStatusLabelKey,
  openApiKeyTimeLabel,
  resolveOpenApiKeyListState,
} from './open-api-key-state';

/**
 * 开放 API Key 管理页（看板 #11 第 3 批；菜单 /iot/open-api-keys，权限 iot:openapi:key-*）。
 *
 * 后端契约（OpenApiKeyController）只有三端点：创建/列表/吊销（无更新）。
 * 本页一次做到位：
 *   ① 列表（prefix/appName/scopes/status/expireAt/lastUsedAt，失败态与空态分离）；
 *   ② 签发 Modal（应用名+作用域多选+配额+过期时间，校验与后端同口径；
 *      明文 secret 仅在签发结果 Modal 展示一次，可复制，不持久化）；
 *   ③ 吊销 Popconfirm 二次确认（仅启用态可点）；
 *   ④ 入口分别按 key-list/key-create/key-revoke 显示。
 */
const { hasAccessByCodes } = useAccess();
const canList = computed(() => hasAccessByCodes(['iot:openapi:key-list']));
const canCreate = computed(() => hasAccessByCodes(['iot:openapi:key-create']));
const canRevoke = computed(() => hasAccessByCodes(['iot:openapi:key-revoke']));

const loading = ref(false);
const errorMessage = ref('');
const rows = ref<IotOpenApiKeyApi.KeyItem[]>([]);

const listState = computed(() =>
  resolveOpenApiKeyListState(
    loading.value,
    errorMessage.value,
    rows.value.length,
  ),
);

// ---------- 创建表单 ----------
const createOpen = ref(false);
const formAppName = ref('');
const formScopes = ref<string[]>(['iot:series:get']);
const formQps = ref<number | undefined>(10);
const formQuota = ref<number | undefined>(100_000);
const formExpireAt = ref<Dayjs>();
const creating = ref(false);

// ---------- 签发结果（明文仅此一次） ----------
const issuedOpen = ref(false);
const issuedResult = ref<IotOpenApiKeyApi.CreateResp>();

async function load() {
  loading.value = true;
  errorMessage.value = '';
  try {
    rows.value = (await getOpenApiKeys()) ?? [];
  } catch (error) {
    rows.value = [];
    errorMessage.value = extractErrorMessage(
      error,
      $t('page.iot.openApiKey.loadFailed'),
    );
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  formAppName.value = '';
  formScopes.value = ['iot:series:get'];
  formQps.value = 10;
  formQuota.value = 100_000;
  formExpireAt.value = undefined;
  createOpen.value = true;
}

async function submitCreate() {
  const check = checkOpenApiKeyForm(
    formAppName.value,
    formScopes.value,
    formQps.value,
    formQuota.value,
  );
  if (!check.ok) {
    message.error($t('page.iot.openApiKey.saveFailed'));
    return;
  }
  const normalized = normalizeOpenApiKeyForm(
    formAppName.value,
    formScopes.value,
  );
  creating.value = true;
  try {
    issuedResult.value = await createOpenApiKey({
      appName: normalized.appName,
      scopes: normalized.scopes,
      rateLimitQps: formQps.value,
      dailyQuota: formQuota.value,
      expireAt: formExpireAt.value
        ? formExpireAt.value.format('YYYY-MM-DD HH:mm:ss')
        : undefined,
    });
    createOpen.value = false;
    issuedOpen.value = true;
    message.success($t('page.iot.openApiKey.createSuccess'));
    await load();
  } catch (error) {
    message.error(
      extractErrorMessage(error, $t('page.iot.openApiKey.saveFailed')),
    );
  } finally {
    creating.value = false;
  }
}

async function revoke(row: IotOpenApiKeyApi.KeyItem) {
  try {
    await revokeOpenApiKey(row.id);
    message.success($t('page.iot.openApiKey.revokeSuccess'));
    await load();
  } catch (error) {
    message.error(
      extractErrorMessage(error, $t('page.iot.openApiKey.revokeFailed')),
    );
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    message.success($t('page.iot.openApiKey.copied'));
  } catch {
    message.error($t('page.iot.openApiKey.copyFailed'));
  }
}

onMounted(() => {
  if (canList.value) {
    void load();
  }
});
</script>

<template>
  <div v-if="canList" class="p-3">
    <div class="mb-3 flex items-center gap-3">
      <div class="font-semibold">
        {{ $t('page.iot.openApiKey.title') }}
      </div>
      <Button v-if="canCreate" type="primary" size="small" @click="openCreate">
        {{ $t('page.iot.openApiKey.create') }}
      </Button>
      <span class="text-xs text-muted-foreground">{{ rows.length }}</span>
    </div>

    <Spin :spinning="loading">
      <Alert
        v-if="listState === 'error'"
        type="error"
        show-icon
        :message="$t('page.iot.openApiKey.loadFailed')"
        :description="errorMessage"
      />

      <Empty
        v-if="listState === 'empty'"
        :description="$t('page.iot.openApiKey.empty')"
      />

      <table v-if="listState === 'ready'" class="w-full text-sm">
        <thead>
          <tr class="text-left text-gray-500">
            <th class="py-1">{{ $t('page.iot.openApiKey.appName') }}</th>
            <th class="py-1">{{ $t('page.iot.openApiKey.accessKey') }}</th>
            <th class="py-1">{{ $t('page.iot.openApiKey.prefix') }}</th>
            <th class="py-1">{{ $t('page.iot.openApiKey.scopes') }}</th>
            <th class="py-1">{{ $t('page.iot.openApiKey.status') }}</th>
            <th class="py-1">{{ $t('page.iot.openApiKey.expireAt') }}</th>
            <th class="py-1">{{ $t('page.iot.openApiKey.lastUsed') }}</th>
            <th class="py-1">{{ $t('page.iot.openApiKey.action') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id" class="border-t">
            <td class="py-1">{{ row.appName }}</td>
            <td class="py-1 font-mono text-xs">{{ row.accessKeyId }}</td>
            <td class="py-1 font-mono text-xs">{{ row.secretPrefix }}</td>
            <td class="max-w-64 truncate py-1 font-mono text-xs">
              {{ openApiKeyScopesLabel(row.scopes) }}
            </td>
            <td class="py-1">
              <Tag :color="openApiKeyStatusColor(row.status)">
                {{ $t(openApiKeyStatusLabelKey(row.status)) }}
              </Tag>
            </td>
            <td class="py-1">{{ openApiKeyTimeLabel(row.expireAt) }}</td>
            <td class="py-1">{{ openApiKeyTimeLabel(row.lastUsedAt) }}</td>
            <td class="py-1">
              <Popconfirm
                v-if="canRevoke && row.status === 1"
                :title="$t('page.iot.openApiKey.revokeConfirm')"
                :ok-text="$t('page.iot.openApiKey.revoke')"
                :cancel-text="$t('page.iot.openApiKey.cancel')"
                @confirm="revoke(row)"
              >
                <Button size="small" type="link" danger>
                  {{ $t('page.iot.openApiKey.revoke') }}
                </Button>
              </Popconfirm>
              <span v-else class="text-xs text-muted-foreground">-</span>
            </td>
          </tr>
        </tbody>
      </table>
    </Spin>

    <div v-if="!canList" class="p-4 text-sm text-muted-foreground">
      {{ $t('page.iot.openApiKey.noPermission') }}
    </div>
  </div>

  <!-- 创建 Modal -->
  <Modal
    v-model:open="createOpen"
    :title="$t('page.iot.openApiKey.createTitle')"
    :confirm-loading="creating"
    :ok-text="$t('page.iot.openApiKey.create')"
    :cancel-text="$t('page.iot.openApiKey.cancel')"
    @ok="submitCreate"
  >
    <div class="space-y-3">
      <div>
        <div class="mb-1 text-sm">{{ $t('page.iot.openApiKey.appName') }}</div>
        <Input
          v-model:value="formAppName"
          :placeholder="$t('page.iot.openApiKey.appNamePlaceholder')"
        />
      </div>
      <div>
        <div class="mb-1 text-sm">{{ $t('page.iot.openApiKey.scopes') }}</div>
        <div class="flex flex-col gap-1">
          <div v-for="scope in OPEN_API_ALLOWED_SCOPES" :key="scope">
            <Checkbox
              :checked="formScopes.includes(scope)"
              @change="
                ($event.target as HTMLInputElement).checked
                  ? formScopes.push(scope)
                  : (formScopes = formScopes.filter((s) => s !== scope))
              "
            >
              <span class="font-mono text-xs">{{ scope }}</span>
            </Checkbox>
            <Tag
              v-if="scope === OPEN_API_DANGEROUS_SCOPE"
              color="error"
              class="ml-1"
            >
              {{ $t('page.iot.openApiKey.dangerous') }}
            </Tag>
          </div>
        </div>
      </div>
      <div class="flex gap-3">
        <div class="flex-1">
          <div class="mb-1 text-sm">{{ $t('page.iot.openApiKey.qps') }}</div>
          <InputNumber v-model:value="formQps" :min="1" class="w-full" />
        </div>
        <div class="flex-1">
          <div class="mb-1 text-sm">{{ $t('page.iot.openApiKey.quota') }}</div>
          <InputNumber v-model:value="formQuota" :min="0" class="w-full" />
        </div>
      </div>
      <div>
        <div class="mb-1 text-sm">{{ $t('page.iot.openApiKey.expireAt') }}</div>
        <DatePicker
          v-model:value="formExpireAt"
          show-time
          class="w-full"
          :placeholder="$t('page.iot.openApiKey.expirePlaceholder')"
        />
      </div>
    </div>
  </Modal>

  <!-- 签发结果 Modal：明文仅此一次 -->
  <Modal
    v-model:open="issuedOpen"
    :title="$t('page.iot.openApiKey.issueResult')"
    :footer="null"
  >
    <Alert
      :message="$t('page.iot.openApiKey.oneTime')"
      show-icon
      type="warning"
    />
    <div class="mt-3 space-y-2 text-sm">
      <div>
        {{ $t('page.iot.openApiKey.accessKey') }}:
        <span class="font-mono">{{ issuedResult?.accessKeyId }}</span>
        <Button
          size="small"
          class="ml-2"
          @click="copyText(issuedResult?.accessKeyId ?? '')"
        >
          {{ $t('page.iot.openApiKey.copy') }}
        </Button>
      </div>
      <div>
        {{ $t('page.iot.openApiKey.secret') }}:
        <span class="font-mono text-base">{{ issuedResult?.secret }}</span>
        <Button
          size="small"
          class="ml-2"
          @click="copyText(issuedResult?.secret ?? '')"
        >
          {{ $t('page.iot.openApiKey.copy') }}
        </Button>
      </div>
      <div class="text-xs text-muted-foreground">
        {{ $t('page.iot.openApiKey.secretHint') }}
      </div>
    </div>
  </Modal>
</template>
