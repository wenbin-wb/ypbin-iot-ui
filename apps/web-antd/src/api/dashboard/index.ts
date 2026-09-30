/**
 * 仪表盘 API 出口。
 *
 * 旧的系统概览统计（用户/角色/部门/菜单/在线/日志，`/system/dashboard/*`）是基座
 * （通用后台）口径，物联网平台的分析页/工作台已全部改用 `iot-overview`。
 * 后端如恢复系统统计页，再按需把旧模块加回来。
 */
export * from './iot-overview';
