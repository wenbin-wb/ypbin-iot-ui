<script lang="ts" setup>
import type {
  VxeTableGridColumns,
  VxeTableGridOptions,
} from '#/adapter/vxe-table';
import type { IotLedgerApi } from '#/api/iot';

import { ref } from 'vue';

import { Alert, Button, InputSearch, message, Tag } from 'ant-design-vue';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import { getTenantLedgerList, updateTenantLedgerAssignable } from '#/api/iot';
import { getTenantList } from '#/api/system/tenant';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import CopyText from '../../shared/copy-text.vue';
import { formatDateTime } from '../../shared/display';
import ListErrorAlert from '../../shared/list-error-alert.vue';
import {
  assignableColor,
  assignableLabelKey,
  buildTenantNameMap,
  filterLedgerRows,
  ledgerCredentialColor,
  ledgerCredentialLabelKey,
  ledgerDeviceCountText,
  ledgerLastReportText,
} from '../ledger-display';

/**
 * 租户接入台账——**纯内容组件**：不含 `Page` 包裹、不自带固定高度/最大宽度，
 * 因此同一个组件既能当页面主体、也能当抽屉内容：
 * - 页面宿主：`<Page auto-content-height><TenantLedger /></Page>`（见同目录 `index.vue`）
 * - 抽屉宿主：`const [TenantLedgerDrawer] = useVbenDrawer();`
 *   `<TenantLedgerDrawer :title="..."><TenantLedger /></TenantLedgerDrawer>`
 *
 * ⚠️ 不要把它直接当 `useVbenDrawer({ connectedComponent })` 的 `connectedComponent`：
 * vben 的 `connectedComponent` 要求子组件**自带** `useVbenDrawer`/`useVbenModal` 并渲染
 * `<Drawer>`/`<Modal>` 容器（子组件靠 `inject` 与父 api 连接，见
 * `packages/@core/ui-kit/popup-ui/src/drawer/use-drawer.ts` 第 75~113 行）；纯内容组件被
 * 这样传进去只会**内联渲染、不产生抽屉**。抽屉宿主请用上面的插槽写法。
 *
 * 本组件要求宿主提供**确定高度**的容器（`h-full` 链），`Page auto-content-height` 与
 * vben 抽屉 body（`flex-1 overflow-y-auto`）都满足。
 *
 * 字段诚实性（硬要求）：
 * - 租户名称：用系统租户接口 `GET /system/tenant/list` **批量**解析（不按行发 N+1 请求），
 *   失败时名称列回落「名称待接入」并挂可见 Alert（不伪造名称、也不清空台账）；
 * - 「设备数」「最近上报」「是否有凭据」：消费后端聚合字段
 *   `deviceCount` / `lastReportAt` / `hasCredential`。**只有字段 `undefined`（后端尚未提供）
 *   才渲染「待接入」**；0 显示 0、空时间显示 `-`、有/无凭据显示「是/否」Tag，
 *   绝不把缺失或空值猜成 0 / 假日期 / 无凭据；
 * - `change` 列表恒为空，故不做成列；
 * - 搜索为**前端过滤**（租户名 / tenantId），不新增后端查询参数。
 */

/**
 * 列定义：tenantId / assignable / configEpoch / updateTime 为后端直出字段；
 * tenantName 是**展示派生列**（由系统租户接口解析，无同名后端字段）；
 * deviceCount / lastReportAt / hasCredential 消费后端聚合字段，
 * 仅 `undefined`（后端未提供）显示「待接入」（见文件头说明）。
 */
function useColumns(): VxeTableGridColumns {
  return [
    {
      // 名称与 ID 同源于 tenantId（后端没有 tenantName 字段）。
      // field 用展示派生名 `tenantName`：vxe 要求同一张表的 field 唯一，
      // 两列都写 tenantId 会触发 "column.field 重复" 告警（真实挂载实测）。
      field: 'tenantName',
      title: $t('page.iot.ledger.tenantName'),
      minWidth: 180,
      slots: { default: 'tenantName' },
    },
    {
      field: 'tenantId',
      title: $t('page.iot.ledger.tenantId'),
      minWidth: 180,
      slots: { default: 'tenantId' },
    },
    {
      field: 'assignable',
      title: $t('page.iot.ledger.assignable'),
      width: 120,
      // CellTag 对缺省值渲染空白、区分不出「未知」；这里用三态 Tag + 纯函数给键/色。
      slots: { default: 'assignable' },
    },
    {
      field: 'configEpoch',
      title: $t('page.iot.ledger.configEpoch'),
      width: 120,
    },
    {
      field: 'updateTime',
      title: $t('page.iot.ledger.updateTime'),
      width: 170,
      slots: { default: 'updateTime' },
    },
    // 以下三列消费后端聚合字段；`field` 与后端 DTO 同名，不做改名映射（铁律 7）：
    // 字段缺失（undefined）才显示「待接入」，0 / 空串按真实值展示。
    {
      field: 'deviceCount',
      title: $t('page.iot.ledger.deviceCount'),
      width: 110,
      slots: { default: 'deviceCount' },
    },
    {
      field: 'lastReportAt',
      title: $t('page.iot.ledger.lastReportAt'),
      width: 170,
      slots: { default: 'lastReportAt' },
    },
    {
      field: 'hasCredential',
      title: $t('page.iot.ledger.credential'),
      width: 130,
      slots: { default: 'hasCredential' },
    },
    {
      align: 'center',
      field: 'action',
      fixed: 'right',
      slots: { default: 'action' },
      title: $t('common.action'),
      width: 150,
    },
  ];
}

/**
 * 列表**加载失败**的原因（非空即代表「这次没取到数据」）。
 *
 * 🔴 本页原先**连 `#empty` 槽都没有** ⇒ 加载失败时直接落到 vxe 的默认「暂无数据」，
 * 那是**假空态**：台账是平台管理员判断「哪些租户接进来了」的唯一入口，
 * 把查询失败说成「没有租户」会直接误导接入运营。
 */
const listError = ref('');

/** 租户名解析结果（tenantId → name）；缺失时模板回落展示 tenantId / 待接入。 */
const tenantNameById = ref<Record<string, string>>({});

/** 名称接口是否成功返回过（区分「加载中」与「加载成功但查无此租户」）。 */
const tenantNamesLoaded = ref(false);

/** 名称解析失败原因（空 = 未失败）；失败必须可见，不静默回落。 */
const tenantNameError = ref('');

/** 搜索关键字（前端过滤，不发给后端）。 */
const tenantKeyword = ref('');

/**
 * 批量解析 tenantId → 租户名称（`GET /system/tenant/list`，台账列表本身不大）。
 *
 * 内部捕获的取舍：名称是**展示增强**，解析失败不能把台账列表一起拖失败
 * （与维护窗口解析设备名同一口径）；但**不静默吞**——失败原因进 `tenantNameError`
 * 由页面 Alert 展示，名称列回落「名称待接入」，同时 `console.warn` 留痕。
 */
async function resolveTenantNames(rows: IotLedgerApi.LedgerResp[]) {
  const ids = [...new Set(rows.map((row) => row.tenantId).filter(Boolean))];
  if (ids.length === 0) {
    // 没有任何 tenantId 可解析（含列表为空）⇒ 不发多余请求。
    return;
  }
  try {
    tenantNameById.value = buildTenantNameMap(await getTenantList());
    tenantNamesLoaded.value = true;
    tenantNameError.value = '';
  } catch (error) {
    tenantNamesLoaded.value = false;
    tenantNameError.value = extractErrorMessage(
      error,
      $t('page.iot.ledger.tenantNameLoadFailed'),
    );
    console.warn(
      '[iot/tenant-ledger] 租户名称解析失败，名称列回落为「名称待接入」（不伪造名称）',
      error,
    );
  }
}

/** 名称列四态：已解析 / 批量失败 / 加载中 / 已加载但查无此租户。 */
function tenantNameState(
  row: IotLedgerApi.LedgerResp,
): 'error' | 'loading' | 'name' | 'unknown' {
  if (tenantNameById.value[row.tenantId]) {
    return 'name';
  }
  if (tenantNameError.value) {
    return 'error';
  }
  return tenantNamesLoaded.value ? 'unknown' : 'loading';
}

const [Grid, gridApi] = useVbenVxeGrid({
  gridOptions: {
    columns: useColumns(),
    height: 'auto',
    keepSource: true,
    // 接口返回全量 `List`，无分页参数 ⇒ 关闭分页器（与维护窗口、分组两页一致）
    pagerConfig: { enabled: false },
    proxyConfig: {
      ajax: {
        query: async () => {
          try {
            const rows = await getTenantLedgerList();
            // 租户名是展示增强（内部自捕获 + 可见提示），不把台账列表一起拖失败。
            await resolveTenantNames(rows);
            listError.value = '';
            // 搜索为**前端过滤**：按租户名或 tenantId 命中，不新增查询参数。
            return filterLedgerRows(
              rows,
              tenantKeyword.value,
              tenantNameById.value,
            );
          } catch (error) {
            // 记下失败原因（原样展示后端 message），异常继续抛出 ⇒ 不改原有失败语义
            listError.value = extractErrorMessage(
              error,
              $t('page.iot.ledger.listLoadFailed'),
            );
            throw error;
          }
        },
      },
    },
    // 行主键是 `tenantId`（列表里没有 `id` 字段），一个租户一行
    rowConfig: { keyField: 'tenantId' },
    toolbarConfig: { custom: true, export: false, refresh: true, zoom: true },
  } as VxeTableGridOptions<IotLedgerApi.LedgerResp>,
});

/** 搜索框回车/点搜索：重新走 query（过滤仍在前端做，不新增后端参数）。 */
function onTenantSearch() {
  gridApi.query();
}

/** `allowClear` 清空时立即恢复全量，不必再按一次搜索。 */
function onTenantKeywordChange(event: Event) {
  const value = (event.target as HTMLInputElement | null)?.value ?? '';
  if (value === '') {
    tenantKeyword.value = '';
    gridApi.query();
  }
}

/**
 * `change` 仅在写入口回填，取值固定三选一；列表里恒为空 ⇒ 不认识的值一律退化。
 *
 * 这里用 `switch` 而不是拼 key：拼出来的 key 逃过 `scripts/check-iot-i18n-keys.mjs`
 * 的静态扫描（该门禁只认「`$t` + 引号字面量」的写法），少一个键就要等运行期才发现。
 */
function changeLabel(change?: string) {
  switch (change) {
    case 'created': {
      return $t('page.iot.ledger.change.created');
    }
    case 'revived': {
      return $t('page.iot.ledger.change.revived');
    }
    case 'updated': {
      return $t('page.iot.ledger.change.updated');
    }
    default: {
      return '';
    }
  }
}

/** 暂停 / 恢复某租户的接入开关（`iot:ledger:update`）。 */
function onToggleAssignable(row: IotLedgerApi.LedgerResp, assignable: boolean) {
  updateTenantLedgerAssignable(row.tenantId, assignable)
    .then((resp) => {
      const detail = changeLabel(resp.change);
      message.success(
        detail ? `${$t('common.success')} · ${detail}` : $t('common.success'),
      );
      gridApi.query();
    })
    .catch(() => {
      // 失败提示由 `requestClient` 的全局响应拦截器统一弹出（见 `#/api/request`），
      // 这里只兜住 Promise，避免 unhandled rejection 与重复提示。
    });
}
</script>

<template>
  <div class="flex h-full flex-col gap-3">
    <!--
      字段可用性说明：后端只给了 5 个字段，本页不补造任何数据。
      写清楚「哪些列为什么空」比让用户对着空白列猜更有价值。
    -->
    <Alert
      class="shrink-0"
      show-icon
      type="info"
      :description="$t('page.iot.ledger.noticeText')"
      :message="$t('page.iot.ledger.noticeTitle')"
    />

    <div class="min-h-0 flex-1">
      <!-- 失败态必须挂在表格之外：真实 vxe 只在表体无行时渲染 `#empty` 槽，
           「已有数据后刷新失败」时槽不渲染 ⇒ 放槽里的失败提示会看不见。 -->
      <ListErrorAlert
        :error="listError"
        :title="$t('page.iot.ledger.listLoadFailed')"
      />
      <!-- 名称解析失败是「展示增强」失败：台账仍可用，但原因必须让用户看得见 -->
      <ListErrorAlert
        v-if="tenantNameError"
        :error="
          $t('page.iot.ledger.tenantNameLoadFailedDesc', [tenantNameError])
        "
        :title="$t('page.iot.ledger.tenantNameLoadFailed')"
        type="warning"
      />
      <Grid>
        <!-- 空态：本页原先没有 `#empty` 槽（失败会落到 vxe 默认「暂无数据」= 假空态）；
             这里只声明**真的没有数据**这一种情况，失败态由上方 Alert 单独承担 -->
        <template #empty>
          <span v-if="listError"></span>
          <span
            v-else-if="tenantKeyword.trim() !== ''"
            class="text-muted-foreground"
          >
            {{ $t('page.iot.ledger.searchEmptyHint', [tenantKeyword]) }}
          </span>
          <span v-else class="text-muted-foreground">
            {{ $t('page.iot.ledger.emptyHint') }}
          </span>
        </template>

        <template #tenantName="{ row }">
          <span v-if="tenantNameState(row) === 'name'">
            {{ tenantNameById[row.tenantId] }}
          </span>
          <Tag v-else-if="tenantNameState(row) === 'error'" color="warning">
            {{ $t('page.iot.ledger.tenantNamePending') }}
          </Tag>
          <span
            v-else-if="tenantNameState(row) === 'loading'"
            class="text-muted-foreground"
          >
            -
          </span>
          <span v-else class="text-muted-foreground">
            {{ $t('page.iot.display.unknownWithValue', [row.tenantId]) }}
          </span>
        </template>

        <template #tenantId="{ row }">
          <CopyText :value="row.tenantId" />
        </template>

        <template #assignable="{ row }">
          <!-- 三态（true/false/缺失）都要可解释：缺失显示「未知」而不是空白。 -->
          <Tag :color="assignableColor(row.assignable)">
            {{ $t(assignableLabelKey(row.assignable)) }}
          </Tag>
        </template>

        <template #updateTime="{ row }">
          {{ formatDateTime(row.updateTime) }}
        </template>

        <template #toolbar-tools>
          <div class="flex flex-wrap items-center gap-2">
            <InputSearch
              v-model:value="tenantKeyword"
              allow-clear
              class="w-56"
              :placeholder="$t('page.iot.ledger.tenantSearchPlaceholder')"
              @change="onTenantKeywordChange"
              @search="onTenantSearch"
            />
            <!-- 本页没有 create 类页面级写操作，故用**读**权限码门禁刷新按钮；
               写操作（暂停/恢复接入）在行内，用 `iot:ledger:update`。 -->
            <Button
              v-access:code="['iot:ledger:list']"
              @click="gridApi.query()"
            >
              {{ $t('common.refresh') }}
            </Button>
          </div>
        </template>

        <!-- 聚合字段三列：undefined（后端未提供）才显示「待接入」；0 / 空串是真实值 -->
        <template #deviceCount="{ row }">
          <Tag v-if="row.deviceCount === undefined" color="default">
            {{ $t('page.iot.ledger.pending') }}
          </Tag>
          <span v-else>{{ ledgerDeviceCountText(row.deviceCount) }}</span>
        </template>
        <template #lastReportAt="{ row }">
          <Tag v-if="row.lastReportAt === undefined" color="default">
            {{ $t('page.iot.ledger.pending') }}
          </Tag>
          <span v-else>{{ ledgerLastReportText(row.lastReportAt) }}</span>
        </template>
        <template #hasCredential="{ row }">
          <Tag v-if="row.hasCredential === undefined" color="default">
            {{ $t('page.iot.ledger.pending') }}
          </Tag>
          <Tag v-else :color="ledgerCredentialColor(row.hasCredential)">
            {{ $t(ledgerCredentialLabelKey(row.hasCredential)) }}
          </Tag>
        </template>

        <template #action="{ row }">
          <VbenTableAction
            :actions="[
              row.assignable
                ? {
                    text: $t('page.iot.ledger.suspend'),
                    icon: 'lucide:pause',
                    auth: 'iot:ledger:update',
                    danger: true,
                    popConfirm: {
                      title: $t('page.iot.ledger.suspendConfirm'),
                      confirm: () => onToggleAssignable(row, false),
                    },
                  }
                : {
                    text: $t('page.iot.ledger.resume'),
                    icon: 'lucide:play',
                    auth: 'iot:ledger:update',
                    popConfirm: {
                      title: $t('page.iot.ledger.resumeConfirm'),
                      confirm: () => onToggleAssignable(row, true),
                    },
                  },
            ]"
            align="center"
          />
        </template>
      </Grid>
    </div>
  </div>
</template>
