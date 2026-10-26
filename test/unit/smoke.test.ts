/** Перевірка, що тестове середовище піднялося: D1 із міграціями й підтримка часових поясів у workerd. */

import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { localParts } from '../../src/time';

describe('smoke', () => {
  it('has D1 with migrated tables', async () => {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    expect(row?.n).toBe(0);
  });
  it('knows Europe/Kyiv in workerd', () => {
    const p = localParts(Date.UTC(2026, 6, 1, 9, 0) / 1000, 'Europe/Kyiv');
    expect(p.hour).toBe(12);
  });
});
