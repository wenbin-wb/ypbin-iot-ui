<script lang="ts" setup>
import type { OnboardingTemplate } from './templates';

import { computed, onMounted, ref } from 'vue';

import { useRouter } from 'vue-router';

import { Alert, Button, Input, Steps, Tag, message } from 'ant-design-vue';

import {
  createProduct,
  createProperty,
  createService,
  getDevicePage,
  getProductPage,
  publishProduct,
} from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { useOnboardingTemplates } from './templates';

/**
 * 接入向导（F6）：三步引导 + 内置模板一键创建 + 空态引导。
 *
 * **为什么需要它**：新租户打开 IoT 平台看到的是四个并列的列表页，没有入口顺序、没有空态引导、
 * 没有「下一步」——普通用户不知道从哪下手（方案 §5 的症状描述）。
 *
 * **只用既有接口**：模板创建 = `POST /iot/products` → `POST /iot/products/{id}/services` →
 * `POST .../properties`；发布 = `POST /iot/products/{id}/publish`；设备侧跳到设备台账的既有
 * `?productId=&action=create` 入口（设备台账页面自己会打开预选该产品的表单）。本组件不新造任何后端能力。
 *
 * **权限沿用既有写权限**：模板一键创建受 `iot:product:create` 管控，跳转按钮只做导航、
 * 目标页自己按权限展示动作；未授权用户能看到引导（知道下一步做什么），但点不出越权动作。
 *
 * **有数据时弱化而不是消失**：已接入过的老用户不需要每次都被三步向导占满屏，
 * 因此一旦租户下有产品**或**设备，就折叠成一行提示，需要时手动展开。
 */
const emit = defineEmits<{
  /** 向导里产生了新数据（产品），宿主页面据此刷新列表。 */
  done: [];
  /** 请求宿主打开「添加设备」（设备台账页用它开预选产品的表单）。 */
  addDevice: [productId: string];
}>();

const router = useRouter();

const templates = useOnboardingTemplates();

const selectedKey = ref(templates[0]?.key ?? '');

/** 产品编码/名称预填后可改：同一租户内产品编码唯一，撞了由后端业务错误暴露给用户。 */
const productCode = ref('');

const productName = ref('');

const createdProductId = ref('');

const createdProductCode = ref('');

const busy = ref(false);

const error = ref('');

const counts = ref({ devices: 0, products: 0 });

/** 是否被用户手动展开（有数据时的弱化态）。 */
const expanded = ref(false);

const selected = computed(
  () => templates.find((item) => item.key === selectedKey.value) ?? templates[0],
);

/** 租户下是否已经有数据（有 ⇒ 默认折叠，不干扰老用户）。 */
const hasData = computed(() => counts.value.products > 0 || counts.value.devices > 0);

const showWizard = computed(() => !hasData.value || expanded.value);

/** 当前步骤：建过产品 ⇒ 直接落到第 3 步（前两步由模板一次完成）。 */
const current = computed(() => (createdProductId.value === '' ? 0 : 2));

const stepItems = computed(() => [
  {
    description: $t('page.iot.onboarding.step1Desc'),
    title: $t('page.iot.onboarding.step1Title'),
  },
  {
    description: $t('page.iot.onboarding.step2Desc'),
    title: $t('page.iot.onboarding.step2Title'),
  },
  {
    description: $t('page.iot.onboarding.step3Desc'),
    title: $t('page.iot.onboarding.step3Title'),
  },
]);

/**
 * 选模板：把产品名/编码预填进表单（这就是「后端不支持模板能力」时的降级形态——
 * 预填 + 一键调用既有写接口，而不是等后端出模板表）。
 */
function selectTemplate(template: OnboardingTemplate) {
  selectedKey.value = template.key;
  productName.value = template.productName;
  productCode.value = nextProductCode(template.productCodePrefix);
  error.value = '';
}

/**
 * 生成一个不易撞车的产品编码：同租户内 `product_code` 唯一，而模板前缀是固定的，
 * 直接用前缀会让第二位用户一进去就撞唯一键；加 36 进制时间戳后缀降低概率（用户可改）。
 */
function nextProductCode(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

async function reloadCounts() {
  try {
    const [products, devices] = await Promise.all([
      getProductPage({ page: 1, pageSize: 1 }),
      getDevicePage({ page: 1, pageSize: 1 }),
    ]);
    counts.value = {
      devices: devices?.total ?? 0,
      products: products?.total ?? 0,
    };
  } catch (caught) {
    // 计数只用于「是否弱化引导」这一个判断，取不到就当作「没有数据」把引导显示全——
    // 宁可多显示引导，也不能因为一次统计失败让新用户看不到入口（并留痕便于排查）
    console.warn('[iot] 接入向导的统计查询失败，按「暂无数据」展示完整引导', caught);
  }
}

/**
 * 一键按模板创建产品 + 物模型。
 *
 * 逐条创建属性是**串行**的：后端没有批量属性接口（`POST .../properties` 一次一个），
 * 而模板属性只有 2 条，串行比并发更容易在失败时给出「哪一步失败」的准确错误。
 */
async function applyTemplate() {
  const template = selected.value;
  if (!template) {
    return;
  }
  if (productCode.value.trim() === '' || productName.value.trim() === '') {
    error.value = $t('page.iot.onboarding.codeRequired');
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const productId = String(
      await createProduct({
        dataFormat: 'json',
        productCode: productCode.value.trim(),
        productName: productName.value.trim(),
        protocol: template.protocol,
        remark: $t('page.iot.onboarding.createdFromTemplate', [template.name]),
      }),
    );
    const serviceId = String(
      await createService(productId, {
        description: $t('page.iot.onboarding.createdFromTemplate', [
          template.name,
        ]),
        serviceId: template.serviceId,
        serviceName: template.serviceName,
        serviceOption: 'mandatory',
      }),
    );
    let sort = 1;
    for (const property of template.properties) {
      await createProperty(productId, serviceId, {
        accessMode: property.accessMode,
        dataType: property.dataType,
        identifier: property.identifier,
        maxValue: property.maxValue,
        minValue: property.minValue,
        propertyName: property.propertyName,
        sort,
        unit: property.unit,
      });
      sort += 1;
    }
    createdProductId.value = productId;
    createdProductCode.value = productCode.value.trim();
    message.success($t('page.iot.onboarding.createSuccess'));
    await reloadCounts();
    emit('done');
  } catch (caught) {
    error.value = extractErrorMessage(
      caught,
      $t('page.iot.onboarding.createFailed'),
    );
  } finally {
    busy.value = false;
  }
}

/** 发布刚创建的产品：设备只能绑定**已发布**产品（否则设备表单的下拉里看不到它）。 */
async function publishCreated() {
  if (createdProductId.value === '') {
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const version = await publishProduct(createdProductId.value);
    message.success(
      `${$t('page.iot.onboarding.publishSuccess')} ${version ?? ''}`.trim(),
    );
  } catch (caught) {
    error.value = extractErrorMessage(
      caught,
      $t('page.iot.onboarding.publishFailed'),
    );
  } finally {
    busy.value = false;
  }
}

function goProducts() {
  void router.push('/iot/products');
}

function goDevices() {
  void router.push('/iot/devices');
}

/**
 * 第 3 步的「添加设备」：带 `?productId=&action=create` 跳到设备台账——
 * 该页面已有消费这个参数的逻辑（打开设备表单并预选产品），所以这里不重复实现建表单。
 */
function goAddDevice() {
  if (createdProductId.value === '') {
    goDevices();
    return;
  }
  emit('addDevice', createdProductId.value);
  void router.push({
    path: '/iot/devices',
    query: { action: 'create', productId: createdProductId.value },
  });
}

onMounted(async () => {
  selectTemplate(templates[0] as OnboardingTemplate);
  await reloadCounts();
});
</script>
<template>
  <div>
    <!-- 有数据时的弱化态：一行提示 + 展开，不占满屏幕 -->
    <Alert
      v-if="!showWizard"
      :message="$t('page.iot.onboarding.readyHint')"
      show-icon
      type="success"
    >
      <template #action>
        <Button size="small" @click="expanded = true">
          {{ $t('page.iot.onboarding.showGuide') }}
        </Button>
      </template>
    </Alert>

    <template v-else>
      <Steps :current="current" :items="stepItems" size="small" class="mb-4" />

      <div class="mb-4">
        <div class="mb-2 font-semibold">
          {{ $t('page.iot.onboarding.step1Title') }}
        </div>
        <p class="mb-2 text-sm text-muted-foreground">
          {{ $t('page.iot.onboarding.step1Desc') }}
        </p>

        <div class="grid grid-cols-2 gap-3">
          <button
            v-for="template in templates"
            :key="template.key"
            class="rounded-lg border p-3 text-left transition-colors"
            :class="
              selectedKey === template.key
                ? 'border-primary bg-primary/10'
                : 'border-border hover:bg-accent'
            "
            type="button"
            @click="selectTemplate(template)"
          >
            <div class="font-medium">{{ template.name }}</div>
            <div class="mt-1 text-xs text-muted-foreground">
              {{ template.description }}
            </div>
            <div class="mt-2 flex flex-wrap gap-1">
              <Tag
                v-for="property in template.properties"
                :key="property.identifier"
              >
                {{ property.propertyName }} · {{ property.dataType
                }}<template v-if="property.unit"> · {{ property.unit }}</template>
              </Tag>
            </div>
          </button>
        </div>

        <div v-if="selected" class="mt-3 grid grid-cols-2 gap-3">
          <div>
            <div class="mb-1 text-sm">{{ $t('page.iot.product.name') }}</div>
            <Input v-model:value="productName" :maxlength="128" />
          </div>
          <div>
            <div class="mb-1 text-sm">{{ $t('page.iot.product.code') }}</div>
            <Input v-model:value="productCode" :maxlength="64" />
            <div class="mt-1 text-xs text-muted-foreground">
              {{ $t('page.iot.product.codeHelp') }}
            </div>
          </div>
        </div>

        <div v-if="selected" class="mt-3 text-xs text-muted-foreground">
          <div class="mb-1">{{ $t('page.iot.onboarding.pointSuggest') }}</div>
          <ul class="list-disc pl-5">
            <li v-for="property in selected.properties" :key="property.identifier">
              {{ property.propertyName }}：{{ property.pointHint }}
            </li>
          </ul>
        </div>

        <div class="mt-3 flex flex-wrap gap-2">
          <Button
            v-access:code="['iot:product:create']"
            :loading="busy"
            type="primary"
            @click="applyTemplate"
          >
            {{ $t('page.iot.onboarding.createFromTemplate') }}
          </Button>
          <Button @click="goProducts">
            {{ $t('page.iot.onboarding.goProducts') }}
          </Button>
        </div>
      </div>

      <div class="mb-4">
        <div class="mb-2 font-semibold">
          {{ $t('page.iot.onboarding.step2Title') }}
        </div>
        <p class="mb-2 text-sm text-muted-foreground">
          {{ $t('page.iot.onboarding.step2Desc') }}
        </p>
        <div class="flex flex-wrap gap-2">
          <Button :disabled="createdProductId === ''" @click="goProducts">
            {{ $t('page.iot.onboarding.openThingModel') }}
          </Button>
          <Button
            v-access:code="['iot:product:publish']"
            :disabled="createdProductId === ''"
            :loading="busy"
            @click="publishCreated"
          >
            {{ $t('page.iot.product.publish') }}
          </Button>
        </div>
        <div v-if="createdProductCode" class="mt-1 text-xs text-muted-foreground">
          {{ $t('page.iot.onboarding.createdProduct', [createdProductCode]) }}
        </div>
      </div>

      <div class="mb-4">
        <div class="mb-2 font-semibold">
          {{ $t('page.iot.onboarding.step3Title') }}
        </div>
        <p class="mb-2 text-sm text-muted-foreground">
          {{ $t('page.iot.onboarding.step3Desc') }}
        </p>
        <div class="flex flex-wrap gap-2">
          <Button
            v-access:code="['iot:device:create']"
            type="primary"
            @click="goAddDevice"
          >
            {{ $t('page.iot.onboarding.addDevice') }}
          </Button>
          <Button @click="goDevices">
            {{ $t('page.iot.onboarding.goDevices') }}
          </Button>
        </div>
      </div>

      <Alert v-if="error" :message="error" show-icon type="error" />

      <div v-if="hasData" class="mt-2">
        <Button size="small" type="link" @click="expanded = false">
          {{ $t('page.iot.onboarding.hideGuide') }}
        </Button>
      </div>
    </template>
  </div>
</template>
