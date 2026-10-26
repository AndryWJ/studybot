/**
 * Дедлайни: додавання з вільного тексту, важливість і складність, список,
 * упорядкований за пріоритетом, кнопки "виконано", "розбити на кроки",
 * "видалити", а також запис нагадувань.
 */

import { completeJson } from '../../ai/client';
import { buildDeadlineExtract, parseDeadlineExtract } from '../../ai/prompts';
import type { Deadline } from '../../db';
import { escapeHtml, truncate } from '../../format';
import { parseDeadline, type ParsedDeadline } from '../../parse';
import { priorityLevel, priorityScore, PRIORITY_ICON } from '../../planner';
import { reminderTimes } from '../../reminders';
import type { InlineKeyboard } from '../../telegram';
import { formatMoment, plural, relativeLabel, zonedToEpoch } from '../../time';
import { nowLine, reply, setState, withAi, type Ctx } from '../context';
import { btn, CANCEL_ROW, kb } from '../ui';

const IMPORTANCE = ['', 'низька', 'середня', 'висока'];
const DIFFICULTY = ['', 'легко', 'середньо', 'важко'];

/** Кнопки важливості й складності під повідомленням про новий дедлайн. */
export function ratingKeyboard(id: number, importance: number, difficulty: number): InlineKeyboard {
  return kb(
    [1, 2, 3].map((v) => btn(`${v === importance ? '✅' : '❗'} ${IMPORTANCE[v]}`, `dl:i:${id}:${v}`)),
    [1, 2, 3].map((v) => btn(`${v === difficulty ? '✅' : '💪'} ${DIFFICULTY[v]}`, `dl:c:${id}:${v}`)),
    [btn('🧩 Розбити на кроки', `dl:sp:${id}`), btn('📋 Усі дедлайни', 'dl:list')],
  );
}

const ADD_HELP = `⏰ Напиши, що і коли треба здати. Наприклад:

<code>Реферат з біології 15.11 18:00</code>
<code>Курсова з історії до 20 грудня</code>
<code>Контрольна з фізики в четвер о 10</code>
<code>Взяти форму на фізру завтра</code>

Якщо час не вказати, вважатиму, що дедлайн до кінця дня.`;

/** Починає діалог додавання дедлайну: ставить крок "deadline_add" і надсилає підказку з прикладами. */
export async function startAddDeadline(ctx: Ctx): Promise<void> {
  await setState(ctx, 'deadline_add');
  await reply(ctx, ADD_HELP, { reply_markup: kb(CANCEL_ROW) });
}

/**
 * Розбирає дату з тексту: спершу без ШІ, а якщо не вийшло і `useAi`, то через ШІ.
 * Повертає null, якщо дати в тексті немає, і 'ai-failed', якщо ШІ не відповів або
 * денний ліміт вичерпано (про це людина вже отримала повідомлення від `withAi`).
 */
export async function resolveDeadline(ctx: Ctx, text: string, useAi: boolean): Promise<ParsedDeadline | null | 'ai-failed'> {
  const parsed = parseDeadline(text, ctx.now, ctx.user.tz);
  if (parsed || !useAi) return parsed;
  const result = await withAi(ctx, () =>
    completeJson(ctx.env, { messages: buildDeadlineExtract(text, nowLine(ctx)), maxTokens: 400, temperature: 0 }, parseDeadlineExtract),
  );
  if (!result) return 'ai-failed';
  const { title, date, time } = result.data;
  if (!date) return null;
  const minutes = time ?? 23 * 60 + 59;
  return {
    title,
    due: zonedToEpoch(date.year, date.month, date.day, Math.floor(minutes / 60), minutes % 60, ctx.user.tz),
    allDay: time === null,
  };
}

/** Обробляє текст нового дедлайну. Повертає true, якщо дедлайн збережено. */
export async function onDeadlineText(ctx: Ctx, text: string): Promise<boolean> {
  const parsed = await resolveDeadline(ctx, text, true);
  if (parsed === 'ai-failed') {
    await reply(ctx, 'Без ШІ я розумію дату, записану цифрами чи словами, наприклад: <code>Есе з літератури 12.11 23:00</code>', {
      reply_markup: kb(CANCEL_ROW),
    });
    return false;
  }
  return onDeadlineParsed(ctx, parsed);
}

/** Перевіряє вже розібраний дедлайн (дата знайдена, не в минулому) і зберігає його. */
export async function onDeadlineParsed(ctx: Ctx, parsed: ParsedDeadline | null): Promise<boolean> {
  if (!parsed) {
    if (ctx.user.state === 'deadline_add') {
      await reply(ctx, `Не знайшов дату чи час. 🤔 Спробуй, наприклад, так: <code>Есе з літератури 12.11 23:00</code>`, {
        reply_markup: kb(CANCEL_ROW),
      });
    }
    return false;
  }
  if (parsed.due <= ctx.now) {
    await reply(ctx, `Цей момент уже минув (${formatMoment(parsed.due, ctx.user.tz, parsed.allDay, ctx.now)}). Перевір дату, будь ласка.`, {
      reply_markup: kb(CANCEL_ROW),
    });
    return false;
  }
  await saveDeadline(ctx, parsed);
  return true;
}

/**
 * Записує дедлайн у D1 разом із нагадуваннями, скидає крок діалогу і надсилає підтвердження
 * з кнопками важливості та складності. Повертає id нового дедлайну.
 */
export async function saveDeadline(ctx: Ctx, d: ParsedDeadline): Promise<number> {
  const tz = ctx.user.tz;
  const reminders = reminderTimes(d.due, d.allDay, ctx.now, tz);
  const id = await ctx.db.addDeadline(ctx.user.id, d.title, d.due, d.allDay, reminders, ctx.now);
  await setState(ctx, null);
  const when = formatMoment(d.due, tz, d.allDay, ctx.now);
  const rel = relativeLabel(d.due, tz, ctx.now, d.allDay);
  const remindText = reminders.length
    ? `🔔 Нагадаю: ${reminders.map((r) => formatMoment(r, tz, false, ctx.now)).join('; ')}.`
    : '🔔 До дедлайну зовсім мало часу, тож окремих нагадувань не буде.';
  await reply(
    ctx,
    `✅ Записав: <b>${escapeHtml(d.title)}</b>\n📆 ${when} (${rel})\n${remindText}\n\n` +
      'Познач ❗ важливість (перший ряд) і 💪 складність (другий): від них і терміну залежить пріоритет у списку.',
    { reply_markup: ratingKeyboard(id, 2, 2) },
  );
  return id;
}

/** Змінює важливість (`field` = 'importance') чи складність дедлайну і оновлює кнопки. */
export async function rateDeadline(ctx: Ctx, id: number, field: 'importance' | 'difficulty', value: number, messageId: number): Promise<void> {
  if (!(await ctx.db.setDeadlineRating(ctx.user.id, id, field, value))) return;
  const d = await ctx.db.getDeadline(ctx.user.id, id);
  if (d) await ctx.tg.editMarkup(ctx.chatId, messageId, ratingKeyboard(id, d.importance, d.difficulty));
}

/** Невиконані дедлайни від найвищого пріоритету до найнижчого. */
export function byPriority(deadlines: Deadline[], now: number): Deadline[] {
  return [...deadlines].sort(
    (a, b) => priorityScore(b.importance, b.difficulty, b.due_at, now) - priorityScore(a.importance, a.difficulty, a.due_at, now) || a.due_at - b.due_at,
  );
}

/** Текст списку дедлайнів; `total` - скільки всього відкритих, щоб написати про ті, що не поміщаються. */
function listHtml(deadlines: Deadline[], ctx: Ctx, total: number): string {
  if (!deadlines.length) {
    return '⏰ <b>Активних дедлайнів немає.</b> 🎉\n\nДодай перший, і я нагадаю заздалегідь.';
  }
  const tz = ctx.user.tz;
  const lines = deadlines.map((d, i) => {
    const allDay = Boolean(d.all_day);
    const icon = PRIORITY_ICON[priorityLevel(priorityScore(d.importance, d.difficulty, d.due_at, ctx.now))];
    const mark = d.due_at < ctx.now ? ' ⚠️' : '';
    return `${i + 1}. ${icon} <b>${escapeHtml(truncate(d.title, 80))}</b>${mark}\n    ${formatMoment(d.due_at, tz, allDay, ctx.now)} · ${relativeLabel(d.due_at, tz, ctx.now, allDay)}`;
  });
  const rest = total - deadlines.length;
  const more = rest > 0 ? `\n\n…і ще ${rest} ${plural(rest, ['дедлайн', 'дедлайни', 'дедлайнів'])}. Познач виконані, щоб побачити решту.` : '';
  return (
    `⏰ <b>Дедлайни за пріоритетом</b>\n\n${lines.join('\n')}${more}\n\n` +
    '🔴 зробити першим · 🟡 найближчим часом · 🟢 є запас часу. Пріоритет враховує термін, важливість і складність.\n' +
    'Кнопки: ✅ виконано, 🧩 розбити на кроки, 🗑 видалити.'
  );
}

function listKeyboard(deadlines: Deadline[]) {
  return kb(
    ...deadlines.map((d, i) => [btn(`✅ ${i + 1}`, `dl:ok:${d.id}`), btn(`🧩 ${i + 1}`, `dl:sp:${d.id}`), btn(`🗑 ${i + 1}`, `dl:rm:${d.id}`)]),
    [btn('➕ Додати дедлайн', 'dl:add'), btn('📋 Мої завдання', 'tk:list')],
  );
}

/**
 * Показує до 10 відкритих дедлайнів за пріоритетом; з `editMessageId` редагує те повідомлення,
 * інакше надсилає нове.
 */
export async function showDeadlines(ctx: Ctx, editMessageId?: number): Promise<void> {
  const all = await ctx.db.listOpenDeadlines(ctx.user.id, 50);
  const deadlines = byPriority(all, ctx.now).slice(0, 10);
  const total = all.length === 50 ? await ctx.db.countOpenDeadlines(ctx.user.id) : all.length;
  const html = listHtml(deadlines, ctx, total);
  if (editMessageId) await ctx.tg.editHtml(ctx.chatId, editMessageId, html, listKeyboard(deadlines));
  else await reply(ctx, html, { reply_markup: listKeyboard(deadlines) });
}
