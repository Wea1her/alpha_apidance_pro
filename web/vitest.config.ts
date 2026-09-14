import { defineConfig } from 'vitest/config';

/**
 * 前端逻辑测试：只覆盖纯函数与状态工具（web/src/state.ts、api.ts 的纯部分），
 * 不引入 jsdom——组件渲染由真实页面验证覆盖，避免为测试引入额外依赖。
 */
export default defineConfig({
  root: __dirname,
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
});
