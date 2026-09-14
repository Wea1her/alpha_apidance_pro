import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', '.codex/**'],
    // 存储层测试共用同一个 PostgreSQL 实例并在 beforeAll 里重建 schema，
    // 因此文件级必须串行，否则两个文件会互相 DROP/CREATE 同一个 schema。
    fileParallelism: false
  }
});
