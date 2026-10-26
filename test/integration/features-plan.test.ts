/**
 * Наскрізні тести планування й обліку: майстер плану підготовки (НМТ та іспити),
 * оцінки, таймер і ручний облік часу, прогрес зі сторінкою графіків та налаштування.
 *
 * Кожен тест користується власним Telegram id, бо стан D1 живе протягом усього файлу.
 */

import { env } from 'cloudflare:workers';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleUpdate } from '../../src/bot/router';
import { Db } from '../../src/db';
import worker from '../../src/index';
import { localParts, ymdOf, ymdToString } from '../../src/time';
import { verifyChartsUrl } from '../../src/web/sign';
import { callbackUpdate, findButton, kyiv, mockFetch, textUpdate, type FetchMock, type TgCall } from '../helpers';

const BASE = 'https://bot.test';
const NOW = kyiv(2026, 10, 26, 18, 0); // понеділок, 18:00 за Києвом, зимовий час
const DEFAULT_AVAILABILITY = [120, 120, 120, 120, 120, 180, 60];

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
const editedText = () => String(tg.last('editMessageText')?.params.text ?? '');

interface UserRow {
  first_name: string | null;
  state: string | null;
  state_data: string | null;
  tz: string;
  digest_min: number | null;
  next_digest_at: number | null;
  lesson_lead: number;
  availability: string | null;
  grade_scale: number;
  timer_start: number | null;
  timer_subject: string | null;
}
const userOf = async (uid: number) => (await one<UserRow>('SELECT * FROM users WHERE id = ?', uid))!;
const draftOf = async (uid: number) => JSON.parse((await userOf(uid)).state_data!) as { step: string; selected: string[]; budget: number | null; subjects: Array<{ name: string; difficulty: number; level: number; exam: string | null }> };

interface PlanStep {
  id: number;
  subject: string | null;
  minutes: number | null;
  due_date: string | null;
  done: number;
}
const planSteps = (uid: number) =>
  all<PlanStep>("SELECT s.id, s.subject, s.minutes, s.due_date, s.done FROM steps s JOIN tasks t ON t.id = s.task_id WHERE t.user_id = ? AND t.kind = 'plan' ORDER BY s.id", uid);

/** Хвилини за предметами з текстової діаграми попереднього перегляду плану. */
function previewMinutes(text: string): Record<string, number> {
  const pre = /<pre>([\s\S]*?)<\/pre>/.exec(text)?.[1] ?? '';
  const out: Record<string, number> = {};
  for (const line of pre.split('\n')) {
    const m = /^(\S.*?)\s+[█▏▎▍▌▋▊▉]*\s+((?:\d+ год)?(?: ?\d+ хв)?) · \d+%$/.exec(line);
    if (!m) continue;
    const hours = /(\d+) год/.exec(m[2]);
    const mins = /(\d+) хв/.exec(m[2]);
    out[m[1].trim()] = (hours ? Number(hours[1]) * 60 : 0) + (mins ? Number(mins[1]) : 0);
  }
  return out;
}

function sumBy(steps: PlanStep[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of steps) out[s.subject!] = (out[s.subject!] ?? 0) + (s.minutes ?? 0);
  return out;
}

const weekdayIndex = (ymd: string) => (new Date(`${ymd}T00:00:00Z`).getUTCDay() + 6) % 7;

describe('plan wizard for NMT', () => {
  it('walks from subject choice to a saved plan with hours split by difficulty and level', async () => {
    const U = 2200;
    await press('pl:k:nmt', U);
    let draft = await draftOf(U);
    expect(draft.step).toBe('nmt_subjects');
    expect(draft.selected).toEqual(['ukr', 'math', 'hist']);
    expect(findButton(tg.last('sendMessage'), 'Українська мова')).toBe('pl:s:ukr');

    await press('pl:s:hist', U);
    await press('pl:s:phys', U);
    draft = await draftOf(U);
    expect(draft.selected).toEqual(['ukr', 'math', 'phys']);
    expect(tg.last('editMessageText')).toBeDefined();

    await press('pl:next', U);
    expect((await draftOf(U)).step).toBe('date');
    expect(lastText()).toContain('Коли НМТ?');
    expect(findButton(tg.last('sendMessage'), '20 травня 2027')).toBe('pl:d:auto');

    await press('pl:d:auto', U);
    draft = await draftOf(U);
    expect(draft.step).toBe('rate');
    expect(draft.subjects.map((s) => [s.name, s.exam])).toEqual([
      ['Українська мова', '2027-05-20'],
      ['Математика', '2027-05-20'],
      ['Фізика', '2027-05-20'],
    ]);
    expect(lastText()).toContain('Оціни кожен предмет');

    // Складність циклічно 3, 4, 5, потім знову 1; рівень так само.
    await press('pl:r:d:0', U);
    await press('pl:r:d:0', U);
    for (let i = 0; i < 3; i++) await press('pl:r:l:0', U);
    await press('pl:r:d:1', U);
    draft = await draftOf(U);
    expect(draft.subjects.map((s) => [s.difficulty, s.level])).toEqual([[5, 1], [4, 3], [3, 3]]);
    expect(editedText()).toContain('складність 4');

    await press('pl:r:n:0', U);
    expect(toast()).toBe('Натискай 💪 чи 📚 праворуч');

    await press('pl:r:ok', U);
    expect((await draftOf(U)).step).toBe('budget');
    expect(lastText()).toContain('Скільки годин усього');

    await say('12', U);
    draft = await draftOf(U);
    expect(draft.step).toBe('preview');
    expect(draft.budget).toBe(720);
    const preview = lastText();
    expect(preview).toContain('Розрахунок часу');
    const shown = previewMinutes(preview);
    expect(Object.keys(shown)).toEqual(['Українська мова', 'Математика', 'Фізика']);
    expect(Object.values(shown).reduce((a, b) => a + b, 0)).toBe(720);
    expect(shown['Українська мова']).toBeGreaterThan(shown['Математика']);
    expect(shown['Математика']).toBeGreaterThan(shown['Фізика']);
    expect(preview).toContain('у плані: <b>12 год</b>');
    expect(findButton(tg.last('sendMessage'), 'Зберегти план')).toBe('pl:save');

    await press('pl:save', U);
    expect(await one('SELECT state FROM users WHERE id = ?', U)).toEqual({ state: null });

    const deadlines = await all('SELECT title, due_at, all_day, importance FROM deadlines WHERE user_id = ?', U);
    expect(deadlines).toEqual([{ title: 'НМТ', due_at: kyiv(2027, 5, 20, 23, 59, 3), all_day: 1, importance: 3 }]);
    const deadline = await one<{ id: number }>('SELECT id FROM deadlines WHERE user_id = ?', U);
    expect((await one<{ n: number }>('SELECT COUNT(*) AS n FROM reminders WHERE deadline_id = ?', deadline!.id))!.n).toBeGreaterThan(0);
    expect(await one("SELECT kind, title, deadline_id FROM tasks WHERE user_id = ?", U)).toEqual({ kind: 'plan', title: 'Підготовка до НМТ', deadline_id: deadline!.id });

    const steps = await planSteps(U);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s.subject && s.minutes! > 0 && s.minutes! % 30 === 0 && s.due_date)).toBe(true);
    expect(sumBy(steps)).toEqual(shown);
    expect(steps.every((s) => s.due_date! < '2027-05-20')).toBe(true);
    expect(steps.every((s) => s.due_date! >= '2026-10-26')).toBe(true);
    expect(lastText()).toContain('Підготовка до НМТ');
    expect(tg.sent().some((t) => new RegExp(`${steps.length} занят(?:тя|ь), разом 12 год`).test(t))).toBe(true);

    // День не перевантажений понад вільний час, а один предмет за день не довший за дві години.
    const perDay = new Map<string, number>();
    const perSubjectDay = new Map<string, number>();
    for (const s of steps) {
      perDay.set(s.due_date!, (perDay.get(s.due_date!) ?? 0) + s.minutes!);
      const key = `${s.due_date}|${s.subject}`;
      perSubjectDay.set(key, (perSubjectDay.get(key) ?? 0) + s.minutes!);
    }
    for (const [day, minutes] of perDay) expect(minutes).toBeLessThanOrEqual(DEFAULT_AVAILABILITY[weekdayIndex(day)]);
    for (const minutes of perSubjectDay.values()) expect(minutes).toBeLessThanOrEqual(120);
  });

  it('logs plan step time under the step subject, not the plan title', async () => {
    const U = 2201;
    await press('pl:k:nmt', U);
    await press('pl:next', U);
    await press('pl:d:auto', U);
    await press('pl:r:ok', U);
    await say('6', U);
    await press('pl:save', U);

    const [first] = await planSteps(U);
    await press(`tk:s:${first.id}`, U);
    const log = await all<{ subject: string; minutes: number; day: string }>('SELECT subject, minutes, day FROM study_log WHERE user_id = ?', U);
    expect(log).toEqual([{ subject: first.subject!, minutes: first.minutes!, day: ymdToString(ymdOf(localParts(NOW, 'Europe/Kyiv'))) }]);
    expect(first.subject).not.toBe('Підготовка до НМТ');
  });

  it('refuses to continue without any chosen subject', async () => {
    const U = 2202;
    await press('pl:k:nmt', U);
    for (const code of ['ukr', 'math', 'hist']) await press(`pl:s:${code}`, U);
    expect((await draftOf(U)).selected).toEqual([]);
    await press('pl:next', U);
    expect(toast()).toBe('Обери хоча б один предмет');
    expect((await draftOf(U)).step).toBe('nmt_subjects');
  });

  it('keeps nothing on or after a close exam day and fills all free days before it', async () => {
    const U = 2203;
    await press('pl:k:nmt', U);
    await press('pl:next', U);
    await say('01.11.2026', U);
    const draft = await draftOf(U);
    expect(draft.step).toBe('rate');
    expect(draft.subjects.every((s) => s.exam === '2026-11-01')).toBe(true);

    await press('pl:r:ok', U);
    await press('pl:b:all', U);
    expect(lastText()).toContain('Розрахунок часу');
    await press('pl:save', U);

    const steps = await planSteps(U);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((s) => s.due_date! >= '2026-10-26' && s.due_date! <= '2026-10-31')).toBe(true);
    // Пн-пт по 2 год і субота 3 год: 13 годин вільного часу до 1 листопада.
    expect(steps.reduce((a, s) => a + s.minutes!, 0)).toBe(780);
  });

  it('rejects dates that are too close, too far or not dates at all', async () => {
    const U = 2204;
    await press('pl:k:nmt', U);
    await press('pl:next', U);

    await say('27.10.2026', U);
    expect(lastText()).toContain('щонайменше через 2 дні');
    await say('01.01.2030', U);
    expect(lastText()).toContain('не далі ніж за рік');
    await say('коли-небудь', U);
    expect(lastText()).toContain('Не бачу дати');
    expect((await draftOf(U)).step).toBe('date');
  });

  it('rejects invalid budgets and accepts decimal hours', async () => {
    const U = 2205;
    await press('pl:k:nmt', U);
    await press('pl:next', U);
    await press('pl:d:auto', U);
    await press('pl:r:ok', U);

    for (const bad of ['0', 'багато', '0,2']) {
      await say(bad, U);
      expect(lastText()).toContain('Напиши кількість годин числом');
      expect((await draftOf(U)).step).toBe('budget');
    }
    await say('1,5', U);
    expect((await draftOf(U)).budget).toBe(90);
    await say('2 год', U);
    expect((await draftOf(U)).budget).toBe(120);
  });

  it('applies an availability preset from the budget step', async () => {
    const U = 2206;
    await press('pl:k:nmt', U);
    await press('pl:next', U);
    await press('pl:d:auto', U);
    await press('pl:r:ok', U);
    await press('pl:av:a3', U);
    expect(JSON.parse((await userOf(U)).availability!)).toEqual([180, 180, 180, 180, 180, 240, 240]);
    expect(editedText()).toContain('пн-пт 3 год, сб-нд 4 год');
  });

  it('shows AI advice with the NMT facts for a draft plan', async () => {
    const U = 2207;
    tg.setAi(() => '**Українська мова**\n- Орфографія');
    await press('pl:k:nmt', U);
    await press('pl:next', U);
    await press('pl:d:auto', U);
    await press('pl:r:ok', U);
    await say('10', U);
    await press('pl:tips:0', U);
    expect(tg.aiRequests).toHaveLength(1);
    expect(String(tg.aiRequests[0].messages[0].content)).toContain('НМТ-2026');
    expect(String(tg.aiRequests[0].messages[1].content)).toContain('Українська мова');
    expect(lastText()).toContain('<b>Українська мова</b>');
  });

  it('reports a stale draft on pl:save', async () => {
    await press('pl:save', 2208);
    expect(toast()).toContain('неактуальний');
    expect(await all('SELECT id FROM tasks WHERE user_id = 2208')).toHaveLength(0);
  });
});

describe('plan wizard for exams', () => {
  it('parses subject lines with exam dates and schedules every subject before its exam', async () => {
    const U = 2210;
    await press('pl:k:exam', U);
    expect((await draftOf(U)).step).toBe('subjects_text');

    await say('Фізика 25.01\nВища математика 20.01\nАнглійська', U);
    const draft = await draftOf(U);
    expect(draft.step).toBe('rate');
    expect(draft.subjects.map((s) => [s.name, s.exam])).toEqual([
      ['Фізика', '2027-01-25'],
      ['Вища математика', '2027-01-20'],
      ['Англійська', null],
    ]);
    expect(lastText()).toContain('25 січня');

    await press('pl:r:ok', U);
    await press('pl:b:all', U);
    expect(lastText()).toContain('Розрахунок часу');
    await press('pl:save', U);

    const deadlines = await all<{ title: string; due_at: number; importance: number }>('SELECT title, due_at, importance FROM deadlines WHERE user_id = ? ORDER BY due_at', U);
    expect(deadlines).toEqual([
      { title: 'Іспит: Вища математика', due_at: kyiv(2027, 1, 20, 23, 59), importance: 3 },
      { title: 'Іспит: Фізика', due_at: kyiv(2027, 1, 25, 23, 59), importance: 3 },
    ]);
    expect(await one('SELECT title, kind FROM tasks WHERE user_id = ?', U)).toEqual({ title: 'Підготовка: Фізика, Вища математика, Англійська', kind: 'plan' });

    const steps = await planSteps(U);
    const bySubject = (name: string) => steps.filter((s) => s.subject === name);
    expect(bySubject('Фізика').length).toBeGreaterThan(0);
    expect(bySubject('Вища математика').length).toBeGreaterThan(0);
    expect(bySubject('Англійська').length).toBeGreaterThan(0);
    expect(bySubject('Фізика').every((s) => s.due_date! < '2027-01-25')).toBe(true);
    expect(bySubject('Вища математика').every((s) => s.due_date! < '2027-01-20')).toBe(true);
    expect(steps.every((s) => s.due_date! < '2027-01-25')).toBe(true);
  });

  it('splits 12 hours between three subjects by difficulty, level and exam date', async () => {
    const U = 2211;
    await press('pl:k:exam', U);
    await say('Математика 10.11\nФізика 20.11\nІсторія 15.11', U);
    await press('pl:r:d:1', U);
    await press('pl:r:d:1', U);
    await press('pl:r:l:2', U);
    await press('pl:r:l:2', U);
    expect((await draftOf(U)).subjects.map((s) => [s.difficulty, s.level])).toEqual([[3, 3], [5, 3], [3, 5]]);
    await press('pl:r:ok', U);

    await say('500', U);
    expect(lastText()).toContain('вільного часу до іспитів лише');
    await say('12', U);
    const preview = lastText();
    const shown = previewMinutes(preview);
    expect(Object.values(shown).reduce((a, b) => a + b, 0)).toBe(720);
    expect(shown['Фізика']).toBeGreaterThan(shown['Математика']);
    expect(shown['Математика']).toBeGreaterThan(shown['Історія']);

    await press('pl:save', U);
    const steps = await planSteps(U);
    expect(sumBy(steps)).toEqual(shown);
    const lastDay = (name: string) => steps.filter((s) => s.subject === name).map((s) => s.due_date!).sort().at(-1)!;
    expect(lastDay('Математика') < '2026-11-10').toBe(true);
    expect(lastDay('Історія') < '2026-11-15').toBe(true);
    expect(lastDay('Фізика') < '2026-11-20').toBe(true);
  });

  it('rejects past exam dates and empty subject lists', async () => {
    const U = 2212;
    await press('pl:k:exam', U);
    await say('Фізика 20.10.2026', U);
    expect(lastText()).toContain('Дата вже минула');
    await say(';', U);
    expect(lastText()).toContain('Не бачу жодного предмета');
    expect((await draftOf(U)).step).toBe('subjects_text');
  });

  it('asks the AI for advice on a saved plan by its task id', async () => {
    const U = 2213;
    tg.setAi(() => 'Порада');
    await press('pl:k:exam', U);
    await say('Хімія 30.11', U);
    await press('pl:r:ok', U);
    await say('4', U);
    await press('pl:save', U);
    const task = await one<{ id: number }>('SELECT id FROM tasks WHERE user_id = ?', U);
    await press(`pl:tips:${task!.id}`, U);
    expect(String(tg.aiRequests[0].messages[1].content)).toContain('Хімія: 4 год');
    expect(String(tg.aiRequests[0].messages[0].content)).not.toContain('НМТ-2026');
  });
});

describe('grades', () => {
  const gradeRows = (uid: number) => all<{ subject: string; value: number; weight: number }>('SELECT subject, value, weight FROM grades WHERE user_id = ? ORDER BY id', uid);

  it('records grades with weights and shows the averages', async () => {
    const U = 2300;
    await press('gr:add', U);
    await say('Математика 10 11 9\nФізика 8, 7x2\nАнглійська 12', U);

    expect(await gradeRows(U)).toEqual([
      { subject: 'Математика', value: 10, weight: 1 },
      { subject: 'Математика', value: 11, weight: 1 },
      { subject: 'Математика', value: 9, weight: 1 },
      { subject: 'Фізика', value: 8, weight: 1 },
      { subject: 'Фізика', value: 7, weight: 2 },
      { subject: 'Англійська', value: 12, weight: 1 },
    ]);
    expect(tg.sent().some((t) => t.includes('Записав 6 оцінок'))).toBe(true);
    const summary = lastText();
    expect(summary).toContain('7,33 (2)');
    expect(summary).toContain('10 (3)');
    expect(summary).toContain('Загальний середній: <b>9,78</b>');
    expect(summary).toContain('Найслабший предмет: <b>Фізика</b>');
  });

  it('reports lines outside the scale and keeps the valid ones', async () => {
    const U = 2301;
    await press('gr:add', U);
    await say('Біологія 15\nХімія 9', U);
    expect(await gradeRows(U)).toEqual([{ subject: 'Хімія', value: 9, weight: 1 }]);
    expect(tg.sent().some((t) => t.includes('Не зрозумів: Біологія 15'))).toBe(true);
  });

  it('keeps asking when nothing can be parsed', async () => {
    const U = 2302;
    await press('gr:add', U);
    await say('просто слова', U);
    expect(lastText()).toContain('Не вдалося розібрати оцінки');
    expect((await userOf(U)).state).toBe('grades_add');
  });

  it('computes the grades needed for a desired final grade', async () => {
    const U = 2303;
    await press('gr:add', U);
    await say('Математика 10 11 9\nФізика 8, 7x2\nАнглійська 12', U);

    await press('gr:target', U);
    expect((await userOf(U)).state).toBe('grade_target');
    // Предмети йдуть від найнижчого середнього: Фізика, Математика, Англійська.
    expect(findButton(tg.last('sendMessage'), 'Фізика')).toBe('gr:s:0');
    expect(findButton(tg.last('sendMessage'), 'Англійська')).toBe('gr:s:2');

    await press('gr:s:0', U);
    expect(lastText()).toContain('Фізика');
    expect(findButton(tg.last('sendMessage'), '10')).toBe('gr:g:0:10');

    await press('gr:g:0:10', U);
    const text = lastText();
    expect(text).toContain('середній має бути від 9,5');
    expect(text).toContain('3 оцінки: у середньому від <b>11,67</b>');
    expect(text).toContain('Найшвидший шлях: 3 оцінки по 12');
    expect(text).not.toContain('1 оцінка: у середньому');
    expect((await userOf(U)).state).toBeNull();
  });

  it('says the target is already reached when the average is high enough', async () => {
    const U = 2304;
    await press('gr:add', U);
    await say('Англійська 12 12', U);
    await press('gr:target', U);
    await press('gr:s:0', U);
    await press('gr:g:0:11', U);
    expect(lastText()).toContain('Уже виходить 11 або вище');
  });

  it('undoes the last grade and clears all grades with confirmation', async () => {
    const U = 2305;
    await press('gr:add', U);
    await say('Математика 10 11\nАнглійська 12', U);

    await press('gr:undo', U);
    expect(tg.sent().some((t) => t.includes('Видалив оцінку 12 з предмета Англійська'))).toBe(true);
    expect(await gradeRows(U)).toHaveLength(2);

    await press('gr:clr', U);
    expect(findButton(tg.last('sendMessage'), 'Так, видалити')).toBe('gr:clr!');
    expect(await gradeRows(U)).toHaveLength(2);
    await press('gr:clr!', U);
    expect(toast()).toBe('Оцінки видалено');
    expect(await gradeRows(U)).toHaveLength(0);
    expect(lastText()).toContain('Записуй оцінки');

    await press('gr:undo', U);
    expect(lastText()).toBe('Оцінок немає.');
  });
});

describe('timer and manual time log', () => {
  const logRows = (uid: number) => all<{ subject: string; minutes: number; day: string }>('SELECT subject, minutes, day FROM study_log WHERE user_id = ? ORDER BY id', uid);

  it('starts from the subject picker and writes the elapsed minutes on stop', async () => {
    const U = 2400;
    await press('tm:log', U);
    await say('45 хв математика', U);
    expect(await logRows(U)).toEqual([{ subject: 'Математика', minutes: 45, day: '2026-10-26' }]);

    await press('tm:start', U);
    expect((await userOf(U)).state).toBe('timer_pick');
    expect(findButton(tg.last('sendMessage'), 'Математика')).toBe('tm:go:0');

    await press('tm:go:0', U);
    let user = await userOf(U);
    expect(user.timer_start).toBe(NOW);
    expect(user.timer_subject).toBe('Математика');
    expect(user.state).toBeNull();

    await press('tm:stop', U, NOW + 50 * 60);
    user = await userOf(U);
    expect(user.timer_start).toBeNull();
    expect(user.timer_subject).toBeNull();
    expect(await logRows(U)).toEqual([
      { subject: 'Математика', minutes: 45, day: '2026-10-26' },
      { subject: 'Математика', minutes: 50, day: '2026-10-26' },
    ]);
    expect(lastText()).toContain('Записав <b>50 хв</b>');
    expect(lastText()).toContain('Сьогодні загалом 1 год 35 хв');
  });

  it('starts a timer from a typed subject and stops it with /timer', async () => {
    const U = 2401;
    await press('tm:start', U);
    await say('Біологія', U);
    expect((await userOf(U)).timer_subject).toBe('Біологія');
    expect(findButton(tg.last('sendMessage'), 'Стоп')).toBe('tm:stop');

    await say('/timer', U, NOW + 25 * 60);
    expect(await logRows(U)).toEqual([{ subject: 'Біологія', minutes: 25, day: '2026-10-26' }]);
  });

  it('refuses a second timer and a stop without a running timer', async () => {
    const U = 2402;
    await press('tm:stop', U);
    expect(lastText()).toBe('Таймер не запущено.');
    await say('/timer Хімія', U);
    await press('tm:start', U);
    expect(lastText()).toContain('Таймер уже йде');
    expect((await userOf(U)).timer_subject).toBe('Хімія');
  });

  it('writes nothing for a stop within a minute and caps very long sessions', async () => {
    const U = 2403;
    await say('/timer Історія', U);
    await press('tm:stop', U, NOW + 20);
    expect(lastText()).toContain('менше хвилини');
    expect(await logRows(U)).toHaveLength(0);

    await say('/timer Історія', U);
    await press('tm:stop', U, NOW + 9 * 3600);
    expect(await logRows(U)).toEqual([{ subject: 'Історія', minutes: 240, day: '2026-10-27' }]);
    expect(lastText()).toContain('понад 4 год');
  });

  it('understands several duration formats in the manual log', async () => {
    const U = 2404;
    for (const text of ['1.5 год фізика', '1:20 англійська', '30 хв']) {
      await press('tm:log', U);
      await say(text, U);
    }
    expect(await logRows(U)).toEqual([
      { subject: 'Фізика', minutes: 90, day: '2026-10-26' },
      { subject: 'Англійська', minutes: 80, day: '2026-10-26' },
      { subject: 'Навчання', minutes: 30, day: '2026-10-26' },
    ]);
  });

  it('keeps waiting when the log text has no duration', async () => {
    const U = 2405;
    await press('tm:log', U);
    await say('вчив математику', U);
    expect(lastText()).toContain('Не бачу тривалості');
    expect((await userOf(U)).state).toBe('log_time');
    expect(await logRows(U)).toHaveLength(0);
  });
});

describe('progress and charts', () => {
  async function seedProgress(uid: number, now: number): Promise<{ stepIds: number[] }> {
    const db = new Db(env.DB);
    const today = ymdToString(ymdOf(localParts(now, 'Europe/Kyiv')));
    await handleUpdate(env, textUpdate('/start', uid), BASE, now);
    const taskId = await db.createTask(
      uid,
      'Проєкт',
      'split',
      null,
      [1, 2, 3, 4].map((n) => ({ text: `Крок ${n}`, minutes: 30, due_date: today })),
      now,
    );
    const steps = await all<{ id: number }>('SELECT id FROM steps WHERE task_id = ? ORDER BY pos', taskId);
    return { stepIds: steps.map((s) => s.id) };
  }

  const webAppUrl = (call: TgCall | undefined): string | undefined => {
    const rows: Array<Array<{ web_app?: { url: string } }>> = call?.params.reply_markup?.inline_keyboard ?? [];
    return rows.flat().find((b) => b.web_app)?.web_app?.url;
  };

  it('shows percentages of completed work and a verifiable charts link', async () => {
    const U = 2500;
    const { stepIds } = await seedProgress(U, NOW);
    await press(`tk:s:${stepIds[0]}`, U);
    await press(`tk:s:${stepIds[1]}`, U);
    await new Db(env.DB).addStudy(U, 'Фізика', 60, '2026-10-25', NOW);

    await say('/progress', U);
    const text = lastText();
    expect(text).toContain('Кроки й заняття за 7 днів: <b>2 з 4</b> (50%)');
    expect(text).toContain('Усього виконано: <b>2 з 4</b> кроків (50%)');
    expect(text).toContain('Сьогодні: <b>1 год</b> · за 7 днів: <b>2 год</b>');
    expect(text).toContain('Час навчання за 7 днів');
    expect(text).toContain('Фізика');

    const url = webAppUrl(tg.last('sendMessage'));
    expect(url).toBeDefined();
    expect(url!.startsWith(`${BASE}/charts?`)).toBe(true);
    expect(await verifyChartsUrl(env, new URL(url!), NOW)).toBe(U);
    expect(await verifyChartsUrl(env, new URL(url!), NOW + 25 * 3600)).toBeNull();
  });

  it('counts completed deadlines and warns about overdue open ones', async () => {
    const U = 2501;
    await say('/add Звіт з практики 30.10 18:00', U);
    await say('/add Лабораторна 27.10 18:00', U);
    const done = await one<{ id: number }>("SELECT id FROM deadlines WHERE user_id = ? AND title = 'Звіт з практики'", U);
    await press(`dl:ok:${done!.id}`, U);

    await say('/progress', U);
    expect(lastText()).toContain('виконано 1, з них вчасно 1');
    expect(lastText()).not.toContain('прострочених відкритих');

    await say('/progress', U, kyiv(2026, 10, 29, 9, 0));
    expect(lastText()).toContain('прострочених відкритих: 1');
  });

  it('explains how to get charts when nothing is logged yet', async () => {
    const U = 2502;
    await say('/progress', U);
    expect(lastText()).toContain('Щоб тут з\'явилися графіки');
    expect(lastText()).toContain('немає даних');
  });

  it('serves the charts page for a signed link and rejects tampered ones', async () => {
    const U = 2503;
    const real = Math.floor(Date.now() / 1000);
    const { stepIds } = await seedProgress(U, real);
    await press(`tk:s:${stepIds[0]}`, U, real);
    const today = ymdToString(ymdOf(localParts(real, 'Europe/Kyiv')));
    await new Db(env.DB).addStudy(U, 'Хімія', 90, today, real);
    await new Db(env.DB).addGrades(U, [{ subject: 'Алгебра', value: 11, weight: 1 }], real);

    await say('/progress', U, real);
    const url = webAppUrl(tg.last('sendMessage'))!;

    const get = async (u: string) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(u), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };

    const ok = await get(url);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/html');
    expect(ok.headers.get('cache-control')).toBe('no-store');
    const html = await ok.text();
    for (const section of ['Час навчання по днях', 'Виконані завдання', 'Час за предметами', 'Середній бал за предметами']) {
      expect(html).toContain(section);
    }
    expect(html).toContain('Хімія');
    expect(html).toContain('Алгебра');
    expect(html).toContain('1 год 30 хв');

    const parsed = new URL(url);
    const sig = parsed.searchParams.get('s')!;
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    const tampered = new URL(url);
    tampered.searchParams.set('s', flipped);
    const bad = await get(tampered.href);
    expect(bad.status).toBe(403);
    expect(await bad.text()).toContain('Посилання застаріло');

    const otherUser = new URL(url);
    otherUser.searchParams.set('u', String(U + 1));
    expect((await get(otherUser.href)).status).toBe(403);

    const noSig = new URL(url);
    noSig.searchParams.delete('s');
    expect((await get(noSig.href)).status).toBe(403);
  });

  it('returns 404 for a correctly signed link of a user that does not exist and 403 for an expired one', async () => {
    const { chartsUrl } = await import('../../src/web/sign');
    const real = Math.floor(Date.now() / 1000);
    const get = async (u: string) => {
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(u), env, ctx);
      await waitOnExecutionContext(ctx);
      return res;
    };
    expect((await get(await chartsUrl(env, BASE, 987654321, real))).status).toBe(404);
    expect((await get(await chartsUrl(env, BASE, 987654321, real - 3 * 86400))).status).toBe(403);
  });
});

describe('settings', () => {
  const nextDigest = async (uid: number) => (await userOf(uid)).next_digest_at;
  const utc = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi) / 1000;

  it('computes the first digest time in the default zone around the autumn DST change', async () => {
    await say('/start', 2600, kyiv(2026, 10, 24, 20, 0, 3));
    // Після переходу на зимовий час 07:30 за Києвом це 05:30 UTC, а не 04:30.
    expect(await nextDigest(2600)).toBe(utc(2026, 10, 25, 5, 30));
  });

  it('computes the first digest time around the spring DST change', async () => {
    await say('/start', 2601, kyiv(2027, 3, 27, 20, 0, 2));
    expect(await nextDigest(2601)).toBe(utc(2027, 3, 28, 4, 30));
  });

  it('recomputes next_digest_at when the time zone changes', async () => {
    const U = 2602;
    await say('/start', U);
    expect(await nextDigest(U)).toBe(kyiv(2026, 10, 27, 7, 30));

    await press('set:tz', U);
    expect(editedText()).toContain('часовий пояс');
    expect(findButton(tg.last('editMessageText'), 'Warsaw')).toBe('set:tz:1');

    await press('set:tz:1', U);
    expect((await userOf(U)).tz).toBe('Europe/Warsaw');
    expect(await nextDigest(U)).toBe(utc(2026, 10, 27, 6, 30));
    expect(editedText()).toContain('Europe/Warsaw');

    await press('set:tz:4', U);
    expect(await nextDigest(U)).toBe(utc(2026, 10, 27, 7, 30));
    // Нью-Йорк ще на літньому часі (UTC-4) до 1 листопада.
    await press('set:tz:6', U);
    expect(await nextDigest(U)).toBe(utc(2026, 10, 27, 11, 30));
    await press('set:tz:7', U);
    expect(await nextDigest(U)).toBe(utc(2026, 10, 27, 3, 30));
  });

  it('accepts a custom IANA zone by text and rejects an unknown one', async () => {
    const U = 2603;
    await say('/start', U);
    await press('set:tz:x', U);
    expect((await userOf(U)).state).toBe('set_tz');
    await say('Mars/Olympus', U);
    expect(lastText()).toContain('Не знаю такого поясу');
    expect((await userOf(U)).state).toBe('set_tz');

    await say('Europe/Vienna', U);
    const user = await userOf(U);
    expect(user.tz).toBe('Europe/Vienna');
    expect(user.state).toBeNull();
    expect(user.next_digest_at).toBe(utc(2026, 10, 27, 6, 30));
  });

  it('turns the digest off, back on and to a custom time', async () => {
    const U = 2604;
    await say('/start', U);
    await press('set:dg:off', U);
    let user = await userOf(U);
    expect(user.digest_min).toBeNull();
    expect(user.next_digest_at).toBeNull();
    expect(editedText()).toContain('вимкнено');

    // Зміна поясу при вимкненому зведенні не вмикає його знову.
    await press('set:tz:1', U);
    expect((await userOf(U)).next_digest_at).toBeNull();

    await press('set:dg:480', U);
    user = await userOf(U);
    expect(user.digest_min).toBe(480);
    expect(user.next_digest_at).toBe(utc(2026, 10, 27, 7, 0));

    await press('set:dg:x', U);
    expect((await userOf(U)).state).toBe('set_digest');
    await say('не час', U);
    expect(lastText()).toContain('Не зрозумів час');
    expect((await userOf(U)).state).toBe('set_digest');

    await say('06:45', U);
    user = await userOf(U);
    expect(user.digest_min).toBe(405);
    expect(user.state).toBeNull();
    expect(user.next_digest_at).toBe(utc(2026, 10, 27, 5, 45));
  });

  it('moves a digest set into the spring DST gap to the first valid moment after it', async () => {
    const U = 2605;
    const now = kyiv(2027, 3, 27, 20, 0, 2);
    await say('/start', U, now);
    await press('set:dg:x', U, now);
    await say('03:30', U, now);
    expect(await nextDigest(U)).toBe(utc(2027, 3, 28, 1, 30));
  });

  it('sets the lesson reminder lead only to the offered values', async () => {
    const U = 2606;
    await say('/start', U);
    await press('set:ll:15', U);
    expect((await userOf(U)).lesson_lead).toBe(15);
    await press('set:ll:7', U);
    expect((await userOf(U)).lesson_lead).toBe(15);
    await press('set:ll:0', U);
    expect((await userOf(U)).lesson_lead).toBe(0);
  });

  it('stores free-time presets and custom text', async () => {
    const U = 2607;
    await say('/start', U);
    await press('set:av:a2', U);
    expect(JSON.parse((await userOf(U)).availability!)).toEqual([120, 120, 120, 120, 120, 180, 180]);

    await press('set:av:x', U);
    expect((await userOf(U)).state).toBe('set_avail');
    await say('пн-пт 1.5, сб 4, нд 0', U);
    expect(JSON.parse((await userOf(U)).availability!)).toEqual([90, 90, 90, 90, 90, 240, 0]);
    expect((await userOf(U)).state).toBeNull();
    expect(lastText()).toContain('пн-пт 1 год 30 хв, сб 4 год, нд вихідний');

    await press('set:av:x', U);
    await say('будні 2 год, вихідні 45 хв', U);
    expect(JSON.parse((await userOf(U)).availability!)).toEqual([120, 120, 120, 120, 120, 45, 45]);

    await press('set:av:x', U);
    await say('коли як', U);
    expect(lastText()).toContain('Не зрозумів');
    expect((await userOf(U)).state).toBe('set_avail');
  });

  it('changes the grade scale and validates new grades against it', async () => {
    const U = 2608;
    await say('/start', U);
    await press('set:gs:5', U);
    expect((await userOf(U)).grade_scale).toBe(5);
    expect(editedText()).toContain('5-бальна');

    await press('gr:add', U);
    expect(lastText()).toContain('5-бальна');
    await say('Математика 5 4\nФізика 7', U);
    expect((await all('SELECT subject FROM grades WHERE user_id = ?', U)).length).toBe(2);
    expect(tg.sent().some((t) => t.includes('Не зрозумів: Фізика 7'))).toBe(true);

    await press('set:gs:100', U);
    // Оцінки вже є, тож бот просить підтвердити, що їх буде видалено.
    expect((await userOf(U)).grade_scale).toBe(5);
    expect(findButton(tg.last('editMessageText'), 'Так, видалити')).toBe('set:gs!:100');
    await press('set:gs!:100', U);
    expect((await userOf(U)).grade_scale).toBe(100);
    expect(await all('SELECT id FROM grades WHERE user_id = ?', U)).toHaveLength(0);
    await press('gr:add', U);
    await say('Історія 0 95', U);
    expect((await all('SELECT value FROM grades WHERE user_id = ? AND subject = ?', U, 'Історія')).length).toBe(2);

    await press('set:gs:7', U);
    expect((await userOf(U)).grade_scale).toBe(100);
  });

  it('wipes every row of the user and nothing of anybody else', async () => {
    const db = new Db(env.DB);
    const seed = async (uid: number) => {
      await say('/start', uid);
      await db.addLessons(uid, [{ weekday: 1, start: 480, end: null, title: 'Урок' }]);
      const deadlineId = await db.addDeadline(uid, 'Звіт', kyiv(2026, 11, 5, 12, 0), false, [kyiv(2026, 11, 4, 12, 0)], NOW);
      const taskId = await db.createTask(uid, 'Завдання', 'split', deadlineId, [{ text: 'Крок', minutes: 30, due_date: '2026-10-27' }], NOW);
      const step = await one<{ id: number }>('SELECT id FROM steps WHERE task_id = ?', taskId);
      await db.toggleStep(uid, step!.id, NOW, '2026-10-26');
      await db.createQuiz(uid, 'Тема', [], NOW);
      await db.addStudy(uid, 'Фізика', 30, '2026-10-26', NOW);
      await db.addGrades(uid, [{ subject: 'Математика', value: 10, weight: 1 }], NOW);
    };
    const tables: Array<[string, string]> = [
      ['lessons', 'user_id'],
      ['deadlines', 'user_id'],
      ['reminders', 'user_id'],
      ['tasks', 'user_id'],
      ['steps', 'user_id'],
      ['quizzes', 'user_id'],
      ['study_log', 'user_id'],
      ['grades', 'user_id'],
      ['users', 'id'],
    ];
    const counts = async (uid: number) => {
      const out: Record<string, number> = {};
      for (const [table, col] of tables) out[table] = (await one<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`, uid))!.n;
      return out;
    };

    await seed(2610);
    await seed(2611);
    const before = await counts(2611);
    expect(Object.values(await counts(2610)).every((n) => n > 0)).toBe(true);

    await press('set:wipe', 2610);
    expect(findButton(tg.last('editMessageText'), 'Так, видалити все')).toBe('set:wipe!');
    expect(Object.values(await counts(2610)).every((n) => n > 0)).toBe(true);

    await press('set:wipe!', 2610);
    expect(editedText()).toContain('Усі твої дані видалено');
    // Лишається тільки службовий рядок users з лічильником запитів до ШІ, без особистих даних.
    const after = await counts(2610);
    expect(Object.entries(after).every(([table, n]) => (table === 'users' ? n === 1 : n === 0))).toBe(true);
    expect((await userOf(2610)).first_name).toBeNull();
    expect(await counts(2611)).toEqual(before);

    await say('/start', 2610);
    expect((await counts(2610)).users).toBe(1);
  });
});
