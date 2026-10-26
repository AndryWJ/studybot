/**
 * Кнопки головного меню, допоміжні функції для inline-клавіатур і спільні тексти.
 *
 * callback_data у Telegram обмежене 64 байтами, тому в кнопках лише короткі коди
 * виду "розділ:дія:id", а не текст.
 */

import type { InlineButton, InlineKeyboard, ReplyKeyboard } from '../telegram';

/** Підписи кнопок головного меню; за цим текстом роутер впізнає натискання. */
export const BTN = {
  schedule: '📅 Розклад',
  deadlines: '⏰ Дедлайни',
  split: '🧩 Розбити завдання',
  plan: '🎯 План підготовки',
  summary: '📝 Конспект',
  quiz: '❓ Тест',
  progress: '📊 Прогрес',
  grades: '🎓 Оцінки',
  settings: '⚙️ Налаштування',
  help: 'ℹ️ Допомога',
} as const;

/** Постійна клавіатура головного меню під полем введення. */
export function mainMenu(): ReplyKeyboard {
  return {
    keyboard: [
      [{ text: BTN.schedule }, { text: BTN.deadlines }],
      [{ text: BTN.plan }, { text: BTN.split }],
      [{ text: BTN.summary }, { text: BTN.quiz }],
      [{ text: BTN.progress }, { text: BTN.grades }],
      [{ text: BTN.settings }, { text: BTN.help }],
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: 'Напиши питання або обери дію',
  };
}

/** Одна кнопка з callback-даними. */
export function btn(text: string, data: string): InlineButton {
  return { text, callback_data: data };
}

/** Inline-клавіатура з рядків кнопок; порожні рядки відкидаються. */
export function kb(...rows: InlineButton[][]): InlineKeyboard {
  return { inline_keyboard: rows.filter((r) => r.length > 0) };
}

/** Розкладає кнопки в рядки по `perRow`. */
export function grid(buttons: InlineButton[], perRow: number): InlineButton[][] {
  const rows: InlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += perRow) rows.push(buttons.slice(i, i + perRow));
  return rows;
}

/** Рядок inline-клавіатури з кнопкою скасування поточного кроку діалогу. */
export const CANCEL_ROW = [btn('❌ Скасувати', 'x:cancel')];

/** Довідка про можливості бота в HTML-розмітці Telegram; показується за /help і кнопкою "Допомога". */
export const HELP_TEXT = `<b>StudyBot допомагає вчитися без авралів.</b>

📅 <b>Розклад</b>: уроки, пари й самопідготовка; ШІ може скласти розклад за описом твого тижня.
⏰ <b>Дедлайни</b>: напиши, наприклад, <i>реферат з біології до 15.11 18:00</i>. Нагадаю заздалегідь, а список упорядкую за пріоритетом (термін, важливість, складність).
🎯 <b>План підготовки</b>: рахую, скільки годин дати кожному предмету за складністю й твоїм рівнем, і розкладаю заняття по вільних днях так, щоб кожен предмет устиг до свого іспиту. Підходить для НМТ, сесії чи контрольних.
🧩 <b>Розбити завдання</b>: велике завдання на кроки, розкладені по днях до дедлайну.
📝 <b>Конспект</b> і ❓ <b>Тест</b>: з тексту, теми чи фото сторінки.
📊 <b>Прогрес</b>: таймер навчання, відсоток виконаних завдань і графіки витраченого часу.
🎓 <b>Оцінки</b>: середній бал і скільки треба отримати для бажаної підсумкової.

Щоранку надсилаю зведення на день (вимикається в налаштуваннях). Можна просто написати питання з будь-якого предмета, і я поясню.
Швидкий дедлайн: почни повідомлення зі слова <i>нагадай</i>, наприклад <i>нагадай завтра о 9 взяти форму</i>.

/cancel скасовує поточну дію, /today показує план на сьогодні.`;

/** Команди для меню Telegram (setMyCommands). */
export const COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'start', description: 'Почати і показати меню' },
  { command: 'today', description: 'План на сьогодні' },
  { command: 'schedule', description: 'Розклад на тиждень' },
  { command: 'deadlines', description: 'Дедлайни' },
  { command: 'add', description: 'Додати дедлайн' },
  { command: 'tasks', description: 'Завдання, розбиті на кроки' },
  { command: 'split', description: 'Розбити завдання на кроки' },
  { command: 'plan', description: 'План підготовки до НМТ чи іспитів' },
  { command: 'progress', description: 'Прогрес, час навчання і графіки' },
  { command: 'timer', description: 'Запустити або зупинити таймер навчання' },
  { command: 'grades', description: 'Оцінки і середній бал' },
  { command: 'summary', description: 'Зробити конспект' },
  { command: 'quiz', description: 'Тест для самоперевірки' },
  { command: 'settings', description: 'Налаштування' },
  { command: 'help', description: 'Що вміє бот' },
  { command: 'cancel', description: 'Скасувати поточну дію' },
];
