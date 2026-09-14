import 'dotenv/config';
import { resolve as resolvePath } from 'node:path';
import { createStoragePool, resolveDatabaseUrl } from '../storage/client.js';
import { readAuthConfig, validateAuthConfig } from '../storage/auth.js';
import { buildApiServer } from './server.js';

/**
 * API 服务入口（实施计划第 8.2 节 `src/api/`）。
 *
 * 启动前必须通过访问凭据校验（Q86：访问密钥与管理员密码不能相同）；
 * 数据库不可用时不阻止进程启动，但接口会如实返回 5xx（F11），
 * 登录时会重试同步凭据（见 server.ts）。
 */

const port = Number(process.env.PORT ?? 3080);
const host = process.env.HOST ?? '0.0.0.0';
const databaseUrl = resolveDatabaseUrl();

if (!databaseUrl) {
  console.error('缺少 DATABASE_URL，API 服务无法启动。');
  process.exit(1);
}

const authConfig = readAuthConfig();
const validation = validateAuthConfig(authConfig);
if (!validation.ok) {
  console.error(`访问凭据配置无效：${validation.errors.join('；')}`);
  process.exit(1);
}
for (const warning of validation.warnings) console.warn(`凭据配置提示：${warning}`);

// 自签证书 HTTPS 由前置代理承担（Q13、Q22）；这里只提供同域 HTTP 服务。
// 启用 Secure Cookie 的部署应在反代终止 TLS 并用 COOKIE_SECURE=true 告知本服务。
const cookieSecure = process.env.COOKIE_SECURE === 'true';
const webRoot = process.env.WEB_ROOT ?? resolvePath(process.cwd(), 'web', 'dist');

const pool = createStoragePool({ connectionString: databaseUrl, max: Number(process.env.DB_POOL_MAX ?? 10) });

const app = await buildApiServer({
  pool,
  authConfig,
  cookieSecure,
  requireSecondConfirmation: process.env.REQUIRE_CONFIRMATION !== 'false',
  webRoot,
  logger: process.env.LOG_LEVEL !== 'silent',
});

try {
  await app.listen({ port, host });
  console.info(`API 服务已启动：http://${host}:${port}（静态目录 ${webRoot}，Secure Cookie ${cookieSecure}）`);
} catch (error) {
  console.error(`启动失败：${error instanceof Error ? error.message : String(error)}`);
  await pool.close();
  process.exit(1);
}

// 优雅退出：先停止接收新请求，再关闭连接池。
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      console.info(`收到 ${signal}，正在退出…`);
      await app.close();
      await pool.close();
      process.exit(0);
    })();
  });
}
