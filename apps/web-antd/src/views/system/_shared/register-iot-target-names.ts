/**
 * IoT 侧的「空间关联对象名」解析器注册。
 *
 * <p>由 `bootstrap.ts` 以副作用 import 引入（本仓独有文件，admin-ui 不存在）。</p>
 *
 * <h2>为什么注册而不是让抽屉直接调</h2>
 *
 * 空间关联抽屉属基础模块；本仓与 admin-ui 的该文件**逐字节相同**，
 * 一旦在其中 import `#/api/iot`，admin-ui 会编译失败（那边没有 iot 模块）。
 * 注册表把「谁提供解析」下沉到各仓自己的启动代码，抽屉保持零差异。
 *
 * @module views/system/_shared/register-iot-target-names
 */
import { getDeviceNameMap } from '#/api/iot';

import {
  registerTargetNameResolver,
  TARGET_TYPE_DEVICE,
} from './target-name-resolver';

registerTargetNameResolver(TARGET_TYPE_DEVICE, async (_targetType, ids) => {
  if (ids.length === 0) {
    return {};
  }
  // 复用设备侧的批量取名（内部按页拉取，一次请求取一页 ID→名称）
  return await getDeviceNameMap(ids);
});
