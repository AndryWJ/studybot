/**
 * Наскрізні тести фонової роботи й оболонки бота: Cron (нагадування, ранкові зведення,
 * нагадування про заняття, заблоковані користувачі), HTTP-маршрути Worker-а, групові чати,
 * обмеження ALLOWED_USERS і поведінка при недоступному ШІ та денному ліміті.
 *
 * Cron-тести працюють із чистою базою: runCron обробляє всіх користувачів одразу.
 */

import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../../src/bot/router';
import { runCron } from '../../src/cron';
import { Db, type User } from '../../src/db';
import type { AppEnv } from '../../src/env';
import worker from '../../src/index';
import type { TgUpdate } from '../../src/telegram';
import { localParts } from '../../src/time';
import { callbackUpdate, findButton, kyiv, mockFetch, textUpdate, type FetchMock } from '../helpers';

const BASE = 'https://bot.test';
const NOW = kyiv(2026, 10, 26, 18, 0); // понеділок, 18:00 за Києвом, зимовий час
const SECRET = 'test_secret_0123456789';

let tg: FetchMock;

beforeEach(() => {
  tg = mockFetch();
});
afterEach(() => tg.restore());

const utc = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
const say = (text: string, uid: number, now = NOW, e: AppEnv = env) => handleUpdate(e, textUpdate(text, uid), BASE, now);
const press = (data: string, uid: number, now = NOW, e: AppEnv = env) => handleUpdate(e, callbackUpdate(data, uid, 555), BASE, now);

async function one<T>(sql: string, ...binds: unknown[]): Promise<T | null> {
  return env.DB.prepare(sql).bind(...binds).first<T>();
}

async function all<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...binds).all<T>()).results;
}

const lastText = () => tg.sent().at(-1) ?? '';
const messagesTo = (chatId: number) => tg.calls.filter((c) => c.method === 'sendMessage' && c.params.chat_id === chatId);
const userRow = async (uid: number) => (await one<User>('SELECT * FROM users WHERE id = ?', uid))!;
const aiCount = async (uid: number) => (await one<{ ai_count: number }>('SELECT ai_count FROM users WHERE id = ?', uid))?.ai_count ?? 0;

async function resetDb(): Promise<void> {
  const tables = ['reminders', 'steps', 'tasks', 'deadlines', 'lessons', 'quizzes', 'study_log', 'grades', 'users', 'meta'];
  await env.DB.batch(tables.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
}

/** Створює користувача напряму в базі; ранкове зведення вимкнене, якщо не задано інакше. */
async function mkUser(id: number, fields: Partial<Omit<User, 'id'>> = {}): Promise<void> {
  const db = new Db(env.DB);
  await db.upsertUser(id, 'Оля', NOW, 'Europe/Kyiv', 0);
  await db.updateUser(id, { digest_min: null, next_digest_at: null, ...fields });
}

/** Підміняє відповідь Telegram на sendMessage для одного чату помилкою Bot API. */
function failSendsTo(chatId: number, code: number, description: string, parameters?: Record<string, unknown>): void {
  const fetchMock = vi.mocked(globalThis.fetch);
  const previous = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/sendMessage') && JSON.parse(String(init?.body)).chat_id === chatId) {
      return Response.json({ ok: false, error_code: code, description, parameters });
    }
    return previous(input, init);
  });
}

describe('cron reminders', () => {
  beforeEach(resetDb);

  const T = kyiv(2026, 10, 27, 10, 0);
  const DUE = kyiv(2026, 10, 28, 10, 0);

  async function deadlineWithReminders(uid: number, reminders: number[], title = 'Здати звіт', due = DUE): Promise<number> {
    await mkUser(uid);
    return new Db(env.DB).addDeadline(uid, title, due, false, reminders, NOW);
  }
  const sentFlags = (deadlineId: number) => all<{ sent: number }>('SELECT sent FROM reminders WHERE deadline_id = ? ORDER BY remind_at', deadlineId).then((r) => r.map((x) => x.sent));

  it('sends a due reminder once and marks it sent', async () => {
    const id = await deadlineWithReminders(3001, [T, DUE - 2 * 3600, DUE]);
    await runCron(env, T + 30);

    const sent = messagesTo(3001);
    expect(sent).toHaveLength(1);
    expect(String(sent[0].params.text)).toContain('Нагадування');
    expect(String(sent[0].params.text)).toContain('Здати звіт');
    expect(findButton(sent[0], 'Виконано')).toBe(`dl:ok:${id}`);
    expect(findButton(sent[0], 'Розбити')).toBe(`dl:sp:${id}`);
    expect(await sentFlags(id)).toEqual([1, 0, 0]);

    await runCron(env, T + 90);
    expect(messagesTo(3001)).toHaveLength(1);

    await runCron(env, DUE - 2 * 3600 + 5);
    expect(messagesTo(3001)).toHaveLength(2);
    await runCron(env, DUE + 5);
    expect(messagesTo(3001)).toHaveLength(3);
    expect(String(messagesTo(3001)[2].params.text)).toContain('Настав час: <b>Здати звіт</b>');
    expect(await sentFlags(id)).toEqual([1, 1, 1]);
  });

  it('does not send a reminder before its time', async () => {
    const id = await deadlineWithReminders(3002, [T]);
    await runCron(env, T - 30);
    expect(messagesTo(3002)).toHaveLength(0);
    expect(await sentFlags(id)).toEqual([0]);
  });

  it('skips reminders that are more than 6 hours late without a message', async () => {
    const id = await deadlineWithReminders(3003, [T, T + 3600]);
    await runCron(env, T + 6 * 3600 + 1800);
    expect(messagesTo(3003)).toHaveLength(1);
    expect(await sentFlags(id)).toEqual([1, 1]);

    const stale = await deadlineWithReminders(3004, [T]);
    await runCron(env, T + 7 * 3600);
    expect(messagesTo(3004)).toHaveLength(0);
    expect(await sentFlags(stale)).toEqual([1]);
  });

  it('still sends a reminder exactly 6 hours late', async () => {
    await deadlineWithReminders(3005, [T]);
    await runCron(env, T + 6 * 3600);
    expect(messagesTo(3005)).toHaveLength(1);
  });

  it('sends nothing for a completed deadline and nothing to a blocked user', async () => {
    const done = await deadlineWithReminders(3006, [T]);
    await new Db(env.DB).setDeadlineDone(3006, done, NOW);
    await mkUser(3007, { blocked: 1 });
    const other = await new Db(env.DB).addDeadline(3007, 'Блок', DUE, false, [T], NOW);
    await runCron(env, T + 30);
    expect(messagesTo(3006)).toHaveLength(0);
    expect(messagesTo(3007)).toHaveLength(0);
    // Виконання дедлайну гасить його нагадування, а заблокованому користувачу нічого не йде.
    expect(await sentFlags(done)).toEqual([1]);
    expect(await sentFlags(other)).toEqual([0]);
  });

  it('sends at most 35 messages per run and carries the rest to the next minute', async () => {
    for (let i = 0; i < 40; i++) await deadlineWithReminders(3100 + i, [T]);
    await runCron(env, T + 30);
    expect(tg.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(35);
    await runCron(env, T + 90);
    expect(tg.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(40);
    const unsent = await one<{ n: number }>('SELECT COUNT(*) AS n FROM reminders WHERE sent = 0');
    expect(unsent!.n).toBe(0);
  });

  it('runs from the Worker scheduled handler', async () => {
    await deadlineWithReminders(3008, [T]);
    const ctx = createExecutionContext();
    await worker.scheduled({ scheduledTime: (T + 30) * 1000, cron: '* * * * *', type: 'scheduled', noRetry() {} } as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(messagesTo(3008)).toHaveLength(1);
  });

  it('removes sent reminders, old quizzes and long finished deadlines once a day', async () => {
    const db = new Db(env.DB);
    await mkUser(3009);
    const old = await db.addDeadline(3009, 'Давній', T - 100 * 86400, false, [T - 100 * 86400], NOW);
    await db.setDeadlineDone(3009, old, T - 100 * 86400);
    await db.markRemindersSent((await all<{ id: number }>('SELECT id FROM reminders WHERE deadline_id = ?', old)).map((r) => r.id));
    const taskId = await db.createTask(3009, 'Пов\'язане', 'split', old, [{ text: 'Крок', due_date: null }], NOW);
    await db.createQuiz(3009, 'Старий', [], T - 5 * 86400);
    await db.createQuiz(3009, 'Свіжий', [], T - 3600);
    const fresh = await db.addDeadline(3009, 'Свіжий дедлайн', DUE, false, [DUE], NOW);

    await runCron(env, T);
    expect(await one('SELECT id FROM deadlines WHERE id = ?', old)).toBeNull();
    expect(await one('SELECT id FROM deadlines WHERE id = ?', fresh)).not.toBeNull();
    expect(await one('SELECT deadline_id FROM tasks WHERE id = ?', taskId)).toEqual({ deadline_id: null });
    expect((await all<{ topic: string }>('SELECT topic FROM quizzes')).map((q) => q.topic)).toEqual(['Свіжий']);
  });
});

describe('cron morning digest', () => {
  beforeEach(resetDb);

  const T0 = kyiv(2026, 10, 27, 7, 30);

  it('sends the digest with content and advances next_digest_at by a day', async () => {
    const db = new Db(env.DB);
    await mkUser(3200, { digest_min: 450, next_digest_at: T0 });
    await db.addLessons(3200, [{ weekday: 2, start: 480, end: 525, title: 'Алгебра' }]);
    await db.addDeadline(3200, 'Лабораторна', kyiv(2026, 10, 29, 12, 0), false, [], NOW);
    await db.createTask(3200, 'Проєкт', 'split', null, [{ text: 'Написати вступ', minutes: 30, due_date: '2026-10-27' }], NOW);
    await db.addStudy(3200, 'Фізика', 60, '2026-10-26', NOW);

    await runCron(env, T0 + 60);
    const sent = messagesTo(3200);
    expect(sent).toHaveLength(1);
    const text = String(sent[0].params.text);
    expect(text).toContain('Доброго ранку');
    expect(text).toContain('Алгебра');
    expect(text).toContain('Лабораторна');
    expect(text).toContain('Написати вступ');
    expect(text).toContain('Учора на навчання пішло 1 год');
    expect((await userRow(3200)).next_digest_at).toBe(kyiv(2026, 10, 28, 7, 30));

    await runCron(env, T0 + 120);
    expect(messagesTo(3200)).toHaveLength(1);
  });

  it('sends nothing when there is no content but still advances next_digest_at', async () => {
    await mkUser(3201, { digest_min: 450, next_digest_at: T0 });
    await runCron(env, T0 + 60);
    expect(messagesTo(3201)).toHaveLength(0);
    expect((await userRow(3201)).next_digest_at).toBe(kyiv(2026, 10, 28, 7, 30));
  });

  it('skips a digest that is more than 2 hours late and advances next_digest_at', async () => {
    const db = new Db(env.DB);
    await mkUser(3202, { digest_min: 450, next_digest_at: T0 });
    await db.addLessons(3202, [{ weekday: 2, start: 480, end: null, title: 'Біологія' }]);
    await runCron(env, T0 + 3 * 3600);
    expect(messagesTo(3202)).toHaveLength(0);
    expect((await userRow(3202)).next_digest_at).toBe(kyiv(2026, 10, 28, 7, 30));
  });

  it('does not touch users whose digest is off, not yet due or blocked', async () => {
    const db = new Db(env.DB);
    await mkUser(3203);
    await mkUser(3204, { digest_min: 450, next_digest_at: T0 + 86400 });
    await mkUser(3205, { digest_min: 450, next_digest_at: T0, blocked: 1 });
    for (const id of [3203, 3204, 3205]) await db.addLessons(id, [{ weekday: 2, start: 480, end: null, title: 'Урок' }]);
    await runCron(env, T0 + 60);
    for (const id of [3203, 3204, 3205]) expect(messagesTo(id)).toHaveLength(0);
    expect((await userRow(3203)).next_digest_at).toBeNull();
    expect((await userRow(3204)).next_digest_at).toBe(T0 + 86400);
    expect((await userRow(3205)).next_digest_at).toBe(T0);
  });

  it('keeps 07:30 local time across the autumn DST change', async () => {
    const db = new Db(env.DB);
    await mkUser(3206, { digest_min: 450, next_digest_at: utc(2026, 10, 24, 4, 30) });
    await db.addLessons(3206, [
      { weekday: 6, start: 600, end: null, title: 'Субота' },
      { weekday: 7, start: 600, end: null, title: 'Неділя' },
    ]);

    await runCron(env, utc(2026, 10, 24, 4, 30, 30));
    expect(String(messagesTo(3206)[0].params.text)).toContain('субота, 24 жовтня');
    expect((await userRow(3206)).next_digest_at).toBe(utc(2026, 10, 25, 5, 30));

    await runCron(env, utc(2026, 10, 25, 5, 30, 30));
    expect(String(messagesTo(3206)[1].params.text)).toContain('неділя, 25 жовтня');
    expect((await userRow(3206)).next_digest_at).toBe(utc(2026, 10, 26, 5, 30));
  });

  it('keeps 07:30 local time across the spring DST change', async () => {
    const db = new Db(env.DB);
    await mkUser(3207, { digest_min: 450, next_digest_at: utc(2027, 3, 27, 5, 30) });
    await db.addLessons(3207, [
      { weekday: 6, start: 600, end: null, title: 'Субота' },
      { weekday: 7, start: 600, end: null, title: 'Неділя' },
    ]);

    await runCron(env, utc(2027, 3, 27, 5, 30, 30));
    expect((await userRow(3207)).next_digest_at).toBe(utc(2027, 3, 28, 4, 30));
    await runCron(env, utc(2027, 3, 28, 4, 30, 30));
    expect(String(messagesTo(3207)[1].params.text)).toContain('неділя, 28 березня');
    expect((await userRow(3207)).next_digest_at).toBe(utc(2027, 3, 29, 4, 30));
  });
});

describe('cron lesson reminders', () => {
  beforeEach(resetDb);

  it('reminds lesson_lead minutes before the start exactly once', async () => {
    const db = new Db(env.DB);
    await mkUser(3300, { lesson_lead: 15 });
    await db.addLessons(3300, [
      { weekday: 2, start: 600, end: 645, title: 'Фізика' },
      { weekday: 3, start: 600, end: null, title: 'Хімія' },
    ]);

    await runCron(env, kyiv(2026, 10, 27, 9, 40));
    expect(messagesTo(3300)).toHaveLength(0);
    await runCron(env, kyiv(2026, 10, 27, 9, 46));
    expect(messagesTo(3300)).toHaveLength(1);
    expect(String(messagesTo(3300)[0].params.text)).toBe('🔔 Через 15 хв: 10:00-10:45  Фізика');

    await runCron(env, kyiv(2026, 10, 27, 9, 46));
    await runCron(env, kyiv(2026, 10, 27, 9, 47));
    await runCron(env, kyiv(2026, 10, 27, 10, 5));
    expect(messagesTo(3300)).toHaveLength(1);
  });

  it('catches up a lesson reminder missed during a short gap between runs', async () => {
    await mkUser(3301, { lesson_lead: 10 });
    await new Db(env.DB).addLessons(3301, [{ weekday: 2, start: 600, end: null, title: 'Історія' }]);
    await runCron(env, kyiv(2026, 10, 27, 9, 40));
    await runCron(env, kyiv(2026, 10, 27, 9, 53));
    expect(messagesTo(3301)).toHaveLength(1);
  });

  it('uses the time zone of each user', async () => {
    const db = new Db(env.DB);
    await mkUser(3302, { lesson_lead: 10, tz: 'Europe/London' });
    await db.addLessons(3302, [{ weekday: 2, start: 480, end: null, title: 'Лондонський урок' }]);
    await runCron(env, utc(2026, 10, 27, 7, 40));
    await runCron(env, utc(2026, 10, 27, 7, 51));
    expect(messagesTo(3302)).toHaveLength(1);
    expect(String(messagesTo(3302)[0].params.text)).toContain('Лондонський урок');
  });

  it('reminds users of every distinct time zone and lead combination, not only the first ten', async () => {
    const db = new Db(env.DB);
    const fireAt = utc(2026, 10, 27, 9, 45);
    const users: number[] = [];
    let uid = 3350;
    for (const tz of ['Europe/Kyiv', 'Europe/Warsaw', 'Europe/London']) {
      for (const lead of [5, 10, 15, 30]) {
        await mkUser(uid, { lesson_lead: lead, tz });
        const p = localParts(fireAt + lead * 60, tz);
        await db.addLessons(uid, [{ weekday: p.weekday, start: p.hour * 60 + p.minute, end: null, title: `Урок ${tz} ${lead}` }]);
        users.push(uid++);
      }
    }
    await runCron(env, fireAt - 300);
    await runCron(env, fireAt + 60);
    const reminded = users.filter((id) => messagesTo(id).length === 1);
    expect(reminded).toEqual(users);
  });

  it('does not remind users with lesson_lead 0 or blocked users', async () => {
    const db = new Db(env.DB);
    await mkUser(3303, { lesson_lead: 0 });
    await mkUser(3304, { lesson_lead: 15, blocked: 1 });
    for (const id of [3303, 3304]) await db.addLessons(id, [{ weekday: 2, start: 600, end: null, title: 'Урок' }]);
    await runCron(env, kyiv(2026, 10, 27, 9, 40));
    await runCron(env, kyiv(2026, 10, 27, 9, 46));
    expect(messagesTo(3303)).toHaveLength(0);
    expect(messagesTo(3304)).toHaveLength(0);
  });
});

describe('cron delivery failures', () => {
  beforeEach(resetDb);

  const T = kyiv(2026, 10, 27, 10, 0);
  const prepare = async (uid: number) => {
    await mkUser(uid);
    return new Db(env.DB).addDeadline(uid, 'Дедлайн', kyiv(2026, 10, 28, 10, 0), false, [T], NOW);
  };
  const sentOf = async (deadlineId: number) => (await one<{ sent: number }>('SELECT sent FROM reminders WHERE deadline_id = ?', deadlineId))!.sent;

  it('marks a user who blocked the bot and does not retry the reminder', async () => {
    const id = await prepare(3400);
    failSendsTo(3400, 403, 'Forbidden: bot was blocked by the user');
    await runCron(env, T + 30);
    expect((await userRow(3400)).blocked).toBe(1);
    expect(await sentOf(id)).toBe(1);
  });

  it('keeps the reminder for the next minute when Telegram rate limits the send', async () => {
    const id = await prepare(3401);
    failSendsTo(3401, 429, 'Too Many Requests: retry after 30', { retry_after: 30 });
    await runCron(env, T + 30);
    expect((await userRow(3401)).blocked).toBe(0);
    expect(await sentOf(id)).toBe(0);
  });

  it('drops the reminder for other permanent errors without blocking the user', async () => {
    const id = await prepare(3402);
    failSendsTo(3402, 400, 'Bad Request: chat not found');
    await runCron(env, T + 30);
    expect((await userRow(3402)).blocked).toBe(0);
    expect(await sentOf(id)).toBe(1);
  });

  it('one failing user does not stop the others', async () => {
    await prepare(3403);
    const other = await prepare(3404);
    failSendsTo(3403, 403, 'Forbidden: bot was blocked by the user');
    await runCron(env, T + 30);
    expect(messagesTo(3404)).toHaveLength(1);
    expect(await sentOf(other)).toBe(1);
  });

  it('unblocks a user who writes to the bot again', async () => {
    await mkUser(3405, { blocked: 1 });
    await say('/start', 3405);
    expect((await userRow(3405)).blocked).toBe(0);
  });

  it('follows my_chat_member updates for private chats', async () => {
    await mkUser(3406);
    const update = (status: string): TgUpdate => ({
      update_id: 9000,
      my_chat_member: { chat: { id: 3406, type: 'private' }, from: { id: 3406, is_bot: false, first_name: 'Оля' }, new_chat_member: { status } },
    });
    await handleUpdate(env, update('kicked'), BASE, NOW);
    expect((await userRow(3406)).blocked).toBe(1);
    await handleUpdate(env, update('member'), BASE, NOW);
    expect((await userRow(3406)).blocked).toBe(0);
  });

  it('marks the user blocked when the bot is blocked during a normal reply', async () => {
    await mkUser(3407);
    failSendsTo(3407, 403, 'Forbidden: bot was blocked by the user');
    await say('/help', 3407);
    expect((await userRow(3407)).blocked).toBe(1);
  });
});

describe('HTTP routes', () => {
  beforeEach(resetDb);

  async function call(request: Request, e: AppEnv = env): Promise<Response> {
    const ctx = createExecutionContext();
    const res = await worker.fetch(request, e, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }
  const webhook = (headers: Record<string, string>, body: unknown = textUpdate('/start', 3500)) =>
    new Request(`${BASE}/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

  it('rejects a webhook call without the secret header', async () => {
    const res = await call(webhook({}));
    expect(res.status).toBe(403);
    expect(tg.calls).toHaveLength(0);
    expect(await one('SELECT id FROM users WHERE id = 3500')).toBeNull();
  });

  it('rejects a webhook call with a wrong secret of the same and of another length', async () => {
    expect((await call(webhook({ 'x-telegram-bot-api-secret-token': 'test_secret_0123456780' }))).status).toBe(403);
    expect((await call(webhook({ 'x-telegram-bot-api-secret-token': 'short' }))).status).toBe(403);
    expect(tg.calls).toHaveLength(0);
  });

  it('rejects every call when the server has no secret configured', async () => {
    const res = await call(webhook({ 'x-telegram-bot-api-secret-token': '' }), { ...env, WEBHOOK_SECRET: '' });
    expect(res.status).toBe(403);
  });

  it('accepts a webhook call with the right secret and handles the update in the background', async () => {
    const res = await call(webhook({ 'x-telegram-bot-api-secret-token': SECRET }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    const welcome = messagesTo(3500)[0];
    expect(String(welcome.params.text)).toContain('Привіт, Оля');
    expect(await one('SELECT id FROM users WHERE id = 3500')).not.toBeNull();
  });

  it('answers 400 for a body that is not JSON', async () => {
    const res = await call(webhook({ 'x-telegram-bot-api-secret-token': SECRET }, 'not json'));
    expect(res.status).toBe(400);
  });

  it('still answers 200 when sending the reply fails with a network error', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    const previous = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/sendMessage')) throw new TypeError('network down');
      return previous(input, init);
    });
    const res = await call(webhook({ 'x-telegram-bot-api-secret-token': SECRET }, textUpdate('/help', 3501)));
    expect(res.status).toBe(200);
    expect(await one('SELECT id FROM users WHERE id = 3501')).not.toBeNull();
  });

  it('serves the diagnostics page and registers the webhook on GET /setup', async () => {
    const res = await call(new Request(`${BASE}/setup?secret=${SECRET}`));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('StudyBot готовий');
    expect(html).toContain('@test_study_bot');
    expect(html).toContain('groq:test-model');
    expect(html).toContain('таблиці на місці');

    const hook = tg.last('setWebhook')!;
    expect(hook.params.url).toBe(`${BASE}/webhook`);
    expect(hook.params.secret_token).toBe(SECRET);
    expect(hook.params.allowed_updates).toEqual(expect.arrayContaining(['message', 'callback_query', 'poll_answer', 'my_chat_member']));
    expect(tg.calls.filter((c) => c.method === 'setMyCommands')).toHaveLength(2);
    expect(tg.calls.filter((c) => c.method === 'setMyCommands')[1].params.language_code).toBe('uk');
    const commands = tg.calls.find((c) => c.method === 'setMyCommands')!.params.commands as Array<{ command: string }>;
    expect(commands.map((c) => c.command)).toEqual(expect.arrayContaining(['start', 'plan', 'grades', 'timer']));
    expect(tg.last('setMyDescription')).toBeDefined();
    expect(tg.last('setMyShortDescription')).toBeDefined();
  });

  it('refuses /setup with a missing or wrong secret and does not call Telegram', async () => {
    expect((await call(new Request(`${BASE}/setup`))).status).toBe(403);
    expect((await call(new Request(`${BASE}/setup?secret=wrong`))).status).toBe(403);
    expect(tg.calls).toHaveLength(0);
  });

  it('explains a missing or too short WEBHOOK_SECRET on /setup', async () => {
    const res = await call(new Request(`${BASE}/setup?secret=short`), { ...env, WEBHOOK_SECRET: 'short' });
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('WEBHOOK_SECRET');
    expect(tg.calls).toHaveLength(0);
  });

  it('reports a missing AI provider on /setup without failing it', async () => {
    const res = await call(new Request(`${BASE}/setup?secret=${SECRET}`), { ...env, AI_PROVIDERS: '' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('жодного провайдера');
  });

  it('answers the health check and unknown routes', async () => {
    const root = await call(new Request(`${BASE}/`));
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('StudyBot працює');
    expect((await call(new Request(`${BASE}/nope`))).status).toBe(404);
    expect((await call(new Request(`${BASE}/webhook`))).status).toBe(404);
  });
});

describe('groups and access control', () => {
  beforeEach(resetDb);

  const inGroup = (update: TgUpdate, chatType: 'group' | 'supergroup' = 'supergroup'): TgUpdate => {
    const chat = { id: -100500, type: chatType } as const;
    if (update.message) return { ...update, message: { ...update.message, chat } };
    return { ...update, callback_query: { ...update.callback_query!, message: { ...update.callback_query!.message!, chat } } };
  };

  it('ignores ordinary messages and callbacks in group chats', async () => {
    await handleUpdate(env, inGroup(textUpdate('привіт всім', 3600)), BASE, NOW);
    await handleUpdate(env, inGroup(textUpdate('/deadlines', 3600), 'group'), BASE, NOW);
    await handleUpdate(env, inGroup(callbackUpdate('dl:add', 3600)), BASE, NOW);
    expect(tg.calls).toHaveLength(0);
    expect(await one('SELECT id FROM users WHERE id = 3600')).toBeNull();
  });

  it('answers /start in a group with a pointer to private messages', async () => {
    await handleUpdate(env, inGroup(textUpdate('/start', 3601)), BASE, NOW);
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0].params.chat_id).toBe(-100500);
    expect(lastText()).toContain('лише в особистих повідомленнях');
    expect(await one('SELECT id FROM users WHERE id = 3601')).toBeNull();
  });

  it('ignores messages from other bots', async () => {
    const update = textUpdate('привіт', 3602);
    update.message!.from!.is_bot = true;
    await handleUpdate(env, update, BASE, NOW);
    expect(tg.calls).toHaveLength(0);
  });

  it('serves only ALLOWED_USERS and tells everybody else their id', async () => {
    const restricted = { ...env, ALLOWED_USERS: '1, 3611' } as AppEnv;
    await say('/start', 3610, NOW, restricted);
    expect(lastText()).toContain('приватний бот');
    expect(lastText()).toContain('3610');
    expect(tg.calls.every((c) => c.params.chat_id === 3610)).toBe(true);
    expect(await one('SELECT id FROM users WHERE id = 3610')).toBeNull();

    await press('dl:add', 3610, NOW, restricted);
    expect(tg.last('answerCallbackQuery')).toBeDefined();
    expect(await one('SELECT id FROM users WHERE id = 3610')).toBeNull();

    await say('/start', 3611, NOW, restricted);
    expect(tg.sent().some((t) => t.includes('Привіт, Оля'))).toBe(true);
    expect(await one('SELECT id FROM users WHERE id = 3611')).not.toBeNull();
  });

  it('allows everybody when ALLOWED_USERS is empty', async () => {
    await say('/start', 3612, NOW, { ...env, ALLOWED_USERS: '' } as AppEnv);
    expect(tg.sent()[0]).toContain('Привіт');
  });

  it('shows /stats only to the admin', async () => {
    const admin = { ...env, ADMIN_ID: '3620' } as AppEnv;
    await say('/stats', 3620, NOW, admin);
    expect(lastText()).toContain('Статистика');
    expect(lastText()).toContain('groq:test-model');
    await say('/stats', 3621, NOW, admin);
    expect(tg.sent().at(-2)).toContain('Не знаю такої команди');
  });

  it('cancels a pending step with /cancel', async () => {
    await press('sch:add', 3630);
    expect((await userRow(3630)).state).toBe('lesson_add');
    await say('/cancel', 3630);
    expect((await userRow(3630)).state).toBeNull();
    expect(lastText()).toContain('Скасовано');

    await press('dl:add', 3630);
    expect((await userRow(3630)).state).toBe('deadline_add');
    await press('x:cancel', 3630);
    expect((await userRow(3630)).state).toBeNull();
    expect(String(tg.last('editMessageText')?.params.text)).toBe('Скасовано.');
  });

  it('asks for a supported input when a message has no text, photo or file', async () => {
    const update = textUpdate('x', 3631);
    delete update.message!.text;
    await handleUpdate(env, update, BASE, NOW);
    expect(lastText()).toContain('Я розумію текст');
  });
});

describe('photos', () => {
  beforeEach(resetDb);

  const photoUpdate = (uid: number, caption?: string): TgUpdate => ({
    update_id: 8000,
    message: {
      message_id: 1,
      from: { id: uid, is_bot: false, first_name: 'Оля' },
      chat: { id: uid, type: 'private' },
      date: 0,
      caption,
      photo: [{ file_id: 'small', width: 90, height: 90, file_size: 800 }, { file_id: 'big', width: 800, height: 600, file_size: 40000 }],
    },
  });

  it('explains that photos are unsupported when no provider reads images', async () => {
    await press('st:sum', 3700);
    await handleUpdate(env, photoUpdate(3700), BASE, NOW);
    expect(lastText()).toContain('Фото поки не розпізнаю');
    expect(tg.aiRequests).toHaveLength(0);
  });

  it('sends the photo to a vision model for a summary', async () => {
    const vision = { ...env, GROQ_VISION_MODEL: 'vision-model' } as AppEnv;
    tg.setAi(() => '**Клітина**\n- Ядро');
    await handleUpdate(vision, callbackUpdate('st:sum', 3701), BASE, NOW);
    await handleUpdate(vision, photoUpdate(3701, 'Біологія'), BASE, NOW);

    expect(tg.aiRequests).toHaveLength(1);
    expect(tg.aiRequests[0].model).toBe('vision-model');
    const content = tg.aiRequests[0].messages[1].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(content.find((p) => p.type === 'image_url')?.image_url?.url.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(tg.calls.some((c) => c.method === 'getFile' && c.params.file_id === 'big')).toBe(true);
    expect(lastText()).toContain('<b>Клітина</b>');
  });

  it('asks what to do with a photo sent without context', async () => {
    const vision = { ...env, GROQ_VISION_MODEL: 'vision-model' } as AppEnv;
    tg.setAi(() => '**Конспект**');
    await handleUpdate(vision, photoUpdate(3702), BASE, NOW);
    expect(findButton(tg.last('sendMessage'), 'Конспект')).toBe('st:fsum');
    expect(findButton(tg.last('sendMessage'), 'Тест')).toBe('st:fquiz');
    await handleUpdate(vision, callbackUpdate('st:fsum', 3702), BASE, NOW);
    expect(tg.aiRequests).toHaveLength(1);
    expect((await userRow(3702)).state).toBeNull();
  });
});

describe('AI failures and the daily limit', () => {
  beforeEach(resetDb);

  it('shows a friendly message and refunds the counter on HTTP 500', async () => {
    tg.setAi(() => new Response('upstream broke', { status: 500 }));
    await say('Поясни теорему Піфагора', 3800);
    expect(tg.aiRequests).toHaveLength(1);
    expect(lastText()).toContain('ШІ зараз не відповідає');
    expect(await aiCount(3800)).toBe(0);
    expect((await userRow(3800)).history).toBeNull();
  });

  it('shows a friendly message and refunds the counter on HTTP 429', async () => {
    tg.setAi(() => new Response('rate limited', { status: 429 }));
    await say('Поясни теорему Піфагора', 3801);
    expect(lastText()).toContain('ШІ зараз не відповідає');
    expect(await aiCount(3801)).toBe(0);
  });

  it('treats an unusable JSON answer as an unavailable AI for JSON features', async () => {
    tg.setAi(() => 'це точно не JSON');
    await say('/quiz Київська Русь', 3802);
    expect(lastText()).toContain('ШІ зараз не відповідає');
    expect(tg.calls.filter((c) => c.method === 'sendPoll')).toHaveLength(0);
    // Модель відповіла, тож токени витрачено: запит зараховується.
    expect(await aiCount(3802)).toBe(1);
  });

  it('falls back to the next model when the first one fails and keeps the counter', async () => {
    const twoModels = { ...env, GROQ_MODELS: 'first-model,second-model' } as AppEnv;
    tg.setAi((body) => (body.model === 'first-model' ? new Response('down', { status: 503 }) : 'Відповідь другої моделі'));
    await say('Що таке дріб?', 3803, NOW, twoModels);
    expect(tg.aiRequests.map((r) => r.model)).toEqual(['first-model', 'second-model']);
    expect(lastText()).toContain('Відповідь другої моделі');
    expect(await aiCount(3803)).toBe(1);
  });

  it('says the AI is not connected when no provider is configured', async () => {
    await say('Що таке дріб?', 3804, NOW, { ...env, AI_PROVIDERS: '' } as AppEnv);
    expect(tg.aiRequests).toHaveLength(0);
    expect(lastText()).toContain('ШІ ще не підключено');
    expect(await aiCount(3804)).toBe(0);
  });

  it('enforces AI_DAILY_LIMIT, refunds the rejected request and resets on the next day', async () => {
    const limited = { ...env, AI_DAILY_LIMIT: '2' } as AppEnv;
    await say('Питання один', 3805, NOW, limited);
    await say('Питання два', 3805, NOW, limited);
    expect(tg.aiRequests).toHaveLength(2);
    expect(await aiCount(3805)).toBe(2);

    await say('Питання три', 3805, NOW, limited);
    expect(tg.aiRequests).toHaveLength(2);
    expect(lastText()).toContain('ліміт запитів до ШІ вичерпано (2 запити на добу)');
    expect(await aiCount(3805)).toBe(2);

    await say('Питання чотири', 3805, NOW + 86400, limited);
    expect(tg.aiRequests).toHaveLength(3);
    expect(await aiCount(3805)).toBe(1);
  });

  it('does not count features that need no AI against the limit', async () => {
    const limited = { ...env, AI_DAILY_LIMIT: '1' } as AppEnv;
    await say('/add Реферат 30.10 18:00', 3806, NOW, limited);
    await say('/deadlines', 3806, NOW, limited);
    await press('sch:add', 3806, NOW, limited);
    await say('пн 08:00 Алгебра', 3806, NOW, limited);
    expect(tg.aiRequests).toHaveLength(0);
    expect(await aiCount(3806)).toBe(0);
  });

  it('allows unlimited requests when AI_DAILY_LIMIT is 0', async () => {
    const unlimited = { ...env, AI_DAILY_LIMIT: '0' } as AppEnv;
    for (let i = 0; i < 4; i++) await say(`Питання ${i}`, 3807, NOW, unlimited);
    expect(tg.aiRequests).toHaveLength(4);
  });
  it('retries without response_format when the provider answers 400 to it', async () => {
    tg.setAi((body) => (body.response_format ? new Response('response_format is not supported', { status: 400 }) : JSON.stringify({ title: 'Дріб', date: '2026-11-12', time: null })));
    await say('нагадай про те що треба зробити в день першого снігу', 3808);
    expect(tg.aiRequests).toHaveLength(2);
    expect(tg.aiRequests[0].response_format).toEqual({ type: 'json_object' });
    expect(tg.aiRequests[1].response_format).toBeUndefined();
    expect(await one('SELECT title FROM deadlines WHERE user_id = 3808')).toEqual({ title: 'Дріб' });
    expect(await aiCount(3808)).toBe(1);
  });

  it('accepts JSON wrapped in a code fence with a trailing comma', async () => {
    tg.setAi(() => '```json\n{"title": "Контрольна", "date": "2026-11-12", "time": "10:00",}\n```');
    await say('нагадай про контрольну коли випаде сніг', 3809);
    expect(await one('SELECT due_at FROM deadlines WHERE user_id = 3809')).toEqual({ due_at: kyiv(2026, 11, 12, 10, 0) });
  });
});
