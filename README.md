> **R5.17.0:** каталог `/catalog`, рецепти, ціни й імена торговців, карта NPC та новий спільний стиль. Актуальні інструкції повного пакета — `../SITE_CATALOG_R5_17_UA.md`. Ця папка — лише сайт; автоматичний знімок NPC потребує оновлених джерел Guilds. Адони не компілювалися.

> **R5.15.6 SITE:** редизайн, мобільна навігація, SEO та HTTP hardening. Див. `HOMECRAFT_R5_15_6_SITE_UA.md`. Це оновлення не змінює Java-моди.

> **R5.15.3:** оновлено клієнтські JAR і додано автоматичне керування конфігураціями. Див. `HOTFIX_R5_15_3_UA.md`.

> **R5.15.2**: авторизацію виправлено після падіння при 60-секундному тайм-ауті. Див. `HOTFIX_R5_15_2_UA.md`.

# HomeCraft R5.15.6 — сайт, деплой на VPS

Сайт https://homecraft-mc.pp.ua → VPS 149.202.57.156.
Гра 51.83.184.222:25618 запускається окремо через Pterodactyl.
Цей пакет адаптовано до /srv/mc-site, контейнера mistblossom-nginx-1,
мережі mistblossom_edge, чинного bind-файла public-site.conf та named volume
на /etc/letsencrypt. Системний Nginx встановлювати не потрібно.

## Оновлення наявного HomeCraft

Не розпаковуйте ZIP поверх робочого data/config. Покладіть новий ZIP на VPS
як /srv/HomeCraft-R5.15.6-SITE.zip та виконайте:

```sh
cd /srv/mc-site
sudo python3 - /srv/HomeCraft-R5.15.6-SITE.zip <<'PY'
from pathlib import Path
import sys, zipfile
root = Path.cwd().resolve()
with zipfile.ZipFile(sys.argv[1]) as z:
    for entry in z.infolist():
        p = Path(entry.filename)
        if p.is_absolute() or '..' in p.parts:
            raise SystemExit('Небезпечний шлях у ZIP')
        if p.parts and (p.parts[0] in {'data', 'config', 'logs', 'deployment-backups'}
                       or p.name in {'.env', '.deploy.lock', 'compose.override.yaml', 'compose.override.yml'}):
            continue
        z.extract(entry, root)
PY
sh deploy.sh
```

Програмні файли оновлюються, чинні data/config/logs/.env/compose.override
не замінюються. Пакет не містить бойових акаунтів, ключів чи баз.
Старий невикористовуваний файл cloudflare/homecraft-mc.pp.ua.nginx.conf можна
видалити: новий деплой його не читає.

## Що виконує одна команда

1. Знаходить чинний Nginx, його мережу, named volume та bind-конфіг через Docker inspect.
2. Збирає образ HomeCraft до зупинки сайта; потім зупиняє тільки HomeCraft і копіює
   data/config у приватний deployment-backups. Ця копія може містити секрет — не публікуйте її.
3. Готує права UID/GID 1000:1000 через одноразовий контейнер з обмеженими додатковими
   capabilities. Робочий контейнер зберігає cap_drop: ALL.
4. Підключає HomeCraft до mistblossom_edge з alias homecraft-web. Використовує
   deployment/compose.edge.yaml; наявний compose.override.yaml з попередніх команд зберігається.
5. Чекає готовності сайта, перевіряє JSON локально й запитом із контейнера Nginx.
6. Перевіряє PEM, строк дії, домен і відповідність приватному ключу.
7. Копіює сертифікат у named volume через тимчасовий контейнер із RW-доступом.
   Сам Nginx залишається з read-only mount. Немає запису напряму у /var/lib/docker.
8. Зберігає конфіг Nginx, оновлює тільки блок BEGIN HOMECRAFT / END HOMECRAFT
   у змонтованому public-site.conf без заміни inode; повторний запуск не дублює домен.
9. Виконує nginx -t і reload без перезапуску контейнера Nginx.
   При помилці відновлює старий конфіг та попередні сертифікати й намагається зробити reload.
10. Окремо перевіряє публічний HTTPS. При помилці Cloudflare команда повертає ненульовий код
    і повідомляє, що origin уже застосовано, але публічний HTTPS не підтверджено.

Всі команди використовують той самий набір Compose-файлів і project homecraft-site.
Скрипт запитує sudo, якщо його запущено від ubuntu. Є блокування одночасного деплою.
При невдалому setup скрипт намагається підняти HomeCraft повторно, але автоматичного
відкату образа/баз немає: резервна копія data/config доступна для ручного відновлення.
Не відновлюйте бази з резервної копії під час роботи сайта.

## Сертифікат, який ви вже створили

На VPS мають бути ці непорожні файли:

- /etc/ssl/homecraft-mc.pp.ua/origin.pem — готовий сертифікат;
- /etc/ssl/homecraft-mc.pp.ua/origin.key — відповідний приватний ключ.

Деплой сам копіює їх у потрібне місце Nginx. Створювати сертифікат повторно не потрібно.
При перевипуску замініть вихідні файли й виконайте sh deploy.sh publish.
Ключі/сертифікати не включені у ZIP, не вводяться в командний рядок і не друкуються.

## Cloudflare

Зона homecraft-mc.pp.ua: A @ → 149.202.57.156, Proxied; SSL/TLS Full (strict).
Не копіюйте NS/MX/TXT іншого домену. Не ставте Access/browser challenge на серверний API.
Cache Rule: Bypass для starts_with(http.request.uri.path, "/api/").
Origin CA призначений для з'єднання Cloudflare→Nginx. Браузер перевіряє сертифікат Cloudflare.
Деплой не змінює DNS чи налаштування Cloudflare — доступу до вашого account у нього немає.

## Нова інсталяція / перенесення

Для чинного сайта збережіть увесь data, включно з characters.json, .initialized,
прихованими файлами, історією власників і всіма ресурсами. Не створюйте нову порожню базу
замість чинної. Старий HomeCraft .env перенесіть у config/site.env; .env «Лігва» не підходить.
Якщо config/site.env відсутній, setup копіює кореневий .env, інакше зберігає чинний.
Сайт генерує секрет тільки коли немає чинного валідного секрету.

Спочатку sh deploy.sh setup. Перший адміністратор реєструється через SSH port-forward:
ssh -L 3018:127.0.0.1:3018 USER@149.202.57.156
Після цього http://localhost:3018/register.html. Для перенесених даних використовуйте
наявного адміністратора. Без адміністратора publish зупиниться, не відкриваючи новий vhost.
Локальний порт залишається 127.0.0.1:3018. Контейнеру Nginx доступний homecraft-web:3000.

## Команди

- sh deploy.sh — setup та publish одним запуском;
- sh deploy.sh setup — образ, права, резервна копія, запуск HomeCraft;
- sh deploy.sh publish — сертифікат, Nginx і перевірка HTTPS;
- sh deploy.sh check — локальний API, мережа, сертифікат, nginx -t;
- sh deploy.sh status / logs / stop — тільки HomeCraft.

Після успішного HTTPS: адмінпанель → завантажити homecraft-connection.properties →
Minecraft config/ → звичайний Restart у Pterodactyl. Для NeoForge 26.3 потрібна Java 25;
цей SITE-пакет не встановлює NeoForge, Java чи ігровий server.jar.

Не видаляйте data/config і не використовуйте docker compose down -v для скидання баз.
Деплой не запускає down, не перевстановлює Nginx і не змінює Compose-проєкт «Лігва».
Під час майбутнього оновлення «Лігва» збережіть блок HOMECRAFT у public-site.conf;
якщо оновлення прибрало його — повторіть sh deploy.sh publish.

## Перевірено

Окремі ручні тести перевіряють повторний деплой без дублювання, відмову від зміни
невідомого vhost, відкат конфігурації/сертифікатів при помилці nginx -t/reload,
набір capabilities і відсутність зміни read-only mount чинного Nginx.
У цій сесії немає Docker daemon/доступу до VPS: інтеграція з реальним Nginx та
Cloudflare потребує перевірки на сервері. Тести не включені в build або deploy.
Резервні копії не видаляються автоматично — контролюйте вільне місце.


## R5.15.5
Докладніше: `HOTFIX_R5_15_5_UA.md`.
