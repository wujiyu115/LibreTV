/**
 * 手动横竖屏切换。
 *
 * 为什么不用 ArtPlayer 内置的 autoOrientation：它依赖 `screen.orientation.lock()`，
 * 而 iOS Safari / 多数移动浏览器根本不支持该 API（只支持 `unlock` 的部分语义），
 * 因此内置能力在 iPhone 上完全无效。这里用「CSS transform 旋转 + 尺寸对调」实现，
 * 不依赖任何系统 API，iOS / Android / 桌面全平台一致。
 *
 * 之所以需要这个按钮：移动端浏览器自身不做方向锁定，但很多用户开了系统方向锁，
 * 此时播放器只会在竖屏的 aspect-video 小窗里显示。手动按钮让用户不必去关系统锁。
 */

export type RotateState = 'normal' | 'rotated';

/** 旋转后的容器上打的标记 class，便于样式与测试定位 */
export const ROTATE_CLASS = 'ltv-rotate';

/** 各旋转阶段用到的内联样式键，退出时按这些键清空 */
const ROTATE_STYLE_KEYS = [
  'position',
  'inset',
  'zIndex',
  'width',
  'height',
  'transformOrigin',
  'transform',
  'maxWidth',
  'maxHeight',
  'margin',
] as const;

export interface RotateTarget {
  /** 播放器容器（将被旋转的元素） */
  element: HTMLElement;
  /** 旋转期间需要禁掉页面滚动，避免背景跟着滑 */
  body?: HTMLElement | null;
}

/**
 * 把容器旋转 90° 铺满视口（模拟横屏）。
 *
 * 实现要点：宽高互换后以左上角为原点 rotate(90deg)，再向上平移一个「旋转后高度」
 * （即视口宽度），旋转后的矩形才正好覆盖视口。这是 CSS 旋转中唯一不依赖
 * transform-origin 计算差异的写法，各浏览器表现一致。
 */
export function applyRotate({ element, body }: RotateTarget): void {
  const vw = element.ownerDocument.documentElement.clientWidth;
  const vh = element.ownerDocument.documentElement.clientHeight;

  element.classList.add(ROTATE_CLASS);
  element.style.position = 'fixed';
  element.style.inset = '0';
  element.style.zIndex = '9999';
  element.style.width = `${vh}px`;
  element.style.height = `${vw}px`;
  element.style.maxWidth = 'none';
  element.style.maxHeight = 'none';
  element.style.margin = '0';
  element.style.transformOrigin = '0 0';
  element.style.transform = `rotate(90deg) translate(0, -${vw}px)`;

  if (body) {
    body.style.overflow = 'hidden';
    body.dataset.ltvRotate = '1';
  }
}

/** 撤销 rotate 造成的全部样式，恢复到原来的内联状态 */
export function clearRotate({ element, body }: RotateTarget): void {
  element.classList.remove(ROTATE_CLASS);
  for (const key of ROTATE_STYLE_KEYS) element.style[key] = '';

  if (body) {
    body.style.overflow = '';
    delete body.dataset.ltvRotate;
  }
}

/**
 * 计算手动旋转下的尺寸。
 * 抽出来是为了能单测：rotate(90deg) 之后视觉上的「宽」是元素 CSS 高度，
 * 一旦把 vw/vh 写反，画面会只占半屏——这是这类实现最常见的 bug。
 */
export function computeRotateSize(viewportWidth: number, viewportHeight: number): {
  width: number;
  height: number;
  translateY: number;
} {
  return {
    // 旋转前容器按「视口高度」宽、「视口宽度」高，转 90° 后正好铺满
    width: viewportHeight,
    height: viewportWidth,
    translateY: viewportWidth,
  };
}
