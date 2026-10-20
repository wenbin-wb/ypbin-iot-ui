<script lang="ts" setup>
import { computed, onMounted, ref, watch } from 'vue';

import { Select, Spin } from 'ant-design-vue';

import { getDevicePage } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

/**
 * 设备选择器（点位表单用）。
 *
 * 用 `a-select` + 远程搜索而不是 `ApiSelect`：本选择器需要「**已选设备不在当前搜索结果里
 * 也要能显示名字**」——编辑已有点位时设备可能是几百页之前的某台，若只靠搜索结果做 options，
 * 回显会变成裸 ID。因此这里显式维护 `selectedLabel`，在回显时按 id 反查一次名字。
 *
 * 数据源是服务端分页接口（`pageSize: 100` + `keyword` 模糊搜索），不拉全量设备
 * （租户可能有上万台）。
 */
const props = withDefaults(
  defineProps<{
    /** 禁用（编辑既有点位时设备不可改：改了就是另一台设备）。 */
    disabled?: boolean;
    /** 占位文案。 */
    placeholder?: string;
    /** 选中值（设备 id 字符串）。 */
    value?: string;
  }>(),
  {
    disabled: false,
    placeholder: '',
    value: '',
  },
);

const emit = defineEmits<{ 'update:value': [value: string] }>();

/** 搜索引擎返回的设备候选上限（一次请求）。 */
const SEARCH_PAGE_SIZE = 100;

const options = ref<Array<{ label: string; value: string }>>([]);
const loading = ref(false);
const error = ref('');
/** 已选设备的展示名（回显用：不在 options 里也能显示）。 */
const selectedLabel = ref('');

/** 当前值（受控）。 */
const innerValue = computed({
  get: () => props.value || undefined,
  set: (value?: string) => {
    emit('update:value', value ?? '');
  },
});

/**
 * 远程搜索设备。
 *
 * @param keyword 关键字（设备名/编码）
 */
async function search(keyword: string): Promise<void> {
  loading.value = true;
  try {
    const result = await getDevicePage({
      keyword: keyword || undefined,
      page: 1,
      pageSize: SEARCH_PAGE_SIZE,
    });
    options.value = result.items.map((device) => ({
      label: `${device.deviceName}（${device.deviceCode}）`,
      value: device.id,
    }));
    error.value = '';
  } catch (searchError) {
    error.value = extractErrorMessage(
      searchError,
      $t('page.iot.twin.deviceSearchFailed'),
    );
  } finally {
    loading.value = false;
  }
}

/**
 * 按 id 反查设备名（回显用）。
 *
 * 只在「有值但 options 里没有」时触发，避免每次渲染都查。
 *
 * @param id 设备 id
 */
async function resolveLabel(id: string): Promise<void> {
  if (!id || options.value.some((option) => option.value === id)) {
    return;
  }
  try {
    const result = await getDevicePage({ keyword: id, page: 1, pageSize: 1 });
    const matched = result.items.find((device) => device.id === id);
    selectedLabel.value = matched
      ? `${matched.deviceName}（${matched.deviceCode}）`
      : id;
  } catch {
    // 反查失败不阻塞表单：显示裸 ID 比报错更有用（用户至少知道选了哪台）
    selectedLabel.value = id;
  }
}

watch(
  () => props.value,
  (value) => {
    void resolveLabel(value);
  },
  { immediate: true },
);

/** 首次聚焦时拉一页（避免打开空下拉）。 */
function onFocus(): void {
  if (options.value.length === 0) {
    void search('');
  }
}

onMounted(() => {
  if (props.value) {
    void resolveLabel(props.value);
  }
});
</script>

<template>
  <Select
    v-model:value="innerValue"
    :disabled="disabled"
    :filter-option="false"
    :loading="loading"
    :options="
      selectedLabel && !options.some((item) => item.value === props.value)
        ? [{ label: selectedLabel, value: props.value }, ...options]
        : options
    "
    :placeholder="placeholder"
    allow-clear
    show-search
    @focus="onFocus"
    @search="search"
  >
    <template #notFoundContent>
      <Spin v-if="loading" size="small" />
      <span v-else-if="error" class="text-xs text-red-500">{{ error }}</span>
      <span v-else class="text-xs">{{ $t('common.noData') }}</span>
    </template>
  </Select>
</template>
