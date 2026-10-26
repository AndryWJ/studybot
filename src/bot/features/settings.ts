/**
 * Налаштування користувача: часовий пояс, ранкове зведення, нагадування про
 * заняття, вільний час для навчання, шкала оцінок і видалення всіх даних.
 */

import { defaultTz } from '../../env';
import { escapeHtml } from '../../format';
import { SCALES } from '../../grades';
import { parseWeeklyHours } from '../../parse';
import { parseAvailability } from '../../planner';
import { nextDigestAt } from '../../reminders';
import { formatMinutes, isValidTimeZone, parseClock } from '../../time';
import { reply, setState, type Ctx } from '../context';
import { btn, CANCEL_ROW, grid, kb } from '../ui';
import { availabilityText, AVAILABILITY_PRESETS } from './plan';

/** Часові пояси на кнопках; у callback_data йде індекс у цьому масиві. */
const TIMEZONES = ['Europe/Kyiv', 'Europe/Warsaw', 'Europe/Berlin', 'Europe/Prague', 'Europe/London', 'Europe/Lisbon', 'America/New_York', 'Asia/Tbilisi'];
/** Варіанти часу ранкового зведення, хвилин від півночі. */
const DIGEST_TIMES = [390, 420, 450, 480, 540];
/** Варіанти "за скільки хвилин нагадувати про заняття"; 0 вимикає нагадування. */
const LESSON_LEADS = [0, 5, 10, 15, 30];

/** Текст головного екрана налаштувань з поточними значеннями. */
function settingsHtml(ctx: Ctx): string {
  const u = ctx.user;
  const digest = u.digest_min === null ? 'вимкнено' : `о ${formatMinutes(u.digest_min)}`;
  const lessons = u.lesson_lead ? `за ${u.lesson_lead} хв до початку` : 'вимкнено';
  return (
    '⚙️ <b>Налаштування</b>\n\n' +
    `🌍 Часовий пояс: <b>${escapeHtml(u.tz)}</b>\n` +
    `🌅 Ранкове зведення: <b>${digest}</b>\n` +
    `🔔 Нагадування про заняття з розкладу: <b>${lessons}</b>\n` +
    `🕒 Вільний час для навчання: <b>${availabilityText(parseAvailability(u.availability))}</b>\n` +
    `🎓 Шкала оцінок: <b>${u.grade_scale}-бальна</b>\n\n` +
    'Вільний час потрібен, щоб розкладати кроки завдань і заняття плану по днях, не перевантажуючи тебе.'
  );
}

/** Кнопки розділів налаштувань. */
function settingsKeyboard() {
  return kb(
    [btn('🌍 Пояс', 'set:tz'), btn('🌅 Зведення', 'set:dg')],
    [btn('🔔 Про заняття', 'set:ll'), btn('🕒 Вільний час', 'set:av')],
    [btn('🎓 Шкала оцінок', 'set:gs'), btn('🗑 Видалити мої дані', 'set:wipe')],
  );
}

/** Показує налаштування; з `editMessageId` редагує те повідомлення, інакше надсилає нове. */
export async function showSettings(ctx: Ctx, editMessageId?: number): Promise<void> {
  if (editMessageId) await ctx.tg.editHtml(ctx.chatId, editMessageId, settingsHtml(ctx), settingsKeyboard());
  else await reply(ctx, settingsHtml(ctx), { reply_markup: settingsKeyboard() });
}

/**
 * Показує варіанти вибору для розділу `what` ("tz", "dg", "ll", "av", "gs", "wipe") у повідомленні `messageId`;
 * невідомий розділ повертає на головний екран налаштувань.
 */
export async function editSetting(ctx: Ctx, what: string, messageId: number): Promise<void> {
  const back = [btn('Назад', 'set:show')];
  if (what === 'tz') {
    await ctx.tg.editHtml(
      ctx.chatId,
      messageId,
      '🌍 Обери часовий пояс. Від нього залежать нагадування й ранкове зведення.',
      kb(...grid(TIMEZONES.map((tz, i) => btn(tz.replace('Europe/', '').replace('America/', '').replace('Asia/', ''), `set:tz:${i}`)), 3), [btn('✏️ Інший', 'set:tz:x')], back),
    );
  } else if (what === 'dg') {
    await ctx.tg.editHtml(
      ctx.chatId,
      messageId,
      '🌅 О котрій надсилати ранкове зведення (заняття, дедлайни і кроки на день)?',
      kb(...grid(DIGEST_TIMES.map((m) => btn(formatMinutes(m), `set:dg:${m}`)), 5), [btn('✏️ Свій час', 'set:dg:x'), btn('🔕 Вимкнути', 'set:dg:off')], back),
    );
  } else if (what === 'll') {
    await ctx.tg.editHtml(
      ctx.chatId,
      messageId,
      '🔔 За скільки хвилин нагадувати про заняття з розкладу?',
      kb(LESSON_LEADS.map((m) => btn(m ? `${m} хв` : 'Вимк.', `set:ll:${m}`)), back),
    );
  } else if (what === 'av') {
    await ctx.tg.editHtml(
      ctx.chatId,
      messageId,
      '🕒 Скільки часу на день ти можеш приділяти навчанню поза уроками чи парами?',
      kb(...AVAILABILITY_PRESETS.map((p) => [btn(p.label, `set:av:${p.code}`)]), [btn('✏️ По днях', 'set:av:x')], back),
    );
  } else if (what === 'gs') {
    await ctx.tg.editHtml(ctx.chatId, messageId, '🎓 Яка шкала оцінок у тебе?', kb(SCALES.map((s) => btn(`${s}-бальна`, `set:gs:${s}`)), back));
  } else if (what === 'wipe') {
    await ctx.tg.editHtml(
      ctx.chatId,
      messageId,
      '🗑 Видалити <b>всі</b> твої дані: розклад, дедлайни, завдання, плани, оцінки й історію навчання? Це не можна скасувати.',
      kb([btn('🗑 Так, видалити все', 'set:wipe!'), btn('Ні', 'set:show')]),
    );
  } else {
    await showSettings(ctx, messageId);
  }
}

/** Канонічна назва поясу ("europe/kyiv" дає "Europe/Kyiv"), щоб однакові пояси не дублювалися. */
function canonicalTz(tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    return tz;
  }
}

/** Зберігає часовий пояс у канонічному записі й перераховує час наступного зведення (запис у D1). */
async function applyTz(ctx: Ctx, rawTz: string): Promise<void> {
  const tz = canonicalTz(rawTz);
  const next = ctx.user.digest_min === null ? null : nextDigestAt(ctx.user.digest_min, tz, ctx.now);
  await ctx.db.updateUser(ctx.user.id, { tz, next_digest_at: next });
  ctx.user.tz = tz;
  ctx.user.next_digest_at = next;
}

/** Зберігає час ранкового зведення (хвилини від півночі; null вимикає) і час наступного надсилання (запис у D1). */
async function applyDigest(ctx: Ctx, minutes: number | null): Promise<void> {
  const next = minutes === null ? null : nextDigestAt(minutes, ctx.user.tz, ctx.now);
  await ctx.db.updateUser(ctx.user.id, { digest_min: minutes, next_digest_at: next });
  ctx.user.digest_min = minutes;
  ctx.user.next_digest_at = next;
}

/** Обробляє вибір значення в налаштуваннях (`what`: код розділу, `value`: значення з кнопки). */
export async function setSetting(ctx: Ctx, what: string, value: string, messageId: number): Promise<void> {
  if (what === 'tz') {
    if (value === 'x') {
      await setState(ctx, 'set_tz');
      await reply(ctx, 'Напиши назву поясу у форматі IANA, наприклад <code>Europe/Vienna</code> чи <code>America/Toronto</code>.', { reply_markup: kb(CANCEL_ROW) });
      return;
    }
    const tz = TIMEZONES[Number(value)];
    if (tz) await applyTz(ctx, tz);
  } else if (what === 'dg') {
    if (value === 'x') {
      await setState(ctx, 'set_digest');
      await reply(ctx, 'Напиши час, наприклад <code>06:45</code>.', { reply_markup: kb(CANCEL_ROW) });
      return;
    }
    await applyDigest(ctx, value === 'off' ? null : Number(value));
  } else if (what === 'll') {
    const lead = Number(value);
    if (LESSON_LEADS.includes(lead)) {
      await ctx.db.updateUser(ctx.user.id, { lesson_lead: lead });
      ctx.user.lesson_lead = lead;
    }
  } else if (what === 'av') {
    if (value === 'x') {
      await setState(ctx, 'set_avail');
      await reply(ctx, 'Напиши вільний час по днях, наприклад: <code>пн-пт 2, сб 4, нд 0</code> або <code>будні 1.5 год, вихідні 3</code>.', {
        reply_markup: kb(CANCEL_ROW),
      });
      return;
    }
    const preset = AVAILABILITY_PRESETS.find((p) => p.code === value);
    if (preset) {
      const json = JSON.stringify(preset.minutes);
      await ctx.db.updateUser(ctx.user.id, { availability: json });
      ctx.user.availability = json;
    }
  } else if (what === 'gs' || what === 'gs!') {
    const scale = Number(value);
    if ((SCALES as number[]).includes(scale) && scale !== ctx.user.grade_scale) {
      const hasGrades = (await ctx.db.listGrades(ctx.user.id)).length > 0;
      if (hasGrades && what === 'gs') {
        // Оцінки зберігаються без шкали, тож змішувати шкали не можна: спершу підтвердження.
        await ctx.tg.editHtml(
          ctx.chatId,
          messageId,
          `🎓 Записані оцінки в ${ctx.user.grade_scale}-бальній шкалі. Щоб перейти на ${scale}-бальну, їх буде видалено. Продовжити?`,
          kb([btn('Так, видалити й перейти', `set:gs!:${scale}`), btn('Ні', 'set:show')]),
        );
        return;
      }
      if (hasGrades) await ctx.db.clearGrades(ctx.user.id);
      await ctx.db.updateUser(ctx.user.id, { grade_scale: scale });
      ctx.user.grade_scale = scale;
    }
  } else if (what === 'wipe' && value === '!') {
    await ctx.db.deleteUser(ctx.user.id, defaultTz(ctx.env));
    await ctx.tg.editHtml(ctx.chatId, messageId, '🗑 Усі твої дані видалено. Напиши /start, якщо захочеш почати знову.');
    return;
  }
  await showSettings(ctx, messageId);
}

/** Текстові відповіді для налаштувань. Повертає true, якщо текст оброблено. */
export async function onSettingsText(ctx: Ctx, text: string): Promise<boolean> {
  const state = ctx.user.state;
  if (state === 'set_tz') {
    const tz = text.trim();
    if (!isValidTimeZone(tz)) {
      await reply(ctx, 'Не знаю такого поясу. Приклад: <code>Europe/Kyiv</code>.', { reply_markup: kb(CANCEL_ROW) });
      return true;
    }
    await applyTz(ctx, tz);
  } else if (state === 'set_digest') {
    const min = parseClock(text);
    if (min === null) {
      await reply(ctx, 'Не зрозумів час. Приклад: <code>07:15</code>.', { reply_markup: kb(CANCEL_ROW) });
      return true;
    }
    await applyDigest(ctx, min);
  } else if (state === 'set_avail') {
    const minutes = parseWeeklyHours(text, parseAvailability(ctx.user.availability));
    if (!minutes) {
      await reply(ctx, 'Не зрозумів. Приклад: <code>пн-пт 2, сб 4, нд 0</code>.', { reply_markup: kb(CANCEL_ROW) });
      return true;
    }
    const json = JSON.stringify(minutes);
    await ctx.db.updateUser(ctx.user.id, { availability: json });
    ctx.user.availability = json;
  } else {
    return false;
  }
  await setState(ctx, null);
  await showSettings(ctx);
  return true;
}
