<script lang="ts" setup>
import type { UserOption } from './user-select-state';

import { computed, onMounted, ref, watch } from 'vue';

import { Select, SelectOption, Spin } from 'ant-design-vue';

import { getUserDetail, getUserList } from '#/api/system/user';
import { $t } from '#/locales';

import {
  mergeUserOptions,
  normalizeUserIds,
  placeholderOptions,
  planBackfillIds,
  toUserOption,
} from './user-select-state';

/**
 * **系统通用**的用户选择器（多选 / 搜索 / 回显）。
 *
 * 用途：任何"选系统里的人"的场景（告警收件人、审批人、负责人……）。
 * 之前仓内**没有**这样的组件，各页面要么让用户手敲 ID、要么用 `ApiSelect` 但**回显会退化成裸 ID**。
 *
 * ## 三条关键行为
 *
 * 1. **回显要显示名字，而不是 ID**：编辑既有数据时，选中的人往往不在当前候选里
 *    （分页 / 搜索词不匹配）。组件会算出"缺哪些"并**按 id 补拉详情**
 *    （`planBackfillIds` + `getUserDetail`）。
 * 2. **补拉失败不能把值弄丢**：用户被删 / 无权限 / 网络抖动时，给带"未知用户"标注的
 *    **占位选项**，保留该值并如实呈现——而不是渲染成裸 ID 或让标签消失。
 * 3. **搜索走服务端、但已加载候选做本地即时过滤**：后端**没有**合并关键词字段
 *    （`UserQuery` 的 `username`/`realName` 是两个独立且 AND 的过滤条件），
 *    故搜索时**并行**按两个字段各查一次再合并；同时本地匹配让按键即时有反应，
 *    避免"每次输入都要等一次往返"的卡顿感。
 *
 * 值形态**统一是字符串 ID**（后端 Long 全局序列化成字符串）；组件对外只收发 id，
 * "id ↔ 文案"的转换全在这里做，调用方不必关心。
 */
const props = withDefaults(
  defineProps<{
    /** 是否禁用。 */
    disabled?: boolean;
    /** 最多显示几个标签，其余折叠（多选时有用）。 */
    maxTagCount?: 'responsive' | number;
    /** 选中值（字符串 ID 或 ID 数组；也接受后端逗号串）。 */
    modelValue?: null | number | number[] | string | string[];
    /** 是否多选（默认多选）。 */
    multiple?: boolean;
    /**
     * 单次拉取的候选上限。
     *
     * 刻意**不做无限滚动/远程分页**：收件人这类场景候选量小（几十人），
     * 引入分页会显著增加复杂度，收益不匹配。
     */
    pageSize?: number;
    /** 搜索关键词参数名（默认同时查 `username` 与 `realName`）。 */
    placeholder?: string;
  }>(),
  {
    disabled: false,
    pageSize: 50,
    placeholder: undefined,
    multiple: true,
    maxTagCount: 'responsive',
    modelValue: () => [],
  },
);

const emit = defineEmits<{
  /** 候选加载完成（供调用方做统计等）。 */
  loaded: [options: UserOption[]];
  /** 值变化（多选给数组，单选给字符串或 undefined）。 */
  'update:modelValue': [value: number[] | string | string[] | undefined];
}>();

/** 已加载的候选（累积；不同关键词的结果合并进来，避免选择器"闪空"）。 */
const options = ref<UserOption[]>([]);

const loading = ref(false);

/** 已尝试过补拉的 ID（防重复请求与死循环）。 */
const backfilled = ref(new Set<string>());

/** 归一化后的选中 ID（组件内部一律用它）。 */
const selectedIds = computed(() => normalizeUserIds(props.modelValue));

/**
 * 把选中值同步回父组件（统一字符串形态）。
 *
 * @param values antdv 回传的值（多选数组 / 单选字符串）
 */
function emitChange(values: unknown) {
  if (props.multiple) {
    emit('update:modelValue', normalizeUserIds(values as never));
    return;
  }
  const ids = normalizeUserIds(values as never);
  // 单选清空时给 undefined 而不是空串：让"没选"与"选了空"在后端只有一种表达
  emit('update:modelValue', ids[0] ?? undefined);
}

/**
 * 拉取候选（服务端搜索）。
 *
 * @param keyword 关键词（空串 ⇒ 拉首页）
 */
async function loadOptions(keyword = '') {
  loading.value = true;
  try {
    const base = { page: 1, pageSize: props.pageSize };
    const key = keyword.trim();
    // 后端没有合并关键词：username 与 realName 是两个独立且 AND 的过滤条件，
    // 故并行各查一次再合并（只查一个会漏掉"按姓名搜"或"按登录名搜"的那一半）。
    const requests = key
      ? [
          getUserList({ ...base, username: key }),
          getUserList({ ...base, realName: key }),
        ]
      : [getUserList(base)];
    const results = await Promise.all(requests);
    const fetched = results.flatMap((page) =>
      (page?.items ?? []).map((user) => toUserOption(user)),
    );
    options.value = mergeUserOptions(options.value, fetched);
    emit('loaded', options.value);
  } catch {
    // 拉取失败**不清空既有候选**：清空会让用户正在选的标签变成裸 ID。
    // 静默降级为"仅显示已加载的"，由页面层的全局拦截器提示错误。
  } finally {
    loading.value = false;
  }
}

/**
 * 回显补拉：为"已选中但候选里没有"的 ID 取详情，失败则给占位。
 *
 * @param ids 待补拉的 ID
 */
async function backfill(ids: string[]) {
  if (ids.length === 0) {
    return;
  }
  for (const id of ids) {
    backfilled.value.add(id);
  }
  const results = await Promise.all(
    ids.map(async (id) => {
      try {
        return toUserOption(await getUserDetail(id));
      } catch {
        // 详情拿不到（被删/无权限/抖动）⇒ 占位保留该值，不静默丢
        return null;
      }
    }),
  );
  const fetched = results.filter((item): item is UserOption => item !== null);
  const failedIds = ids.filter(
    (id) => !fetched.some((option) => option.value === id),
  );
  options.value = mergeUserOptions(
    options.value,
    fetched,
    placeholderOptions(failedIds),
  );
}

// 打开/挂载时先有一批候选；选中值里有候选外的 ⇒ 立即补拉
onMounted(async () => {
  await loadOptions('');
  await backfill(planBackfillIds(selectedIds.value, options.value));
});

// 选中值变化（含父组件回填）后，补齐仍缺的候选
watch(
  selectedIds,
  async (ids) => {
    const missing = planBackfillIds(ids, options.value).filter(
      (id) => !backfilled.value.has(id),
    );
    await backfill(missing);
  },
  { immediate: false },
);

/** 搜索回调（antdv 在输入时触发）。 */
function onSearch(keyword: string) {
  void loadOptions(keyword);
}
</script>

<template>
  <Select
    :disabled="disabled"
    :filter-option="false"
    :max-tag-count="multiple ? maxTagCount : undefined"
    :mode="multiple ? 'multiple' : undefined"
    :not-found-content="loading ? undefined : $t('ui.userSelect.noResult')"
    :options="options"
    :placeholder="placeholder ?? $t('ui.userSelect.placeholder')"
    :show-search="true"
    :value="multiple ? selectedIds : selectedIds[0]"
    allow-clear
    show-arrow
    @search="onSearch"
    @update:value="emitChange"
  >
    <!-- 载入中给一个明确的指示，而不是空列表（空列表会被读成"没有这个用户"） -->
    <template v-if="loading" #notFoundContent>
      <Spin size="small" />
    </template>
    <SelectOption
      v-for="option in options"
      :key="option.value"
      :value="option.value"
    >
      {{ option.label }}
    </SelectOption>
  </Select>
</template>
