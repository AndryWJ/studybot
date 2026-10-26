/** Виконується перед кожним файлом тестів: застосовує міграції з migrations/ до D1 у пам'яті. */

import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
