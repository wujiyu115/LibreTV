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

describe('旋转容器不能带安全区内边距（回归）', () => {
  /**
   * 曾经的错误：把 safe-area 映射成 padding 打到被旋转的视频容器上。
   *
   * 为什么错：rotate(90deg) 后刘海落在画面的**长边**方向，而视频本来就该
   * 铺满那条边。加 padding 只会把画面往里挤——实测 iPhone 14 上
   * padding-left:47 + padding-right:34 让 844px 的可用长度缩到 763px，
   * 即画面两端各多出一条黑边，尺寸正好等于 inset 值。
   *
   * 正确做法：旋转容器保持满屏无 padding；安全区只用在有交互的元素上
   * （页面顶栏 / 底部抽屉），播放器控件由 ArtPlayer 自己内缩。
   */
  it('样式表里不再存在 .ltv-rotate 的 padding 规则', () => {
    expect(css.includes('.ltv-rotate')).toBe(false);
  });

  it('旋转相关的 class 名不与 safe-* 工具类混用', () => {
    // 旋转容器上的 class 由 lib/orientation 添加，不能是 safe-* 系列
    expect(css).not.toMatch(/\.ltv-rotate\s*\{[^}]*padding/s);
  });
});
