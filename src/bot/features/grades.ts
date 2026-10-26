/**
 * Оцінки: запис, середній бал по предметах і розрахунок, які оцінки потрібні
 * для бажаної підсумкової. Усе рахується без ШІ (див. src/grades.ts).
 */

import { escapeHtml, truncate } from '../../format';
import { formatGrade, overallAverage, parseGrades, roundedGrade, subjectStats, targetPlan, type GradeScale, type SubjectStats } from '../../grades';
import { plural } from '../../time';
import { reply, setState, stateData, type Ctx } from '../context';
import { btn, CANCEL_ROW, grid, kb } from '../ui';
import { textChart } from './progress';

/** Шкала оцінок користувача; будь-яке значення, крім 5 і 100, вважається 12-бальною шкалою. */
function scaleOf(ctx: Ctx): GradeScale {
  const s = ctx.user.grade_scale;
  return s === 5 || s === 100 ? s : 12;
}

/** Статистика по предметах, від найслабшого за середнім балом. */
async function loadStats(ctx: Ctx): Promise<SubjectStats[]> {
  const rows = await ctx.db.listGrades(ctx.user.id);
  return subjectStats(rows.map((r) => ({ subject: r.subject, value: r.value, weight: r.weight })));
}

/** Надсилає середній бал по предметах діаграмою й загальний середній; без оцінок пропонує їх додати. */
export async function showGrades(ctx: Ctx): Promise<void> {
  const scale = scaleOf(ctx);
  const stats = await loadStats(ctx);
  if (!stats.length) {
    await reply(
      ctx,
      `🎓 <b>Оцінки</b>\n\nЗаписуй оцінки, і я рахуватиму середній бал та підкажу, що треба отримати для бажаної підсумкової.\nШкала: ${scale}-бальна (змінюється в ⚙️ Налаштування).`,
      { reply_markup: kb([btn('➕ Додати оцінки', 'gr:add')]) },
    );
    return;
  }
  const avg = overallAverage(stats)!;
  const rows = [...stats]
    .reverse()
    .map((s) => ({ label: truncate(s.subject, 14), value: s.average, text: `${formatGrade(s.average)} (${s.count})` }));
  const html =
    `🎓 <b>Оцінки</b> (шкала ${scale})\n\n<pre>${escapeHtml(textChart(rows, 10))}</pre>\n` +
    `Загальний середній: <b>${formatGrade(avg)}</b> (≈ ${roundedGrade(avg)})\n` +
    `У дужках кількість оцінок. Найслабший предмет: <b>${escapeHtml(stats[0].subject)}</b>.`;
  await reply(ctx, html, {
    reply_markup: kb(
      [btn('➕ Додати оцінки', 'gr:add'), btn('🎯 Скільки треба?', 'gr:target')],
      [btn('🗑 Видалити останню', 'gr:undo'), btn('🧹 Очистити', 'gr:clr')],
    ),
  });
}

/** Починає введення оцінок: ставить крок "grades_add" і надсилає формат запису. */
export async function startAddGrades(ctx: Ctx): Promise<void> {
  await setState(ctx, 'grades_add');
  await reply(
    ctx,
    `➕ Напиши оцінки, по предмету на рядок:\n\n<code>Математика 10 11 9\nФізика 8, 7x2\nАнглійська 12</code>\n\n` +
      `"x2" означає вагу 2 (наприклад, контрольна рахується двічі). Шкала: ${scaleOf(ctx)}-бальна.`,
    { reply_markup: kb(CANCEL_ROW) },
  );
}

/**
 * Розбирає оцінки з тексту і записує їх у D1, скидає крок діалогу та показує підсумок.
 * Якщо жодної оцінки не розібрано, крок лишається, щоб людина могла виправити запис.
 */
export async function onGradesText(ctx: Ctx, text: string): Promise<void> {
  const { grades, bad } = parseGrades(text, scaleOf(ctx));
  if (!grades.length) {
    await reply(ctx, `Не вдалося розібрати оцінки. Приклад: <code>Історія 9 10 8</code>. Оцінки мають бути від ${scaleOf(ctx) === 100 ? 0 : 1} до ${scaleOf(ctx)}.`, {
      reply_markup: kb(CANCEL_ROW),
    });
    return;
  }
  await ctx.db.addGrades(ctx.user.id, grades, ctx.now);
  await setState(ctx, null);
  let note = `✅ Записав ${grades.length} ${plural(grades.length, ['оцінку', 'оцінки', 'оцінок'])}.`;
  if (bad.length) note += `\n⚠️ Не зрозумів: ${bad.map((b) => escapeHtml(truncate(b, 60))).join('; ')}`;
  await reply(ctx, note);
  await showGrades(ctx);
}

/** Дані кроку "grade_target": предмети в порядку кнопок, щоб у callback_data йшов лише індекс. */
interface TargetState {
  subjects: string[];
}

/**
 * Пропонує вибрати предмет (до 20 кнопок) для розрахунку бажаної оцінки і ставить крок "grade_target".
 * Без жодної оцінки веде до їх введення.
 */
export async function chooseTargetSubject(ctx: Ctx): Promise<void> {
  const stats = await loadStats(ctx);
  if (!stats.length) {
    await startAddGrades(ctx);
    return;
  }
  const subjects = stats.map((s) => s.subject);
  await setState(ctx, 'grade_target', { subjects } satisfies TargetState);
  await reply(ctx, '🎯 Для якого предмета порахувати?', {
    reply_markup: kb(...grid(subjects.slice(0, 20).map((s, i) => btn(truncate(s, 24), `gr:s:${i}`)), 2), CANCEL_ROW),
  });
}

/** Варіанти бажаної підсумкової оцінки для шкали. */
function targetOptions(scale: GradeScale): number[] {
  if (scale === 5) return [3, 4, 5];
  if (scale === 100) return [60, 75, 90, 95];
  return [7, 8, 9, 10, 11, 12];
}

/**
 * Пропонує вибрати бажану підсумкову оцінку для предмета з індексом `subjectIndex` у стані
 * "grade_target"; якщо стан утрачено, повертає до вибору предмета.
 */
export async function chooseTargetGrade(ctx: Ctx, subjectIndex: number): Promise<void> {
  const subject = stateData<TargetState>(ctx)?.subjects[subjectIndex];
  if (!subject) {
    await chooseTargetSubject(ctx);
    return;
  }
  const options = targetOptions(scaleOf(ctx));
  await reply(ctx, `Яку підсумкову оцінку з предмета <b>${escapeHtml(subject)}</b> хочеш?`, {
    reply_markup: kb(...grid(options.map((g) => btn(String(g), `gr:g:${subjectIndex}:${g}`)), 6), CANCEL_ROW),
  });
}

/** Показує розрахунок: скільки і яких оцінок треба, щоб вийти на `target`. */
export async function showTarget(ctx: Ctx, subjectIndex: number, target: number): Promise<void> {
  const subject = stateData<TargetState>(ctx)?.subjects[subjectIndex];
  const scale = scaleOf(ctx);
  const stats = (await loadStats(ctx)).find((s) => s.subject === subject);
  if (!subject || !stats) {
    await chooseTargetSubject(ctx);
    return;
  }
  const plan = targetPlan(stats, target, scale);
  const head = `🎯 <b>${escapeHtml(subject)}</b>: зараз середній ${formatGrade(stats.average)} (${stats.count} ${plural(stats.count, ['оцінка', 'оцінки', 'оцінок'])}).`;
  let body: string;
  if (plan.reached) {
    body = `Уже виходить ${target} або вище. Щоб не втратити результат, отримуй оцінки не нижчі за ${formatGrade(plan.threshold)}.`;
  } else if (plan.impossible) {
    body = `На жаль, ${target} недосяжна: навіть самі ${scale} не піднімуть середній до ${formatGrade(plan.threshold)}. Спробуй ціль на бал нижчу.`;
  } else {
    const lines = plan.options.map(
      (o) => `• ${o.count} ${plural(o.count, ['оцінка', 'оцінки', 'оцінок'])}: у середньому від <b>${formatGrade(Math.ceil(o.neededAverage * 100) / 100)}</b>`,
    );
    const fastest = plan.maxGradesNeeded
      ? `${plan.maxGradesNeeded} ${plural(plan.maxGradesNeeded, ['оцінка', 'оцінки', 'оцінок'])} по ${scale}`
      : '';
    body =
      `Щоб вийшло ${target}, середній має бути від ${formatGrade(plan.threshold)}.` +
      (lines.length ? `\n\nСкільки треба отримати:\n${lines.join('\n')}` : '') +
      (fastest ? `\n\n${lines.length ? 'Найшвидший шлях' : 'Знадобиться щонайменше'}: ${fastest}.` : '');
  }
  await setState(ctx, null);
  await reply(ctx, `${head}\n\n${body}\n\n<i>Розрахунок вважає підсумкову оцінку округленим середнім; вчитель може враховувати й інше.</i>`, {
    reply_markup: kb([btn('🎓 Усі оцінки', 'gr:show')]),
  });
}

/** Видаляє з D1 останню додану оцінку і показує оновлений підсумок. */
export async function undoLastGrade(ctx: Ctx): Promise<void> {
  const removed = await ctx.db.deleteLastGrade(ctx.user.id);
  await reply(ctx, removed ? `🗑 Видалив оцінку ${formatGrade(removed.value)} з предмета ${escapeHtml(removed.subject)}.` : 'Оцінок немає.');
  if (removed) await showGrades(ctx);
}

/** Просить підтвердити видалення всіх оцінок; саме видалення виконує кнопка підтвердження. */
export async function confirmClearGrades(ctx: Ctx): Promise<void> {
  await reply(ctx, 'Видалити <b>всі</b> оцінки?', { reply_markup: kb([btn('🧹 Так, видалити', 'gr:clr!'), btn('Ні', 'gr:show')]) });
}
