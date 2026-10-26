import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Тести запускаються всередині локального середовища Workers (Miniflare) з
// справжньою D1 у пам'яті; міграції застосовуються перед кожним файлом тестів.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, 'migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        remoteBindings: false,
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            TELEGRAM_BOT_TOKEN: 'TEST_TOKEN',
            WEBHOOK_SECRET: 'test_secret_0123456789',
            TELEGRAM_API_BASE: 'https://telegram.test',
            GROQ_API_KEY: 'test-groq-key',
            GROQ_BASE_URL: 'https://groq.test/openai/v1',
            AI_PROVIDERS: 'groq',
            GROQ_MODELS: 'test-model',
          },
        },
      }),
    ],
    test: {
      setupFiles: ['./test/setup.ts'],
      include: ['test/**/*.test.ts'],
    },
  };
});
