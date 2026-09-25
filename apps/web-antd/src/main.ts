import { initPreferences, updatePreferences } from '@vben/preferences';
import { unmountGlobalLoading } from '@vben/utils';

import { overridesPreferences, preferencesExtension } from './preferences';
import {
  normalizeCachedLayoutPreference,
  REQUIRED_LAYOUT,
} from './preferences-layout-migration';

/**
 * 应用初始化完成之后再进行页面加载渲染
 */
async function initApplication() {
  // name用于指定项目唯一标识
  // 用于区分不同项目的偏好设置以及存储数据的key前缀以及其他一些需要隔离的数据
  const env = import.meta.env.PROD ? 'prod' : 'dev';
  const appVersion = import.meta.env.VITE_APP_VERSION;
  const namespace = `${import.meta.env.VITE_APP_NAMESPACE}-${appVersion}-${env}`;

  // K1：偏好是「缓存优先」，老用户 localStorage 里的旧布局会盖掉 overrides 里的默认布局。
  // 启动前先做一次性归一：只清缓存里的 app.layout（不动主题/语言，也不动业务令牌）。
  const layoutNormalized = normalizeCachedLayoutPreference(namespace);

  // app偏好设置初始化
  await initPreferences({
    extension: preferencesExtension,
    namespace,
    overrides: overridesPreferences,
  });

  // 兜底：缓存结构与预期不符（归一没做成）时，用公开 API 保证本次会话就是目标布局。
  // 这里不写归一版本号 —— 下次启动会再试一次同步归一，缓存格式一旦恢复正常即自愈。
  if (!layoutNormalized) {
    updatePreferences({ app: { layout: REQUIRED_LAYOUT } });
  }

  // 启动应用并挂载
  // vue应用主要逻辑及视图
  const { bootstrap } = await import('./bootstrap');
  await bootstrap(namespace);

  // 移除并销毁loading
  unmountGlobalLoading();
}

initApplication();
