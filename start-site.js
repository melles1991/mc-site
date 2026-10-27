'use strict';
try {
  // Honor common dev-server flags as well as the existing environment settings.
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--port') {
      const port = args[++i];
      if (!/^\d+$/.test(port || '') || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid --port (1–65535).');
      process.env.PORT = port;
    } else if (args[i] === '--host') {
      const host = args[++i];
      if (!host || host.startsWith('--')) throw new Error('Missing --host value.');
      process.env.HOST = host;
    } else if (args[i] !== '--strictPort') throw new Error('Unknown option: ' + args[i]);
  }
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
