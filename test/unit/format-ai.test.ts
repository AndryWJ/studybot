/**
 * Модульні тести src/format.ts (екранування, Markdown у HTML Telegram, LaTeX,
 * нарізка тексту) і src/ai/* (витяг JSON, провайдери із запасними варіантами,
 * валідатори відповідей моделі).
 *
 * Мережа не потрібна: провайдери підміняються фальшивими об'єктами, а fetch
 * для OpenAI-сумісного клієнта перехоплюється через vi.spyOn.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiUnavailableError,
  ProviderError,
  complete,
  completeJson,
  extractJson,
  openAiCompatible,
  providersFromEnv,
  workersAiText,
  type AiRequest,
  type Provider,
} from '../../src/ai/client';
import {
  NMT_FACTS,
  buildDeadlineExtract,
  buildLessonExtract,
  buildPlanAdvice,
  buildQuiz,
  buildSchedule,
  buildSplit,
  buildSummary,
  buildTutor,
  nowContext,
  parseDeadlineExtract,
  parseQuiz,
  parseSplit,
  parseWeekly,
} from '../../src/ai/prompts';
import type { AppEnv } from '../../src/env';
import { escapeHtml, htmlToPlain, latexToText, markdownToHtml, splitText, truncate } from '../../src/format';

const ALLOWED_TAGS = new Set(['b', 'i', 's', 'u', 'code', 'pre', 'a']);

/** Перевіряє, що HTML складається лише з дозволених тегів, збалансований і без "голих" < > &. */
function assertTelegramSafe(html: string): void {
  const tagRe = /<(\/?)([a-z]+)([^<>]*)>/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const [, closing, name, attrs] = m;
    expect(ALLOWED_TAGS.has(name), `tag <${name}> is not allowed in: ${html}`).toBe(true);
    if (closing) {
      expect(stack.pop(), `unbalanced </${name}> in: ${html}`).toBe(name);
      expect(attrs).toBe('');
    } else {
      stack.push(name);
      if (name === 'a') expect(attrs, `bad <a> attributes in: ${html}`).toMatch(/^ href="[^"<>]*"$/);
      else expect(attrs).toBe('');
    }
  }
  expect(stack, `unclosed tags in: ${html}`).toEqual([]);
  const text = html.replace(tagRe, '');
  expect(text, `raw angle bracket in: ${html}`).not.toMatch(/[<>]/);
  expect(text, `raw ampersand in: ${html}`).not.toMatch(/&(?!(?:amp|lt|gt|quot);)/);
}

describe('escapeHtml', () => {
  it('escapes ampersand, less-than and greater-than', () => {
    expect(escapeHtml('<script>alert("x")</script> & co')).toBe('&lt;script&gt;alert("x")&lt;/script&gt; &amp; co');
  });
  it('escapes the ampersand first so entities are not double-decoded', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
  it('leaves plain and Ukrainian text untouched', () => {
    expect(escapeHtml('Привіт, світе!')).toBe('Привіт, світе!');
  });
});

describe('latexToText', () => {
  it('converts \\frac and \\sqrt', () => {
    expect(latexToText('\\frac{1}{2}')).toBe('1/2');
    expect(latexToText('\\frac{a+b}{c}')).toBe('(a+b)/c');
    expect(latexToText('\\sqrt{x}')).toBe('√x');
    expect(latexToText('\\sqrt{x+1}')).toBe('√(x+1)');
  });
  it('handles a \\sqrt nested in a \\frac', () => {
    expect(latexToText('\\frac{\\sqrt{2}}{2}')).toBe('(√2)/2');
  });
  it('converts superscripts', () => {
    expect(latexToText('x^2')).toBe('x²');
    expect(latexToText('x^{10}')).toBe('x¹⁰');
    expect(latexToText('a^{-1}')).toBe('a⁻¹');
    expect(latexToText('2^n')).toBe('2ⁿ');
  });
  it('keeps a superscript it cannot render', () => {
    expect(latexToText('x^{ab}')).toBe('x^{ab}');
  });
  it('converts subscripts in chemical formulas', () => {
    expect(latexToText('H_2O')).toBe('H₂O');
    expect(latexToText('CO_{2}')).toBe('CO₂');
  });
  it('converts symbols', () => {
    expect(latexToText('a \\cdot b')).toBe('a · b');
    expect(latexToText('x \\le 5')).toBe('x ≤ 5');
    expect(latexToText('x \\leq 5')).toBe('x ≤ 5');
    expect(latexToText('x \\geq 5')).toBe('x ≥ 5');
    expect(latexToText('a \\neq b')).toBe('a ≠ b');
    expect(latexToText('\\pi r^2')).toBe('π r²');
    expect(latexToText('30^\\circ')).toBe('30°');
    expect(latexToText('a \\times b \\pm c')).toBe('a × b ± c');
  });
  it('does not treat \\left or \\leftarrow-like commands as \\le', () => {
    expect(latexToText('\\left(x\\right)')).toBe('(x)');
  });
  it('removes $...$, $$...$$, \\(...\\) and \\[...\\] delimiters', () => {
    expect(latexToText('Нехай $x^2$ додатне')).toBe('Нехай x² додатне');
    expect(latexToText('$$\\frac{1}{2}$$')).toBe('1/2');
    expect(latexToText('де \\(a \\cdot b\\) число')).toBe('де a · b число');
    expect(latexToText('\\[x \\le 1\\]')).toBe('x ≤ 1');
  });
  it('unwraps \\text{} and \\mathrm{}', () => {
    expect(latexToText('\\text{км}/\\mathrm{год}')).toBe('км/год');
  });

  describe('dollar amounts', () => {
    it('keeps "$5 and $10"', () => {
      expect(latexToText('$5 and $10')).toBe('$5 and $10');
    });
    it('keeps several prices in a sentence', () => {
      const s = 'Це коштує $5 або $10, а разом $15.';
      expect(latexToText(s)).toBe(s);
    });
    it('keeps prices written with the sign after the number ("5 $ or 10 $")', () => {
      const s = 'Квиток коштує 5 $ або 10 $.';
      expect(latexToText(s)).toBe(s);
    });
    it('keeps a lone dollar sign', () => {
      expect(latexToText('Ціна: 5$')).toBe('Ціна: 5$');
    });
  });
});

describe('markdownToHtml', () => {
  it('returns an empty string for empty input', () => {
    expect(markdownToHtml('')).toBe('');
    expect(markdownToHtml('  \n \n')).toBe('');
  });
  it('turns headers of every level into bold', () => {
    expect(markdownToHtml('# Один')).toBe('<b>Один</b>');
    expect(markdownToHtml('### Три')).toBe('<b>Три</b>');
    expect(markdownToHtml('###### Шість')).toBe('<b>Шість</b>');
  });
  it('drops closing hashes of a header', () => {
    expect(markdownToHtml('## Тема ##')).toBe('<b>Тема</b>');
  });
  it('does not treat a hash that is part of a word as closing hashes', () => {
    expect(markdownToHtml('# Мова C#')).toBe('<b>Мова C#</b>');
  });
  it('does not nest bold inside a header that already has **bold**', () => {
    expect(markdownToHtml('## **Тема**')).toBe('<b>Тема</b>');
  });
  it('turns bullets into "•" for -, * and +', () => {
    expect(markdownToHtml('- а\n* б\n+ в')).toBe('• а\n• б\n• в');
  });
  it('indents nested bullets', () => {
    expect(markdownToHtml('- а\n  - б')).toBe('• а\n   • б');
  });
  it('keeps numbered lists as they are', () => {
    expect(markdownToHtml('1. перше\n2. друге')).toBe('1. перше\n2. друге');
  });
  it('converts **bold** and __bold__', () => {
    expect(markdownToHtml('це **важливо** і __теж__')).toBe('це <b>важливо</b> і <b>теж</b>');
  });
  it('converts *italic*', () => {
    expect(markdownToHtml('це *курсив* тут')).toBe('це <i>курсив</i> тут');
  });
  it('converts ~~strikethrough~~', () => {
    expect(markdownToHtml('~~старе~~')).toBe('<s>старе</s>');
  });
  it('does not treat math like 2*3*4 as italic', () => {
    expect(markdownToHtml('2*3*4 = 24')).toBe('2*3*4 = 24');
    expect(markdownToHtml('a * b * c')).toBe('a * b * c');
  });
  it('does not treat a bullet marker as italic', () => {
    expect(markdownToHtml('* *курсив* у списку')).toBe('• <i>курсив</i> у списку');
  });
  it('wraps inline code and keeps HTML-looking content escaped inside it', () => {
    expect(markdownToHtml('виклич `<div class="a">&</div>` тут')).toBe('виклич <code>&lt;div class="a"&gt;&amp;&lt;/div&gt;</code> тут');
  });
  it('does not apply emphasis inside inline code', () => {
    expect(markdownToHtml('`**не жирний** і *не курсив*`')).toBe('<code>**не жирний** і *не курсив*</code>');
  });
  it('converts fenced code to <pre> and escapes its content', () => {
    const out = markdownToHtml('до\n```html\n<script>alert(1)</script>\n**x**\n```\nпісля');
    expect(out).toBe('до\n<pre>&lt;script&gt;alert(1)&lt;/script&gt;\n**x**</pre>\nпісля');
  });
  it('closes an unterminated code fence', () => {
    const out = markdownToHtml('```\nlet a = 1 < 2;');
    expect(out).toBe('<pre>let a = 1 &lt; 2;</pre>');
    assertTelegramSafe(out);
  });
  it('keeps shell and PHP variables in a code block untouched', () => {
    expect(markdownToHtml('```bash\necho $HOME and $PATH\n```')).toBe('<pre>echo $HOME and $PATH</pre>');
  });
  it('keeps dollar variables in inline code untouched', () => {
    expect(markdownToHtml('Формула `$a + $b` у PHP')).toBe('Формула <code>$a + $b</code> у PHP');
  });
  it('keeps exponent and subscript syntax in code untouched', () => {
    expect(markdownToHtml('```python\nx = y**2\nz = a^2\n```')).toBe('<pre>x = y**2\nz = a^2</pre>');
  });
  it('makes links only for http and https', () => {
    expect(markdownToHtml('[сайт](https://example.com/a?b=1&c=2)')).toBe('<a href="https://example.com/a?b=1&amp;c=2">сайт</a>');
    expect(markdownToHtml('[сайт](http://example.com)')).toBe('<a href="http://example.com">сайт</a>');
    expect(markdownToHtml('[клік](javascript:alert(1))')).toBe('[клік](javascript:alert(1))');
    expect(markdownToHtml('[файл](file:///etc/passwd)')).toBe('[файл](file:///etc/passwd)');
  });
  it('escapes a double quote in a link URL', () => {
    const out = markdownToHtml('[x](https://e.com/a"b)');
    expect(out).toBe('<a href="https://e.com/a&quot;b">x</a>');
    assertTelegramSafe(out);
  });
  it('does not apply emphasis inside a link URL', () => {
    const out = markdownToHtml('[docs](https://example.com/__init__.py)');
    expect(out).toBe('<a href="https://example.com/__init__.py">docs</a>');
    assertTelegramSafe(out);
  });
  it('does not apply italics inside a link URL with asterisks', () => {
    const out = markdownToHtml('[q](https://example.com/*a*)');
    assertTelegramSafe(out);
    expect(out).toBe('<a href="https://example.com/*a*">q</a>');
  });
  it('flattens table rows with " · " and drops separator rows', () => {
    const md = '| Дата | Подія |\n|------|:-----:|\n| 1 вересня | **Початок** |';
    expect(markdownToHtml(md)).toBe('Дата · Подія\n1 вересня · <b>Початок</b>');
  });
  it('handles tables without outer pipes in the separator row', () => {
    expect(markdownToHtml('| a | b |\n--- | ---\n| 1 | 2 |')).toBe('a · b\n1 · 2');
  });
  it('turns a blockquote into italic text', () => {
    expect(markdownToHtml('> цитата *тут*')).toBe('<i>цитата тут</i>');
  });
  it('turns a plain blockquote into italic text', () => {
    expect(markdownToHtml('> цитата')).toBe('<i>цитата</i>');
  });
  it('turns horizontal rules into blank lines and collapses extra blank lines', () => {
    expect(markdownToHtml('а\n\n---\n\n***\n\nб')).toBe('а\n\nб');
  });
  it('normalizes CRLF line endings', () => {
    expect(markdownToHtml('а\r\nб\rв')).toBe('а\nб\nв');
  });
  it('applies LaTeX conversion', () => {
    expect(markdownToHtml('Площа: $S = \\pi r^2$')).toBe('Площа: S = π r²');
  });
  it('escapes "<script>" and "&" in plain text', () => {
    const out = markdownToHtml('<script>alert(1)</script> & <b>не жирний</b>');
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &lt;b&gt;не жирний&lt;/b&gt;');
    assertTelegramSafe(out);
  });
  it('escapes HTML in headers, bullets, tables and quotes', () => {
    const out = markdownToHtml('# <img src=x>\n- <u onclick=1>\n| <a> | & |\n> <i>');
    assertTelegramSafe(out);
    expect(out).not.toContain('<img');
    expect(out).not.toContain('onclick=1>');
  });

  describe('output safety', () => {
    const samples = [
      '# Заголовок\n\nТекст з **жирним**, *курсивом* і `кодом`.\n\n- пункт 1\n- пункт **2**\n\n| a | b |\n|---|---|\n| 1 | 2 |',
      '**жирний *вкладений курсив* кінець**',
      '*курсив **жирний** курсив*',
      '1 < 2 and 3 > 2 & more',
      '```\n<b>не тег</b>\n```\n<b>тег</b>',
      '[a](https://x.com) [b](https://y.com?q=1&r=2) <a href="x">z</a>',
      '**незакритий жирний',
      '*незакритий курсив',
      '`незакритий код',
      '~~перекреслений **жирний~~ текст**',
      '> цитата з `кодом` і **жирним**',
      '__a__ __ b __ **  c  **',
      '<<>> &&& &amp; &lt;',
    ];
    for (const [i, md] of samples.entries()) {
      it(`produces balanced Telegram-safe HTML for sample ${i + 1}`, () => {
        assertTelegramSafe(markdownToHtml(md));
      });
    }

    it('stays balanced when bold and italic overlap', () => {
      assertTelegramSafe(markdownToHtml('**a *b** c*'));
    });
    it('stays balanced when italic overlaps a link', () => {
      assertTelegramSafe(markdownToHtml('[a *b](https://x.com) c*'));
    });
    it('stays balanced when bold overlaps strikethrough', () => {
      assertTelegramSafe(markdownToHtml('**a ~~b** c~~'));
    });
  });
});

describe('htmlToPlain', () => {
  it('strips tags and decodes the entities escapeHtml produces', () => {
    expect(htmlToPlain('<b>Вага</b> &lt;5 &amp; &gt;2 &quot;ок&quot;')).toBe('Вага <5 & >2 "ок"');
  });
  it('strips links but keeps their text', () => {
    expect(htmlToPlain('<a href="https://x.com/?a=1&amp;b=2">сайт</a>')).toBe('сайт');
  });
  it('does not double-decode', () => {
    expect(htmlToPlain('&amp;lt;')).toBe('&lt;');
  });
  it('does not treat escaped angle brackets as tags', () => {
    expect(htmlToPlain('&lt;b&gt;текст&lt;/b&gt;')).toBe('<b>текст</b>');
  });
  it('round-trips markdownToHtml output to the visible text', () => {
    expect(htmlToPlain(markdownToHtml('**a** < b & `c`'))).toBe('a < b & c');
  });
});

describe('splitText', () => {
  it('returns one chunk for short text', () => {
    expect(splitText('привіт', 100)).toEqual(['привіт']);
  });
  it('returns no chunks for blank text', () => {
    expect(splitText('  \n ', 100)).toEqual([]);
  });
  it('never produces a chunk longer than the limit', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Речення номер ${i} про навчання.`).join(' ');
    const chunks = splitText(text, 200);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
  });
  it('prefers paragraph boundaries', () => {
    const p1 = 'а'.repeat(60);
    const p2 = 'б'.repeat(60);
    const p3 = 'в'.repeat(60);
    expect(splitText(`${p1}\n\n${p2}\n\n${p3}`, 130)).toEqual([`${p1}\n\n${p2}`, p3]);
  });
  it('falls back to a line break when there is no paragraph break', () => {
    const l1 = 'а'.repeat(60);
    const l2 = 'б'.repeat(60);
    const l3 = 'в'.repeat(60);
    expect(splitText(`${l1}\n${l2}\n${l3}`, 130)).toEqual([`${l1}\n${l2}`, l3]);
  });
  it('falls back to a space, then to a hard cut', () => {
    expect(splitText(`${'а'.repeat(50)} ${'б'.repeat(50)}`, 60)).toEqual(['а'.repeat(50), 'б'.repeat(50)]);
    expect(splitText('x'.repeat(250), 100)).toEqual(['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(50)]);
  });
  it('ignores a paragraph break that is too early in the window', () => {
    const text = `ab\n\n${'в'.repeat(30)} ${'г'.repeat(30)}`;
    const chunks = splitText(text, 50);
    expect(chunks[0].length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(50);
  });
  it('loses no words when splitting', () => {
    const words = Array.from({ length: 300 }, (_, i) => `слово${i}`);
    const chunks = splitText(words.join(' '), 120);
    expect(chunks.join(' ').split(/\s+/)).toEqual(words);
  });
  it('uses 3500 as the default limit', () => {
    const chunks = splitText('а '.repeat(3000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(3500);
  });
  it('does not cut a surrogate pair in two', () => {
    const chunks = splitText('😀'.repeat(101), 99);
    for (const c of chunks) {
      expect(c.isWellFormed(), 'chunk contains a lone surrogate').toBe(true);
    }
  });
});

describe('truncate', () => {
  it('returns short strings trimmed', () => {
    expect(truncate('  abc  ', 10)).toBe('abc');
  });
  it('adds an ellipsis and stays within max', () => {
    const t = truncate('abcdefghij', 5);
    expect(t).toBe('abcd…');
    expect(t.length).toBe(5);
  });
  it('keeps a string exactly at max', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
  });
  it('trims trailing whitespace before the ellipsis', () => {
    expect(truncate('abc defgh', 5)).toBe('abc…');
  });
});

describe('extractJson', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('unwraps a fenced block with and without the language tag', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```JSON\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('finds JSON surrounded by prose', () => {
    expect(extractJson('Ось відповідь: {"a":[1,2]} Сподіваюсь, допомогло.')).toEqual({ a: [1, 2] });
  });
  it('forgives trailing commas', () => {
    expect(extractJson('{"a":[1,2,],"b":{"c":1,},}')).toEqual({ a: [1, 2], b: { c: 1 } });
  });
  it('parses top-level arrays', () => {
    expect(extractJson('[1, 2, 3]')).toEqual([1, 2, 3]);
    expect(extractJson('Список: [{"a":1},{"a":2},] кінець')).toEqual([{ a: 1 }, { a: 2 }]);
  });
  it('returns undefined when there is no JSON', () => {
    expect(extractJson('просто текст')).toBeUndefined();
    expect(extractJson('')).toBeUndefined();
  });
  it('returns undefined for broken JSON', () => {
    expect(extractJson('{"a": 1')).toBeUndefined();
    expect(extractJson('{a: 1}')).toBeUndefined();
    expect(extractJson('} {')).toBeUndefined();
  });
  it('keeps braces inside strings', () => {
    expect(extractJson('{"t":"a } b { c"}')).toEqual({ t: 'a } b { c' });
  });
  it('finds the object when the prose before it contains square brackets', () => {
    expect(extractJson('Ось тест [JSON]: {"a":1}')).toEqual({ a: 1 });
  });
  it('finds the object when the prose before it contains a bracketed number', () => {
    expect(extractJson('Дивись [1]: {"a":1}')).toEqual({ a: 1 });
  });
  it('finds the object when the prose before it contains braces', () => {
    expect(extractJson('Формат {json} такий: {"a":1}')).toEqual({ a: 1 });
  });
});

describe('workersAiText', () => {
  it('reads {response: string}', () => {
    expect(workersAiText({ response: 'привіт' })).toBe('привіт');
  });
  it('serializes {response: object}', () => {
    expect(workersAiText({ response: { a: 1 } })).toBe('{"a":1}');
  });
  it('reads {choices: [...]} with string content', () => {
    expect(workersAiText({ choices: [{ message: { content: 'так' } }] })).toBe('так');
  });
  it('reads {choices: [...]} with content parts', () => {
    expect(workersAiText({ choices: [{ message: { content: [{ type: 'text', text: 'а' }, { type: 'text', text: 'б' }] } }] })).toBe('аб');
  });
  it('reads Responses-style output and skips reasoning items', () => {
    const result = {
      output: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'думаю...' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'відповідь' }] },
      ],
    };
    expect(workersAiText(result)).toBe('відповідь');
  });
  it('joins several message items', () => {
    const result = {
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'а' }] },
        { type: 'message', content: [{ type: 'output_text', text: 'б' }] },
      ],
    };
    expect(workersAiText(result)).toBe('аб');
  });
  it('accepts a plain string', () => {
    expect(workersAiText('текст')).toBe('текст');
  });
  it('returns an empty string for unknown shapes', () => {
    expect(workersAiText(null)).toBe('');
    expect(workersAiText(undefined)).toBe('');
    expect(workersAiText(42)).toBe('');
    expect(workersAiText({})).toBe('');
    expect(workersAiText({ choices: [] })).toBe('');
  });
});

/** Фальшивий провайдер: записує виклики й повертає заданий результат. */
function fakeProvider(id: string, result: string | Error, vision = false): Provider & { calls: AiRequest[] } {
  const calls: AiRequest[] = [];
  return {
    id,
    vision,
    calls,
    async complete(req) {
      calls.push(req);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const ENV = { DB: undefined } as unknown as AppEnv;
const REQ: AiRequest = { messages: [{ role: 'user', content: 'привіт' }] };
const IMAGE_REQ: AiRequest = {
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'що на фото?' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
      ],
    },
  ],
};

describe('complete', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the first provider that answers', async () => {
    const a = fakeProvider('a', 'перша');
    const b = fakeProvider('b', 'друга');
    expect(await complete(ENV, REQ, { providers: [a, b] })).toEqual({ text: 'перша', provider: 'a' });
    expect(b.calls).toHaveLength(0);
  });

  it('falls back to the next provider on error', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = fakeProvider('a', new ProviderError('HTTP 429', 429));
    const b = fakeProvider('b', 'друга');
    expect(await complete(ENV, REQ, { providers: [a, b] })).toEqual({ text: 'друга', provider: 'b' });
    expect(a.calls).toHaveLength(1);
  });

  it('falls back when a provider throws a non-Error value', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bad: Provider = {
      id: 'bad',
      vision: false,
      async complete() {
        throw 'рядок';
      },
    };
    const b = fakeProvider('b', 'ок');
    expect((await complete(ENV, REQ, { providers: [bad, b] })).provider).toBe('b');
  });

  it('respects accept() and tries the next provider when the answer is rejected', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = fakeProvider('a', 'погано');
    const b = fakeProvider('b', 'добре');
    const res = await complete(ENV, REQ, { providers: [a, b], accept: (t) => t === 'добре' });
    expect(res).toEqual({ text: 'добре', provider: 'b' });
  });

  it('reports a rejected answer in the attempts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = fakeProvider('a', 'погано');
    const err = await complete(ENV, REQ, { providers: [a], accept: () => false }).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.attempts).toEqual(['a: unusable answer: погано']);
  });

  it('throws AiUnavailableError listing every failed attempt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = fakeProvider('a', new ProviderError('HTTP 500 boom', 500));
    const b = fakeProvider('b', new Error('network down'));
    const err = await complete(ENV, REQ, { providers: [a, b] }).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.attempts).toEqual(['a: HTTP 500 boom', 'b: network down']);
    expect(err.message).toBe('AI unavailable: a: HTTP 500 boom | b: network down');
  });

  it('throws a "not configured" error when there are no providers', async () => {
    const err = await complete(ENV, REQ, { providers: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.attempts).toEqual([]);
    expect(err.message).toBe('AI providers are not configured');
  });

  it('skips non-vision providers for messages with images', async () => {
    const text = fakeProvider('text', 'без фото', false);
    const vis = fakeProvider('vis', 'з фото', true);
    const res = await complete(ENV, IMAGE_REQ, { providers: [text, vis] });
    expect(res).toEqual({ text: 'з фото', provider: 'vis' });
    expect(text.calls).toHaveLength(0);
  });

  it('uses non-vision providers for text-only messages', async () => {
    const text = fakeProvider('text', 'ок', false);
    const vis = fakeProvider('vis', 'ні', true);
    expect((await complete(ENV, REQ, { providers: [text, vis] })).provider).toBe('text');
  });

  it('fails without calling anyone when an image needs vision and none is available', async () => {
    const text = fakeProvider('text', 'ок', false);
    const err = await complete(ENV, IMAGE_REQ, { providers: [text] }).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.attempts).toEqual([]);
    expect(text.calls).toHaveLength(0);
  });

  it('does not start a provider when less than 2.5 seconds of budget remain', async () => {
    const a = fakeProvider('a', 'ок');
    const err = await complete(ENV, REQ, { providers: [a], budgetMs: 2000 }).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.attempts).toEqual(['a: skipped, out of time']);
    expect(a.calls).toHaveLength(0);
  });

  it('aborts a hanging provider at the end of the budget and reports a timeout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hang: Provider = {
      id: 'hang',
      vision: false,
      complete: (_req, signal) =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    const err = await complete(ENV, REQ, { providers: [hang], budgetMs: 2600 }).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.attempts).toEqual(['hang: timeout']);
  });

  it('builds providers from the environment when none are passed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ choices: [{ message: { content: 'з оточення' } }] }));
    const env = { GROQ_API_KEY: 'k', AI_PROVIDERS: 'groq', GROQ_MODELS: 'm1', GROQ_BASE_URL: 'https://groq.test/v1' } as unknown as AppEnv;
    expect(await complete(env, REQ)).toEqual({ text: 'з оточення', provider: 'groq:m1' });
  });
});

describe('completeJson', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks for JSON and returns the parsed value from the first provider that validates', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = fakeProvider('a', 'це не JSON');
    const b = fakeProvider('b', '```json\n{"n": 5,}\n```');
    const res = await completeJson(ENV, REQ, (v) => (typeof (v as { n?: unknown } | undefined)?.n === 'number' ? (v as { n: number }) : null), {
      providers: [a, b],
    });
    expect(res).toEqual({ data: { n: 5 }, provider: 'b' });
    expect(a.calls[0].json).toBe(true);
  });

  it('throws AiUnavailableError when no answer validates', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = fakeProvider('a', '{"x":1}');
    const err = await completeJson(ENV, REQ, () => null, { providers: [a] }).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
  });
});

describe('providersFromEnv', () => {
  const mk = (o: Record<string, unknown>) => ({ ...o }) as unknown as AppEnv;

  it('returns no providers for an empty environment', () => {
    expect(providersFromEnv(mk({ AI_PROVIDERS: 'groq' }))).toEqual([]);
  });

  it('builds providers in AI_PROVIDERS order', () => {
    const ids = providersFromEnv(
      mk({
        AI_PROVIDERS: 'custom, gemini ,groq',
        GROQ_API_KEY: 'g',
        GROQ_MODELS: 'llama-x',
        GEMINI_API_KEY: 'm',
        GEMINI_MODELS: 'gem-1',
        CUSTOM_AI_API_KEY: 'c',
        CUSTOM_AI_BASE_URL: 'https://c.test/v1',
        CUSTOM_AI_MODELS: 'cm-1,cm-2',
      }),
    ).map((p) => p.id);
    expect(ids).toEqual(['custom:cm-1', 'custom:cm-2', 'gemini:gem-1', 'groq:llama-x']);
  });

  it('skips providers whose key is missing', () => {
    const ids = providersFromEnv(mk({ AI_PROVIDERS: 'groq,gemini,custom', GEMINI_API_KEY: 'm', GEMINI_MODELS: 'gem-1', CUSTOM_AI_API_KEY: 'c' })).map((p) => p.id);
    expect(ids).toEqual(['gemini:gem-1']);
  });

  it('ignores unknown provider names', () => {
    expect(providersFromEnv(mk({ AI_PROVIDERS: 'foo,bar', GROQ_API_KEY: 'g' }))).toEqual([]);
  });

  it('uses the default order and default Groq models when nothing is configured', () => {
    const ids = providersFromEnv(mk({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'm' })).map((p) => p.id);
    expect(ids).toEqual(['groq:openai/gpt-oss-120b', 'groq:openai/gpt-oss-20b', 'gemini:gemini-3.5-flash-lite']);
  });

  it('adds a vision provider after the text models when GROQ_VISION_MODEL is set', () => {
    const ps = providersFromEnv(mk({ AI_PROVIDERS: 'groq', GROQ_API_KEY: 'g', GROQ_MODELS: 'm1', GROQ_VISION_MODEL: ' vis-1 ' }));
    expect(ps.map((p) => [p.id, p.vision])).toEqual([
      ['groq:m1', false],
      ['groq:vis-1', true],
    ]);
  });

  it('marks gemini as vision and custom as vision only when CUSTOM_AI_VISION is on', () => {
    const base = { AI_PROVIDERS: 'custom', CUSTOM_AI_API_KEY: 'c', CUSTOM_AI_BASE_URL: 'https://c.test', CUSTOM_AI_MODELS: 'x' };
    expect(providersFromEnv(mk(base))[0].vision).toBe(false);
    expect(providersFromEnv(mk({ ...base, CUSTOM_AI_VISION: '1' }))[0].vision).toBe(true);
    expect(providersFromEnv(mk({ ...base, CUSTOM_AI_VISION: 'true' }))[0].vision).toBe(true);
    expect(providersFromEnv(mk({ ...base, CUSTOM_AI_VISION: '0' }))[0].vision).toBe(false);
    expect(providersFromEnv(mk({ AI_PROVIDERS: 'gemini', GEMINI_API_KEY: 'm' }))[0].vision).toBe(true);
  });

  it('adds the Workers AI provider only when the binding exists', async () => {
    expect(providersFromEnv(mk({ AI_PROVIDERS: 'workers' }))).toEqual([]);
    const run = vi.fn(async () => ({ response: 'від workers' }));
    const ps = providersFromEnv(mk({ AI_PROVIDERS: 'workers', AI: { run }, WORKERS_AI_MODEL: '@cf/test/model' }));
    expect(ps.map((p) => p.id)).toEqual(['workers:@cf/test/model']);
    expect(await ps[0].complete({ messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 }, new AbortController().signal)).toBe('від workers');
    expect(run).toHaveBeenCalledWith('@cf/test/model', expect.objectContaining({ max_tokens: 50 }));
  });

  describe('request bodies', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    async function bodyFor(envVars: Record<string, unknown>, json = false) {
      const bodies: Array<Record<string, any>> = [];
      const urls: string[] = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(input));
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ choices: [{ message: { content: 'ok' } }] });
      });
      const [p] = providersFromEnv(mk(envVars));
      await p.complete({ messages: [{ role: 'user', content: 'q' }], json }, new AbortController().signal);
      return { body: bodies[0], url: urls[0] };
    }

    it('sends reasoning_effort for Groq gpt-oss models only', async () => {
      const oss = await bodyFor({ AI_PROVIDERS: 'groq', GROQ_API_KEY: 'g', GROQ_MODELS: 'openai/gpt-oss-120b' });
      expect(oss.body.reasoning_effort).toBe('low');
      const other = await bodyFor({ AI_PROVIDERS: 'groq', GROQ_API_KEY: 'g', GROQ_MODELS: 'llama-3.3-70b' });
      expect(other.body).not.toHaveProperty('reasoning_effort');
    });

    it('asks Groq for a JSON object but not Gemini or custom', async () => {
      const groq = await bodyFor({ AI_PROVIDERS: 'groq', GROQ_API_KEY: 'g', GROQ_MODELS: 'm' }, true);
      expect(groq.body.response_format).toEqual({ type: 'json_object' });
      const gem = await bodyFor({ AI_PROVIDERS: 'gemini', GEMINI_API_KEY: 'k', GEMINI_MODELS: 'm' }, true);
      expect(gem.body).not.toHaveProperty('response_format');
      const custom = await bodyFor(
        { AI_PROVIDERS: 'custom', CUSTOM_AI_API_KEY: 'k', CUSTOM_AI_BASE_URL: 'https://c.test/v1', CUSTOM_AI_MODELS: 'm' },
        true,
      );
      expect(custom.body).not.toHaveProperty('response_format');
    });

    it('does not ask for a JSON object when JSON was not requested', async () => {
      const r = await bodyFor({ AI_PROVIDERS: 'groq', GROQ_API_KEY: 'g', GROQ_MODELS: 'm' }, false);
      expect(r.body).not.toHaveProperty('response_format');
    });

    it('uses the real Groq URL unless GROQ_BASE_URL overrides it', async () => {
      const real = await bodyFor({ AI_PROVIDERS: 'groq', GROQ_API_KEY: 'g', GROQ_MODELS: 'm' });
      expect(real.url).toBe('https://api.groq.com/openai/v1/chat/completions');
      const test = await bodyFor({ AI_PROVIDERS: 'groq', GROQ_API_KEY: 'g', GROQ_MODELS: 'm', GROQ_BASE_URL: 'https://groq.test/openai/v1' });
      expect(test.url).toBe('https://groq.test/openai/v1/chat/completions');
    });
  });
});

describe('openAiCompatible', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const cfg = {
    id: 'x:model',
    baseUrl: 'https://ai.test/v1///',
    apiKey: 'secret',
    model: 'model',
    vision: false,
    jsonObject: true,
  };
  const msgs: AiRequest = { messages: [{ role: 'user', content: 'q' }], json: true };
  const signal = () => new AbortController().signal;

  function stub(...responses: Array<() => Response>) {
    const calls: Array<{ url: string; init: RequestInit; body: Record<string, any> }> = [];
    let i = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {}, body: JSON.parse(String(init?.body)) });
      const make = responses[Math.min(i++, responses.length - 1)];
      return make();
    });
    return calls;
  }
  const ok = (content: unknown = 'відповідь') => () => Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] });

  it('posts to /chat/completions with bearer auth and returns trimmed text', async () => {
    const calls = stub(ok('  привіт \n'));
    const text = await openAiCompatible(cfg).complete({ messages: msgs.messages, maxTokens: 77, temperature: 0.1 }, signal());
    expect(text).toBe('привіт');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://ai.test/v1/chat/completions');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer secret');
    expect(calls[0].body).toMatchObject({ model: 'model', max_tokens: 77, temperature: 0.1 });
  });

  it('uses default max_tokens and temperature', async () => {
    const calls = stub(ok());
    await openAiCompatible(cfg).complete({ messages: msgs.messages }, signal());
    expect(calls[0].body).toMatchObject({ max_tokens: 1200, temperature: 0.5 });
  });

  it('reads content given as an array of parts', async () => {
    stub(ok([{ type: 'text', text: 'а' }, { type: 'text', text: 'б' }]));
    expect(await openAiCompatible(cfg).complete(msgs, signal())).toBe('аб');
  });

  it('retries once without response_format and extra fields on HTTP 400', async () => {
    const calls = stub(() => new Response('bad request', { status: 400 }), ok('після повтору'));
    const text = await openAiCompatible({ ...cfg, extra: { reasoning_effort: 'low' } }).complete(msgs, signal());
    expect(text).toBe('після повтору');
    expect(calls).toHaveLength(2);
    expect(calls[0].body.response_format).toEqual({ type: 'json_object' });
    expect(calls[0].body.reasoning_effort).toBe('low');
    expect(calls[1].body).not.toHaveProperty('response_format');
    expect(calls[1].body).not.toHaveProperty('reasoning_effort');
    expect(calls[1].body).toMatchObject({ model: 'model', messages: msgs.messages });
  });

  it('retries on HTTP 400 when only response_format was sent', async () => {
    const calls = stub(() => new Response('no', { status: 400 }), ok());
    await openAiCompatible(cfg).complete(msgs, signal());
    expect(calls).toHaveLength(2);
  });

  it('retries on HTTP 400 when only extra fields were sent', async () => {
    const calls = stub(() => new Response('no', { status: 400 }), ok());
    await openAiCompatible({ ...cfg, extra: { reasoning_effort: 'low' } }).complete({ messages: msgs.messages }, signal());
    expect(calls).toHaveLength(2);
    expect(calls[1].body).not.toHaveProperty('reasoning_effort');
  });

  it('does not retry on HTTP 400 when there is nothing to strip', async () => {
    const calls = stub(() => new Response('plain bad request', { status: 400 }));
    const err = await openAiCompatible({ ...cfg, jsonObject: false }).complete(msgs, signal()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('retries only once when the second answer is also 400', async () => {
    const calls = stub(() => new Response('still bad', { status: 400 }));
    const err = await openAiCompatible(cfg).complete(msgs, signal()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('still bad');
    expect(calls).toHaveLength(2);
  });

  it('maps a non-OK status to ProviderError with status and truncated detail', async () => {
    stub(() => new Response('x'.repeat(1000), { status: 429 }));
    const err = await openAiCompatible(cfg).complete(msgs, signal()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(429);
    expect(err.message.startsWith('HTTP 429 ')).toBe(true);
    expect(err.message.length).toBeLessThanOrEqual('HTTP 429 '.length + 300);
  });

  it('maps a 500 to ProviderError with status 500', async () => {
    stub(() => new Response('oops', { status: 500 }));
    const err = await openAiCompatible(cfg).complete(msgs, signal()).catch((e) => e);
    expect(err.status).toBe(500);
  });

  it('treats empty content as an error and reports finish_reason', async () => {
    stub(() => Response.json({ choices: [{ message: { content: '   ' }, finish_reason: 'length' }] }));
    const err = await openAiCompatible(cfg).complete(msgs, signal()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe('empty answer (finish_reason: length)');
    expect(err.status).toBeUndefined();
  });

  it('treats a response without choices as an empty answer', async () => {
    stub(() => Response.json({}));
    const err = await openAiCompatible(cfg).complete(msgs, signal()).catch((e) => e);
    expect(err.message).toBe('empty answer (finish_reason: n/a)');
  });

  it('treats null content as an empty answer', async () => {
    stub(ok(null));
    const err = await openAiCompatible(cfg).complete(msgs, signal()).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
  });

  it('passes the abort signal to fetch', async () => {
    const calls = stub(ok());
    const s = signal();
    await openAiCompatible(cfg).complete(msgs, s);
    expect(calls[0].init.signal).toBe(s);
  });
});

describe('parseQuiz', () => {
  const q = (over: Record<string, unknown> = {}) => ({ q: 'Столиця України?', options: ['Київ', 'Львів', 'Одеса', 'Харків'], correct: 0, explain: 'Київ.', ...over });

  it('accepts a valid quiz', () => {
    expect(parseQuiz({ title: 'Географія', questions: [q()] })).toEqual({
      title: 'Географія',
      questions: [{ q: 'Столиця України?', options: ['Київ', 'Львів', 'Одеса', 'Харків'], correct: 0, explain: 'Київ.' }],
    });
  });
  it('rejects non-objects and missing questions', () => {
    expect(parseQuiz(null)).toBeNull();
    expect(parseQuiz([q()])).toBeNull();
    expect(parseQuiz('x')).toBeNull();
    expect(parseQuiz({ title: 'x' })).toBeNull();
    expect(parseQuiz({ questions: [] })).toBeNull();
  });
  it('defaults the title and truncates it to 60', () => {
    expect(parseQuiz({ questions: [q()] })?.title).toBe('Тест');
    const t = parseQuiz({ title: 'т'.repeat(100), questions: [q()] })!.title;
    expect(t).toHaveLength(60);
    expect(t.endsWith('…')).toBe(true);
  });
  it('drops invalid questions and keeps valid ones', () => {
    const res = parseQuiz({
      questions: [
        q({ q: 'добре' }),
        null,
        'рядок',
        q({ q: '' }),
        q({ options: 'не масив' }),
        q({ options: ['одна'] }),
        q({ options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }),
        q({ options: ['a', '', 'c'] }),
        q({ correct: 4 }),
        q({ correct: -1 }),
        q({ correct: 1.5 }),
        q({ correct: 'A' }),
        q({ correct: undefined }),
      ],
    });
    expect(res?.questions.map((x) => x.q)).toEqual(['добре']);
  });
  it('returns null when every question is invalid', () => {
    expect(parseQuiz({ questions: [q({ correct: 9 })] })).toBeNull();
  });
  it('accepts "correct" as a numeric string and the last valid index', () => {
    expect(parseQuiz({ questions: [q({ correct: '2' })] })?.questions[0].correct).toBe(2);
    expect(parseQuiz({ questions: [q({ correct: 3 })] })?.questions[0].correct).toBe(3);
  });
  it('does not turn a missing answer key into option 0', () => {
    expect(parseQuiz({ questions: [q({ correct: null })] })).toBeNull();
    expect(parseQuiz({ questions: [q({ correct: '' })] })).toBeNull();
  });
  it('accepts 2 to 6 options', () => {
    expect(parseQuiz({ questions: [q({ options: ['так', 'ні'], correct: 1 })] })?.questions[0].options).toEqual(['так', 'ні']);
    expect(parseQuiz({ questions: [q({ options: ['1', '2', '3', '4', '5', '6'], correct: 5 })] })).not.toBeNull();
  });
  it('strips letter and digit prefixes from options', () => {
    const res = parseQuiz({ questions: [q({ options: ['A) Київ', 'B. Львів', 'В) Одеса', '4. Харків'] })] });
    expect(res?.questions[0].options).toEqual(['Київ', 'Львів', 'Одеса', 'Харків']);
  });
  it('does not strip words that merely start with a letter', () => {
    const res = parseQuiz({ questions: [q({ options: ['Аргон', 'Бор', 'Вода', 'Гелій'] })] });
    expect(res?.questions[0].options).toEqual(['Аргон', 'Бор', 'Вода', 'Гелій']);
  });
  it('truncates question to 300, option to 100 and explanation to 200', () => {
    const res = parseQuiz({ questions: [q({ q: 'п'.repeat(500), options: ['в'.repeat(300), 'г'.repeat(300)], correct: 0, explain: 'е'.repeat(500) })] })!;
    expect(res.questions[0].q).toHaveLength(300);
    expect(res.questions[0].options.every((o) => o.length === 100)).toBe(true);
    expect(res.questions[0].explain).toHaveLength(200);
    expect(res.questions[0].q.endsWith('…')).toBe(true);
  });
  it('limits the explanation to two line breaks', () => {
    const res = parseQuiz({ questions: [q({ explain: 'а\nб\nв\nг\nд' })] })!;
    const e = res.questions[0].explain;
    expect(e.split('\n').length - 1).toBeLessThanOrEqual(2);
    expect(e.split(/\s+/)).toEqual(['а', 'б', 'в', 'г', 'д']);
  });
  it('keeps an explanation that already has two line breaks', () => {
    expect(parseQuiz({ questions: [q({ explain: 'а\nб\nв' })] })!.questions[0].explain).toBe('а\nб\nв');
  });
  it('rejects a question with duplicate options, ignoring case', () => {
    expect(parseQuiz({ questions: [q({ options: ['Київ', 'київ', 'Львів'] })] })).toBeNull();
  });
  it('rejects options that become duplicates after prefix stripping', () => {
    expect(parseQuiz({ questions: [q({ options: ['A) так', 'B) так'] })] })).toBeNull();
  });
  it('accepts alternative key names question and explanation', () => {
    const res = parseQuiz({ questions: [{ question: 'Питання?', options: ['а', 'б'], correct: 1, explanation: 'Бо так.' }] });
    expect(res?.questions[0]).toEqual({ q: 'Питання?', options: ['а', 'б'], correct: 1, explain: 'Бо так.' });
  });
  it('accepts numeric options and an absent explanation', () => {
    const res = parseQuiz({ questions: [{ q: '2+2?', options: [3, 4], correct: 1 }] });
    expect(res?.questions[0].options).toEqual(['3', '4']);
    expect(res?.questions[0].explain).toBe('');
  });
  it('keeps at most 10 questions', () => {
    const questions = Array.from({ length: 14 }, (_, i) => q({ q: `Питання ${i}` }));
    expect(parseQuiz({ questions })?.questions).toHaveLength(10);
  });
});

describe('parseSplit', () => {
  it('accepts a valid split', () => {
    expect(
      parseSplit({
        title: 'Реферат',
        steps: [
          { text: 'Знайти джерела', minutes: 30 },
          { text: 'Написати план', minutes: 20.4 },
        ],
        tip: 'Починай рано',
      }),
    ).toEqual({
      title: 'Реферат',
      steps: [
        { text: 'Знайти джерела', minutes: 30 },
        { text: 'Написати план', minutes: 20 },
      ],
      tip: 'Починай рано',
    });
  });
  it('rejects non-objects, a missing steps array and fewer than two steps', () => {
    expect(parseSplit(null)).toBeNull();
    expect(parseSplit({})).toBeNull();
    expect(parseSplit({ steps: 'x' })).toBeNull();
    expect(parseSplit({ steps: [{ text: 'один' }] })).toBeNull();
    expect(parseSplit({ steps: [{ text: 'один' }, { text: '' }] })).toBeNull();
  });
  it('sets minutes to null when missing, non-positive or not numeric', () => {
    const res = parseSplit({ steps: [{ text: 'а' }, { text: 'б', minutes: 0 }, { text: 'в', minutes: -5 }, { text: 'г', minutes: 'багато' }, { text: 'д', minutes: null }] });
    expect(res?.steps.map((s) => s.minutes)).toEqual([null, null, null, null, null]);
  });
  it('accepts minutes as a numeric string', () => {
    expect(parseSplit({ steps: [{ text: 'а', minutes: '45' }, { text: 'б' }] })?.steps[0].minutes).toBe(45);
  });
  it('accepts plain string steps and the alternative "step" key', () => {
    const res = parseSplit({ steps: ['Прочитати тему', { step: 'Зробити конспект' }] });
    expect(res?.steps).toEqual([
      { text: 'Прочитати тему', minutes: null },
      { text: 'Зробити конспект', minutes: null },
    ]);
  });
  it('truncates step text to 120, title to 60 and tip to 200', () => {
    const res = parseSplit({ title: 'т'.repeat(90), steps: [{ text: 'к'.repeat(300) }, { text: 'б' }], tip: 'п'.repeat(400) })!;
    expect(res.steps[0].text).toHaveLength(120);
    expect(res.title).toHaveLength(60);
    expect(res.tip).toHaveLength(200);
  });
  it('defaults title and tip', () => {
    const res = parseSplit({ steps: ['а', 'б'] })!;
    expect(res.title).toBe('Завдання');
    expect(res.tip).toBe('');
  });
  it('keeps at most 12 steps and filters empty ones', () => {
    const steps = [{ text: '' }, ...Array.from({ length: 20 }, (_, i) => ({ text: `крок ${i}` }))];
    expect(parseSplit({ steps })?.steps).toHaveLength(11);
    expect(parseSplit({ steps: Array.from({ length: 20 }, (_, i) => `крок ${i}`) })?.steps).toHaveLength(12);
  });
});

describe('parseWeekly', () => {
  const item = (over: Record<string, unknown> = {}) => ({ day: 1, start: '16:00', end: '17:00', title: 'Математика', ...over });

  it('accepts a valid schedule and converts time to minutes', () => {
    expect(parseWeekly({ weekly: [item()], comment: 'Логіка' })).toEqual({
      items: [{ day: 1, start: 960, end: 1020, title: 'Математика' }],
      comment: 'Логіка',
    });
  });
  it('rejects non-objects, a missing list and an empty list by default', () => {
    expect(parseWeekly(null)).toBeNull();
    expect(parseWeekly([item()])).toBeNull();
    expect(parseWeekly({})).toBeNull();
    expect(parseWeekly({ weekly: 'x' })).toBeNull();
    expect(parseWeekly({ weekly: [] })).toBeNull();
  });
  it('allows an empty list when allowEmpty is set', () => {
    expect(parseWeekly({ weekly: [] }, true)).toEqual({ items: [], comment: '' });
    expect(parseWeekly({ weekly: [item({ day: 9 })] }, true)).toEqual({ items: [], comment: '' });
    expect(parseWeekly({}, true)).toBeNull();
  });
  it('accepts the alternative key "items"', () => {
    expect(parseWeekly({ items: [item()] })?.items).toHaveLength(1);
  });
  it('keeps days 1 to 7 only', () => {
    const res = parseWeekly({ weekly: [0, 1, 7, 8, -1, 2.5, 'x', null].map((day) => item({ day })) });
    expect(res?.items.map((i) => i.day)).toEqual([1, 7]);
  });
  it('accepts day as a numeric string', () => {
    expect(parseWeekly({ weekly: [item({ day: '3' })] })?.items[0].day).toBe(3);
  });
  it('validates start time', () => {
    const res = parseWeekly({ weekly: [item({ start: '25:00' }), item({ start: '10:61' }), item({ start: 'ранок' }), item({ start: null }), item({ start: '9:05' }), item({ start: '7.30' })] });
    expect(res?.items.map((i) => i.start).sort((a, b) => a - b)).toEqual([7 * 60 + 30, 9 * 60 + 5]);
  });
  it('sets end to null when it is not after start', () => {
    const res = parseWeekly({
      weekly: [
        item({ day: 1, end: '16:00' }),
        item({ day: 2, end: '15:00' }),
        item({ day: 3, end: 'пізно' }),
        item({ day: 4, end: null }),
        item({ day: 5, end: '' }),
        item({ day: 6, end: undefined }),
        item({ day: 7, end: '16:01' }),
      ],
    });
    expect(res?.items.map((i) => i.end)).toEqual([null, null, null, null, null, null, 961]);
  });
  it('drops items without a title and truncates long titles', () => {
    const res = parseWeekly({ weekly: [item({ title: '' }), item({ title: undefined }), item({ title: 'н'.repeat(200) })] });
    expect(res?.items).toHaveLength(1);
    expect(res?.items[0].title.length).toBeLessThanOrEqual(80);
  });
  it('skips malformed entries', () => {
    expect(parseWeekly({ weekly: [null, 'x', 5, [], item()] })?.items).toHaveLength(1);
  });
  it('sorts by day, then by start time', () => {
    const res = parseWeekly({
      weekly: [item({ day: 3, start: '10:00', title: 'в' }), item({ day: 1, start: '18:00', title: 'б' }), item({ day: 1, start: '08:00', title: 'а' }), item({ day: 2, start: '09:00', title: 'г' })],
    });
    expect(res?.items.map((i) => i.title)).toEqual(['а', 'б', 'г', 'в']);
  });
  it('keeps at most 30 items', () => {
    const weekly = Array.from({ length: 45 }, (_, i) => item({ day: (i % 7) + 1, title: `Урок ${i}` }));
    expect(parseWeekly({ weekly })?.items).toHaveLength(30);
  });
  it('truncates the comment to 300', () => {
    expect(parseWeekly({ weekly: [item()], comment: 'к'.repeat(500) })?.comment).toHaveLength(300);
  });
});

describe('parseDeadlineExtract', () => {
  it('accepts a full deadline', () => {
    expect(parseDeadlineExtract({ title: 'Здати реферат', date: '2026-11-03', time: '14:30' })).toEqual({
      title: 'Здати реферат',
      date: { year: 2026, month: 11, day: 3 },
      time: 14 * 60 + 30,
    });
  });
  it('returns time null when it is absent, null, empty or invalid', () => {
    for (const time of [undefined, null, '', '25:00', 'вечір']) {
      expect(parseDeadlineExtract({ title: 'а', date: '2026-11-03', time })?.time).toBeNull();
    }
  });
  it('treats an explicit or missing null date as "no date found", not as a broken answer', () => {
    expect(parseDeadlineExtract({ title: 'а', date: null })).toEqual({ title: 'А'.toLowerCase(), date: null, time: null });
    expect(parseDeadlineExtract({ title: 'а' })).toEqual({ title: 'а', date: null, time: null });
  });
  it('rejects a malformed or impossible date', () => {
    expect(parseDeadlineExtract({ title: 'а', date: '03.11.2026' })).toBeNull();
    expect(parseDeadlineExtract({ title: 'а', date: '2026-02-30' })).toBeNull();
    expect(parseDeadlineExtract({ title: 'а', date: '2026-13-01' })).toBeNull();
  });
  it('falls back to a generic title when the model gives none', () => {
    expect(parseDeadlineExtract({ title: '', date: '2026-11-03' })?.title).toBe('Дедлайн');
    expect(parseDeadlineExtract({ date: '2026-11-03' })?.title).toBe('Дедлайн');
  });
  it('rejects non-objects', () => {
    expect(parseDeadlineExtract(null)).toBeNull();
    expect(parseDeadlineExtract('2026-11-03')).toBeNull();
    expect(parseDeadlineExtract([])).toBeNull();
  });
  it('truncates the title to 100', () => {
    expect(parseDeadlineExtract({ title: 'т'.repeat(300), date: '2026-11-03' })?.title).toHaveLength(100);
  });
  it('accepts a leap day only in a leap year', () => {
    expect(parseDeadlineExtract({ title: 'а', date: '2028-02-29' })).not.toBeNull();
    expect(parseDeadlineExtract({ title: 'а', date: '2027-02-29' })).toBeNull();
  });
});

describe('prompt builders', () => {
  const sys = (msgs: Array<{ role: string; content: unknown }>) => String(msgs[0].content);

  describe('buildPlanAdvice', () => {
    const subjects = [
      { name: 'Математика', difficulty: 4, level: 2, exam: '2026-12-01', minutes: 90 },
      { name: 'Історія', minutes: 100 },
    ];
    it('includes NMT facts only for nmt plans', () => {
      expect(sys(buildPlanAdvice(true, subjects, '2026-10-25'))).toContain(NMT_FACTS);
      expect(sys(buildPlanAdvice(false, subjects, '2026-10-25'))).not.toContain('НМТ-2026');
      expect(sys(buildPlanAdvice(false, subjects, '2026-10-25'))).not.toContain(NMT_FACTS);
    });
    it('lists hours with one decimal and optional attributes', () => {
      const user = String(buildPlanAdvice(false, subjects, '2026-10-25')[1].content);
      expect(user).toBe('Сьогодні 2026-10-25.\n- Математика: 1.5 год, складність 4/5, рівень 2/5, іспит 2026-12-01\n- Історія: 1.7 год');
    });
    it('omits the exam when it is null', () => {
      const user = String(buildPlanAdvice(false, [{ name: 'Фізика', exam: null, minutes: 60 }], '2026-10-25')[1].content);
      expect(user).toContain('- Фізика: 1 год');
      expect(user).not.toContain('іспит');
    });
  });

  it('nowContext formats the current moment', () => {
    expect(nowContext({ year: 2026, month: 10, day: 25 }, 'неділя', '19:51', 'Europe/Kyiv')).toBe('Сьогодні неділя, 2026-10-25, зараз 19:51 (часовий пояс Europe/Kyiv).');
  });

  it('buildTutor keeps the history between the system prompt and the question', () => {
    const msgs = buildTutor([{ role: 'user', content: 'а' }, { role: 'assistant', content: 'б' }], 'питання');
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs[3].content).toBe('питання');
  });

  it('buildSummary and buildQuiz send plain text for text-only material', () => {
    const msgs = buildSummary({ text: 'Фотосинтез' });
    expect(typeof msgs[1].content).toBe('string');
    expect(String(msgs[1].content)).toContain('Фотосинтез');
    expect(sys(buildQuiz({ text: 'x' }, 7))).toContain('Рівно 7 питань');
  });

  it('attaches the image as a content part when the material has one', () => {
    const msgs = buildQuiz({ text: '', imageUrl: 'data:image/png;base64,AAA' }, 3);
    const parts = msgs[1].content as Array<{ type: string }>;
    expect(parts.map((p) => p.type)).toEqual(['text', 'image_url']);
  });

  it('buildSplit mentions the deadline only when given', () => {
    expect(String(buildSplit('реферат', 'зараз', '2026-11-01')[1].content)).toContain('Дедлайн: 2026-11-01.');
    expect(String(buildSplit('реферат', 'зараз', null)[1].content)).not.toContain('Дедлайн');
  });

  it('buildSchedule adds feedback only when given', () => {
    expect(String(buildSchedule('опис', 'зараз', 'менше вечорів')[1].content)).toContain('Побажання до попереднього варіанта: менше вечорів');
    expect(String(buildSchedule('опис', 'зараз', null)[1].content)).not.toContain('Побажання');
  });

  it('buildLessonExtract and buildDeadlineExtract pass the user text through', () => {
    expect(String(buildLessonExtract('пн 9:00 алгебра')[1].content)).toBe('пн 9:00 алгебра');
    expect(String(buildDeadlineExtract('здати у п\'ятницю', 'зараз')[1].content)).toContain('здати у п\'ятницю');
  });
});
