/** Наскрізні сценарії: оновлення Telegram проходять через handleUpdate з підміненим fetch (test/helpers.ts) і справжньою D1 у пам'яті. */

import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleUpdate } from '../../src/bot/router';
import { findButton, kyiv, mockFetch, textUpdate, type FetchMock } from '../helpers';

let tg: FetchMock;
const NOW = kyiv(2026, 10, 26, 18, 0); // понеділок, 18:00 за Києвом (вже зимовий час)

beforeEach(() => {
  tg = mockFetch();
});
afterEach(() => tg.restore());

describe('start and deadlines', () => {
  it('greets a new user and stores them', async () => {
    await handleUpdate(env, textUpdate('/start'), 'https://bot.test', NOW);
    expect(tg.sent()[0]).toContain('Привіт, Оля');
    const user = await env.DB.prepare('SELECT * FROM users WHERE id = 1001').first<{ tz: string; next_digest_at: number }>();
    expect(user?.tz).toBe('Europe/Kyiv');
    expect(user?.next_digest_at).toBe(kyiv(2026, 10, 27, 7, 30));
  });

  it('adds a deadline from free text with reminders, no AI involved', async () => {
    await handleUpdate(env, textUpdate('нагадай здати реферат з біології в четвер о 10'), 'https://bot.test', NOW);
    const text = tg.sent().at(-1)!;
    expect(text).toContain('Здати реферат з біології');
    expect(tg.aiRequests).toHaveLength(0);
    const d = await env.DB.prepare('SELECT * FROM deadlines WHERE user_id = 1001').first<{ id: number; due_at: number; all_day: number }>();
    expect(d?.due_at).toBe(kyiv(2026, 10, 29, 10, 0));
    const reminders = await env.DB.prepare('SELECT remind_at FROM reminders WHERE deadline_id = ? ORDER BY remind_at').bind(d!.id).all<{ remind_at: number }>();
    expect(reminders.results.map((r) => r.remind_at)).toEqual([kyiv(2026, 10, 28, 10, 0), kyiv(2026, 10, 29, 8, 0), kyiv(2026, 10, 29, 10, 0)]);
    expect(findButton(tg.last('sendMessage'), 'висока')).toBe(`dl:i:${d!.id}:3`);
  });
});
