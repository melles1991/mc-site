#!/bin/sh
set -eu
cd -- "$(dirname -- "$0")"
mode=${1:-setup}
command -v docker >/dev/null 2>&1 || { echo "Docker Engine + Compose plugin required on 149.202.57.156." >&2; exit 1; }
docker compose version >/dev/null
case "$mode" in
 setup)
  umask 077
  mkdir -p config data logs
  if [ -f .env ] && [ ! -f config/site.env ]; then cp .env config/site.env; fi
  docker compose build site
  docker compose run --rm --no-deps --user 0:0 --entrypoint sh site -c 'chown -R 1000:1000 /app/data /app/config /app/logs && chmod 700 /app/config'
  docker compose up -d --wait site
  echo "HomeCraft ready locally: http://127.0.0.1:3018"
  echo "Migrate existing data/secret or create your first administrator BEFORE publishing. See README.md."
  echo "Then install the Cloudflare Origin Certificate and run: sudo sh deploy.sh publish"
  ;;
 publish)
  [ "$(id -u)" -eq 0 ] || { echo "Use sudo sh deploy.sh publish (Nginx configuration)." >&2; exit 1; }
  command -v nginx >/dev/null 2>&1 || { echo "Existing Nginx is required. If this VPS uses Apache/Caddy/a hosting panel, adapt its virtual host instead." >&2; exit 1; }
  [ -s /etc/ssl/homecraft-mc.pp.ua/origin.pem ] && [ -s /etc/ssl/homecraft-mc.pp.ua/origin.key ] || { echo "Install the Origin Certificate/key first; see README.md." >&2; exit 1; }
  nginx -t
  if [ -d /etc/nginx/sites-available ] && [ -d /etc/nginx/sites-enabled ]; then
    target=/etc/nginx/sites-available/homecraft-mc.pp.ua.conf
    enabled=/etc/nginx/sites-enabled/homecraft-mc.pp.ua.conf
  elif [ -d /etc/nginx/conf.d ]; then
    target=/etc/nginx/conf.d/homecraft-mc.pp.ua.conf
    enabled=$target
  else
    echo "Unknown Nginx layout. Install cloudflare/homecraft-mc.pp.ua.nginx.conf through your hosting panel." >&2; exit 1
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "HomeCraft virtual host already exists: $target. Review it manually; it was not overwritten." >&2; exit 1
  fi
  if [ "$enabled" != "$target" ] && { [ -e "$enabled" ] || [ -L "$enabled" ]; }; then
    echo "Enabled HomeCraft virtual host already exists; review manually." >&2; exit 1
  fi
  docker compose up -d --wait site
  install -m 644 cloudflare/homecraft-mc.pp.ua.nginx.conf "$target"
  if [ "$enabled" != "$target" ]; then ln -s "$target" "$enabled"; fi
  if ! nginx -t; then
    if [ "$enabled" != "$target" ]; then rm -f "$enabled"; fi
    rm -f "$target"
    echo "Nginx validation failed. The new HomeCraft virtual host was removed; existing sites were not reloaded." >&2; exit 1
  fi
  nginx -s reload
  echo "HomeCraft virtual host installed. Verify Cloudflare Full (strict), A record, and https://homecraft-mc.pp.ua/api/health/ready."
  ;;
 stop) docker compose stop ;;
 logs) docker compose logs --tail 80 ;;
 status) docker compose ps ;;
 *) echo "Usage: sh deploy.sh [setup|publish|stop|logs|status]" >&2; exit 2 ;;
esac
