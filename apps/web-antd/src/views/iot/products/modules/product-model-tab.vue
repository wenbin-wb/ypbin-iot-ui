<script lang="ts" setup>
import type { IotProductApi, IotThingModelApi } from '#/api/iot';

import { computed } from 'vue';

import { useVbenModal } from '@vben/common-ui';

import { Alert, Button, Empty, message, Popconfirm } from 'ant-design-vue';

import {
  deleteCommand,
  deleteEvent,
  deleteProperty,
  deleteService,
} from '#/api/iot';
import { $t } from '#/locales';

import {
  accessModeLabel,
  dataTypeLabel,
  EMPTY_TEXT,
  serviceOptionLabel,
} from '../../shared/display';
import ThingModelForm from './thingmodel-form.vue';

/**
 * 产品详情 →「物模型」页签内容组件（从 `detail.vue` 拆出）。
 *
 * 职责：服务列表 + 选中服务下的属性/命令/事件三张表 + 新增/编辑/删除入口。
 *
 * ## 为什么数据仍由宿主持有、这里只负责展示与动作
 *
 * 物模型数据（4 个列表 + `modelError`）与「打开抽屉即加载、发布/建草稿/导入后重载」
 * 的生命周期绑在宿主上；本组件只消费 props，避免子组件挂载时机（Tabs 懒渲染）
 * 影响首次加载。这样拆分前后**请求时序完全一致**，回归面只剩模板搬家。
 *
 * 动作类副作用（换选中服务、删除、打开编辑器后重载）通过 emit 交还宿主：
 * - `select-service`：宿主去查该服务下的三张元素表（不扇出整个产品）；
 * - `reload`：服务级删除/编辑器保存后，宿主走完整 reloadAll（版本、设备列表一并刷新）；
 * - `reload-elements`：元素级删除后，宿主只重查当前服务的三张表；
 * - `new-draft` / `open-tsl`：非草稿态提示条里的「新建草稿」「去 TSL 页签」入口。
 */
const props = defineProps<{
  commands: IotThingModelApi.CommandResp[];
  events: IotThingModelApi.EventResp[];
  /** 草稿态：决定增删改与 TSL 入口是否可用（已发布版本不可变）。 */
  isDraft: boolean;
  /** 物模型加载失败原因（宿主传入，原样展示后端 message）。 */
  modelError: string;
  product: IotProductApi.ProductResp | undefined;
  productId: string;
  properties: IotThingModelApi.PropertyResp[];
  /** 当前选中服务主键（由宿主持有：删除接口与编辑器 payload 都要用）。 */
  selectedServiceId: string;
  services: IotThingModelApi.ServiceResp[];
}>();

const emit = defineEmits<{
  newDraft: [];
  openTsl: [];
  reload: [];
  reloadElements: [];
  selectService: [serviceId: string];
}>();

/** 当前选中服务（从 props 派生，不复制一份状态以免两份事实源漂移）。 */
const selectedService = computed(() =>
  props.services.find((service) => service.id === props.selectedServiceId),
);

/** 物模型元素编辑器：四类元素共用一个弹窗（组件本身保持不动）。 */
const [ThingModelModal, thingModelModalApi] = useVbenModal({
  connectedComponent: ThingModelForm,
});

function openEditor(
  kind: 'command' | 'event' | 'property' | 'service',
  // 行对象按 unknown 透传：编辑器内部只取 `id`，不在这里复制一份 DTO 类型
  row?: unknown,
) {
  // 纵深防御：调用方按钮已按草稿态隐藏（`v-if="isDraft"`），这里再拦一道，
  // 避免将来新增入口时漏掉而让用户点到必然 409 的按钮（后端写接口要求草稿态）。
  if (!props.isDraft) {
    message.warning($t('page.iot.product.readonlyEditBlocked'));
    return;
  }
  thingModelModalApi
    .setData({
      kind,
      productId: props.productId,
      row: row ?? null,
      serviceId: props.selectedServiceId,
    })
    .open();
}

// 删除后的刷新：失败提示由全局请求拦截器统一给出，这里只兜底避免未处理拒绝
function ignoreRejection() {}

function onDeleteService(row: IotThingModelApi.ServiceResp) {
  deleteService(props.productId, row.id)
    .then(() => emit('reload'))
    .catch(ignoreRejection);
}

function onDeleteProperty(row: IotThingModelApi.PropertyResp) {
  deleteProperty(props.productId, props.selectedServiceId, row.id)
    .then(() => emit('reloadElements'))
    .catch(ignoreRejection);
}

function onDeleteCommand(row: IotThingModelApi.CommandResp) {
  deleteCommand(props.productId, props.selectedServiceId, row.id)
    .then(() => emit('reloadElements'))
    .catch(ignoreRejection);
}

function onDeleteEvent(row: IotThingModelApi.EventResp) {
  deleteEvent(props.productId, props.selectedServiceId, row.id)
    .then(() => emit('reloadElements'))
    .catch(ignoreRejection);
}
</script>

<template>
  <div>
    <Alert
      v-if="modelError"
      :message="modelError"
      class="mb-3"
      show-icon
      type="error"
    />

    <Alert
      v-if="product && !isDraft"
      :message="$t('page.iot.product.readonlyPublished')"
      class="mb-3"
      show-icon
      type="info"
    />
    <div v-if="product && !isDraft" class="mb-3 flex flex-wrap gap-2">
      <Popconfirm
        :title="$t('page.iot.product.newDraftConfirm')"
        @confirm="emit('newDraft')"
      >
        <Button v-access:code="['iot:product:update']" type="primary">
          {{ $t('page.iot.product.newDraft') }}
        </Button>
      </Popconfirm>
      <Button @click="emit('openTsl')">
        {{ $t('page.iot.product.tabTsl') }}
      </Button>
    </div>

    <div class="mb-2 flex items-center gap-2">
      <span class="font-semibold">
        {{ $t('page.iot.product.service') }}
      </span>
      <Button
        v-access:code="['iot:product:update']"
        v-if="isDraft"
        size="small"
        type="primary"
        @click="openEditor('service', null)"
      >
        {{ $t('page.iot.product.addService') }}
      </Button>
    </div>
    <Empty
      v-if="services.length === 0"
      :description="$t('page.iot.product.noService')"
    />
    <div v-else class="overflow-x-auto">
      <table class="w-full min-w-[560px] text-sm whitespace-nowrap">
        <thead>
          <tr class="text-left text-muted-foreground">
            <th class="py-1">{{ $t('page.iot.product.serviceId') }}</th>
            <th class="py-1">
              {{ $t('page.iot.product.serviceName') }}
            </th>
            <th class="py-1">
              {{ $t('page.iot.product.serviceOption') }}
            </th>
            <th class="py-1">
              {{ $t('page.iot.product.description') }}
            </th>
            <th class="py-1">{{ $t('common.action') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="service in services"
            :key="service.id"
            class="border-t"
            :class="
              service.id === selectedServiceId ? 'bg-primary/10' : undefined
            "
          >
            <td class="py-1">
              <Button type="link" @click="emit('selectService', service.id)">
                {{ service.serviceId }}
              </Button>
            </td>
            <td class="py-1">{{ service.serviceName }}</td>
            <td class="py-1">
              {{ serviceOptionLabel(service.serviceOption) }}
            </td>
            <td class="py-1">{{ service.description || EMPTY_TEXT }}</td>
            <td class="py-1">
              <Button
                v-if="isDraft"
                v-access:code="['iot:product:update']"
                size="small"
                type="link"
                @click="openEditor('service', service)"
              >
                {{ $t('common.edit') }}
              </Button>
              <Popconfirm
                :title="
                  $t('ui.actionMessage.deleteConfirm', [service.serviceId])
                "
                @confirm="onDeleteService(service)"
              >
                <Button
                  v-access:code="['iot:product:update']"
                  v-if="isDraft"
                  danger
                  size="small"
                  type="link"
                >
                  {{ $t('common.delete') }}
                </Button>
              </Popconfirm>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <template v-if="selectedService">
      <div class="mt-4 mb-2 text-sm text-muted-foreground">
        {{ $t('page.iot.product.currentService') }}：
        {{ selectedService.serviceId }}（{{ selectedService.serviceName }}）
      </div>

      <!-- 属性 -->
      <div class="mb-1 flex items-center gap-2">
        <span class="font-semibold">
          {{ $t('page.iot.product.property') }}
        </span>
        <Button
          v-if="isDraft"
          v-access:code="['iot:product:update']"
          size="small"
          @click="openEditor('property', null)"
        >
          {{ $t('page.iot.product.addProperty') }}
        </Button>
      </div>
      <Empty
        v-if="properties.length === 0"
        :description="$t('page.iot.product.noProperty')"
      />
      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[640px] text-sm whitespace-nowrap">
          <thead>
            <tr class="text-left text-muted-foreground">
              <th class="py-1">
                {{ $t('page.iot.point.identifier') }}
              </th>
              <th class="py-1">
                {{ $t('page.iot.product.propertyName') }}
              </th>
              <th class="py-1">{{ $t('page.iot.point.dataType') }}</th>
              <th class="py-1">
                {{ $t('page.iot.point.accessMode') }}
              </th>
              <th class="py-1">{{ $t('page.iot.point.unit') }}</th>
              <th class="py-1">
                {{ $t('page.iot.product.required') }}
              </th>
              <th class="py-1">{{ $t('common.action') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in properties" :key="row.id" class="border-t">
              <td class="py-1">{{ row.identifier }}</td>
              <td class="py-1">{{ row.propertyName }}</td>
              <td class="py-1">{{ dataTypeLabel(row.dataType) }}</td>
              <td class="py-1">
                {{ accessModeLabel(row.accessMode) }}
              </td>
              <td class="py-1">{{ row.unit || EMPTY_TEXT }}</td>
              <td class="py-1">
                {{ row.required ? $t('common.yes') : $t('common.no') }}
              </td>
              <td class="py-1">
                <Button
                  v-access:code="['iot:product:update']"
                  v-if="isDraft"
                  size="small"
                  type="link"
                  @click="openEditor('property', row)"
                >
                  {{ $t('common.edit') }}
                </Button>
                <Popconfirm
                  :title="
                    $t('ui.actionMessage.deleteConfirm', [row.identifier])
                  "
                  @confirm="onDeleteProperty(row)"
                >
                  <Button
                    v-access:code="['iot:product:update']"
                    v-if="isDraft"
                    danger
                    size="small"
                    type="link"
                  >
                    {{ $t('common.delete') }}
                  </Button>
                </Popconfirm>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 命令 -->
      <div class="mt-4 mb-1 flex items-center gap-2">
        <span class="font-semibold">
          {{ $t('page.iot.product.command') }}
        </span>
        <Button
          v-if="isDraft"
          v-access:code="['iot:product:update']"
          size="small"
          @click="openEditor('command', null)"
        >
          {{ $t('page.iot.product.addCommand') }}
        </Button>
      </div>
      <Empty
        v-if="commands.length === 0"
        :description="$t('page.iot.product.noCommand')"
      />
      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[480px] text-sm whitespace-nowrap">
          <thead>
            <tr class="text-left text-muted-foreground">
              <th class="py-1">
                {{ $t('page.iot.point.identifier') }}
              </th>
              <th class="py-1">
                {{ $t('page.iot.product.commandName') }}
              </th>
              <th class="py-1">
                {{ $t('page.iot.product.timeoutMs') }}
              </th>
              <th class="py-1">{{ $t('common.action') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in commands" :key="row.id" class="border-t">
              <td class="py-1">{{ row.identifier }}</td>
              <td class="py-1">{{ row.commandName }}</td>
              <td class="py-1">{{ row.timeoutMs ?? EMPTY_TEXT }}</td>
              <td class="py-1">
                <Button
                  v-access:code="['iot:product:update']"
                  v-if="isDraft"
                  size="small"
                  type="link"
                  @click="openEditor('command', row)"
                >
                  {{ $t('common.edit') }}
                </Button>
                <Popconfirm
                  :title="
                    $t('ui.actionMessage.deleteConfirm', [row.identifier])
                  "
                  @confirm="onDeleteCommand(row)"
                >
                  <Button
                    v-access:code="['iot:product:update']"
                    v-if="isDraft"
                    danger
                    size="small"
                    type="link"
                  >
                    {{ $t('common.delete') }}
                  </Button>
                </Popconfirm>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 事件 -->
      <div class="mt-4 mb-1 flex items-center gap-2">
        <span class="font-semibold">
          {{ $t('page.iot.product.event') }}
        </span>
        <Button
          v-if="isDraft"
          v-access:code="['iot:product:update']"
          size="small"
          @click="openEditor('event', null)"
        >
          {{ $t('page.iot.product.addEvent') }}
        </Button>
      </div>
      <Empty
        v-if="events.length === 0"
        :description="$t('page.iot.product.noEvent')"
      />
      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[560px] text-sm whitespace-nowrap">
          <thead>
            <tr class="text-left text-muted-foreground">
              <th class="py-1">
                {{ $t('page.iot.point.identifier') }}
              </th>
              <th class="py-1">{{ $t('page.iot.product.eventName') }}</th>
              <th class="py-1">{{ $t('page.iot.point.dataType') }}</th>
              <th class="py-1">{{ $t('page.iot.point.unit') }}</th>
              <th class="py-1">{{ $t('common.action') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in events" :key="row.id" class="border-t">
              <td class="py-1">{{ row.identifier }}</td>
              <td class="py-1">{{ row.eventName }}</td>
              <td class="py-1">{{ dataTypeLabel(row.dataType) }}</td>
              <td class="py-1">{{ row.unit || EMPTY_TEXT }}</td>
              <td class="py-1">
                <Button
                  v-access:code="['iot:product:update']"
                  v-if="isDraft"
                  size="small"
                  type="link"
                  @click="openEditor('event', row)"
                >
                  {{ $t('common.edit') }}
                </Button>
                <Popconfirm
                  :title="
                    $t('ui.actionMessage.deleteConfirm', [row.identifier])
                  "
                  @confirm="onDeleteEvent(row)"
                >
                  <Button
                    v-access:code="['iot:product:update']"
                    v-if="isDraft"
                    danger
                    size="small"
                    type="link"
                  >
                    {{ $t('common.delete') }}
                  </Button>
                </Popconfirm>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <ThingModelModal @reload="emit('reload')" />
  </div>
</template>
