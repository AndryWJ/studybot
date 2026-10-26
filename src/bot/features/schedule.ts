/**
 * Розклад на тиждень: перегляд, додавання занять текстом, складання розкладу
 * самопідготовки з ШІ, видалення і план на сьогодні.
 */

import { completeJson } from '../../ai/client';
import { buildLessonExtract, buildSchedule, parseWeekly, type WeeklyItem } from '../../ai/prompts';
import { escapeHtml, truncate } from '../../format';
import { parseLessons } from '../../parse';
import { digestHtml, lessonLine } from '../../reminders';
import { MAX_LESSONS } from '../../db';
import { formatMinutes, plural, ymdToString, WEEKDAYS_FULL, WEEKDAYS_SHORT } from '../../time';
import { local, nowLine, reply, setState, stateData, today, withAi, type Ctx } from '../context';
import { btn, CANCEL_ROW, grid, kb } from '../ui';

const LESSON_FORMAT_HELP = `Напиши заняття, по одному на рядок, у форматі <i>день час назва</i>:

<code>пн 08:30-09:15 Математика
вт, чт 15:00 Англійська
пн-пт 19:00-20:00 Підготовка до НМТ
щодня 21:00 Читання</code>

Можна й своїми словами: <i>у середу з 16 до 17 гурток з робототехніки</i>.`;

/** Кнопки розкладу; "Сьогодні" і "Видалити" з'являються, лише якщо є заняття. */
function scheduleKeyboard(hasLessons: boolean) {
  return kb(
    [btn('➕ Додати заняття', 'sch:add'), btn('🤖 Скласти з ШІ', 'sch:ai')],
    hasLessons ? [btn('📆 Сьогодні', 'sch:today'), btn('🗑 Видалити', 'sch:del')] : [],
  );
}

/** Показує розклад на тиждень по днях; з `editMessageId` редагує те повідомлення, інакше надсилає нове. */
export async function showSchedule(ctx: Ctx, editMessageId?: number): Promise<void> {
  const lessons = await ctx.db.listLessons(ctx.user.id);
  const todayWd = local(ctx).weekday;
  let html: string;
  if (!lessons.length) {
    html =
      '📅 <b>Розклад порожній.</b>\n\nДодай свої уроки чи пари, гуртки й час самопідготовки, і я щоранку ' +
      'нагадуватиму, що сьогодні. Або опиши свій тиждень, і ШІ складе розклад самопідготовки.';
  } else {
    const days: string[] = [];
    for (let wd = 1; wd <= 7; wd++) {
      const items = lessons.filter((l) => l.weekday === wd);
      if (!items.length) continue;
      const head = `<b>${WEEKDAYS_FULL[wd - 1][0].toUpperCase()}${WEEKDAYS_FULL[wd - 1].slice(1)}</b>${wd === todayWd ? ' (сьогодні)' : ''}`;
      days.push(`${head}\n${items.map(lessonLine).join('\n')}`);
    }
    html = `📅 <b>Розклад на тиждень</b>\n\n${days.join('\n\n')}`;
  }
  if (editMessageId) await ctx.tg.editHtml(ctx.chatId, editMessageId, html, scheduleKeyboard(lessons.length > 0));
  else await reply(ctx, html, { reply_markup: scheduleKeyboard(lessons.length > 0) });
}

/** Заняття, дедлайни і кроки на сьогодні. */
export async function showToday(ctx: Ctx): Promise<void> {
  const p = local(ctx);
  const data = await ctx.db.digestData(ctx.user.id, p.weekday, ctx.now, ctx.now + 3 * 86400, ymdToString(today(ctx)));
  const html = digestHtml(data, ctx.now, ctx.user.tz, false)!;
  await reply(ctx, html, { reply_markup: kb([btn('📅 Розклад', 'sch:view'), btn('⏰ Дедлайни', 'dl:list')]) });
}

/** Починає додавання занять: ставить крок "lesson_add" і показує формат запису. */
export async function startAddLessons(ctx: Ctx): Promise<void> {
  await setState(ctx, 'lesson_add');
  await reply(ctx, LESSON_FORMAT_HELP, { reply_markup: kb(CANCEL_ROW) });
}

/** Приймає рядки з заняттями; якщо жоден не розібрано, просить ШІ переписати текст у розклад. */
export async function onLessonText(ctx: Ctx, text: string): Promise<void> {
  const { lessons, bad } = parseLessons(text);
  let items: WeeklyItem[] = lessons.flatMap((l) => l.weekdays.map((day) => ({ day, start: l.start, end: l.end, title: l.title })));
  let skipped = bad;

  if (!items.length) {
    const result = await withAi(ctx, () => completeJson(ctx.env, { messages: buildLessonExtract(text), maxTokens: 1200, temperature: 0.1 }, (v) => parseWeekly(v, true)));
    if (!result) return;
    items = result.data.items;
    skipped = [];
    if (!items.length) {
      await reply(ctx, `Не вдалося знайти в повідомленні жодного заняття. 🤔\n\n${LESSON_FORMAT_HELP}`, { reply_markup: kb(CANCEL_ROW) });
      return;
    }
  }

  const added = await ctx.db.addLessons(ctx.user.id, items.map((i) => ({ weekday: i.day, start: i.start, end: i.end, title: i.title })));
  await setState(ctx, null);
  const lines = items.map((i) => `• ${WEEKDAYS_SHORT[i.day - 1]} ${lessonLine({ start_min: i.start, end_min: i.end, title: i.title })}`);
  let html = `✅ Додав у розклад:\n${lines.join('\n')}`;
  if (added < items.length) html += `\n\nℹ️ ${items.length - added} з них уже були в розкладі або перевищено ліміт у ${MAX_LESSONS} занять, тож їх пропущено.`;
  if (skipped.length) html += `\n\n⚠️ Не зрозумів ці рядки:\n${skipped.map((b) => `• ${escapeHtml(truncate(b, 80))}`).join('\n')}`;
  await reply(ctx, html, { reply_markup: kb([btn('📅 Показати розклад', 'sch:view'), btn('➕ Ще заняття', 'sch:add')]) });
}

/** Починає складання розкладу з ШІ: ставить крок "sched_ai" і просить описати тиждень. */
export async function startAiSchedule(ctx: Ctx): Promise<void> {
  await setState(ctx, 'sched_ai');
  await reply(
    ctx,
    '🤖 Розкажи про свій тиждень: коли уроки чи пари, гуртки, тренування, коли зазвичай вільний час і що хочеш встигати.\n\n' +
      '<i>Наприклад: 10 клас, уроки до 14:00, у вт і чт футбол о 16:00. Хочу готуватися до НМТ з математики й англійської по годині на день, у неділю відпочиваю.</i>',
    { reply_markup: kb(CANCEL_ROW) },
  );
}

/** Дані кроку "sched_preview": опис тижня від людини, запропоновані заняття й коментар ШІ. */
interface SchedulePreview {
  description: string;
  items: WeeklyItem[];
  comment: string;
}

/** Просить ШІ скласти розклад і показує чернетку з кнопками "додати", "інший варіант", "скасувати". */
export async function generateSchedule(ctx: Ctx, description: string, feedback: string | null): Promise<void> {
  const result = await withAi(ctx, () =>
    completeJson(ctx.env, { messages: buildSchedule(description, nowLine(ctx), feedback), maxTokens: 2500, temperature: 0.6 }, (v) => parseWeekly(v)),
  );
  if (!result) return;
  const { items, comment } = result.data;
  await setState(ctx, 'sched_preview', { description, items, comment } satisfies SchedulePreview);
  await reply(ctx, previewHtml(items, comment), { reply_markup: previewKeyboard((await ctx.db.countLessons(ctx.user.id)) > 0) });
}

/** Текст чернетки розкладу: заняття по днях тижня й коментар ШІ, якщо він є. */
export function previewHtml(items: WeeklyItem[], comment: string): string {
  const byDay: string[] = [];
  for (let wd = 1; wd <= 7; wd++) {
    const day = items.filter((i) => i.day === wd);
    if (!day.length) continue;
    byDay.push(`<b>${WEEKDAYS_SHORT[wd - 1]}</b>  ${day.map((i) => `${formatMinutes(i.start)} ${escapeHtml(i.title)}`).join('; ')}`);
  }
  return (
    `🤖 <b>Чернетка розкладу</b>\n\n${byDay.join('\n')}` +
    (comment ? `\n\n💡 ${escapeHtml(comment)}` : '') +
    '\n\nЯкщо щось не так, просто напиши побажання (наприклад, <i>у суботу менше занять</i>), і я перероблю.'
  );
}

/** Кнопки чернетки; "Замінити мій розклад" лише тоді, коли в людини вже є заняття. */
function previewKeyboard(hasLessons: boolean) {
  return kb(
    [btn('✅ Додати в розклад', 'sch:save')],
    hasLessons ? [btn('♻️ Замінити мій розклад', 'sch:replace')] : [],
    [btn('🔁 Інший варіант', 'sch:redo'), btn('❌ Скасувати', 'x:cancel')],
  );
}

/**
 * Записує чернетку в розклад (D1) і скидає крок діалогу; з `replace` спершу очищає наявні заняття.
 * Повторне натискання чи застаріла чернетка нічого не додає.
 */
export async function savePreview(ctx: Ctx, replace: boolean): Promise<void> {
  const preview = ctx.user.state === 'sched_preview' ? stateData<SchedulePreview>(ctx) : null;
  // claimState не дає подвійному натисканню додати заняття двічі.
  if (!preview || !(await ctx.db.claimState(ctx.user.id, 'sched_preview', ctx.user.state_data))) {
    await reply(ctx, 'Чернетка вже неактуальна. Склади розклад ще раз: 📅 Розклад, далі 🤖 Скласти з ШІ.');
    return;
  }
  ctx.user.state = null;
  ctx.user.state_data = null;
  if (replace) await ctx.db.clearLessons(ctx.user.id);
  const added = await ctx.db.addLessons(ctx.user.id, preview.items.map((i) => ({ weekday: i.day, start: i.start, end: i.end, title: i.title })));
  await reply(ctx, `✅ ${replace ? 'Розклад замінено' : 'Додав у розклад'}: ${added} ${plural(added, ['заняття', 'заняття', 'занять'])}.`);
  await showSchedule(ctx);
}

/**
 * Просить ШІ переробити чернетку за побажанням `feedback` (null: просто інший варіант).
 * Без збереженої чернетки починає складання заново.
 */
export async function redoPreview(ctx: Ctx, feedback: string | null): Promise<void> {
  const preview = ctx.user.state === 'sched_preview' ? stateData<SchedulePreview>(ctx) : null;
  if (!preview) {
    await startAiSchedule(ctx);
    return;
  }
  await generateSchedule(ctx, preview.description, feedback ?? 'Запропонуй інший варіант.');
}

/** Крок 1 видалення: вибір дня. */
export async function chooseDayToDelete(ctx: Ctx, messageId: number): Promise<void> {
  const lessons = await ctx.db.listLessons(ctx.user.id);
  const days = [...new Set(lessons.map((l) => l.weekday))];
  if (!days.length) {
    await showSchedule(ctx, messageId);
    return;
  }
  const keyboard = kb(
    ...grid(days.map((d) => btn(WEEKDAYS_SHORT[d - 1], `sch:dd:${d}`)), 4),
    [btn('🧹 Очистити весь розклад', 'sch:clr')],
    [btn('Назад', 'sch:back')],
  );
  await ctx.tg.editHtml(ctx.chatId, messageId, '🗑 З якого дня видалити заняття?', keyboard);
}

/** Крок 2 видалення: заняття вибраного дня кнопками. */
export async function showDayForDelete(ctx: Ctx, messageId: number, weekday: number): Promise<void> {
  const lessons = await ctx.db.listLessons(ctx.user.id, weekday);
  if (!lessons.length) {
    await chooseDayToDelete(ctx, messageId);
    return;
  }
  const keyboard = kb(
    ...lessons.slice(0, 40).map((l) => [btn(`❌ ${formatMinutes(l.start_min)} ${truncate(l.title, 40)}`, `sch:x:${l.id}:${weekday}`)]),
    [btn('Інший день', 'sch:del'), btn('✅ Готово', 'sch:back')],
  );
  await ctx.tg.editHtml(ctx.chatId, messageId, `🗑 <b>${WEEKDAYS_FULL[weekday - 1]}</b>: натисни заняття, щоб видалити.`, keyboard);
}

/** Просить підтвердити видалення всього розкладу, редагуючи повідомлення `messageId`; сам розклад очищає кнопка підтвердження. */
export async function confirmClear(ctx: Ctx, messageId: number): Promise<void> {
  await ctx.tg.editHtml(
    ctx.chatId,
    messageId,
    'Точно видалити <b>весь</b> розклад? Дедлайни й завдання залишаться.',
    kb([btn('🧹 Так, очистити', 'sch:clr!'), btn('Ні', 'sch:back')]),
  );
}
