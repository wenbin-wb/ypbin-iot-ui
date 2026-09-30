/**
 * 用户选择器的**纯逻辑**（可回显 / 去重 / 补拉判据）。
 *
 * 为什么抽出来：这些判断决定"用户看到的是名字还是裸 ID"——而这恰恰是
 * **编辑回显**最容易做错的地方：只拿到 id 列表、拉到的候选里又没有那几个人
 * （分页/搜索词不匹配），于是标签显示成一串数字，用户根本认不出选了谁。
 *
 * 组件只负责渲染，结论由本模块给出，因此可以在 jsdom 之外直接跑用例。
 */

/** 用户最小信息（只声明本模块用到的字段，避免与 `SystemUserApi.SystemUser` 强耦合）。 */
export interface UserLike {
  id: number | string;
  /** 邮箱（后端可空；告警收件人等场景要展示/回显它）。 */
  email?: null | string;
  /** 真实姓名（后端可空）。 */
  realName?: null | string;
  /** 登录名。 */
  username?: null | string;
}

/** 下拉选项。 */
export interface UserOption {
  /** 展示文案。 */
  label: string;
  /** 值（**统一为字符串**：后端 Long 全局序列化成字符串，混用 number 会让 v-model 比对失败）。 */
  value: string;
  /** 附加信息，供 tooltip / 搜索用。 */
  username?: string;
  email?: null | string;
}

/**
 * 从字符串或数组归一化出一组用户 ID。
 *
 * 兼容三种入参：`'1,2'`（后端存储形态）、`['1','2']`（选择器形态）、`null`。
 * 为什么必须兼容字符串：本组件的值有两个来源——选择器自己（数组）与后端回填（逗号串），
 * 归一化放在一处，调用方就不必各写一遍。
 *
 * @param value 原始值
 * @returns 去重后的 ID 字符串数组（**绝不返回 null**）
 */
export function normalizeUserIds(
  value?: null | number | number[] | string | string[],
): string[] {
  if (value === null || value === undefined || value === '') {
    return [];
  }
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const token = String(item ?? '').trim();
    if (token === '' || seen.has(token)) {
      continue;
    }
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * 生成一个用户的展示文案。
 *
 * 有真实姓名时附上登录名（`张三（zhangsan）`）：同名用户在系统里很常见，
 * 只显示姓名会让"到底选的是哪一个"无法分辨。
 *
 * @param user 用户
 * @returns 展示文案（**空姓名回落登录名，再回落 `#id`**——绝不返回空串）
 */
export function resolveUserLabel(user: UserLike): string {
  const id = String(user?.id ?? '');
  const name = (user?.realName ?? '').trim();
  const username = (user?.username ?? '').trim();
  if (name && username) {
    return `${name}（${username}）`;
  }
  if (name) {
    return name;
  }
  if (username) {
    return username;
  }
  // 既无姓名也无登录名：显示 #id 而不是空——空白标签比"裸 ID"更糟（用户以为组件坏了）
  return id === '' ? '未知用户' : `#${id}`;
}

/**
 * 用户 → 下拉选项。
 *
 * @param user 用户
 * @returns 选项
 */
export function toUserOption(user: UserLike): UserOption {
  return {
    label: resolveUserLabel(user),
    value: String(user.id),
    username: (user?.username ?? '') || undefined,
    email: user?.email ?? null,
  };
}

/**
 * 合并多批选项（按 `value` 去重，**保留首次出现的顺序**）。
 *
 * 用途：搜索结果是分两路（username / realName）合并来的；回显补拉的详情也要并进来。
 *
 * @param batches 多批选项
 * @returns 去重后的新数组
 */
export function mergeUserOptions(...batches: UserOption[][]): UserOption[] {
  const out: UserOption[] = [];
  const seen = new Set<string>();
  for (const batch of batches) {
    for (const option of batch ?? []) {
      const value = String(option?.value ?? '').trim();
      if (value === '' || seen.has(value)) {
        continue;
      }
      seen.add(value);
      out.push({ ...option, value });
    }
  }
  return out;
}

/**
 * 算出**需要补拉详情**的 ID（已选中但候选里没有的）。
 *
 * 🔴 这是回显能显示名字的关键：编辑一条既有规则时，选中的人是历史数据，
 * 未必出现在当前搜索结果里。不补拉就只能显示裸 ID。
 *
 * @param selectedIds 已选中的 ID
 * @param loadedOptions 当前已加载的候选
 * @returns 待补拉的 ID（顺序同 `selectedIds`）
 */
export function planBackfillIds(
  selectedIds: string[],
  loadedOptions: UserOption[],
): string[] {
  const loaded = new Set(
    (loadedOptions ?? []).map((item) => String(item.value)),
  );
  return normalizeUserIds(selectedIds).filter((id) => !loaded.has(id));
}

/**
 * 为补拉失败的 ID 生成**占位选项**。
 *
 * 为什么要占位：详情接口失败（用户被删/无权限/网络抖动）时，若不给选项，
 * antdv 的多选会把该值渲染成裸 ID 甚至丢失标签——用户会以为"我选的被人改了"。
 * 占位保留该值并标注"（未知用户）"，让信息**如实**呈现而不是消失。
 *
 * @param ids 补拉失败的 ID
 * @returns 占位选项
 */
export function placeholderOptions(ids: string[]): UserOption[] {
  return normalizeUserIds(ids).map((id) => ({
    label: `#${id}（未知用户）`,
    value: id,
  }));
}

/**
 * 本地过滤（用于已加载候选的即时过滤兜底）。
 *
 * 服务端搜索是主路径（`getUserList`），但**已加载的候选项在用户继续输入时**
 * 也应按本地匹配立即反应，否则每次按键都要等一次往返，体验上像卡住。
 *
 * @param options 候选
 * @param keyword 关键词
 * @returns 命中项（关键词为空时原样返回）
 */
export function filterUserOptions(
  options: UserOption[],
  keyword: string,
): UserOption[] {
  const key = (keyword ?? '').trim().toLowerCase();
  if (key === '') {
    return options ?? [];
  }
  return (options ?? []).filter((option) => {
    const label = String(option?.label ?? '').toLowerCase();
    const username = String(option?.username ?? '').toLowerCase();
    return label.includes(key) || username.includes(key);
  });
}
