/**
 * Наскрізні тести основних сценаріїв бота: розклад, дедлайни, розбиття завдань
 * на кроки, тести-вікторини і конспекти. Оновлення Telegram проходять через
 * handleUpdate, а перевіряються і виклики Bot API, і рядки в D1.
 *
 * Кожен тест користується власним Telegram id, бо стан D1 живе протягом усього файлу.
 */

import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleUpdate } from '../../src/bot/router';
import { callbackUpdate, findButton, kyiv, mockFetch, pollAnswerUpdate, textUpdate, type FetchMock } from '../helpers';

const BASE = 'https://bot.test';
const NOW = kyiv(2026, 10, 26, 18, 0); // понеділок, 18:00 за Києвом, зимовий час

let tg: FetchMock;

beforeEach(() => {
  tg = mockFetch();
});
afterEach(() => tg.restore());

const say = (text: string, uid: number, now = NOW) => handleUpdate(env, textUpdate(text, uid), BASE, now);
const press = (data: string, uid: number, now = NOW, messageText = '') => handleUpdate(env, callbackUpdate(data, uid, 555, messageText), BASE, now);

async function one<T>(sql: string, ...binds: unknown[]): Promise<T | null> {
  return env.DB.prepare(sql).bind(...binds).first<T>();
}

async function all<T>(sql: string, ...binds: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...binds).all<T>()).results;
}

const toast = () => tg.last('answerCallbackQuery')?.params.text as string | undefined;
const lastText = () => tg.sent().at(-1) ?? '';
const userState = async (uid: number) => (await one<{ state: string | null }>('SELECT state FROM users WHERE id = ?', uid))?.state ?? null;
const aiCount = async (uid: number) => (await one<{ ai_count: number }>('SELECT ai_count FROM users WHERE id = ?', uid))?.ai_count ?? 0;

type LessonRow = { weekday: number; start_min: number; end_min: number | null; title: string };
const lessonsOf = (uid: number) => all<LessonRow>('SELECT weekday, start_min, end_min, title FROM lessons WHERE user_id = ? ORDER BY weekday, start_min', uid);

describe('schedule', () => {
  it('adds lessons from the state flow without calling the AI', async () => {
    const U = 2001;
    await press('sch:add', U);
    expect(await userState(U)).toBe('lesson_add');
    expect(lastText()).toContain('день час назва');

    await say('пн 08:30-09:15 Математика\nвт, чт 15:00 Англійська', U);
    expect(await lessonsOf(U)).toEqual([
      { weekday: 1, start_min: 510, end_min: 555, title: 'Математика' },
      { weekday: 2, start_min: 900, end_min: null, title: 'Англійська' },
      { weekday: 4, start_min: 900, end_min: null, title: 'Англійська' },
    ]);
    expect(await userState(U)).toBeNull();
    expect(tg.aiRequests).toHaveLength(0);
    expect(lastText()).toContain('Додав у розклад');
    expect(findButton(tg.last('sendMessage'), 'Показати розклад')).toBe('sch:view');
  });

  it('keeps good lines and reports the lines it could not parse', async () => {
    const U = 2002;
    await press('sch:add', U);
    await say('пн 08:30 Математика\nце зовсім не заняття', U);
    expect(await lessonsOf(U)).toHaveLength(1);
    expect(lastText()).toContain('Не зрозумів ці рядки');
    expect(lastText()).toContain('це зовсім не заняття');
  });

  it('falls back to the AI when the lesson text is free-form', async () => {
    const U = 2003;
    tg.setAi(() => JSON.stringify({ weekly: [{ day: 3, start: '16:00', end: '17:00', title: 'Гурток з робототехніки' }] }));
    await press('sch:add', U);
    await say('у середу з 16 до 17 гурток з робототехніки', U);

    expect(tg.aiRequests).toHaveLength(1);
    expect(tg.aiRequests[0].response_format).toEqual({ type: 'json_object' });
    expect(await lessonsOf(U)).toEqual([{ weekday: 3, start_min: 960, end_min: 1020, title: 'Гурток з робототехніки' }]);
    expect(await userState(U)).toBeNull();
    expect(await aiCount(U)).toBe(1);
  });

  it('stays in the add state when the AI finds no lessons in the text', async () => {
    const U = 2004;
    tg.setAi(() => JSON.stringify({ weekly: [] }));
    await press('sch:add', U);
    await say('сьогодні гарна погода', U);
    expect(await lessonsOf(U)).toHaveLength(0);
    expect(await userState(U)).toBe('lesson_add');
    expect(lastText()).toContain('Не вдалося знайти');
  });

  it('shows an AI schedule preview and saves it with sch:save', async () => {
    const U = 2005;
    tg.setAi(() =>
      JSON.stringify({
        weekly: [
          { day: 1, start: '16:00', end: '17:00', title: 'Математика НМТ' },
          { day: 3, start: '16:00', end: '17:00', title: 'Англійська' },
        ],
        comment: 'Чергуємо предмети',
      }),
    );
    await press('sch:ai', U);
    expect(await userState(U)).toBe('sched_ai');
    await say('10 клас, уроки до 14:00, хочу готуватися до НМТ', U);

    expect(await userState(U)).toBe('sched_preview');
    expect(await lessonsOf(U)).toHaveLength(0);
    expect(lastText()).toContain('Чернетка розкладу');
    expect(lastText()).toContain('Чергуємо предмети');
    expect(findButton(tg.last('sendMessage'), 'Додати в розклад')).toBe('sch:save');
    expect(findButton(tg.last('sendMessage'), 'Замінити')).toBeUndefined();
    expect(String(tg.aiRequests[0].messages[1].content)).toContain('2026-10-26');

    await press('sch:save', U);
    expect((await lessonsOf(U)).map((l) => l.title)).toEqual(['Математика НМТ', 'Англійська']);
    expect(await userState(U)).toBeNull();
    expect(tg.sent().some((t) => t.includes('Додав у розклад: 2 заняття'))).toBe(true);
    expect(lastText()).toContain('Розклад на тиждень');
  });

  it('replaces the whole schedule with sch:replace', async () => {
    const U = 2006;
    await press('sch:add', U);
    await say('пн 08:00 Старе заняття', U);
    expect(await lessonsOf(U)).toHaveLength(1);

    tg.setAi(() => JSON.stringify({ weekly: [{ day: 5, start: '17:30', end: null, title: 'Нове заняття' }], comment: '' }));
    await press('sch:ai', U);
    await say('щось про п\'ятницю', U);
    expect(findButton(tg.last('sendMessage'), 'Замінити')).toBe('sch:replace');

    await press('sch:replace', U);
    expect(await lessonsOf(U)).toEqual([{ weekday: 5, start_min: 1050, end_min: null, title: 'Нове заняття' }]);
    expect(tg.sent().some((t) => t.includes('Розклад замінено'))).toBe(true);
  });

  it('regenerates the preview with feedback text and with sch:redo', async () => {
    const U = 2007;
    tg.setAi(() => JSON.stringify({ weekly: [{ day: 2, start: '10:00', end: '11:00', title: 'Фізика' }], comment: '' }));
    await press('sch:ai', U);
    await say('мій тиждень', U);
    await say('у суботу менше занять', U);
    expect(tg.aiRequests).toHaveLength(2);
    expect(String(tg.aiRequests[1].messages[1].content)).toContain('Побажання до попереднього варіанта: у суботу менше занять');
    expect(String(tg.aiRequests[1].messages[1].content)).toContain('Опис: мій тиждень');

    await press('sch:redo', U);
    expect(tg.aiRequests).toHaveLength(3);
    expect(String(tg.aiRequests[2].messages[1].content)).toContain('Запропонуй інший варіант');
    expect(await userState(U)).toBe('sched_preview');
  });

  it('tells the user that a stale preview is no longer valid', async () => {
    const U = 2008;
    await press('sch:save', U);
    expect(lastText()).toContain('Чернетка вже неактуальна');
    expect(await lessonsOf(U)).toHaveLength(0);
  });

  it('shows the friendly message and creates no preview when the AI answers with junk', async () => {
    const U = 2009;
    tg.setAi(() => 'вибач, не можу');
    await press('sch:ai', U);
    await say('мій тиждень', U);
    expect(lastText()).toContain('ШІ зараз не відповідає');
    expect(await userState(U)).toBe('sched_ai');
    // Модель відповіла (токени витрачено), тож запит зараховується, хоч відповідь і не підійшла.
    expect(await aiCount(U)).toBe(1);
  });

  it('walks the delete flow by day, lesson and full clear', async () => {
    const U = 2010;
    await press('sch:add', U);
    await say('пн 08:00 Алгебра\nпн 09:00 Геометрія\nсб 11:00 Гурток', U);
    const [alg, geo] = await all<{ id: number }>("SELECT id FROM lessons WHERE user_id = ? AND weekday = 1 ORDER BY start_min", U);

    await press('sch:del', U);
    const days = tg.last('editMessageText');
    expect(days?.params.text).toContain('З якого дня');
    expect(findButton(days, 'пн')).toBe('sch:dd:1');
    expect(findButton(days, 'сб')).toBe('sch:dd:6');
    expect(findButton(days, 'вт')).toBeUndefined();

    await press('sch:dd:1', U);
    const dayView = tg.last('editMessageText');
    expect(findButton(dayView, 'Алгебра')).toBe(`sch:x:${alg.id}:1`);
    expect(findButton(dayView, 'Геометрія')).toBe(`sch:x:${geo.id}:1`);

    await press(`sch:x:${alg.id}:1`, U);
    expect(toast()).toBe('Видалено');
    expect((await lessonsOf(U)).map((l) => l.title)).toEqual(['Геометрія', 'Гурток']);
    expect(findButton(tg.last('editMessageText'), 'Алгебра')).toBeUndefined();

    await press(`sch:x:${geo.id}:1`, U);
    expect(await lessonsOf(U)).toHaveLength(1);
    // День спорожнів, тож бот повертає до вибору дня.
    expect(tg.last('editMessageText')?.params.text).toContain('З якого дня');

    await press('sch:clr', U);
    expect(findButton(tg.last('editMessageText'), 'Так, очистити')).toBe('sch:clr!');
    await press('sch:clr!', U);
    expect(toast()).toBe('Розклад очищено');
    expect(await lessonsOf(U)).toHaveLength(0);
    expect(tg.last('editMessageText')?.params.text).toContain('Розклад порожній');
  });

  it('does not let one user delete the lesson of another', async () => {
    await press('sch:add', 2011);
    await say('пн 08:00 Чужий урок', 2011);
    const row = await one<{ id: number }>('SELECT id FROM lessons WHERE user_id = 2011');
    await press(`sch:x:${row!.id}:1`, 2012);
    expect(await lessonsOf(2011)).toHaveLength(1);
  });

  it('shows only the lessons of today in /today', async () => {
    const U = 2013;
    await press('sch:add', U);
    await say('пн 08:30 Математика\nвт 09:00 Хімія', U);
    await say('/today', U);
    expect(lastText()).toContain('Математика');
    expect(lastText()).not.toContain('Хімія');
  });
});

describe('deadlines', () => {
  async function addDeadline(uid: number, text: string, now = NOW): Promise<number> {
    await say(`/add ${text}`, uid, now);
    const row = await one<{ id: number }>('SELECT id FROM deadlines WHERE user_id = ? ORDER BY id DESC LIMIT 1', uid);
    return row!.id;
  }

  it('orders the list by priority, not by due date', async () => {
    const U = 2020;
    const urgentLow = await addDeadline(U, 'Лабораторна 28.10 18:00');
    const normal = await addDeadline(U, 'Реферат 30.10 18:00');
    const important = await addDeadline(U, 'Курсова 30.10 18:00');
    await press(`dl:i:${important}:3`, U);
    await press(`dl:c:${important}:3`, U);
    await press(`dl:i:${urgentLow}:1`, U);
    await press(`dl:c:${urgentLow}:1`, U);

    const rated = await one<{ importance: number; difficulty: number }>('SELECT importance, difficulty FROM deadlines WHERE id = ?', important);
    expect(rated).toEqual({ importance: 3, difficulty: 3 });
    expect(tg.last('editMessageReplyMarkup')).toBeDefined();

    await say('/deadlines', U);
    const list = tg.last('sendMessage')!;
    const text = String(list.params.text);
    expect(text.indexOf('Курсова')).toBeLessThan(text.indexOf('Реферат'));
    expect(text.indexOf('Реферат')).toBeLessThan(text.indexOf('Лабораторна'));
    const okButtons = (list.params.reply_markup.inline_keyboard as Array<Array<{ callback_data?: string }>>)
      .flat()
      .map((b) => b.callback_data)
      .filter((d) => d?.startsWith('dl:ok:'));
    expect(okButtons).toEqual([`dl:ok:${important}`, `dl:ok:${normal}`, `dl:ok:${urgentLow}`]);
  });

  it('marks a deadline that is due tomorrow with the high priority icon', async () => {
    const U = 2021;
    const id = await addDeadline(U, 'Контрольна 27.10 12:00');
    await press(`dl:i:${id}:3`, U);
    await say('/deadlines', U);
    expect(lastText()).toContain('🔴');
  });

  it('marks a deadline done with done_at and an on-time toast', async () => {
    const U = 2022;
    const id = await addDeadline(U, 'Доповідь 30.10 18:00');
    await press(`dl:ok:${id}`, U);
    expect(toast()).toBe('Виконано вчасно! 🎉');
    expect(await one('SELECT done, done_at FROM deadlines WHERE id = ?', id)).toEqual({ done: 1, done_at: NOW });
    expect(tg.last('editMessageText')?.params.text).toContain('Доповідь');
    expect(tg.last('editMessageText')?.params.text).toContain('виконано');

    // Повторне натискання нічого не змінює і не показує привітання.
    await press(`dl:ok:${id}`, U, NOW + 600);
    expect(toast()).toBeUndefined();
    expect((await one<{ done_at: number }>('SELECT done_at FROM deadlines WHERE id = ?', id))?.done_at).toBe(NOW);
  });

  it('uses the late toast for an overdue deadline and refreshes the list message', async () => {
    const U = 2023;
    const id = await addDeadline(U, 'Есе 27.10 12:00');
    await press(`dl:ok:${id}`, U, kyiv(2026, 10, 28, 9, 0), '⏰ Дедлайни за пріоритетом');
    expect(toast()).toBe('Виконано! 🎉');
    expect(tg.last('editMessageText')?.params.text).toContain('Активних дедлайнів немає');
  });

  it('removes the reminders together with the deadline on dl:rm', async () => {
    const U = 2024;
    const id = await addDeadline(U, 'Звіт 30.10 18:00');
    expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM reminders WHERE deadline_id = ?', id))!.n).toBeGreaterThan(0);

    await press(`dl:rm:${id}`, U);
    expect(toast()).toBe('Точно видалити дедлайн?');
    expect(await one('SELECT id FROM deadlines WHERE id = ?', id)).not.toBeNull();
    await press(`dl:rm!:${id}`, U);
    expect(toast()).toBe('Видалено');
    expect(await one('SELECT id FROM deadlines WHERE id = ?', id)).toBeNull();
    expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM reminders WHERE deadline_id = ?', id))!.n).toBe(0);
  });

  it('refuses to touch the deadline of another user', async () => {
    const id = await addDeadline(2025, 'Чужий дедлайн 30.10 18:00');
    await press(`dl:ok:${id}`, 2026);
    await press(`dl:rm:${id}`, 2026);
    expect(await one('SELECT done FROM deadlines WHERE id = ?', id)).toEqual({ done: 0 });
  });

  it('escapes HTML in titles everywhere they are shown', async () => {
    const U = 2031;
    await addDeadline(U, '<b>Реферат</b> & тест 30.10 18:00');
    expect(lastText()).toContain('&lt;b&gt;Реферат&lt;/b&gt; &amp; тест');
    await say('/deadlines', U);
    expect(lastText()).toContain('&lt;b&gt;Реферат&lt;/b&gt; &amp; тест');
    expect(lastText()).not.toContain('<b>Реферат</b>');
  });

  it('keeps the list within the Telegram message limit of 4096 characters for very long titles', async () => {
    const U = 2032;
    for (let i = 0; i < 10; i++) await addDeadline(U, `${'Дуже довгий опис завдання '.repeat(16)}${i} 30.10 18:00`);
    await say('/deadlines', U);
    expect(lastText().length).toBeLessThanOrEqual(4096);
  });

  it('rejects a moment in the past', async () => {
    const U = 2027;
    await say('/add Здати звіт 20.10.2026 18:00', U);
    expect(lastText()).toContain('уже минув');
    await say('/add Здати звіт сьогодні 17:00', U);
    expect(lastText()).toContain('уже минув');
    expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM deadlines WHERE user_id = ?', U))!.n).toBe(0);
  });

  it('asks again when the text has no date and the AI cannot find one', async () => {
    const U = 2028;
    tg.setAi(() => JSON.stringify({ title: 'Здати проєкт', date: null, time: null }));
    await press('dl:add', U);
    await say('здати проєкт колись', U);
    expect(lastText()).toContain('Не знайшов дату');
    expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM deadlines WHERE user_id = ?', U))!.n).toBe(0);
    expect(await userState(U)).toBe('deadline_add');
  });

  it('extracts the date with the AI when the text cannot be parsed locally', async () => {
    const U = 2029;
    tg.setAi(() => JSON.stringify({ title: 'Здати проєкт', date: '2026-12-25', time: null }));
    await say('нагадай здати проєкт на Різдво', U);

    expect(tg.aiRequests).toHaveLength(1);
    expect(String(tg.aiRequests[0].messages[1].content)).toContain('здати проєкт на Різдво');
    const d = await one<{ title: string; due_at: number; all_day: number }>('SELECT title, due_at, all_day FROM deadlines WHERE user_id = ?', U);
    expect(d).toEqual({ title: 'Здати проєкт', due_at: kyiv(2026, 12, 25, 23, 59), all_day: 1 });
    expect(await aiCount(U)).toBe(1);
    expect(lastText()).toContain('Записав');
  });

  it('uses the AI time when the model returns one', async () => {
    const U = 2030;
    tg.setAi(() => JSON.stringify({ title: 'Контрольна', date: '2026-11-12', time: '09:30' }));
    await say('нагадай про контрольну в той день коли випаде перший сніг', U);
    const d = await one<{ due_at: number; all_day: number }>('SELECT due_at, all_day FROM deadlines WHERE user_id = ?', U);
    expect(d).toEqual({ due_at: kyiv(2026, 11, 12, 9, 30), all_day: 0 });
  });
});

describe('split into steps', () => {
  const SPLIT = {
    title: 'Курсова з історії',
    steps: [
      { text: 'Знайти джерела', minutes: 60 },
      { text: 'Скласти план', minutes: 30 },
      { text: 'Написати вступ', minutes: 90 },
      { text: 'Написати основну частину', minutes: 120 },
      { text: 'Оформити висновки', minutes: 45 },
    ],
    tip: 'Починай із джерел',
  };

  type StepRow = { id: number; pos: number; text: string; minutes: number | null; due_date: string | null; done: number; done_at: number | null };
  const stepsOf = (taskId: number) => all<StepRow>('SELECT id, pos, text, minutes, due_date, done, done_at FROM steps WHERE task_id = ? ORDER BY pos', taskId);

  async function makeTask(uid: number, text = 'написати курсову з історії до 15 грудня'): Promise<{ taskId: number; deadlineId: number | null }> {
    await press('tk:new', uid);
    await say(text, uid);
    const t = await one<{ id: number; deadline_id: number | null }>('SELECT id, deadline_id FROM tasks WHERE user_id = ? ORDER BY id DESC LIMIT 1', uid);
    return { taskId: t!.id, deadlineId: t!.deadline_id };
  }

  it('creates steps from the AI answer and spreads them over free days before the deadline', async () => {
    const U = 2040;
    tg.setAi(() => JSON.stringify(SPLIT));
    const { taskId, deadlineId } = await makeTask(U);

    expect(await userState(U)).toBeNull();
    expect(String(tg.aiRequests[0].messages[1].content)).toContain('Дедлайн:');
    const task = await one<{ kind: string; title: string }>('SELECT kind, title FROM tasks WHERE id = ?', taskId);
    expect(task).toEqual({ kind: 'split', title: 'Курсова з історії' });

    const steps = await stepsOf(taskId);
    expect(steps.map((s) => s.pos)).toEqual([1, 2, 3, 4, 5]);
    expect(steps.map((s) => s.minutes)).toEqual([60, 30, 90, 120, 45]);
    expect(steps.map((s) => s.due_date)).toEqual(['2026-10-26', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29']);
    expect(steps.every((s) => s.due_date! < '2026-12-15')).toBe(true);

    const deadline = await one<{ title: string; due_at: number; all_day: number }>('SELECT title, due_at, all_day FROM deadlines WHERE id = ?', deadlineId);
    expect(deadline).toEqual({ title: 'Курсова з історії', due_at: kyiv(2026, 12, 15, 23, 59), all_day: 1 });
    expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM reminders WHERE deadline_id = ?', deadlineId))!.n).toBeGreaterThan(0);

    const texts = tg.sent();
    expect(texts.some((t) => t.includes('Курсова з історії') && t.includes('0%'))).toBe(true);
    expect(texts.at(-1)).toContain('Також записав дедлайн');
    expect(texts.at(-1)).toContain('Починай із джерел');
  });

  it('places steps only on days with free time from the availability setting', async () => {
    const U = 2041;
    await say('/start', U);
    await env.DB.prepare('UPDATE users SET availability = ? WHERE id = ?').bind('[0,120,0,0,0,0,0]', U).run();
    tg.setAi(() =>
      JSON.stringify({
        title: 'Проєкт',
        steps: [
          { text: 'Крок один', minutes: 60 },
          { text: 'Крок два', minutes: 60 },
          { text: 'Крок три', minutes: 60 },
        ],
      }),
    );
    const { taskId } = await makeTask(U);
    const dates = (await stepsOf(taskId)).map((s) => s.due_date);
    expect(dates).toEqual(['2026-10-27', '2026-10-27', '2026-11-03']);
  });

  it('creates a task without a deadline when the text has no date', async () => {
    const U = 2042;
    tg.setAi(() => JSON.stringify(SPLIT));
    const { taskId, deadlineId } = await makeTask(U, 'вивчити всю історію України');
    expect(deadlineId).toBeNull();
    expect((await stepsOf(taskId)).every((s) => s.due_date !== null)).toBe(true);
    expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM deadlines WHERE user_id = ?', U))!.n).toBe(0);
  });

  it('writes study_log when a step is done and removes it when the step is unchecked', async () => {
    const U = 2043;
    tg.setAi(() => JSON.stringify(SPLIT));
    const { taskId } = await makeTask(U);
    const [first] = await stepsOf(taskId);

    await press(`tk:s:${first.id}`, U);
    const done = (await stepsOf(taskId))[0];
    expect(done.done).toBe(1);
    expect(done.done_at).toBe(NOW);
    expect(await all('SELECT subject, minutes, day, step_id FROM study_log WHERE user_id = ?', U)).toEqual([
      { subject: 'Курсова з історії', minutes: 60, day: '2026-10-26', step_id: first.id },
    ]);
    expect(tg.last('editMessageText')?.params.text).toContain('1/5');

    await press(`tk:s:${first.id}`, U);
    const undone = (await stepsOf(taskId))[0];
    expect(undone.done).toBe(0);
    expect(undone.done_at).toBeNull();
    expect(await all('SELECT id FROM study_log WHERE user_id = ?', U)).toHaveLength(0);
  });

  it('ignores a step toggle from a different user', async () => {
    const U = 2044;
    tg.setAi(() => JSON.stringify(SPLIT));
    const { taskId } = await makeTask(U);
    const [first] = await stepsOf(taskId);
    await press(`tk:s:${first.id}`, 2045);
    expect((await stepsOf(taskId))[0].done).toBe(0);
    expect(await all('SELECT id FROM study_log WHERE step_id = ?', first.id)).toHaveLength(0);
  });

  it('offers to close the deadline only after the last step is done', async () => {
    const U = 2046;
    tg.setAi(() => JSON.stringify(SPLIT));
    const { taskId, deadlineId } = await makeTask(U);
    const steps = await stepsOf(taskId);

    for (const s of steps.slice(0, -1)) await press(`tk:s:${s.id}`, U);
    expect(tg.sent().some((t) => t.includes('Позначити дедлайн'))).toBe(false);

    await press(`tk:s:${steps.at(-1)!.id}`, U);
    expect(lastText()).toContain('Позначити дедлайн');
    expect(lastText()).toContain('Курсова з історії');
    expect(findButton(tg.last('sendMessage'), 'Так')).toBe(`dl:ok:${deadlineId}`);
    expect(tg.last('editMessageText')?.params.text).toContain('Усі кроки виконано');

    await press(`dl:ok:${deadlineId}`, U);
    expect(await one('SELECT done FROM deadlines WHERE id = ?', deadlineId)).toEqual({ done: 1 });
  });

  it('splits an existing deadline with dl:sp without creating a second deadline', async () => {
    const U = 2047;
    tg.setAi(() => JSON.stringify(SPLIT));
    await say('/add Підготувати презентацію 30.10 18:00', U);
    const d = await one<{ id: number }>('SELECT id FROM deadlines WHERE user_id = ?', U);

    await press(`dl:sp:${d!.id}`, U);
    const task = await one<{ id: number; deadline_id: number }>('SELECT id, deadline_id FROM tasks WHERE user_id = ?', U);
    expect(task!.deadline_id).toBe(d!.id);
    expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM deadlines WHERE user_id = ?', U))!.n).toBe(1);
    // Крок плану не може стояти в день дедлайну, коли до нього більше двох днів.
    expect((await stepsOf(task!.id)).every((s) => s.due_date! <= '2026-10-29')).toBe(true);
    expect(String(tg.aiRequests[0].messages[1].content)).toContain('Підготувати презентацію');

    await press(`dl:rm!:${d!.id}`, U);
    expect(await one('SELECT deadline_id FROM tasks WHERE id = ?', task!.id)).toEqual({ deadline_id: null });
  });

  it('reports that the deadline is gone for dl:sp on a missing id', async () => {
    await press('dl:sp:999999', 2048);
    expect(lastText()).toContain('Цього дедлайну вже немає');
  });

  it('deletes a task with confirmation and keeps the logged time', async () => {
    const U = 2049;
    tg.setAi(() => JSON.stringify(SPLIT));
    const { taskId } = await makeTask(U);
    const [first] = await stepsOf(taskId);
    await press(`tk:s:${first.id}`, U);

    await press(`tk:rm:${taskId}`, U);
    expect(toast()).toBe('Точно видалити?');
    expect(await one('SELECT id FROM tasks WHERE id = ?', taskId)).not.toBeNull();

    await press(`tk:rm!:${taskId}`, U);
    expect(toast()).toBe('Видалено');
    expect(await one('SELECT id FROM tasks WHERE id = ?', taskId)).toBeNull();
    expect(await stepsOf(taskId)).toHaveLength(0);
    expect(await all('SELECT minutes, step_id FROM study_log WHERE user_id = ?', U)).toEqual([{ minutes: 60, step_id: null }]);
  });

  it('lists tasks with their percentage', async () => {
    const U = 2050;
    tg.setAi(() => JSON.stringify(SPLIT));
    const { taskId } = await makeTask(U);
    const [first, second] = await stepsOf(taskId);
    await press(`tk:s:${first.id}`, U);
    await press(`tk:s:${second.id}`, U);
    await say('/tasks', U);
    expect(findButton(tg.last('sendMessage'), '40%')).toBe(`tk:v:${taskId}`);
  });
});

describe('quiz', () => {
  const QUESTIONS = [
    { q: 'Хто охрестив Русь?', options: ['Володимир', 'Ярослав', 'Олег', 'Ігор'], correct: 0, explain: 'Це сталося 988 року' },
    { q: 'Столиця Київської Русі?', options: ['Львів', 'Київ', 'Чернігів', 'Галич'], correct: 1, explain: 'Київ' },
    { q: 'Рік хрещення Русі?', options: ['862', '988', '1054', '1240'], correct: 1, explain: '988' },
  ];
  const QUIZ_JSON = JSON.stringify({ title: 'Київська Русь', questions: QUESTIONS });

  // Імітований Telegram нумерує опитування з poll-1 у кожному тесті, а в бою id унікальні.
  beforeEach(async () => {
    await env.DB.prepare('UPDATE quizzes SET poll_id = NULL').run();
  });

  const pollOf = async (uid: number) => (await one<{ poll_id: string | null }>('SELECT poll_id FROM quizzes WHERE user_id = ? ORDER BY id DESC LIMIT 1', uid))?.poll_id ?? null;
  const polls = () => tg.calls.filter((c) => c.method === 'sendPoll');
  const correctOf = (call: { params: Record<string, any> }) => call.params.correct_option_ids[0] as number;

  it('sends non-anonymous quiz polls whose correct option survives the shuffle', async () => {
    const U = 2060;
    tg.setAi(() => QUIZ_JSON);
    await say('/quiz 3 питання з теми Київська Русь', U);

    expect(String(tg.aiRequests[0].messages[0].content)).toContain('Рівно 3 питань');
    expect(tg.sent().some((t) => t.includes('Тест: Київська Русь'))).toBe(true);
    expect(polls()).toHaveLength(1);
    const poll = polls()[0];
    expect(poll.params.type).toBe('quiz');
    expect(poll.params.is_anonymous).toBe(false);
    expect(Array.isArray(poll.params.correct_option_ids)).toBe(true);
    expect(poll.params.correct_option_ids).toHaveLength(1);
    expect(String(poll.params.question)).toBe('1/3. Хто охрестив Русь?');
    const options = (poll.params.options as Array<{ text: string }>).map((o) => o.text);
    expect([...options].sort()).toEqual([...QUESTIONS[0].options].sort());
    expect(options[correctOf(poll)]).toBe('Володимир');
    expect(poll.params.explanation).toBe('Це сталося 988 року');
  });

  it('advances through the questions and reports the final score', async () => {
    const U = 2061;
    tg.setAi(() => QUIZ_JSON);
    await say('/quiz 3 питання з теми Київська Русь', U);

    for (let i = 0; i < 3; i++) {
      const poll = polls()[i];
      expect(poll).toBeDefined();
      const options = (poll.params.options as Array<{ text: string }>).map((o) => o.text);
      expect(options[correctOf(poll)]).toBe(QUESTIONS[i].options[QUESTIONS[i].correct]);
      const pick = i === 1 ? (correctOf(poll) + 1) % options.length : correctOf(poll);
      await handleUpdate(env, pollAnswerUpdate((await pollOf(U))!, pick, U), BASE, NOW);
    }

    expect(polls()).toHaveLength(3);
    expect(lastText()).toContain('Результат: <b>2 з 3</b> (67%)');
    expect(findButton(tg.last('sendMessage'), 'Ще тест')).toMatch(/^qz:again:\d+$/);
    expect(await one('SELECT score, current, poll_id FROM quizzes WHERE user_id = ?', U)).toEqual({ score: 2, current: 3, poll_id: null });
  });

  it('ignores a poll answer from another user and a repeated answer to a finished poll', async () => {
    const U = 2062;
    tg.setAi(() => QUIZ_JSON);
    await say('/quiz 3 питання з теми Київська Русь', U);
    const firstPoll = (await pollOf(U))!;

    await handleUpdate(env, pollAnswerUpdate(firstPoll, 0, 2063), BASE, NOW);
    expect(polls()).toHaveLength(1);
    expect(await one('SELECT score, current FROM quizzes WHERE user_id = ?', U)).toEqual({ score: 0, current: 0 });

    await handleUpdate(env, pollAnswerUpdate(firstPoll, correctOf(polls()[0]), U), BASE, NOW);
    expect(polls()).toHaveLength(2);
    await handleUpdate(env, pollAnswerUpdate(firstPoll, correctOf(polls()[0]), U), BASE, NOW);
    expect(polls()).toHaveLength(2);
    expect(await one('SELECT score, current FROM quizzes WHERE user_id = ?', U)).toEqual({ score: 1, current: 1 });
  });

  it('starts a quiz from the menu button and a topic text', async () => {
    const U = 2064;
    tg.setAi(() => QUIZ_JSON);
    await say('❓ Тест', U);
    expect(await userState(U)).toBe('quiz');
    await say('Київська Русь', U);
    expect(await userState(U)).toBeNull();
    expect(polls()).toHaveLength(1);
    expect(String(tg.aiRequests[0].messages[0].content)).toContain('Рівно 5 питань');
  });

  it('skips malformed questions from the AI but keeps the valid ones', async () => {
    const U = 2065;
    tg.setAi(() =>
      JSON.stringify({
        title: 'Суміш',
        questions: [{ q: 'Без варіантів', options: ['лише один'], correct: 0 }, QUESTIONS[1], { q: 'Поганий індекс', options: ['а', 'б'], correct: 5 }],
      }),
    );
    await say('/quiz Суміш', U);
    expect(tg.sent().some((t) => t.includes('1 питання'))).toBe(true);
    expect(polls()).toHaveLength(1);
  });
});

describe('summary and quiz from summary', () => {
  const SUMMARY = '**Київська Русь**\n- Володимир охрестив Русь у 988 році\n- Ярослав Мудрий склав Руську правду';
  const route = (body: Record<string, any>): string => {
    const system = String(body.messages[0].content);
    if (system.includes('Склади короткий конспект')) return SUMMARY;
    if (system.includes('Склади тест')) {
      return JSON.stringify({
        title: 'За конспектом',
        questions: [
          { q: 'Коли охрестили Русь?', options: ['988', '1054', '862', '1240'], correct: 0, explain: '' },
          { q: 'Хто склав Руську правду?', options: ['Олег', 'Ярослав Мудрий', 'Ігор', 'Святослав'], correct: 1, explain: '' },
        ],
      });
    }
    return 'Звичайна відповідь';
  };

  it('stores the summary in the history and builds the quiz from it', async () => {
    const U = 2070;
    tg.setAi(route);
    await say('/summary Київська Русь', U);

    const summary = tg.last('sendMessage')!;
    expect(String(summary.params.text)).toContain('<b>Київська Русь</b>');
    expect(findButton(summary, 'Тест за конспектом')).toBe('st:quiz');
    const history = JSON.parse((await one<{ history: string }>('SELECT history FROM users WHERE id = ?', U))!.history) as Array<{ role: string; content: string }>;
    expect(history.at(-1)).toEqual({ role: 'assistant', content: SUMMARY, summary: true });

    await press('st:quiz', U);
    const quizRequest = tg.aiRequests.at(-1)!;
    expect(String(quizRequest.messages[0].content)).toContain('Склади тест');
    expect(String(quizRequest.messages.at(-1).content)).toContain('Ярослав Мудрий склав Руську правду');
    expect(tg.calls.filter((c) => c.method === 'sendPoll')).toHaveLength(1);
    expect(await one('SELECT topic FROM quizzes WHERE user_id = ?', U)).toEqual({ topic: SUMMARY });
  });

  it('asks for a topic when the summary is older than the tutor memory', async () => {
    const U = 2071;
    tg.setAi(route);
    await say('/summary Київська Русь', U);
    await press('st:quiz', U, NOW + 3 * 3600);
    expect(tg.aiRequests).toHaveLength(1);
    expect(await userState(U)).toBe('quiz');
    expect(tg.calls.filter((c) => c.method === 'sendPoll')).toHaveLength(0);
  });

  it('makes a summary through the menu button and the state flow', async () => {
    const U = 2072;
    tg.setAi(route);
    await say('📝 Конспект', U);
    expect(await userState(U)).toBe('summary');
    await say('Причини Першої світової війни', U);
    expect(await userState(U)).toBeNull();
    expect(String(tg.aiRequests[0].messages[1].content)).toContain('Причини Першої світової війни');
    expect(findButton(tg.last('sendMessage'), 'Ще конспект')).toBe('st:sum');
  });

  it('answers a free question as a tutor and remembers the conversation', async () => {
    const U = 2073;
    tg.setAi(route);
    await say('Поясни теорему Піфагора', U);
    await say('А тепер приклад', U);
    expect(tg.aiRequests).toHaveLength(2);
    expect(tg.aiRequests[1].messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(String(tg.aiRequests[1].messages[1].content)).toBe('Поясни теорему Піфагора');
  });
});
