import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: {
    default: 'LibreTV - 免费在线视频搜索与观看平台',
    template: '%s - LibreTV',
  },
  description:
    'LibreTV 是一个免费的在线视频搜索平台，无广告、安全，提供来自多个视频源的内容搜索与观看服务，无需注册即可使用。',
  manifest: '/manifest.webmanifest',
  // 图标与门户站（LibreTV-portal）同一套：同一张 artwork 导出的多尺寸 + 根目录 favicon.ico 兜底。
  // 只声明单张 512 时，抓取端只能拿大图缩放，小尺寸下易糊、看起来「没填满」。
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48' },
      { url: '/icons/icon-96.png', sizes: '96x96', type: 'image/png' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  // iOS「添加到主屏幕」相关声明。
  // 注意：iOS 不读 manifest 里的 display/theme_color，只看这几个 meta。
  // 不加 appleWebApp.capable 的话，从主屏打开仍是普通 Safari 窗口（带地址栏），
  // 手动旋转就白白被工具栏吃掉一块。
  appleWebApp: {
    capable: true,
    title: 'LibreTV',
    // black-translucent：状态栏透明、内容延伸到状态栏下面。
    // 配合全局 safe-area 内边距，观看时才真正满屏（其它两个值会留一条不透明状态栏）。
    statusBarStyle: 'black-translucent',
  },
  // formatDetection：iOS 会自动把疑似电话号码的文本变成蓝色链接，
  // 片名/演员里出现数字串时很碍眼
  formatDetection: { telephone: false },
  // Next 15 的 appleWebApp.capable 只会输出新标准的 mobile-web-app-capable。
  // iOS Safari（包括当前的 17/18）认的仍然是 apple-mobile-web-app-capable，
  // 缺了它「添加到主屏」打开后依旧是带地址栏的普通窗口，旋转照样被工具栏吃一块。
  // 两个并存是因为新标准正在推广，老 iOS 量还很大。
  other: {
    'apple-mobile-web-app-capable': 'yes',
  },
};

export const viewport: Viewport = {
  themeColor: '#0b101a',
  width: 'device-width',
  initialScale: 1,
  // viewport-fit=cover：让页面延伸到刘海/圆角区域，配合 env(safe-area-inset-*)
  // 才能把手动旋转后的画面用满整块屏幕。默认（contain）下 iOS 会给页面加内边距，
  // 旋转 90° 后那个内边距会变成左右黑边。
  //
  // 注意：这个值必须配上 globals.css 里的 safe-area 规则才有意义。
  // 只声明 cover 而不消费 env()，内容会钻到刘海和 Home 指示条下面，
  // 比不声明更糟（顶栏图标被遮、底部按钮点不到）。
  viewportFit: 'cover',
  // maximumScale 不限制：用户放大页面是无障碍需求，锁死不礼貌也没必要
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/* 首屏前同步主题，避免亮暗闪烁 */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('libretv-theme')||'dark';var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);}catch(e){}})()",
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
