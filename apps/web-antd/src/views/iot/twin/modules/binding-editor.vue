<script lang="ts" setup>
import type { IotTwinApi } from '#/api/iot';

import { computed } from 'vue';

import { Alert, Button, Empty, Select, Tag, Tooltip } from 'ant-design-vue';

import { $t } from '#/locales';

import { displayRoleOptions, displayTypeOptions } from '../data';

/**
 * 属性绑定编辑器（变长列表子表单）。
 *
 * ## 为什么独立成组件而不是塞进 `useVbenForm` 的 schema
 *
 * 绑定列表是**变长**的（0~12 条），每条还有 6 个字段。`useVbenForm` 的 schema 是扁平
 * 字段模型，表达列表需要「`fieldName: 'bindings[0].xxx'` + 手工维护增删」——那比手写更绕
 * 且易错。按 `vben-ui-dev` 铁律 2 的例外条款（不是标量录入控件），本组件用原生控件组织。
 */
// vben-ui-dev-exempt: R2 绑定列表是变长列表容器，每行的紧凑控件无法用单份 schema 表达
const props = defineProps<{
  /** 已绑定的属性（受控）。 */
  bindings: IotTwinApi.BindingSaveReq[];
  /** 设备可绑定的全部属性。 */
  properties: IotTwinApi.DevicePropertyResp[];
}>();

const emit = defineEmits<{
  'update:bindings': [value: IotTwinApi.BindingSaveReq[]];
}>();

/** 绑定业务键分隔符（与后端 `TwinBindingResolver.key` 同构）。 */
const KEY_SEPARATOR = '\u0000';

/** 抬升为常量，避免模板里出现魔法值。 */
const MAX_BINDINGS = 12;

/** 小数位上限（与后端 `TwinLimits.MAX_DECIMALS` 同值）。 */
const MAX_DECIMALS = 6;

/** 单位覆盖长度上限（与后端 `TwinLimits.MAX_UNIT_LENGTH` 同值）。 */
const MAX_UNIT_LENGTH = 32;

/**
 * 拼业务键（两个标识唯一确定一次绑定）。
 *
 * @param serviceIdentifier 服务标识
 * @param propertyIdentifier 属性标识
 * @returns 复合键
 */
function buildPropertyKey(
  serviceIdentifier: string,
  propertyIdentifier: string,
): string {
  return `${serviceIdentifier}${KEY_SEPARATOR}${propertyIdentifier}`;
}

/**
 * 拆业务键。
 *
 * @param key 复合键
 * @returns 两个标识
 */
function splitKey(key: string): {
  propertyIdentifier: string;
  serviceIdentifier: string;
} {
  const [serviceIdentifier = '', propertyIdentifier = ''] =
    key.split(KEY_SEPARATOR);
  return { propertyIdentifier, serviceIdentifier };
}

/** 属性候选（`value` 是复合键）。 */
const propertyOptions = computed(() =>
  props.properties.map((property) => ({
    label: buildPropertyLabel(property),
    mapped: property.mapped,
    value: buildPropertyKey(
      property.serviceIdentifier,
      property.propertyIdentifier,
    ),
  })),
);

/** 复合键 → 属性（回显与展示用）。 */
const propertyByKey = computed(() => {
  const map = new Map<string, IotTwinApi.DevicePropertyResp>();
  for (const property of props.properties) {
    map.set(
      buildPropertyKey(property.serviceIdentifier, property.propertyIdentifier),
      property,
    );
  }
  return map;
});

/** 是否有属性未配置采集点位（顶部统一提示一次，避免每条重复提示）。 */
const hasUnmappedBinding = computed(() =>
  props.bindings.some((binding) => {
    const property = propertyByKey.value.get(selectedKey(binding));
    return property ? !property.mapped : false;
  }),
);

/** 已选中的复合键（用于在下拉里禁用重复项）。 */
const selectedKeys = computed(
  () => new Set(props.bindings.map((binding) => selectedKey(binding))),
);

/**
 * 属性展示名。
 *
 * @param property 设备属性
 * @returns 展示文本
 */
function buildPropertyLabel(property: IotTwinApi.DevicePropertyResp): string {
  const unit = property.unit ? `（${property.unit}）` : '';
  return `${property.serviceName} / ${property.propertyName}${unit}`;
}

/**
 * 取某条绑定的复合键。
 *
 * @param binding 绑定
 * @returns 复合键
 */
function selectedKey(binding: IotTwinApi.BindingSaveReq): string {
  return buildPropertyKey(
    binding.serviceIdentifier,
    binding.propertyIdentifier,
  );
}

/** 新增一条绑定（上限 12 条）。 */
function onAdd(): void {
  if (props.bindings.length >= MAX_BINDINGS) {
    return;
  }
  // 默认值：第一条为主展示，其余为次展示 —— 与后端「primary 至多一条」的约束一致，
  // 用户不需要理解这条规则就能配出合法配置。
  const nextRole: IotTwinApi.DisplayRole = props.bindings.some(
    (binding) => binding.displayRole === 'primary',
  )
    ? 'secondary'
    : 'primary';
  emit('update:bindings', [
    ...props.bindings,
    {
      decimals: undefined,
      displayRole: nextRole,
      displayType: 'value',
      propertyIdentifier: '',
      serviceIdentifier: '',
      sort: props.bindings.length,
      unitOverride: undefined,
    },
  ]);
}

/** 删除一条绑定。 */
function onRemove(index: number): void {
  const next = props.bindings.filter((_, itemIndex) => itemIndex !== index);
  // 删除后若主展示不在了，把第一条提升为主展示（保证始终有且仅有一条 primary）
  const hasPrimary = next.some((binding) => binding.displayRole === 'primary');
  const normalized = hasPrimary
    ? next
    : next.map((binding, itemIndex) => ({
        ...binding,
        displayRole:
          itemIndex === 0 ? ('primary' as const) : ('secondary' as const),
      }));
  emit(
    'update:bindings',
    normalized.map((binding, itemIndex) => ({ ...binding, sort: itemIndex })),
  );
}

/**
 * 修改某条的属性（同时回填 service/property 标识）。
 *
 * @param index 行号
 * @param key 复合键
 */
function onPropertyChange(index: number, key: string): void {
  const { propertyIdentifier, serviceIdentifier } = splitKey(key);
  updateBinding(index, { propertyIdentifier, serviceIdentifier });
}

/**
 * 修改某条的某个字段。
 *
 * @param index 行号
 * @param patch 字段补丁
 */
function updateBinding(
  index: number,
  patch: Partial<IotTwinApi.BindingSaveReq>,
): void {
  emit(
    'update:bindings',
    props.bindings.map((binding, itemIndex) =>
      itemIndex === index ? { ...binding, ...patch } : binding,
    ),
  );
}

/**
 * 修改展示角色（选 primary 时把其它条降级为 secondary）。
 *
 * @param index 行号
 * @param role 角色
 */
function onRoleChange(index: number, role: string): void {
  const next = props.bindings.map((binding, itemIndex) => {
    if (itemIndex === index) {
      return { ...binding, displayRole: role as IotTwinApi.DisplayRole };
    }
    if (role === 'primary') {
      return { ...binding, displayRole: 'secondary' as const };
    }
    return binding;
  });
  emit('update:bindings', next);
}
</script>

<template>
  <div class="space-y-2">
    <Alert
      v-if="hasUnmappedBinding"
      :message="$t('page.iot.twin.unmappedBindingHint')"
      type="warning"
    />

    <Empty
      v-if="bindings.length === 0"
      :description="$t('page.iot.twin.noBindingHint')"
    />

    <div
      v-for="(binding, index) in bindings"
      :key="`${index}-${selectedKey(binding)}`"
      class="rounded border border-border p-2"
    >
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1 space-y-2">
          <Select
            :options="
              propertyOptions.filter(
                (option) =>
                  option.value === selectedKey(binding) ||
                  !selectedKeys.has(option.value),
              )
            "
            :placeholder="$t('page.iot.twin.selectProperty')"
            :value="selectedKey(binding) || undefined"
            option-filter-prop="label"
            show-search
            @change="(value: unknown) => onPropertyChange(index, String(value))"
          >
            <template #option="{ label, mapped }">
              <div class="flex items-center justify-between gap-2">
                <span class="truncate">{{ label }}</span>
                <Tag v-if="mapped === false" color="orange">
                  {{ $t('page.iot.twin.unmapped') }}
                </Tag>
              </div>
            </template>
          </Select>

          <div class="grid grid-cols-4 gap-2">
            <Select
              :options="displayTypeOptions()"
              :value="binding.displayType"
              size="small"
              @change="
                (value: unknown) =>
                  updateBinding(index, {
                    displayType: String(value) as IotTwinApi.DisplayType,
                  })
              "
            />
            <Select
              :options="displayRoleOptions()"
              :value="binding.displayRole ?? 'secondary'"
              size="small"
              @change="(value: unknown) => onRoleChange(index, String(value))"
            />
            <a-input-number
              :max="MAX_DECIMALS"
              :min="0"
              :placeholder="$t('page.iot.twin.decimals')"
              :value="binding.decimals ?? undefined"
              class="w-full"
              size="small"
              @change="
                (value: null | number | string) =>
                  updateBinding(index, {
                    decimals:
                      value === null || value === ''
                        ? undefined
                        : Number(value),
                  })
              "
            />
            <a-input
              :maxlength="MAX_UNIT_LENGTH"
              :placeholder="$t('page.iot.twin.unitOverride')"
              :value="binding.unitOverride ?? undefined"
              size="small"
              @change="
                (event: Event) =>
                  updateBinding(index, {
                    unitOverride:
                      (event.target as HTMLInputElement).value || undefined,
                  })
              "
            />
          </div>
        </div>

        <Tooltip :title="$t('common.delete')">
          <Button danger size="small" type="text" @click="onRemove(index)">
            ×
          </Button>
        </Tooltip>
      </div>
    </div>

    <Button
      :disabled="bindings.length >= MAX_BINDINGS"
      block
      type="dashed"
      @click="onAdd"
    >
      + {{ $t('page.iot.twin.addBinding') }}
    </Button>
  </div>
</template>
