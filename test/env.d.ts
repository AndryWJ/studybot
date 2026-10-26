/** Типи оточення для тестів: Cloudflare.Env доповнюється полями AppEnv і міграціями (TEST_MIGRATIONS з vitest.config.ts). */

import type { D1Migration } from '@cloudflare/vitest-plugin';
import type { AppEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
