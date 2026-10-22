#!/usr/bin/env python3
"""HomeCraft deployment for the observed shared Docker Nginx installation."""
import argparse
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
DOMAIN = 'homecraft-mc.pp.ua'
NGINX = 'mistblossom-nginx-1'
NETWORK = 'mistblossom_edge'
CERT_SOURCE = Path('/etc/ssl') / DOMAIN
BEGIN, END = '# BEGIN HOMECRAFT', '# END HOMECRAFT'


def run(args, capture=False, timeout=120, **kwargs):
    result = subprocess.run([str(x) for x in args], cwd=ROOT, check=True,
                            text=True, capture_output=capture, timeout=timeout, **kwargs)
    return result.stdout if capture else ''


def compose(*args, capture=False, timeout=120):
    cmd = ['docker', 'compose', '-p', 'homecraft-site', '-f', str(ROOT/'compose.yaml')]
    overrides = [ROOT/'compose.override.yaml', ROOT/'compose.override.yml']
    existing = [p for p in overrides if p.exists()]
    if len(existing) > 1:
        raise RuntimeError('Both compose.override.yaml and .yml exist; keep one explicit override.')
    if existing:
        cmd += ['-f', str(existing[0])]
    return run(cmd + ['-f', str(ROOT/'deployment/compose.edge.yaml'), *args], capture, timeout)


def info():
    data = json.loads(run(['docker', 'inspect', NGINX], True))[0]
    if not data['State']['Running']:
        raise RuntimeError('Existing Nginx container is not running.')
    if NETWORK not in data['NetworkSettings']['Networks']:
        raise RuntimeError('Existing Nginx is not on mistblossom_edge.')
    mounts = {m['Destination']: m for m in data['Mounts']}
    cert = mounts.get('/etc/letsencrypt', {})
    config = mounts.get('/etc/nginx/conf.d/public-site.conf', {})
    if cert.get('Type') != 'volume' or not cert.get('Name'):
        raise RuntimeError('Expected named volume mounted at /etc/letsencrypt.')
    if config.get('Type') != 'bind' or not Path(config.get('Source', '')).is_file():
        raise RuntimeError('Expected accessible host bind for public-site.conf. Remote Docker contexts are unsupported.')
    return data, cert['Name'], Path(config['Source'])


def health():
    with urllib.request.urlopen('http://127.0.0.1:3018/api/health/ready', timeout=10) as r:
        data = json.load(r)
        if r.status != 200 or not data.get('ready') or not data.get('ok'):
            raise RuntimeError('Local HomeCraft readiness did not return JSON ready=true.')
    response = run(['docker', 'exec', NGINX, 'wget', '-T', '10', '-qO-',
                    'http://homecraft-web:3000/api/health/ready'], True, 20)
    if not json.loads(response).get('ready'):
        raise RuntimeError('Nginx cannot reach HomeCraft through its Docker alias.')


def render(old):
    # Recognize only our previously documented managed blocks.
    if old.count(BEGIN) != old.count(END) or old.count(BEGIN) > 1:
        raise RuntimeError('Ambiguous HomeCraft markers; existing configuration was not changed.')
    clean = re.sub(r'(?ms)^# BEGIN HOMECRAFT\s*\n.*?^# END HOMECRAFT[^\n]*\n?', '', old)
    if DOMAIN in clean:
        raise RuntimeError('Unmanaged HomeCraft configuration exists; refusing to overwrite it.')
    return clean.rstrip() + '\n\n' + (ROOT/'deployment/homecraft.nginx.conf').read_text() + '\n'


def write_in_place(path, text):
    # Keep inode: the live Nginx uses an individual file bind mount.
    with path.open('w') as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())


def validate_cert():
    cert, key = CERT_SOURCE/'origin.pem', CERT_SOURCE/'origin.key'
    for p in (cert, key):
        if not p.is_file() or not p.stat().st_size:
            raise RuntimeError(f'Missing certificate/key: {p}')
    run(['openssl', 'x509', '-in', cert, '-noout', '-checkend', '86400'])
    matched = run(['openssl', 'x509', '-in', cert, '-noout', '-checkhost', DOMAIN], True)
    if f'Hostname {DOMAIN} does match certificate' not in matched:
        raise RuntimeError('Certificate does not cover homecraft-mc.pp.ua.')
    a = run(['openssl', 'x509', '-in', cert, '-pubkey', '-noout'], True)
    b = run(['openssl', 'pkey', '-in', key, '-pubout', '-passin', 'pass:'], True)
    if a.strip() != b.strip():
        raise RuntimeError('Certificate and private key do not match.')


def volume_step(data, volume, snapshot, action):
    # A dedicated temporary container mounts the same volume read-write.
    # The actual Nginx keeps its existing read-only mount.
    scripts = {
      'install': '''umask 077
mkdir -p /certs/homecraft-origin
cd /certs/homecraft-origin
mkdir "$SNAP"
for f in origin.pem origin.key; do
 if [ -e "$f" ] || [ -L "$f" ]; then
  [ ! -L "$f" ] || exit 30
  cp -p "$f" "$SNAP/$f"
 fi
done
printf ready > "$SNAP/ready"
cp /incoming/origin.pem origin.pem
cp /incoming/origin.key origin.key
chmod 700 .
chmod 644 origin.pem
chmod 600 origin.key
''',
      'restore': '''[ -d /certs/homecraft-origin ] || exit 0
cd /certs/homecraft-origin
[ -f "$SNAP/ready" ] || exit 0
for f in origin.pem origin.key; do
 if [ -f "$SNAP/$f" ]; then cp -p "$SNAP/$f" "$f"; else rm -f "$f"; fi
done
'''
    }
    run(['docker', 'run', '--rm', '--network', 'none', '--user', '0:0',
         '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
         '--mount', f'type=volume,source={volume},target=/certs',
         '--mount', f'type=bind,source={CERT_SOURCE},target=/incoming,readonly',
         '--env', f'SNAP={snapshot}', '--entrypoint', 'sh', data['Image'],
         '-ec', scripts[action]])


def setup():
    info()
    run(['docker', 'network', 'inspect', NETWORK], True)
    for name in ('data', 'config', 'logs'):
        p = ROOT/name
        if p.is_symlink():
            raise RuntimeError(f'{p} must be a dedicated HomeCraft directory, not a symlink.')
        p.mkdir(mode=0o700, exist_ok=True)
    env = ROOT/'config/site.env'
    if not env.exists() and (ROOT/'.env').exists():
        shutil.copyfile(ROOT/'.env', env)
        env.chmod(0o600)
    # Data backup is taken while this site is stopped, never another Compose project.
    compose('config', '--quiet')
    compose('build', 'site', timeout=1800)  # Build before stopping the working site.
    compose('stop', 'site')
    try:
        setup_stopped()
    except BaseException:
        print('Setup failed; attempting to restart HomeCraft. Existing data/config are not deleted.', file=sys.stderr)
        try:
            compose('up', '-d', '--wait', '--wait-timeout', '90', 'site', timeout=150)
        except Exception:
            print('HomeCraft restart failed. Run: sh deploy.sh logs', file=sys.stderr)
        raise


def setup_stopped():
    backup = ROOT/'deployment-backups'/datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup.mkdir(mode=0o700, parents=True)
    for name in ('data', 'config'):
        shutil.copytree(ROOT/name, backup/name, symlinks=True)
    compose('run', '--rm', '--no-deps', '--user', '0:0',
            '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
            '--entrypoint', 'sh', 'site', '-ec',
            'chown -R 1000:1000 /app/data /app/config /app/logs; chmod 700 /app/config')
    compose('up', '-d', '--wait', '--wait-timeout', '90', 'site', timeout=150)
    health()
    print(f'HomeCraft ready. Data/config backup: {backup}')


def publish():
    data, volume, config = info()
    validate_cert()
    health()
    users_path = ROOT/'data/users.json'
    users = json.loads(users_path.read_text()) if users_path.exists() else []
    if not isinstance(users, list) or not any(u.get('role') == 'admin' for u in users):
        raise RuntimeError('Create/restore your administrator before publishing. See README.md.')
    old = config.read_text()
    new = render(old)
    # Do not publish on top of an already invalid shared configuration.
    run(['docker', 'exec', NGINX, 'nginx', '-t'])
    stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S-%f')
    backup = ROOT/'deployment-backups'/stamp
    backup.mkdir(mode=0o700, parents=True)
    (backup/'public-site.conf').write_text(old)
    snapshot = 'backup-' + stamp
    changed = False
    try:
        changed = True  # Include partially failed certificate installation in rollback.
        volume_step(data, volume, snapshot, 'install')
        write_in_place(config, new)
        run(['docker', 'exec', NGINX, 'nginx', '-t'])
        run(['docker', 'exec', NGINX, 'nginx', '-s', 'reload'])
    except BaseException:
        if changed:
            write_in_place(config, old)
            try:
                volume_step(data, volume, snapshot, 'restore')
                run(['docker', 'exec', NGINX, 'nginx', '-t'])
                run(['docker', 'exec', NGINX, 'nginx', '-s', 'reload'])
            except Exception:
                print(f'Rollback needs attention. Original config: {backup}/public-site.conf', file=sys.stderr)
        raise
    print(f'HomeCraft virtual host applied; config backup: {backup}')
    print('Cloudflare: A @ -> 149.202.57.156, Proxied; SSL/TLS Full (strict).')
    try:
        with urllib.request.urlopen(f'https://{DOMAIN}/api/health/ready', timeout=15) as r:
            if not json.load(r).get('ready'):
                raise RuntimeError('Public readiness is not ready=true')
        print('Public HTTPS readiness passed.')
    except Exception as e:
        detail = f'HTTP {e.code}' if isinstance(e, urllib.error.HTTPError) else type(e).__name__
        raise RuntimeError(f'Origin applied; PUBLIC HTTPS NOT VERIFIED: {detail}. Check Cloudflare DNS/TLS/WAF.') from e


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', nargs='?', default='deploy', choices=['deploy', 'setup', 'publish', 'check', 'status', 'logs', 'stop'])
    args = parser.parse_args()
    if os.geteuid() != 0:
        os.execvp('sudo', ['sudo', 'python3', str(Path(__file__).resolve()), args.mode])
    os.umask(0o077)
    os.chdir(ROOT)
    with (ROOT/'.deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.mode in ('setup', 'deploy'):
            setup()
        if args.mode in ('publish', 'deploy'):
            publish()
        if args.mode == 'check':
            info(); health(); validate_cert(); run(['docker', 'exec', NGINX, 'nginx', '-t'])
            print('Local, Docker network, certificate and Nginx checks passed.')
        if args.mode == 'status': compose('ps')
        if args.mode == 'logs': compose('logs', '--tail', '80')
        if args.mode == 'stop': compose('stop', 'site')


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as e:
        print(f'Deployment stopped: {e}', file=sys.stderr)
        sys.exit(1)
