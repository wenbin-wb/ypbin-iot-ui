<script lang="ts" setup>
import type { RefreshGuard } from '../shared/refresh-guard';
import type { BatchOutcome } from './list-actions';

import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotDeviceApi } from '#/api/iot';

import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { Page, useVbenDrawer } from '@vben/common-ui';
import { Download, Plus } from '@vben/icons';

import {
  Alert,
  Button,
  message,
  Popconfirm,
  Switch,
  Tag,
  Tooltip,
} from 'ant-design-vue';
import dayjs from 'dayjs';

import { useVbenVxeGrid, VbenTableAction } from '#/adapter/vxe-table';
import {
  deleteDevice,
  getActiveAlertCounts,
  getDevicePage,
  updateDeviceStatus,
} from '#/api/iot';
// 批量端点从全路径导入（skill 的值导入约定）：既不与聚合器 mock 的既有测试互相牵制，
// 也避免「聚合器多导出一个函数」就把老测试的固定 mock 打破。
import {
  batchDeleteDevices,
  batchUpdateDeviceStatus,
  exportDevicesCsv,
} from '#/api/iot/device';
import {
  createTrailingDebounce,
  deviceStatusTouchesDevices,
} from '#/api/iot/realtime';
import { handleSessionExpired } from '#/api/request';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';
import { downloadBlobSafe } from '#/utils/file';

import EmptyGuide from '../onboarding/modules/empty-guide.vue';
import OnboardingGuide from '../onboarding/modules/guide.vue';
import ListErrorAlert from '../shared/list-error-alert.vue';
import {
  createRefreshGuard,
  QueryTimeoutError,
  withQueryTimeout,
} from '../shared/refresh-guard';
import { useIotRealtime } from '../shared/use-iot-realtime';
import TenantLedger from '../tenant-ledger/modules/ledger.vue';
import { useColumns, useGridFormSchema } from './data';
import {
  resolveBatchDisabledReason,
  resolveBatchOutcome,
  resolvePageAfterDelete,
  resolvePageAfterEmptyQuery,
} from './list-actions';
import Availability from './modules/availability.vue';
import BatchCommand from './modules/batch-command.vue';
import BatchTags from './modules/batch-tags.vue';
import Detail from './modules/detail.vue';
import Form from './modules/form.vue';
import DeviceImport from './modules/import.vue';
import Series from './modules/series.vue';

const route = useRoute();
const router = useRouter();

const [FormDrawer, FormDrawerApi] = useVbenDrawer({ connectedComponent: Form });
const [DetailDrawer, DetailDrawerApi] = useVbenDrawer({
  connectedComponent: Detail,
});
const [AvailabilityDrawer, AvailabilityDrawerApi] = useVbenDrawer({
  connectedComponent: Availability,
});
const [SeriesDrawer, SeriesDrawerApi] = useVbenDrawer({
  connectedComponent: Series,
});
/**
 * 接入向导抽屉。
 *
 * 用**默认插槽**而不是 `connectedComponent`：向导内容组件（`onboarding/modules/guide.vue`）
 * 同时要被独立页面复用，因此它不自带抽屉容器；`connectedComponent` 形态要求子组件自己渲染
 * `<Drawer>`（vben 只 provide 上下文、父侧不渲染容器），两者不能兼得。
 */
const [GuideDrawer, GuideDrawerApi] = useVbenDrawer();
/**
 * 租户接入台账抽屉。
 *
 * **为什么挂在设备台账页**：平台级权限码 `iot:ledger:list/update` 本来就挂在设备菜单（`sys_menu`
 * 320014/320015，`platform_only=1`，见 `deploy/sql/007-iot-data.sql`）。
 * **菜单已由迁移补齐**（2026-09-29 更正，此前写的是「台账页暂时没有页面级菜单」）：
 * `deploy/sql/migration/2026-09-29-iot-menu-onboarding-ledger.sql` 补了 3206
 * （`type='menu'`、`platform_only=1`、标题键 `page.iot.ledger.pageTitle`）。
 * 此处保留抽屉入口仍有价值：平台管理员在设备台账页可**就地**查看/修改本租户归属，
 * 不必跳到独立页面。
 */
const [LedgerDrawer, LedgerDrawerApi] = useVbenDrawer();
/**
 * 批量导入（CSV）抽屉——「下载模板 → 上传 → 看结果」三步闭环。
 *
 * 抽屉打开时拉一次批次列表：用户点开这个入口时想看的就是「我以前传过什么、结果如何」，
 * 而不是一个空面板等着他去上传。
 */
const [ImportDrawer, ImportDrawerApi] = useVbenDrawer();

/**
 * 批量打标签 / 批量移除标签抽屉（同一组件按 mode 切换表单与接口）。
 *
 * 权限：打标签入口按 iot:tag:create/update（后端 SaMode.OR）显示，
 * 移除入口按 iot:tag:delete；目标设备来自当前勾选（ids 全程字符串，铁律 9）。
 */
const [BatchTagsDrawer, BatchTagsDrawerApi] = useVbenDrawer({
  connectedComponent: BatchTags,
});

/**
 * 批量下发命令抽屉（一个命令模板 + 多台设备，逐设备结果如实展示）。
 *
 * 权限沿用后端要求的 `iot:debug:send`（批量是同一动作的放大，不新造权限码）；
 * 目标设备来自当前勾选（**设备 id 全程字符串**，铁律 9；由抽屉在发送前显式转 number，
 * 因为后端该字段是 `List<Long>`）。
 */
const [BatchCommandDrawer, BatchCommandDrawerApi] = useVbenDrawer({
  connectedComponent: BatchCommand,
});

/** 批量导入面板的实例（用来在打开抽屉时触发一次列表刷新）。 */
const ImportPanel = ref<InstanceType<typeof DeviceImport> | null>(null);

/**
 * 列表**加载失败**的原因（非空即代表「这次没取到数据」）。
 *
 * 🔴 为什么必须有它：vxe 的 `#empty` 插槽在「**加载失败**」与「**确实没有数据**」两种情况下
 * 长得一模一样 ⇒ 只挂一个 `EmptyGuide` 就是把失败画成「还没有设备，去创建吧」。
 * 失败虽然会由全局请求拦截器弹一次 toast，但 toast 是**转瞬即逝**的：用户错过它之后，
 * 页面上永久留着「没有数据」这个**错误结论**（这正是「假空态」）。
 * 有了这个 ref，空态插槽才有依据区分二者：失败态原样展示后端 `message`。
 */
const listError = ref('');

/**
 * 当前页设备的**活动告警数**（一次批量查询；`id → 数量`）。
 *
 * 它是**辅助信息**，因此它自己的失败不能把设备列表画成失败态（那是两件事）；
 * 但也不能完全无声：失败时把原因记到 `alertCountError` 并只清空计数，
 * 列表照常展示（页面上会少一列数字，而不是给出错误结论）。
 */
const alertCounts = ref<Record<string, number | string>>({});

const alertCountError = ref('');

/** 勾选设备的 id 列表（批量启停/删除的目标；由 vxe `checkbox-change` 同步）。 */
const selectedIds = ref<string[]>([]);

/** 批量请求在途：防重复提交（按钮同时进入禁用态）。 */
const batchPending = ref(false);

/** 导出请求在途：按钮 loading + 防重复点击。 */
const exportLoading = ref(false);

/**
 * 批量按钮的**禁用原因**（空串 = 可用）。
 *
 * 🔴 为什么要把原因分开：「未勾选」与「请求在途」在视觉上都只是一排灰按钮，
 * 用户无法判断该做什么（勾选？还是等？）。拆出原因后由模板给出 Tooltip。
 */
const batchDisabledReason = computed(() =>
  resolveBatchDisabledReason(selectedIds.value.length, batchPending.value),
);

/** 批量按钮是否禁用（与 {@link batchDisabledReason} 同源，避免两处判断漂移）。 */
const batchActionDisabled = computed(() => batchDisabledReason.value !== '');

/** 禁用原因的人话（可用时为空串 ⇒ 不渲染 Tooltip）。 */
const batchDisabledTooltip = computed(() => {
  switch (batchDisabledReason.value) {
    case 'noSelection': {
      return $t('page.iot.common.disabledSelectFirst');
    }
    case 'pending': {
      return $t('page.iot.common.disabledPending');
    }
    default: {
      return '';
    }
  }
});

/** 批量打标签/移除标签的禁用原因（只受「未勾选」影响，与批量写操作不同源）。 */
const tagDisabledTooltip = computed(() =>
  selectedIds.value.length === 0
    ? $t('page.iot.common.disabledSelectFirst')
    : '',
);

/**
 * 列表查询的「静默丢弃」守卫（见 `../shared/refresh-guard.ts`）。
 *
 * 生命周期：`useVbenVxeGrid` 返回的 api 先就位，再创建守卫；网格真正挂载/查询发生在
 * setup 之后，闭包拿到的引用必然已赋值。
 */
let deviceGuard: RefreshGuard;

/**
 * `?productId=` 带来的**初始筛选值**（产品详情「添加设备」与按产品浏览共用这个参数）。
 *
 * 只在组件初始化时读取：搜索表单的 `defaultValue` 会随首次查询一起提交，
 * 因此「带 productId 打开台账」天然是筛选后的结果；用户之后可在表单里改/清空。
 * `action=create` 的消费链路（见 `consumeCreateQuery`）保持不变：同一个 productId
 * 既预填筛选、又预选设备表单，两件事互不冲突。
 */
const initialProductId =
  typeof route.query.productId === 'string' && route.query.productId !== ''
    ? route.query.productId
    : undefined;

/**
 * `device-status` 实时事件的去抖窗口（800ms）。
 *
 * 启停/删除本身是低频写操作，但批量启停会一次推一条 `deviceIds`、紧接着可能还有别的写事件；
 * 800ms 合并既不会让用户觉得「状态没更新」，也不会把列表打成请求风暴。
 * 明确**不订阅** `latest`（高频读数事件），避免一屏点位上报把台账重查成轮询。
 */
const REALTIME_DEVICE_STATUS_DEBOUNCE_MS = 800;

const [Grid, gridApi] = useVbenVxeGrid({
  // 搜索表单字段名与后端 `IotDeviceQuery` 同名（keyword/productId/protocol），submitOnChange 即时查询
  formOptions: {
    schema: useGridFormSchema(initialProductId),
    submitOnChange: true,
  },
  /**
   * 🔴 **勾选事件必须走 gridEvents，不能只写模板上的 @checkbox-change**。
   *
   * 机制事实（已实测核实，2026-10-15）：vben 的 `<Grid>` 包装组件把未声明的 attrs 透传到自身**根 div**，
   * 而 vxe 的真实 `checkbox-change` 事件只由内层 `<VxeGrid>` 的 `v-on="events"` 绑定
   * （见 packages/effects/plugins/src/vxe-table/use-vxe-grid.vue）。Vue 自定义事件不冒泡 ⇒
   * 模板上的 `@checkbox-change` **收不到**，`selectedIds` 永远是空、所有批量按钮恒为禁用。
   * 这也是既有「批量启用/停用/删除/打标签」在页面上从不激活的根因（既有用例用桩 Grid 直接 emit，
   * 结构性掩盖了它）。`gridEvents` 是 vben 文档化的接线方式，与 alerts 页同一写法。
   */
  gridEvents: {
    checkboxChange: onCheckboxChange,
    /**
     * 翻页与工具栏按钮（刷新/查询）由 vxe 自己发起 `commitProxy`，
     * 页面拿不到调用点 ⇒ 只能靠这两个事件登记「查询意图」。
     * 在途时 vxe 会**直接丢弃**这次查询（`grid.js` 的 `tableLoading` 早退），
     * 由守卫在周期结束后用最新状态补发（否则用户点刷新/翻页「什么都没发生」）。
     */
    pageChange: () => deviceGuard.markIntent(),
    toolbarButtonClick: ({ code }: { code?: string }) => {
      if (code === 'reload' || code === 'query') {
        deviceGuard.markIntent();
      }
    },
    // 残余缺口（如实登记，不假装已覆盖）：vben 搜索表单的提交/重置走适配层
    // `api.reload()`（`commitProxy('reload')`），**不触发 vxe 的任何 grid 事件** ⇒
    // 在途时提交筛选仍可能被丢弃且无法登记意图。该窗口极窄（只在慢查询在途期间），
    // 与告警页同一已知边界；彻底收口需要改 vben 适配层（`packages/effects/plugins`），
    // 不在本页/本轮范围。
  },
  gridOptions: {
    columns: useColumns(),
    height: 'auto',
    keepSource: true,
    pagerConfig: { enabled: true },
    // 勾选行高亮；勾选列在 data.ts 的 columns 里显式声明
    checkboxConfig: { highlight: true },
    proxyConfig: {
      ajax: {
        query: async ({ page }, formValues: IotDeviceApi.DeviceQuery = {}) => {
          // 查询真正启动 ⇒ 任何刷新意图都被执行了（没被 vxe 丢弃），消费掉
          deviceGuard.consumeIntent();
          // 翻页/筛选/刷新会整表重载：旧页勾选的 id 不能继续留在批量目标里
          // （否则界面上看不到勾选、按钮却可用，可能对上一页设备误操作）。
          selectedIds.value = [];
          try {
            // 搜索条件原样透传（字段与后端同名，不做改名校验/映射）。
            // 客户端超时：`ajax.query` 不无限挂起（挂起时 vxe 的 tableLoading 永远为真，
            // 之后的查询全被丢弃）⇒ 超时改写成用户看得懂的话，沿既有失败链展示。
            const result = await withQueryTimeout(
              getDevicePage({
                page: page.currentPage,
                pageSize: page.pageSize,
                ...formValues,
              }),
            ).catch((error: unknown) => {
              if (error instanceof QueryTimeoutError) {
                throw new TypeError($t('page.iot.common.queryTimeout'));
              }
              throw error;
            });
            listError.value = '';
            await loadAlertCounts(result.items ?? []);
            // 后端 `PageResult.total` 是 `long` ⇒ 全局序列化成**字符串**（`"17"`），
            // 而 vxe 的 pager 拿到 total 后要做算术语义（页数 = ceil(total/pageSize)）⇒
            // 在**进入表格前**转成 number，别把契约违例一路喂到分页组件里。
            const total = toBackendNumber(result.total);
            // 查到空页但总数 > 0 ⇒ 数据在别的页（同事删除/实时删除事件/筛选变化都可能造成）：
            // 改查「还有数据的最后一页」并登记意图，由守卫补发。否则 `#empty` 槽会把
            // 「本页空了」说成「一台设备都没有」（P1-9 的兜底防线）。
            if ((result.items?.length ?? 0) === 0 && page.currentPage > 1) {
              const corrected = resolvePageAfterEmptyQuery(
                page.pageSize,
                total,
              );
              if (corrected > 0 && corrected !== page.currentPage) {
                setGridCurrentPage(corrected);
                deviceGuard.markIntent();
              }
            }
            return { ...result, total };
          } catch (error) {
            // 记下失败原因（原样展示后端 message），再把异常**继续抛出**：
            // 不改动原有失败语义（全局拦截器照旧弹提示、vxe 照旧走失败分支）。
            listError.value = extractErrorMessage(
              error,
              $t('page.iot.device.listLoadFailed'),
            );
            throw error;
          } finally {
            // 一个查询周期结束（成功或失败）⇒ 若这段时间里有被丢弃的刷新意图，守卫补发
            deviceGuard.notifyCycleEnd();
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
  } as VxeTableGridOptions<IotDeviceApi.DeviceResp>,
});

deviceGuard = createRefreshGuard({
  isBusy: () => Boolean(gridApi.grid?.reactData?.tableLoading),
  issue: () => {
    void gridApi.query();
  },
  onTrailing: (active) => gridApi.setLoading(active),
});

// ---------------------------------------------------------------- 实时状态

/**
 * 实时鉴权失败原因（实时层在 401/403 后写入：401 ⇒ `unauthorized`，403 ⇒ `forbidden`）。
 *
 * 为什么需要它：`state === 'unauthorized'` 时实时流**不会自动重连**（401/403 重试没有意义，
 * 且会被后端当异常流量），页面若只看 `reconnecting` 就完全不提示 ⇒ 用户拿过期数据做处置。
 * 所以鉴权失败必须是一条**常驻**提示（见模板里的 Alert），并在重登后由实时层自愈。
 */
const {
  authError: realtimeAuthError,
  error: realtimeError,
  onEvent: onRealtimeEvent,
  state: realtimeState,
} = useIotRealtime();

/** 断线/重连中才提示；首次 `connecting` 不闪提示（与告警中心同一口径）。 */
const realtimeDisconnected = computed(
  () => realtimeState.value === 'reconnecting',
);

/** 实时鉴权失败（持续状态，必须常驻提示而不是一次性 toast）。 */
const realtimeUnauthorized = computed(() => realtimeAuthError.value !== '');

/**
 * 重新登录：复用全局会话过期入口（清 token + 按登录过期模式弹窗/登出），
 * 不在本页自己实现登出，避免与请求拦截器的会话语义分叉。
 *
 * 403（无实时端点权限）不给这个按钮：重新登录不会改变角色权限。
 */
async function handleRealtimeReLogin() {
  try {
    await handleSessionExpired();
  } catch (error) {
    // 登出本身也可能失败（例如网络/存储异常）：必须给用户可见反馈，不能静默
    message.error(
      extractErrorMessage(error, $t('ui.actionMessage.operationFailed')),
    );
  }
}

/** 工具栏实时状态 Tag：`closed`（无 token/已释放）不渲染，避免误报「实时」。 */
const realtimeTag = computed(() => {
  switch (realtimeState.value) {
    case 'connecting': {
      return {
        color: 'processing',
        text: $t('page.iot.realtime.connecting'),
      };
    }
    case 'live': {
      return { color: 'success', text: $t('page.iot.realtime.live') };
    }
    case 'reconnecting': {
      return { color: 'warning', text: $t('page.iot.realtime.reconnecting') };
    }
    default: {
      // `closed` / `unauthorized` 等状态**不得**显示成绿色「实时连接」：
      // 那是「数据在实时更新」的承诺，此时恰恰没有实时数据（鉴权失败另有常驻 Alert）。
      return null;
    }
  }
});

/** 当前表格可见行的设备 id（vxe 拿不到数据时返回空集合，不刷新）。 */
function currentVisibleDeviceIds(): string[] {
  const rows = (gridApi.grid?.getData?.() ?? []) as IotDeviceApi.DeviceResp[];
  return rows.map((row) => String(row.id));
}

/**
 * `device-status` → 当前页去抖刷新。
 *
 * 只对**命中当前可见行**的事件刷新（单台 deviceId / 批量 deviceIds / 删除 deviceIds 或
 * deletedIds）；无关设备的事件不产生任何请求。无设备上下文的事件按保守策略刷新一次。
 *
 * 走守卫 `request()`：实时事件常与用户操作/上一轮查询重叠，直接 `query()` 会被 vxe 静默丢弃
 * （表现为「提示已离线但列表状态没变」）。
 */
const refreshOnDeviceStatus = createTrailingDebounce(() => {
  deviceGuard.request();
}, REALTIME_DEVICE_STATUS_DEBOUNCE_MS);

onRealtimeEvent('device-status', (payload) => {
  if (deviceStatusTouchesDevices(payload, currentVisibleDeviceIds())) {
    refreshOnDeviceStatus();
  }
});

onUnmounted(() => {
  refreshOnDeviceStatus.cancel();
  deviceGuard?.dispose();
});

/**
 * 批量取本页设备的活动告警数（一次请求；空页直接短路，不发请求）。
 *
 * 失败**不影响列表**：清空计数并把原因记到 `alertCountError`（控制台留痕），
 * 列上显示 `-`。把「计数查询失败」渲染成「设备列表加载失败」会让用户以为整页不可用。
 */
async function loadAlertCounts(items: IotDeviceApi.DeviceResp[]) {
  const ids = items.map((item) => item.id).filter((id) => !!id);
  if (ids.length === 0) {
    alertCounts.value = {};
    alertCountError.value = '';
    return;
  }
  try {
    alertCounts.value = await getActiveAlertCounts(ids);
    alertCountError.value = '';
  } catch (error) {
    alertCounts.value = {};
    alertCountError.value = extractErrorMessage(
      error,
      $t('page.iot.alert.activeCountLoadFailed'),
    );
    console.warn('[iot] 活动告警数查询失败（列表照常展示）', error);
  }
}

/**
 * 「从产品一键添加设备」落地处：产品详情点「添加设备」时带
 * `?productId=xxx&action=create` 跳到这里，设备表单打开并预选该产品。
 *
 * 用 `?action=create` 显式表达意图（只在带它时自动开表单）：单纯带 `productId` 浏览台账
 * 不应该弹出表单。参数消费后清掉，避免刷新/后退又弹一次。
 */
function consumeCreateQuery() {
  const productId = route.query.productId;
  if (route.query.action !== 'create' || typeof productId !== 'string') {
    return;
  }
  FormDrawerApi.setData({ productId }).open();
  deviceGuard.request();
  // 参数只消费一次：不清理的话刷新/切回标签页会再弹一次表单
  void router.replace({ query: {} });
}

onMounted(consumeCreateQuery);
watch(() => route.query.action, consumeCreateQuery);

function onEdit(row: IotDeviceApi.DeviceResp) {
  FormDrawerApi.setData(row).open();
}

function onDetail(row: IotDeviceApi.DeviceResp) {
  DetailDrawerApi.setData(row).open();
}

function onAvailability(row: IotDeviceApi.DeviceResp) {
  AvailabilityDrawerApi.setData(row).open();
}

function onSeries(row: IotDeviceApi.DeviceResp) {
  SeriesDrawerApi.setData(row).open();
}

/** 跳到全局告警中心并带上该设备（设备台账 → 告警的**第二个入口**，第一个在设备详情页签）。 */
function onAlerts(row: IotDeviceApi.DeviceResp) {
  router.push({ path: '/iot/alerts', query: { deviceId: row.id } });
}

/**
 * 读 vxe 分页快照（当前页/每页/删除前总数）。
 *
 * 未挂载或测试桩没有 `reactData` 时返回 `undefined` ⇒ 页面**不做**页码判断，
 * 行为与改动前完全一致（不去猜 vxe 内部状态）。
 */
function readPagerSnapshot():
  | undefined
  | { currentPage: number; pageSize: number; totalBefore: number } {
  const tablePage = gridApi.grid?.reactData?.tablePage as
    | undefined
    | { currentPage?: number; pageSize?: number; total?: number };
  if (!tablePage) {
    return undefined;
  }
  const currentPage = toBackendNumber(tablePage.currentPage ?? 0);
  const pageSize = toBackendNumber(tablePage.pageSize ?? 0);
  const totalBefore = toBackendNumber(tablePage.total ?? 0);
  if (currentPage <= 0 || pageSize <= 0) {
    return undefined;
  }
  return { currentPage, pageSize, totalBefore };
}

/**
 * 设置 vxe 当前页码。
 *
 * vxe 4.22.4 **没有**公开的 `setPager`：分页状态就是 `reactData.tablePage`（响应式），
 * 翻页时 vxe 自己也是直接改这个对象（`grid.js:355`）。
 */
function setGridCurrentPage(page: number) {
  const tablePage = gridApi.grid?.reactData?.tablePage as
    | undefined
    | { currentPage?: number };
  if (tablePage) {
    tablePage.currentPage = page;
  }
}

/**
 * 删除成功后的刷新（单删与批量删共用）。
 *
 * 🔴 不能只 `query()`：vxe 只在 `initial`/`reload` 时重置页码（4.22.4 `grid.js:968`），
 * `query` **保留当前页** ⇒ 删光最后一页的最后一条后仍查 `page=N`，得到一张空表，
 * 而空态插槽会把「本页空了」说成「还没有设备」。这里先按
 * {@link resolvePageAfterDelete} 判断是否需要回退页码，再走守卫刷新。
 *
 * @param deletedCount 本次**实际生效**的删除台数（后端 `R<Integer>`）
 */
function refreshAfterDelete(deletedCount: number) {
  const pager = readPagerSnapshot();
  if (pager) {
    const rows = (gridApi.grid?.getData?.() ?? []) as IotDeviceApi.DeviceResp[];
    const nextPage = resolvePageAfterDelete({
      ...pager,
      deletedCount,
      visibleCount: rows.length,
    });
    if (nextPage !== pager.currentPage) {
      setGridCurrentPage(nextPage);
      message.info($t('page.iot.device.pageRollbackHint'));
    }
  }
  deviceGuard.request();
}

/**
 * 按后端**实际生效台数**播报批量结果（审查 P1-5）。
 *
 * 为什么不能用勾选数：勾中的设备可能已被他人删除、或已处于目标状态未命中 `UPDATE`，
 * 后端 `R<Integer>` 才是真相。报「已删除 3 台」而实际只删掉 2 台，会让用户以为处理完了。
 */
function announceBatchOutcome(outcome: BatchOutcome, fullSuccessKey: string) {
  if (outcome.level === 'none') {
    message.info($t('page.iot.device.batchNoChange'));
    return;
  }
  if (outcome.level === 'partial') {
    message.warning(
      $t('page.iot.device.batchPartialDone', [
        String(outcome.affected),
        String(outcome.notEffective),
      ]),
    );
    return;
  }
  message.success($t(fullSuccessKey, [String(outcome.affected)]));
}

function onDelete(row: IotDeviceApi.DeviceResp) {
  deleteDevice(row.id)
    .then(() => {
      message.success($t('common.success'));
      // 单删同样可能删空当前页 ⇒ 走统一的「页码回落 + 守卫刷新」
      refreshAfterDelete(1);
    })
    // 失败提示由全局请求拦截器统一处理，这里仅兜底避免未处理拒绝
    .catch(() => {});
}

/** vxe 勾选变化 → 同步批量操作的目标 id（字符串，铁律 9）。由 gridEvents.checkboxChange 调用。 */
function onCheckboxChange(params: { records?: IotDeviceApi.DeviceResp[] }) {
  selectedIds.value = (params?.records ?? []).map((item) => String(item.id));
}

/**
 * 清空勾选：既清 ref，也清 vxe 的勾选视觉态。
 *
 * 只把 `selectedIds` 置空是不够的——表格行首的复选框仍会勾着（用户会以为还会对这些行操作）。
 * `clearCheckboxRow()` 在未挂载/测试桩上可能不存在，用可选链兜底。
 */
function clearSelection() {
  selectedIds.value = [];
  gridApi.grid?.clearCheckboxRow();
}

/**
 * 批量启用/停用（`iot:device:update`）。
 *
 * - 停用是破坏性动作（接入侧解绑、撤销点位订阅）⇒ 调用方（模板）用 Popconfirm 讲清后果；
 * - 成功：按**后端实际生效台数**播报 + 清空勾选 + 刷新列表（不能只改本地行状态）；
 * - 失败：原样展示后端 message（不静默、不假装成功），且**不清空勾选**，用户可直接重试。
 */
async function onBatchStatus(status: number) {
  const ids = [...selectedIds.value];
  if (ids.length === 0 || batchPending.value) {
    return;
  }
  batchPending.value = true;
  try {
    const affected = await batchUpdateDeviceStatus(ids, status);
    announceBatchOutcome(
      resolveBatchOutcome(ids.length, affected),
      status === DEVICE_ENABLED
        ? 'page.iot.device.batchEnableDone'
        : 'page.iot.device.batchDisableDone',
    );
    clearSelection();
    // 启停不改行数 ⇒ 不需要页码回落，但仍走守卫（在途时补发）
    deviceGuard.request();
  } catch (error) {
    message.error(
      extractErrorMessage(error, $t('page.iot.device.batchStatusFailed')),
    );
  } finally {
    batchPending.value = false;
  }
}

/**
 * 批量删除（`iot:device:delete`）。
 *
 * 删除不可恢复 ⇒ 模板用 Popconfirm + danger；成功按后端实际删除台数播报 +
 * 清空勾选 + **页码回落**后刷新；失败原样展示后端 message 且保留勾选。
 */
async function onBatchDelete() {
  const ids = [...selectedIds.value];
  if (ids.length === 0 || batchPending.value) {
    return;
  }
  batchPending.value = true;
  try {
    const affected = await batchDeleteDevices(ids);
    // 同一个 outcome 既用于播报、也用于页码回落：部分未生效时本页未必被删空，
    // 页码不能按勾选数算（两处必须同源，否则会「报 2 台却按 3 台回退」）
    const outcome = resolveBatchOutcome(ids.length, affected);
    announceBatchOutcome(outcome, 'page.iot.device.batchDeleteDone');
    clearSelection();
    refreshAfterDelete(outcome.affected);
  } catch (error) {
    message.error(
      extractErrorMessage(error, $t('page.iot.device.batchDeleteFailed')),
    );
  } finally {
    batchPending.value = false;
  }
}

/**
 * 打开批量标签抽屉：目标 = 当前勾选设备（字符串 id），`mode` 决定表单与接口。
 *
 * 未勾选时按钮已禁用，这里再短路一道防呆（避免程序化调用时对空清单发请求）。
 */
function openBatchTags(mode: 'remove' | 'set') {
  if (selectedIds.value.length === 0) {
    return;
  }
  BatchTagsDrawerApi.setData({
    deviceIds: [...selectedIds.value],
    mode,
  }).open();
}

/** 批量标签成功：清空勾选 + 刷新列表（与批量启停/删除同口径；在途时由守卫补发）。 */
function onBatchTagsSuccess() {
  clearSelection();
  deviceGuard.request();
}

/**
 * 打开批量下发命令抽屉：目标是当前勾选的设备。
 *
 * 未勾选时按钮已禁用，这里再短路一道防呆（程序化调用时不能对空清单发请求）。
 * 传的是**设备对象**（需要 deviceName/deviceCode/productId 用于弹窗展示与物模辨预判），
 * 不只是 id —— 弹窗要展示「将下发到 N 台」的清单，光有 id 只能显示数字。
 */
function openBatchCommand() {
  const rows = (gridApi.grid?.getCheckboxRecords?.() ??
    []) as IotDeviceApi.DeviceResp[];
  const selected =
    rows.length > 0
      ? rows
      : // 测试桩/异常情况下退化为只有勾选 id（至少不丢目标）
        selectedIds.value.map((id) => ({ id }) as IotDeviceApi.DeviceResp);
  if (selected.length === 0) {
    return;
  }
  BatchCommandDrawerApi.setData({
    devices: selected.map((row) => ({
      deviceCode: row.deviceCode,
      deviceId: String(row.id),
      deviceName: row.deviceName,
      productId: row.productId,
    })),
  }).open();
}

/** 批量下发成功（**部分失败也算成功返回**，由弹窗逐台如实展示）：保留勾选，只刷新列表。 */
function onBatchCommandSuccess() {
  deviceGuard.request();
}

/**
 * 导出当前筛选条件下的设备台账 CSV。
 *
 * - 参数取搜索表单当前值（与列表 query 同一份字段名，不另做映射）；
 * - 文件名 `设备台账_YYYYMMDD.csv`（日期由 dayjs 生成，避免同名覆盖）；
 * - `downloadBlobSafe` 处理「HTTP 200 但响应体是业务失败 JSON」的伪文件；
 * - 请求级失败原样展示后端 message（不静默）；loading 防重复点击。
 */
async function onExportCsv() {
  if (exportLoading.value) {
    return;
  }
  exportLoading.value = true;
  try {
    const formValues = (gridApi.formApi?.form?.values ??
      {}) as IotDeviceApi.DeviceQuery;
    const blob = await exportDevicesCsv(formValues);
    const downloaded = await downloadBlobSafe(
      blob,
      `${$t('page.iot.device.exportName')}_${dayjs().format('YYYYMMDD')}.csv`,
      $t('page.iot.device.exportFailed'),
    );
    if (downloaded) {
      message.success($t('common.success'));
    }
  } catch (error) {
    message.error(
      extractErrorMessage(error, $t('page.iot.device.exportFailed')),
    );
  } finally {
    exportLoading.value = false;
  }
}

/** 打开接入向导抽屉（空态引导与工具栏按钮共用同一个入口）。 */
function openGuide() {
  GuideDrawerApi.open();
}

/**
 * 启停位与后端 `EntityStatus` 的码值对齐（1 启用 / 0 停用）。
 *
 * 用具名常量而不是散落的字面量：这两个数字同时出现在「开关取值」与「行是否停用」两处判断里，
 * 写错一处就会出现「行显示已停用、开关却是开的」这种自相矛盾的界面。
 */
const DEVICE_ENABLED = 1;

const DEVICE_DISABLED = 0;

/**
 * 正在切换启停的设备 id 集合（开关的 `loading` 与防重复提交）。
 *
 * 按行记而不是一个全局布尔：并发切换两台设备时，全局布尔会让**所有**开关一起转，
 * 也会把第二台设备的点击误判成「已在提交中」而静默丢弃（点了没反应）。
 */
const statusPending = ref<Record<string, boolean>>({});

/** 后端启停位按「启用」处理当且仅当它显式等于 1（`null/undefined` 视为启用，与 DB 默认值一致）。 */
function isDeviceEnabled(row: IotDeviceApi.DeviceResp) {
  return toBackendNumber(row.status ?? DEVICE_ENABLED) === DEVICE_ENABLED;
}

/**
 * 切换设备启停。
 *
 * 🔴 为什么要二次确认：停用是**破坏性**动作——接入侧会解绑该设备并撤销其全部点位订阅，
 * 采集立刻停止。确认文案必须把这个后果说清楚，而不是干巴巴一句「确定吗」。
 *
 * 失败时**不保留乐观状态**：`.finally` 里无条件重查列表，让开关回到后端的真实值；
 * 成功时也重查（不能只翻本地位，否则「停用是否真的生效」在界面上无从体现）。
 */
function onToggleStatus(row: IotDeviceApi.DeviceResp, checked: boolean) {
  const target = checked ? DEVICE_ENABLED : DEVICE_DISABLED;
  statusPending.value = { ...statusPending.value, [row.id]: true };
  updateDeviceStatus(row.id, target)
    .then(() => {
      message.success(
        $t(
          target === DEVICE_ENABLED
            ? 'page.iot.device.statusEnableDone'
            : 'page.iot.device.statusDisableDone',
        ),
      );
    })
    .catch((error: unknown) => {
      // 原样展示后端 message：全局拦截器也会弹一次，但这里给出的是「这次切换没生效」的明确结论
      message.error(
        extractErrorMessage(error, $t('page.iot.device.statusUpdateFailed')),
      );
    })
    .finally(() => {
      // 用「删键后重新赋值」而不是 `delete`：oxlint 的 `no-dynamic-delete` 禁止对动态键做
      // delete（频繁删除会把对象推进字典模式、伤内联缓存）。这里用解构剔除该 id，
      // 语义与原写法一致（未在途的行不再有 loading 标记）。
      const { [row.id]: _removed, ...rest } = statusPending.value;
      void _removed;
      statusPending.value = rest;
      // 启停结果必须以后端为准（失败也要把开关拉回真实值）⇒ 守卫刷新
      deviceGuard.request();
    });
}

/**
 * 向导第 3 步点了「添加设备」：先关向导，否则它会盖在设备表单抽屉上；
 * 表单本身由 `consumeCreateQuery()` 消费 `?productId=&action=create` 后打开（同一条既有链路）。
 */
function onGuideAddDevice() {
  GuideDrawerApi.close();
}

/** 打开租户接入台账抽屉（仅平台管理员可见：按钮由 `iot:ledger:list` 权限码门禁）。 */
function openLedger() {
  LedgerDrawerApi.open();
}

/**
 * 打开批量导入抽屉。
 *
 * 入口按 `iot:device:import` 门禁（**新造的权限码**，不复用 `iot:device:create`）：
 * 批量导入一次能建上万台设备，比单条创建高危得多；复用 create 会让「只想让某角色逐台建」
 * 的租户被迫放开批量口子。
 *
 * 抽屉打开时补拉一次列表，覆盖「上次打开后又传了一批」的情况。
 */
function openImport() {
  ImportDrawerApi.open();
  // 打开时拉一次批次列表（覆盖「上次打开后又传了一批」的情况）。
  // 组件可能还没挂载（首次打开时抽屉内容是懒挂的）⇒ 用可选链，挂载后由组件自己的
  // onMounted 拉取，两条路径都不会漏。
  ImportPanel.value?.onOpen?.();
}
</script>
<template>
  <Page auto-content-height>
    <FormDrawer @reload="deviceGuard.request()" />
    <DetailDrawer />
    <AvailabilityDrawer />
    <SeriesDrawer />
    <GuideDrawer
      :title="$t('page.iot.onboarding.title')"
      class="w-full max-w-[900px]"
    >
      <OnboardingGuide
        @add-device="onGuideAddDevice"
        @done="deviceGuard.request()"
      />
    </GuideDrawer>
    <LedgerDrawer
      :title="$t('page.iot.ledger.pageTitle')"
      class="w-full max-w-[1000px]"
    >
      <TenantLedger />
    </LedgerDrawer>
    <ImportDrawer
      :title="$t('page.iot.device.import.title')"
      class="w-full max-w-[1000px]"
    >
      <DeviceImport ref="ImportPanel" />
    </ImportDrawer>
    <BatchTagsDrawer @success="onBatchTagsSuccess" />
    <BatchCommandDrawer @success="onBatchCommandSuccess" />
    <!--
      🔴 失败态**必须挂在表格之外**（不能只放 `#empty` 槽里）：
      真实 vxe 只在**表体没有行**时才渲染 `#empty` 槽 ⇒ 若把失败提示只放槽里，
      「已有数据后刷新失败」时旧行仍在、槽不渲染 ⇒ 失败提示**看不见**（只剩一次转瞬即逝的 toast），
      页面会继续展示**过期数据**而用户毫不知情。放在表格上方则任何一次失败都可见。
    -->
    <!--
      活动告警数查询失败：**辅助信息失败不能把设备列表画成失败态**，但也不能静默无声
      （列上只会显示 `-`，用户会以为「这台设备没有告警」）。因此单独一条可关闭的提示。
    -->
    <ListErrorAlert
      v-if="alertCountError"
      :error="alertCountError"
      :title="$t('page.iot.alert.activeCountLoadFailed')"
      closable
      type="warning"
      @close="alertCountError = ''"
    />
    <!-- 实时连接中断：可见提示但不阻塞页面（列表仍可手动刷新） -->
    <ListErrorAlert
      v-if="realtimeDisconnected"
      :error="$t('page.iot.realtime.disconnectedHint', [realtimeError || '-'])"
      :title="$t('page.iot.realtime.disconnected')"
      type="warning"
    />
    <!--
      实时鉴权失败（401/403）：实时层**不自动重连**，页面若只提示 reconnecting 就完全不提示，
      用户会拿过期数据做处置。因此这里常驻一条 Alert：
      - unauthorized（会话可能过期）⇒ 给「重新登录」按钮（复用全局会话过期入口）；
      - forbidden（角色无实时端点权限）⇒ 重新登录也没用，只说明原因、不给按钮。
    -->
    <Alert
      v-if="realtimeUnauthorized"
      show-icon
      type="warning"
      :message="
        $t(
          realtimeAuthError === 'unauthorized'
            ? 'page.iot.realtime.authFailed'
            : 'page.iot.realtime.forbidden',
        )
      "
    >
      <template v-if="realtimeAuthError === 'unauthorized'" #action>
        <Button
          data-testid="realtime-relogin"
          size="small"
          @click="handleRealtimeReLogin"
        >
          {{ $t('authentication.loginAgainTitle') }}
        </Button>
      </template>
    </Alert>
    <ListErrorAlert
      :error="listError"
      :title="$t('page.iot.device.listLoadFailed')"
    />
    <!--
      勾选事件不写在这里：vben 的 Grid 会把未声明的 attrs 透传到自身根 div，而 vxe 的
      checkbox-change 只绑定在内层 VxeGrid 上（自定义事件不冒泡）⇒ 模板监听收不到，
      selectedIds 恒为空、所有批量按钮恒禁用。正确接线是 gridOptions 同级的
      gridEvents.checkboxChange（见脚本内注释）。
    -->
    <Grid>
      <template #toolbar-tools>
        <div class="flex flex-wrap items-center gap-2">
          <!-- 实时连接状态：live/connecting/reconnecting；closed（无 token）不渲染 -->
          <Tag v-if="realtimeTag" :color="realtimeTag.color">
            {{ realtimeTag.text }}
          </Tag>
          <!-- 接入向导入口：不带权限码（所有角色可见，先知道下一步做什么）； -->
          <!-- 向导里的写动作各自沿用 iot:product:create / iot:product:publish / iot:device:create。 -->
          <Button @click="openGuide">
            {{ $t('page.iot.onboarding.openGuide') }}
          </Button>
          <!-- 租户接入台账：平台级权限（platform_only=1），非平台管理员看不到这个按钮 -->
          <Button v-access:code="['iot:ledger:list']" @click="openLedger">
            {{ $t('page.iot.ledger.pageTitle') }}
          </Button>
          <!--
          批量运维：按钮按权限码显示（iot:device:update / iot:device:delete），
          未勾选或批量请求在途时禁用。启用无破坏性后果直接执行；停用/删除必须 Popconfirm 讲清后果。
        -->
          <Tooltip :title="batchDisabledTooltip">
            <span class="inline-block" :tabindex="batchActionDisabled ? 0 : -1">
              <Button
                v-access:code="['iot:device:update']"
                data-testid="batch-enable"
                :disabled="batchActionDisabled"
                @click="onBatchStatus(DEVICE_ENABLED)"
              >
                {{ $t('page.iot.device.batchEnable') }}
              </Button>
            </span>
          </Tooltip>
          <Popconfirm
            :cancel-text="$t('common.cancel')"
            :ok-text="$t('page.iot.device.disabled')"
            :title="
              $t('page.iot.device.batchDisableConfirm', [
                String(selectedIds.length),
              ])
            "
            @confirm="onBatchStatus(DEVICE_DISABLED)"
          >
            <Tooltip :title="batchDisabledTooltip">
              <span
                class="inline-block"
                :tabindex="batchActionDisabled ? 0 : -1"
              >
                <Button
                  v-access:code="['iot:device:update']"
                  data-testid="batch-disable"
                  :disabled="batchActionDisabled"
                >
                  {{ $t('page.iot.device.batchDisable') }}
                </Button>
              </span>
            </Tooltip>
          </Popconfirm>
          <Popconfirm
            :cancel-text="$t('common.cancel')"
            :ok-text="$t('common.delete')"
            :title="
              $t('page.iot.device.batchDeleteConfirm', [
                String(selectedIds.length),
              ])
            "
            @confirm="onBatchDelete"
          >
            <Tooltip :title="batchDisabledTooltip">
              <span
                class="inline-block"
                :tabindex="batchActionDisabled ? 0 : -1"
              >
                <Button
                  v-access:code="['iot:device:delete']"
                  danger
                  data-testid="batch-delete"
                  :disabled="batchActionDisabled"
                >
                  {{ $t('page.iot.device.batchDelete') }}
                </Button>
              </span>
            </Tooltip>
          </Popconfirm>
          <!--
            批量下发命令：权限沿用 iot:debug:send（后端 @SaCheckPermission 同码）；
            未勾选或批量请求在途时禁用。批量会**明确拒绝停用设备**（单台端点不拒），
            该结果由弹窗逐台如实展示。
          -->
          <Tooltip :title="batchDisabledTooltip">
            <span class="inline-block" :tabindex="batchActionDisabled ? 0 : -1">
              <Button
                v-access:code="['iot:debug:send']"
                data-testid="batch-command"
                :disabled="batchActionDisabled"
                @click="openBatchCommand"
              >
                {{ $t('page.iot.device.batchCommand.entry') }}
              </Button>
            </span>
          </Tooltip>
          <!-- 批量打标签：后端权限为 iot:tag:create/update 任一（SaMode.OR），故两码都放行 -->
          <Tooltip :title="tagDisabledTooltip">
            <span class="inline-block" :tabindex="tagDisabledTooltip ? 0 : -1">
              <Button
                v-access:code="['iot:tag:create', 'iot:tag:update']"
                data-testid="batch-tag-set"
                :disabled="selectedIds.length === 0"
                @click="openBatchTags('set')"
              >
                {{ $t('page.iot.device.batchTagSet') }}
              </Button>
            </span>
          </Tooltip>
          <Tooltip :title="tagDisabledTooltip">
            <span class="inline-block" :tabindex="tagDisabledTooltip ? 0 : -1">
              <Button
                v-access:code="['iot:tag:delete']"
                data-testid="batch-tag-remove"
                :disabled="selectedIds.length === 0"
                @click="openBatchTags('remove')"
              >
                {{ $t('page.iot.device.batchTagRemove') }}
              </Button>
            </span>
          </Tooltip>
          <!-- 导出当前筛选结果（服务端全量，不是当前页）；权限沿用列表读权限 -->
          <Button
            v-access:code="['iot:device:list']"
            data-testid="export-csv"
            :loading="exportLoading"
            @click="onExportCsv"
          >
            <template #icon><Download /></template>
            {{ $t('page.iot.device.exportCsv') }}
          </Button>
          <!-- 批量导入（CSV）：一次能建上万台设备 ⇒ 独立权限码 iot:device:import -->
          <Button v-access:code="['iot:device:import']" @click="openImport">
            {{ $t('page.iot.device.import.title') }}
          </Button>
          <Button
            v-access:code="['iot:device:create']"
            type="primary"
            @click="FormDrawerApi.setData(null).open()"
          >
            <template #icon><Plus /></template>
            {{ $t('ui.actionTitle.create', [$t('page.iot.device.name')]) }}
          </Button>
        </div>
      </template>

      <!-- 空态引导：说明「为什么是空的 + 下一步点哪里」，而不是一张空白表格 -->
      <!-- 🔴 但**失败不能画成空态**：加载失败时由上方 Alert 承担失败态，这里不得再声称「没有数据」 -->
      <template #empty>
        <EmptyGuide
          v-if="!listError"
          :reason="$t('page.iot.device.emptyReason')"
          @open-guide="openGuide"
        />
      </template>

      <template #alertActive="{ row }">
        <Tag v-if="toBackendNumber(alertCounts[row.id] ?? 0) > 0" color="error">
          {{ toBackendNumber(alertCounts[row.id] ?? 0) }}
        </Tag>
        <span v-else class="text-muted-foreground">-</span>
      </template>

      <!--
        启停开关。
        🔴 这里用 `Popconfirm` **包住** `Switch`，而不是给 Switch 传 `popconfirm` 属性：
        ant-design-vue 4.2.6 的 Switch **没有** `popconfirm` 这个 prop（只有 React antd 有），
        传进去会被静默忽略 ⇒ 「停用会停止采集」这道确认**根本不会弹**。
        `Popconfirm` 只在**要停用时**才渲染（`v-if="isDeviceEnabled(row)"`）：启用没有意外后果，
        若也弹确认，用户会习惯性点确定 ⇒ 真正危险的那次确认就失去拦截力。
        开关是**受控**的（`:checked` + `@change` 后重查），不做乐观翻转——
        慢请求期间先翻再回滚等于界面先撒一次谎。
      -->
      <template #status="{ row }">
        <Popconfirm
          v-if="isDeviceEnabled(row)"
          :cancel-text="$t('common.cancel')"
          :ok-text="$t('page.iot.device.disabled')"
          :title="$t('page.iot.device.statusConfirmDisable')"
          @confirm="onToggleStatus(row, false)"
        >
          <Switch
            v-access:code="['iot:device:update']"
            :aria-label="$t('page.iot.device.status')"
            :checked="true"
            :loading="!!statusPending[row.id]"
            size="small"
          />
        </Popconfirm>
        <Switch
          v-else
          v-access:code="['iot:device:update']"
          :aria-label="$t('page.iot.device.status')"
          :checked="false"
          :loading="!!statusPending[row.id]"
          size="small"
          @change="() => onToggleStatus(row, true)"
        />
        <Tag v-if="!isDeviceEnabled(row)" class="ml-1" color="default">
          {{ $t('page.iot.device.statusDisabledTag') }}
        </Tag>
      </template>

      <!--
        操作列：详情/编辑留在行内，告警/可用率/历史曲线/删除收进「更多」下拉。
        6 个 icon+文字按钮横排会被固定列宽挤成省略号；权限码与各动作入口保持不变。
      -->
      <template #action="{ row }">
        <VbenTableAction
          :actions="[
            {
              text: $t('page.iot.device.detail'),
              icon: 'lucide:info',
              auth: 'iot:device:list',
              onClick: () => onDetail(row),
            },
            {
              text: $t('common.edit'),
              icon: 'lucide:edit',
              auth: 'iot:device:update',
              onClick: () => onEdit(row),
            },
          ]"
          :dropdown-actions="[
            {
              text: $t('page.iot.alert.title'),
              icon: 'lucide:bell-ring',
              auth: 'iot:alert:list',
              onClick: () => onAlerts(row),
            },
            {
              text: $t('page.iot.availability.title', ['']),
              icon: 'lucide:activity',
              auth: 'iot:availability:get',
              onClick: () => onAvailability(row),
            },
            {
              text: $t('page.iot.series.title'),
              icon: 'lucide:chart-line',
              auth: 'iot:series:get',
              onClick: () => onSeries(row),
            },
            {
              text: $t('common.delete'),
              icon: 'lucide:trash-2',
              auth: 'iot:device:delete',
              danger: true,
              popConfirm: {
                title: $t('ui.actionMessage.deleteConfirm', [
                  row.deviceName || row.deviceCode || '',
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
