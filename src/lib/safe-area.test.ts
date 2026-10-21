import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * safe-area 规则的静态校验。
 *
 * 为什么用读文件而不是渲染测试：env(safe-area-inset-*) 只在真实刘海设备上
 * 有非零值，jsdom / Chromium 里恒为 0，断言不出任何东西。
 * 这里锁定的是「映射方向」这个最容易写反、且一旦写反肉眼很难立刻定位的点
 * （表现是刘海留白跑到画面另一边，看着像视频居中偏了）。
 */

const css = readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8');

/** 取出某个选择器块的内容 */
function blockOf(selector: string): string {
  const idx = css.indexOf(`${selector} {`);
  if (idx < 0) throw new Error(`未找到选择器 ${selector}`);
  const end = css.indexOf('}', idx);
  return css.slice(idx, end);
}

describe('安全区工具类', () => {
  it('四个方向都有对应工具类', () => {
    for (const sel of ['.safe-top', '.safe-bottom', '.safe-x', '.safe-all']) {
      expect(css.includes(`${sel} {`), sel).toBe(true);
    }
  });

  it('env() 都带 0px 兜底：不支持的环境里不能把布局撑出空隙', () => {
    // env(x) 不带第二个参数时，不支持的浏览器会整条声明失效或按 0 处理，
    // 显式写 0px 避免各家差异
    const matches = css.match(/env\(safe-area-inset-[a-z]+[^)]*\)/g) ?? [];
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m, `${m} 缺少兜底值`).toMatch(/,\s*0px\s*\)/);
    }
  });
});

describe('旋转态的安全区映射', () => {
  it('.ltv-rotate 存在且四向都有 padding', () => {
    const block = blockOf('.ltv-rotate');
    for (const dir of ['padding-top', 'padding-right', 'padding-bottom', 'padding-left']) {
      expect(block, dir).toContain(dir);
    }
  });

  /**
   * 方向推导（transform = rotate(90deg) translate(0,-vw)，origin 0 0）：
   *   本地点 (x,y) → (x, y-vw) → 旋转 → (vw-y, x)
   *   本地左边 → 物理上边；本地右边 → 物理下边
   *
   * 竖屏锁定（该按钮的主要场景）只有 inset-top（刘海）与 inset-bottom（Home 条）
   * 非零，所以：
   *   padding-left  ← inset-top     （避开刘海）
   *   padding-right ← inset-bottom  （避开 Home 条）
   *
   * 实测：padding-left:47 / padding-right:34 时，内容区在屏幕上落在 y=47..666，
   * 即刘海侧留出 47、底部留出 34，方向正确。
   */
  it('本地 left 对应 inset-top（刘海侧）', () => {
    const block = blockOf('.ltv-rotate');
    const leftRule = block.match(/padding-left:\s*([^;]+);/)?.[1] ?? '';
    expect(leftRule).toContain('safe-area-inset-top');
  });

  it('本地 right 对应 inset-bottom（Home 指示条侧）', () => {
    const block = blockOf('.ltv-rotate');
    const rightRule = block.match(/padding-right:\s*([^;]+);/)?.[1] ?? '';
    expect(rightRule).toContain('safe-area-inset-bottom');
  });

  it('不会把 inset-top 错配到 padding-top（写反的典型错误）', () => {
    const block = blockOf('.ltv-rotate');
    const topRule = block.match(/padding-top:\s*([^;]+);/)?.[1] ?? '';
    expect(topRule).not.toContain('safe-area-inset-top');
  });
});
