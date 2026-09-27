<script lang="ts" setup>
import type {
  VxeTableGridColumns,
  VxeTableGridOptions,
} from '#/adapter/vxe-table';
import type { IotLedgerApi } from '#/api/iot';

import { ref } from 'vue';

import { Alert, Button, message, Tag } from 'ant-design-vue';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import { getTenantLedgerList, updateTenantLedgerAssignable } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

/**
 * 租户接入台账（F5）——**纯内容组件**：不含 `Page` 包裹、不自带固定高度/最大宽度，
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
 * 字段诚实性（硬要求）：后端 `TenantLedgerResp` 只提供
 * `tenantId` / `assignable` / `configEpoch` / `change` / `updateTime` 五个字段，
 * 没有租户名称、设备数、最近上报、凭据信息，IoT 服务也没有跨租户聚合接口
 * ⇒ 「设备数」「最近上报」「是否有凭据」三列一律留空、渲染「待接入」标签，
 * 绝不显示 0 或假日期；`change` 列表恒为空，故不做成列。
 */

/** 列定义：前四列有真实数据源，后三列当前无数据源（留空 + 「待接入」标签）。 */
function useColumns(): VxeTableGridColumns {
  return [
    {
      field: 'tenantId',
      title: $t('page.iot.ledger.tenant'),
      minWidth: 180,
    },
    {
      field: 'assignable',
      title: $t('page.iot.ledger.assignable'),
      width: 120,
      cellRender: {
        name: 'CellTag',
        options: [
          {
            color: 'success',
            label: $t('page.iot.ledger.assignableOn'),
            value: true,
          },
          {
            color: 'default',
            label: $t('page.iot.ledger.assignableOff'),
            value: false,
          },
        ],
      },
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
    },
    // ↓ 以下三列的数据源**当前不存在**：留空 + 「待接入」标签（见文件头说明）。
    //   `field` 仍按目标聚合接口的预期字段名声明，便于后端补齐后直接接线。
    {
      field: 'deviceCount',
      title: $t('page.iot.ledger.deviceCount'),
      width: 110,
      slots: { default: 'pendingDeviceCount' },
    },
    {
      field: 'lastReportAt',
      title: $t('page.iot.ledger.lastReportAt'),
      width: 150,
      slots: { default: 'pendingLastReportAt' },
    },
    {
      field: 'credential',
      title: $t('page.iot.ledger.credential'),
      width: 130,
      slots: { default: 'pendingCredential' },
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
            listError.value = '';
            return rows;
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
      <Alert
        v-if="listError"
        class="mb-2"
        :description="listError"
        :message="$t('page.iot.ledger.listLoadFailed')"
        show-icon
        type="error"
      />
      <Grid>
        <!-- 空态：本页原先没有 `#empty` 槽（失败会落到 vxe 默认「暂无数据」= 假空态）；
             这里只声明**真的没有数据**这一种情况，失败态由上方 Alert 单独承担 -->
        <template #empty>
          <span v-if="!listError" class="text-muted-foreground">
            {{ $t('page.iot.ledger.emptyHint') }}
          </span>
        </template>

        <template #toolbar-tools>
          <!-- 本页没有 create 类页面级写操作，故用**读**权限码门禁刷新按钮；
               写操作（暂停/恢复接入）在行内，用 `iot:ledger:update`。 -->
          <Button v-access:code="['iot:ledger:list']" @click="gridApi.query()">
            {{ $t('common.refresh') }}
          </Button>
        </template>

        <!-- 三列当前无数据源：留空 + 「待接入」，不显示 0 / 不显示假日期 -->
        <template #pendingDeviceCount>
          <Tag color="default">{{ $t('page.iot.ledger.pending') }}</Tag>
        </template>
        <template #pendingLastReportAt>
          <Tag color="default">{{ $t('page.iot.ledger.pending') }}</Tag>
        </template>
        <template #pendingCredential>
          <Tag color="default">{{ $t('page.iot.ledger.pending') }}</Tag>
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
