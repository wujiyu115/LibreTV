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
  'top',
  'left',
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
 * 取「真正可见」的视口尺寸与偏移。
 *
 * 关键：iOS Safari 上 documentElement.clientHeight 是**布局视口**高度，
 * 不随地址栏/工具栏显隐变化，比可见区高出一截（iPhone 上通常多 100~150px）。
 * 用它算旋转尺寸时，画面底部会被地址栏压住——这就是 iOS 上「旋转了但底下
 * 被工具栏盖掉」的根因。visualViewport 给的才是真正能看到的那块。
 *
 * offsetTop/offsetLeft：iOS 上视觉视口还能相对布局视口偏移（工具栏、缩放），
 * position:fixed 是相对布局视口定位的，不补偿偏移就会整体错位。
 */
export interface ViewportBox {
  width: number;
  height: number;
  offsetTop: number;
  offsetLeft: number;
}

export function visibleViewport(doc?: Document): ViewportBox {
  const d = doc ?? (typeof document === 'undefined' ? null : document);
  // visualViewport 在 iOS 13+ / Chrome 61+ 都有；测试环境与极老浏览器回落到布局视口
  const vv =
    typeof window !== 'undefined'
      ? (window.visualViewport as VisualViewport | null | undefined)
      : null;
  if (vv && vv.width > 0 && vv.height > 0) {
    return {
      width: vv.width,
      height: vv.height,
      offsetTop: vv.offsetTop,
      offsetLeft: vv.offsetLeft,
    };
  }
  const de = d?.documentElement;
  return {
    width: de?.clientWidth ?? 0,
    height: de?.clientHeight ?? 0,
    offsetTop: 0,
    offsetLeft: 0,
  };
}

/**
 * 把容器旋转 90° 铺满**可见**视口（模拟横屏）。
 *
 * 实现要点：宽高互换后以左上角为原点 rotate(90deg)，再向上平移一个「旋转后高度」
 * （即视口宽度），旋转后的矩形才正好覆盖视口。这是 CSS 旋转中唯一不依赖
 * transform-origin 计算差异的写法，各浏览器表现一致。
 *
 * 尺寸取自 visibleViewport（而非 documentElement）：iOS 上后者含被地址栏遮住的区域。
 */
export function applyRotate({ element, body }: RotateTarget): void {
  const doc = element.ownerDocument;
  const { width: vw, height: vh, offsetTop, offsetLeft } = visibleViewport(doc);
  const { width, height, translateY } = computeRotateSize(vw, vh);

  element.classList.add(ROTATE_CLASS);
  element.style.position = 'fixed';
  // 先清 inset 再设 top/left：inset 是 top/right/bottom/left 的简写，
  // 放在后面会把刚设好的 top/left 冲回 auto，浏览器就退回元素的静态位置
  // （实测 iPhone 尺寸下会变成 top:73px left:16px，画面全偏）。
  element.style.inset = 'auto';
  // 用 top/left 而不是四向 inset：需要按视觉视口偏移补偿，
  // 四向 inset 会把元素钉在布局视口四角，工具栏一出来就偏
  element.style.top = `${offsetTop}px`;
  element.style.left = `${offsetLeft}px`;
  element.style.zIndex = '9999';
  element.style.width = `${width}px`;
  element.style.height = `${height}px`;
  element.style.maxWidth = 'none';
  element.style.maxHeight = 'none';
  element.style.margin = '0';
  element.style.transformOrigin = '0 0';
  element.style.transform = `rotate(90deg) translate(0, -${translateY}px)`;

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

/** iOS / iPadOS 判定（含 iPadOS 13+ 伪装成 Mac 的情况） */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  // iPadOS 13+ 默认发桌面 UA，靠触摸点数区分：Mac 没有多点触控
  return /Macintosh/.test(ua) && typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 1;
}

/** 是否处于 PWA 独立窗口（iOS 上添加到主屏后没有地址栏） */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // iOS 用 navigator.standalone，其它平台用 display-mode 媒体查询
  const nav = window.navigator as Navigator & { standalone?: boolean };
  if (nav.standalone) return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
}

/**
 * 手动旋转在 iOS Safari 上的实际能力边界。
 *
 * iOS 的地址栏/底部工具栏**只能**通过原生视频全屏（video.webkitEnterFullscreen）
 * 或添加到主屏的 PWA 窗口去掉；纯 CSS 的 position:fixed + transform 无论怎么调，
 * 都仍然是「网页」，工具栏会一直占着那几十像素。这不是实现缺陷，是平台限制。
 *
 * 因此这里返回一句如实的话术，让用户在知情的前提下选择：
 * 手动旋转看着有工具栏 → 换成播放器自带的完整全屏按钮就干净了。
 */
export function rotateHintOnIOS(): string {
  return isIOS() && !isStandalone() ? '横屏（iOS 全屏可隐藏工具栏）' : '横屏';
}
