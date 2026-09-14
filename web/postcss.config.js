import { join } from 'node:path';

export default {
  plugins: {
    tailwindcss: { config: join(import.meta.dirname, 'tailwind.config.js') },
    autoprefixer: {}
  }
};
