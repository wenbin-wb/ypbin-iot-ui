import { describe, expect, it, vi } from 'vitest';

import { useOnboardingTemplates } from './templates';

vi.mock('#/locales', () => ({ $t: (key: string) => key }));

/**
 * 内置品类模板用例（看板 #12「品类模板+必选功能」）。
 *
 * 重点：**必选功能语义** —— 温湿度模板的温度/湿度、继电器模板的电源开关是核心量测/
 * 控制对象 ⇒ required=true（创建物模型时写入、UI 标「必选」）；次要量测（电压）不强制。
 */

function template(key: string) {
  const found = useOnboardingTemplates().find((item) => item.key === key);
  if (!found) {
    throw new Error(`template not found: ${key}`);
  }
  return found;
}

describe('品类模板必选功能', () => {
  it('温湿度模板：温度与湿度都是必选（核心量测）', () => {
    const tpl = template('temp-humidity');
    const byId = new Map(
      tpl.properties.map((property) => [property.identifier, property]),
    );
    expect(byId.get('temperature')?.required).toBe(true);
    expect(byId.get('humidity')?.required).toBe(true);
  });

  it('继电器模板：电源开关必选（控制主对象），电压不强制', () => {
    const tpl = template('relay-switch');
    const byId = new Map(
      tpl.properties.map((property) => [property.identifier, property]),
    );
    expect(byId.get('power')?.required).toBe(true);
    expect(byId.get('voltage')?.required).toBeFalsy();
  });

  it('每个模板至少有一个必选功能', () => {
    for (const tpl of useOnboardingTemplates()) {
      expect(tpl.properties.some((property) => property.required)).toBe(true);
    }
  });
});
