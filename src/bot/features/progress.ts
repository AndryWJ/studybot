/**
 * Облік часу і прогресу: таймер навчання, ручний запис часу, відсоток
 * виконаних завдань і текстові графіки прямо в чаті, плюс посилання на
 * сторінку з детальними графіками.
 */

import { escapeHtml, truncate } from '../../format';
import { parseDuration } from '../../parse';
import { addDays, formatDuration, WEEKDAYS_SHORT, weekdayOf, ymdToString, zonedToEpoch } from '../../time';
import { chartsUrl } from '../../web/sign';
import { reply, setState, stateData, today, type Ctx } from '../context';
import { btn, CANCEL_ROW, grid, kb } from '../ui';
import type { InlineButton } from '../../telegram';

/** Найдовша сесія таймера, яку бот записує без питань, хвилин. */
const TIMER_CAP = 4 * 60;

/** Неповні блоки Unicode для восьмих часток символу смуги, від 0 до 7. */
const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** Смуга з Unicode-блоків довжиною до `width` символів для частки `value / max`. */
export function bar(value: number, max: number, width = 12): string {
  if (max <= 0 || value <= 0) return '';
  const eighths = Math.max(1, Math.round((value / max) * width * 8));
  return '█'.repeat(Math.floor(eighths / 8)) + PARTIAL[eighths % 8];
}

/**
 * Текстова стовпчикова діаграма для тегу pre: підпис, смуга, значення.
 * Підписи вирівнюються пробілами (моноширинний шрифт).
 */
export function textChart(rows: Array<{ label: string; value: number; text: string }>, width = 12): string {
  const max = Math.max(0, ...rows.map((r) => r.value));
  const labelWidth = Math.max(...rows.map((r) => r.label.length));
  return rows
    .map((r) => `${r.label.padEnd(labelWidth)} ${bar(r.value, max, width).padEnd(width + 1)} ${r.text}`)
    .join('\n');
}

/** Відсоток виконаного рядком; "немає даних", якщо `total` дорівнює нулю. */
function percent(done: number, total: number): string {
  return total ? `${Math.round((done / total) * 100)}%` : 'немає даних';
}

/** "Час навчання за 7 днів" і "за предметами" як текстові графіки. */
async function weekCharts(ctx: Ctx): Promise<{ html: string; week: number; lastWeek: number; todayMin: number }> {
  const t = today(ctx);
  const from14 = addDays(t, -13);
  const rows = await ctx.db.studyByDay(ctx.user.id, ymdToString(from14));
  const byDay = new Map<string, number>();
  const bySubject = new Map<string, number>();
  const weekStart = ymdToString(addDays(t, -6));
  for (const r of rows) {
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.minutes);
    if (r.day >= weekStart) bySubject.set(r.subject, (bySubject.get(r.subject) ?? 0) + r.minutes);
  }
  let week = 0;
  let lastWeek = 0;
  for (const [day, m] of byDay) {
    if (day >= weekStart) week += m;
    else lastWeek += m;
  }
  const todayMin = byDay.get(ymdToString(t)) ?? 0;
  if (week === 0) return { html: '', week, lastWeek, todayMin };

  const dayRows = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(t, i - 6);
    const key = ymdToString(d);
    const m = byDay.get(key) ?? 0;
    return { label: `${WEEKDAYS_SHORT[weekdayOf(d) - 1]} ${String(d.day).padStart(2, '0')}`, value: m, text: m ? formatDuration(m) : '·' };
  });
  const subjects = [...bySubject.entries()].sort((a, b) => b[1] - a[1]);
  const top = subjects.slice(0, 6);
  const other = subjects.slice(6).reduce((a, [, m]) => a + m, 0);
  if (other) top.push(['Інше', other]);
  const subjectRows = top.map(([s, m]) => ({ label: truncate(s, 14), value: m, text: `${formatDuration(m)} · ${Math.round((m / week) * 100)}%` }));
  const html =
    `\n\n<b>Час навчання за 7 днів</b>\n<pre>${escapeHtml(textChart(dayRows))}</pre>` +
    `\n<b>За предметами</b>\n<pre>${escapeHtml(textChart(subjectRows, 10))}</pre>`;
  return { html, week, lastWeek, todayMin };
}

/** Кнопки таймера (старт чи стоп за станом) і запису часу; кнопка графіків лише за наявності `url`. */
function progressKeyboard(ctx: Ctx, url: string | null) {
  const timerRow: InlineButton[] = ctx.user.timer_start
    ? [btn(`⏹ Стоп: ${truncate(ctx.user.timer_subject ?? 'заняття', 20)}`, 'tm:stop')]
    : [btn('⏱ Почати заняття', 'tm:start')];
  return kb(
    [...timerRow, btn('➕ Записати час', 'tm:log')],
    url ? [{ text: '📈 Детальні графіки', web_app: { url } }] : [],
  );
}

/**
 * Надсилає зведення за 7 днів: час навчання, виконані кроки й дедлайни, текстові графіки.
 * Посилання на сторінку графіків додається, лише якщо `ctx.origin` починається з https.
 */
export async function showProgress(ctx: Ctx): Promise<void> {
  const t = today(ctx);
  const weekFrom = addDays(t, -6);
  const fromTs = zonedToEpoch(weekFrom.year, weekFrom.month, weekFrom.day, 0, 0, ctx.user.tz);
  const [counts, charts] = await Promise.all([
    ctx.db.progressCounts(ctx.user.id, ymdToString(weekFrom), ymdToString(t), fromTs, ctx.now, ctx.now),
    weekCharts(ctx),
  ]);
  const lines: string[] = ['📊 <b>Прогрес</b>', ''];
  const trend =
    charts.lastWeek > 0
      ? ` (попередні 7 днів: ${formatDuration(charts.lastWeek)}, ${charts.week >= charts.lastWeek ? '+' : ''}${Math.round(((charts.week - charts.lastWeek) / charts.lastWeek) * 100)}%)`
      : '';
  lines.push(`⏱ Сьогодні: <b>${formatDuration(charts.todayMin)}</b> · за 7 днів: <b>${formatDuration(charts.week)}</b>${trend}`);
  if (ctx.user.timer_start) {
    lines.push(`▶️ Іде таймер: ${escapeHtml(ctx.user.timer_subject ?? '')}, ${formatDuration((ctx.now - ctx.user.timer_start) / 60)}`);
  }
  lines.push(`✅ Кроки й заняття за 7 днів: <b>${counts.periodDone} з ${counts.periodSteps}</b> (${percent(counts.periodDone, counts.periodSteps)})`);
  lines.push(`📋 Усього виконано: <b>${counts.allDone} з ${counts.allSteps}</b> кроків (${percent(counts.allDone, counts.allSteps)})`);
  lines.push(
    `⏰ Дедлайни за 7 днів: виконано ${counts.deadlinesDone}, з них вчасно ${counts.deadlinesOnTime}` +
      (counts.overdueOpen ? `; прострочених відкритих: ${counts.overdueOpen} ⚠️` : ''),
  );
  const body = lines.join('\n') + (charts.html || '\n\nЩоб тут з\'явилися графіки, запускай ⏱ таймер під час навчання або познач виконані заняття плану.');
  // Telegram приймає Mini App лише за HTTPS-адресою (локальний wrangler dev працює по HTTP).
  const url = ctx.origin?.startsWith('https://') ? await chartsUrl(ctx.env, ctx.origin, ctx.user.id, ctx.now) : null;
  await reply(ctx, body, { reply_markup: progressKeyboard(ctx, url) });
}

/** Дані кроку "timer_pick": предмети в порядку кнопок вибору. */
interface TimerPick {
  subjects: string[];
}

/**
 * Пропонує вибрати предмет для таймера (до 8 нещодавніх) і ставить крок "timer_pick".
 * Якщо таймер уже йде, лише нагадує про це.
 */
export async function startTimerPick(ctx: Ctx): Promise<void> {
  if (ctx.user.timer_start) {
    await reply(ctx, `Таймер уже йде: ${escapeHtml(ctx.user.timer_subject ?? '')}.`, { reply_markup: kb([btn('⏹ Стоп', 'tm:stop')]) });
    return;
  }
  const subjects = await ctx.db.recentSubjects(ctx.user.id, 8);
  await setState(ctx, 'timer_pick', { subjects } satisfies TimerPick);
  await reply(ctx, '⏱ Що вчиш? Обери предмет або напиши назву.', {
    reply_markup: kb(...grid(subjects.map((s, i) => btn(truncate(s, 24), `tm:go:${i}`)), 2), CANCEL_ROW),
  });
}

/** Запускає таймер навчання: пише початок і предмет (до 60 символів, типово "Навчання") у D1, скидає крок діалогу. */
export async function startTimer(ctx: Ctx, subjectRaw: string): Promise<void> {
  const subject = truncate(subjectRaw.trim() || 'Навчання', 60);
  await ctx.db.updateUser(ctx.user.id, { timer_start: ctx.now, timer_subject: subject });
  ctx.user.timer_start = ctx.now;
  ctx.user.timer_subject = subject;
  await setState(ctx, null);
  await reply(ctx, `▶️ Таймер запущено: <b>${escapeHtml(subject)}</b>. Натисни "Стоп", коли закінчиш.`, {
    reply_markup: kb([btn('⏹ Стоп', 'tm:stop')]),
  });
}

/** Предмет за індексом кнопки зі стану "timer_pick"; null, якщо стану чи індексу немає. */
export function pickedSubject(ctx: Ctx, index: number): string | null {
  return stateData<TimerPick>(ctx)?.subjects[index] ?? null;
}

/**
 * Зупиняє таймер і записує пройдений час у журнал навчання, не більше `TIMER_CAP`.
 * Менше хвилини не записується; повторне натискання не дублює запис.
 */
export async function stopTimer(ctx: Ctx): Promise<void> {
  const start = ctx.user.timer_start;
  if (!start) {
    await reply(ctx, 'Таймер не запущено.', { reply_markup: kb([btn('⏱ Почати заняття', 'tm:start')]) });
    return;
  }
  const subject = ctx.user.timer_subject ?? 'Навчання';
  let minutes = Math.round((ctx.now - start) / 60);
  // Подвійне натискання "Стоп" не має записати час двічі.
  if (!(await ctx.db.claimTimer(ctx.user.id, start))) return;
  ctx.user.timer_start = null;
  ctx.user.timer_subject = null;
  if (minutes < 1) {
    await reply(ctx, 'Минуло менше хвилини, нічого не записую.');
    return;
  }
  let note = '';
  if (minutes > TIMER_CAP) {
    minutes = TIMER_CAP;
    note = `\nТаймер ішов понад ${formatDuration(TIMER_CAP)}, тож записав ${formatDuration(TIMER_CAP)}. Якщо навчання тривало менше, наступного разу зупиняй таймер одразу.`;
  }
  const day = ymdToString(today(ctx));
  await ctx.db.addStudy(ctx.user.id, subject, minutes, day, ctx.now);
  const todayTotal = (await ctx.db.studyByDay(ctx.user.id, day)).reduce((a, r) => a + r.minutes, 0);
  await reply(ctx, `✅ Записав <b>${formatDuration(minutes)}</b>: ${escapeHtml(subject)}. Сьогодні загалом ${formatDuration(todayTotal)}.${note}`, {
    reply_markup: kb([btn('📊 Прогрес', 'pg:show')]),
  });
}

/** Починає ручний запис часу: ставить крок "log_time" і показує приклади формату. */
export async function startLogTime(ctx: Ctx): Promise<void> {
  await setState(ctx, 'log_time');
  await reply(ctx, '➕ Напиши, скільки часу і з якого предмета, наприклад: <code>45 хв математика</code>, <code>1.5 год фізика</code> або <code>1:20 англійська</code>.', {
    reply_markup: kb(CANCEL_ROW),
  });
}

/**
 * Розбирає тривалість і предмет з тексту та записує навчання на сьогодні в D1; скидає крок діалогу.
 * Без тривалості просить повторити, крок лишається.
 */
export async function onLogTimeText(ctx: Ctx, text: string): Promise<void> {
  const parsed = parseDuration(text);
  if (!parsed) {
    await reply(ctx, 'Не бачу тривалості. Приклад: <code>40 хв історія</code>.', { reply_markup: kb(CANCEL_ROW) });
    return;
  }
  const subject = truncate(parsed.rest || 'Навчання', 60);
  await ctx.db.addStudy(ctx.user.id, subject, parsed.minutes, ymdToString(today(ctx)), ctx.now);
  await setState(ctx, null);
  await reply(ctx, `✅ Записав ${formatDuration(parsed.minutes)}: ${escapeHtml(subject)}.`, { reply_markup: kb([btn('📊 Прогрес', 'pg:show')]) });
}

