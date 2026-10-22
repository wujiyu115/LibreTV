import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  ROTATE_CLASS,
  applyRotate,
  clearRotate,
  computeRotateSize,
  isIOS,
  isStandalone,
  rotateHintOnIOS,
  rotatedSeekRatio,
  visibleViewport,
} from './orientation';

/** 造一个可控的假容器：ownerDocument 里给固定视口尺寸 */
function fakeElement(vw: number, vh: number) {
  const classes = new Set<string>();
  const style: Record<string, string> = {};
  const doc = {
    documentElement: { clientWidth: vw, clientHeight: vh },
  };
  const element = {
    ownerDocument: doc,
    style: style as unknown as CSSStyleDeclaration,
    classList: {
      add: (c: string) => classes.add(c),
      remove: (c: string) => classes.delete(c),
      contains: (c: string) => classes.has(c),
    },
  };
  return { element: element as unknown as HTMLElement, style, classes };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeBody() {
  const style: Record<string, string> = {};
  const data: Record<string, string> = {};
  const body = {
    style: style as unknown as CSSStyleDeclaration,
    dataset: data,
  };
  return { body: body as unknown as HTMLElement, style, data };
}

describe('computeRotateSize', () => {
  it('宽高互换：旋转后视觉宽 = 视口高', () => {
    // 竖屏 390×844：容器要先设成 844 宽 × 390 高，转 90° 后才是 844 宽的画面
    expect(computeRotateSize(390, 844)).toEqual({
      width: 844,
      height: 390,
      translateY: 390,
    });
  });
});

describe('applyRotate', () => {
  it('按视口算出宽高并旋转铺满视口', () => {
    const { element, style, classes } = fakeElement(390, 844);

    applyRotate({ element });

    expect(style.width).toBe('844px');
    expect(style.height).toBe('390px');
    expect(style.transform).toBe('rotate(90deg) translate(0, -390px)');
    expect(style.transformOrigin).toBe('0 0');
    expect(style.position).toBe('fixed');
    expect(classes.has(ROTATE_CLASS)).toBe(true);
  });

  it('清掉可能限制尺寸的继承样式', () => {
    // 播放器外层是 aspect-video + overflow-hidden，不覆盖会被裁成小窗
    const { element, style } = fakeElement(390, 844);

    applyRotate({ element });

    expect(style.maxWidth).toBe('none');
    expect(style.maxHeight).toBe('none');
    expect(style.margin).toBe('0');
  });

  it('锁定页面滚动，避免旋转后背景还能滑', () => {
    const { element } = fakeElement(390, 844);
    const { body, style, data } = fakeBody();

    applyRotate({ element, body });

    expect(style.overflow).toBe('hidden');
    expect(data.ltvRotate).toBe('1');
  });

  it('视口尺寸变化后重新计算（横屏手机转为更宽时）', () => {
    const { element, style } = fakeElement(844, 390);

    applyRotate({ element });

    expect(style.width).toBe('390px');
    expect(style.height).toBe('844px');
  });
});

describe('clearRotate', () => {
  it('清空全部内联样式并移除标记', () => {
    const { element, style, classes } = fakeElement(390, 844);

    applyRotate({ element });
    clearRotate({ element });

    expect(classes.has(ROTATE_CLASS)).toBe(false);
    for (const key of ['position', 'inset', 'zIndex', 'width', 'height', 'transform', 'transformOrigin', 'maxWidth', 'maxHeight', 'margin']) {
      expect(style[key], key).toBe('');
    }
  });

  it('恢复页面滚动', () => {
    const { element } = fakeElement(390, 844);
    const { body, style, data } = fakeBody();

    applyRotate({ element, body });
    clearRotate({ element, body });

    expect(style.overflow).toBe('');
    expect(data.ltvRotate).toBeUndefined();
  });

  it('未旋转时调用也安全（幂等）', () => {
    const { element, style } = fakeElement(390, 844);

    expect(() => clearRotate({ element })).not.toThrow();
    expect(style.transform).toBe('');
  });
});

describe('visibleViewport（iOS 工具栏问题的核心）', () => {
  it('优先用 visualViewport：它是最小可见区', () => {
    // 布局视口高 844（含被地址栏遮住的部分），实际可见只有 700
    const { element } = fakeElement(390, 844);
    vi.stubGlobal('window', {
      visualViewport: { width: 390, height: 700, offsetTop: 0, offsetLeft: 0 },
    });

    const box = visibleViewport(element.ownerDocument);
    expect(box).toEqual({ width: 390, height: 700, offsetTop: 0, offsetLeft: 0 });
  });

  it('带上 offsetTop/offsetLeft 用于补偿固定定位偏移', () => {
    const { element } = fakeElement(390, 844);
    vi.stubGlobal('window', {
      visualViewport: { width: 390, height: 700, offsetTop: 60, offsetLeft: 0 },
    });

    expect(visibleViewport(element.ownerDocument).offsetTop).toBe(60);
  });

  it('没有 visualViewport 时回落到 documentElement（桌面 / 测试环境）', () => {
    const { element } = fakeElement(1280, 800);
    vi.stubGlobal('window', { visualViewport: undefined });

    expect(visibleViewport(element.ownerDocument)).toEqual({
      width: 1280,
      height: 800,
      offsetTop: 0,
      offsetLeft: 0,
    });
  });

  it('visualViewport 宽高为 0（键盘收起瞬间 / 隐藏）时不采用', () => {
    const { element } = fakeElement(390, 844);
    vi.stubGlobal('window', {
      visualViewport: { width: 0, height: 0, offsetTop: 0, offsetLeft: 0 },
    });

    // 回落，避免算出 0×0 把画面压没
    expect(visibleViewport(element.ownerDocument).width).toBe(390);
  });
});

describe('applyRotate 在 iOS 工具栏场景下', () => {
  it('按可见区而非布局视口算尺寸（回归：底部被工具栏盖住）', () => {
    const { element, style } = fakeElement(390, 844);
    // iPhone 14 Safari：布局 844，可见 700（地址栏+工具栏吃掉 144）
    vi.stubGlobal('window', {
      visualViewport: { width: 390, height: 700, offsetTop: 0, offsetLeft: 0 },
    });

    applyRotate({ element });

    // 旋转后视觉宽 = 可见区高 700（不是 844）
    expect(style.width).toBe('700px');
    expect(style.height).toBe('390px');
    expect(style.transform).toBe('rotate(90deg) translate(0, -390px)');
  });

  it('用 top/left 补偿视觉视口偏移，并清掉 inset 的四向钉死', () => {
    const { element, style } = fakeElement(390, 844);
    vi.stubGlobal('window', {
      visualViewport: { width: 390, height: 700, offsetTop: 60, offsetLeft: 0 },
    });

    applyRotate({ element });

    expect(style.top).toBe('60px');
    expect(style.left).toBe('0px');
    // inset 会覆盖 top/left，必须设成 auto
    expect(style.inset).toBe('auto');
  });

  it('先清 inset 再设 top/left（回归：简写属性冲掉定位）', () => {
    // inset 是 top/right/bottom/left 的简写。若在 top/left 之后赋值，
    // 会把它们重置为 auto，元素退回静态位置（实测 top:73px left:16px，画面全偏）。
    const { element, style } = fakeElement(390, 844);
    vi.stubGlobal('window', {
      visualViewport: { width: 390, height: 700, offsetTop: 60, offsetLeft: 0 },
    });

    // 用一个会记录赋值顺序的 style 代理，模拟真实 CSSOM 的简写行为
    const order: string[] = [];
    const proxy = new Proxy(style, {
      set(t, k: string, v: string) {
        order.push(k);
        // 真实浏览器里 inset='auto' 会把 top/left 一起复位
        if (k === 'inset' && v === 'auto') {
          t.top = '';
          t.left = '';
        }
        t[k] = v;
        return true;
      },
    });
    (element as unknown as { style: CSSStyleDeclaration }).style = proxy as unknown as CSSStyleDeclaration;

    applyRotate({ element });

    expect(order.indexOf('inset')).toBeLessThan(order.indexOf('top'));
    expect(style.top).toBe('60px');
    expect(style.left).toBe('0px');
  });

  it('clearRotate 把 top/left/inset 都清干净', () => {
    const { element, style } = fakeElement(390, 844);
    vi.stubGlobal('window', {
      visualViewport: { width: 390, height: 700, offsetTop: 60, offsetLeft: 0 },
    });

    applyRotate({ element });
    clearRotate({ element });

    expect(style.top).toBe('');
    expect(style.left).toBe('');
    expect(style.inset).toBe('');
  });
});

describe('isIOS / isStandalone / rotateHintOnIOS', () => {
  it('识别 iPhone / iPad UA', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    expect(isIOS()).toBe(true);

    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    expect(isIOS()).toBe(false);
  });

  it('iPadOS 13+ 伪装成 Mac 时靠多点触控识别', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 });
    expect(isIOS()).toBe(true);

    // 真 Mac 没有多点触控
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 });
    expect(isIOS()).toBe(false);
  });

  it('识别 PWA 独立窗口（navigator.standalone 与 display-mode 两条路）', () => {
    vi.stubGlobal('window', { navigator: { standalone: true } });
    expect(isStandalone()).toBe(true);

    vi.stubGlobal('window', {
      navigator: {},
      matchMedia: (q: string) => ({ matches: q.includes('standalone') }),
    });
    expect(isStandalone()).toBe(true);

    vi.stubGlobal('window', { navigator: {}, matchMedia: () => ({ matches: false }) });
    expect(isStandalone()).toBe(false);
  });

  it('iOS Safari 下提示语如实说明工具栏去不掉', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    vi.stubGlobal('window', { navigator: { standalone: false }, matchMedia: () => ({ matches: false }) });

    expect(rotateHintOnIOS()).toContain('全屏');
  });

  it('已装成 PWA 时不再多嘴（本来就没有工具栏）', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' });
    vi.stubGlobal('window', { navigator: { standalone: true } });

    expect(rotateHintOnIOS()).toBe('横屏');
  });

  it('非 iOS 用普通提示', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 13)' });
    expect(rotateHintOnIOS()).toBe('横屏');
  });
});

describe('rotatedSeekRatio：旋转态进度条纵向换算', () => {
  /**
   * 旋转后进度条是竖条（实测视觉尺寸 26×824），而 ArtPlayer 仍用
   * clientX / 未变换的 clientWidth(824) 换算，纵向点击时 clientX 恒定，
   * 比例恒为 0 —— 这就是「点进度条总跳回开头」的根因。
   * 实测 60s 片源：修复前点 25/50/75% 全部落到约 1.4s。
   */
  const rect = { top: 10, height: 800 };

  it('顶部对应 0，底部对应 1', () => {
    expect(rotatedSeekRatio(10, rect)).toBe(0);
    expect(rotatedSeekRatio(810, rect)).toBe(1);
  });

  it('中点对应 0.5', () => {
    expect(rotatedSeekRatio(410, rect)).toBeCloseTo(0.5, 6);
  });

  it('25% / 75% 按纵向线性插值', () => {
    expect(rotatedSeekRatio(210, rect)).toBeCloseTo(0.25, 6);
    expect(rotatedSeekRatio(610, rect)).toBeCloseTo(0.75, 6);
  });

  it('落在进度条之外时夹到 [0,1]，避免 seek 越界', () => {
    expect(rotatedSeekRatio(-500, rect)).toBe(0);
    expect(rotatedSeekRatio(5000, rect)).toBe(1);
  });

  it('高度为 0 时返回 0 而不是 NaN/Infinity', () => {
    // 进度条未布局完成时 rect.height 可能是 0，除零会得到 Infinity，
    // 进而 currentTime = Infinity 触发 video 报错
    expect(rotatedSeekRatio(100, { top: 0, height: 0 })).toBe(0);
  });
});
