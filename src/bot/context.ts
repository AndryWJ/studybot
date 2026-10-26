/**
 * Контекст обробки одного оновлення від Telegram і спільні допоміжні дії:
 * локальний час користувача, стан діалогу, виклик ШІ з денним лімітом.
 */

import { AiUnavailableError } from '../ai/client';
import { nowContext } from '../ai/prompts';
import type { Db, User } from '../db';
import { intVar, type AppEnv } from '../env';
import { escapeHtml } from '../format';
import type { Telegram } from '../telegram';
import { formatMinutes, localParts, plural, WEEKDAYS_FULL, ymdOf, type LocalParts, type Ymd } from '../time';

/** Все, що потрібно обробникам для роботи з одним оновленням від одного користувача. */
export interface Ctx {
  env: AppEnv;
  db: Db;
  tg: Telegram;
  /** Поточний момент, unix-секунди. */
  now: number;
  user: User;
  chatId: number;
  /** Адреса Worker-а (https://...workers.dev) для посилань на сторінку графіків; null у фонових задачах. */
  origin: string | null;
}

/** Поточний момент, розкладений за календарем у часовому поясі користувача. */
export function local(ctx: Ctx): LocalParts {
  return localParts(ctx.now, ctx.user.tz);
}

/** Сьогоднішня дата за місцевим часом користувача. */
export function today(ctx: Ctx): Ymd {
  return ymdOf(local(ctx));
}

/** Рядок для моделі на кшталт "Сьогодні неділя, 2026-10-25, зараз 19:15 (часовий пояс Europe/Kyiv)." */
export function nowLine(ctx: Ctx): string {
  const p = local(ctx);
  return nowContext(ymdOf(p), WEEKDAYS_FULL[p.weekday - 1], formatMinutes(p.hour * 60 + p.minute), ctx.user.tz);
}

/**
 * Встановлює крок діалогу користувача (null скидає його) і дані до нього.
 * Оновлює `ctx.user` і пише в D1; `data` зберігається як JSON.
 */
export async function setState(ctx: Ctx, state: string | null, data: unknown = null): Promise<void> {
  ctx.user.state = state;
  ctx.user.state_data = data === null ? null : JSON.stringify(data);
  await ctx.db.setState(ctx.user.id, state, data);
}

/** Дані поточного кроку діалогу або null, якщо їх немає чи JSON зіпсований. */
export function stateData<T>(ctx: Ctx): T | null {
  if (!ctx.user.state_data) return null;
  try {
    return JSON.parse(ctx.user.state_data) as T;
  } catch {
    return null;
  }
}

/** Надсилає HTML-повідомлення в чат користувача; `opts` передаються в `Telegram.sendHtml`. */
export function reply(ctx: Ctx, html: string, opts: Parameters<Telegram['sendHtml']>[2] = {}) {
  return ctx.tg.sendHtml(ctx.chatId, html, opts);
}

/**
 * Виконує дію з ШІ: перевіряє денний ліміт користувача, показує "друкує..." поки
 * модель думає, і повідомляє людині, якщо ШІ недоступний. Повертає результат
 * дії або null, якщо дія не відбулася (про причину користувачу вже написано).
 */
export async function withAi<T>(ctx: Ctx, action: () => Promise<T>): Promise<T | null> {
  const limit = intVar(ctx.env.AI_DAILY_LIMIT, 40);
  // День ліміту рахується за UTC: зміна часового поясу не обнуляє лічильник.
  const day = new Date(ctx.now * 1000).toISOString().slice(0, 10);
  const used = await ctx.db.bumpAiCount(ctx.user.id, day);
  if (limit > 0 && used > limit) {
    await ctx.db.refundAiCount(ctx.user.id, day);
    await reply(
      ctx,
      `На сьогодні ліміт запитів до ШІ вичерпано (${limit} ${plural(limit, ['запит', 'запити', 'запитів'])} на добу). ` +
        `Він оновиться о ${resetClock(ctx)}. Розклад, дедлайни й нагадування працюють і без ШІ.`,
    );
    return null;
  }

  await ctx.tg.typing(ctx.chatId);
  let ticks = 0;
  const typingTimer = setInterval(() => {
    if (++ticks <= 5) void ctx.tg.typing(ctx.chatId);
  }, 4500);
  try {
    return await action();
  } catch (e) {
    if (e instanceof AiUnavailableError) {
      // Якщо модель відповіла, але не за форматом, токени вже витрачено: запит не повертаємо.
      if (!e.consumed) await ctx.db.refundAiCount(ctx.user.id, day);
      console.warn(e.message);
      await reply(
        ctx,
        e.attempts.length
          ? '😔 ШІ зараз не відповідає: схоже, вичерпано безкоштовний ліміт або сервіс перевантажений. Спробуй за кілька хвилин.'
          : '😔 ШІ ще не підключено. Передай власнику бота, щоб додав ключ ШІ.',
      );
      return null;
    }
    throw e;
  } finally {
    clearInterval(typingTimer);
  }
}

/** Місцевий час найближчої півночі за UTC, коли оновлюється денний ліміт ШІ ("02:00" для Києва взимку). */
function resetClock(ctx: Ctx): string {
  const nextUtcMidnight = (Math.floor(ctx.now / 86400) + 1) * 86400;
  const p = localParts(nextUtcMidnight, ctx.user.tz);
  return formatMinutes(p.hour * 60 + p.minute);
}

/** Ім'я користувача для привітань, безпечне для HTML. */
export function name(ctx: Ctx): string {
  return escapeHtml(ctx.user.first_name ?? 'друже');
}
