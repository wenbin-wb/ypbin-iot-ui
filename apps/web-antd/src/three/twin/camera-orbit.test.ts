import { describe, expect, it, vi } from 'vitest';

import { AUTO_ORBIT_IDLE_MS, stepOrbit } from './camera-orbit';

/**
 * 自动巡航的纯函数部分：空闲判定 + 缓入。
 *
 * 为什么只测纯函数：真实巡航要改 `camera.position`（需要 three 的球坐标数学），
 * 单测里用替身测「有没有转到某个角度」价值不大；真正要钉住的不变量是
 * **「空闲满 20s 才启动」** 与 **「一有交互立刻归零」** —— 这两条是用户体验的关键，
 * 也是最容易被后续改动破坏的地方。
 */
describe('stepOrbit：空闲启动与缓入', () => {
  it('★ 空闲不足 20s ⇒ 不环绕（ease 归零）', () => {
    const phase = stepOrbit(
      { ease: 0.5, orbiting: true },
      19_999,
      AUTO_ORBIT_IDLE_MS,
      0.016,
    );
    expect(phase.orbiting).toBe(false);
    expect(phase.ease).toBe(0);
  });

  it('★ 一有交互（空闲 0）⇒ 立即停止（不回弹）', () => {
    const phase = stepOrbit(
      { ease: 1, orbiting: true },
      0,
      AUTO_ORBIT_IDLE_MS,
      0.016,
    );
    expect(phase.orbiting).toBe(false);
    expect(phase.ease).toBe(0);
  });

  it('★ 满 20s 才开始，且有缓入（首帧不是全速）', () => {
    const first = stepOrbit(
      { ease: 0, orbiting: false },
      AUTO_ORBIT_IDLE_MS,
      AUTO_ORBIT_IDLE_MS,
      0.016,
    );
    expect(first.orbiting).toBe(true);
    expect(first.ease).toBeGreaterThan(0);
    expect(first.ease).toBeLessThan(0.5);
  });

  it('缓入单调爬升到 1 并封顶（不会超过 1）', () => {
    let phase = { ease: 0, orbiting: false };
    for (let i = 0; i < 500; i++) {
      phase = stepOrbit(phase, AUTO_ORBIT_IDLE_MS, AUTO_ORBIT_IDLE_MS, 1 / 60);
      expect(phase.ease).toBeLessThanOrEqual(1);
    }
    expect(phase.ease).toBe(1);
  });

  it('空闲阈值常量是 20s（需求口径）', () => {
    expect(AUTO_ORBIT_IDLE_MS).toBe(20_000);
  });
});

describe('createAutoOrbit：事件绑定与开关', () => {
  it('★ pointerdown/wheel/touchstart/keydown 都会通知交互；dispose 移除监听', async () => {
    vi.resetModules();
    // 用最小的 three 替身：只要 Spherical / Vector3
    const THREE = {
      Spherical: class {
        phi = 1;
        radius = 1;
        theta = 0;
        setFromCartesianCoords() {
          return this;
        }
        setFromVector3() {
          return this;
        }
      },
      Vector3: class {
        x = 0;
        y = 0;
        z = 0;
        add() {
          return this;
        }
        clone() {
          return this;
        }
        copy() {
          return this;
        }
        lengthSq() {
          return 1;
        }
        normalize() {
          return this;
        }
        set() {
          return this;
        }
        setFromSpherical() {
          return this;
        }
        sub() {
          return this;
        }
      },
    } as never;
    const { createAutoOrbit } = await import('./camera-orbit');
    const removed: string[] = [];
    const added: string[] = [];
    const domElement = {
      addEventListener: (name: string) => {
        added.push(name);
        return undefined;
      },
      removeEventListener: (name: string) => {
        removed.push(name);
        return undefined;
      },
    } as never;
    let clock = 0;
    const orbit = createAutoOrbit(THREE, {
      camera: {
        lookAt: () => undefined,
        position: {
          add: () => undefined,
          // `copy()` 返回自身，链式 `.add()` 才有地方调用
          copy(this: unknown) {
            return this;
          },
          sub: () => undefined,
        },
      } as never,
      controls: { target: { x: 0, y: 0, z: 0 } as never },
      domElement,
      enabled: true,
      idleMs: 1000,
      now: () => clock,
    });
    expect(added.toSorted()).toEqual([
      'keydown',
      'pointerdown',
      'touchstart',
      'wheel',
    ]);

    // 空闲未满：不环绕
    clock = 500;
    orbit.update(0.016);
    expect(orbit.isOrbiting()).toBe(false);
    // 空闲届满：开始环绕
    clock = 1500;
    orbit.update(0.016);
    expect(orbit.isOrbiting()).toBe(true);
    // 一次交互：立刻停
    orbit.notifyInteraction();
    expect(orbit.isOrbiting()).toBe(false);

    orbit.dispose();
    expect(removed.toSorted()).toEqual([
      'keydown',
      'pointerdown',
      'touchstart',
      'wheel',
    ]);
  });

  it('enabled=false（reduced/off 档）时永不环绕', async () => {
    vi.resetModules();
    const THREE = {
      Spherical: class {
        phi = 1;
        radius = 1;
        theta = 0;
        setFromCartesianCoords() {
          return this;
        }
        setFromVector3() {
          return this;
        }
      },
      Vector3: class {
        x = 0;
        y = 0;
        z = 0;
        add() {
          return this;
        }
        clone() {
          return this;
        }
        copy() {
          return this;
        }
        set() {
          return this;
        }
        setFromSpherical() {
          return this;
        }
        sub() {
          return this;
        }
      },
    } as never;
    const { createAutoOrbit } = await import('./camera-orbit');
    const orbit = createAutoOrbit(THREE, {
      camera: {
        lookAt: () => undefined,
        position: {
          add: () => undefined,
          // `copy()` 返回自身，链式 `.add()` 才有地方调用
          copy(this: unknown) {
            return this;
          },
          sub: () => undefined,
        },
      } as never,
      controls: { target: {} as never },
      domElement: {
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as never,
      enabled: false,
      idleMs: 0,
      now: () => 1_000_000,
    });
    for (let i = 0; i < 10; i++) {
      orbit.update(0.1);
    }
    expect(orbit.isOrbiting()).toBe(false);
    orbit.dispose();
  });
});
