<script lang="ts" setup>
import type { IotProductApi, IotThingModelApi } from '#/api/iot';

import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

import { useVbenDrawer } from '@vben/common-ui';

import {
  Button,
  Descriptions,
  DescriptionsItem,
  Empty,
  message,
  Popconfirm,
  Spin,
  Tabs,
  Tag,
} from 'ant-design-vue';

import {
  getProductDetail,
  getProductVersions,
  listCommands,
  listEvents,
  listProperties,
  listServices,
  newProductDraft,
  publishProduct,
} from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import {
  dataFormatLabel,
  EMPTY_TEXT,
  formatDateTime,
  modelStatusColor,
  modelStatusLabel,
  protocolLabel,
} from '../../shared/display';
import PanelErrorBoundary from '../../shared/panel-error-boundary.vue';
import DeviceList from './device-list.vue';
import ProductModelTab from './product-model-tab.vue';
import ProductTslTab from './product-tsl-tab.vue';

/**
 * 产品详情：5 页签 + 物模型编辑器（宿主）。
 *
 * 页签分工：
 * - **概览**：产品基础信息 + 导入/导出 TSL + 新建草稿/发布 + 添加设备（本文件）；
 * - **物模型**：`product-model-tab.vue`（服务/属性/命令/事件四张表 + 增删改入口）；
 * - **TSL**：`product-tsl-tab.vue`（导出查看 / 粘贴导入，错误逐项展示）；
 * - **设备**：内嵌按产品分页的设备清单（`device-list.vue`，服务端 `productId` 过滤），
 *   并保留「添加设备」入口（带 `productId` 跳设备台账并预选/预筛）；
 * - **版本**：`GET /products/{id}/versions`（本文件）。
 *
 * 为什么数据加载仍留在宿主：物模型/版本/设备三块数据源的生命周期绑定「打开抽屉 → 加载 →
 * 发布/建草稿/导入 TSL 后重载」，由宿主持有可以保证拆分前后**请求时序与失败隔离不变**
 * （物模型失败不清空版本页签）；页签子组件只消费 props + emit 动作，属于纯模板搬迁。
 *
 * ⚠️ **不做的**：点位模板（产品级模板表尚不存在）——页签里如实写「待接入」，
 * 不画一个点不动的空表。
 */
interface ProductDetailData {
  id: string;
  productCode?: string;
  productName?: string;
}

const emit = defineEmits(['reload']);

const router = useRouter();

const productId = ref('');

/** 内嵌设备清单实例（`defineExpose({ reload })`），按产品重查用。 */
const deviceListRef = ref<InstanceType<typeof DeviceList> | null>(null);

/** TSL 页签实例：概览页的「导出 TSL」按钮复用它的导出逻辑（避免两份实现漂移）。 */
const tslTabRef = ref<InstanceType<typeof ProductTslTab> | null>(null);

const product = ref<IotProductApi.ProductResp>();

const services = ref<IotThingModelApi.ServiceResp[]>([]);

const properties = ref<IotThingModelApi.PropertyResp[]>([]);

const commands = ref<IotThingModelApi.CommandResp[]>([]);

const events = ref<IotThingModelApi.EventResp[]>([]);

const selectedServiceId = ref('');

const versions = ref<IotProductApi.ProductVersionResp[]>([]);

const modelError = ref('');

const loading = ref(false);

const activeTab = ref('overview');

/**
 * 物模型的**读**与**写**在草稿态上不对称（2026-09-27 后端修正）：
 * - **读**（services/properties/commands/events）任何状态都可读，因此四张表**始终展示**；
 * - **写**仍要求产品处于草稿态（已发布版本不可变）⇒ 非草稿态下隐藏增删改与 TSL 导入按钮，
 *   并给出「新建草稿」入口，而不是让用户点下去吃 409。
 */
const isDraft = computed(() => product.value?.modelStatus === 'draft');

/** 重新加载服务与当前选中服务下的三类元素（一次只查一个服务，不扇出全产品）。 */
async function loadModel() {
  modelError.value = '';
  const servicesResult = await listServices(productId.value);
  services.value = servicesResult ?? [];
  const firstService = services.value[0];
  if (
    firstService &&
    !services.value.some((service) => service.id === selectedServiceId.value)
  ) {
    selectedServiceId.value = firstService.id;
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

/** 重新加载物模型与版本；产品状态可能已变（发布/建草稿/导入 TSL），一并通知列表页刷新。 */
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
  // 设备清单是按 productId 独立查询的内嵌列表：产品变更后随之刷新（未挂载时 no-op）
  deviceListRef.value?.reload();
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
    modelError.value = '';
    activeTab.value = 'overview';
    // TSL 文本/错误已搬进子组件；抽屉关闭不销毁组件（destroyOnClose=false），
    // 必须显式重置，否则换一个产品打开会看到上一个产品的 TSL 文本。
    tslTabRef.value?.reset();
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
      <PanelErrorBoundary title-key="page.iot.product.renderFailed">
        <Tabs v-model:active-key="activeTab" :animated="false">
          <!-- ===== 概览 ===== -->
          <Tabs.TabPane
            key="overview"
            :tab="$t('page.iot.product.tabOverview')"
          >
            <Descriptions :column="2" bordered size="small">
              <DescriptionsItem :label="$t('page.iot.product.code')">
                {{ product?.productCode ?? EMPTY_TEXT }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.product.name')">
                {{ product?.productName ?? EMPTY_TEXT }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.device.protocol')">
                {{ protocolLabel(product?.protocol) }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.product.dataFormat')">
                {{ dataFormatLabel(product?.dataFormat) }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.product.deviceType')">
                {{ product?.deviceType ?? EMPTY_TEXT }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.product.manufacturer')">
                {{ product?.manufacturerName ?? EMPTY_TEXT }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.product.modelStatus')">
                <Tag :color="modelStatusColor(product?.modelStatus)">
                  {{ modelStatusLabel(product?.modelStatus) }}
                </Tag>
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.product.currentVersion')">
                {{ product?.currentVersion ?? EMPTY_TEXT }}
              </DescriptionsItem>
              <DescriptionsItem :label="$t('page.iot.device.remark')" :span="2">
                {{ product?.remark || EMPTY_TEXT }}
              </DescriptionsItem>
            </Descriptions>

            <div class="mt-4 flex flex-wrap gap-2">
              <Button
                v-access:code="['iot:product:tsl-export']"
                @click="tslTabRef?.exportTsl()"
              >
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
                <Button v-access:code="['iot:product:update']" v-if="!isDraft">
                  {{ $t('page.iot.product.newDraft') }}
                </Button>
              </Popconfirm>
              <Popconfirm
                :title="$t('page.iot.product.publishConfirm')"
                @confirm="onPublish"
              >
                <Button
                  v-access:code="['iot:product:publish']"
                  type="primary"
                  v-if="isDraft"
                >
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

          <!-- ===== 物模型（子组件：服务/属性/命令/事件四张表） ===== -->
          <Tabs.TabPane key="model" :tab="$t('page.iot.product.tabThingModel')">
            <ProductModelTab
              :commands="commands"
              :events="events"
              :is-draft="isDraft"
              :model-error="modelError"
              :product="product"
              :product-id="productId"
              :properties="properties"
              :selected-service-id="selectedServiceId"
              :services="services"
              @new-draft="onNewDraft"
              @open-tsl="activeTab = 'tsl'"
              @reload="reloadAll"
              @reload-elements="loadServiceElements"
              @select-service="onSelectService"
            />
          </Tabs.TabPane>

          <!-- ===== TSL（子组件；force-render：概览页的「导出 TSL」需在其未激活时可用） ===== -->
          <Tabs.TabPane
            key="tsl"
            :tab="$t('page.iot.product.tabTsl')"
            force-render
          >
            <ProductTslTab
              ref="tslTabRef"
              :is-draft="isDraft"
              :product-code="product?.productCode"
              :product-id="productId"
              @reload="reloadAll"
            />
          </Tabs.TabPane>

          <!-- ===== 设备 ===== -->
          <Tabs.TabPane key="devices" :tab="$t('page.iot.product.tabDevices')">
            <!-- 设备清单：按 productId 服务端分页查询（后端 IotDeviceQuery.productId 已支持） -->
            <div class="mb-3 flex justify-end">
              <Button
                v-access:code="['iot:device:create']"
                type="primary"
                @click="onAddDevice"
              >
                {{ $t('page.iot.product.addDevice') }}
              </Button>
            </div>
            <DeviceList
              v-if="productId"
              ref="deviceListRef"
              :product-id="productId"
            />
          </Tabs.TabPane>

          <!-- ===== 版本 ===== -->
          <Tabs.TabPane
            key="versions"
            :tab="$t('page.iot.product.tabVersions')"
          >
            <Empty
              v-if="versions.length === 0"
              :description="$t('common.noData')"
            />
            <div v-else class="overflow-x-auto">
              <table class="w-full min-w-[480px] text-sm whitespace-nowrap">
                <thead>
                  <tr class="text-left text-muted-foreground">
                    <th class="py-1">{{ $t('page.iot.product.versionNo') }}</th>
                    <th class="py-1">
                      {{ $t('page.iot.product.modelStatus') }}
                    </th>
                    <th class="py-1">
                      {{ $t('page.iot.product.publishedAt') }}
                    </th>
                    <th class="py-1">{{ $t('common.remark') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in versions" :key="row.id" class="border-t">
                    <td class="py-1">{{ row.versionNo }}</td>
                    <td class="py-1">
                      <Tag :color="modelStatusColor(row.modelStatus)">
                        {{ modelStatusLabel(row.modelStatus) }}
                      </Tag>
                    </td>
                    <td class="py-1">{{ formatDateTime(row.publishedAt) }}</td>
                    <td class="py-1">{{ row.remark || EMPTY_TEXT }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Tabs.TabPane>
        </Tabs>
      </PanelErrorBoundary>
    </Spin>
  </Drawer>
</template>
