import 'dotenv/config';
import { parseServiceConfig } from './config.js';
import { startAlphaService } from './service.js';

const config = parseServiceConfig(process.env);

await startAlphaService({ config });

console.log('alpha 共同关注推送服务已启动');
