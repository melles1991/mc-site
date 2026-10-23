'use strict';
const { publicOrigin, validSecret } = require('./site-bootstrap');
function property(value) {
  return String(value).replace(/[\\:=#! ]/g, '\\$&').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\f/g, '\\f');
}
function connectionFile(siteUrl, secret, minecraftHost) {
  if (!siteUrl) throw new Error('Спочатку задай PUBLIC_SITE_URL з адресою окремого сайту та перезапусти його.');
  const origin = publicOrigin(siteUrl);
  const host = new URL(origin).hostname;
  if (host === 'localhost' || host === '[::1]' || host === '::1' || host === '0.0.0.0' || /^127\./.test(host))
    throw new Error('Адреса localhost підходить лише для перегляду. Для Minecraft потрібна доступна адреса окремого сайту.');
  if (!minecraftHost || String(minecraftHost).length > 255 || /[\x00-\x20\x7f]/.test(String(minecraftHost)))
    throw new Error('HOMECRAFT_MC_HOST має містити адресу Minecraft без пробілів і переносів рядка.');
  if (!validSecret(secret)) throw new Error('Серверний секрет не налаштовано. Запускай сайт через npm start.');
  return '# HomeCraft separate website connection. Keep this file private.\n'
    + 'siteUrl=' + property(origin) + '\nserverSecret=' + property(secret)
    + '\nminecraftHost=' + property(minecraftHost) + '\n';
}
module.exports = { connectionFile };
