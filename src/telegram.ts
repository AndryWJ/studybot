/**
 * Тонкий клієнт Telegram Bot API (https://core.telegram.org/bots/api) і типи
 * лише тих об'єктів, якими користується бот. Без сторонніх бібліотек: кожен
 * метод це один POST-запит із JSON.
 */

import { htmlToPlain, markdownToHtml, splitText, escapeHtml } from './format';

/** Користувач чи бот Telegram (об'єкт User з Bot API). */
export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  language_code?: string;
}

/** Чат (об'єкт Chat з Bot API). */
export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
}

/** Один розмір фото в повідомленні. */
export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/** Файл, надісланий як документ. */
export interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

/** Повідомлення; `date` у unix-секундах. */
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  photo?: TgPhotoSize[];
  document?: TgDocument;
  poll?: { id: string };
}

/** Натискання inline-кнопки; `data`: callback_data цієї кнопки. */
export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

/** Відповідь користувача в неанонімному опитуванні; `option_ids`: індекси обраних варіантів з нуля. */
export interface TgPollAnswer {
  poll_id: string;
  user?: TgUser;
  option_ids: number[];
}

/** Зміна статусу бота в чаті; `status` "kicked" означає, що користувач заблокував бота. */
export interface TgChatMemberUpdated {
  chat: TgChat;
  from: TgUser;
  new_chat_member: { status: string };
}

/** Вхідне оновлення від Telegram; крім `update_id` заповнене одне з необов'язкових полів. */
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
  poll_answer?: TgPollAnswer;
  my_chat_member?: TgChatMemberUpdated;
}

/** Кнопка під повідомленням; задається одне з `callback_data`, `url`, `web_app`. */
export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
  /** Mini App: сторінка, що відкривається всередині Telegram (лише в приватних чатах). */
  web_app?: { url: string };
}

/** Кнопки під повідомленням, по рядках. */
export interface InlineKeyboard {
  inline_keyboard: InlineButton[][];
}

/** Клавіатура на місці системної клавіатури; кнопка надсилає свій текст як повідомлення. */
export interface ReplyKeyboard {
  keyboard: { text: string }[][];
  resize_keyboard?: boolean;
  is_persistent?: boolean;
  input_field_placeholder?: string;
}

/** Розмітка відповіді: inline-кнопки, клавіатура або прибирання клавіатури. */
export type ReplyMarkup = InlineKeyboard | ReplyKeyboard | { remove_keyboard: true };

/** Параметри надсилання повідомлення. */
export interface SendOptions {
  reply_markup?: ReplyMarkup;
  /** Не показувати прев'ю посилань. */
  noPreview?: boolean;
}

/** Помилка, яку повернув Bot API. `code` це HTTP-подібний код із відповіді (400, 403, 429...). */
export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${method}: ${code} ${description}`);
  }

  /** Користувач заблокував бота або видалив чат: писати йому більше немає сенсу. */
  get isBlocked(): boolean {
    return this.code === 403;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Клієнт Bot API для одного бота. `base`: адреса API, змінюється лише в тестах. */
export class Telegram {
  private readonly base: string;

  constructor(
    private readonly token: string,
    base = 'https://api.telegram.org',
  ) {
    this.base = base.replace(/\/+$/, '');
  }

  /**
   * Викликає метод Bot API і повертає поле `result`.
   * На 429 один раз чекає `retry_after` (якщо це не довше за 5 с) і повторює.
   * @throws TelegramError, якщо Telegram відповів ok=false.
   */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });
      let data: { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } };
      try {
        data = await res.json();
      } catch {
        throw new TelegramError(method, res.status, `non-JSON response (HTTP ${res.status})`);
      }
      if (data.ok) return data.result as T;
      const retryAfter = data.parameters?.retry_after;
      const code = data.error_code ?? res.status;
      if (code === 429 && attempt === 0 && retryAfter !== undefined && retryAfter <= 5) {
        await sleep(retryAfter * 1000);
        continue;
      }
      throw new TelegramError(method, code, data.description ?? 'unknown error', retryAfter);
    }
  }

  /**
   * Надсилає HTML-повідомлення. Якщо Telegram не зміг розібрати розмітку,
   * надсилає той самий текст без тегів; якщо текст задовгий, ділить його на
   * кілька повідомлень без тегів. Клавіатура йде з останнім повідомленням.
   */
  async sendHtml(chatId: number, html: string, opts: SendOptions = {}): Promise<TgMessage> {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: opts.noPreview ?? true },
    };
    if (opts.reply_markup) params.reply_markup = opts.reply_markup;
    try {
      return await this.call<TgMessage>('sendMessage', params);
    } catch (e) {
      if (e instanceof TelegramError && e.code === 400 && /parse entities|can't find end|unsupported start tag/i.test(e.description)) {
        delete params.parse_mode;
        params.text = htmlToPlain(html);
        return this.call<TgMessage>('sendMessage', params);
      }
      if (e instanceof TelegramError && e.code === 400 && /too long/i.test(e.description)) {
        const parts = splitText(htmlToPlain(html), 4000);
        let last: TgMessage | undefined;
        for (let i = 0; i < parts.length; i++) {
          const isLast = i === parts.length - 1;
          last = await this.call<TgMessage>('sendMessage', {
            chat_id: chatId,
            text: parts[i],
            link_preview_options: { is_disabled: true },
            ...(isLast && opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
          });
        }
        if (last) return last;
      }
      throw e;
    }
  }

  /** Надсилає звичайний текст, екрануючи все, що схоже на HTML. */
  sendText(chatId: number, text: string, opts: SendOptions = {}): Promise<TgMessage> {
    return this.sendHtml(chatId, escapeHtml(text), opts);
  }

  /**
   * Надсилає Markdown-відповідь ШІ: перетворює на HTML і за потреби ділить на
   * кілька повідомлень. Клавіатура чіпляється до останнього шматка.
   */
  async sendMarkdown(chatId: number, markdown: string, opts: SendOptions = {}): Promise<TgMessage> {
    const chunks = splitText(markdown, 3500);
    let last: TgMessage | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      last = await this.sendHtml(chatId, markdownToHtml(chunks[i]), isLast ? opts : { noPreview: opts.noPreview });
    }
    return last ?? this.sendText(chatId, '…', opts);
  }

  /** Редагує текст повідомлення; помилку "message is not modified" ігнорує. */
  async editHtml(chatId: number, messageId: number, html: string, markup?: InlineKeyboard): Promise<void> {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    };
    if (markup) params.reply_markup = markup;
    try {
      await this.call('editMessageText', params);
    } catch (e) {
      if (e instanceof TelegramError && /message is not modified/i.test(e.description)) return;
      throw e;
    }
  }

  /** Замінює лише клавіатуру під повідомленням. */
  async editMarkup(chatId: number, messageId: number, markup: InlineKeyboard): Promise<void> {
    try {
      await this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: markup });
    } catch (e) {
      if (e instanceof TelegramError && /message is not modified/i.test(e.description)) return;
      throw e;
    }
  }

  /** Підтверджує натискання кнопки (інакше біля неї лишається індикатор завантаження); `alert` показує `text` у вікні. Помилки ігнорує. */
  async answerCallback(id: string, text?: string, alert = false): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: id, text, show_alert: alert }).catch(() => undefined);
  }

  /** Показує в чаті, що бот друкує. Помилки ігнорує. */
  async typing(chatId: number): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => undefined);
  }

  /** Видаляє повідомлення. Помилки ігнорує: воно могло вже зникнути. */
  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.call('deleteMessage', { chat_id: chatId, message_id: messageId }).catch(() => undefined);
  }

  /**
   * Надсилає тест-вікторину (одне питання). `correct`: індекси правильних
   * варіантів, з нуля. Опитування неанонімне, інакше Telegram не надсилає боту
   * poll_answer з відповіддю користувача.
   */
  sendQuiz(chatId: number, question: string, options: string[], correct: number[], explanation?: string): Promise<TgMessage> {
    const params: Record<string, unknown> = {
      chat_id: chatId,
      question,
      options: options.map((text) => ({ text })),
      type: 'quiz',
      is_anonymous: false,
      correct_option_ids: correct,
    };
    if (explanation) params.explanation = explanation;
    return this.call<TgMessage>('sendPoll', params);
  }

  /** Завантажує файл, надісланий користувачем (до 20 МБ), і повертає його байти. */
  async downloadFile(fileId: string): Promise<{ bytes: Uint8Array; path: string }> {
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: fileId });
    if (!file.file_path) throw new TelegramError('getFile', 400, 'file_path is missing');
    const res = await fetch(`${this.base}/file/bot${this.token}/${file.file_path}`);
    if (!res.ok) throw new TelegramError('downloadFile', res.status, `HTTP ${res.status}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), path: file.file_path };
  }
}
