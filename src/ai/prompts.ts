/**
 * Тексти запитів до ШІ та перевірка JSON-відповідей.
 *
 * Кожна функція build* повертає готові повідомлення для моделі, а parse*
 * перевіряє відповідь, обрізає задовгі рядки до лімітів Telegram і повертає
 * null, якщо модель відповіла не в тому форматі.
 */

import { parseClock, parseYmd, ymdToString, type Ymd } from '../time';
import { truncate } from '../format';
import type { AiMessage, AiTextPart, AiImagePart } from './client';

/**
 * Факти про НМТ, які отримує модель, коли радить, що вчити. Джерела:
 * https://testportal.gov.ua/osnovne-pro-nmt-2026/ і
 * https://testportal.gov.ua/kalendar-provedennya-nmt-2026/. Коли УЦОЯО
 * оголосить формат і календар наступного року, текст треба оновити.
 */
export const NMT_FACTS =
  'НМТ-2026: 3 обов\'язкові предмети (українська мова, математика, історія України) і 1 на вибір ' +
  '(українська література, англійська, німецька, французька чи іспанська мова, біологія, хімія, фізика, географія). ' +
  'Усі 4 тести в один день, два блоки по 120 хвилин, лише завдання закритої форми, результат за шкалою 100-200. ' +
  'Основна сесія 2026 тривала з 20 травня по 25 червня, реєстрація з 5 березня по 2 квітня. ' +
  'Формат і дати НМТ-2027 офіційно ще не оголошені, тож орієнтуйся на схожий графік і не стверджуй нічого напевно.';

/** Предмети НМТ для вибору кнопками. `mandatory`: обов'язковий за форматом 2026 року. */
export const NMT_SUBJECTS: Array<{ code: string; name: string; mandatory: boolean }> = [
  { code: 'ukr', name: 'Українська мова', mandatory: true },
  { code: 'math', name: 'Математика', mandatory: true },
  { code: 'hist', name: 'Історія України', mandatory: true },
  { code: 'lit', name: 'Українська література', mandatory: false },
  { code: 'eng', name: 'Англійська мова', mandatory: false },
  { code: 'ger', name: 'Німецька мова', mandatory: false },
  { code: 'fra', name: 'Французька мова', mandatory: false },
  { code: 'spa', name: 'Іспанська мова', mandatory: false },
  { code: 'bio', name: 'Біологія', mandatory: false },
  { code: 'chem', name: 'Хімія', mandatory: false },
  { code: 'phys', name: 'Фізика', mandatory: false },
  { code: 'geo', name: 'Географія', mandatory: false },
];

const PERSONA =
  'Ти StudyBot, помічник у навчанні для українських школярів і студентів. ' +
  'Відповідай українською мовою, дружньо, просто і по суті. ' +
  'Формули пиши звичайним текстом із символами Unicode (x², √, ≤, π), без LaTeX. ' +
  'Не вигадуй фактів: якщо не впевнений, так і скажи.';

const JSON_ONLY = 'Відповідай лише JSON-об\'єктом без пояснень і без обгортки ```.';

/** Опис поточного моменту для моделі: без нього вона не знає, яке сьогодні число. */
export function nowContext(today: Ymd, weekdayName: string, clock: string, tz: string): string {
  return `Сьогодні ${weekdayName}, ${ymdToString(today)}, зараз ${clock} (часовий пояс ${tz}).`;
}

/** Навчальний матеріал від користувача: текст і, можливо, фото сторінки. */
export interface Material {
  text: string;
  /** data:-URL зображення для моделей із підтримкою фото. */
  imageUrl?: string;
}

function materialContent(intro: string, m: Material): string | Array<AiTextPart | AiImagePart> {
  const text = m.text.trim() ? `${intro}\n\n${m.text}` : intro;
  if (!m.imageUrl) return text;
  return [
    { type: 'text', text: `${text}\n\nМатеріал на фото нижче.` },
    { type: 'image_url', image_url: { url: m.imageUrl } },
  ];
}

/** Повідомлення для репетитора: системна роль, попередня розмова `history` і нове питання. Відповідь у Markdown. */
export function buildTutor(history: AiMessage[], question: string): AiMessage[] {
  return [
    {
      role: 'system',
      content:
        `${PERSONA} Ти репетитор: пояснюй кроками, з прикладом, коротко (до 1500 символів). ` +
        'Якщо просять просто розв\'язати домашнє завдання, поясни хід розв\'язання, щоб людина зрозуміла сама. ' +
        'Можна використовувати **жирний** і списки.',
    },
    ...history,
    { role: 'user', content: question },
  ];
}

/** Запит на короткий конспект матеріалу (до 2500 символів, відповідь у Markdown). */
export function buildSummary(m: Material): AiMessage[] {
  return [
    {
      role: 'system',
      content:
        `${PERSONA} Склади короткий конспект. Структура: назва теми жирним; 5-10 головних тез списком; ` +
        'ключові терміни з короткими визначеннями; формули чи дати, якщо вони є; наприкінці 3 питання для самоперевірки. ' +
        'Обсяг до 2500 символів. Якщо користувач дав лише назву теми, склади конспект за шкільною чи університетською ' +
        'програмою і в кінці порадь звірити його з підручником.',
    },
    { role: 'user', content: materialContent('Матеріал для конспекту:', m) },
  ];
}

/** Питання тесту; `correct`: індекс правильного варіанта з нуля, `explain`: пояснення після відповіді. */
export interface QuizQuestion {
  q: string;
  options: string[];
  correct: number;
  explain: string;
}

/** Запит на тест із `count` питань; відповідь у JSON, її перевіряє parseQuiz. */
export function buildQuiz(m: Material, count: number): AiMessage[] {
  return [
    {
      role: 'system',
      content:
        `${PERSONA} Склади тест на перевірку розуміння матеріалу. ${JSON_ONLY} Формат: ` +
        `{"title": "тема до 60 символів", "questions": [{"q": "питання до 250 символів", ` +
        `"options": ["варіант до 90 символів", "...", "...", "..."], "correct": 0, "explain": "чому відповідь правильна, до 180 символів"}]}. ` +
        `Рівно ${count} питань, у кожному 4 варіанти і лише один правильний; "correct" це його номер з нуля. ` +
        'Неправильні варіанти мають бути правдоподібними. Варіанти не нумеруй і не позначай літерами.',
    },
    { role: 'user', content: materialContent('Матеріал для тесту:', m) },
  ];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** Лишає не більше `maxBreaks` переносів рядка: решта рядків склеюється пробілом. */
function limitLines(s: string, maxBreaks: number): string {
  const parts = s.split('\n');
  return parts.length <= maxBreaks + 1 ? s : parts.slice(0, maxBreaks).join('\n') + '\n' + parts.slice(maxBreaks).join(' ');
}

/** Перевіряє тест: 1-10 питань, 2-6 різних варіантів, коректний номер правильної відповіді. */
export function parseQuiz(v: unknown): { title: string; questions: QuizQuestion[] } | null {
  if (!isObj(v) || !Array.isArray(v.questions)) return null;
  const questions: QuizQuestion[] = [];
  for (const raw of v.questions.slice(0, 10)) {
    if (!isObj(raw) || !Array.isArray(raw.options)) continue;
    const q = truncate(str(raw.q ?? raw.question), 300);
    const options = raw.options.map((o) => truncate(str(o).replace(/^[A-DА-Г1-4][).]\s+/, ''), 100));
    const rc = raw.correct;
    const correct = typeof rc === 'number' ? rc : typeof rc === 'string' && rc.trim() !== '' ? Number(rc) : NaN;
    const unique = new Set(options.map((o) => o.toLowerCase()));
    if (!q || options.length < 2 || options.length > 6 || options.some((o) => !o) || unique.size !== options.length) continue;
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) continue;
    questions.push({ q, options, correct, explain: limitLines(truncate(str(raw.explain ?? raw.explanation), 200), 2) });
  }
  if (!questions.length) return null;
  return { title: truncate(str(v.title) || 'Тест', 60), questions };
}

/** Розбиття завдання на кроки; `minutes` null, якщо модель не оцінила час; `tip`: порада. */
export interface SplitResult {
  title: string;
  steps: Array<{ text: string; minutes: number | null }>;
  tip: string;
}

/** Запит на розбиття завдання на кроки; відповідь у JSON, її перевіряє parseSplit. `now`: опис моменту з nowContext, `deadlineNote`: підпис дедлайну чи null. */
export function buildSplit(task: string, now: string, deadlineNote: string | null): AiMessage[] {
  return [
    {
      role: 'system',
      content:
        `${PERSONA} Розбий велике навчальне завдання на 3-10 конкретних кроків, кожен на 15-90 хвилин роботи, ` +
        `у логічному порядку. Кожен крок починай з дієслова ("Знайти", "Написати"...). ${JSON_ONLY} Формат: ` +
        '{"title": "коротка назва завдання до 60 символів", "steps": [{"text": "крок до 120 символів", "minutes": 30}], ' +
        '"tip": "одна практична порада до 200 символів"}.',
    },
    { role: 'user', content: `${now}${deadlineNote ? `\nДедлайн: ${deadlineNote}.` : ''}\nЗавдання: ${task}` },
  ];
}

/** Перевіряє розбиття: потрібно щонайменше 2 непорожні кроки (береться до 12). null, якщо відповідь не в тому форматі. */
export function parseSplit(v: unknown): SplitResult | null {
  if (!isObj(v) || !Array.isArray(v.steps)) return null;
  const steps = v.steps
    .slice(0, 12)
    .map((s) => {
      const text = truncate(isObj(s) ? str(s.text ?? s.step) : str(s), 120);
      const minutes = isObj(s) ? Number(s.minutes) : NaN;
      return { text, minutes: Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : null };
    })
    .filter((s) => s.text);
  if (steps.length < 2) return null;
  return { title: truncate(str(v.title) || 'Завдання', 60), steps, tip: truncate(str(v.tip), 200) };
}

/** Заняття в тижневому розкладі. Час: хвилини від півночі. */
export interface WeeklyItem {
  day: number;
  start: number;
  end: number | null;
  title: string;
}

const WEEKLY_FORMAT =
  '"weekly": [{"day": 1, "start": "16:00", "end": "17:00", "title": "назва до 60 символів"}], де day: 1 понеділок ... 7 неділя';

/** Запит на тижневий розклад за описом людини; відповідь у JSON, її перевіряє parseWeekly. `feedback`: побажання до попереднього варіанта чи null. */
export function buildSchedule(description: string, now: string, feedback: string | null): AiMessage[] {
  return [
    {
      role: 'system',
      content:
        `${PERSONA} Склади зручний тижневий розклад навчання й самопідготовки за описом людини. ` +
        'Враховуй уроки чи пари, гуртки, відпочинок і сон; не став заняття раніше 7:00 і пізніше 22:00; ' +
        `чергуй складні й легкі предмети; не більше 25 занять на тиждень. ${JSON_ONLY} Формат: ` +
        `{${WEEKLY_FORMAT}, "comment": "коротке пояснення логіки розкладу до 300 символів"}.`,
    },
    {
      role: 'user',
      content: `${now}\nОпис: ${description}${feedback ? `\nПобажання до попереднього варіанта: ${feedback}` : ''}`,
    },
  ];
}

/** Перетворює розклад, описаний своїми словами, на список занять (без вигадування нових). */
export function buildLessonExtract(text: string): AiMessage[] {
  return [
    {
      role: 'system',
      content:
        `Витягни з повідомлення заняття тижневого розкладу. Нічого не додавай від себе. ${JSON_ONLY} ` +
        `Формат: {${WEEKLY_FORMAT}}. Якщо кінець заняття не вказано, став "end": null. ` +
        'Якщо занять немає, поверни {"weekly": []}.',
    },
    { role: 'user', content: text },
  ];
}

function parseWeeklyItem(raw: unknown): WeeklyItem | null {
  if (!isObj(raw)) return null;
  const day = Number(raw.day);
  const start = parseClock(str(raw.start));
  const endRaw = raw.end === null || raw.end === undefined || raw.end === '' ? null : parseClock(str(raw.end));
  const title = truncate(str(raw.title), 80);
  if (!Number.isInteger(day) || day < 1 || day > 7 || start === null || !title) return null;
  const end = endRaw !== null && endRaw > start ? endRaw : null;
  return { day, start, end, title };
}

/** Перевіряє масив занять; порожній масив допустимий лише коли `allowEmpty`. */
export function parseWeekly(v: unknown, allowEmpty = false): { items: WeeklyItem[]; comment: string } | null {
  if (!isObj(v)) return null;
  const rawItems = Array.isArray(v.weekly) ? v.weekly : Array.isArray(v.items) ? v.items : null;
  if (!rawItems) return null;
  const items = rawItems.slice(0, 30).map(parseWeeklyItem).filter((x): x is WeeklyItem => x !== null);
  if (!items.length && !allowEmpty) return null;
  items.sort((a, b) => a.day - b.day || a.start - b.start);
  return { items, comment: truncate(str(v.comment), 300) };
}

/**
 * Поради ШІ до вже розрахованого плану: які теми вчити по кожному предмету і
 * як розподілити зусилля. Години рахує src/planner.ts, модель їх не змінює.
 */
export function buildPlanAdvice(
  nmt: boolean,
  subjects: Array<{ name: string; difficulty?: number; level?: number; exam?: string | null; minutes: number }>,
  todayYmd: string,
): AiMessage[] {
  const lines = subjects.map((s) => {
    const parts = [`${s.name}: ${Math.round((s.minutes / 60) * 10) / 10} год`];
    if (s.difficulty) parts.push(`складність ${s.difficulty}/5`);
    if (s.level) parts.push(`рівень ${s.level}/5`);
    if (s.exam) parts.push(`іспит ${s.exam}`);
    return `- ${parts.join(', ')}`;
  });
  return [
    {
      role: 'system',
      content:
        `${PERSONA} Людина вже має розклад занять і кількість годин на кожен предмет. ` +
        'Для кожного предмета дай 4-7 конкретних тем чи навичок у порядку вивчення, з урахуванням рівня, ' +
        'і 1-2 поради, як найкраще використати ці години (пробні тести, повторення, типові помилки). ' +
        'Наприкінці загальна порада щодо режиму. Не змінюй кількість годин. Обсяг до 2500 символів, заголовки предметів жирним.' +
        (nmt ? ` ${NMT_FACTS}` : ''),
    },
    { role: 'user', content: `Сьогодні ${todayYmd}.\n${lines.join('\n')}` },
  ];
}

/** Запит на витяг дедлайну з довільного повідомлення; відповідь у JSON, її перевіряє parseDeadlineExtract. */
export function buildDeadlineExtract(text: string, now: string): AiMessage[] {
  return [
    {
      role: 'system',
      content:
        `Витягни з повідомлення дедлайн: що треба зробити і коли. ${JSON_ONLY} Формат: ` +
        '{"title": "що зробити, до 100 символів", "date": "YYYY-MM-DD", "time": "HH:MM"}. ' +
        'Якщо час не вказано, став "time": null. Якщо дати немає зовсім, став "date": null. ' +
        'Відносні дати ("в п\'ятницю", "через тиждень") рахуй від сьогоднішньої.',
    },
    { role: 'user', content: `${now}\nПовідомлення: ${text}` },
  ];
}

/**
 * Перевіряє відповідь на buildDeadlineExtract. `date: null` означає, що модель
 * чесно не знайшла дати (це не збій). null повертається лише для зіпсованої відповіді.
 */
export function parseDeadlineExtract(v: unknown): { title: string; date: Ymd | null; time: number | null } | null {
  if (!isObj(v)) return null;
  const title = truncate(str(v.title), 100) || 'Дедлайн';
  if (v.date === null || v.date === undefined || v.date === '') return { title, date: null, time: null };
  const date = parseYmd(str(v.date));
  if (!date) return null;
  const time = v.time === null || v.time === undefined || v.time === '' ? null : parseClock(str(v.time));
  return { title, date, time };
}
