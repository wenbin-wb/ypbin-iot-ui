<script lang="ts" setup>
import type { IotProductApi, IotThingModelApi } from '#/api/iot';

import { computed, ref } from 'vue';

import { useVbenDrawer, useVbenModal } from '@vben/common-ui';

import {
  Alert,
  Button,
  Descriptions,
  DescriptionsItem,
  Empty,
  Popconfirm,
  Spin,
  Tabs,
  Tag,
  message,
} from 'ant-design-vue';
import { useRouter } from 'vue-router';

import {
  deleteCommand,
  deleteEvent,
  deleteProperty,
  deleteService,
  exportTsl,
  getProductDetail,
  getProductVersions,
  importTsl,
  listCommands,
  listEvents,
  listProperties,
  listServices,
  newProductDraft,
  publishProduct,
} from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';
import { downloadByBlob } from '#/utils/file';

import ThingModelForm from './thingmodel-form.vue';

/**
 * 产品详情（F2）：5 页签 + 物模型编辑器。
 *
 * 页签分工（对应方案 §6.4）：
 * - **概览**：产品基础信息 + 导入/导出 TSL + 新建草稿/发布 + 添加设备；
 * - **物模型**：服务列表 + 选中服务的属性/命令/事件三张表（增删改，走已就绪的物模型接口）；
 * - **TSL**：导出查看 / 粘贴导入（全量替换草稿；错误逐项展示，禁静默失败）；
 * - **设备**：一键跳「添加设备」（带 productId 预选）；
 * - **版本**：`GET /products/{id}/versions`。
 *
 * ⚠️ **不做的**：点位模板（方案 G4，产品级模板表尚不存在）——页签里如实写「待接入」，
 * 不画一个点不动的空表；按产品筛设备（方案 G8，后端查询条件未补）同理，只在页面上说明。
 */
interface ProductDetailData {
  id: string;
  productCode?: string;
  productName?: string;
}

const emit = defineEmits(['reload']);

const router = useRouter();

const productId = ref('');

const product = ref<IotProductApi.ProductResp>();

const services = ref<IotThingModelApi.ServiceResp[]>([]);

const properties = ref<IotThingModelApi.PropertyResp[]>([]);

const commands = ref<IotThingModelApi.CommandResp[]>([]);

const events = ref<IotThingModelApi.EventResp[]>([]);

const selectedServiceId = ref('');

const versions = ref<IotProductApi.ProductVersionResp[]>([]);

const modelError = ref('');

const tslText = ref('');

const tslError = ref('');

const tslErrors = ref<string[]>([]);

const loading = ref(false);

const activeTab = ref('overview');

const [ThingModelModal, thingModelModalApi] = useVbenModal({
  connectedComponent: ThingModelForm,
});

const selectedService = computed(() =>
  services.value.find((service) => service.id === selectedServiceId.value),
);

/**
 * 物模型的**读**与**写**在草稿态上不对称（2026-09-27 后端修正）：
 * - **读**（services/properties/commands/events）任何状态都可读，因此四张表**始终展示**；
 * - **写**仍要求产品处于草稿态（已发布版本不可变）⇒ 非草稿态下隐藏增删改与 TSL 导入按钮，
 *   并给出「新建草稿」入口，而不是让用户点下去吃 409。
 */
const isDraft = computed(() => product.value?.modelStatus === 'draft');

function openEditor(
  kind: 'command' | 'event' | 'property' | 'service',
  // 行对象按 unknown 透传：编辑器内部只取 `id`，不在父组件里复制一份 DTO 类型
  row?: unknown,
) {
  thingModelModalApi
    .setData({
      kind,
      productId: productId.value,
      row: row ?? null,
      serviceId: selectedServiceId.value,
    })
    .open();
}

/** 重新加载服务与当前选中服务下的三类元素（一次只查一个服务，不扇出全产品）。 */
async function loadModel() {
  modelError.value = '';
  const servicesResult = await listServices(productId.value);
  services.value = servicesResult ?? [];
  if (
    services.value.length > 0 &&
    !services.value.some((service) => service.id === selectedServiceId.value)
  ) {
    selectedServiceId.value = services.value[0]!.id;
  }
  await loadServiceElements();
}

/** 加载选中服务下的属性/命令/事件（三个独立接口并发，各自失败不影响另外两张表）。 */
async function loadServiceElements() {
  properties.value = [];
  commands.value = [];
  events.value = [];
  const serviceId = selectedServiceId.value;
  if (!serviceId) {
    return;
  }
  const [propertiesResult, commandsResult, eventsResult] =
    await Promise.allSettled([
      listProperties(productId.value, serviceId),
      listCommands(productId.value, serviceId),
      listEvents(productId.value, serviceId),
    ]);
  if (propertiesResult.status === 'fulfilled') {
    properties.value = propertiesResult.value ?? [];
  }
  if (commandsResult.status === 'fulfilled') {
    commands.value = commandsResult.value ?? [];
  }
  if (eventsResult.status === 'fulfilled') {
    events.value = eventsResult.value ?? [];
  }
}

async function loadVersions() {
  versions.value = (await getProductVersions(productId.value)) ?? [];
}

/** 重新加载物模型与版本；产品状态可能已变（发布/建草稿），一并通知列表页刷新。 */
async function reloadAll() {
  emit('reload');
  loading.value = true;
  // 两块数据源相互独立：物模型是草稿态的接口、版本列表任何状态都能读 ⇒
  // 不能用同一个 try 包住，否则已发布产品的 409 会连带把「版本」页签清空（复核实测指出）
  try {
    await loadModel();
  } catch (error) {
    services.value = [];
    properties.value = [];
    commands.value = [];
    events.value = [];
    modelError.value = extractErrorMessage(
      error,
      $t('page.iot.product.modelLoadFailed'),
    );
  }
  try {
    await loadVersions();
  } catch (error) {
    versions.value = [];
    console.warn('[iot] 产品版本列表加载失败，版本页签回落为空', error);
  }
  loading.value = false;
}

function onSelectService(serviceId: string) {
  selectedServiceId.value = serviceId;
  void loadServiceElements();
}

function onAddDevice() {
  void router.push({
    path: '/iot/devices',
    query: { action: 'create', productId: productId.value },
  });
}

async function onPublish() {
  const version = await publishProduct(productId.value);
  message.success(`${$t('common.success')} ${version}`);
  await reloadAll();
}

async function onNewDraft() {
  const version = await newProductDraft(productId.value);
  message.success(`${$t('common.success')} ${version}`);
  await reloadAll();
}

/** 导出 TSL：既落到页面文本框（可核对），也直接下载成文件。 */
async function onExportTsl() {
  tslError.value = '';
  tslErrors.value = [];
  const doc = await exportTsl(productId.value);
  tslText.value = JSON.stringify(doc, null, 2);
  downloadByBlob(
    new Blob([tslText.value], { type: 'application/json;charset=utf-8' }),
    `tsl-${product.value?.productCode ?? productId.value}.json`,
  );
}

/**
 * 导入 TSL：本地先解析（JSON 语法错误要在本地报，不该把注定失败的请求发出去），
 * 再交给后端做结构与校验（失败逐项返回 `errors`，整体不落库）。
 */
async function onImportTsl() {
  tslError.value = '';
  tslErrors.value = [];
  if (tslText.value.trim() === '') {
    tslError.value = $t('page.iot.product.tslEmpty');
    return;
  }
  let doc: IotThingModelApi.TslDocument;
  try {
    doc = JSON.parse(tslText.value) as IotThingModelApi.TslDocument;
  } catch (error) {
    tslError.value = `${$t('page.iot.product.tslInvalidJson')}：${extractErrorMessage(error, '')}`;
    return;
  }
  const result = await importTsl(productId.value, doc);
  tslErrors.value = result?.errors ?? [];
  if (tslErrors.value.length === 0) {
    message.success(
      `${$t('common.success')}（${$t('page.iot.product.tslSuccessCount', [String(result?.successCount ?? 0)])}）`,
    );
    await reloadAll();
  }
}

// 删除后的刷新：失败提示由全局请求拦截器统一给出，这里只兜底避免未处理拒绝
function ignoreRejection() {}

function onDeleteService(row: IotThingModelApi.ServiceResp) {
  deleteService(productId.value, row.id).then(reloadAll).catch(ignoreRejection);
}

function onDeleteProperty(row: IotThingModelApi.PropertyResp) {
  deleteProperty(productId.value, selectedServiceId.value, row.id)
    .then(loadServiceElements)
    .catch(ignoreRejection);
}

function onDeleteCommand(row: IotThingModelApi.CommandResp) {
  deleteCommand(productId.value, selectedServiceId.value, row.id)
    .then(loadServiceElements)
    .catch(ignoreRejection);
}

function onDeleteEvent(row: IotThingModelApi.EventResp) {
  deleteEvent(productId.value, selectedServiceId.value, row.id)
    .then(loadServiceElements)
    .catch(ignoreRejection);
}

const [Drawer, drawerApi] = useVbenDrawer<ProductDetailData>({
  async onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      return;
    }
    const data = drawerApi.getData();
    productId.value = data?.id ?? '';
    product.value = undefined;
    services.value = [];
    properties.value = [];
    commands.value = [];
    events.value = [];
    versions.value = [];
    selectedServiceId.value = '';
    tslText.value = '';
    tslError.value = '';
    tslErrors.value = [];
    modelError.value = '';
    activeTab.value = 'overview';
    drawerApi.setState({
      title: `${$t('page.iot.product.detail')} - ${data?.productName ?? data?.productCode ?? productId.value}`,
    });
    if (!productId.value) {
      return;
    }
    try {
      product.value = await getProductDetail(productId.value);
    } catch {
      // 产品详情拉取失败由全局拦截器提示；后续区域仍按各自接口的错误如实展示
    }
    await reloadAll();
  },
});
</script>
<template>
  <Drawer class="w-[1100px]">
    <Spin :spinning="loading">
      <Tabs v-model:active-key="activeTab" :animated="false">
        <!-- ===== 概览 ===== -->
        <Tabs.TabPane key="overview" :tab="$t('page.iot.product.tabOverview')">
          <Descriptions :column="2" bordered size="small">
            <DescriptionsItem :label="$t('page.iot.product.code')">
              {{ product?.productCode ?? '-' }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.product.name')">
              {{ product?.productName ?? '-' }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.device.protocol')">
              {{ product?.protocol ?? '-' }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.product.dataFormat')">
              {{ product?.dataFormat ?? '-' }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.product.deviceType')">
              {{ product?.deviceType ?? '-' }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.product.manufacturer')">
              {{ product?.manufacturerName ?? '-' }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.product.modelStatus')">
              <Tag
                :color="
                  product?.modelStatus === 'published' ? 'success' : 'default'
                "
              >
                {{ product?.modelStatus ?? '-' }}
              </Tag>
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.product.currentVersion')">
              {{ product?.currentVersion ?? '-' }}
            </DescriptionsItem>
            <DescriptionsItem :label="$t('page.iot.device.remark')" :span="2">
              {{ product?.remark || '-' }}
            </DescriptionsItem>
          </Descriptions>

          <div class="mt-4 flex flex-wrap gap-2">
            <Button v-access:code="['iot:product:tsl-export']" @click="onExportTsl">
              {{ $t('page.iot.product.tslExport') }}
            </Button>
            <Button
              v-access:code="['iot:product:tsl-import']"
              @click="activeTab = 'tsl'"
            >
              {{ $t('page.iot.product.tslImport') }}
            </Button>
            <Popconfirm
              :title="$t('page.iot.product.newDraftConfirm')"
              @confirm="onNewDraft"
            >
              <Button v-access:code="['iot:product:update']">
                {{ $t('page.iot.product.newDraft') }}
              </Button>
            </Popconfirm>
            <Popconfirm
              :title="$t('page.iot.product.publishConfirm')"
              @confirm="onPublish"
            >
              <Button v-access:code="['iot:product:publish']" type="primary">
                {{ $t('page.iot.product.publish') }}
              </Button>
            </Popconfirm>
            <Button
              v-access:code="['iot:device:create']"
              type="primary"
              @click="onAddDevice"
            >
              {{ $t('page.iot.product.addDevice') }}
            </Button>
          </div>
        </Tabs.TabPane>

        <!-- ===== 物模型 ===== -->
        <Tabs.TabPane key="model" :tab="$t('page.iot.product.tabThingModel')">
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
              @confirm="onNewDraft"
            >
              <Button v-access:code="['iot:product:update']" type="primary">
                {{ $t('page.iot.product.newDraft') }}
              </Button>
            </Popconfirm>
            <Button @click="activeTab = 'tsl'">
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
          <table v-else class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-500">
                <th class="py-1">{{ $t('page.iot.product.serviceId') }}</th>
                <th class="py-1">{{ $t('page.iot.product.serviceName') }}</th>
                <th class="py-1">{{ $t('page.iot.product.serviceOption') }}</th>
                <th class="py-1">{{ $t('page.iot.product.description') }}</th>
                <th class="py-1">{{ $t('common.action') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="service in services"
                :key="service.id"
                class="border-t"
                :class="
                  service.id === selectedServiceId ? 'bg-blue-50' : undefined
                "
              >
                <td class="py-1">
                  <Button type="link" @click="onSelectService(service.id)">
                    {{ service.serviceId }}
                  </Button>
                </td>
                <td class="py-1">{{ service.serviceName }}</td>
                <td class="py-1">{{ service.serviceOption }}</td>
                <td class="py-1">{{ service.description || '-' }}</td>
                <td class="py-1">
                  <Button
                    v-access:code="['iot:product:update']"
                    size="small"
                    type="link"
                    @click="openEditor('service', service)"
                  >
                    {{ $t('common.edit') }}
                  </Button>
                  <Popconfirm
                    :title="$t('ui.actionMessage.deleteConfirm', [service.serviceId])"
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
            <table v-else class="w-full text-sm">
              <thead>
                <tr class="text-left text-gray-500">
                  <th class="py-1">{{ $t('page.iot.point.identifier') }}</th>
                  <th class="py-1">{{ $t('page.iot.product.propertyName') }}</th>
                  <th class="py-1">{{ $t('page.iot.point.dataType') }}</th>
                  <th class="py-1">{{ $t('page.iot.point.accessMode') }}</th>
                  <th class="py-1">{{ $t('page.iot.point.unit') }}</th>
                  <th class="py-1">{{ $t('page.iot.product.required') }}</th>
                  <th class="py-1">{{ $t('common.action') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="row in properties"
                  :key="row.id"
                  class="border-t"
                >
                  <td class="py-1">{{ row.identifier }}</td>
                  <td class="py-1">{{ row.propertyName }}</td>
                  <td class="py-1">{{ row.dataType }}</td>
                  <td class="py-1">{{ row.accessMode }}</td>
                  <td class="py-1">{{ row.unit || '-' }}</td>
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

            <!-- 命令 -->
            <div class="mt-4 mb-1 flex items-center gap-2">
              <span class="font-semibold">
                {{ $t('page.iot.product.command') }}
              </span>
              <Button
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
            <table v-else class="w-full text-sm">
              <thead>
                <tr class="text-left text-gray-500">
                  <th class="py-1">{{ $t('page.iot.point.identifier') }}</th>
                  <th class="py-1">{{ $t('page.iot.product.commandName') }}</th>
                  <th class="py-1">{{ $t('page.iot.product.timeoutMs') }}</th>
                  <th class="py-1">{{ $t('common.action') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in commands" :key="row.id" class="border-t">
                  <td class="py-1">{{ row.identifier }}</td>
                  <td class="py-1">{{ row.commandName }}</td>
                  <td class="py-1">{{ row.timeoutMs ?? '-' }}</td>
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

            <!-- 事件 -->
            <div class="mt-4 mb-1 flex items-center gap-2">
              <span class="font-semibold">
                {{ $t('page.iot.product.event') }}
              </span>
              <Button
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
            <table v-else class="w-full text-sm">
              <thead>
                <tr class="text-left text-gray-500">
                  <th class="py-1">{{ $t('page.iot.point.identifier') }}</th>
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
                  <td class="py-1">{{ row.dataType }}</td>
                  <td class="py-1">{{ row.unit || '-' }}</td>
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
          </template>
        </Tabs.TabPane>

        <!-- ===== TSL ===== -->
        <Tabs.TabPane key="tsl" :tab="$t('page.iot.product.tabTsl')">
          <Alert
            :message="$t('page.iot.product.tslHint')"
            class="mb-3"
            show-icon
            type="info"
          />
          <div class="mb-2 flex gap-2">
            <Button v-access:code="['iot:product:tsl-export']" @click="onExportTsl">
              {{ $t('page.iot.product.tslExport') }}
            </Button>
            <Button
              v-access:code="['iot:product:tsl-import']"
              v-if="isDraft"
              type="primary"
              @click="onImportTsl"
            >
              {{ $t('page.iot.product.tslImport') }}
            </Button>
          </div>
          <textarea
            v-model="tslText"
            class="h-[360px] w-full rounded border p-2 font-mono text-xs"
            :placeholder="$t('page.iot.product.tslPlaceholder')"
          ></textarea>
          <Alert
            v-if="tslError"
            :message="tslError"
            class="mt-2"
            show-icon
            type="error"
          />
          <Alert
            v-if="tslErrors.length > 0"
            class="mt-2"
            show-icon
            type="error"
          >
            <template #message>
              <div>{{ $t('page.iot.product.tslImportFailed') }}</div>
              <ul class="ml-4 list-disc">
                <li v-for="(item, index) in tslErrors" :key="index">
                  {{ item }}
                </li>
              </ul>
            </template>
          </Alert>
        </Tabs.TabPane>

        <!-- ===== 设备 ===== -->
        <Tabs.TabPane key="devices" :tab="$t('page.iot.product.tabDevices')">
          <Alert
            :message="$t('page.iot.product.deviceTabHint')"
            class="mb-3"
            show-icon
            type="warning"
          />
          <Button
            v-access:code="['iot:device:create']"
            type="primary"
            @click="onAddDevice"
          >
            {{ $t('page.iot.product.addDevice') }}
          </Button>
        </Tabs.TabPane>

        <!-- ===== 版本 ===== -->
        <Tabs.TabPane key="versions" :tab="$t('page.iot.product.tabVersions')">
          <Empty
            v-if="versions.length === 0"
            :description="$t('common.noData')"
          />
          <table v-else class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-500">
                <th class="py-1">{{ $t('page.iot.product.versionNo') }}</th>
                <th class="py-1">{{ $t('page.iot.product.modelStatus') }}</th>
                <th class="py-1">{{ $t('page.iot.product.publishedAt') }}</th>
                <th class="py-1">{{ $t('common.remark') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in versions" :key="row.id" class="border-t">
                <td class="py-1">{{ row.versionNo }}</td>
                <td class="py-1">
                  <Tag
                    :color="row.modelStatus === 'published' ? 'success' : 'default'"
                  >
                    {{ row.modelStatus }}
                  </Tag>
                </td>
                <td class="py-1">{{ row.publishedAt ?? '-' }}</td>
                <td class="py-1">{{ row.remark || '-' }}</td>
              </tr>
            </tbody>
          </table>
        </Tabs.TabPane>
      </Tabs>
    </Spin>

    <ThingModelModal @reload="reloadAll" />
  </Drawer>
</template>
