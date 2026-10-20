<script lang="ts" setup>
import type { RefreshGuard } from '../shared/refresh-guard';

import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotProductApi } from '#/api/iot';

import { ref } from 'vue';

import { Page, useVbenDrawer } from '@vben/common-ui';
import { Plus } from '@vben/icons';

import { Button, message } from 'ant-design-vue';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import { deleteProduct, getProductPage, publishProduct } from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

import EmptyGuide from '../onboarding/modules/empty-guide.vue';
import OnboardingGuide from '../onboarding/modules/guide.vue';
import ListErrorAlert from '../shared/list-error-alert.vue';
import {
  createRefreshGuard,
  QueryTimeoutError,
  withQueryTimeout,
} from '../shared/refresh-guard';
import { useColumns, useGridFormSchema } from './data';
import Detail from './modules/detail.vue';
import Form from './modules/form.vue';

const [FormDrawer, FormDrawerApi] = useVbenDrawer({ connectedComponent: Form });
const [DetailDrawer, DetailDrawerApi] = useVbenDrawer({
  connectedComponent: Detail,
});
/** 接入向导抽屉：内容组件不自带抽屉容器（它还要被独立页面复用）⇒ 用默认插槽挂进来。 */
const [GuideDrawer, GuideDrawerApi] = useVbenDrawer();

/**
 * 列表**加载失败**的原因（非空即代表「这次没取到数据」）。
 *
 * 🔴 与设备台账同一道理：vxe 的 `#empty` 插槽分不清「加载失败」与「确实没有数据」，
 * 只挂 `EmptyGuide` 就是把失败画成「还没有产品，去创建吧」。全局拦截器的 toast 转瞬即逝，
 * 用户错过它之后页面上永久留着「没有数据」这个**错误结论**（假空态）。
 */
const listError = ref('');

/**
 * 列表的「静默丢弃」守卫（见 shared/refresh-guard.ts）。
 *
 * vxe 在查询在途时会直接吞掉后续 `query`/`reload`（不报错、不转圈）：
 * 用户点刷新/翻页撞上慢请求就是「点了没反应」；慢请求本身也没有客户端超时。
 * 这里登记每个查询意图，被吞掉的那次在本周期结束后用最新筛选补发一次。
 */
let listGuard: RefreshGuard;

const [Grid, gridApi] = useVbenVxeGrid({
  formOptions: {
    schema: useGridFormSchema(),
    submitOnChange: true,
  },
  gridOptions: {
    columns: useColumns(),
    height: 'auto',
    keepSource: true,
    pagerConfig: { enabled: true },
    proxyConfig: {
      ajax: {
        query: async ({ page }, formValues: IotProductApi.ProductQuery) => {
          // 查询真的启动了 ⇒ 登记过的刷新意图已被执行（没被 vxe 丢弃）
          listGuard.consumeIntent();
          try {
            const result = await withQueryTimeout(
              getProductPage({
                page: page.currentPage,
                pageSize: page.pageSize,
                ...formValues,
              }),
            ).catch((error: unknown) => {
              // 客户端超时 ⇒ 换成用户能看懂的话（而不是永远转圈）
              if (error instanceof QueryTimeoutError) {
                throw new TypeError($t('page.iot.common.queryTimeout'));
              }
              throw error;
            });
            listError.value = '';
            // 后端 `PageResult.total` 是 `long` ⇒ 全局序列化成**字符串**（`"17"`），
            // 而 vxe 的 pager 需要 number（页数 = ceil(total/pageSize)）⇒ 进入表格前先转数。
            return { ...result, total: toBackendNumber(result.total) };
          } catch (error) {
            // 记下失败原因（原样展示后端 message），异常继续抛出 ⇒ 不改动原有失败语义。
            listError.value = extractErrorMessage(
              error,
              $t('page.iot.product.listLoadFailed'),
            );
            throw error;
          } finally {
            // 周期结束（成功/失败）⇒ 有被丢弃的意图就补发一次
            listGuard.notifyCycleEnd();
          }
        },
      },
    },
    rowConfig: { keyField: 'id' },
    toolbarConfig: {
      custom: true,
      export: false,
      refresh: true,
      search: true,
      zoom: true,
    },
  } as VxeTableGridOptions<IotProductApi.ProductResp>,
  gridEvents: {
    pageChange: () => listGuard.markIntent(),
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

/** 列表刷新入口（表单/详情/向导/删除发布后共用；走守卫覆盖「慢查询在途」窗口）。 */
function reloadList() {
  listGuard.request();
}

function onEdit(row: IotProductApi.ProductResp) {
  FormDrawerApi.setData(row).open();
}

/** 产品详情：5 页签 + 物模型编辑器 + 添加设备入口，全部走已存在的物模型接口。 */
function onDetail(row: IotProductApi.ProductResp) {
  DetailDrawerApi.setData(row).open();
}

function onDelete(row: IotProductApi.ProductResp) {
  deleteProduct(row.id)
    .then(() => {
      message.success($t('common.success'));
      reloadList();
    })
    .catch(() => {});
}

function onPublish(row: IotProductApi.ProductResp) {
  publishProduct(row.id)
    .then((version) => {
      message.success(`${$t('common.success')} ${version}`);
      reloadList();
    })
    .catch(() => {});
}

/** 打开接入向导抽屉（空态引导与工具栏按钮共用同一个入口）。 */
function openGuide() {
  GuideDrawerApi.open();
}
</script>
<template>
  <Page auto-content-height>
    <FormDrawer @reload="reloadList" />
    <DetailDrawer @reload="reloadList" />
    <GuideDrawer
      :title="$t('page.iot.onboarding.title')"
      class="w-full max-w-[900px]"
    >
      <OnboardingGuide @done="reloadList" />
    </GuideDrawer>
    <!--
      🔴 失败态**必须挂在表格之外**（不能只放 `#empty` 槽里）：
      真实 vxe 只在**表体没有行**时才渲染 `#empty` 槽 ⇒ 「已有数据后刷新失败」时旧行仍在、
      槽不渲染 ⇒ 失败提示看不见，页面继续展示**过期数据**而用户毫不知情。
      统一走 shared/list-error-alert.vue（与设备/告警等页同一呈现）。
    -->
    <ListErrorAlert
      :error="listError"
      :title="$t('page.iot.product.listLoadFailed')"
    />
    <Grid>
      <template #toolbar-tools>
        <div class="flex flex-wrap items-center gap-2">
          <Button @click="openGuide">
            {{ $t('page.iot.onboarding.openGuide') }}
          </Button>
          <Button
            v-access:code="['iot:product:create']"
            type="primary"
            @click="FormDrawerApi.setData(null).open()"
          >
            <template #icon><Plus /></template>
            {{ $t('ui.actionTitle.create', [$t('page.iot.product.name')]) }}
          </Button>
        </div>
      </template>

      <!-- 空态引导：说明「为什么是空的 + 下一步点哪里」，而不是一张空白表格 -->
      <!-- 🔴 但**失败不能画成空态**：加载失败时由上方 ListErrorAlert 承担失败态，这里不得再声称「没有数据」 -->
      <template #empty>
        <EmptyGuide
          v-if="!listError"
          :reason="$t('page.iot.product.emptyReason')"
          @open-guide="openGuide"
        />
      </template>

      <template #action="{ row }">
        <VbenTableAction
          :actions="[
            {
              text: $t('page.iot.product.detail'),
              icon: 'lucide:info',
              auth: 'iot:product:list',
              onClick: () => onDetail(row),
            },
            {
              text: $t('common.edit'),
              icon: 'lucide:edit',
              auth: 'iot:product:update',
              onClick: () => onEdit(row),
            },
          ]"
          :dropdown-actions="[
            {
              text: $t('page.iot.product.publish'),
              icon: 'lucide:upload',
              auth: 'iot:product:publish',
              popConfirm: {
                title: $t('page.iot.product.publishConfirm'),
                confirm: () => onPublish(row),
              },
            },
            {
              text: $t('common.delete'),
              icon: 'lucide:trash-2',
              auth: 'iot:product:delete',
              danger: true,
              popConfirm: {
                title: $t('ui.actionMessage.deleteConfirm', [
                  row.productName || row.productCode || '',
                ]),
                confirm: () => onDelete(row),
              },
            },
          ]"
          align="center"
        />
      </template>
    </Grid>
  </Page>
</template>
