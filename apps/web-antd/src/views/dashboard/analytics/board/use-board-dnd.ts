import type { Ref } from 'vue';

import type { BoardConfig, BoardWidget } from './board-utils';
import type { BoardLoadApi } from './use-board-load';
import type { BoardRuntimeApi } from './use-board-runtime';

import { ref } from 'vue';

import {
  addBoardWidget,
  moveBoardWidget,
  moveWidget,
  removeBoardWidget,
  updateBoardWidget,
} from './board-utils';

/**
 * 看板的**结构变更**：拖拽排序、上移/下移、组件增删改（从 board-drawer.vue 抽出，
 * 逻辑逐行搬移，不改语义）。
 *
 * 三条口径（与抽出前一致，别在别处再实现一套）：
 * 1. **纯函数决策**：顺序/增删都由 `board-utils` 的纯函数算（`moveWidget` 插入语义、
 *    `moveBoardWidget` 按 id 上下移、`addBoardWidget` 补 id……），本文件只负责「算完就落库」；
 * 2. **本地先生效、再 PUT**：用户立刻看到结果；PUT 失败由 `useBoardLoad.pushBoard`
 *    保留本地草稿并提示（这里不重复处理）；
 * 3. **运行期跟随**：删除组件要扔掉它的运行期数据，新增/编辑只重拉**这一张卡**的数据
 *    （不整板重查，避免其余卡片闪一下）。
 *
 * 为什么单独成 composable：这是看板里唯一会「改配置」的入口集合，独立后
 * 「谁能改配置」一目了然 —— 其余模块只读 `config`。
 */
export function useBoardDnd(options: {
  config: Ref<BoardConfig>;
  load: BoardLoadApi;
  runtime: BoardRuntimeApi;
}) {
  const { config, load, runtime } = options;

  const dragIndex = ref<null | number>(null);

  /** 拖拽：dragstart 记录源下标，drop 在目标卡片上完成插入式重排。 */
  function onDragStart(index: number): void {
    dragIndex.value = index;
  }

  async function onDrop(index: number): Promise<void> {
    const from = dragIndex.value;
    dragIndex.value = null;
    if (from === null) {
      return;
    }
    const next = moveWidget(config.value.widgets, from, index);
    if (next === config.value.widgets) {
      return;
    }
    await load.replaceWidgets(next);
  }

  /** 上移/下移按钮（键盘/触屏兜底）：与拖拽共用 `moveWidget` 规则。 */
  async function moveWidgetBy(id: string, offset: number): Promise<void> {
    const moved = moveBoardWidget(config.value, id, offset);
    if (moved === config.value) {
      return;
    }
    await load.replaceWidgets(moved.widgets);
  }

  /** 删除组件：先落配置，再扔掉它的运行期数据，最后 PUT（顺序与原实现一致）。 */
  async function removeWidget(widget: BoardWidget): Promise<void> {
    load.setConfig(removeBoardWidget(config.value, widget.id));
    runtime.dropWidgetRuntime(widget.id);
    await load.pushBoard();
  }

  /** 新增/编辑提交：写回配置 + 持久化 + 只加载这一个组件的数据（不整板重查）。 */
  async function onWidgetSaved(widget: BoardWidget): Promise<void> {
    const exists = config.value.widgets.some((item) => item.id === widget.id);
    load.setConfig(
      exists
        ? updateBoardWidget(config.value, widget.id, widget)
        : addBoardWidget(config.value, widget),
    );
    await load.pushBoard();
    const saved = exists
      ? config.value.widgets.find((item) => item.id === widget.id)
      : config.value.widgets.at(-1);
    if (!saved) {
      return;
    }
    runtime.resetWidgetRuntime(saved.id);
    await runtime.loadWidgetRuntime(saved, new Map());
  }

  return {
    dragIndex,
    moveWidgetBy,
    onDragStart,
    onDrop,
    onWidgetSaved,
    removeWidget,
  };
}

export type BoardDndApi = ReturnType<typeof useBoardDnd>;
