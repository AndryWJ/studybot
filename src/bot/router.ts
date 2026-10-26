/**
 * Маршрутизація оновлень Telegram: команди, кнопки меню, натискання inline-кнопок,
 * відповіді на кроках діалогу, відповіді в тестах і вільні питання до репетитора.
 */

import { providersFromEnv } from '../ai/client';
import { Db, type User } from '../db';
import { defaultTz, isAdmin, isAllowed, type AppEnv } from '../env';
import { escapeHtml, truncate } from '../format';
import { nextDigestAt } from '../reminders';
import { Telegram, TelegramError, type TgCallbackQuery, type TgMessage, type TgUpdate } from '../telegram';
import { name, reply, setState, type Ctx } from './context';
import { BTN, btn, HELP_TEXT, kb, mainMenu } from './ui';
import * as deadlines from './features/deadlines';
import * as grades from './features/grades';
import * as plan from './features/plan';
import * as progress from './features/progress';
import * as schedule from './features/schedule';
import * as settings from './features/settings';
import * as study from './features/study';
import * as tasks from './features/tasks';

/** Дії кнопок головного меню за їхнім підписом; перед виконанням крок діалогу скидається. */
const MENU: Record<string, (ctx: Ctx) => Promise<void>> = {
  [BTN.schedule]: (ctx) => schedule.showSchedule(ctx),
  [BTN.deadlines]: (ctx) => deadlines.showDeadlines(ctx),
  [BTN.plan]: plan.startPlan,
  [BTN.split]: tasks.startSplit,
  [BTN.summary]: study.startSummary,
  [BTN.quiz]: study.startQuiz,
  [BTN.progress]: progress.showProgress,
  [BTN.grades]: grades.showGrades,
  [BTN.settings]: (ctx) => settings.showSettings(ctx),
  [BTN.help]: (ctx) => reply(ctx, HELP_TEXT, { reply_markup: mainMenu() }).then(() => undefined),
};

/** Повертає користувача з бази, створюючи його при першому зверненні. Пише в базу лише за потреби. */
async function loadUser(db: Db, env: AppEnv, id: number, firstName: string, now: number): Promise<User> {
  const existing = await db.getUser(id);
  if (!existing) {
    const tz = defaultTz(env);
    return db.upsertUser(id, firstName, now, tz, nextDigestAt(450, tz, now));
  }
  if (existing.blocked || existing.first_name !== firstName) {
    await db.updateUser(id, { first_name: firstName, blocked: 0 });
    existing.first_name = firstName;
    existing.blocked = 0;
  }
  return existing;
}

/**
 * Обробляє одне оновлення від Telegram. Помилки не прокидає назовні: логує і,
 * якщо можна, повідомляє користувача.
 * @param origin адреса Worker-а для посилань на сторінку графіків
 */
export async function handleUpdate(env: AppEnv, update: TgUpdate, origin: string | null, now = Math.floor(Date.now() / 1000)): Promise<void> {
  const tg = new Telegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_API_BASE);
  const db = new Db(env.DB);

  if (update.my_chat_member) {
    const m = update.my_chat_member;
    if (m.chat.type === 'private') await db.setBlocked(m.from.id, m.new_chat_member.status === 'kicked');
    return;
  }
  if (update.poll_answer) {
    await study.onPollAnswer(tg, db, update.poll_answer).catch((e) => console.error('poll_answer failed', e));
    return;
  }

  const from = update.message?.from ?? update.callback_query?.from;
  const chat = update.message?.chat ?? update.callback_query?.message?.chat;
  if (!from || from.is_bot) return;
  if (chat && chat.type !== 'private') {
    if (update.message?.text?.startsWith('/start')) await tg.sendText(chat.id, 'Я працюю лише в особистих повідомленнях. Напиши мені напряму.').catch(() => undefined);
    return;
  }
  if (!isAllowed(env, from.id)) {
    if (update.callback_query) await tg.answerCallback(update.callback_query.id);
    await tg.sendText(from.id, 'Це приватний бот. Попроси власника додати твій Telegram id: ' + from.id).catch(() => undefined);
    return;
  }

  const user = await loadUser(db, env, from.id, from.first_name, now);
  const ctx: Ctx = { env, db, tg, now, user, chatId: from.id, origin };
  try {
    if (update.callback_query) await onCallback(ctx, update.callback_query);
    else if (update.message) await onMessage(ctx, update.message);
  } catch (e) {
    if (e instanceof TelegramError && e.isBlocked) {
      await db.setBlocked(from.id, true);
      return;
    }
    console.error('update failed', e instanceof Error ? e.stack ?? e.message : e);
    await tg.sendText(from.id, '😕 Щось пішло не так. Спробуй ще раз або натисни /cancel.').catch(() => undefined);
  }
}

/** Вітання на /start: показує меню й пропонує три стартові дії. */
async function welcome(ctx: Ctx): Promise<void> {
  await reply(
    ctx,
    `👋 Привіт, ${name(ctx)}! Я <b>StudyBot</b>, помічник у навчанні.\n\n` +
      'Допоможу скласти розклад, не проґавити дедлайни, розбити велике завдання на кроки, порахувати години на кожен предмет перед іспитами, ' +
      'зробити конспект чи тест, стежити за прогресом і оцінками. Меню внизу екрана.',
    { reply_markup: mainMenu() },
  );
  await reply(ctx, 'З чого почнемо?', {
    reply_markup: kb(
      [btn('➕ Додати дедлайн', 'dl:add'), btn('📅 Заповнити розклад', 'sch:add')],
      [btn('🎯 План до НМТ чи іспитів', 'pl:start')],
    ),
  });
}

/**
 * Виконує slash-команду з необов'язковим аргументом. Спершу скидає крок діалогу;
 * невідому команду (і /stats не від адміна) відхиляє відповіддю з довідкою.
 */
async function onCommand(ctx: Ctx, cmd: string, arg: string): Promise<void> {
  await setState(ctx, null);
  switch (cmd) {
    case 'start':
      return welcome(ctx);
    case 'menu':
    case 'help':
      await reply(ctx, HELP_TEXT, { reply_markup: mainMenu() });
      return;
    case 'cancel':
      await reply(ctx, 'Скасовано. Обери дію в меню.', { reply_markup: mainMenu() });
      return;
    case 'today':
      return schedule.showToday(ctx);
    case 'schedule':
      return schedule.showSchedule(ctx);
    case 'deadlines':
      return deadlines.showDeadlines(ctx);
    case 'add':
      if (arg) {
        await setState(ctx, 'deadline_add');
        await deadlines.onDeadlineText(ctx, arg);
        return;
      }
      return deadlines.startAddDeadline(ctx);
    case 'tasks':
      return tasks.listTasks(ctx);
    case 'split':
      return arg ? tasks.onSplitText(ctx, arg) : tasks.startSplit(ctx);
    case 'summary':
      return arg ? study.makeSummary(ctx, { text: truncate(arg, 8000) }) : study.startSummary(ctx);
    case 'quiz':
      return arg ? study.makeQuiz(ctx, { text: truncate(arg, 8000) }, study.questionCount(arg)) : study.startQuiz(ctx);
    case 'plan':
      return plan.startPlan(ctx);
    case 'progress':
      return progress.showProgress(ctx);
    case 'timer':
      if (ctx.user.timer_start) return progress.stopTimer(ctx);
      return arg ? progress.startTimer(ctx, arg) : progress.startTimerPick(ctx);
    case 'grades':
      return grades.showGrades(ctx);
    case 'settings':
      return settings.showSettings(ctx);
    case 'stats':
      if (isAdmin(ctx.env, ctx.user.id)) return adminStats(ctx);
      break;
  }
  await reply(ctx, 'Не знаю такої команди. Ось що я вмію:', { reply_markup: mainMenu() });
  await reply(ctx, HELP_TEXT);
}

/** Надсилає адміністратору лічильники користувачів, дедлайнів і запитів до ШІ та список підключених провайдерів. */
async function adminStats(ctx: Ctx): Promise<void> {
  const s = await ctx.db.stats(new Date(ctx.now * 1000).toISOString().slice(0, 10));
  const providers = providersFromEnv(ctx.env).map((p) => p.id);
  await reply(
    ctx,
    `📈 <b>Статистика</b>\nКористувачів: ${s.users} (активних ${s.active})\nВідкритих дедлайнів: ${s.deadlines}\nЗапитів до ШІ сьогодні: ${s.aiToday}\n` +
      `ШІ: ${providers.length ? escapeHtml(providers.join(', ')) : 'не налаштовано'}`,
  );
}

/**
 * Розподіляє повідомлення за пріоритетом: команда, кнопка меню, файл чи фото,
 * текст поточного кроку діалогу, швидкий дедлайн ("нагадай ...") і, нарешті, питання до репетитора.
 * Текст, який не підійшов кроку діалогу, цей крок скидає.
 */
async function onMessage(ctx: Ctx, msg: TgMessage): Promise<void> {
  const text = msg.text?.trim() ?? '';
  if (text.startsWith('/')) {
    const cmd = text.slice(1).split(/[\s@]/)[0].toLowerCase();
    const arg = text.replace(/^\/\S+\s*/, '').trim();
    await onCommand(ctx, cmd, arg);
    return;
  }
  const menuAction = MENU[text];
  if (menuAction) {
    await setState(ctx, null);
    await menuAction(ctx);
    return;
  }

  const state = ctx.user.state;
  if (msg.photo?.length || msg.document) {
    if (state === 'summary' || state === 'quiz') {
      const material = await study.materialFrom(ctx, msg);
      if (!material) return;
      if (state === 'summary') await study.makeSummary(ctx, material);
      else await study.makeQuiz(ctx, material, study.questionCount(material.text));
      return;
    }
    await study.askWhatToDoWithFile(ctx, msg);
    return;
  }
  if (!text) {
    await reply(ctx, 'Я розумію текст, фото й текстові файли. Обери дію в меню внизу.');
    return;
  }

  switch (state) {
    case 'lesson_add':
      return schedule.onLessonText(ctx, text);
    case 'sched_ai':
      return schedule.generateSchedule(ctx, truncate(text, 2000), null);
    case 'sched_preview':
      return schedule.redoPreview(ctx, truncate(text, 500));
    case 'deadline_add':
      await deadlines.onDeadlineText(ctx, text);
      return;
    case 'split':
      return tasks.onSplitText(ctx, text);
    case 'summary':
    case 'quiz': {
      const material = await study.materialFrom(ctx, msg);
      if (!material) return;
      if (state === 'summary') return study.makeSummary(ctx, material);
      return study.makeQuiz(ctx, material, study.questionCount(text));
    }
    case 'plan':
      if (await plan.onPlanText(ctx, text)) return;
      break;
    case 'set_tz':
    case 'set_digest':
    case 'set_avail':
      if (await settings.onSettingsText(ctx, text)) return;
      break;
    case 'grades_add':
      return grades.onGradesText(ctx, text);
    case 'timer_pick':
      return progress.startTimer(ctx, text);
    case 'log_time':
      return progress.onLogTimeText(ctx, text);
  }
  if (state) await setState(ctx, null);

  if (/^(нагадай|нагадайте|нагадування|дедлайн)(?![а-яіїєґ'])/i.test(text)) {
    // "Нагадай, що таке інтеграл" без дати це питання, а не дедлайн: тоді відповідає репетитор.
    const parsed = await deadlines.resolveDeadline(ctx, text, true);
    // ШІ не відповів: людина вже знає про це, тож репетитор (той самий ШІ) не викликається.
    if (parsed === 'ai-failed') return;
    if (parsed) {
      await setState(ctx, 'deadline_add');
      await deadlines.onDeadlineParsed(ctx, parsed);
      return;
    }
  }
  await study.tutor(ctx, text);
}

/**
 * Обробляє натискання inline-кнопки. `callback_data` має вигляд "розділ:дія:a1:a2";
 * на запит до Telegram відповідається рівно один раз: достроково через `answerNow`
 * або наприкінці, з коротким повідомленням `toast`, якщо воно є.
 */
async function onCallback(ctx: Ctx, cq: TgCallbackQuery): Promise<void> {
  const data = cq.data ?? '';
  const messageId = cq.message?.message_id ?? 0;
  const [area, action = '', a1, a2] = data.split(':');
  const id = Number(a1);
  let toast: string | undefined;
  let answered = false;
  const answerNow = async () => {
    if (!answered) {
      answered = true;
      await ctx.tg.answerCallback(cq.id);
    }
  };

  try {
    switch (area) {
      case 'x':
        await setState(ctx, null);
        if (messageId) await ctx.tg.editHtml(ctx.chatId, messageId, 'Скасовано.');
        break;

      case 'sch':
        if (action === 'add') await schedule.startAddLessons(ctx);
        else if (action === 'ai') await schedule.startAiSchedule(ctx);
        else if (action === 'today') await schedule.showToday(ctx);
        else if (action === 'view') await schedule.showSchedule(ctx);
        else if (action === 'back') await schedule.showSchedule(ctx, messageId);
        else if (action === 'del') await schedule.chooseDayToDelete(ctx, messageId);
        else if (action === 'dd') await schedule.showDayForDelete(ctx, messageId, id);
        else if (action === 'x') {
          if (await ctx.db.deleteLesson(ctx.user.id, id)) toast = 'Видалено';
          await schedule.showDayForDelete(ctx, messageId, Number(a2));
        } else if (action === 'clr') await schedule.confirmClear(ctx, messageId);
        else if (action === 'clr!') {
          await ctx.db.clearLessons(ctx.user.id);
          toast = 'Розклад очищено';
          await schedule.showSchedule(ctx, messageId);
        } else if (action === 'save' || action === 'replace') await schedule.savePreview(ctx, action === 'replace');
        else if (action === 'redo') {
          await answerNow();
          await schedule.redoPreview(ctx, null);
        }
        break;

      case 'dl':
        if (action === 'add') await deadlines.startAddDeadline(ctx);
        else if (action === 'list') await deadlines.showDeadlines(ctx);
        else if (action === 'ok') {
          const d = await ctx.db.getDeadline(ctx.user.id, id);
          if (d && (await ctx.db.setDeadlineDone(ctx.user.id, id, ctx.now))) {
            toast = d.due_at >= ctx.now ? 'Виконано вчасно! 🎉' : 'Виконано! 🎉';
          }
          if (cq.message?.text?.startsWith('⏰ Дедлайни')) await deadlines.showDeadlines(ctx, messageId);
          else if (messageId && d) await ctx.tg.editHtml(ctx.chatId, messageId, `✅ <b>${escapeHtml(d.title)}</b>: виконано.`);
        } else if (action === 'rm') {
          await ctx.tg.editMarkup(ctx.chatId, messageId, kb([btn('🗑 Так, видалити', `dl:rm!:${id}`), btn('Ні', 'dl:back')]));
          toast = 'Точно видалити дедлайн?';
        } else if (action === 'rm!') {
          if (await ctx.db.deleteDeadline(ctx.user.id, id)) toast = 'Видалено';
          await deadlines.showDeadlines(ctx, messageId);
        } else if (action === 'back') {
          await deadlines.showDeadlines(ctx, messageId);
        } else if (action === 'sp') {
          await answerNow();
          await tasks.splitDeadline(ctx, id);
        } else if (action === 'i' || action === 'c') {
          await deadlines.rateDeadline(ctx, id, action === 'i' ? 'importance' : 'difficulty', Number(a2), messageId);
        }
        break;

      case 'tk':
        if (action === 'list') await tasks.listTasks(ctx);
        else if (action === 'new') await tasks.startSplit(ctx);
        else if (action === 'v') await tasks.showTask(ctx, id);
        else if (action === 'vb') await tasks.showTask(ctx, id, messageId);
        else if (action === 's') await tasks.toggleStep(ctx, id, messageId);
        else if (action === 'rm') {
          await ctx.tg.editMarkup(ctx.chatId, messageId, kb([btn('🗑 Так, видалити', `tk:rm!:${id}`), btn('Ні', `tk:vb:${id}`)]));
          toast = 'Точно видалити?';
        } else if (action === 'rm!') {
          if (await ctx.db.deleteTask(ctx.user.id, id)) toast = 'Видалено';
          await tasks.listTasks(ctx, messageId);
        }
        break;

      case 'st': {
        await answerNow();
        if (action === 'quiz') await study.quizFromLastSummary(ctx);
        else if (action === 'sum') await study.startSummary(ctx);
        else if (action === 'fsum' || action === 'fquiz') {
          const msg = study.pendingFileMessage(ctx);
          if (!msg) {
            await reply(ctx, 'Надішли файл чи фото ще раз, будь ласка.');
            break;
          }
          await setState(ctx, null);
          const material = await study.materialFrom(ctx, msg);
          if (!material) break;
          if (action === 'fsum') await study.makeSummary(ctx, material);
          else await study.makeQuiz(ctx, material, study.questionCount(material.text));
        }
        break;
      }

      case 'qz':
        await answerNow();
        await study.fromPastQuiz(ctx, id, action === 'sum' ? 'summary' : 'quiz');
        break;

      case 'pl':
        // Кнопки старих повідомлень майстра без чернетки нічого не роблять: пояснюємо чому.
        if (!['start', 'k', 'tips'].includes(action) && !plan.hasDraft(ctx)) {
          toast = 'Цей крок уже неактуальний. Почни заново: /plan';
          break;
        }
        if (action === 'start') await plan.startPlan(ctx);
        else if (action === 'k' && (a1 === 'nmt' || a1 === 'exam' || a1 === 'custom')) await plan.chooseKind(ctx, a1);
        else if (action === 's') await plan.toggleNmtSubject(ctx, a1, messageId);
        else if (action === 'next') {
          if (!(await plan.nmtSubjectsDone(ctx))) toast = 'Обери хоча б один предмет';
        } else if (action === 'd') await plan.setNmtDate(ctx, plan.nmtAutoDate(ctx));
        else if (action === 'r') {
          if (a1 === 'd' || a1 === 'l') await plan.cycleRating(ctx, a1, Number(a2), messageId);
          else if (a1 === 'ok') await plan.goBudget(ctx);
          else toast = 'Натискай 💪 чи 📚 праворуч';
        } else if (action === 'av') await plan.setAvailabilityPreset(ctx, a1, messageId);
        else if (action === 'b') await plan.setBudget(ctx, null);
        else if (action === 'budget') await plan.goBudget(ctx);
        else if (action === 'edit') await plan.backToRate(ctx);
        else if (action === 'save') await plan.savePlan(ctx);
        else if (action === 'tips') {
          await answerNow();
          await plan.planTips(ctx, id);
        }
        break;

      case 'tm':
        if (action === 'start') await progress.startTimerPick(ctx);
        else if (action === 'go') {
          const subject = progress.pickedSubject(ctx, id);
          if (subject) await progress.startTimer(ctx, subject);
          else await progress.startTimerPick(ctx);
        } else if (action === 'stop') await progress.stopTimer(ctx);
        else if (action === 'log') await progress.startLogTime(ctx);
        break;

      case 'pg':
        await progress.showProgress(ctx);
        break;

      case 'gr':
        if (action === 'add') await grades.startAddGrades(ctx);
        else if (action === 'show') await grades.showGrades(ctx);
        else if (action === 'target') await grades.chooseTargetSubject(ctx);
        else if (action === 's') await grades.chooseTargetGrade(ctx, id);
        else if (action === 'g') await grades.showTarget(ctx, id, Number(a2));
        else if (action === 'undo') await grades.undoLastGrade(ctx);
        else if (action === 'clr') await grades.confirmClearGrades(ctx);
        else if (action === 'clr!') {
          await ctx.db.clearGrades(ctx.user.id);
          toast = 'Оцінки видалено';
          await grades.showGrades(ctx);
        }
        break;

      case 'set':
        if (action === 'show') await settings.showSettings(ctx, messageId);
        else if (action === 'wipe!') await settings.setSetting(ctx, 'wipe', '!', messageId);
        else if (a1 !== undefined) await settings.setSetting(ctx, action, a1, messageId);
        else await settings.editSetting(ctx, action, messageId);
        break;
    }
  } finally {
    if (!answered) await ctx.tg.answerCallback(cq.id, toast);
  }
}
