/**
 * Сторінка з графіками прогресу: витрачений час по днях і предметах, виконані
 * завдання, середні бали. Відкривається з бота як Telegram Mini App за
 * підписаним посиланням (див. sign.ts) і рендериться на сервері в HTML без
 * сторонніх бібліотек. Графіки зроблені блоками CSS, тож підписи лишаються
 * читабельними на вузькому екрані телефона.
 */

import type { Db, User } from '../db';
import { escapeHtml } from '../format';
import { overallAverage, subjectStats, formatGrade, type GradeScale } from '../grades';
import { addDays, formatDuration, localParts, weekdayOf, WEEKDAYS_SHORT, ymdOf, ymdToString } from '../time';

interface Series {
  name: string;
  /** Номер категоріального кольору (1-3) або 0 для сірого "Інше". */
  slot: number;
  values: number[];
}

interface Tile {
  label: string;
  value: string;
  note?: string;
}

const attr = (s: string) => escapeHtml(s).replace(/"/g, '&quot;');

function niceStep(max: number): number {
  const rough = max / 4;
  const steps = [15, 30, 60, 120, 180, 240, 300, 600];
  return steps.find((s) => s >= rough) ?? Math.ceil(rough / 60) * 60;
}

function niceCountStep(max: number): number {
  const rough = Math.max(1, max / 4);
  return [1, 2, 5, 10, 20, 50].find((s) => s >= rough) ?? Math.ceil(rough / 10) * 10;
}

/** Короткий підпис осі для хвилин: "0", "0,5 год", "2 год". */
function hoursTick(minutes: number): string {
  if (minutes === 0) return '0';
  return `${String(Math.round((minutes / 60) * 10) / 10).replace('.', ',')} год`;
}

/** Стовпчикова діаграма по днях; кілька серій складаються в стопку. */
function columnChart(
  id: string,
  labels: string[],
  fullLabels: string[],
  series: Series[],
  format: (v: number) => string,
  step: (max: number) => number,
  tickFormat: (v: number) => string,
): string {
  const totals = labels.map((_, i) => series.reduce((a, s) => a + s.values[i], 0));
  const rawMax = Math.max(0, ...totals);
  const tick = step(rawMax || 1);
  const max = Math.max(tick, Math.ceil(rawMax / tick) * tick);
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += tick) ticks.push(v);

  const grid = ticks
    .map((v) => `<div class="gridline" style="bottom:${(v / max) * 100}%"><span>${escapeHtml(tickFormat(v))}</span></div>`)
    .join('');
  const cols = labels
    .map((label, i) => {
      const segs = series
        .map((s) => ({ s, v: s.values[i] }))
        .filter((x) => x.v > 0)
        .map((x) => `<div class="seg c${x.s.slot}" style="height:${(x.v / max) * 100}%"></div>`)
        .join('');
      const tip = JSON.stringify({
        title: fullLabels[i],
        rows: series.filter((s) => s.values[i] > 0).map((s) => ({ name: s.name, slot: s.slot, value: format(s.values[i]) })),
        total: totals[i] > 0 && series.length > 1 ? format(totals[i]) : null,
      });
      return `<div class="col" tabindex="0" data-tip="${attr(tip)}"><div class="stack">${segs}</div><div class="xlabel">${escapeHtml(label)}</div></div>`;
    })
    .join('');
  const legend =
    series.length > 1
      ? `<div class="legend">${series.map((s) => `<span><i class="key c${s.slot}"></i>${escapeHtml(s.name)}</span>`).join('')}</div>`
      : '';
  const head = `<tr><th>День</th>${series.map((s) => `<th>${escapeHtml(s.name)}</th>`).join('')}${series.length > 1 ? '<th>Разом</th>' : ''}</tr>`;
  const body = labels
    .map(
      (_, i) =>
        `<tr><td>${escapeHtml(fullLabels[i])}</td>${series.map((s) => `<td>${escapeHtml(s.values[i] ? format(s.values[i]) : '0')}</td>`).join('')}` +
        `${series.length > 1 ? `<td>${escapeHtml(totals[i] ? format(totals[i]) : '0')}</td>` : ''}</tr>`,
    )
    .join('');
  return (
    `${legend}<div class="columns" id="${id}"><div class="plot">${grid}<div class="cols">${cols}</div></div></div>` +
    `<details><summary>Показати таблицею</summary><table>${head}${body}</table></details>`
  );
}

/** Горизонтальні смуги для однієї серії зі значенням на кінці смуги. */
function barList(rows: Array<{ label: string; value: number; text: string }>, max: number): string {
  return `<div class="bars">${rows
    .map(
      (r) =>
        `<div class="barrow" tabindex="0" data-tip="${attr(JSON.stringify({ title: r.label, rows: [{ name: '', slot: 1, value: r.text }] }))}">` +
        `<div class="barlabel">${escapeHtml(r.label)}</div>` +
        `<div class="track"><div class="barbox"><div class="fill c1" style="width:${max > 0 ? Math.max(1, (r.value / max) * 100) : 0}%"></div></div><span class="barvalue">${escapeHtml(r.text)}</span></div></div>`,
    )
    .join('')}</div>`;
}

function card(title: string, subtitle: string, content: string): string {
  return `<section class="card"><h2>${escapeHtml(title)}</h2><p class="sub">${escapeHtml(subtitle)}</p>${content}</section>`;
}

function empty(text: string): string {
  return `<p class="empty">${escapeHtml(text)}</p>`;
}

/** Збирає дані користувача і повертає HTML сторінки графіків. Лише читає D1; `now`: unix-секунди. */
export async function renderCharts(db: Db, user: User, now: number): Promise<string> {
  const tz = user.tz;
  const today = ymdOf(localParts(now, tz));
  const from30 = addDays(today, -29);
  const days14 = Array.from({ length: 14 }, (_, i) => addDays(today, i - 13));
  const keys14 = days14.map(ymdToString);
  const weekFrom = ymdToString(addDays(today, -6));

  const [study, completions, grades, counts] = await Promise.all([
    db.studyByDay(user.id, ymdToString(from30)),
    db.completionTimes(user.id, now - 14 * 86400 - 86400),
    db.listGrades(user.id),
    db.progressCounts(user.id, weekFrom, ymdToString(today), now - 7 * 86400, now, now),
  ]);

  const study14 = study.filter((r) => r.day >= keys14[0]);
  const subjTotals14 = new Map<string, number>();
  for (const r of study14) subjTotals14.set(r.subject, (subjTotals14.get(r.subject) ?? 0) + r.minutes);
  const topSubjects = [...subjTotals14.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s]) => s);
  const series: Series[] = topSubjects.map((name, i) => ({ name, slot: i + 1, values: keys14.map(() => 0) }));
  const other: Series = { name: 'Інше', slot: 0, values: keys14.map(() => 0) };
  for (const r of study14) {
    const idx = keys14.indexOf(r.day);
    if (idx < 0) continue;
    const s = series.find((x) => x.name === r.subject) ?? other;
    s.values[idx] += r.minutes;
  }
  if (other.values.some((v) => v > 0)) series.push(other);
  const shortLabels = days14.map((d) => String(d.day));
  const fullLabels = days14.map((d) => `${WEEKDAYS_SHORT[weekdayOf(d) - 1]}, ${String(d.day).padStart(2, '0')}.${String(d.month).padStart(2, '0')}`);

  const weekMinutes = study.filter((r) => r.day >= weekFrom).reduce((a, r) => a + r.minutes, 0);
  const prevFrom = ymdToString(addDays(today, -13));
  const prevMinutes = study.filter((r) => r.day >= prevFrom && r.day < weekFrom).reduce((a, r) => a + r.minutes, 0);
  const delta = prevMinutes > 0 ? Math.round(((weekMinutes - prevMinutes) / prevMinutes) * 100) : null;

  const doneByDay = keys14.map(() => 0);
  for (const t of completions) {
    const key = ymdToString(ymdOf(localParts(t, tz)));
    const idx = keys14.indexOf(key);
    if (idx >= 0) doneByDay[idx]++;
  }

  const subjTotals30 = new Map<string, number>();
  for (const r of study) subjTotals30.set(r.subject, (subjTotals30.get(r.subject) ?? 0) + r.minutes);
  const subjRows = [...subjTotals30.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const total30 = subjRows.reduce((a, [, m]) => a + m, 0);

  const scale = (user.grade_scale as GradeScale) || 12;
  const gStats = subjectStats(grades.map((g) => ({ subject: g.subject, value: g.value, weight: g.weight })));
  const avg = overallAverage(gStats);

  const tiles: Tile[] = [
    { label: 'Час навчання за 7 днів', value: formatDuration(weekMinutes), note: delta === null ? undefined : `${delta >= 0 ? '+' : ''}${delta}% до попередніх 7 днів` },
    {
      label: 'Виконано за 7 днів',
      value: counts.periodSteps ? `${Math.round((counts.periodDone / counts.periodSteps) * 100)}%` : 'немає',
      note: counts.periodSteps ? `${counts.periodDone} з ${counts.periodSteps} кроків і занять` : 'немає кроків з датою',
    },
    { label: 'Дедлайни вчасно', value: `${counts.deadlinesOnTime} з ${counts.deadlinesDone}`, note: counts.overdueOpen ? `прострочено відкритих: ${counts.overdueOpen}` : 'за 7 днів' },
    { label: 'Середній бал', value: avg === null ? 'немає' : formatGrade(avg), note: avg === null ? 'додай оцінки в боті' : `шкала ${scale}` },
  ];

  const sections = [
    `<div class="tiles">${tiles
      .map((t) => `<div class="tile"><div class="tlabel">${escapeHtml(t.label)}</div><div class="tvalue">${escapeHtml(t.value)}</div>${t.note ? `<div class="tnote">${escapeHtml(t.note)}</div>` : ''}</div>`)
      .join('')}</div>`,
    card(
      'Час навчання по днях',
      'Останні 14 днів, за предметами',
      study14.length
        ? columnChart('time', shortLabels, fullLabels, series, (v) => formatDuration(v), niceStep, hoursTick)
        : empty('Поки немає записаного часу. Запускай таймер у розділі 📊 Прогрес.'),
    ),
    card(
      'Виконані завдання',
      'Кроки, заняття плану й дедлайни, позначені виконаними, за 14 днів',
      doneByDay.some((v) => v > 0)
        ? columnChart('done', shortLabels, fullLabels, [{ name: 'Виконано', slot: 1, values: doneByDay }], (v) => String(v), niceCountStep, (v) => String(v))
        : empty('Ще немає виконаних завдань за цей час.'),
    ),
    card(
      'Час за предметами',
      `Останні 30 днів, усього ${formatDuration(total30)}`,
      subjRows.length
        ? barList(subjRows.map(([s, m]) => ({ label: s, value: m, text: `${formatDuration(m)} · ${Math.round((m / total30) * 100)}%` })), subjRows[0][1])
        : empty('Немає даних.'),
    ),
    card(
      'Середній бал за предметами',
      `Шкала ${scale}, від найнижчого`,
      gStats.length
        ? barList(gStats.map((g) => ({ label: g.subject, value: g.average, text: `${formatGrade(g.average)} (${g.count})` })), scale)
        : empty('Оцінок ще немає. Додай їх у розділі 🎓 Оцінки.'),
    ),
  ];

  return page(sections.join(''));
}

function page(content: string): string {
  return `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Мій прогрес</title>
<style>
.viz-root{color-scheme:light;--surface-1:#fcfcfb;--page:#f9f9f7;--text-primary:#0b0b0b;--text-secondary:#52514e;--muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--ring:rgba(11,11,11,.10);--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a;--series-0:#b5b3ac}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz-root{color-scheme:dark;--surface-1:#1a1a19;--page:#0d0d0d;--text-primary:#f0efec;--text-secondary:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-0:#5f5e5a}}
:root[data-theme="dark"] .viz-root{color-scheme:dark;--surface-1:#1a1a19;--page:#0d0d0d;--text-primary:#f0efec;--text-secondary:#c3c2b7;--muted:#898781;--grid:#2c2c2a;--axis:#383835;--ring:rgba(255,255,255,.10);--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-0:#5f5e5a}
*{box-sizing:border-box}
html,body{margin:0}
body.viz-root{background:var(--page);color:var(--text-primary);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:4px 0 14px;font-weight:650}
h2{font-size:16px;margin:0;font-weight:600}
.sub{margin:2px 0 14px;color:var(--text-secondary);font-size:13px}
.card{background:var(--surface-1);border:1px solid var(--ring);border-radius:14px;padding:16px;margin:0 0 14px}
.tiles{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-bottom:14px}
@media (min-width:640px){.tiles{grid-template-columns:repeat(4,minmax(0,1fr))}}
.tile{background:var(--surface-1);border:1px solid var(--ring);border-radius:14px;padding:12px}
.tlabel{font-size:13px;color:var(--text-secondary)}
.tvalue{font-size:22px;font-weight:600;margin-top:2px}
.tnote{font-size:12px;color:var(--muted);margin-top:2px}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px;color:var(--text-secondary);margin:0 0 10px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.key{display:inline-block;width:10px;height:10px;border-radius:2px}
.c1{background:var(--series-1)}.c2{background:var(--series-2)}.c3{background:var(--series-3)}.c0{background:var(--series-0)}
.columns{padding-left:52px}
.plot{position:relative;height:190px;margin-bottom:22px}
.gridline{position:absolute;left:0;right:0;border-top:1px solid var(--grid)}
.gridline:first-child{border-top-color:var(--axis)}
.gridline span{position:absolute;right:100%;transform:translateY(-50%);padding-right:6px;font-size:11px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.cols{position:absolute;inset:0;display:flex;align-items:stretch}
.col{flex:1;position:relative;display:flex;justify-content:center;outline:none;cursor:default}
.col:focus-visible{background:var(--ring);border-radius:6px}
.stack{position:absolute;bottom:0;width:min(24px,70%);height:100%;display:flex;flex-direction:column-reverse;gap:0}
.seg{width:100%;flex:none}
.seg+.seg{border-bottom:2px solid var(--surface-1)}
.stack .seg:last-child{border-radius:4px 4px 0 0}
.col:hover .seg{filter:brightness(1.08)}
.xlabel{position:absolute;top:100%;margin-top:6px;font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums}
.bars{display:grid;gap:10px}
.barrow{display:grid;grid-template-columns:minmax(80px,32%) 1fr;gap:10px;align-items:center;outline:none}
.barrow:focus-visible{background:var(--ring);border-radius:6px}
.barlabel{font-size:13px;color:var(--text-secondary);overflow-wrap:anywhere}
.track{display:grid;grid-template-columns:minmax(0,1fr) 9.5em;align-items:center;gap:8px;min-width:0}
.barbox{min-width:0}
.fill{height:16px;border-radius:0 4px 4px 0}
.barvalue{font-size:13px;color:var(--text-primary);white-space:nowrap}
details{margin-top:10px;font-size:13px;color:var(--text-secondary)}
summary{cursor:pointer}
table{border-collapse:collapse;width:100%;margin-top:8px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:4px 6px;border-bottom:1px solid var(--grid)}
.empty{color:var(--muted);font-size:14px;margin:4px 0}
#tip{position:fixed;pointer-events:none;background:var(--surface-1);color:var(--text-primary);border:1px solid var(--ring);border-radius:10px;padding:8px 10px;font-size:13px;box-shadow:0 2px 10px rgba(0,0,0,.12);display:none;max-width:240px;z-index:10}
#tip .t{color:var(--text-secondary);margin-bottom:4px}
#tip .r{display:flex;align-items:center;gap:8px}
#tip .r i{display:inline-block;width:12px;height:2px;border-radius:1px}
#tip .r b{font-weight:600}
footer{color:var(--muted);font-size:12px;text-align:center;padding:4px 0 16px}
</style>
</head>
<body class="viz-root">
<main>
<h1>Мій прогрес</h1>
${content}
<footer>StudyBot · дані оновлюються щоразу, коли відкриваєш сторінку</footer>
</main>
<div id="tip" role="status"></div>
<script>
(function(){
  var tip=document.getElementById('tip');
  function show(el,x,y){
    var d; try{d=JSON.parse(el.getAttribute('data-tip'))}catch(e){return}
    tip.textContent='';
    var t=document.createElement('div');t.className='t';t.textContent=d.title;tip.appendChild(t);
    (d.rows||[]).forEach(function(r){
      var row=document.createElement('div');row.className='r';
      if(r.name){var k=document.createElement('i');k.className='c'+r.slot;row.appendChild(k)}
      var b=document.createElement('b');b.textContent=r.value;row.appendChild(b);
      if(r.name){var n=document.createElement('span');n.textContent=r.name;row.appendChild(n)}
      tip.appendChild(row);
    });
    if(d.total){var tt=document.createElement('div');tt.className='r';var bb=document.createElement('b');bb.textContent='Разом: '+d.total;tt.appendChild(bb);tip.appendChild(tt)}
    if(!(d.rows||[]).length&&!d.total){var e=document.createElement('div');e.textContent='немає';tip.appendChild(e)}
    tip.style.display='block';
    var w=tip.offsetWidth,h=tip.offsetHeight;
    tip.style.left=Math.max(8,Math.min(window.innerWidth-w-8,x-w/2))+'px';
    tip.style.top=Math.max(8,y-h-12)+'px';
  }
  function hide(){tip.style.display='none'}
  document.addEventListener('pointerdown',function(e){if(!e.target.closest('[data-tip]'))hide()});
  document.querySelectorAll('[data-tip]').forEach(function(el){
    el.addEventListener('pointermove',function(e){if(e.pointerType==='mouse')show(el,e.clientX,e.clientY)});
    el.addEventListener('pointerdown',function(e){show(el,e.clientX,e.clientY)});
    el.addEventListener('pointerleave',function(e){if(e.pointerType==='mouse')hide()});
    el.addEventListener('focus',function(){var r=el.getBoundingClientRect();show(el,r.left+r.width/2,r.top)});
    el.addEventListener('blur',hide);
  });
})();
</script>
</body>
</html>`;
}

/** Сторінка-заглушка для простроченого чи підробленого посилання. */
export function expiredPage(): string {
  return page('<section class="card"><h2>Посилання застаріло</h2><p class="sub">Відкрий графіки ще раз із розділу 📊 Прогрес у боті.</p></section>');
}

