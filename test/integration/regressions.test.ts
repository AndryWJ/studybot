/**
 * Регресійні сценарії: подвійні натискання, питання,
 * що починаються зі слова "нагадай" (і коли ШІ недоступний), заміна плану з тими самими предметами,
 * дублікати занять, ліміт ШІ за UTC.
 */

import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleUpdate } from '../../src/bot/router';
import { callbackUpdate, kyiv, mockFetch, textUpdate, type FetchMock } from '../helpers';

const BASE = 'https://bot.test';
const NOW = kyiv(2026, 10, 26, 18, 0);

let tg: FetchMock;
beforeEach(() => {
  tg = mockFetch();
});
afterEach(() => tg.restore());

const say = (text: string, uid: number, now = NOW) => handleUpdate(env, textUpdate(text, uid), BASE, now);
const press = (data: string, uid: number, now = NOW) => handleUpdate(env, callbackUpdate(data, uid), BASE, now);
const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

describe('double taps', () => {
  it('saves an AI schedule only once when sch:save arrives twice at the same time', async () => {
    const U = 5001;
    tg.setAi(() => JSON.stringify({ weekly: [{ day: 1, start: '16:00', end: '17:00', title: 'Математика' }], comment: '' }));
    await press('sch:ai', U);
    await say('мій тиждень', U);
    await Promise.all([press('sch:save', U), press('sch:save', U)]);
    expect(await count('SELECT COUNT(*) AS n FROM lessons WHERE user_id = ?', U)).toBe(1);
  });

  it('records the timer once when Stop is pressed twice', async () => {
    const U = 5002;
    await say('/timer Фізика', U, NOW);
    await Promise.all([press('tm:stop', U, NOW + 1800), press('tm:stop', U, NOW + 1800)]);
    expect(await count('SELECT COUNT(*) AS n FROM study_log WHERE user_id = ?', U)).toBe(1);
  });

  it('does not add the same lessons twice when the timetable is resent', async () => {
    const U = 5003;
    for (let i = 0; i < 2; i++) {
      await press('sch:add', U);
      await say('пн 08:30 Математика', U);
    }
    expect(await count('SELECT COUNT(*) AS n FROM lessons WHERE user_id = ?', U)).toBe(1);
    expect(tg.sent().at(-1)).toContain('уже були в розкладі');
  });
});

describe('questions that start with "нагадай"', () => {
  it('answers with the tutor when there is no date in the text', async () => {
    const U = 5004;
    tg.setAi((body) => (body.response_format ? JSON.stringify({ title: 'Інтеграл', date: null, time: null }) : 'Інтеграл це площа під графіком.'));
    await say('Нагадай, що таке інтеграл', U);
    expect(await count('SELECT COUNT(*) AS n FROM deadlines WHERE user_id = ?', U)).toBe(0);
    expect(tg.sent().at(-1)).toContain('площа під графіком');
  });

  it('sends one error and asks the AI once when the AI fails', async () => {
    const U = 5007;
    tg.setAi(() => new Response('boom', { status: 500 }));
    await say('нагадай що таке інтеграл', U);
    expect(tg.aiRequests).toHaveLength(1);
    expect(tg.sent().filter((t) => t.includes('ШІ зараз не відповідає'))).toHaveLength(1);
  });

  it('sends one limit message when the daily AI limit is used up', async () => {
    const U = 5008;
    const limited = { ...env, AI_DAILY_LIMIT: '1' };
    await handleUpdate(limited, textUpdate('Питання раз', U), BASE, NOW);
    await handleUpdate(limited, textUpdate('нагадай що таке інтеграл', U), BASE, NOW);
    expect(tg.aiRequests).toHaveLength(1);
    expect(tg.sent().filter((t) => t.includes('ліміт запитів до ШІ вичерпано'))).toHaveLength(1);
  });

  it('explains the date format instead of "no date found" when the AI fails while adding a deadline', async () => {
    const U = 5009;
    tg.setAi(() => new Response('boom', { status: 500 }));
    await say('/add', U);
    await say('реферат колись', U);
    const sent = tg.sent();
    expect(sent.at(-2)).toContain('ШІ зараз не відповідає');
    expect(sent.at(-1)).toContain('Без ШІ я розумію дату');
    expect(sent.some((t) => t.includes('Не знайшов дату'))).toBe(false);
  });
});

describe('plan replacement', () => {
  async function makePlan(U: number, now: number) {
    await press('pl:k:exam', U, now);
    await say('Фізика 25.11\nХімія 30.11', U, now);
    await press('pl:r:ok', U, now);
    await say('10', U, now);
    await press('pl:save', U, now);
  }

  it('replaces the old plan with the same subjects and does not duplicate exam deadlines', async () => {
    const U = 5005;
    await makePlan(U, NOW);
    await makePlan(U, NOW + 3600);
    expect(await count("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND kind = 'plan'", U)).toBe(1);
    expect(await count('SELECT COUNT(*) AS n FROM deadlines WHERE user_id = ?', U)).toBe(2);
    expect(await count('SELECT COALESCE(SUM(minutes), 0) AS n FROM steps WHERE user_id = ?', U)).toBe(600);
    expect(tg.sent().some((t) => t.includes('Попередній план із тими самими предметами замінено'))).toBe(true);
  });
});

describe('AI daily limit', () => {
  it('counts the limit per UTC day, so changing the time zone does not reset it', async () => {
    const U = 5006;
    const limited = { ...env, AI_DAILY_LIMIT: '1' };
    await handleUpdate(limited, textUpdate('Питання раз', U), BASE, NOW);
    await handleUpdate(limited, textUpdate('/settings', U), BASE, NOW);
    await env.DB.prepare("UPDATE users SET tz = 'Pacific/Kiritimati' WHERE id = ?").bind(U).run();
    await handleUpdate(limited, textUpdate('Питання два', U), BASE, NOW);
    expect(tg.aiRequests).toHaveLength(1);
    expect(tg.sent().at(-1)).toContain('ліміт запитів до ШІ вичерпано');
  });
});
