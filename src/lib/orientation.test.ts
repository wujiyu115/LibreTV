import { describe, expect, it } from 'vitest';
import {
  ROTATE_CLASS,
  applyRotate,
  clearRotate,
  computeRotateSize,
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
