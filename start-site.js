'use strict';
try {
  const { bootstrap } = require('./site-bootstrap');
  const settings = bootstrap();
  if (settings.preview) console.log('[Home Craft] Local preview only. Set PUBLIC_SITE_URL when the separate site address is ready.');
  const { server } = require('./server');
  server.on('error', error => { console.error('[Home Craft] Site failed to start: ' + error.message); process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    server.close(); server.closeIdleConnections?.();
  });
} catch (error) {
  console.error('[Home Craft] ' + error.message);
  process.exitCode = 1;
}
