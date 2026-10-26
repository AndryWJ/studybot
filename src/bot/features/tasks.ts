/**
 * Велике завдання, розбите на маленькі кроки: генерація кроків через ШІ,
 * розподіл кроків по вільних днях до дедлайну, чекліст із кнопками.
 * Тут же картка плану підготовки (теж завдання, але з заняттями по днях).
 */

import { completeJson } from '../../ai/client';
import { buildSplit, parseSplit } from '../../ai/prompts';
import type { Step, Task } from '../../db';
import { escapeHtml, truncate } from '../../format';
import { parseDeadline } from '../../parse';
import { allocateSteps, parseAvailability } from '../../planner';
import { reminderTimes } from '../../reminders';
import {
  addDays,
  compareYmd,
  daysBetween,
  formatDate,
  formatDuration,
  formatMoment,
  localParts,
  parseYmd,
  WEEKDAYS_SHORT,
  weekdayOf,
  ymdOf,
  ymdToString,
  type Ymd,
} from '../../time';
import { nowLine, reply, setState, today, withAi, type Ctx } from '../context';
import { btn, CANCEL_ROW, grid, kb } from '../ui';

/** Починає розбиття завдання: ставить крок "split" і просить опис із дедлайном. */
export async function startSplit(ctx: Ctx): Promise<void> {
  await setState(ctx, 'split');
  await reply(
    ctx,
    '🧩 Опиши велике завдання, і я розіб\'ю його на кроки та розкладу їх по твоїх вільних днях. ' +
      'Якщо є дедлайн, допиши його.\n\n<i>Наприклад: написати курсову з історії на 25 сторінок до 15 грудня</i>',
    { reply_markup: kb(CANCEL_ROW) },
  );
}

/** Текст нового завдання: розбирає дедлайн (якщо є, записує його з нагадуваннями) і генерує кроки. */
export async function onSplitText(ctx: Ctx, text: string): Promise<void> {
  // Повторно надісланий текст, поки ШІ ще думає над першим, не має створити друге завдання.
  if (ctx.user.state === 'split' && !(await ctx.db.claimState(ctx.user.id, 'split', ctx.user.state_data))) return;
  ctx.user.state = null;
  const parsed = parseDeadline(text, ctx.now, ctx.user.tz);
  const deadline = parsed && parsed.due > ctx.now ? parsed : null;
  const created = await createSplit(ctx, text, deadline, null);
  if (!created) await setState(ctx, 'split');
}

/** Розбиває на кроки вже записаний дедлайн. */
export async function splitDeadline(ctx: Ctx, deadlineId: number): Promise<void> {
  const d = await ctx.db.getDeadline(ctx.user.id, deadlineId);
  if (!d) {
    await reply(ctx, 'Цього дедлайну вже немає.');
    return;
  }
  const existing = await ctx.db.splitTaskForDeadline(ctx.user.id, d.id);
  if (existing !== null) {
    await showTask(ctx, existing);
    return;
  }
  await createSplit(ctx, d.title, { title: d.title, due: d.due_at, allDay: Boolean(d.all_day) }, d.id);
}

/** Генерує кроки й зберігає завдання. Повертає false, якщо ШІ не відповів. */
async function createSplit(
  ctx: Ctx,
  taskText: string,
  deadline: { title: string; due: number; allDay: boolean } | null,
  existingDeadlineId: number | null,
): Promise<boolean> {
  const tz = ctx.user.tz;
  const note = deadline ? formatMoment(deadline.due, tz, deadline.allDay, ctx.now) : null;
  const result = await withAi(ctx, () =>
    completeJson(ctx.env, { messages: buildSplit(truncate(taskText, 2000), nowLine(ctx), note), maxTokens: 1500, temperature: 0.4 }, parseSplit),
  );
  if (!result) return false;
  const { title, steps, tip } = result.data;

  let deadlineId = existingDeadlineId;
  let createdDeadline = false;
  if (deadline && deadlineId === null) {
    deadlineId = await ctx.db.addDeadline(ctx.user.id, title, deadline.due, deadline.allDay, reminderTimes(deadline.due, deadline.allDay, ctx.now, tz), ctx.now);
    createdDeadline = true;
  }
  const from = today(ctx);
  const dueDate = deadline ? ymdOf(localParts(deadline.due, tz)) : null;
  const busy = await ctx.db.busyByDate(ctx.user.id, ymdToString(from));
  const allocation = allocateSteps(steps.map((s) => s.minutes), from, dueDate, parseAvailability(ctx.user.availability), busy);
  const taskId = await ctx.db.createTask(
    ctx.user.id,
    title,
    'split',
    deadlineId,
    steps.map((s, i) => ({ text: s.text, minutes: s.minutes ?? 45, due_date: allocation.dates[i] ?? null })),
    ctx.now,
  );
  await setState(ctx, null);
  await showTask(ctx, taskId);

  const extra: string[] = [];
  const total = steps.reduce((a, s) => a + (s.minutes ?? 45), 0);
  extra.push(`⏱ Орієнтовно ${formatDuration(total)} роботи. Кроки розкладено по днях з урахуванням твого вільного часу (⚙️ Налаштування).`);
  if (allocation.overload > 0) {
    extra.push(`⚠️ Часу впритул: до дедлайну бракує близько ${formatDuration(allocation.overload)} вільного часу. Кроки розподілено рівномірно, але доведеться вчитися більше звичного.`);
  }
  if (tip) extra.push(`💡 ${escapeHtml(tip)}`);
  if (createdDeadline && deadline) extra.push(`⏰ Також записав дедлайн на ${formatMoment(deadline.due, tz, deadline.allDay, ctx.now)} з нагадуваннями.`);
  await reply(ctx, extra.join('\n\n'));
  return true;
}

/** Смуга з 10 клітинок за часткою виконаного. */
function progressBar(done: number, total: number): string {
  const filled = total ? Math.round((done / total) * 10) : 0;
  return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
}

/** Відсоток виконаного, 0 для порожнього списку. */
function percent(done: number, total: number): number {
  return total ? Math.round((done / total) * 100) : 0;
}

/** Рядок кроку чекліста; невиконаний крок із датою в минулому позначається попередженням, дата показується за `withDate`. */
function stepLine(s: Step, todayYmd: Ymd, withDate: boolean): string {
  const date = s.due_date ? parseYmd(s.due_date) : null;
  const late = !s.done && date && compareYmd(date, todayYmd) < 0 ? ' ⚠️' : '';
  const when = withDate && date ? ` <i>(${formatDate(date, todayYmd)})</i>` : '';
  const dur = s.minutes ? ` · ${formatDuration(s.minutes)}` : '';
  return `${s.done ? '✅' : '⬜'} ${s.pos}. ${escapeHtml(s.text)}${dur}${when}${late}`;
}

/**
 * Кроки, які показувати в картці плану: невиконані з минулих днів і всі на
 * найближчі 7 днів, не більше 15.
 */
export function planWindow(steps: Step[], todayYmd: Ymd): Step[] {
  const until = addDays(todayYmd, 6);
  return steps
    .filter((s) => {
      const d = s.due_date ? parseYmd(s.due_date) : null;
      if (!d) return !s.done;
      if (compareYmd(d, todayYmd) < 0) return !s.done;
      return compareYmd(d, until) <= 0;
    })
    .slice(0, 15);
}

/** Текст картки завдання чи плану з прогресом. Для плану показує лише `planWindow`, згруповане по днях. */
export function taskHtml(task: Task, steps: Step[], todayYmd: Ymd): string {
  const done = steps.filter((s) => s.done).length;
  const head = `${progressBar(done, steps.length)} ${percent(done, steps.length)}% (${done}/${steps.length})`;
  if (task.kind === 'plan') {
    const minutesTotal = steps.reduce((a, s) => a + (s.minutes ?? 0), 0);
    const minutesDone = steps.reduce((a, s) => a + (s.done ? (s.minutes ?? 0) : 0), 0);
    const visible = planWindow(steps, todayYmd);
    const byDay: string[] = [];
    let currentDay = '';
    for (const s of visible) {
      const d = s.due_date ? parseYmd(s.due_date) : null;
      const label = d ? (daysBetween(todayYmd, d) === 0 ? 'Сьогодні' : formatDate(d, todayYmd)) : 'Без дати';
      if (label !== currentDay) {
        byDay.push(`\n<b>${label}</b>`);
        currentDay = label;
      }
      byDay.push(stepLine(s, todayYmd, false));
    }
    const finished = steps.length > 0 && done === steps.length ? '\n\n🎉 План виконано повністю!' : '';
    return (
      `🎯 <b>${escapeHtml(task.title)}</b>\n${head}\n⏱ Пройдено ${formatDuration(minutesDone)} з ${formatDuration(minutesTotal)}\n` +
      (byDay.length ? byDay.join('\n') : '\nНа найближчий тиждень занять немає.') +
      `${finished}\n\nНатискай номер заняття, коли його пройдеш: час запишеться в 📊 Прогрес.`
    );
  }
  const lines = steps.map((s) => stepLine(s, todayYmd, true));
  const finished = steps.length > 0 && done === steps.length ? '\n\n🎉 Усі кроки виконано! Чудова робота!' : '';
  return `🧩 <b>${escapeHtml(task.title)}</b>\n${head}\n\n${lines.join('\n')}${finished}\n\nНатискай номер кроку, щоб позначити його виконаним.`;
}

/** Кнопки кроків (для плану лише з вікна `planWindow`, для завдання до 30), поради ШІ для плану, видалення і список. */
function taskKeyboard(task: Task, steps: Step[], todayYmd: Ymd) {
  const shown = task.kind === 'plan' ? planWindow(steps, todayYmd) : steps.slice(0, 30);
  const stepButtons = shown.map((s) => btn(`${s.done ? '✅' : '⬜'} ${s.pos}`, `tk:s:${s.id}`));
  return kb(
    ...grid(stepButtons, 5),
    task.kind === 'plan' ? [btn('🤖 Що вчити: поради ШІ', `pl:tips:${task.id}`)] : [],
    [btn('🗑 Видалити', `tk:rm:${task.id}`), btn('📋 Усі завдання', 'tk:list')],
  );
}

/**
 * Показує картку завдання; з `editMessageId` редагує те повідомлення, інакше надсилає нове.
 * Якщо завдання немає, повідомляє про це.
 */
export async function showTask(ctx: Ctx, taskId: number, editMessageId?: number): Promise<void> {
  const found = await ctx.db.getTask(ctx.user.id, taskId);
  if (!found) {
    if (editMessageId) await ctx.tg.editHtml(ctx.chatId, editMessageId, 'Цього завдання вже немає.');
    else await reply(ctx, 'Цього завдання вже немає.');
    return;
  }
  const t = today(ctx);
  const html = taskHtml(found.task, found.steps, t);
  const keyboard = taskKeyboard(found.task, found.steps, t);
  if (editMessageId) await ctx.tg.editHtml(ctx.chatId, editMessageId, html, keyboard);
  else await reply(ctx, html, { reply_markup: keyboard });
}

/** Перемикає крок і оновлює чекліст; коли все виконано, пропонує закрити пов'язаний дедлайн. */
export async function toggleStep(ctx: Ctx, stepId: number, messageId: number): Promise<void> {
  const taskId = await ctx.db.toggleStep(ctx.user.id, stepId, ctx.now, ymdToString(today(ctx)));
  if (taskId === null) return;
  await showTask(ctx, taskId, messageId);
  const found = await ctx.db.getTask(ctx.user.id, taskId);
  if (!found || !found.task.deadline_id) return;
  const allDone = found.steps.length > 0 && found.steps.every((s) => s.done);
  if (!allDone) return;
  const d = await ctx.db.getDeadline(ctx.user.id, found.task.deadline_id);
  if (d && !d.done) {
    await reply(ctx, `Усі кроки готові. Позначити дедлайн <b>${escapeHtml(d.title)}</b> виконаним?`, {
      reply_markup: kb([btn('✅ Так', `dl:ok:${d.id}`)]),
    });
  }
}

/** Показує список завдань і планів із відсотком виконання; з `editMessageId` редагує те повідомлення. */
export async function listTasks(ctx: Ctx, editMessageId?: number): Promise<void> {
  const tasks = await ctx.db.listTasks(ctx.user.id);
  const html = tasks.length
    ? '📋 <b>Твої завдання і плани</b>\n\nНатисни, щоб відкрити.'
    : '📋 Завдань поки немає. Натисни 🧩 Розбити завдання або 🎯 План підготовки, щоб створити перше.';
  const keyboard = kb(
    ...tasks.map((t) => [btn(`${t.kind === 'plan' ? '🎯' : '🧩'} ${truncate(t.title, 36)} · ${percent(t.done_count, t.total)}%`, `tk:v:${t.id}`)]),
    [btn('🧩 Нове завдання', 'tk:new')],
  );
  if (editMessageId) await ctx.tg.editHtml(ctx.chatId, editMessageId, html, keyboard);
  else await reply(ctx, html, { reply_markup: keyboard });
}

/** Короткий підпис дня тижня для дати 'YYYY-MM-DD': "пн 26.10". */
export function shortDay(ymd: string): string {
  const d = parseYmd(ymd);
  if (!d) return ymd;
  return `${WEEKDAYS_SHORT[weekdayOf(d) - 1]} ${String(d.day).padStart(2, '0')}.${String(d.month).padStart(2, '0')}`;
}
