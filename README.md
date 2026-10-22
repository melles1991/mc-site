# HomeCraft R5.15 — homecraft-mc.pp.ua на VPS «Лігва друїда»

Сайт: **https://homecraft-mc.pp.ua**. VPS сайту: **149.202.57.156**
(адреса зі наданого DNS-експорту lihvodruida.pp.ua). Minecraft: **51.83.184.222:25618**.
HomeCraft має окремий Docker Compose project, папки даних і Nginx virtual host.
Поточний сайт «Лігво друїда» не потрібно переносити чи замінювати.
Пакет підготовлено для Linux VPS із Docker Engine + Compose plugin та наявним Nginx.
Якщо сервер керується Apache/Caddy або панеллю, не запускайте publish: додайте домен
і reverse proxy в цій панелі за наведеними нижче параметрами.

## 1. Cloudflare DNS

Додайте окрему зону `homecraft-mc.pp.ua` у свій Cloudflare account.
Встановіть у реєстратора nameserver саме з НОВОЇ зони. Імена austin/dina
в експорті належать старій зоні; для нової Cloudflare може призначити інші.
Дочекайтеся Active та активного Edge Certificate для нового домену.
Імпортуйте `cloudflare/homecraft-mc.pp.ua.zone` тільки в нову зону або створіть запис.
Після імпорту перевірте, що Proxy status увімкнено:

| Тип | Ім'я | Значення | Proxy |
| --- | --- | --- | --- |
| A | @ | 149.202.57.156 | Proxied, помаранчева хмарка |

Не копіюйте MX/TXT/google-verification зі старого домену й не змінюйте його DNS.
Не залишайте суперечливих AAAA/CNAME для кореня нового домену.
Підключення гри лишається без змін: 51.83.184.222:25618. Звичайний HTTP proxy
Cloudflare не проксіює цей Minecraft-порт. Порт 25587 для сайта більше не використовується.

## 2. Перенесення чинного HomeCraft без втрати персонажів

Підготуйте резервну копію, зупиніть старий HomeCraft SITE перед фінальним копіюванням.
На VPS створіть окремий каталог, наприклад `/opt/homecraft-site`, і розпакуйте пакет.
Перенесіть **увесь** старий `SITE/data`, включно з прихованими файлами, маркерами баз,
реєстром characters, резервними копіями, ресурс-паками та завантаженнями.
Не копіюйте лише users.json: історія власності/видалених ніків має зберегтися.
Старий `.env` скопіюйте у `config/site.env` (створіть config) або в корінь як `.env`:
setup перенесе його у config/site.env, тільки якщо ціль ще не існує.
Збережіть наявний SERVER_SECRET/HOMECRAFT_SERVER_SECRET. Старі абсолютні шляхи до
баз і завантажень замініть на відносні `data/...` з .env.example, зберігши самі файли.
Адресу нового сайта, Secure cookies і каталог клієнтських JAR Compose встановлює автоматично.
На ігровому сервері збережіть світ, UUID-файли та ownership ledger.
Не запускайте одночасно старий і новий HomeCraft із незалежними копіями баз.

## 3. Запуск Node.js окремо від інших сайтів

У каталозі HomeCraft на VPS виконайте `sh deploy.sh setup`.
Сайт слухає **127.0.0.1:3018** тільки на VPS; контейнер має внутрішній порт 3000.
Якщо 3018 вже зайнятий, зупиніться: змініть його одночасно у compose.yaml та Nginx-конфігурації.
Не завершуйте сторонній процес, щоб звільнити порт. Наявні конфігурації «Лігва» не змінюються.
Дані/секрет/логи лежать у `data`, `config`, `logs` поза контейнером і переживають його заміну.
Для нової інсталяції секрет генерується один раз автоматично.

Якщо це порожня інсталяція, створіть власного першого адміністратора ДО відкриття домену.
На своєму комп'ютері: `ssh -L 3018:127.0.0.1:3018 USER@149.202.57.156`.
Відкрийте `http://localhost:3018/register.html` і зареєструйте свій акаунт.
Для перенесеної бази використовуйте старого адміністратора, новий не створюється.

## 4. HTTPS origin і Nginx

У Cloudflare → SSL/TLS → Origin Server → Create Certificate створіть Origin CA
сертифікат для **homecraft-mc.pp.ua**. Збережіть на VPS:

- `/etc/ssl/homecraft-mc.pp.ua/origin.pem` — сертифікат;
- `/etc/ssl/homecraft-mc.pp.ua/origin.key` — приватний ключ, права 600.

Каталог створіть з правами 700. Приватний ключ не надсилайте у чат.
У Cloudflare → SSL/TLS → Overview оберіть **Full (strict)**. Не Flexible.
На VPS виконайте `sudo sh deploy.sh publish`.
Скрипт створює тільки новий vhost homecraft-mc.pp.ua, перевіряє nginx -t,
і лише тоді робить reload; не перезапускає і не зупиняє інші сайти.
Якщо файл нового домену вже існує, скрипт зупиняється і не перезаписує його.
При помилці nginx -t новий файл прибирається, чинний Nginx не перезавантажується.
Перегляньте конфліктні server_name у наявній конфігурації перед publish.
Origin CA довіряє Cloudflare: прямий браузерний HTTPS на IP не є перевіркою сертифіката домену.
VPS має приймати HTTP/HTTPS на 80/443; localhost:3018 відкривати у firewall не потрібно.
Альтернатива для панелі: окремий домен, TLS Origin CA, proxy на http://127.0.0.1:3018,
Host і X-Forwarded-Proto=https, ліміт body 34m; не змінювати virtual host «Лігва».

Перевірте https://homecraft-mc.pp.ua/api/health/ready (JSON 200), вхід та завантаження модів.
У Cloudflare увімкніть Always Use HTTPS. Створіть Cache Rule Bypass для
`starts_with(http.request.uri.path, "/api/")`; не застосовуйте Cache Everything до всього сайта.
Не закривайте /api/ Cloudflare Access або browser challenge: це блокує Auth/Map/Guild.

## 5. Підключення Minecraft без власного Startup

На новому домені увійдіть адміністратором → Адмінпанель → «Завантажити файл підключення».
Завантажений `homecraft-connection.properties` покладіть у Minecraft `config/` через
файловий менеджер панелі, замінивши шаблон. Файл містить секрет — не публікуйте його.
Установіть 4 серверні JAR із Minecraft-пакета, прибравши тільки їхні старі версії.
Натисніть звичайний Restart у панелі гри. Node.js та bat/sh на Minecraft-хості не потрібні.
Auth/Guild/Map читають один файл; клієнт отримує адресу https://homecraft-mc.pp.ua.
Лаунчер також має цей домен за замовчуванням; збережені користувачем налаштування
лаунчера не перезаписуються — у старому профілі змініть адресу сайта один раз.

## Оновлення та перевірки

`sh deploy.sh status`, `sh deploy.sh logs`, `sh deploy.sh stop` стосуються тільки HomeCraft.
Для наступного оновлення зупиніть HomeCraft, зробіть копію data/config, замініть програмні
файли і повторіть setup. Повторний publish не потрібний, якщо Nginx не змінювався.
Не замінюйте чинні data/config чистими папками з архіву.
Node heap 128 МіБ, контейнер 256 МіБ / до 1 CPU. Ліміт не гарантує пропускної здатності.
Для сайта на тому самому VPS слід перевірити вільну RAM/CPU з урахуванням «Лігва».
Локальні Node/Java перевірки виконано; справжній VPS, Docker, Nginx, Cloudflare
та запуск гри з цим доменом ще не перевірено. Доступу SSH/Cloudflare у цьому сеансі немає.

Документація Cloudflare:
https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/
https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/
https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/
https://developers.cloudflare.com/fundamentals/reference/network-ports/
