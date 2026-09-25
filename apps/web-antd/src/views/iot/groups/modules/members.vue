<script lang="ts" setup>
import type { IotGroupApi } from '#/api/iot';

import { computed, ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';
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
} from 'ant-design-vue';
import { useRouter } from 'vue-router';

import {
  addGroupMember,
  getDeviceOptions,
  getGroupMembers,
  removeGroupMember,
} from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

/**
 * 分组成员管理（F4）：查看 / 加入 / 移出，入口在「设备分组」页。
 *
 * 接口全部是**既有** members 接口：
 * `GET /groups/{id}/members`、`POST /groups/{id}/members`、`DELETE /groups/{id}/members/{memberId}`。
 * 移除传的是**成员行主键**（`member.id`），不是 deviceId —— 传错会「点得动但删不掉」。
 *
 * 空分组必须有**空态引导**（不是一句「暂无数据」）：说明设备在设备台账创建，并给一个能点过去的按钮。
 *
 * 已知边界（不夸大）：设备下拉复用 `getDeviceOptions()`（**前 200 条**，与维护窗口页同一 helper，
 * 本仓没有服务端搜索下拉的既有实现）⇒ 设备超过 200 台的租户可能在下拉里看不到靠后的设备；
 * 这是本轮的既有能力边界，已在交付说明里登记。
 */

const router = useRouter();

const groupId = ref('');
const groupName = ref('');

const loading = ref(false);
const members = ref<IotGroupApi.GroupMemberResp[]>([]);
/** 读取失败与「确实没有成员」必须区分显示：禁把失败画成空态（会让人以为分组是空的）。 */
const loadError = ref('');

const devices = ref<Array<{ label: string; value: string }>>([]);
const selectedDeviceId = ref<undefined | string>();
const adding = ref(false);
const removingId = ref('');

/** 可加入的设备 = 全部设备 - 已在分组中的设备（避免必错的「设备已在分组中」往返）。 */
const selectableDevices = computed(() => {
  const joined = new Set(members.value.map((member) => member.deviceId));
  return devices.value.filter((device) => !joined.has(device.value));
});

const columns = computed(() => [
  { dataIndex: 'deviceName', key: 'deviceName', title: $t('page.iot.device.name') },
  { dataIndex: 'deviceCode', key: 'deviceCode', title: $t('page.iot.device.code'), width: 180 },
  { dataIndex: 'productName', key: 'productName', title: $t('page.iot.device.product'), width: 180 },
  { dataIndex: 'createTime', key: 'createTime', title: $t('common.createTime'), width: 170 },
  { key: 'action', title: $t('common.action'), width: 110 },
]);

const [Drawer, drawerApi] = useVbenDrawer<null | IotGroupApi.GroupResp>({
  onOpenChange(isOpen: boolean) {
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
  } catch (error) {
    // 失败不画成空态：清空列表但把错误显示出来
    members.value = [];
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

/** 空态引导：设备在设备台账创建，点过去即可（不改台账页本身的交互）。 */
function onGoDevices() {
  void router.push({ path: '/iot/devices' });
}

defineExpose({ drawerApi });
</script>

<template>
  <Drawer class="w-[900px]">
    <div class="flex flex-col gap-3">
      <div v-access:code="['iot:group:update']" class="flex items-center gap-2">
        <Select
          v-model:value="selectedDeviceId"
          :options="selectableDevices"
          :placeholder="$t('page.iot.group.memberSelectPlaceholder')"
          allow-clear
          class="min-w-[280px]"
          show-search
        />
        <Button type="primary" :loading="adding" @click="onAdd">
          <template #icon><Plus /></template>
          {{ $t('page.iot.group.memberAdd') }}
        </Button>
      </div>

      <Alert v-if="loadError" :message="loadError" show-icon type="error" />

      <Spin :spinning="loading">
        <Table
          v-if="members.length > 0"
          :columns="columns"
          :data-source="members"
          :pagination="false"
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
                  v-access:code="['iot:group:update']"
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
        <Empty v-else-if="!loadError" :description="$t('page.iot.group.memberEmpty')">
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
