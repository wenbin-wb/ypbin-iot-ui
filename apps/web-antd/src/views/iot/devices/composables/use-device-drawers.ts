import type { RefreshGuard } from '../../shared/refresh-guard';

/**
 * 设备台账「抽屉编排 + 行内跳转」组合式。
 *
 * 本页要编排 9 个抽屉（表单/详情/可用率/曲线/接入向导/租户台账/导入/批量标签/批量命令）。
 * 抽屉声明本身占 60 行且与业务逻辑无关，收进这里后页面只剩「装配 + 模板」。
 * 批量标签/批量命令两个抽屉在 `use-device-batch` 里（它们与勾选强耦合）。
 *
 * 还收了口 `?productId=&action=create` 的一次性消费（产品详情「添加设备」跳转落地）：
 * 它需要 route/router 与列表刷新，属于「编排」而不是「列表查询」。
 */
import type { IotDeviceApi } from '#/api/iot';

import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';

import { useVbenDrawer } from '@vben/common-ui';

import Availability from '../modules/availability.vue';
import Detail from '../modules/detail.vue';
import Form from '../modules/form.vue';
import DeviceImport from '../modules/import.vue';
import Series from '../modules/series.vue';

export interface UseDeviceDrawersOptions {
  /** 守卫刷新（表单保存成功、向导完成后刷新列表）。 */
  getGuard: () => RefreshGuard;
}

/** 设备行的最小形态（行内跳转只用到 id/名称/编码）。 */
type DeviceRow = IotDeviceApi.DeviceResp;

export function useDeviceDrawers(options: UseDeviceDrawersOptions) {
  const route = useRoute();
  const router = useRouter();

  const [FormDrawer, FormDrawerApi] = useVbenDrawer({
    connectedComponent: Form,
  });
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
   * 菜单已由迁移补齐（`deploy/sql/migration/2026-09-29-iot-menu-onboarding-ledger.sql` 补了 3206）。
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

  /** 批量导入面板的实例（用来在打开抽屉时触发一次列表刷新）。 */
  const ImportPanel = ref<InstanceType<typeof DeviceImport> | null>(null);

  function onEdit(row: DeviceRow) {
    FormDrawerApi.setData(row).open();
  }

  function onDetail(row: DeviceRow) {
    DetailDrawerApi.setData(row).open();
  }

  function onAvailability(row: DeviceRow) {
    AvailabilityDrawerApi.setData(row).open();
  }

  function onSeries(row: DeviceRow) {
    SeriesDrawerApi.setData(row).open();
  }

  /** 跳到全局告警中心并带上该设备（设备台账 → 告警的**第二个入口**，第一个在设备详情页签）。 */
  function onAlerts(row: DeviceRow) {
    router.push({ path: '/iot/alerts', query: { deviceId: row.id } });
  }

  /** 打开接入向导抽屉（空态引导与工具栏按钮共用同一个入口）。 */
  function openGuide() {
    GuideDrawerApi.open();
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
    // 打开时拉一次批次列表（组件可能还没挂载 ⇒ 用可选链；挂载后由组件自己的 onMounted 拉取）
    ImportPanel.value?.onOpen?.();
  }

  /**
   * 向导第 3 步点了「添加设备」：先关向导，否则它会盖在设备表单抽屉上；
   * 表单本身由 `consumeCreateQuery()` 消费 `?productId=&action=create` 后打开（同一条既有链路）。
   */
  function onGuideAddDevice() {
    GuideDrawerApi.close();
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
    options.getGuard().request();
    // 参数只消费一次：不清理的话刷新/切回标签页会再弹一次表单
    void router.replace({ query: {} });
  }

  onMounted(consumeCreateQuery);
  watch(() => route.query.action, consumeCreateQuery);

  return {
    AvailabilityDrawer,
    DetailDrawer,
    // 模板里 `FormDrawerApi.setData(null).open()`（新建按钮）与 `@reload`（保存后刷新）
    FormDrawerApi,
    FormDrawer,
    GuideDrawer,
    ImportDrawer,
    // 模板 `ref="ImportPanel"`
    ImportPanel,
    LedgerDrawer,
    SeriesDrawer,
    onAlerts,
    onAvailability,
    onDetail,
    onEdit,
    onGuideAddDevice,
    onSeries,
    openGuide,
    openImport,
    openLedger,
  };
}
