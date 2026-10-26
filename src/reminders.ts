/**
 * Коли нагадувати про дедлайн і про що писати в ранковому зведенні.
 *
 * Правила нагадувань (у часовому поясі користувача):
 * - дедлайн із часом: за добу, за 2 години і в сам момент дедлайну;
 * - дедлайн "до кінця дня": напередодні о 19:00 і в день дедлайну о 8:00;
 * - якщо до дедлайну 4 дні й більше, ще й за 3 дні о 19:00.
 * Нагадування за добу й за 2 години, що випадають на тихі години (22:00-8:00),
 * переносяться на 21:00: того ж вечора, якщо це після 22:00, або попереднього,
 * якщо до 8:00. Нагадування в сам момент дедлайну не зсувається. Минулі й надто
 * близькі одне до одного відкидаються.
 */

import {
  addDays,
  dayMonth,
  daysBetween,
  formatMinutes,
  formatMoment,
  localParts,
  relativeLabel,
  ymdOf,
  ymdToString,
  zonedToEpoch,
  WEEKDAYS_FULL,
  type Ymd,
} from './time';
import { escapeHtml } from './format';
import type { Deadline, Lesson, Step } from './db';

const QUIET_FROM = 22 * 60;
const QUIET_TO = 8 * 60;

function at(d: Ymd, minutes: number, tz: string): number {
  return zonedToEpoch(d.year, d.month, d.day, Math.floor(minutes / 60), minutes % 60, tz);
}

function outOfQuietHours(t: number, tz: string): number {
  const p = localParts(t, tz);
  const m = p.hour * 60 + p.minute;
  if (m >= QUIET_FROM) return at(ymdOf(p), 21 * 60, tz);
  if (m < QUIET_TO) return at(addDays(ymdOf(p), -1), 21 * 60, tz);
  return t;
}

/** Моменти нагадувань (unix-секунди, за зростанням) для дедлайну `due`. */
export function reminderTimes(due: number, allDay: boolean, now: number, tz: string): number[] {
  const dueDate = ymdOf(localParts(due, tz));
  const daysAhead = daysBetween(ymdOf(localParts(now, tz)), dueDate);
  const candidates: number[] = [];
  if (daysAhead >= 4) candidates.push(at(addDays(dueDate, -3), 19 * 60, tz));
  if (allDay) {
    candidates.push(at(addDays(dueDate, -1), 19 * 60, tz));
    candidates.push(at(dueDate, 8 * 60, tz));
  } else {
    candidates.push(outOfQuietHours(due - 86400, tz));
    candidates.push(outOfQuietHours(due - 2 * 3600, tz));
    candidates.push(due);
  }
  const result: number[] = [];
  for (const t of candidates.sort((a, b) => a - b)) {
    if (t <= now + 60 || t > due) continue;
    const prev = result[result.length - 1];
    if (prev !== undefined && t - prev < 3600 && t !== due) continue;
    if (prev !== undefined && t === prev) continue;
    result.push(t);
  }
  return result;
}

/** Найближчий момент після `now`, коли в поясі `tz` настане `digestMin` хвилин від півночі. */
export function nextDigestAt(digestMin: number, tz: string, now: number): number {
  const day = ymdOf(localParts(now, tz));
  const todayAt = at(day, digestMin, tz);
  return todayAt > now ? todayAt : at(addDays(day, 1), digestMin, tz);
}

/** Текст нагадування про дедлайн. */
export function reminderHtml(d: Pick<Deadline, 'title' | 'due_at' | 'all_day'>, remindAt: number, now: number, tz: string): string {
  const title = escapeHtml(d.title);
  if (!d.all_day && remindAt >= d.due_at - 60) return `⏰ Настав час: <b>${title}</b>`;
  return `⏰ Нагадування: <b>${title}</b>\n${formatMoment(d.due_at, tz, Boolean(d.all_day), now)} (${relativeLabel(d.due_at, tz, now, Boolean(d.all_day))})`;
}

/** Рядок розкладу: "08:30-09:15  Назва" або "08:30  Назва", якщо кінця немає. Повертає HTML, назва екранована. */
export function lessonLine(l: Pick<Lesson, 'start_min' | 'end_min' | 'title'>): string {
  const time = l.end_min !== null ? `${formatMinutes(l.start_min)}-${formatMinutes(l.end_min)}` : formatMinutes(l.start_min);
  return `${time}  ${escapeHtml(l.title)}`;
}

/** Рядок дедлайну для списків і зведення: позначка (⚠️ для простроченого), назва, момент і відносний підпис. Повертає HTML. */
export function deadlineLine(d: Deadline, now: number, tz: string): string {
  const mark = d.due_at < now ? '⚠️' : '•';
  const allDay = Boolean(d.all_day);
  return `${mark} <b>${escapeHtml(d.title)}</b>: ${formatMoment(d.due_at, tz, allDay, now)} (${relativeLabel(d.due_at, tz, now, allDay)})`;
}

/**
 * Зведення на день: заняття, дедлайни на найближчі дні та кроки, заплановані
 * на сьогодні чи прострочені. `greeting` вмикає ранкове привітання. Повертає null,
 * якщо показувати нічого (тоді ранкове зведення не надсилається).
 */
export function digestHtml(
  data: { lessons: Lesson[]; deadlines: Deadline[]; steps: Array<Step & { task_title: string }> },
  now: number,
  tz: string,
  greeting: boolean,
): string | null {
  const p = localParts(now, tz);
  const dateLine = `${WEEKDAYS_FULL[p.weekday - 1]}, ${dayMonth(ymdOf(p))}`;
  const parts: string[] = [greeting ? `🌅 Доброго ранку! Сьогодні <b>${dateLine}</b>.` : `🗓 <b>Сьогодні, ${dateLine}</b>`];
  if (data.lessons.length) parts.push(`📅 <b>Заняття</b>\n${data.lessons.map(lessonLine).join('\n')}`);
  if (data.deadlines.length) parts.push(`⏰ <b>Дедлайни</b>\n${data.deadlines.map((d) => deadlineLine(d, now, tz)).join('\n')}`);
  if (data.steps.length) {
    const todayStr = ymdToString(ymdOf(p));
    const lines = data.steps.map((s) => {
      const late = s.due_date !== null && s.due_date < todayStr ? ' ⚠️' : '';
      return `• ${escapeHtml(s.text)} <i>(${escapeHtml(s.task_title)})</i>${late}`;
    });
    parts.push(`🧩 <b>Кроки на сьогодні</b>\n${lines.join('\n')}`);
  }
  if (parts.length === 1) {
    return greeting ? null : `${parts[0]}\n\nНа сьогодні нічого не заплановано. Можна додати заняття в 📅 Розклад або дедлайн в ⏰ Дедлайни.`;
  }
  if (greeting) parts.push('Гарного дня і продуктивного навчання! 💪');
  return parts.join('\n\n');
}
