/**
 * План підготовки до НМТ чи іспитів. Майстер з кількох кроків: що готуємо,
 * предмети й дати, складність і рівень по кожному предмету, бюджет часу. Сам
 * розрахунок годин і розклад по днях робить src/planner.ts без ШІ; ШІ лише
 * за бажанням підказує, що саме вчити.
 */

import { complete } from '../../ai/client';
import { buildPlanAdvice, NMT_SUBJECTS } from '../../ai/prompts';
import { escapeHtml, truncate } from '../../format';
import { parseDeadline, parseDuration } from '../../parse';
import { buildStudyPlan, parseAvailability, type StudyPlan } from '../../planner';
import { reminderTimes } from '../../reminders';
import { compareYmd, daysBetween, formatDate, formatDuration, localParts, parseYmd, plural, ymdOf, ymdToString, zonedToEpoch, type Ymd } from '../../time';
import { local, reply, setState, stateData, today, withAi, type Ctx } from '../context';
import { btn, CANCEL_ROW, grid, kb } from '../ui';
import { textChart } from './progress';
import { shortDay, showTask } from './tasks';
import type { InlineKeyboard } from '../../telegram';

/** Що готуємо: НМТ, іспити чи сесія, або довільний набір предметів. */
type PlanKind = 'nmt' | 'exam' | 'custom';

/** Предмет у чернетці плану: `difficulty` і `level` від 1 до 5, `exam` - дата іспиту "YYYY-MM-DD" або null. */
interface DraftSubject {
  name: string;
  difficulty: number;
  level: number;
  exam: string | null;
}

/**
 * Чернетка майстра, яка лежить у стані діалогу "plan" як JSON. `selected` - коди обраних предметів НМТ,
 * `budget` - загальний ліміт часу в хвилинах, null означає весь вільний час.
 */
interface PlanDraft {
  kind: PlanKind;
  step: 'nmt_subjects' | 'subjects_text' | 'date' | 'rate' | 'budget' | 'preview';
  selected: string[];
  subjects: DraftSubject[];
  budget: number | null;
}

/** Готові варіанти вільного часу, хвилин [пн..нд]. */
export const AVAILABILITY_PRESETS: Array<{ code: string; label: string; minutes: number[] }> = [
  { code: 'a1', label: 'Будні 1 год, вихідні 2', minutes: [60, 60, 60, 60, 60, 120, 120] },
  { code: 'a2', label: 'Будні 2 год, вихідні 3', minutes: [120, 120, 120, 120, 120, 180, 180] },
  { code: 'a3', label: 'Будні 3 год, вихідні 4', minutes: [180, 180, 180, 180, 180, 240, 240] },
];

/** Орієнтовна дата НМТ, поки офіційний календар не оголошено: найближче 20 травня. */
export function defaultNmtDate(from: Ymd): Ymd {
  const thisYear = { year: from.year, month: 5, day: 20 };
  return compareYmd(thisYear, from) > 0 ? thisYear : { year: from.year + 1, month: 5, day: 20 };
}

/** Чернетка плану з поточного стану діалогу; null, якщо діалог не на майстрі плану. */
function draft(ctx: Ctx): PlanDraft | null {
  return ctx.user.state === 'plan' ? stateData<PlanDraft>(ctx) : null;
}

/** Чи є незавершена чернетка плану (кнопки старих повідомлень без неї не працюють). */
export function hasDraft(ctx: Ctx): boolean {
  return draft(ctx) !== null;
}

/** Назва завдання-плану; за нею новий план замінює старий на ті самі предмети. */
function planTitle(d: PlanDraft): string {
  return d.kind === 'nmt' ? 'Підготовка до НМТ' : truncate(`Підготовка: ${d.subjects.map((s) => s.name).join(', ')}`, 80);
}

/** Зайнятий час інших планів; кроки старого плану з такою самою назвою не враховуються, бо він буде замінений. */
async function busyFor(ctx: Ctx, d: PlanDraft): Promise<Record<string, number>> {
  const replaced = await ctx.db.planTaskIds(ctx.user.id, planTitle(d));
  return ctx.db.busyByDate(ctx.user.id, ymdToString(today(ctx)), replaced);
}

/** Зберігає чернетку в стані діалогу (запис у D1). */
async function saveDraft(ctx: Ctx, d: PlanDraft): Promise<void> {
  await setState(ctx, 'plan', d);
}

/** "пн-пт 2 год, сб 3 год, нд 1 год" для показу вільного часу. */
export function availabilityText(minutes: number[]): string {
  const names = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд'];
  const parts: string[] = [];
  let i = 0;
  while (i < 7) {
    let j = i;
    while (j + 1 < 7 && minutes[j + 1] === minutes[i]) j++;
    const label = i === j ? names[i] : `${names[i]}-${names[j]}`;
    parts.push(`${label} ${minutes[i] ? formatDuration(minutes[i]) : 'вихідний'}`);
    i = j + 1;
  }
  return parts.join(', ');
}

/** Скидає крок діалогу і питає, до чого готуємося: НМТ, іспити чи свої предмети. */
export async function startPlan(ctx: Ctx): Promise<void> {
  await setState(ctx, null);
  await reply(
    ctx,
    '🎯 <b>План підготовки</b>\n\nПорахую, скільки годин дати кожному предмету за його складністю й твоїм рівнем, ' +
      'і розкладу заняття по вільних днях так, щоб кожен предмет устиг до свого іспиту. Якщо до раннього іспиту часу замало, ' +
      'зайве перейде на предмети з пізнішими датами. До чого готуємося?',
    { reply_markup: kb([btn('🎓 НМТ', 'pl:k:nmt'), btn('📚 Іспити / сесія', 'pl:k:exam')], [btn('📝 Свої предмети', 'pl:k:custom')]) },
  );
}

/**
 * Створює чернетку обраного виду. Для НМТ наперед відмічає обов'язкові предмети, для інших видів просить
 * текстовий список предметів.
 */
export async function chooseKind(ctx: Ctx, kind: PlanKind): Promise<void> {
  if (kind === 'nmt') {
    const d: PlanDraft = { kind, step: 'nmt_subjects', selected: NMT_SUBJECTS.filter((s) => s.mandatory).map((s) => s.code), subjects: [], budget: null };
    await saveDraft(ctx, d);
    await reply(ctx, nmtSubjectsText(), { reply_markup: nmtSubjectsKeyboard(d.selected) });
    return;
  }
  await saveDraft(ctx, { kind, step: 'subjects_text', selected: [], subjects: [], budget: null });
  await reply(
    ctx,
    'Напиши предмети, по одному на рядок. Якщо є дата іспиту, допиши її:\n\n<code>Вища математика 20.01\nФізика 25.01\nАнглійська</code>\n\n' +
      'Предмети без дати плануватиму на 4 тижні або до найпізнішого іспиту, якщо він пізніше.',
    { reply_markup: kb(CANCEL_ROW) },
  );
}

/** Підказка до вибору предметів НМТ. */
function nmtSubjectsText(): string {
  return '🎓 Обери предмети НМТ (у 2026 році: 3 обов\'язкові та 1 на вибір; формат 2027 року ще не оголошено).';
}

/** Кнопки предметів НМТ з позначкою обраних, "Далі" і скасування. */
function nmtSubjectsKeyboard(selected: string[]): InlineKeyboard {
  const buttons = NMT_SUBJECTS.map((s) => btn(`${selected.includes(s.code) ? '✅' : '▫️'} ${s.name}`, `pl:s:${s.code}`));
  return kb(...grid(buttons, 2), [btn('Далі ▶️', 'pl:next')], CANCEL_ROW);
}

/** Додає чи прибирає предмет НМТ з вибору й оновлює повідомлення. Поза кроком вибору нічого не робить. */
export async function toggleNmtSubject(ctx: Ctx, code: string, messageId: number): Promise<void> {
  const d = draft(ctx);
  if (!d || d.step !== 'nmt_subjects') return;
  d.selected = d.selected.includes(code) ? d.selected.filter((c) => c !== code) : [...d.selected, code];
  await saveDraft(ctx, d);
  await ctx.tg.editHtml(ctx.chatId, messageId, nmtSubjectsText(), nmtSubjectsKeyboard(d.selected));
}

/** Завершує вибір предметів НМТ і питає дату. Повертає false, якщо чернетки немає, крок інший чи нічого не обрано. */
export async function nmtSubjectsDone(ctx: Ctx): Promise<boolean> {
  const d = draft(ctx);
  if (!d || d.step !== 'nmt_subjects') return false;
  if (!d.selected.length) return false;
  d.subjects = NMT_SUBJECTS.filter((s) => d.selected.includes(s.code)).map((s) => ({ name: s.name, difficulty: 3, level: 3, exam: null }));
  d.step = 'date';
  await saveDraft(ctx, d);
  const auto = defaultNmtDate(today(ctx));
  await reply(ctx, `📆 Коли НМТ? Напиши дату, наприклад <code>${auto.day}.${String(auto.month).padStart(2, '0')}.${auto.year}</code>, або натисни кнопку.`, {
    reply_markup: kb([btn(`Орієнтовно ${formatDate(auto)} ${auto.year}`, 'pl:d:auto')], CANCEL_ROW),
  });
  return true;
}

/**
 * Задає дату іспиту всім предметам чернетки й переходить до оцінювання. Дата має бути від 2 до 400 днів
 * від сьогодні, інакше просить іншу.
 */
export async function setNmtDate(ctx: Ctx, date: Ymd): Promise<void> {
  const d = draft(ctx);
  if (!d) return;
  const days = daysBetween(today(ctx), date);
  if (days < 2 || days > 400) {
    await reply(ctx, 'Дата має бути щонайменше через 2 дні і не далі ніж за рік. Спробуй ще раз.', { reply_markup: kb(CANCEL_ROW) });
    return;
  }
  d.subjects = d.subjects.map((s) => ({ ...s, exam: ymdToString(date) }));
  await goRate(ctx, d);
}

/** Розбирає рядки "Предмет [дата]" для іспитів і своїх предметів. */
export function parseSubjectLines(text: string, nowSec: number, tz: string): DraftSubject[] {
  const out: DraftSubject[] = [];
  for (const raw of text.split(/[\n;]+/)) {
    const line = raw.trim();
    if (!line) continue;
    const parsed = parseDeadline(line, nowSec, tz);
    const name = truncate((parsed ? parsed.title : line).replace(/[,.:;]+$/, ''), 40);
    if (!name || name === 'Дедлайн') continue;
    const exam = parsed ? ymdToString(ymdOf(localParts(parsed.due, tz))) : null;
    out.push({ name: name[0].toUpperCase() + name.slice(1), difficulty: 3, level: 3, exam });
  }
  return out.slice(0, 8);
}

/** Приймає список предметів із датами; відхиляє порожній список і дати, що вже минули. */
async function onSubjectsText(ctx: Ctx, d: PlanDraft, text: string): Promise<void> {
  const subjects = parseSubjectLines(text, ctx.now, ctx.user.tz);
  const t = today(ctx);
  const past = subjects.filter((s) => s.exam && compareYmd(parseYmd(s.exam)!, t) <= 0);
  if (!subjects.length) {
    await reply(ctx, 'Не бачу жодного предмета. Напиши, наприклад: <code>Фізика 25.01</code>', { reply_markup: kb(CANCEL_ROW) });
    return;
  }
  if (past.length) {
    await reply(ctx, `Дата вже минула або сьогодні: ${past.map((s) => escapeHtml(s.name)).join(', ')}. Виправ дату чи прибери предмет.`, {
      reply_markup: kb(CANCEL_ROW),
    });
    return;
  }
  d.subjects = subjects;
  await goRate(ctx, d);
}

const DIFF_LABEL = ['', 'дуже легко', 'легко', 'середньо', 'важко', 'дуже важко'];
const LEVEL_LABEL = ['', 'слабкий', 'нижче середнього', 'середній', 'добрий', 'сильний'];

/** Текст кроку оцінювання: складність і рівень по кожному предмету. */
function rateText(d: PlanDraft): string {
  const lines = d.subjects.map(
    (s, i) => `${i + 1}. <b>${escapeHtml(s.name)}</b>${s.exam ? ` (іспит ${formatDate(parseYmd(s.exam)!)})` : ''}: складність ${s.difficulty} (${DIFF_LABEL[s.difficulty]}), рівень ${s.level} (${LEVEL_LABEL[s.level]})`,
  );
  return (
    '⚖️ <b>Оціни кожен предмет</b>\n\n💪 складність для тебе: 1 легко ... 5 дуже важко\n📚 твій рівень зараз: 1 слабкий ... 5 сильний\n' +
    'Натискай кнопки, щоб змінити значення.\n\n' +
    lines.join('\n')
  );
}

/** Кнопки циклічної зміни складності й рівня для кожного предмета. */
function rateKeyboard(d: PlanDraft): InlineKeyboard {
  return kb(
    ...d.subjects.map((s, i) => [btn(`${i + 1}. ${truncate(s.name, 14)}`, `pl:r:n:${i}`), btn(`💪 ${s.difficulty}`, `pl:r:d:${i}`), btn(`📚 ${s.level}`, `pl:r:l:${i}`)]),
    [btn('Далі ▶️', 'pl:r:ok')],
    CANCEL_ROW,
  );
}

/** Переводить чернетку на крок оцінювання і показує його. */
async function goRate(ctx: Ctx, d: PlanDraft): Promise<void> {
  d.step = 'rate';
  await saveDraft(ctx, d);
  await reply(ctx, rateText(d), { reply_markup: rateKeyboard(d) });
}

/**
 * Збільшує складність (`field` = "d") чи рівень ("l") предмета з індексом `index` на 1, після 5 повертається до 1.
 * Працює лише на кроці оцінювання.
 */
export async function cycleRating(ctx: Ctx, field: 'd' | 'l', index: number, messageId: number): Promise<void> {
  const d = draft(ctx);
  const s = d?.subjects[index];
  if (!d || !s || d.step !== 'rate') return;
  if (field === 'd') s.difficulty = (s.difficulty % 5) + 1;
  else s.level = (s.level % 5) + 1;
  await saveDraft(ctx, d);
  await ctx.tg.editHtml(ctx.chatId, messageId, rateText(d), rateKeyboard(d));
}

/** Рахує план за чернеткою; `busy` - хвилини, уже зайняті іншими планами, за датами "YYYY-MM-DD". */
function planFor(ctx: Ctx, d: PlanDraft, busy: Record<string, number>): StudyPlan {
  return buildStudyPlan(
    d.subjects.map((s) => ({ name: s.name, difficulty: s.difficulty, level: s.level, exam: s.exam ? parseYmd(s.exam) : null })),
    { budget: d.budget, availability: parseAvailability(ctx.user.availability), from: today(ctx), busy },
  );
}

/** Кнопки готових варіантів вільного часу (поточний позначено) і "Весь вільний час". */
function budgetKeyboard(current: number[]): InlineKeyboard {
  return kb(
    ...AVAILABILITY_PRESETS.map((p) => [btn(`${p.minutes.every((m, i) => m === current[i]) ? '✅ ' : ''}${p.label}`, `pl:av:${p.code}`)]),
    [btn('Весь вільний час ▶️', 'pl:b:all')],
    CANCEL_ROW,
  );
}

/** Текст кроку бюджету з вільним часом користувача й місткістю до іспитів. */
async function budgetText(ctx: Ctx, d: PlanDraft): Promise<string> {
  const busy = await busyFor(ctx, d);
  const capacity = planFor(ctx, { ...d, budget: null }, busy).capacity;
  const avail = parseAvailability(ctx.user.availability);
  return (
    '⏱ <b>Скільки годин усього можна витратити на підготовку?</b>\n' +
    'Напиши число, наприклад <code>12</code>, або натисни "Весь вільний час".\n\n' +
    `Твій вільний час для навчання: ${availabilityText(avail)}.\nДо іспитів це приблизно <b>${formatDuration(capacity)}</b>` +
    ' (без часу, вже зайнятого іншими планами). Можна змінити кнопками нижче або в ⚙️ Налаштування.'
  );
}

/** Переводить чернетку на крок бюджету часу і показує його. */
export async function goBudget(ctx: Ctx): Promise<void> {
  const d = draft(ctx);
  if (!d) return;
  d.step = 'budget';
  await saveDraft(ctx, d);
  await reply(ctx, await budgetText(ctx, d), { reply_markup: budgetKeyboard(parseAvailability(ctx.user.availability)) });
}

/** Записує обраний варіант вільного часу в налаштування користувача (D1) і оновлює повідомлення бюджету. */
export async function setAvailabilityPreset(ctx: Ctx, code: string, messageId: number): Promise<void> {
  const preset = AVAILABILITY_PRESETS.find((p) => p.code === code);
  const d = draft(ctx);
  if (!preset || !d) return;
  const json = JSON.stringify(preset.minutes);
  await ctx.db.updateUser(ctx.user.id, { availability: json });
  ctx.user.availability = json;
  await ctx.tg.editHtml(ctx.chatId, messageId, await budgetText(ctx, d), budgetKeyboard(preset.minutes));
}

/** Задає ліміт часу на підготовку в хвилинах (null: весь вільний час) і показує розрахунок. */
export async function setBudget(ctx: Ctx, minutes: number | null): Promise<void> {
  const d = draft(ctx);
  if (!d) return;
  d.budget = minutes;
  d.step = 'preview';
  await saveDraft(ctx, d);
  await showPreview(ctx, d);
}

/** Текст розрахунку: розподіл часу по предметах, перші дні, кількість занять і попередження планувальника. */
function previewHtml(ctx: Ctx, d: PlanDraft, plan: StudyPlan): string {
  const t = today(ctx);
  const rows = plan.subjects.map((s) => ({
    label: truncate(s.name, 16),
    value: s.scheduled,
    text: `${formatDuration(s.scheduled)}${plan.budget ? ` · ${Math.round((s.scheduled / Math.max(1, plan.subjects.reduce((a, x) => a + x.scheduled, 0))) * 100)}%` : ''}`,
  }));
  const planned = plan.subjects.reduce((a, s) => a + s.scheduled, 0);
  const firstDays = plan.days.slice(0, 7).map((day) => `${shortDay(day.date)}: ${day.sessions.map((s) => `${escapeHtml(s.subject)} ${formatDuration(s.minutes)}`).join(', ')}`);
  const sessions = plan.days.reduce((a, day) => a + day.sessions.length, 0);
  const last = plan.days[plan.days.length - 1];
  const parts = [
    '🧮 <b>Розрахунок часу</b>',
    `Вільного часу до іспитів: ${formatDuration(plan.capacity)} · у плані: <b>${formatDuration(planned)}</b>`,
    `<pre>${escapeHtml(textChart(rows, 10))}</pre>`,
    'Більше часу отримують складніші предмети й ті, де рівень нижчий. Першими йдуть предмети з ближчим іспитом, а один предмет займає не більше 2 годин на день, якщо його є чим чергувати і він устигає до іспиту.',
  ];
  if (firstDays.length) {
    parts.push(`📆 <b>Перші дні</b>\n${firstDays.join('\n')}`);
    parts.push(`Усього ${sessions} ${plural(sessions, ['заняття', 'заняття', 'занять'])}${last ? `, останнє ${formatDate(parseYmd(last.date)!, t)}` : ''}.`);
  }
  if (plan.warnings.length) parts.push(plan.warnings.map((w) => `⚠️ ${escapeHtml(w)}`).join('\n'));
  if (d.kind === 'nmt') parts.push('<i>Офіційні дати НМТ-2027 ще не оголошені; коли з\'являться, просто склади план заново.</i>');
  return parts.join('\n\n');
}

/** Показує розрахунок із кнопками; "Зберегти" з'являється лише тоді, коли в плані є заняття. */
async function showPreview(ctx: Ctx, d: PlanDraft): Promise<void> {
  const plan = planFor(ctx, d, await busyFor(ctx, d));
  const canSave = plan.days.length > 0;
  await reply(ctx, previewHtml(ctx, d, plan), {
    reply_markup: kb(
      canSave ? [btn('✅ Зберегти план', 'pl:save')] : [],
      [btn('🤖 Що вчити: поради ШІ', 'pl:tips:0')],
      [btn('⚖️ Змінити оцінки', 'pl:edit'), btn('⏱ Змінити години', 'pl:budget')],
      CANCEL_ROW,
    ),
  });
}

/** Повертає чернетку з розрахунку на крок оцінювання. */
export async function backToRate(ctx: Ctx): Promise<void> {
  const d = draft(ctx);
  if (d) await goRate(ctx, d);
}

/**
 * Зберігає розрахований план як завдання виду "plan" (кроки - заняття по днях) і скидає крок діалогу.
 * Дати іспитів стають дедлайнами з нагадуваннями, без дублікатів; попередній план з тією самою назвою видаляється.
 * Повторне натискання нічого не зберігає вдруге.
 */
export async function savePlan(ctx: Ctx): Promise<void> {
  const d = draft(ctx);
  // claimState не дає подвійному натисканню зберегти план двічі.
  if (!d || d.step !== 'preview' || !(await ctx.db.claimState(ctx.user.id, 'plan', ctx.user.state_data))) {
    await reply(ctx, 'Чернетка плану вже неактуальна. Почни заново: 🎯 План підготовки.');
    return;
  }
  ctx.user.state = null;
  ctx.user.state_data = null;
  const tz = ctx.user.tz;
  const title = planTitle(d);
  const replaced = await ctx.db.planTaskIds(ctx.user.id, title);
  const plan = planFor(ctx, d, await ctx.db.busyByDate(ctx.user.id, ymdToString(today(ctx)), replaced));
  if (!plan.days.length) {
    await reply(ctx, 'У плані немає жодного заняття: додай вільного часу в налаштуваннях.');
    return;
  }

  const byDate = new Map<string, string[]>();
  for (const s of d.subjects) if (s.exam) byDate.set(s.exam, [...(byDate.get(s.exam) ?? []), s.name]);
  let deadlineId: number | null = null;
  let newDeadlines = 0;
  for (const [date, names] of byDate) {
    const y = parseYmd(date)!;
    const due = zonedToEpoch(y.year, y.month, y.day, 23, 59, tz);
    const deadlineTitle = truncate(d.kind === 'nmt' ? 'НМТ' : `${d.kind === 'exam' ? 'Іспит' : 'Термін'}: ${names.join(', ')}`, 100);
    // Та сама дата іспиту вже записана (наприклад, план складається вдруге): не дублюємо.
    const existing = await ctx.db.findOpenDeadline(ctx.user.id, deadlineTitle, due);
    let id = existing?.id;
    if (!id) {
      id = await ctx.db.addDeadline(ctx.user.id, deadlineTitle, due, true, reminderTimes(due, true, ctx.now, tz), ctx.now);
      await ctx.db.setDeadlineRating(ctx.user.id, id, 'importance', 3);
      newDeadlines++;
    }
    deadlineId ??= id;
  }

  for (const oldId of replaced) await ctx.db.deleteTask(ctx.user.id, oldId);
  const steps = plan.days.flatMap((day) => day.sessions.map((s) => ({ text: s.subject, subject: s.subject, minutes: s.minutes, due_date: day.date })));
  const taskId = await ctx.db.createTask(ctx.user.id, title, 'plan', deadlineId, steps, ctx.now);
  const total = steps.reduce((a, s) => a + s.minutes, 0);
  await reply(
    ctx,
    `✅ План збережено: ${steps.length} ${plural(steps.length, ['заняття', 'заняття', 'занять'])}, разом ${formatDuration(total)}.` +
      (replaced.length ? ' Попередній план із тими самими предметами замінено.' : '') +
      (newDeadlines ? ' Дати іспитів записав у ⏰ Дедлайни з нагадуваннями.' : '') +
      '\nЩоранку в зведенні будуть заняття на день. Познач заняття виконаним, і час запишеться в 📊 Прогрес.',
  );
  await showTask(ctx, taskId);
}

/** Поради ШІ, що вчити: для чернетки (`taskId` = 0) або збереженого плану. */
export async function planTips(ctx: Ctx, taskId: number): Promise<void> {
  let kind: PlanKind = 'custom';
  let subjects: Array<{ name: string; difficulty?: number; level?: number; exam?: string | null; minutes: number }> = [];
  if (taskId === 0) {
    const d = draft(ctx);
    if (!d) {
      await startPlan(ctx);
      return;
    }
    const plan = planFor(ctx, d, await busyFor(ctx, d));
    kind = d.kind;
    subjects = d.subjects.map((s) => ({ ...s, minutes: plan.subjects.find((p) => p.name === s.name)?.scheduled ?? 0 }));
  } else {
    const found = await ctx.db.getTask(ctx.user.id, taskId);
    if (!found) {
      await reply(ctx, 'Цього плану вже немає.');
      return;
    }
    kind = found.task.title.includes('НМТ') ? 'nmt' : 'exam';
    const bySubject = new Map<string, { minutes: number; last: string | null }>();
    for (const s of found.steps) {
      const key = s.subject ?? s.text;
      const prev = bySubject.get(key) ?? { minutes: 0, last: null };
      bySubject.set(key, { minutes: prev.minutes + (s.minutes ?? 0), last: s.due_date && (!prev.last || s.due_date > prev.last) ? s.due_date : prev.last });
    }
    subjects = [...bySubject.entries()].map(([name, v]) => ({ name, minutes: v.minutes, exam: v.last }));
  }
  const p = local(ctx);
  const result = await withAi(ctx, () =>
    complete(ctx.env, { messages: buildPlanAdvice(kind === 'nmt', subjects, ymdToString(ymdOf(p))), maxTokens: 2000, temperature: 0.5 }),
  );
  if (!result) return;
  await ctx.tg.sendMarkdown(ctx.chatId, result.text);
}

/** Текстові відповіді на кроках майстра. Повертає true, якщо текст оброблено. */
export async function onPlanText(ctx: Ctx, text: string): Promise<boolean> {
  const d = draft(ctx);
  if (!d) return false;
  if (d.step === 'nmt_subjects' || d.step === 'rate') {
    await reply(ctx, 'На цьому кроці натискай кнопки під повідомленням вище. Щоб вийти з майстра, натисни /cancel.');
    return true;
  }
  if (d.step === 'subjects_text') {
    await onSubjectsText(ctx, d, text);
    return true;
  }
  if (d.step === 'date') {
    const parsed = parseDeadline(text, ctx.now, ctx.user.tz);
    if (!parsed) {
      await reply(ctx, 'Не бачу дати. Напиши, наприклад, <code>20.05.2027</code>.', { reply_markup: kb(CANCEL_ROW) });
      return true;
    }
    await setNmtDate(ctx, ymdOf(localParts(parsed.due, ctx.user.tz)));
    return true;
  }
  if (d.step === 'budget' || d.step === 'preview') {
    const hours = /^\s*(\d+(?:[.,]\d+)?)\s*(?:год[а-яіїєґ]*)?\s*$/i.exec(text);
    const minutes = hours ? Math.round(Number(hours[1].replace(',', '.')) * 60) : parseDuration(text)?.minutes ?? null;
    if (!minutes || minutes < 30 || minutes > 2000 * 60) {
      await reply(ctx, 'Напиши кількість годин числом, наприклад <code>12</code> або <code>40</code>.', { reply_markup: kb(CANCEL_ROW) });
      return true;
    }
    await setBudget(ctx, minutes);
    return true;
  }
  return false;
}

/** Орієнтовна дата НМТ відносно сьогоднішнього дня користувача. */
export function nmtAutoDate(ctx: Ctx): Ymd {
  return defaultNmtDate(today(ctx));
}

