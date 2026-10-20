/**
 * 设备台账「列表查询」组合式：vxe Grid 配置 + 静默丢弃守卫 + 三态/失败态 + 活动告警数 + 分页取值。
 *
 * 为什么抽出来（审查 P2-7）：这页原本把「查询/守卫/失败态/辅助计数」和「批量/启停/导出/抽屉编排」
 * 混在 1200 行里，一次改动要在四种关注点间跳转。这里收口三件事：
 * 1. vxe `proxyConfig.ajax.query` 的**唯一**实现（含客户端超时与空页兜底）；
 * 2. `refresh-guard` 的创建与释放（在途查询被 vxe 丢弃时补发）；
 * 3. 「失败态 vs 空态」判据的数据来源（`listError` / `alertCountError`）。
 *
 * 不在这里做的事：勾选、批量动作、启停、导出、抽屉编排（各自有组合式）。
 * 勾选状态属于「批量」组合式，但**查询开始要清空旧页勾选**，所以这里只暴露
 * `setQueryStartHandler` 让宿主在装配阶段注入，避免两个组合式互相 import 成环。
 */
import type { RefreshGuard } from '../../shared/refresh-guard';
import type { PagerSnapshot } from '../list-actions';

import type { VxeTableGridOptions } from '#/adapter/vxe-table';
import type { IotDeviceApi } from '#/api/iot';

import { onUnmounted, ref } from 'vue';

import { useVbenVxeGrid } from '#/adapter/vxe-table';
import { getActiveAlertCounts, getDevicePage } from '#/api/iot';
import { $t } from '#/locales';
import { toBackendNumber } from '#/utils/backend-number';
import { extractErrorMessage } from '#/utils/error';

import {
  createRefreshGuard,
  QueryTimeoutError,
  withQueryTimeout,
} from '../../shared/refresh-guard';
import { useColumns, useGridFormSchema } from '../data';
import { resolvePageAfterEmptyQuery } from '../list-actions';

export interface UseDeviceListOptions {
  /** `?productId=` 带来的初始筛选值（产品详情「添加设备」/按产品浏览共用）。 */
  initialProductId?: string;
}

export function useDeviceList(options: UseDeviceListOptions = {}) {
  /**
   * 列表**加载失败**的原因（非空即代表「这次没取到数据」）。
   *
   * 🔴 为什么必须有它：vxe 的 `#empty` 插槽在「**加载失败**」与「**确实没有数据**」两种情况下
   * 长得一模一样 ⇒ 只挂一个 `EmptyGuide` 就是把失败画成「还没有设备，去创建吧」。
   * 失败虽然会由全局请求拦截器弹一次 toast，但 toast 是**转瞬即逝**的：用户错过它之后，
   * 页面上永久留着「没有数据」这个**错误结论**（这正是「假空态」）。
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

  /**
   * 查询开始时的额外动作（宿主注入：清空旧页勾选）。
   *
   * 用**可变钩子**而不是构造参数的回调：批量组合式依赖本组合式返回的 `gridApi`/`guard`，
   * 若本组合式再直接依赖批量组合式就成环。装配顺序由宿主决定（见 index.vue）。
   */
  let queryStartHandler: (() => void) | undefined;

  /**
   * 列表查询的「静默丢弃」守卫（见 `../../shared/refresh-guard.ts`）。
   *
   * 生命周期：`useVbenVxeGrid` 返回的 api 先就位，再创建守卫；网格真正挂载/查询发生在
   * setup 之后，闭包拿到的引用必然已赋值。
   */
  let guard: RefreshGuard;

  /** 勾选变化的回调（宿主装配阶段由批量组合式注入；未注入时忽略事件）。 */
  let onCheckboxChange:
    | ((params: { records?: IotDeviceApi.DeviceResp[] }) => void)
    | undefined;

  const [Grid, gridApi] = useVbenVxeGrid({
    // 搜索表单字段名与后端 `IotDeviceQuery` 同名（keyword/productId/protocol），submitOnChange 即时查询
    formOptions: {
      schema: useGridFormSchema(options.initialProductId),
      submitOnChange: true,
    },
    /**
     * 🔴 **勾选事件必须走 gridEvents，不能只写模板上的 @checkbox-change**。
     *
     * 机制事实（已实测核实，2026-10-15）：vben 的 `<Grid>` 包装组件把未声明的 attrs 透传到自身**根 div**，
     * 而 vxe 的真实 `checkbox-change` 事件只由内层 `<VxeGrid>` 的 `v-on="events"` 绑定
     * （见 packages/effects/plugins/src/vxe-table/use-vxe-grid.vue）。Vue 自定义事件不冒泡 ⇒
     * 模板上的 `@checkbox-change` **收不到**，勾选状态恒空、所有批量按钮恒为禁用。
     * 这也是既有「批量启用/停用/删除/打标签」在页面上从不激活的根因（既有用例用桩 Grid 直接 emit，
     * 结构性掩盖了它）。`gridEvents` 是 vben 文档化的接线方式，与 alerts 页同一写法。
     */
    gridEvents: {
      checkboxChange: (params: { records?: IotDeviceApi.DeviceResp[] }) =>
        onCheckboxChange?.(params),
      /**
       * 翻页与工具栏按钮（刷新/查询）由 vxe 自己发起 `commitProxy`，
       * 页面拿不到调用点 ⇒ 只能靠这两个事件登记「查询意图」。
       * 在途时 vxe 会**直接丢弃**这次查询（`grid.js` 的 `tableLoading` 早退），
       * 由守卫在周期结束后用最新状态补发（否则用户点刷新/翻页「什么都没发生」）。
       */
      pageChange: () => guard.markIntent(),
      toolbarButtonClick: ({ code }: { code?: string }) => {
        if (code === 'reload' || code === 'query') {
          guard.markIntent();
        }
      },
      // 残余缺口（如实登记，不假装已覆盖）：vben 搜索表单的提交/重置走适配层
      // `api.reload()`（`commitProxy('reload')`），**不触发 vxe 的任何 grid 事件** ⇒
      // 在途时提交筛选仍可能被丢弃且无法登记意图。该窗口极窄（只在慢查询在途期间），
      // 与告警页同一已知边界；彻底收口需要改 vben 适配层（`packages/effects/plugins`）。
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
          query: async (
            { page },
            formValues: IotDeviceApi.DeviceQuery = {},
          ) => {
            // 查询真正启动 ⇒ 任何刷新意图都被执行了（没被 vxe 丢弃），消费掉
            guard.consumeIntent();
            // 翻页/筛选/刷新会整表重载：旧页勾选的 id 不能继续留在批量目标里
            // （否则界面上看不到勾选、按钮却可用，可能对上一页设备误操作）。
            queryStartHandler?.();
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
                  guard.markIntent();
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
              guard.notifyCycleEnd();
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

  guard = createRefreshGuard({
    isBusy: () => Boolean(gridApi.grid?.reactData?.tableLoading),
    issue: () => {
      void gridApi.query();
    },
    onTrailing: (active) => gridApi.setLoading(active),
  });

  // 组件卸载时释放守卫（清掉 trailing 定时器，避免卸载后仍补发查询）
  onUnmounted(() => {
    guard?.dispose();
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
   * 读 vxe 分页快照（当前页/每页/删除前总数）。
   *
   * 未挂载或测试桩没有 `reactData` 时返回 `undefined` ⇒ 页面**不做**页码判断，
   * 行为与改动前完全一致（不去猜 vxe 内部状态）。
   */
  function readPagerSnapshot(): PagerSnapshot | undefined {
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

  /** 当前表格可见行（vxe 拿不到数据时返回空数组，不做任何刷新判断）。 */
  function readVisibleRows(): IotDeviceApi.DeviceResp[] {
    return (gridApi.grid?.getData?.() ?? []) as IotDeviceApi.DeviceResp[];
  }

  /** 当前表格可见行的设备 id（实时事件命中判断用）。 */
  function currentVisibleDeviceIds(): string[] {
    return readVisibleRows().map((row) => String(row.id));
  }

  /** 当前勾选行（批量下发命令要设备对象，不只是 id）。 */
  function readSelectedRows(): IotDeviceApi.DeviceResp[] {
    return (gridApi.grid?.getCheckboxRecords?.() ??
      []) as IotDeviceApi.DeviceResp[];
  }

  /** 清空 vxe 表格的勾选**视觉态**（ref 由批量组合式维护）。 */
  function clearGridCheckbox() {
    gridApi.grid?.clearCheckboxRow();
  }

  /** 搜索表单当前值（导出按当前筛选条件取数）。 */
  function readFormValues(): IotDeviceApi.DeviceQuery {
    return (gridApi.formApi?.form?.values ?? {}) as IotDeviceApi.DeviceQuery;
  }

  return {
    Grid,
    gridApi,
    guard,
    listError,
    alertCounts,
    alertCountError,
    loadAlertCounts,
    readPagerSnapshot,
    setGridCurrentPage,
    readVisibleRows,
    currentVisibleDeviceIds,
    readSelectedRows,
    clearGridCheckbox,
    readFormValues,
    /** 宿主装配：查询开始时要执行的清理（清空旧页勾选）。 */
    setQueryStartHandler(handler: () => void) {
      queryStartHandler = handler;
    },
    /** 宿主装配：勾选变化回调（必须走 `gridEvents.checkboxChange`）。 */
    setCheckboxChangeHandler(
      handler: (params: { records?: IotDeviceApi.DeviceResp[] }) => void,
    ) {
      onCheckboxChange = handler;
    },
  };
}
