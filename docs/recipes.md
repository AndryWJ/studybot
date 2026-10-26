# Часті задачі

Короткі рецепти для того, хто вже запустив бота за [launch.md](launch.md). Після будь-якої зміни коду виконайте `npm test`, а щоб зміни побачили користувачі, `npm run deploy`.

Рецепти, що стосуються коду й локальної перевірки, перевірені тестами та `npm run e2e`. Команди, які звертаються до вашого акаунта Cloudflare, звірені з довідкою wrangler 4.152.

## Перевірити, що нічого не зламалося

```bash
npm test             # 650+ автоматичних тестів, близько 20 секунд
npm run typecheck    # перевірка типів TypeScript
npm run e2e          # бот наскрізь на локальному сервері: 12 сценаріїв
```

`npm run e2e` не потребує ні Telegram, ні ключів ШІ, ні акаунта Cloudflare: скрипт піднімає підставні сервіси й окрему локальну базу. Наприкінці друкує PASS чи FAIL для кожного сценарію.

## Погратися з ботом локально

```bash
npm run e2e -- --keep
```

Після сценаріїв сервер лишається працювати на `http://127.0.0.1:8787` з тестовими даними, доки не натиснете Ctrl+C. Сторінка налаштування: `http://127.0.0.1:8787/setup?secret=e2e_secret_0123456789`. Справжній Telegram до локального сервера не достукається: для цього потрібна публічна HTTPS-адреса, тобто `npm run deploy`.

## Змінити модель ШІ або порядок провайдерів

У `wrangler.jsonc`, розділ `vars`:

```jsonc
"AI_PROVIDERS": "groq,gemini,custom,workers",
"GROQ_MODELS": "openai/gpt-oss-120b,openai/gpt-oss-20b",
"WORKERS_AI_MODEL": "@cf/google/gemma-4-26b-a4b-it",
```

Моделі через кому пробуються по черзі; провайдер без ключа пропускається. Актуальні моделі: [console.groq.com/docs/models](https://console.groq.com/docs/models), [каталог Workers AI](https://developers.cloudflare.com/workers-ai/models/). Після зміни: `npm run deploy`.

## Підключити інший OpenAI-сумісний сервіс (наприклад, OpenRouter)

```jsonc
"CUSTOM_AI_BASE_URL": "https://openrouter.ai/api/v1",
"CUSTOM_AI_MODELS": "google/gemma-4-31b-it:free",
"CUSTOM_AI_VISION": "1",
```

```bash
npx wrangler secret put CUSTOM_AI_API_KEY
npm run deploy
```

`CUSTOM_AI_VISION` ставте лише для моделей, що розуміють зображення. Безкоштовні моделі OpenRouter часто змінюються, а без поповнення рахунку дають близько 50 запитів на добу, тож це лише запасний варіант. Список: [openrouter.ai/models](https://openrouter.ai/models).

## Зробити бота лише для своїх

```jsonc
"ALLOWED_USERS": "123456789,987654321",
```

Решта отримає відповідь, що бот приватний, і свій id, який можна передати вам. Свій id можна дізнатися в [@userinfobot](https://t.me/userinfobot). Порожній рядок відкриває бота для всіх.

## Змінити денний ліміт запитів до ШІ

```jsonc
"AI_DAILY_LIMIT": "40",
```

`0` вимикає ліміт. Ліміт рахується на кожного користувача й оновлюється о 00:00 UTC.

## Змінити, коли приходять нагадування

Правила в `reminderTimes` у `src/reminders.ts`: зараз за добу, за 2 години і в момент дедлайну, для дедлайнів "до кінця дня" напередодні о 19:00 і того ж дня о 8:00, без нагадувань з 22:00 до 8:00. Змініть, запустіть `npm test`: тест `adds a deadline from free text with reminders, no AI involved` у `test/integration/flows.test.ts` покаже нові часи, оновіть у ньому очікування. Уже створені дедлайни зберігають свої нагадування, нові правила діють для нових.

## Оновити факти про НМТ

Коли оголосять формат і дати НМТ-2027:

- текст для ШІ: `NMT_FACTS` у `src/ai/prompts.ts`;
- список предметів для кнопок: `NMT_SUBJECTS` там само;
- дата за замовчуванням (зараз найближче 20 травня): `defaultNmtDate` у `src/bot/features/plan.ts`;
- тексти з роком у `src/bot/features/plan.ts`: підказка при виборі предметів, примітка в підсумку плану й приклад дати.

Знайти всі місця з роком допоможе `grep -n "202[67]" src/ai/prompts.ts src/bot/features/plan.ts`.

## Змінити вільний час за замовчуванням

`DEFAULT_AVAILABILITY` у `src/planner.ts`, хвилини на день від понеділка до неділі. Діє для тих, хто не задавав свій вільний час у налаштуваннях.

## Додати команду

1. У `src/bot/router.ts`, функція `onCommand`, додайте `case 'назва':` з викликом свого обробника.
2. Щоб команда з'явилася в меню Telegram, додайте її в `COMMANDS` у `src/bot/ui.ts`.
3. `npm test`, `npm run deploy`, потім відкрийте `/setup?secret=...`: сторінка оновить меню команд.

## Змінити схему бази

```bash
npx wrangler d1 migrations create studybot add_notes
```

Команда створить у `migrations/` новий файл із номером. Напишіть у ньому SQL (наприклад, `ALTER TABLE users ADD COLUMN note TEXT;`), додайте поле в інтерфейс у `src/db.ts`, потім:

```bash
npm test
npm run db:migrate
npm run deploy
```

Уже застосований `0001_init.sql` не редагуйте: wrangler вдруге його не виконає.

## Подивитися логи

```bash
npm run logs
```

Показує повідомлення бота в реальному часі (помилки ШІ, збої надсилання). Ctrl+C, щоб вийти.

## Подивитися дані або зробити резервну копію

```bash
npx wrangler d1 execute studybot --remote --command "SELECT COUNT(*) AS users FROM users"
npx wrangler d1 export studybot --remote --output backup.sql
```

Файл `backup.sql` містить особисті дані учнів. Він записаний у `.gitignore`, тож у git не потрапить, але й пересилати його не варто.

## Оновити залежності

```bash
npm outdated
npm install -D wrangler@latest vitest@latest @cloudflare/vitest-plugin@latest typescript@latest
npm test && npm run typecheck && npm run e2e
```

Якщо після оновлення щось упало, поверніть попередні версії з `package-lock.json` (`git checkout package.json package-lock.json && npm install`).

## Повністю видалити бота

```bash
npx wrangler delete                 # прибрати Worker
npx wrangler d1 delete studybot     # видалити базу з усіма даними
```

Самого бота в Telegram видаляє @BotFather командою `/deletebot`.
