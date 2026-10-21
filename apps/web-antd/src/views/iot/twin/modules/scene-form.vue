<script lang="ts" setup>
import type { IotTwinApi } from '#/api/iot';

import { nextTick, ref } from 'vue';

import { useVbenDrawer } from '@vben/common-ui';

import { message } from 'ant-design-vue';

import { useVbenForm } from '#/adapter/form';
import { createTwinScene, updateTwinScene } from '#/api/iot';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import { useSceneFormSchema } from '../data';

/**
 * 场景新增/编辑抽屉。
 *
 * `getData()` 是**上下文包**（`row` / `parentId` / `parentOptions` / `scenes`）而不是单个
 * 场景：新建子场景要预填 `parentId`，父场景候选又要按「排除自身与后代」计算，
 * 两者都依赖树结构 ⇒ 由父组件算好传入，本组件不重复实现树逻辑。
 */
interface SceneFormData {
  /** 父场景候选（已按编辑行排除自身与后代）。 */
  parentOptions: Array<{ label: string; value: string }>;
  /** 新建子场景时预填的父场景 id。 */
  parentId?: string;
  /** 编辑时的原始行（undefined = 新建）。 */
  row?: IotTwinApi.SceneResp;
  /** 平铺场景列表。 */
  scenes: IotTwinApi.SceneResp[];
}

const emit = defineEmits<{ success: [] }>();

/** 根场景的 parentId 哨兵值（与后端一致）。 */
const ROOT_PARENT_ID = '0';

const isUpdate = ref(false);
const rowId = ref('');

const [Form, formApi] = useVbenForm({
  schema: useSceneFormSchema([]),
  showDefaultActions: false,
});

const [Drawer, drawerApi] = useVbenDrawer<null | SceneFormData>({
  onCancel() {
    drawerApi.close();
  },
  async onConfirm() {
    try {
      drawerApi.setState({ confirmLoading: true });
      const { valid } = await formApi.validate();
      if (!valid) {
        return;
      }
      const values = await formApi.getValues<IotTwinApi.SceneSaveReq>();
      // 根场景：父场景留空时**不传 parentId 字段**（后端把 null 视为根场景；
      // 传空串会被后端当成非法 id 而拒绝）
      const payload: IotTwinApi.SceneSaveReq = {
        ...values,
        parentId: values.parentId ? String(values.parentId) : undefined,
      };
      await (isUpdate.value
        ? updateTwinScene(rowId.value, payload)
        : createTwinScene(payload));
      message.success($t('common.success'));
      drawerApi.close();
      emit('success');
    } catch (error) {
      message.error(extractErrorMessage(error, $t('page.iot.twin.saveFailed')));
    } finally {
      drawerApi.setState({ confirmLoading: false });
    }
  },
  async onOpenChange(isOpen: boolean) {
    if (!isOpen) {
      return;
    }
    const data = drawerApi.getData();
    isUpdate.value = Boolean(data?.row?.id);
    rowId.value = data?.row?.id ?? '';
    formApi.reset();
    // 父场景候选随「当前编辑行」变化（要排除自身与后代）⇒ 整体替换 schema。
    // 与 `batch-tags.vue` 的 `formApi.setState({ schema })` 同款做法：
    // useVbenForm 的 schema 在创建时求值，不替换就会一直用第一次的候选。
    formApi.setState({ schema: useSceneFormSchema(data?.parentOptions ?? []) });
    drawerApi.setState({
      title: isUpdate.value
        ? $t('ui.actionTitle.edit', [$t('page.iot.twin.sceneName')])
        : $t('ui.actionTitle.create', [$t('page.iot.twin.sceneName')]),
    });
    await nextTick();
    if (data?.row) {
      formApi.setValues({
        ...data.row,
        // 根场景的 parentId 是 "0"：表单里必须表现为「未选择」，
        // 否则会去匹配一个 id 为 0 的假选项
        parentId:
          data.row.parentId === ROOT_PARENT_ID ? undefined : data.row.parentId,
      });
    } else if (data?.parentId) {
      formApi.setValues({ parentId: data.parentId });
    }
  },
});

defineExpose({ drawerApi });
</script>

<template>
  <Drawer>
    <Form />
  </Drawer>
</template>
