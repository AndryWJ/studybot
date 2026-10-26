/**
 * Підготовка тексту до Telegram: екранування HTML, перетворення Markdown-відповідей
 * ШІ на дозволений Telegram піднабір HTML і нарізка довгого тексту на повідомлення.
 *
 * Telegram у режимі parse_mode=HTML розуміє лише b, i, u, s, code, pre, a, blockquote
 * і tg-spoiler, а будь-який зайвий "<" ламає все повідомлення. Тому весь текст спершу
 * екранується, а теги додаються вже поверх екранованого.
 */

/** Екранує `&`, `<` і `>` для parse_mode=HTML. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

const SUPERSCRIPT: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', n: 'ⁿ', i: 'ⁱ',
};
const SUBSCRIPT: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋',
};
const LATEX_SYMBOLS: Array<[RegExp, string]> = [
  [/\\cdot/g, '·'], [/\\times/g, '×'], [/\\div/g, '÷'], [/\\pm/g, '±'], [/\\mp/g, '∓'],
  [/\\leq?(?![a-z])/g, '≤'], [/\\geq?(?![a-z])/g, '≥'], [/\\neq?(?![a-z])/g, '≠'], [/\\approx/g, '≈'],
  [/\\infty/g, '∞'], [/\\pi/g, 'π'], [/\\alpha/g, 'α'], [/\\beta/g, 'β'], [/\\gamma/g, 'γ'],
  [/\\delta/g, 'δ'], [/\\Delta/g, 'Δ'], [/\\lambda/g, 'λ'], [/\\mu/g, 'μ'], [/\\sigma/g, 'σ'],
  [/\\omega/g, 'ω'], [/\\Omega/g, 'Ω'], [/\\varphi|\\phi/g, 'φ'], [/\\theta/g, 'θ'], [/\\rho/g, 'ρ'],
  [/\\degree|\^\\circ|\^\{\\circ\}/g, '°'], [/\\angle/g, '∠'], [/\\in(?![a-z])/g, '∈'],
  [/\\rightarrow|\\to(?![a-z])/g, ' дає '], [/\\Rightarrow/g, ', отже, '], [/\\sum/g, 'Σ'],
  [/\\int/g, '∫'], [/\\sqrt\[3\]/g, '∛'], [/\\%/g, '%'], [/\\,|\\;|\\!|\\quad|\\qquad/g, ' '],
  [/\\left|\\right/g, ''], [/\\text\{([^{}]*)\}/g, '$1'], [/\\mathrm\{([^{}]*)\}/g, '$1'],
];

/**
 * Спрощує LaTeX-формули до звичайного тексту з Unicode-символами: Telegram
 * формул не рендерить, а моделі часто відповідають саме LaTeX-ом.
 */
export function latexToText(s: string): string {
  let t = s.replace(/\$\$([\s\S]+?)\$\$/g, '$1').replace(/\\\[([\s\S]+?)\\\]/g, '$1').replace(/\\\(([\s\S]+?)\\\)/g, '$1');
  // $...$ вважається формулою, лише якщо одразу після першого і перед другим знаком немає пробілу:
  // так "5 $ або 10 $" лишається цінами.
  t = t.replace(/(^|[^\\\w])\$(?!\s)([^$\n]{1,200}?)(?<!\s)\$(?!\d)/g, '$1$2');
  for (let i = 0; i < 3; i++) {
    t = t.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (_, a: string, b: string) => `${wrap(a)}/${wrap(b)}`);
    t = t.replace(/\\sqrt\{([^{}]*)\}/g, (_, a: string) => `√${wrap(a)}`);
  }
  for (const [re, rep] of LATEX_SYMBOLS) t = t.replace(re, rep);
  t = t.replace(/\^\{([^{}]{1,12})\}|\^([0-9n+\-i])/g, (m, group?: string, single?: string) => toScript(group ?? single ?? '', SUPERSCRIPT) ?? m);
  t = t.replace(/_\{([0-9+\-]{1,6})\}|_([0-9])(?![0-9a-z_])/g, (m, group?: string, single?: string) => toScript(group ?? single ?? '', SUBSCRIPT) ?? m);
  return t;
}

function wrap(expr: string): string {
  const e = expr.trim();
  return /^[\w.]+$/.test(e) ? e : `(${e})`;
}

function toScript(chars: string, table: Record<string, string>): string | null {
  let out = '';
  for (const c of chars) {
    const mapped = table[c];
    if (!mapped) return null;
    out += mapped;
  }
  return out;
}

/** Чи правильно вкладені теги b, i, s, code, a в рядку (Telegram відкидає перехрещені). */
function balanced(html: string): boolean {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)(b|i|s|code|a)(?:\s[^>]*)?>/g)) {
    if (!m[1]) stack.push(m[2]);
    else if (stack.pop() !== m[2]) return false;
  }
  return stack.length === 0;
}

/**
 * Inline-розмітка в межах одного рядка, текст уже екранований. Код і посилання
 * спершу ховаються за маркерами, щоб жирний і курсив не зачіпали їхній вміст.
 * Якщо теги виходять перехрещеними, рядок лишається без оформлення.
 */
function inline(escaped: string): string {
  const stash: string[] = [];
  const hide = (html: string) => {
    stash.push(html);
    return `\u0000${stash.length - 1}\u0000`;
  };
  let t = escaped.replace(/`([^`\n]+)`/g, (_, code: string) => hide(`<code>${code}</code>`));
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text: string, url: string) =>
    hide(`<a href="${escapeAttr(url.replace(/&amp;/g, '&'))}">${text.replace(/\*\*|__|~~|(?<!\w)\*|\*(?!\w)/g, '')}</a>`),
  );
  const plain = t;
  t = t.replace(/\*\*(?!\s)([^*\n]+?)(?<!\s)\*\*/g, '<b>$1</b>');
  t = t.replace(/__(?!\s)([^_\n]+?)(?<!\s)__/g, '<b>$1</b>');
  t = t.replace(/(^|[^\w*])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![\w*])/g, '$1<i>$2</i>');
  t = t.replace(/~~(?!\s)([^~\n]+?)(?<!\s)~~/g, '<s>$1</s>');
  if (!balanced(t)) t = plain;
  return t.replace(/\u0000(\d+)\u0000/g, (_, i: string) => stash[Number(i)]);
}

/**
 * Перетворює Markdown, який зазвичай повертають моделі, на HTML для Telegram:
 * заголовки стають жирним, маркери списків крапками, таблиці рядками через " · ",
 * блоки коду тегом pre. Формули LaTeX спрощуються всюди, крім коду.
 * Невідома розмітка лишається звичайним текстом.
 */
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let inCode = false;
  let code: string[] = [];
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      if (inCode) {
        out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
        code = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(raw);
      continue;
    }
    // LaTeX спрощується в усьому, крім inline-коду між зворотними лапками.
    const line = raw
      .split(/(`[^`\n]+`)/)
      .map((part) => (part.startsWith('`') && part.endsWith('`') && part.length > 1 ? part : latexToText(part)))
      .join('');
    const e = escapeHtml(line);
    let m: RegExpExecArray | null;
    if ((m = /^\s*#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(e))) {
      out.push(`<b>${inline(m[1].replace(/\*\*/g, ''))}</b>`);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(e)) {
      out.push('');
    } else if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(e)) {
      continue;
    } else if (/^\s*\|.*\|\s*$/.test(e)) {
      const cells = e.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim())).filter(Boolean);
      out.push(cells.join(' · '));
    } else if ((m = /^(\s*)[-*+•]\s+(.*)$/.exec(e))) {
      const indent = m[1].length >= 2 ? '   ' : '';
      out.push(`${indent}• ${inline(m[2])}`);
    } else if ((m = /^\s*&gt;\s?(.*)$/.exec(e))) {
      out.push(`<i>${inline(m[1]).replace(/<\/?i>/g, '')}</i>`);
    } else {
      out.push(inline(e));
    }
  }
  if (inCode && code.length) out.push(`<pre>${escapeHtml(code.join('\n'))}</pre>`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Прибирає HTML-теги і розкодовує сутності: запасний варіант, якщо Telegram не прийняв розмітку. */
export function htmlToPlain(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Ріже текст на шматки не довші за `limit`, намагаючись різати по абзацах, потім
 * по рядках, потім по пробілах. Розмітку не аналізує, тому викликати його слід
 * на Markdown до перетворення в HTML.
 */
export function splitText(text: string, limit = 3500): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.4) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.4) cut = window.lastIndexOf(' ');
    if (cut < limit * 0.4) cut = limit;
    // Не розрізаємо пару UTF-16 (емодзі) навпіл.
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** Обрізає рядок до `max` символів, додаючи "…", якщо щось відрізано. */
export function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}
