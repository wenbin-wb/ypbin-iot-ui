<script lang="ts" setup>
import type { IotGroupApi } from '#/api/iot';

import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

import { useAccess } from '@vben/access';
import { useVbenDrawer, useVbenModal } from '@vben/common-ui';
import { Plus } from '@vben/icons';

import {
  Alert,
  Button,
  Empty,
  message,
  Popconfirm,
  Select,
  Spin,
  Table,
  Tooltip,
} from 'ant-design-vue';

import { useVbenForm } from '#/adapter/form';
import {
  addGroupMember,
  addGroupMembersBatch,
  getDeviceOptions,
  getGroupMembers,
  removeGroupMember,
  removeGroupMembersBatch,
} from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

/**
 * 分组成员管理：查看 / 加入 / 移出，入口在「设备分组」页。
 *
 * 成员接口：`GET /groups/{id}/members`、`POST /groups/{id}/members`、
 * `POST /groups/{id}/members/batch`（批量加入）、`POST /groups/{id}/members/batch-remove`
 * （批量移除）、`DELETE /groups/{id}/members/{memberId}`。
 * 移除传的是**成员行主键**（`member.id`），不是 deviceId —— 传错会「点得动但删不掉」。
 *
 * 空分组必须有**空态引导**（不是一句「暂无数据」）：说明设备在设备台账创建，并给一个能点过去的按钮。
 *
 * 已知边界（不夸大）：设备下拉复用 `getDeviceOptions()`（**前 200 条**，与维护窗口页同一 helper，
 * 本仓没有服务端搜索下拉的既有实现）⇒ 设备超过 200 台的租户可能在下拉里看不到靠后的设备；
 * 这是本轮的既有能力边界，已在交付说明里登记。
 */

const router = useRouter();

/**
 * 写操作门禁用 **computed + `v-if`**，不用 `v-access` 指令。
 *
 * **机制事实（已核实上游源码）**：`packages/effects/access/src/directive.ts` 的 `v-access`
 * **只注册了 `mounted`、没有 `updated`**，且无权限时执行 `el.remove()`（不可逆）
 * ⇒ 它在挂载那一刻把权限判定定死：权限码此后变化不会重算。
 *
 * ⚠️ **风险定性如实**（独立复核指出，采纳）：本应用的权限码在**路由守卫里、页面挂载之前**
 * 就写入 store（`router/guard.ts` 先 `fetchUserInfo()` → `generateAccess()` 才放行导航），
 * 故「权限码迟到」窗口在正常流程中**不可达**。因此这是**防御性加固**（把可见性从
 * 「依赖挂载时机」换成显式响应式判定），而**不是**在修一个已复现的线上缺陷。
 * 范围口径：只对**区块级**功能区（如本页的「加入成员」工具栏）使用；行内单个按钮沿用指令亦可，
 * 本页为保持同一权限码的口径一致也一并改成了 computed。
 */
const { hasAccessByCodes } = useAccess();

/** 加入/移出成员都需要 `iot:group:update`（与后端 `@SaCheckPermission` 一一对应）。 */
const canUpdateGroup = computed(() => hasAccessByCodes(['iot:group:update']));

const groupId = ref('');
const groupName = ref('');

const loading = ref(false);
const members = ref<IotGroupApi.GroupMemberResp[]>([]);
/** 读取失败与「确实没有成员」必须区分显示：禁把失败画成空态（会让人以为分组是空的）。 */
const loadError = ref('');

const devices = ref<Array<{ label: string; value: string }>>([]);
const selectedDeviceId = ref<string | undefined>();
const adding = ref(false);
const removingId = ref('');
const batchSubmitting = ref(false);
/** 批量移除选中的成员行主键（`GroupMemberResp.id`，不是 deviceId）。 */
const selectedMemberIds = ref<string[]>([]);
const batchRemoving = ref(false);

/**
 * 批量加入表单：ApiSelect 多选，api 直接复用 `getDeviceOptions`。
 *
 * 这里**不做**「已在分组中」的前端过滤：后端会返回 `skipped` 数量，成功提示里如实展示
 * 「新增 X 台、已存在 Y 台」，避免用户以为点击无效。
 */
const [BatchForm, batchFormApi] = useVbenForm({
  schema: [
    {
      component: 'ApiSelect',
      componentProps: {
        allowClear: true,
        api: getDeviceOptions,
        class: 'w-full',
        labelField: 'deviceName',
        maxTagCount: 'responsive',
        mode: 'multiple',
        placeholder: $t('page.iot.group.batchSelectPlaceholder'),
        showSearch: true,
        valueField: 'id',
      },
      fieldName: 'deviceIds',
      label: $t('page.iot.group.batchDeviceLabel'),
      rules: 'required',
    },
  ],
  showDefaultActions: false,
});

/**
 * 提交批量加入。
 *
 * 防重复：`batchSubmitting` 在**任何 await 之前**置位，模态框同时 lock（提交中禁用
 * 取消/确认，覆盖 loading），因此连续点击/重复触发只会发一次请求。
 */
async function submitBatchAdd() {
  if (batchSubmitting.value) {
    return;
  }
  batchSubmitting.value = true;
  batchModalApi.lock();
  try {
    const { valid } = await batchFormApi.validate();
    if (!valid) {
      return;
    }
    const values = await batchFormApi.getValues<{ deviceIds?: string[] }>();
    const deviceIds = values.deviceIds ?? [];
    if (deviceIds.length === 0) {
      message.warning($t('page.iot.group.batchSelectRequired'));
      return;
    }
    const result = await addGroupMembersBatch(groupId.value, deviceIds);
    message.success(
      $t('page.iot.group.batchAddSuccess', [
        String(result.added),
        String(result.skipped),
      ]),
    );
    batchModalApi.close();
    await loadMembers();
  } catch (error) {
    // 原样展示后端 message（含「设备不存在」等拒绝原因），不静默
    message.error(extractErrorMessage(error, $t('common.requestFailed')));
  } finally {
    batchSubmitting.value = false;
    batchModalApi.unlock();
  }
}

const [BatchModal, batchModalApi] = useVbenModal({
  async onConfirm() {
    await submitBatchAdd();
  },
  onCancel() {
    batchModalApi.close();
  },
  onOpenChange(isOpen: boolean) {
    if (isOpen) {
      batchFormApi.reset();
    }
  },
});

/** 可加入的设备 = 全部设备 - 已在分组中的设备（避免必错的「设备已在分组中」往返）。 */
const selectableDevices = computed(() => {
  const joined = new Set(members.value.map((member) => member.deviceId));
  return devices.value.filter((device) => !joined.has(device.value));
});

const columns = computed(() => [
  {
    dataIndex: 'deviceName',
    key: 'deviceName',
    title: $t('page.iot.device.name'),
  },
  {
    dataIndex: 'deviceCode',
    key: 'deviceCode',
    title: $t('page.iot.device.code'),
    width: 180,
  },
  {
    dataIndex: 'productName',
    key: 'productName',
    title: $t('page.iot.device.product'),
    width: 180,
  },
  {
    dataIndex: 'createTime',
    key: 'createTime',
    title: $t('common.createTime'),
    width: 170,
  },
  { key: 'action', title: $t('common.action'), width: 110 },
]);

/**
 * 成员表行选择：仅 iot:group:update 用户可勾选（无权限连选择列都不出现）。
 * `selectedRowKeys` 用成员行主键 id，批量移除直接把它交给后端。
 */
const rowSelection = computed(() => {
  if (!canUpdateGroup.value) {
    return undefined;
  }
  return {
    onChange: (selectedRowKeys: Array<number | string>) => {
      selectedMemberIds.value = selectedRowKeys.map(String);
    },
    selectedRowKeys: selectedMemberIds.value,
  };
});

const [Drawer, drawerApi] = useVbenDrawer<IotGroupApi.GroupResp | null>({
  onOpenChange(isOpen: boolean) {
    // 抽屉开/关都清空勾选：避免把上一个分组的成员 id 带到下一次批量移除
    selectedMemberIds.value = [];
    if (!isOpen) {
      return;
    }
    const data = drawerApi.getData();
    groupId.value = data?.id ?? '';
    groupName.value = data?.groupName ?? '';
    selectedDeviceId.value = undefined;
    drawerApi.setState({
      title: `${$t('page.iot.group.members')}${groupName.value ? ` - ${groupName.value}` : ''}`,
    });
    void loadMembers();
    void loadDevices();
  },
});

async function loadMembers() {
  if (!groupId.value) {
    return;
  }
  loading.value = true;
  loadError.value = '';
  try {
    members.value = await getGroupMembers(groupId.value);
    // 列表刷新后旧勾选可能已不存在（被他人移除/切分页）⇒ 一律清空，避免失效 ID 提交
    selectedMemberIds.value = [];
  } catch (error) {
    // 失败不画成空态：清空列表但把错误显示出来
    members.value = [];
    selectedMemberIds.value = [];
    loadError.value = extractErrorMessage(error, $t('common.requestFailed'));
  } finally {
    loading.value = false;
  }
}

async function loadDevices() {
  try {
    const options = await getDeviceOptions();
    devices.value = options.map((device) => ({
      label: device.deviceName || device.deviceCode || device.id,
      value: device.id,
    }));
  } catch {
    // 设备下拉拉取失败不阻塞成员列表（移除/查看仍可用）；写操作失败由全局拦截器提示
    devices.value = [];
  }
}

async function onAdd() {
  if (!selectedDeviceId.value) {
    message.warning($t('page.iot.group.memberSelectPlaceholder'));
    return;
  }
  adding.value = true;
  try {
    await addGroupMember(groupId.value, selectedDeviceId.value);
    message.success($t('common.success'));
    selectedDeviceId.value = undefined;
    await loadMembers();
  } catch {
    // 提示由全局请求拦截器统一处理（如「设备已在分组中」），这里只兜底避免未处理拒绝
  } finally {
    adding.value = false;
  }
}

/**
 * 批量移除选中成员。
 *
 * 防重复：`batchRemoving` 在任何 await 之前置位，按钮同时进入 disabled/loading，
 * Popconfirm 也据此禁用，连续确认只会发一次请求。
 */
async function onBatchRemove() {
  if (batchRemoving.value) {
    return;
  }
  const memberIds = [...selectedMemberIds.value];
  if (memberIds.length === 0) {
    return;
  }
  batchRemoving.value = true;
  try {
    const removed = await removeGroupMembersBatch(groupId.value, memberIds);
    message.success(
      $t('page.iot.group.memberBatchRemoveSuccess', [String(removed)]),
    );
    // 成功先清选再刷新，保证按钮立刻回到禁用态
    selectedMemberIds.value = [];
    await loadMembers();
  } catch (error) {
    // 原样展示后端 message（含缺失/跨组成员等整批拒绝原因），不静默
    message.error(extractErrorMessage(error, $t('common.requestFailed')));
  } finally {
    batchRemoving.value = false;
  }
}

async function onRemove(memberId: string) {
  removingId.value = memberId;
  try {
    await removeGroupMember(groupId.value, memberId);
    message.success($t('common.success'));
    await loadMembers();
  } catch {
    // 同上：失败提示由全局拦截器给出
  } finally {
    removingId.value = '';
  }
}

/**
 * 批量移除按钮的**禁用原因**（空 = 可点）。
 *
 * 为什么要分离原因：禁用态如果只显示一个灰按钮，用户无法区分
 * 「没勾选」还是「请求在途」，前者会去查权限、后者会以为界面卡死。
 * 文案复用 shared/common 的 disabled* 键，不新增页面级文案。
 */
const batchRemoveDisabledReason = computed(() => {
  if (batchRemoving.value) {
    return $t('page.iot.common.disabledPending');
  }
  if (selectedMemberIds.value.length === 0) {
    return $t('page.iot.common.disabledSelectFirst');
  }
  return '';
});

/** 空态引导：设备在设备台账创建，点过去即可（不改台账页本身的交互）。 */
function onGoDevices() {
  void router.push({ path: '/iot/devices' });
}

defineExpose({ drawerApi });
</script>

<template>
  <Drawer class="w-full max-w-[900px]">
    <div class="flex flex-col gap-3">
      <div v-if="canUpdateGroup" class="flex flex-wrap items-center gap-2">
        <Select
          v-model:value="selectedDeviceId"
          :options="selectableDevices"
          :placeholder="$t('page.iot.group.memberSelectPlaceholder')"
          allow-clear
          class="w-full min-w-0 sm:w-[280px]"
          show-search
        />
        <Button type="primary" :loading="adding" @click="onAdd">
          <template #icon><Plus /></template>
          {{ $t('page.iot.group.memberAdd') }}
        </Button>
        <Button @click="batchModalApi.open()">
          {{ $t('page.iot.group.memberBatchAdd') }}
        </Button>
        <!-- antd 的 disabled 按钮不触发 mouseenter ⇒ 原因提示挂在外层 span 上；
             span 同时带 tabindex=0，键盘用户也能聚焦看到原因（无障碍要求）。 -->
        <Tooltip :title="batchRemoveDisabledReason || undefined">
          <span
            class="inline-block"
            :tabindex="batchRemoveDisabledReason ? 0 : undefined"
          >
            <Popconfirm
              :cancel-text="$t('common.cancel')"
              :disabled="selectedMemberIds.length === 0 || batchRemoving"
              :ok-text="$t('common.confirm')"
              :title="
                $t('page.iot.group.memberBatchRemoveConfirm', [
                  String(selectedMemberIds.length),
                ])
              "
              @confirm="onBatchRemove"
            >
              <Button
                danger
                :disabled="selectedMemberIds.length === 0 || batchRemoving"
                :loading="batchRemoving"
              >
                {{ $t('page.iot.group.memberBatchRemove') }}
              </Button>
            </Popconfirm>
          </span>
        </Tooltip>
      </div>

      <BatchModal
        :title="$t('page.iot.group.batchTitle')"
        class="w-full max-w-[600px]"
      >
        <BatchForm />
      </BatchModal>

      <Alert v-if="loadError" :message="loadError" show-icon type="error" />

      <Spin :spinning="loading">
        <!-- vben-ui-dev-exempt: R3 分组成员是抽屉内轻量列表，沿用既有 a-table；task-29 明确要求 a-table row-selection -->
        <Table
          v-if="members.length > 0"
          :columns="columns"
          :data-source="members"
          :pagination="false"
          :row-selection="rowSelection"
          :scroll="{ x: 'max-content' }"
          row-key="id"
          size="small"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'deviceName'">
              {{ record.deviceName || record.deviceCode || record.deviceId }}
            </template>
            <template v-else-if="column.key === 'productName'">
              <span v-if="record.productName">{{ record.productName }}</span>
              <span v-else class="text-muted-foreground">
                {{ $t('page.iot.device.noProduct') }}
              </span>
            </template>
            <template v-else-if="column.key === 'action'">
              <Popconfirm
                :title="$t('page.iot.group.memberRemoveConfirm')"
                @confirm="onRemove(record.id)"
              >
                <Button
                  v-if="canUpdateGroup"
                  danger
                  :loading="removingId === record.id"
                  size="small"
                  type="link"
                >
                  {{ $t('page.iot.group.memberRemove') }}
                </Button>
              </Popconfirm>
            </template>
          </template>
        </Table>

        <!-- 空态引导：只有在**确实读到了空成员**时才显示（读取失败走上面的 Alert） -->
        <Empty
          v-else-if="!loadError"
          :description="$t('page.iot.group.memberEmpty')"
        >
          <div class="text-muted-foreground mb-3 text-sm">
            {{ $t('page.iot.group.memberEmptyHint') }}
          </div>
          <Button type="primary" @click="onGoDevices">
            {{ $t('page.iot.group.memberGoDevices') }}
          </Button>
        </Empty>
      </Spin>
    </div>
  </Drawer>
</template>
