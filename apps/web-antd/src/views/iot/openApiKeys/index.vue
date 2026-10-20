<script lang="ts" setup>
import type { Dayjs } from 'dayjs';

import type { RefreshGuard } from '../shared/refresh-guard';

import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotOpenApiKeyApi } from '#/api/iot';

import { computed, ref } from 'vue';

import { useAccess } from '@vben/access';
import { Page } from '@vben/common-ui';

import {
  Alert,
  Button,
  Checkbox,
  DatePicker,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Progress,
  Tag,
  Textarea,
  Tooltip,
} from 'ant-design-vue';

import { useVbenVxeGrid } from '#/adapter/vxe-table';
import { createOpenApiKey, getOpenApiKeys, revokeOpenApiKey } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import CopyText from '../shared/copy-text.vue';
import { formatDateTime, openApiScopeLabelKey } from '../shared/display';
import {
  createRefreshGuard,
  QueryTimeoutError,
  withQueryTimeout,
} from '../shared/refresh-guard';
import {
  checkOpenApiKeyForm,
  normalizeOpenApiKeyForm,
  OPEN_API_ALLOWED_SCOPES,
  OPEN_API_DANGEROUS_SCOPE,
  openApiKeyIpWhitelistKind,
  openApiKeyStatusColor,
  openApiKeyStatusLabelKey,
  openApiKeyUsageKind,
  openApiKeyUsageLabel,
  openApiKeyUsagePercent,
  parseIpWhitelist,
} from './open-api-key-state';

/**
 * 开放 API Key 管理页（菜单 /iot/open-api-keys，权限 iot:openapi:key-*）。
 *
 * 后端契约（OpenApiKeyController）只有三端点：创建/列表/吊销（无更新）。
 * 本页一次做到位：
 *   ① 列表用架构自带 `useVbenVxeGrid`（后端一次返回全量，分页关闭；失败态与空态分离）；
 *   ② 签发 Modal（应用名+作用域多选+配额+过期时间，校验与后端同口径；
 *      明文 secret 仅在签发结果 Modal 展示一次，可复制，不持久化）；
 *   ③ 吊销 Popconfirm 二次确认（仅启用态可点）；
 *   ④ 入口分别按 key-list/key-create/key-revoke 显示。
 */
const { hasAccessByCodes } = useAccess();
// 页面级只保留整页守卫；按钮权限一律用 v-access:code 指令
const canList = computed(() => hasAccessByCodes(['iot:openapi:key-list']));

const listError = ref('');

/**
 * 列表的「静默丢弃」守卫（见 shared/refresh-guard.ts）。
 *
 * 本页虽关闭分页器，但工具栏刷新/签发后刷新/吊销后刷新同样会被 vxe 在途守卫吞掉；
 * 登记意图后，被吞掉的那次会在当前周期结束补发一次，且查询有 15s 客户端超时。
 */
let listGuard: RefreshGuard;

const [Grid, gridApi] = useVbenVxeGrid({
  gridOptions: {
    columns: [
      {
        field: 'appName',
        title: $t('page.iot.openApiKey.appName'),
        minWidth: 140,
      },
      {
        field: 'accessKeyId',
        title: $t('page.iot.openApiKey.accessKey'),
        minWidth: 170,
        slots: { default: 'accessKey' },
      },
      {
        field: 'secretPrefix',
        title: $t('page.iot.openApiKey.prefix'),
        width: 120,
        slots: { default: 'mono' },
      },
      {
        field: 'scopes',
        title: $t('page.iot.openApiKey.scopes'),
        minWidth: 200,
        slots: { default: 'scopes' },
      },
      {
        // 来源限制：后端 ListItemResp 当前不返回 ipWhitelist，字段缺席时按「未知」展示（-），
        // 不猜测成「不限来源」；后端补字段后此列自动生效（前向兼容）。
        field: 'ipWhitelist',
        title: $t('page.iot.openApiKey.ipWhitelist'),
        minWidth: 150,
        slots: { default: 'ipWhitelist' },
      },
      {
        field: 'usedToday',
        title: $t('page.iot.openApiKey.usage'),
        minWidth: 170,
        slots: { default: 'usage' },
      },
      {
        field: 'status',
        title: $t('page.iot.openApiKey.status'),
        width: 100,
        slots: { default: 'status' },
      },
      {
        field: 'expireAt',
        title: $t('page.iot.openApiKey.expireAt'),
        width: 170,
        slots: { default: 'expireAt' },
      },
      {
        field: 'lastUsedAt',
        title: $t('page.iot.openApiKey.lastUsed'),
        width: 170,
        slots: { default: 'lastUsedAt' },
      },
      {
        title: $t('page.iot.openApiKey.action'),
        field: 'action',
        width: 90,
        fixed: 'right',
        slots: { default: 'action' },
      },
    ],
    height: 'auto',
    keepSource: true,
    pagerConfig: { enabled: false },
    proxyConfig: {
      ajax: {
        query: async () => {
          // 查询真的启动了 ⇒ 登记过的刷新意图已被执行（没被 vxe 丢弃）
          listGuard.consumeIntent();
          try {
            const items =
              (await withQueryTimeout(getOpenApiKeys()).catch(
                (error: unknown) => {
                  if (error instanceof QueryTimeoutError) {
                    throw new TypeError($t('page.iot.common.queryTimeout'));
                  }
                  throw error;
                },
              )) ?? [];
            listError.value = '';
            return { items, total: items.length };
          } catch (error) {
            listError.value = extractErrorMessage(
              error,
              $t('page.iot.openApiKey.loadFailed'),
            );
            throw error;
          } finally {
            // 周期结束（成功/失败）⇒ 有被丢弃的刷新意图就补发一次
            listGuard.notifyCycleEnd();
          }
        },
      },
    },
    rowConfig: { keyField: 'id' },
    toolbarConfig: { custom: true, export: false, refresh: true, zoom: true },
  } as VxeTableGridOptions<IotOpenApiKeyApi.KeyItem>,
  gridEvents: {
    toolbarButtonClick: ({ code }: { code?: string }) => {
      if (code === 'reload' || code === 'query') {
        listGuard.markIntent();
      }
    },
  },
});

listGuard = createRefreshGuard({
  isBusy: () => Boolean(gridApi.grid?.reactData?.tableLoading),
  issue: () => {
    void gridApi.query();
  },
  onTrailing: (active) => gridApi.setLoading(active),
});

// ---------- 创建表单 ----------
const createOpen = ref(false);
const formAppName = ref('');
const formScopes = ref<string[]>(['iot:series:get']);
const formQps = ref<number | undefined>(10);
const formQuota = ref<number | undefined>(100_000);
const formExpireAt = ref<Dayjs>();
/** 来源 IP 白名单原始输入（逗号/换行分隔；提交前归一化，空 = 不限来源）。 */
const formIpWhitelist = ref('');
const creating = ref(false);

// ---------- 签发结果（明文仅此一次） ----------
const issuedOpen = ref(false);
const issuedResult = ref<IotOpenApiKeyApi.CreateResp>();

function openCreate() {
  formAppName.value = '';
  formScopes.value = ['iot:series:get'];
  formQps.value = 10;
  formQuota.value = 100_000;
  formExpireAt.value = undefined;
  formIpWhitelist.value = '';
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
  // 后端建 Key 时会拒绝非法白名单条目（不静默忽略）⇒ 前端先按同一口径拦住并点名条目，
  // 避免「点了签发才弹一句保存失败」的往返。
  const ipWhitelist = parseIpWhitelist(formIpWhitelist.value);
  if (ipWhitelist.invalidEntry) {
    message.error(
      $t('page.iot.openApiKey.ipWhitelistInvalid', [ipWhitelist.invalidEntry]),
    );
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
      // 归一化后的逗号分隔串；空（未配置）⇒ 传 undefined（后端=不限来源）
      ipWhitelist: ipWhitelist.normalized,
      expireAt: formExpireAt.value
        ? formExpireAt.value.format('YYYY-MM-DD HH:mm:ss')
        : undefined,
    });
    createOpen.value = false;
    issuedOpen.value = true;
    message.success($t('page.iot.openApiKey.createSuccess'));
    listGuard.request();
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
    listGuard.request();
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
</script>

<template>
  <!-- 架构对齐：根节点用 Page auto-content-height（其余 8 个 IoT 列表页的范式） -->
  <Page v-if="canList" auto-content-height>
    <div class="mb-3 flex flex-wrap items-center gap-3">
      <div class="font-semibold">
        {{ $t('page.iot.openApiKey.title') }}
      </div>
      <Button
        v-access:code="['iot:openapi:key-create']"
        type="primary"
        size="small"
        @click="openCreate"
      >
        {{ $t('page.iot.openApiKey.create') }}
      </Button>
    </div>

    <Alert
      v-if="listError"
      type="error"
      show-icon
      :message="$t('page.iot.openApiKey.loadFailed')"
      :description="listError"
      class="mb-3"
    />

    <Grid>
      <template #empty>
        <!-- 失败态由上方 Alert 承担，这里只声明「真的没有 Key」这一种情况。 -->
        <span v-if="!listError" class="text-muted-foreground">
          {{ $t('page.iot.openApiKey.empty') }}
        </span>
      </template>

      <template #accessKey="{ row }">
        <CopyText :value="row.accessKeyId" />
      </template>
      <template #mono="{ row }">
        <span class="font-mono text-xs">{{ row.secretPrefix }}</span>
      </template>
      <template #scopes="{ row }">
        <span
          v-if="!row.scopes || row.scopes.length === 0"
          class="text-xs text-muted-foreground"
        >
          -
        </span>
        <span v-else class="flex flex-wrap items-center justify-center gap-1">
          <!-- 界面显示中文作用域，原权限码放 tooltip：排障/对接口文档时不用再猜。 -->
          <Tooltip v-for="scope in row.scopes" :key="scope" :title="scope">
            <Tag
              class="m-0 cursor-help"
              :color="scope === OPEN_API_DANGEROUS_SCOPE ? 'error' : 'default'"
            >
              {{ $t(openApiScopeLabelKey(scope)) }}
            </Tag>
          </Tooltip>
        </span>
      </template>
      <template #ipWhitelist="{ row }">
        <!-- 已配置：完整白名单放 tooltip（列内只显示一行，避免撑破表格） -->
        <Tooltip
          v-if="openApiKeyIpWhitelistKind(row.ipWhitelist) === 'configured'"
          :title="row.ipWhitelist"
        >
          <span class="cursor-help font-mono text-xs">
            {{ row.ipWhitelist }}
          </span>
        </Tooltip>
        <span
          v-else-if="openApiKeyIpWhitelistKind(row.ipWhitelist) === 'unlimited'"
          class="text-xs"
        >
          {{ $t('page.iot.openApiKey.ipWhitelistUnlimited') }}
        </span>
        <!-- 后端 ListItemResp 暂不返回该字段 ⇒ 显示占位 '-'，不猜成「不限来源」 -->
        <span v-else class="text-xs text-muted-foreground">-</span>
      </template>

      <template #usage="{ row }">
        <div
          v-if="
            openApiKeyUsageKind(row.usedToday, row.dailyQuota) === 'limited'
          "
          class="flex items-center gap-2 px-1"
        >
          <Progress
            :percent="openApiKeyUsagePercent(row.usedToday, row.dailyQuota)"
            :show-info="false"
            class="flex-1"
            size="small"
          />
          <span class="font-mono text-xs">
            {{ openApiKeyUsageLabel(row.usedToday) }} / {{ row.dailyQuota }}
          </span>
        </div>
        <span
          v-else-if="
            openApiKeyUsageKind(row.usedToday, row.dailyQuota) === 'unlimited'
          "
          class="text-xs"
        >
          {{ $t('page.iot.openApiKey.unlimited') }}
        </span>
        <span v-else class="text-xs">
          {{ $t('page.iot.openApiKey.unknown') }}
        </span>
      </template>
      <template #status="{ row }">
        <Tag :color="openApiKeyStatusColor(row.status)">
          {{ $t(openApiKeyStatusLabelKey(row.status)) }}
        </Tag>
      </template>
      <template #expireAt="{ row }">
        {{ formatDateTime(row.expireAt) }}
      </template>
      <template #lastUsedAt="{ row }">
        {{ formatDateTime(row.lastUsedAt) }}
      </template>
      <template #action="{ row }">
        <Popconfirm
          v-access:code="['iot:openapi:key-revoke']"
          v-if="row.status === 1"
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
      </template>
    </Grid>

    <div v-if="!canList" class="p-4 text-sm text-muted-foreground">
      {{ $t('page.iot.openApiKey.noPermission') }}
    </div>
  </Page>

  <!-- 创建 Modal -->
  <Modal
    v-model:open="createOpen"
    :title="$t('page.iot.openApiKey.createTitle')"
    width="min(520px, 92vw)"
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
              <span>{{ $t(openApiScopeLabelKey(scope)) }}</span>
              <span class="ml-1 font-mono text-xs text-muted-foreground">
                {{ scope }}
              </span>
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
      <div class="flex flex-col gap-3 sm:flex-row">
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
        <div class="mb-1 text-sm">
          {{ $t('page.iot.openApiKey.ipWhitelist') }}
        </div>
        <Textarea
          v-model:value="formIpWhitelist"
          :rows="2"
          :placeholder="$t('page.iot.openApiKey.ipWhitelistHelp')"
        />
        <div class="mt-1 text-xs text-muted-foreground">
          {{ $t('page.iot.openApiKey.ipWhitelistHelp') }}
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
    width="min(520px, 92vw)"
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
