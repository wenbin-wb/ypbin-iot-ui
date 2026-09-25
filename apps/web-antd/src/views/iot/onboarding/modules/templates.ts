import { $t } from '#/locales';

/**
 * 内置产品模板（F6 接入向导的「从模板创建」）。
 *
 * **为什么是前端静态定义**：后端没有模板能力（无模板表、无模板接口），本轮的定位是
 * 「让新用户不用从零理解物模型」；一键创建走的是**既有**的产品/服务/属性写接口
 * （`POST /iot/products` → `/services` → `/services/{serviceId}/properties`），
 * 不新造任何后端能力。模板后端化留在方案 P1-11。
 *
 * **点位建议只是文案**：点位映射挂在**设备**上（`iot_point_mapping.device_id`，缺口 G4），
 * 所以模板不可能替设备建点位；这里给的是「接这台设备时地址大致填什么」的提示，
 * 由用户在设备详情的「属性与点位」里真正落地。
 */
export interface OnboardingTemplateProperty {
  identifier: string;
  propertyName: string;
  /** 物模型数据类型（后端白名单：int|long|decimal|string|bool|enum|date_time|json_object|array）。 */
  dataType: string;
  /** 读写权限：R | W | RW。 */
  accessMode: string;
  unit?: string;
  minValue?: string;
  maxValue?: string;
  /** 点位建议（展示用；不是自动建点位）。 */
  pointHint: string;
}

export interface OnboardingTemplate {
  key: string;
  /** 模板展示名。 */
  name: string;
  /** 一句话说明（这个模板适合什么设备）。 */
  description: string;
  /** 产品编码前缀（用户可改；最终编码会带一个短后缀避免同租户唯一键冲突）。 */
  productCodePrefix: string;
  /** 预填的产品名。 */
  productName: string;
  /** 预填的接入协议码。 */
  protocol: string;
  /** 服务标识（PascalCase，产品内唯一）。 */
  serviceId: string;
  serviceName: string;
  properties: OnboardingTemplateProperty[];
}

/**
 * 内置模板清单。
 *
 * 用**函数**而不是模块级常量：`$t()` 必须在 i18n 就绪后求值（模块级常量会在 import 期固化文案，
 * 切语言不会跟着变）；仓内 `data.ts` 的 `useColumns()` 也是同一写法。
 *
 * @returns 模板清单（至少含温湿度传感器）
 */
export function useOnboardingTemplates(): OnboardingTemplate[] {
  return [
    {
      key: 'temp-humidity',
      name: $t('page.iot.onboarding.templateTempHumidityName'),
      description: $t('page.iot.onboarding.templateTempHumidityDesc'),
      productCodePrefix: 'th-sensor',
      productName: $t('page.iot.onboarding.templateTempHumidityProduct'),
      protocol: 'modbus',
      serviceId: 'TempHumidity',
      serviceName: $t('page.iot.onboarding.templateTempHumidityService'),
      properties: [
        {
          identifier: 'temperature',
          propertyName: $t('page.iot.onboarding.propertyTemperature'),
          dataType: 'decimal',
          accessMode: 'R',
          unit: '℃',
          minValue: '-40',
          maxValue: '125',
          pointHint: $t('page.iot.onboarding.templateTempHumidityPointTemp'),
        },
        {
          identifier: 'humidity',
          propertyName: $t('page.iot.onboarding.propertyHumidity'),
          dataType: 'decimal',
          accessMode: 'R',
          unit: '%RH',
          minValue: '0',
          maxValue: '100',
          pointHint: $t('page.iot.onboarding.templateTempHumidityPointHumidity'),
        },
      ],
    },
    {
      key: 'relay-switch',
      name: $t('page.iot.onboarding.templateRelayName'),
      description: $t('page.iot.onboarding.templateRelayDesc'),
      productCodePrefix: 'relay-switch',
      productName: $t('page.iot.onboarding.templateRelayProduct'),
      protocol: 'modbus',
      serviceId: 'RelaySwitch',
      serviceName: $t('page.iot.onboarding.templateRelayService'),
      properties: [
        {
          identifier: 'power',
          propertyName: $t('page.iot.onboarding.propertyPower'),
          dataType: 'bool',
          accessMode: 'RW',
          pointHint: $t('page.iot.onboarding.templateRelayPointPower'),
        },
        {
          identifier: 'voltage',
          propertyName: $t('page.iot.onboarding.propertyVoltage'),
          dataType: 'decimal',
          accessMode: 'R',
          unit: 'V',
          minValue: '0',
          maxValue: '300',
          pointHint: $t('page.iot.onboarding.templateRelayPointVoltage'),
        },
      ],
    },
  ];
}
