/**
 * Навчальні функції з ШІ: конспект, тест-вікторина з підрахунком балів і
 * репетитор, що відповідає на вільні питання з урахуванням кількох попередніх реплік.
 */

import { complete, completeJson, providersFromEnv, type AiMessage } from '../../ai/client';
import { buildQuiz, buildSummary, buildTutor, parseQuiz, type Material, type QuizQuestion } from '../../ai/prompts';
import { escapeHtml, truncate } from '../../format';
import type { TgMessage, TgPollAnswer } from '../../telegram';
import { plural } from '../../time';
import { reply, setState, stateData, withAi, type Ctx } from '../context';
import { btn, CANCEL_ROW, kb } from '../ui';
import type { Db } from '../../db';
import type { Telegram } from '../../telegram';

/** Найбільше символів матеріалу, що йде в ШІ: безкоштовні ліміти токенів невеликі. */
const MATERIAL_LIMIT = 8000;
/** Скільки останніх реплік розмови пам'ятає репетитор і як довго. */
const HISTORY_MESSAGES = 6;
const HISTORY_TTL = 2 * 3600;

/** Чи є серед підключених ШІ-провайдерів такий, що приймає зображення. */
function hasVision(ctx: Ctx): boolean {
  return providersFromEnv(ctx.env).some((p) => p.vision);
}

/**
 * Base64 для фото. Вбудований Uint8Array.prototype.toBase64 у workerd працює
 * в рази швидше за JS-цикл, що важливо при ліміті 10 мс CPU безкоштовного тарифу.
 */
function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === 'function') return native.call(bytes);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}

/**
 * Дістає навчальний матеріал із повідомлення: текст, підпис, текстовий файл
 * чи фото (для фото потрібен ШІ з підтримкою зображень). Повертає null, якщо
 * матеріалу немає; про причину людині вже написано.
 */
export async function materialFrom(ctx: Ctx, msg: TgMessage): Promise<Material | null> {
  let text = (msg.text ?? msg.caption ?? '').trim();
  let imageUrl: string | undefined;

  if (msg.photo?.length) {
    if (!hasVision(ctx)) {
      await reply(ctx, '📷 Фото поки не розпізнаю: у бота не підключено ШІ з підтримкою зображень. Надішли, будь ласка, текст.');
      return null;
    }
    const sizes = [...msg.photo].sort((a, b) => b.width - a.width);
    const pick = sizes.find((p) => (p.file_size ?? 0) <= 400_000 && p.width <= 1280) ?? sizes[sizes.length - 1];
    const { bytes } = await ctx.tg.downloadFile(pick.file_id);
    imageUrl = `data:image/jpeg;base64,${toBase64(bytes)}`;
  } else if (msg.document) {
    const doc = msg.document;
    const isText = (doc.mime_type ?? '').startsWith('text/') || /\.(txt|md)$/i.test(doc.file_name ?? '');
    if (!isText) {
      await reply(ctx, '📄 Поки розумію лише текстові файли (.txt). Скопіюй текст у повідомлення або надішли фото сторінки.');
      return null;
    }
    if ((doc.file_size ?? 0) > 300_000) {
      await reply(ctx, '📄 Файл завеликий. Надішли уривок до 8000 символів.');
      return null;
    }
    const { bytes } = await ctx.tg.downloadFile(doc.file_id);
    text = `${text}\n${new TextDecoder().decode(bytes)}`.trim();
  }

  if (!text && !imageUrl) return null;
  if (text.length > MATERIAL_LIMIT) {
    text = text.slice(0, MATERIAL_LIMIT);
    await reply(ctx, `✂️ Текст довгий, тож беру перші ${MATERIAL_LIMIT} символів.`);
  }
  return { text, imageUrl };
}

/** Починає конспект: ставить крок "summary" і просить текст, тему чи файл. */
export async function startSummary(ctx: Ctx): Promise<void> {
  await setState(ctx, 'summary');
  const photo = hasVision(ctx) ? ', фото сторінки' : '';
  await reply(ctx, `📝 Надішли текст, тему${photo} або текстовий файл, і я зроблю короткий конспект.\n\n<i>Наприклад: Причини Першої світової війни</i>`, {
    reply_markup: kb(CANCEL_ROW),
  });
}

/** Репліка розмови з позначкою, чи це конспект (з нього можна зробити тест). */
interface HistoryItem extends AiMessage {
  summary?: boolean;
}

/** Історія розмови з репетитором; порожня, якщо її немає, вона старша за `HISTORY_TTL` чи зіпсована. */
function loadHistory(ctx: Ctx): HistoryItem[] {
  if (!ctx.user.history || !ctx.user.history_at || ctx.now - ctx.user.history_at > HISTORY_TTL) return [];
  try {
    const h = JSON.parse(ctx.user.history);
    return Array.isArray(h) ? (h as HistoryItem[]) : [];
  } catch {
    return [];
  }
}

/** Історія для моделі: без службових позначок. */
function forModel(history: HistoryItem[]): AiMessage[] {
  return history.map((m) => ({ role: m.role, content: m.content }));
}

/** Зберігає останні `HISTORY_MESSAGES` реплік (кожну до 2000 символів) у користувача (запис у D1). */
async function saveHistory(ctx: Ctx, history: HistoryItem[]): Promise<void> {
  const trimmed = history.slice(-HISTORY_MESSAGES).map((m) => ({
    role: m.role,
    content: truncate(typeof m.content === 'string' ? m.content : '', 2000),
    ...(m.summary ? { summary: true } : {}),
  }));
  ctx.user.history = JSON.stringify(trimmed);
  ctx.user.history_at = ctx.now;
  await ctx.db.updateUser(ctx.user.id, { history: ctx.user.history, history_at: ctx.now });
}

/**
 * Складає конспект через ШІ (з денним лімітом), скидає крок діалогу, надсилає результат і запам'ятовує його в історії,
 * щоб із нього можна було зробити тест.
 */
export async function makeSummary(ctx: Ctx, material: Material): Promise<void> {
  const result = await withAi(ctx, () => complete(ctx.env, { messages: buildSummary(material), maxTokens: 1800, temperature: 0.3 }));
  if (!result) return;
  await setState(ctx, null);
  await ctx.tg.sendMarkdown(ctx.chatId, result.text, {
    reply_markup: kb([btn('❓ Тест за конспектом', 'st:quiz'), btn('📝 Ще конспект', 'st:sum')]),
  });
  const topic = material.text ? truncate(material.text, 300) : 'матеріал із фото';
  await saveHistory(ctx, [
    { role: 'user', content: `Зроби конспект: ${topic}` },
    { role: 'assistant', content: result.text, summary: true },
  ]);
}

/** Починає тест: ставить крок "quiz" і просить тему чи текст. */
export async function startQuiz(ctx: Ctx): Promise<void> {
  await setState(ctx, 'quiz');
  const photo = hasVision(ctx) ? ', фото сторінки' : '';
  await reply(
    ctx,
    `❓ Про що тест? Напиши тему, встав текст${photo}. Можна вказати кількість питань (3-10), за замовчуванням 5.\n\n<i>Наприклад: 7 питань з теми Київська Русь</i>`,
    { reply_markup: kb(CANCEL_ROW) },
  );
}

/** Кількість питань із тексту на кшталт "7 питань ..."; від 3 до 10, типово 5. */
export function questionCount(text: string): number {
  const m = /(\d{1,2})\s*(?:питан|запитан|question)/i.exec(text);
  const n = m ? Number(m[1]) : 5;
  return Math.min(10, Math.max(3, n));
}

/** Перемішує копію масиву (Фішера-Єйтса); вихідний не змінюється. */
function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Перемішує варіанти, щоб правильна відповідь не стояла завжди першою. */
export function shuffleQuestion(q: QuizQuestion): QuizQuestion {
  const order = shuffle(q.options.map((_, i) => i));
  return { ...q, options: order.map((i) => q.options[i]), correct: order.indexOf(q.correct) };
}

/** Складає через ШІ тест із `count` питань, зберігає його в D1, скидає крок діалогу і надсилає перше питання. */
export async function makeQuiz(ctx: Ctx, material: Material, count: number): Promise<void> {
  const result = await withAi(ctx, () =>
    completeJson(ctx.env, { messages: buildQuiz(material, count), maxTokens: 2500, temperature: 0.5 }, parseQuiz),
  );
  if (!result) return;
  await setState(ctx, null);
  const questions = result.data.questions.map(shuffleQuestion);
  const quizId = await ctx.db.createQuiz(ctx.user.id, truncate(material.text || result.data.title, 2000), questions, ctx.now);
  const n = questions.length;
  await reply(ctx, `🧠 <b>Тест: ${escapeHtml(result.data.title)}</b>\n${n} ${plural(n, ['питання', 'питання', 'питань'])}. Відповідай, і я надішлю наступне.`);
  await sendQuestion(ctx.tg, ctx.db, ctx.chatId, quizId, questions, 0);
}

/** Надсилає питання `index` як опитування-вікторину й записує в тест поточний номер та id опитування. */
async function sendQuestion(tg: Telegram, db: Db, chatId: number, quizId: number, questions: QuizQuestion[], index: number): Promise<void> {
  const q = questions[index];
  const msg = await tg.sendQuiz(chatId, `${index + 1}/${questions.length}. ${q.q}`.slice(0, 300), q.options, [q.correct], q.explain || undefined);
  await db.updateQuiz(quizId, { current: index, poll_id: msg.poll?.id ?? null });
}

/** Тест за останнім конспектом із пам'яті репетитора (відповіді на питання не враховуються). */
export async function quizFromLastSummary(ctx: Ctx): Promise<void> {
  const last = [...loadHistory(ctx)].reverse().find((m) => m.role === 'assistant' && m.summary);
  if (!last || typeof last.content !== 'string') {
    await startQuiz(ctx);
    return;
  }
  await makeQuiz(ctx, { text: last.content }, 5);
}

/** Відповідь на питання тесту: рахує бал і надсилає наступне питання або результат. */
export async function onPollAnswer(tg: Telegram, db: Db, answer: TgPollAnswer): Promise<void> {
  const quiz = await db.getQuizByPoll(answer.poll_id);
  if (!quiz || !answer.user || answer.user.id !== quiz.user_id) return;
  let questions: QuizQuestion[];
  try {
    questions = JSON.parse(quiz.questions) as QuizQuestion[];
  } catch {
    return;
  }
  const q = questions[quiz.current];
  if (!q) return;
  const score = quiz.score + (answer.option_ids.length === 1 && answer.option_ids[0] === q.correct ? 1 : 0);
  const next = quiz.current + 1;
  await db.updateQuiz(quiz.id, { score, current: next, poll_id: null });
  const chatId = quiz.user_id;
  if (next < questions.length) {
    await sendQuestion(tg, db, chatId, quiz.id, questions, next);
    return;
  }
  const pct = Math.round((score / questions.length) * 100);
  const verdict = pct >= 90 ? 'Блискуче! 🏆' : pct >= 70 ? 'Добре! 💪' : pct >= 50 ? 'Непогано, але варто повторити. 📚' : 'Тему варто повторити, ти впораєшся! 🙌';
  await tg.sendHtml(chatId, `🏁 Результат: <b>${score} з ${questions.length}</b> (${pct}%). ${verdict}`, {
    reply_markup: kb([btn('🔁 Ще тест на цю тему', `qz:again:${quiz.id}`), btn('📝 Конспект теми', `qz:sum:${quiz.id}`)]),
  });
}

/** Новий тест або конспект за темою вже пройденого тесту. */
export async function fromPastQuiz(ctx: Ctx, quizId: number, mode: 'quiz' | 'summary'): Promise<void> {
  const row = await ctx.db.d1.prepare('SELECT topic FROM quizzes WHERE id = ? AND user_id = ?').bind(quizId, ctx.user.id).first<{ topic: string | null }>();
  if (!row?.topic) {
    if (mode === 'quiz') await startQuiz(ctx);
    else await startSummary(ctx);
    return;
  }
  if (mode === 'quiz') await makeQuiz(ctx, { text: row.topic }, 5);
  else await makeSummary(ctx, { text: row.topic });
}

/** Вільне питання до репетитора. */
export async function tutor(ctx: Ctx, question: string): Promise<void> {
  const history = loadHistory(ctx);
  const q = truncate(question, 3000);
  const result = await withAi(ctx, () => complete(ctx.env, { messages: buildTutor(forModel(history), q), maxTokens: 1500, temperature: 0.5 }));
  if (!result) return;
  await ctx.tg.sendMarkdown(ctx.chatId, result.text);
  await saveHistory(ctx, [...history, { role: 'user', content: q }, { role: 'assistant', content: result.text }]);
}

/** Що зробити з фото чи файлом, надісланим без команди: конспект чи тест. */
export async function askWhatToDoWithFile(ctx: Ctx, msg: TgMessage): Promise<void> {
  const fileId = msg.photo?.length ? [...msg.photo].sort((a, b) => b.width - a.width)[0].file_id : msg.document?.file_id;
  if (!fileId) return;
  if (ctx.user.state && ctx.user.state !== 'file_choice') {
    await reply(ctx, 'Спершу заверши поточну дію або натисни /cancel, а потім надішли файл ще раз.');
    return;
  }
  await setState(ctx, 'file_choice', { message: msg });
  await reply(ctx, 'Що зробити з цим матеріалом?', {
    reply_markup: kb([btn('📝 Конспект', 'st:fsum'), btn('❓ Тест', 'st:fquiz')], CANCEL_ROW),
  });
}

/** Повертає повідомлення з файлом, збережене на кроці вибору дії. */
export function pendingFileMessage(ctx: Ctx): TgMessage | null {
  return ctx.user.state === 'file_choice' ? (stateData<{ message: TgMessage }>(ctx)?.message ?? null) : null;
}
