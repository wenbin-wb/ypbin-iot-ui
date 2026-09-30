import {
  defineOverridesPreferences,
  definePreferencesExtension,
} from '@vben/preferences';

interface WebAntdPreferencesExtension {
  defaultTableSize: number;
  enableFormFullscreen: boolean;
  reportTitle: string;
  tenantMode: 'multi' | 'single';
}

/**
 * @description 项目配置文件
 * 只需要覆盖项目中的一部分配置，不需要的配置不用覆盖，会自动使用默认配置
 * !!! 更改配置后请清空缓存，否则可能不生效
 */
export const overridesPreferences = defineOverridesPreferences({
  // overrides
  app: {
    name: import.meta.env.VITE_APP_TITLE,
    // 菜单从后端获取（走 /menu/all），而非前端内置路由
    accessMode: 'backend',
    // 首次登录落点：后端菜单的 /dashboard 只是无组件目录（子菜单 path 均为绝对路径，
    // 框架不会自动加 redirect），直接进会白屏；改到分析页。
    defaultHomePath: '/dashboard/analytics',
    // 默认头像：不用基座的 unpkg 外链图，改本地 IoT 风格头像（用户无头像时回退到此）
    defaultAvatar: '/avatar-default.svg',
    // 平台级导航：顶部一级大模块 + 左侧二级菜单（vben 原生 mixed-nav）。
    // 偏好是「缓存优先」——老用户的 localStorage 会盖掉这里，所以启动时还要跑一次性
    // 布局归一（见 preferences-layout-migration.ts），否则本行对老用户不生效。
    layout: 'mixed-nav',
    locale: 'zh-CN',
    // Sa-Token 为续期机制、无 refresh token，关闭前端刷新逻辑
    enableRefreshToken: false,
  },
  // 顶部大模块导航：居中展示（对标智慧园区：logo 左 / 大模块居中 / 用户区右）
  header: {
    menuAlign: 'center',
  },
  sidebar: {
    // 点顶部大模块时内容区同步跳到该模块（上次访问的子菜单，没有则进目录 redirect
    // 指向的第一个子菜单），而不是只切左侧菜单、内容区不动
    autoActivateChild: true,
  },
  copyright: {
    companyName: 'Ypbin IoT',
    companySiteLink: 'https://github.com/wenbin-wb/ypbin-iot-ui',
    date: '2026',
    enable: true,
    icp: '',
    icpLink: '',
    settingShow: true,
  },
  logo: {
    source: '/ypbin-logo.png',
    sourceDark: '/ypbin-logo.png',
  },
});

export const preferencesExtension =
  definePreferencesExtension<WebAntdPreferencesExtension>({
    tabLabel: 'preferences.antd.tabLabel',
    title: 'preferences.antd.title',
    fields: [
      {
        component: 'switch',
        defaultValue: true,
        key: 'enableFormFullscreen',
        label: 'preferences.antd.fields.enableFormFullscreen.label',
        tip: 'preferences.antd.fields.enableFormFullscreen.tip',
      },
      {
        component: 'select',
        defaultValue: 'single',
        key: 'tenantMode',
        label: 'preferences.antd.fields.tenantMode.label',
        options: [
          {
            label: 'preferences.antd.fields.tenantMode.options.single.label',
            value: 'single',
          },
          {
            label: 'preferences.antd.fields.tenantMode.options.multi.label',
            value: 'multi',
          },
        ],
      },
      {
        component: 'number',
        componentProps: {
          max: 200,
          min: 10,
          step: 10,
        },
        defaultValue: 20,
        key: 'defaultTableSize',
        label: 'preferences.antd.fields.defaultTableSize.label',
      },
      {
        component: 'input',
        defaultValue: '',
        key: 'reportTitle',
        label: 'preferences.antd.fields.reportTitle.label',
        placeholder: 'preferences.antd.fields.reportTitle.placeholder',
      },
    ],
  });
