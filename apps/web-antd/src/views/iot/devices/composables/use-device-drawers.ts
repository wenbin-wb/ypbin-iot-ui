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
  /**
   * 按 id 从当前列表找设备行（深链/后退恢复时优先用完整行；找不到返回 undefined）。
   *
   * 为什么需要它：URL 只剩一个 id，直接打开详情时「产品/协议/名称」等行级档案字段缺失，
   * 详情页只能显示 `-`。能拿到行就用行；拿不到（不在当前页/未知 id）仍按 id 打开，
   * 由详情页各区块自行取数/展示失败——**不静默忽略，也不伪造档案字段**。
   */
  findDevice?: (deviceId: string) => DeviceRow | undefined;
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
  /**
   * 详情抽屉的「打开/关闭」是深链的唯一生命周期信号：
   * 打开时写 `?deviceId=`（由 onDetail/openDetailById 主动写，这里只处理关闭），
   * 关闭时把 URL 上的 deviceId 清掉——否则刷新/复制 URL 会重新弹出一个已关掉的抽屉。
   */
  const [DetailDrawer, DetailDrawerApi] = useVbenDrawer({
    connectedComponent: Detail,
    onOpenChange(isOpen: boolean) {
      detailOpen = isOpen;
      if (isOpen) {
        return;
      }
      currentDetailDeviceId = undefined;
      if (readDeviceIdQuery() !== undefined) {
        replaceDeviceIdQuery(undefined);
      }
    },
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

  /** 详情抽屉当前是否打开（深链 watch 用它判断「外部清 query 时要关闭」）。 */
  let detailOpen = false;

  /** 当前详情抽屉展示的设备 id（undefined = 未跟踪；用于外部 query 变化时判断是否换设备）。 */
  let currentDetailDeviceId: string | undefined;

  function readDeviceIdQuery(): string | undefined {
    const value = route.query.deviceId;
    return typeof value === 'string' && value !== '' ? value : undefined;
  }

  /** 把 deviceId 同步进 URL（`router.replace`：不产生历史栈垃圾，后退仍是上一页而不是抽屉次数）。 */
  function replaceDeviceIdQuery(deviceId: string | undefined) {
    const before = readDeviceIdQuery();
    if (before === deviceId) {
      return;
    }
    const next = { ...route.query };
    if (deviceId === undefined) {
      delete next.deviceId;
    } else {
      next.deviceId = deviceId;
    }
    void router.replace({ query: next });
  }

  /**
   * 按 id 打开设备详情（深链 / 浏览器前进后退的恢复路径）。
   *
   * 行为约定（unknown id 也走这条）：
   * - 列表里能找到该行 ⇒ 用完整行打开（档案字段齐全）；
   * - 找不到（不在当前页 / 未知 id / 列表还没加载完）⇒ **仍按 `{ id }` 打开**，
   *   详情各区块自己按 id 请求；后端 404/失败时各区块展示原样错误，不静默忽略 id、
   *   也不伪造设备档案字段（用户至少能看到「这条深链指向哪台设备」以及失败原因）。
   */
  function openDetailById(deviceId: string) {
    const row = options.findDevice?.(deviceId);
    const resolvedId = String(row?.id ?? deviceId);
    currentDetailDeviceId = resolvedId;
    DetailDrawerApi.setData(row ?? ({ id: deviceId } as DeviceRow)).open();
    replaceDeviceIdQuery(resolvedId);
  }

  function onEdit(row: DeviceRow) {
    FormDrawerApi.setData(row).open();
  }

  function onDetail(row: DeviceRow) {
    currentDetailDeviceId = String(row.id);
    DetailDrawerApi.setData(row).open();
    replaceDeviceIdQuery(String(row.id));
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

  /**
   * 挂载时消费 URL 意图。
   *
   * 优先级：`?action=create`（产品详情「添加设备」落地面）> `?deviceId=` 深链。
   * 同一个 URL 同时带两者时以新建表单为准（否则表单 + 详情两个抽屉会叠在一起），
   * `deviceId` 随 `consumeCreateQuery` 的一次性清理一并移除，避免刷新后又弹详情。
   */
  function openDetailFromQuery() {
    if (route.query.action === 'create') {
      return;
    }
    const deviceId = readDeviceIdQuery();
    if (deviceId) {
      openDetailById(deviceId);
    }
  }

  /**
   * URL 上的 deviceId 被**外部**改变时同步抽屉（浏览器前进/后退、粘贴深链、其它入口 push）：
   * - 出现/切换 id ⇒ 用该 id 打开（列表有行则用行）；
   * - id 消失 ⇒ 关闭抽屉。
   * 自身写入的 id 与 `currentDetailDeviceId` 相同 ⇒ 幂等跳过，不会来回震荡。
   */
  function onDeviceIdQueryChange(deviceId: string | undefined) {
    if (deviceId === undefined) {
      if (detailOpen) {
        currentDetailDeviceId = undefined;
        DetailDrawerApi.close();
      }
      return;
    }
    if (deviceId === currentDetailDeviceId) {
      return;
    }
    openDetailById(deviceId);
  }

  onMounted(() => {
    consumeCreateQuery();
    openDetailFromQuery();
  });
  watch(() => route.query.action, consumeCreateQuery);
  watch(() => readDeviceIdQuery(), onDeviceIdQueryChange);

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
