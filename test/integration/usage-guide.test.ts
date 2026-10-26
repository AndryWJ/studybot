/**
 * Приклади з інструкції для учня (docs/usage.md): кожна описана там фраза, команда
 * й кнопка проходить через обробник оновлень і дає описаний результат. Фрази беруться
 * через `fromGuide`, тож тест падає, щойно інструкція і бот розійдуться.
 *
 * Кожен тест користується власним Telegram id, бо стан D1 живе протягом усього файлу.
 */

import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import guide from '../../docs/usage.md?raw';
import { handleUpdate } from '../../src/bot/router';
import { COMMANDS } from '../../src/bot/ui';
import type { TgUpdate } from '../../src/telegram';
import { callbackUpdate, findButton, kyiv, mockFetch, pollAnswerUpdate, textUpdate, type FetchMock } from '../helpers';

const BASE = 'https://bot.test';
const NOW = kyiv(2026, 10, 26, 18, 0); // понеділок, 18:00 за Києвом

let tg: FetchMock;
beforeEach(() => {
  tg = mockFetch();
});
afterEach(() => tg.restore());

const say = (text: string, uid: number, now = NOW) => handleUpdate(env, textUpdate(text, uid), BASE, now);
const press = (data: string, uid: number, now = NOW) => handleUpdate(env, callbackUpdate(data, uid), BASE, now);
const send = (update: TgUpdate) => handleUpdate(env, update, BASE, NOW);
const one = <T>(sql: string, ...binds: unknown[]) => env.DB.prepare(sql).bind(...binds).first<T>();
const all = async <T>(sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).all<T>()).results;
const lastText = () => tg.sent().at(-1) ?? '';
const toast = () => tg.last('answerCallbackQuery')?.params.text as string | undefined;
const lastButtons = () =>
  ((tg.last('sendMessage')?.params.reply_markup?.inline_keyboard ?? []) as Array<Array<{ text: string }>>).flat().map((b) => b.text);

/** Повертає `text`, переконавшись, що він дослівно є в інструкції. */
function fromGuide(text: string): string {
  expect(guide, `docs/usage.md не містить "${text}"`).toContain(text);
  return text;
}

/** Рядки з інструкції (кожен перевіряється окремо), з'єднані в одне повідомлення. */
const lines = (...items: string[]) => items.map(fromGuide).join('\n');

const quizJson = (n: number) =>
  JSON.stringify({ title: 'Київська Русь', questions: Array.from({ length: n }, (_, i) => ({ q: `Питання ${i + 1}`, options: ['а', 'б', 'в', 'г'], correct: 0, explain: '' })) });
const splitJson = JSON.stringify({
  title: 'Курсова з історії',
  steps: [
    { text: 'Обрати тему', minutes: 60 },
    { text: 'Скласти план', minutes: 45 },
  ],
  tip: 'Почни з плану',
});

describe('what you can just write', () => {
  it('turns messages that start with "нагадай" or "дедлайн" into deadlines', async () => {
    const U = 8001;
    await say(fromGuide('нагадай здати реферат завтра о 18'), U);
    await say(fromGuide('дедлайн контрольна з фізики в четвер о 10'), U);
    const rows = await all<{ title: string }>('SELECT title FROM deadlines WHERE user_id = ? ORDER BY id', U);
    expect(rows.map((r) => r.title)).toEqual(['Здати реферат', 'Контрольна з фізики']);
    expect(tg.aiRequests).toHaveLength(0);
  });

  it('saves a deadline from /add with text', async () => {
    const U = 8002;
    await say(fromGuide('/add есе 12.11 23:00'), U);
    await say(fromGuide('/add реферат 15.11 18:00'), U);
    const rows = await all<{ title: string; due_at: number }>('SELECT title, due_at FROM deadlines WHERE user_id = ? ORDER BY id', U);
    expect(rows).toEqual([
      { title: 'Есе', due_at: kyiv(2026, 11, 12, 23, 0) },
      { title: 'Реферат', due_at: kyiv(2026, 11, 15, 18, 0) },
    ]);
  });

  it('makes a summary, a quiz with the asked number of questions and a split task from commands', async () => {
    const U = 8003;
    tg.setAi(() => 'Конспект: причини війни');
    await say(fromGuide('/summary Причини Першої світової війни'), U);
    expect(lastText()).toContain('Конспект: причини війни');

    tg.setAi(() => quizJson(7));
    await say(fromGuide('/quiz 7 питань з теми Київська Русь'), U);
    expect(JSON.stringify(tg.aiRequests.at(-1))).toContain('Рівно 7 питань');
    expect(String(tg.last('sendPoll')?.params.question)).toMatch(/^1\/7\./);

    tg.setAi(() => splitJson);
    await say(fromGuide('/split написати курсову з історії до 15 грудня'), U);
    const task = await one<{ id: number; deadline_id: number }>("SELECT id, deadline_id FROM tasks WHERE user_id = ? AND kind = 'split'", U);
    const deadline = await one<{ due_at: number; all_day: number }>('SELECT due_at, all_day FROM deadlines WHERE id = ?', task!.deadline_id);
    expect(deadline).toEqual({ due_at: kyiv(2026, 12, 15, 23, 59), all_day: 1 });
  });

  it('starts the timer with /timer and a subject, and stops it with /timer', async () => {
    const U = 8004;
    await say(fromGuide('/timer хімія'), U);
    await say('/timer', U, NOW + 30 * 60);
    expect(await all('SELECT subject, minutes FROM study_log WHERE user_id = ?', U)).toEqual([{ subject: 'хімія', minutes: 30 }]);
  });

  it('stops a running timer even when /timer comes with another subject', async () => {
    const U = 8006;
    await say('/timer хімія', U);
    await say('/timer фізика', U, NOW + 10 * 60);
    expect(await all('SELECT subject, minutes FROM study_log WHERE user_id = ?', U)).toEqual([{ subject: 'хімія', minutes: 10 }]);
    expect(await one('SELECT timer_start FROM users WHERE id = ?', U)).toEqual({ timer_start: null });
  });

  it('shows lessons and deadlines for today with /today', async () => {
    const U = 8005;
    await press('sch:add', U);
    await say(fromGuide('пн 08:30-09:15 Математика'), U);
    await say('/add Взяти форму на фізру завтра', U);
    await say(fromGuide('/today'), U);
    expect(lastText()).toContain('Математика');
    expect(lastText()).toContain('Взяти форму на фізру');
  });
});

describe('schedule', () => {
  it('adds lessons written one per line and skips the same lessons the second time', async () => {
    const U = 8011;
    const text = lines('пн 08:30-09:15 Математика', 'вт, чт 15:00 Англійська', 'пн-пт 19:00-20:00 Підготовка до НМТ', 'щодня 21:00 Читання');
    await press('sch:add', U);
    await say(text, U);
    const count = async () => (await one<{ n: number }>('SELECT COUNT(*) AS n FROM lessons WHERE user_id = ?', U))!.n;
    expect(await count()).toBe(1 + 2 + 5 + 7);
    await press('sch:add', U);
    await say(text, U);
    expect(await count()).toBe(15);
    expect(lastText()).toContain('уже були в розкладі');
  });

  it('asks the AI to read lessons written in own words', async () => {
    const U = 8012;
    tg.setAi(() => JSON.stringify({ weekly: [{ day: 3, start: '16:00', end: '17:00', title: 'Гурток з робототехніки' }], comment: '' }));
    await press('sch:add', U);
    await say(fromGuide('у середу з 16 до 17 гурток з робототехніки'), U);
    expect(tg.aiRequests).toHaveLength(1);
    expect(await all('SELECT weekday, start_min FROM lessons WHERE user_id = ?', U)).toEqual([{ weekday: 3, start_min: 16 * 60 }]);
  });

  it('reworks the AI draft from a written wish and saves it with a button', async () => {
    const U = 8013;
    tg.setAi(() => JSON.stringify({ weekly: [{ day: 6, start: '10:00', end: '11:00', title: 'Математика' }], comment: '' }));
    await press('sch:ai', U);
    await say('10 клас, уроки до 14:00', U);
    await say(fromGuide('у суботу менше занять'), U);
    expect(tg.aiRequests).toHaveLength(2);
    expect(JSON.stringify(tg.aiRequests[1])).toContain('у суботу менше занять');
    expect(findButton(tg.last('sendMessage'), fromGuide('🔁 Інший варіант'))).toBe('sch:redo');
    await press('sch:save', U);
    expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM lessons WHERE user_id = ?', U))!.n).toBe(1);
  });
});

describe('deadlines', () => {
  it('understands the example phrases without AI and treats a missing time as the end of the day', async () => {
    const U = 8021;
    const cases: Array<[string, string, number]> = [
      ['Реферат з біології 15.11 18:00', 'Реферат з біології', 0],
      ['Курсова з історії до 20 грудня', 'Курсова з історії', 1],
      ['Контрольна з фізики в четвер о 10', 'Контрольна з фізики', 0],
      ['Взяти форму на фізру завтра', 'Взяти форму на фізру', 1],
      ['через 2 години подзвонити', 'Подзвонити', 0],
    ];
    for (const [phrase] of cases) {
      await say('/add', U);
      await say(fromGuide(phrase), U);
    }
    const rows = await all<{ title: string; all_day: number }>('SELECT title, all_day FROM deadlines WHERE user_id = ? ORDER BY id', U);
    expect(rows.map((r) => [r.title, r.all_day])).toEqual(cases.map(([, title, allDay]) => [title, allDay]));
    expect(tg.aiRequests).toHaveLength(0);
  });

  it('keeps only the reminders that are still ahead, so "через 2 години" gets one', async () => {
    const U = 8022;
    await say('/add через 2 години подзвонити', U);
    const d = await one<{ id: number; due_at: number }>('SELECT id, due_at FROM deadlines WHERE user_id = ?', U);
    expect(await all('SELECT remind_at FROM reminders WHERE deadline_id = ?', d!.id)).toEqual([{ remind_at: d!.due_at }]);
  });

  it('tells when it will remind and offers importance and difficulty with medium values set', async () => {
    const U = 8023;
    await say('/add Реферат з біології 15.11 18:00', U);
    expect(lastText()).toContain('Нагадаю:');
    expect(lastButtons()).toEqual(expect.arrayContaining(['❗ низька', '✅ середня', '❗ висока', '💪 легко', '✅ середньо', '💪 важко']));
    expect(guide).toContain('(низька, середня, висока)');
    expect(guide).toContain('(легко, середньо, важко)');
  });

  it('lists deadlines by priority with done, split and delete buttons, and asks before deleting', async () => {
    const U = 8024;
    await say('/add Курсова з історії до 20 грудня', U);
    await say('/add Контрольна з фізики в четвер о 10', U);
    await say(fromGuide('⏰ Дедлайни'), U);
    expect(lastText().indexOf('Контрольна з фізики')).toBeLessThan(lastText().indexOf('Курсова з історії'));
    expect(lastText()).toContain('🟢 є запас часу');
    expect(lastButtons()).toEqual(expect.arrayContaining(['✅ 1', '🧩 1', '🗑 1']));
    const id = (await one<{ id: number }>("SELECT id FROM deadlines WHERE user_id = ? AND title = 'Курсова з історії'", U))!.id;
    await press(`dl:rm:${id}`, U);
    expect(toast()).toBe('Точно видалити дедлайн?');
  });
});

describe('preparation plan', () => {
  interface Draft {
    selected: string[];
    subjects: Array<{ name: string; difficulty: number; level: number; exam: string | null }>;
  }
  const draftOf = async (uid: number) => JSON.parse((await one<{ state_data: string }>('SELECT state_data FROM users WHERE id = ?', uid))!.state_data) as Draft;

  it('builds an exam plan from the subject list, ratings and 12 hours, and saves exam dates as deadlines', async () => {
    const U = 8031;
    await say(fromGuide('🎯 План підготовки'), U);
    await press('pl:k:exam', U);
    await say(lines('Вища математика 20.01', 'Фізика 25.01', 'Англійська'), U);
    expect((await draftOf(U)).subjects.map((s) => s.exam)).toEqual(['2027-01-20', '2027-01-25', null]);

    await press('pl:r:d:0', U);
    await press('pl:r:l:1', U);
    const rated = (await draftOf(U)).subjects;
    expect([rated[0].difficulty, rated[1].level]).toEqual([4, 4]);

    await press('pl:r:ok', U);
    await press('pl:av:a1', U);
    expect((await one<{ availability: string }>('SELECT availability FROM users WHERE id = ?', U))!.availability).toBe('[60,60,60,60,60,120,120]');
    await say('12', U);
    expect(guide).toContain('(наприклад, `12`)');
    expect(lastText()).toContain('у плані: <b>12 год</b>');

    await press('pl:save', U);
    expect(await one('SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND kind = ?', U, 'plan')).toEqual({ n: 1 });
    const titles = (await all<{ title: string }>('SELECT title FROM deadlines WHERE user_id = ? ORDER BY due_at', U)).map((r) => r.title);
    expect(titles).toEqual(['Іспит: Вища математика', 'Іспит: Фізика']);
  });

  it('plans a subject without a date for 4 weeks, or until a later exam', async () => {
    const lastSession = async (uid: number, subject: string) =>
      (await one<{ d: string }>('SELECT MAX(s.due_date) AS d FROM steps s WHERE s.user_id = ? AND s.subject = ?', uid, subject))!.d;
    const fourWeeks = '2026-11-23';

    const near = 8032;
    await press('pl:k:custom', near);
    await say('Фізика 05.11\nАнглійська', near);
    await press('pl:r:ok', near);
    await press('pl:b:all', near);
    await press('pl:save', near);
    expect(await lastSession(near, 'Англійська')).toBe('2026-11-22');

    const far = 8033;
    await press('pl:k:custom', far);
    await say('Фізика 25.01\nАнглійська', far);
    await press('pl:r:ok', far);
    await press('pl:b:all', far);
    await press('pl:save', far);
    expect((await lastSession(far, 'Англійська')) > fourWeeks).toBe(true);
  });

  it('pre-selects the mandatory NMT subjects and takes a written date', async () => {
    const U = 8034;
    await press('pl:k:nmt', U);
    expect((await draftOf(U)).selected).toEqual(['ukr', 'math', 'hist']);
    await press('pl:s:eng', U);
    await press('pl:next', U);
    expect(lastButtons().some((t) => t.startsWith('Орієнтовно'))).toBe(true);
    await say(fromGuide('20.05.2027'), U);
    const subjects = (await draftOf(U)).subjects;
    expect(subjects.map((s) => s.name)).toEqual(['Українська мова', 'Математика', 'Історія України', 'Англійська мова']);
    expect(new Set(subjects.map((s) => s.exam))).toEqual(new Set(['2027-05-20']));
    await press('pl:r:ok', U);
    await press('pl:b:all', U);
    expect(lastText()).toContain('НМТ-2027');
  });
});

describe('big task by steps', () => {
  it('logs the time of a finished step and offers to close the deadline when all steps are done', async () => {
    const U = 8041;
    tg.setAi(() => splitJson);
    await say(fromGuide('🧩 Розбити завдання'), U);
    await say(fromGuide('написати курсову з історії на 25 сторінок до 15 грудня'), U);
    const steps = await all<{ id: number }>('SELECT id FROM steps WHERE user_id = ? ORDER BY pos', U);
    expect(steps).toHaveLength(2);
    await press(`tk:s:${steps[0].id}`, U);
    expect(await all('SELECT subject, minutes FROM study_log WHERE user_id = ?', U)).toEqual([{ subject: 'Курсова з історії', minutes: 60 }]);
    await press(`tk:s:${steps[1].id}`, U);
    expect(lastText()).toContain('Позначити дедлайн');
  });

  it('splits a deadline from the deadline list', async () => {
    const U = 8042;
    await say('/add Курсова з історії до 20 грудня', U);
    const id = (await one<{ id: number }>('SELECT id FROM deadlines WHERE user_id = ?', U))!.id;
    tg.setAi(() => splitJson);
    await press(`dl:sp:${id}`, U);
    expect(await one('SELECT deadline_id FROM tasks WHERE user_id = ?', U)).toEqual({ deadline_id: id });
  });
});

describe('summary and quiz', () => {
  it('makes a summary and a quiz from it', async () => {
    const U = 8051;
    await say(fromGuide('📝 Конспект'), U);
    tg.setAi(() => 'Конспект теми');
    await say(fromGuide('Причини Першої світової війни'), U);
    expect(lastText()).toContain('Конспект теми');
    expect(lastButtons()).toContain(fromGuide('❓ Тест за конспектом'));
    tg.setAi(() => quizJson(5));
    await press('st:quiz', U);
    expect(JSON.stringify(tg.aiRequests.at(-1))).toContain('Рівно 5 питань');
    expect(String(tg.last('sendPoll')?.params.question)).toMatch(/^1\/5\./);
  });

  it('asks the questions one by one and offers another quiz or a summary at the end', async () => {
    const U = 8052;
    // Імітований Telegram нумерує опитування з poll-1 у кожному тесті, а в бою id унікальні.
    await env.DB.prepare('UPDATE quizzes SET poll_id = NULL').run();
    await say(fromGuide('❓ Тест'), U);
    tg.setAi(() => quizJson(7));
    await say(fromGuide('7 питань з теми Київська Русь'), U);
    for (let i = 0; i < 7; i++) {
      const { poll_id } = (await one<{ poll_id: string }>('SELECT poll_id FROM quizzes WHERE user_id = ?', U))!;
      await send(pollAnswerUpdate(poll_id, 0, U));
    }
    expect(tg.calls.filter((c) => c.method === 'sendPoll')).toHaveLength(7);
    expect(lastText()).toContain('Результат');
    expect(lastButtons()).toEqual([fromGuide('🔁 Ще тест на цю тему'), fromGuide('📝 Конспект теми')]);
  });

  it('defaults to 5 questions when the count is not given', async () => {
    const U = 8053;
    await say('❓ Тест', U);
    tg.setAi(() => quizJson(5));
    await say('Київська Русь', U);
    expect(JSON.stringify(tg.aiRequests.at(-1))).toContain('Рівно 5 питань');
  });

  it('asks what to do with a text file sent without a command', async () => {
    const U = 8054;
    await send({
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: U, is_bot: false, first_name: 'Оля' },
        chat: { id: U, type: 'private' },
        date: 0,
        document: { file_id: 'doc', file_name: 'notes.txt', mime_type: 'text/plain', file_size: 100 },
      },
    });
    expect(lastText()).toBe('Що зробити з цим матеріалом?');
  });

  it('asks to finish the current step before taking a file', async () => {
    const U = 8056;
    await press('gr:add', U);
    await send({
      update_id: 3,
      message: {
        message_id: 3,
        from: { id: U, is_bot: false, first_name: 'Оля' },
        chat: { id: U, type: 'private' },
        date: 0,
        document: { file_id: 'doc', file_name: 'notes.txt', mime_type: 'text/plain', file_size: 100 },
      },
    });
    expect(lastText()).toContain('Спершу заверши поточну дію');
  });

  it('says it cannot read photos when no image-reading AI is connected', async () => {
    const U = 8055;
    await send({
      update_id: 2,
      message: {
        message_id: 2,
        from: { id: U, is_bot: false, first_name: 'Оля' },
        chat: { id: U, type: 'private' },
        date: 0,
        photo: [{ file_id: 'p', width: 800, height: 600, file_size: 40000 }],
      },
    });
    await press('st:fsum', U);
    expect(lastText()).toContain(fromGuide('Фото поки не розпізнаю'));
  });
});

describe('questions', () => {
  it('answers a question and remembers it for a follow-up', async () => {
    const U = 8061;
    tg.setAi(() => 'Похідна показує швидкість зміни функції.');
    await say(fromGuide('поясни, що таке похідна'), U);
    expect(lastText()).toContain('швидкість зміни');
    await say(fromGuide('а можна простіший приклад?'), U);
    expect(JSON.stringify(tg.aiRequests[1])).toContain('поясни, що таке похідна');
    await say(fromGuide("як розв'язати x² - 5x + 6 = 0"), U);
    expect(tg.aiRequests).toHaveLength(3);
  });

  it('answers "нагадай" without a date as a question', async () => {
    const U = 8062;
    tg.setAi((body) => (body.response_format ? JSON.stringify({ title: 'Інтеграл', date: null, time: null }) : 'Інтеграл це площа під графіком.'));
    await say(fromGuide('нагадай, що таке інтеграл'), U);
    expect(await one('SELECT COUNT(*) AS n FROM deadlines WHERE user_id = ?', U)).toEqual({ n: 0 });
    expect(lastText()).toContain('площа під графіком');
  });
});

describe('time and progress', () => {
  it('logs time written by hand in the three documented formats', async () => {
    const U = 8071;
    for (const text of ['45 хв математика', '1.5 год фізика', '1:20 англійська']) {
      await press('tm:log', U);
      await say(fromGuide(text), U);
    }
    const rows = await all<{ subject: string; minutes: number }>('SELECT subject, minutes FROM study_log WHERE user_id = ? ORDER BY id', U);
    expect(rows.map((r) => [r.subject.toLowerCase(), r.minutes])).toEqual([
      ['математика', 45],
      ['фізика', 90],
      ['англійська', 80],
    ]);
  });

  it('records at most 4 hours from the timer and nothing under a minute', async () => {
    const U = 8072;
    await say('/timer фізика', U);
    await say('/timer', U, NOW + 20);
    await say('/timer фізика', U);
    await say('/timer', U, NOW + 5 * 3600);
    expect(await all('SELECT minutes FROM study_log WHERE user_id = ?', U)).toEqual([{ minutes: 240 }]);
  });

  it('shows progress with charts and a button to the detailed charts page', async () => {
    const U = 8073;
    await press('tm:log', U);
    await say('45 хв математика', U);
    await say(fromGuide('📊 Прогрес'), U);
    expect(lastText()).toContain('за 7 днів');
    expect(lastText()).toContain('За предметами');
    expect(lastButtons()).toContain('📈 Детальні графіки');
    expect(guide).toContain('**📈 Детальні графіки**');
  });
});

describe('grades', () => {
  it('reads weights, shows averages and calculates what is needed for 10', async () => {
    const U = 8081;
    await press('gr:add', U);
    await say(lines('Математика 10 11 9', 'Фізика 8, 7x2', 'Англійська 12'), U);
    expect(await all('SELECT subject, value, weight FROM grades WHERE user_id = ? AND subject = ? ORDER BY id', U, 'Фізика')).toEqual([
      { subject: 'Фізика', value: 8, weight: 1 },
      { subject: 'Фізика', value: 7, weight: 2 },
    ]);
    expect(lastText()).toContain('Найслабший предмет: <b>Фізика</b>');

    await press('gr:target', U);
    await press(findButton(tg.last('sendMessage'), 'Фізика')!, U);
    const choose = findButton(tg.last('sendMessage'), '10')!;
    await press(choose, U);
    expect(lastText()).toContain('середній має бути від 9,5');
    expect(lastText()).toContain('Найшвидший шлях: 3 оцінки по 12');
    expect(guide).toContain('"3 оцінки по 12"');

    await press('gr:undo', U);
    expect(await one('SELECT COUNT(*) AS n FROM grades WHERE user_id = ?', U)).toEqual({ n: 5 });
  });
});

describe('settings', () => {
  interface Settings {
    tz: string;
    digest_min: number | null;
    lesson_lead: number;
    availability: string | null;
    grade_scale: number;
  }
  const settingsOf = async (uid: number) => (await one<Settings>('SELECT tz, digest_min, lesson_lead, availability, grade_scale FROM users WHERE id = ?', uid))!;

  it('starts with the documented defaults', async () => {
    const U = 8091;
    await say(fromGuide('⚙️ Налаштування'), U);
    expect(await settingsOf(U)).toEqual({ tz: 'Europe/Kyiv', digest_min: 7 * 60 + 30, lesson_lead: 0, availability: null, grade_scale: 12 });
    expect(lastText()).toContain('пн-пт 2 год, сб 3 год, нд 1 год');
    expect(guide).toContain('пн-пт по 2 години, сб 3 години і нд 1 година');
    expect(guide).toContain('(за замовчуванням 07:30)');
  });

  it('understands the documented free time, digest time and time zone, and turns on lesson reminders', async () => {
    const U = 8092;
    await press('set:av:x', U);
    await say(fromGuide('пн-пт 2, сб 4, нд 0'), U);
    expect((await settingsOf(U)).availability).toBe('[120,120,120,120,120,240,0]');
    await press('set:av:x', U);
    await say(fromGuide('будні 1.5 год, вихідні 3'), U);
    expect((await settingsOf(U)).availability).toBe('[90,90,90,90,90,180,180]');
    await press('set:dg:x', U);
    await say(fromGuide('06:45'), U);
    await press('set:tz:x', U);
    await say(fromGuide('Europe/Vienna'), U);
    await press('set:ll:15', U);
    expect(await settingsOf(U)).toMatchObject({ tz: 'Europe/Vienna', digest_min: 6 * 60 + 45, lesson_lead: 15 });
  });

  it('asks before a scale change deletes grades, and before wiping all data', async () => {
    const U = 8093;
    await press('gr:add', U);
    await say('Математика 10', U);
    await press('set:gs:5', U);
    expect(String(tg.last('editMessageText')?.params.text)).toContain('їх буде видалено');
    expect((await settingsOf(U)).grade_scale).toBe(12);
    await press('set:wipe', U);
    expect(String(tg.last('editMessageText')?.params.text)).toContain('Це не можна скасувати');
    await press('set:wipe!', U);
    expect(await one('SELECT COUNT(*) AS n FROM grades WHERE user_id = ?', U)).toEqual({ n: 0 });
    expect((await settingsOf(U)).digest_min).toBeNull();
  });
});

describe('commands', () => {
  it('documents every command from the Telegram menu and no others', () => {
    const table = guide.slice(guide.indexOf('## Усі команди'), guide.indexOf('## Якщо бот'));
    const documented = [...table.matchAll(/^\| `\/(\w+)`/gm)].map((m) => m[1]);
    expect(documented).toEqual(COMMANDS.map((c) => c.command));
  });
});

describe('when the bot answers differently than expected', () => {
  it('leaves a dialog step with /cancel', async () => {
    const U = 8101;
    await press('sch:add', U);
    await say(fromGuide('/cancel'), U);
    expect(await one('SELECT state FROM users WHERE id = ?', U)).toEqual({ state: null });
  });

  it('explains a button under an old plan message', async () => {
    const U = 8102;
    await press('pl:r:ok', U);
    expect(toast()).toContain(fromGuide('Цей крок уже неактуальний'));
  });

  it('asks for a date it can read when there is none', async () => {
    const U = 8103;
    tg.setAi(() => JSON.stringify({ title: 'Реферат', date: null, time: null }));
    await say('/add', U);
    await say('реферат колись', U);
    expect(lastText()).toContain(fromGuide('Не знайшов дату чи час'));
    expect(lastText()).toContain(fromGuide('Есе з літератури 12.11 23:00'));
  });
});
