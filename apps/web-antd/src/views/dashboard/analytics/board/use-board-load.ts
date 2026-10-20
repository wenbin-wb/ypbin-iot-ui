import type { BoardConfig, BoardConfigSource, BoardWidget } from './board-utils';

import { computed, ref } from 'vue';

import { message, Modal } from 'ant-design-vue';

import { getDashboardBoard, saveDashboardBoard } from '#/api/iot/board';
import { $t } from '#/locales';
import { extractErrorMessage } from '#/utils/error';

import {
  createEmptyBoardConfig,
  loadBoardConfig,
  planBoardLoad,
  sanitizeBoardWidgetList,
  saveBoardConfig,
  toBoardPayloadWidget,
} from './board-utils';

/**
 * 看板配置的**加载 / 本地草稿 / 保存**（从 board-drawer.vue 抽出，逻辑逐行搬移，不改语义）。
 *
 * 持久化口径（2026-10-15 起接后端，见 `api/iot/board.ts`）：
 * - **加载**：先 GET 平台配置；GET 失败或平台无配置时回落本地草稿，并在 UI 上如实标注
 *   「当前为本地草稿（未同步到平台）」，绝不静默降级；平台空数组 = 无配置，不是配置损坏；
 * - **保存**：PUT 成功后写 localStorage（dirty=false）；PUT 失败**保留本地草稿**并置 dirty=true，
 *   明确提示「本次改动只在本机，未同步到平台」；
 * - **上传确认**：首次 GET 到平台为空且本地有草稿 ⇒ 弹出「检测到本地草稿，是否上传到平台？」，
 *   用户确认才 PUT，取消则继续以本地草稿运行。
 *
 * 为什么单独成 composable：这三件事的判据（`planBoardLoad` 纯函数 + 两种失败分支的文案）
 * 是看板最容易出「静默降级」的地方，独立后可以只读这一个文件复核口径。
 */
export function useBoardLoad() {
  const config = ref<BoardConfig>(createEmptyBoardConfig());
  const configInvalid = ref(false);
  const saveError = ref('');
  const source = ref<BoardConfigSource>('empty');
  const saving = ref(false);

  /** 是否展示「当前为本地草稿（未同步到平台）」提示。 */
  const isLocalDraft = computed(() => source.value === 'local-draft');

  /** 写本地草稿；写失败（隐私模式/配额满）必须留痕，不能假装存下了。 */
  function persistLocal(dirty: boolean): void {
    const saved = saveBoardConfig(config.value, undefined, dirty);
    saveError.value = saved ? '' : $t('page.iot.board.saveFailed');
  }

  /**
   * 拉平台配置并决策展示哪一份（纯函数 `planBoardLoad`）；失败/无配置回落本地草稿并标注。
   */
  async function loadBoard(): Promise<void> {
    const local = loadBoardConfig();
    configInvalid.value = local.reset;
    let remote: { error?: string; ok: boolean; widgets?: BoardWidget[] };
    try {
      const resp = await getDashboardBoard();
      remote = { ok: true, widgets: sanitizeBoardWidgetList(resp?.widgets) };
    } catch (error) {
      remote = {
        error: extractErrorMessage(error, $t('page.iot.board.loadFailed')),
        ok: false,
      };
    }
    const plan = planBoardLoad(remote, local);
    config.value = plan.config;
    source.value = plan.source;
    saveError.value = plan.remoteError;
    if (plan.localDraftAvailable) {
      confirmUploadLocalDraft();
      return;
    }
    // 平台为准时把平台配置写回本地（下次断网也能看）
    if (plan.source === 'platform') {
      persistLocal(false);
    }
  }

  /** 首次 GET 到平台为空且本地有草稿：显式询问，用户确认才上传。 */
  function confirmUploadLocalDraft(): void {
    Modal.confirm({
      content: $t('page.iot.board.uploadDraftConfirm'),
      okText: $t('page.iot.board.uploadDraftOk'),
      cancelText: $t('page.iot.board.uploadDraftCancel'),
      title: $t('page.iot.board.uploadDraftTitle'),
      onCancel: () => {
        source.value = 'local-draft';
      },
      onOk: async () => {
        await pushBoard({ silent: true });
      },
    });
  }

  /**
   * 把当前配置整体 PUT 到平台。
   *
   * 成功：写 localStorage 且 dirty=false，source 变 platform；
   * 失败：**保留本地草稿**（dirty=true）并明确提示，绝不假装保存成功。
   */
  async function pushBoard(options: { silent?: boolean } = {}): Promise<boolean> {
    if (saving.value) {
      return false;
    }
    saving.value = true;
    try {
      await saveDashboardBoard(
        config.value.widgets.map((widget) => toBoardPayloadWidget(widget)),
      );
      persistLocal(false);
      source.value = 'platform';
      saveError.value = '';
      if (!options.silent) {
        message.success($t('page.iot.board.saveSuccess'));
      }
      return true;
    } catch (error) {
      const reason = extractErrorMessage(error, $t('page.iot.board.saveFailed'));
      persistLocal(true);
      source.value = 'local-draft';
      saveError.value = $t('page.iot.board.saveFailedDetail', [reason]);
      if (!options.silent) {
        message.error(saveError.value);
      }
      return false;
    } finally {
      saving.value = false;
    }
  }

  /** 同步替换整份配置（本地立即生效，不触发落库）。 */
  function setConfig(next: BoardConfig): void {
    config.value = next;
  }

  /**
   * 用新组件列表整体替换配置并落库（重排 / 增删后的统一出口）。
   * 本地立即生效（用户马上看到结果），随后 PUT 平台（失败保留本地草稿并提示）。
   */
  async function replaceWidgets(widgets: BoardWidget[]): Promise<void> {
    setConfig({ version: config.value.version, widgets });
    await pushBoard();
  }

  return {
    config,
    configInvalid,
    isLocalDraft,
    loadBoard,
    persistLocal,
    pushBoard,
    replaceWidgets,
    saveError,
    saving,
    setConfig,
    source,
  };
}

export type BoardLoadApi = ReturnType<typeof useBoardLoad>;
