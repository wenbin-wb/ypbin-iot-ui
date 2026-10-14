/**
 * 通知渠道码 → 展示文案（与后端 NotificationChannel / 规则表单的渠道勾选项同一口径）。
 *
 * 为什么单独成文件：告警展开行的投递记录此前直接渲染 `{{ row2.channel }}`，
 * 界面上就是 `INBOX` / `EMAIL` 这种机器码；这里集中映射，未知渠道**不伪装成已知值**，
 * 返回「未知（原码）」保留排障线索。
 */
import { $t } from '#/locales';

/** 渠道码 → 中文；未知码回落 `未知（原码）`，空值回落 `-`。 */
export function channelLabel(channel?: null | string): string {
  const code = (channel ?? '').trim();
  switch (code.toUpperCase()) {
    case 'EMAIL': {
      return $t('page.iot.alert.channel.email');
    }
    case 'INBOX': {
      return $t('page.iot.alert.channel.inbox');
    }
    default: {
      return code === ''
        ? '-'
        : $t('page.iot.display.unknownWithValue', [code]);
    }
  }
}
