'use strict';
const os = require('os');
const port = String(process.argv[2] || process.env.PORT || 3000);
function detectLanIp() {
  const candidates = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      if (net.address.startsWith('169.254.')) continue;
      candidates.push(net.address);
    }
  }
  return candidates.find(ip => ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) || candidates[0] || 'localhost';
}
console.log(`http://${detectLanIp()}:${port}`);
