/**
 * Фонова робота, яку Cloudflare запускає щохвилини (Cron Trigger "* * * * *"):
 * нагадування про дедлайни, ранкові зведення, нагадування про заняття з
 * розкладу і щоденне прибирання старих записів.
 *
 * Ліміти безкоштовного тарифу на один запуск: 50 зовнішніх запитів (кожне
 * повідомлення в Telegram це один запит) і 50 запитів до D1. Тому за хвилину
 * надсилається не більше SEND_BUDGET повідомлень, а решта переходить на наступну хвилину.
 */

import { Db, type User } from './db';
import type { AppEnv } from './env';
import { digestHtml, lessonLine, nextDigestAt, reminderHtml } from './reminders';
import { Telegram, TelegramError } from './telegram';
import { addDays, formatDuration, localParts, ymdOf, ymdToString } from './time';
import { btn, kb } from './bot/ui';

const SEND_BUDGET = 35;
/** Нагадування, що запізнилися більше ніж на стільки секунд (бот був недоступний), не надсилаються. */
const STALE_AFTER = 6 * 3600;

interface Budget {
  left: number;
}

async function safeSend(db: Db, userId: number, send: () => Promise<unknown>): Promise<boolean> {
  try {
    await send();
    return true;
  } catch (e) {
    if (e instanceof TelegramError && e.isBlocked) await db.setBlocked(userId, true);
    else console.warn(`cron send to ${userId} failed`, e instanceof Error ? e.message : e);
    return e instanceof TelegramError && e.code !== 429;
  }
}

async function sendReminders(db: Db, tg: Telegram, now: number, budget: Budget): Promise<void> {
  if (budget.left <= 0) return;
  const due = await db.dueReminders(now, budget.left);
  const handled: number[] = [];
  for (const r of due) {
    if (now - r.remind_at > STALE_AFTER) {
      handled.push(r.id);
      continue;
    }
    if (budget.left <= 0) break;
    budget.left--;
    const ok = await safeSend(db, r.user_id, () =>
      tg.sendHtml(r.user_id, reminderHtml(r, r.remind_at, now, r.tz), {
        reply_markup: kb([btn('✅ Виконано', `dl:ok:${r.deadline_id}`), btn('🧩 Розбити на кроки', `dl:sp:${r.deadline_id}`)]),
      }),
    );
    if (ok) handled.push(r.id);
  }
  await db.markRemindersSent(handled);
}

async function sendDigests(db: Db, tg: Telegram, now: number, budget: Budget): Promise<void> {
  if (budget.left <= 0) return;
  const users = await db.usersForDigest(now, Math.min(budget.left, 10));
  if (!users.length) return;
  // Наступний час зведення записується до надсилання: збій посеред циклу не
  // призведе до повторних зведень щохвилини.
  await db.setNextDigests(users.map((u) => ({ id: u.id, next: nextDigestAt(u.digest_min ?? 450, u.tz, now + 60) })));
  for (const u of users) {
    // Якщо зведення запізнилося більше ніж на 2 години (бот був недоступний), пропускаємо його.
    if (u.next_digest_at !== null && now - u.next_digest_at > 2 * 3600) continue;
    try {
      const html = await buildDigest(db, u, now);
      if (!html) continue;
      budget.left--;
      await safeSend(db, u.id, () => tg.sendHtml(u.id, html));
    } catch (e) {
      console.error(`digest for ${u.id} failed`, e instanceof Error ? e.message : e);
    }
  }
}

/** Текст ранкового зведення або null, якщо на сьогодні нічого немає. */
export async function buildDigest(db: Db, u: User, now: number): Promise<string | null> {
  const p = localParts(now, u.tz);
  const todayYmd = ymdOf(p);
  const data = await db.digestData(u.id, p.weekday, now, now + 3 * 86400, ymdToString(todayYmd));
  let html = digestHtml(data, now, u.tz, true);
  if (!html) return null;
  const yesterday = ymdToString(addDays(todayYmd, -1));
  const studied = (await db.studyByDay(u.id, yesterday)).filter((r) => r.day === yesterday).reduce((a, r) => a + r.minutes, 0);
  if (studied > 0) html += `\n\n📊 Учора на навчання пішло ${formatDuration(studied)}. Так тримати!`;
  return html;
}

/**
 * Нагадування про заняття: для кожної хвилини з проміжку (from, to] шукає заняття,
 * що починаються через lesson_lead хвилин у поясі користувача. Усі групи (пояс,
 * випередження) перевіряються одним пакетним запитом.
 */
async function sendLessonReminders(db: Db, tg: Telegram, from: number, to: number, budget: Budget): Promise<void> {
  if (budget.left <= 0) return;
  const groups = await db.lessonReminderGroups();
  if (!groups.length) return;
  const queries = groups.slice(0, 40).map((g) => {
    const slots: Array<{ weekday: number; minute: number }> = [];
    for (let t = Math.floor(from / 60) * 60 + 60; t <= to && slots.length < 15; t += 60) {
      const p = localParts(t + g.lesson_lead * 60, g.tz);
      slots.push({ weekday: p.weekday, minute: p.hour * 60 + p.minute });
    }
    return { tz: g.tz, lead: g.lesson_lead, slots };
  });
  for (const l of await db.lessonsStartingAt(queries)) {
    if (budget.left <= 0) return;
    budget.left--;
    await safeSend(db, l.user_id, () => tg.sendHtml(l.user_id, `🔔 Через ${l.lead} хв: ${lessonLine(l)}`));
  }
}

/**
 * Один запуск фонової роботи. `now`: момент запуску, unix-секунди.
 * Надсилає повідомлення в Telegram і пише службові ключі та прапорці в D1; збій одного
 * кроку не зупиняє решту.
 */
export async function runCron(env: AppEnv, now: number): Promise<void> {
  const db = new Db(env.DB);
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_API_BASE);
  const budget: Budget = { left: SEND_BUDGET };

  const last = Number(await db.getMeta('last_tick')) || now - 60;
  // Після довгої перерви не надолужуємо більше ніж 15 хвилин нагадувань про заняття.
  const windowFrom = Math.max(last, now - 15 * 60);
  await db.setMeta('last_tick', String(now));

  const steps: Array<[string, () => Promise<void>]> = [
    ['reminders', () => sendReminders(db, tg, now, budget)],
    ['lessons', () => sendLessonReminders(db, tg, windowFrom, now, budget)],
    ['digests', () => sendDigests(db, tg, now, budget)],
  ];
  for (const [label, run] of steps) {
    try {
      await run();
    } catch (e) {
      console.error(`cron ${label} failed`, e instanceof Error ? e.stack ?? e.message : e);
    }
  }

  const day = new Date(now * 1000).toISOString().slice(0, 10);
  if ((await db.getMeta('cleanup_day')) !== day) {
    await db.setMeta('cleanup_day', day);
    await db.cleanup(now).catch((e) => console.error('cleanup failed', e));
  }
}
