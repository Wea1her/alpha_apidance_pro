import { join } from 'node:path';

/**
 * Tailwind 配置（Q21：Tailwind + 少量手写组件，桌面优先、信息密度优先）。
 *
 * 颜色令牌对齐参照站的浅/深两套变量（见 docs/architecture/reference-alpha-portal.md），
 * 用 CSS 变量承载，主题切换只改 html[data-theme]，组件类名不随主题变化。
 * content 用绝对路径：配置从仓库根目录调用时也能正确扫描源码。
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: [join(import.meta.dirname, 'index.html'), join(import.meta.dirname, 'src/**/*.{ts,tsx}')],
  theme: {
    extend: {
      colors: {
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        'surface-soft': 'var(--surface-soft)',
        ink: 'var(--ink)',
        muted: 'var(--muted)',
        line: 'var(--line)',
        accent: 'var(--accent)',
        'accent-soft': 'var(--accent-soft)',
        discover: 'var(--discover)',
        'discover-soft': 'var(--discover-soft)',
        alert: 'var(--alert)',
        'alert-soft': 'var(--alert-soft)'
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace']
      },
      fontSize: {
        '2xs': ['11px', '15px']
      }
    }
  },
  plugins: []
};
