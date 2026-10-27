#!/usr/bin/env python3
"""Manual real HTTP/launcher integration. Uses disposable site copies and game folders; no live deployment."""
from pathlib import Path
import argparse,contextlib,hashlib,http.server,json,os,shutil,socket,subprocess,tempfile,threading,time,urllib.error,urllib.request,zipfile
p=argparse.ArgumentParser();p.add_argument('--site-dir',type=Path,required=True);p.add_argument('--launcher-dir',type=Path,required=True);p.add_argument('--java',default=shutil.which('java'));p.add_argument('--node',default=shutil.which('node'));p.add_argument('--report',type=Path);args=p.parse_args();checks=[]
def check(value,message):
 if not value:raise AssertionError(message)
 checks.append(message)
def port():
 with socket.socket() as sock:sock.bind(('127.0.0.1',0));return sock.getsockname()[1]
def get(url):
 try:
  with urllib.request.urlopen(url,timeout=8) as r:return r.status,r.headers,r.read()
 except urllib.error.HTTPError as e:return e.code,e.headers,e.read()
def digest(raw):return hashlib.sha256(raw).hexdigest()
with tempfile.TemporaryDirectory(prefix='homecraft-delivery-') as temp:
 base=Path(temp);site=base/'site';shutil.copytree(args.site_dir,site,ignore=shutil.ignore_patterns('node_modules','logs','deployment-backups','.env'))
 game=base/'game with spaces';(game/'mods').mkdir(parents=True)
 runtime=base/'launcher with spaces';shutil.copytree(args.launcher_dir,runtime)
 address='http://127.0.0.1:'+str(port());env=os.environ.copy()
 for key in list(env):
  if key.startswith('HOMECRAFT_') or key in {'SERVER_SECRET','PUBLIC_SITE_URL','HOST','PORT'}:env.pop(key)
 env.update(HOST='127.0.0.1',PORT=address.rsplit(':',1)[1],PUBLIC_SITE_URL=address,HOMECRAFT_SERVER_SECRET='manual-test-'+os.urandom(32).hex(),HOMECRAFT_CLIENT_MODS_MODE='manual',HOMECRAFT_CLIENT_MODS_INCLUDE='homecraftauth,homecraftguild,homecraftspawnprotection',HOMECRAFT_CLIENT_MODS_REQUIRED_IDS='homecraftauth,homecraftguild,homecraftspawnprotection',HOMECRAFT_CLIENT_MODS_CACHE_MS='0',HOMECRAFT_MC_PING_ENABLED='false',HOMECRAFT_MC_TCP_FALLBACK_ENABLED='false')
 env['JAVA_HOME']=str(Path(args.java).resolve().parent.parent)
 logs=(base/'server.log').open('w');server=subprocess.Popen([args.node,'server.js'],cwd=site,env=env,stdout=logs,stderr=subprocess.STDOUT)
 def cli(command,*options,game_dir=game,origin=address):
  r=subprocess.run(['sh',str(runtime/'start-linux.sh'),command,'--site',origin,'--game-dir',str(game_dir),*options],env=env,cwd=base,capture_output=True,text=True,timeout=35)
  return r
 try:
  for attempt in range(100):
   if server.poll() is not None:raise RuntimeError((base/'server.log').read_text()[-3000:])
   try:
    if get(address+'/api/health/ready')[0]==200:break
   except OSError:pass
   time.sleep(.05)
  status,headers,body=get(address+'/api/launcher/manifest');manifest=json.loads(body);expected={'homecraftauth','homecraftchat','homecraftguild','homecraftspawnprotection','realtime'}
  check(status==200 and manifest['ready'],'site serves a ready launcher manifest')
  check({f['id'] for f in manifest['files']}==expected,'manifest includes all five exact client IDs')
  check(manifest['minecraft']=='26.3' and manifest['neoforge']=='26.3.0.99','runtime versions match the shipped mod pack')
  listing=json.loads(get(address+'/api/client-mods')[2])['clientMods'];check({f['modId'] for f in listing['files']}==expected,'manual download list and manifest agree despite legacy three-ID env')
  raw_files={}
  for f in manifest['files']:
   code,h,raw=get(address+f['url']);raw_files[f['filename']]=raw
   check(code==200 and len(raw)==f['size'] and digest(raw)==f['sha256'],'HTTP JAR size and SHA256: '+f['id'])
  page=get(address+'/download')[2].decode();check('/launcher/HomeCraftLauncher.jar' in page and 'start-linux.sh' in page,'download page offers the direct JAR and Linux instructions')
  for url,local in [('/launcher/HomeCraftLauncher.jar',runtime/'HomeCraftLauncher.jar'),('/launcher/HomeCraft-Launcher-Java.zip',site/'public/launcher/HomeCraft-Launcher-Java.zip')]:
   code,h,raw=get(address+url);check(code==200 and raw==local.read_bytes() and 'attachment' in h.get('Content-Disposition',''),'site publishes downloadable launcher: '+url)
  # Actual JAR metadata must exclude the server map, even under a misleading filename.
  fake_map=site/'client-mods/homecraftauth-disguised-map.jar'
  with zipfile.ZipFile(fake_map,'w') as z:z.writestr('META-INF/neoforge.mods.toml','[[mods]]\nmodId="homecraftmap"\nversion="1.0"\ndisplayName="Home Craft Map"\n[[dependencies.homecraftmap]]\nmodId="minecraft"\nversionRange="[26.3,26.4)"\nside="SERVER"\n')
  check(len(json.loads(get(address+'/api/launcher/manifest')[2])['files'])==5,'server-only map is not exposed in the published client pack')
  fake_map.unlink()
  catalogue=site/'client-mods/client-pack.json';published=catalogue.read_bytes();edited=json.loads(published);edited['files'][0]['sha256']='0'*64;catalogue.write_text(json.dumps(edited))
  check(get(address+'/api/launcher/manifest')[0]==503,'published file SHA256 mismatch fails closed');catalogue.write_bytes(published)
  edited=json.loads(published);edited['files'][0]['id']='homecraftmap';catalogue.write_text(json.dumps(edited))
  check(get(address+'/api/launcher/manifest')[0]==503,'server-only mod cannot be added to the client publication catalogue');catalogue.write_bytes(published)
  chat=next(f for f in manifest['files'] if f['id']=='homecraftchat');chat_path=site/'client-mods'/chat['filename'];chat_bytes=chat_path.read_bytes();chat_path.unlink()
  code,_,body=get(address+'/api/launcher/manifest');check(code==503 and 'homecraftchat' in json.loads(body)['missingIds'],'missing published mod makes the pack incomplete')
  r=cli('update');check(r.returncode!=0 and not list((game/'mods').iterdir()),'launcher refuses incomplete server pack without modifying mods');chat_path.write_bytes(chat_bytes)
  guild=next(f for f in manifest['files'] if f['id']=='homecraftguild');duplicate=site/'client-mods/duplicate-guild.jar';duplicate.write_bytes(raw_files[guild['filename']])
  check(get(address+'/api/launcher/manifest')[0]==200,'old duplicate left by overlay deployment does not hide the published version');duplicate.unlink()
  r=cli('check');check(r.returncode==0 and r.stdout.count('Не встановлено')==5,'Linux launcher detects five missing client mods')
  r=cli('update');check(r.returncode==0 and 'Оновлено модулів: 5' in r.stdout,'Linux launcher installs all missing mods into an empty folder: '+r.stderr.strip())
  check({f.name for f in (game/'mods').iterdir()}==set(raw_files),'fresh installation contains exactly the five client JARs')
  check(all(digest((game/'mods'/f['filename']).read_bytes())==f['sha256'] for f in manifest['files']),'installed files match the site manifest')
  r=cli('update');check(r.returncode==0 and 'Оновлено модулів: 0' in r.stdout,'repeat update is idempotent')
  (game/'mods'/chat['filename']).unlink();(game/'mods/duplicate-guild.jar').write_bytes(raw_files[guild['filename']]);unrelated=b'user-owned unrelated mod';(game/'mods/other-mod.jar').write_bytes(unrelated)
  r=cli('update');check(r.returncode==0 and 'Оновлено модулів: 2' in r.stdout,'missing Chat and duplicate old Guild are repaired together')
  check((game/'mods/other-mod.jar').read_bytes()==unrelated and not (game/'mods/duplicate-guild.jar').exists(),'unrelated mods are preserved and duplicate managed JAR is removed')
  check(len(list((game/'.homecraft-launcher/backups').rglob('*.jar')))==2,'replaced managed JARs are backed up')
  # A failing last download must not partially install the missing pack.
  bad_game=base/'failed download';(bad_game/'mods').mkdir(parents=True);auth=next(f for f in manifest['files'] if f['id']=='homecraftauth');(bad_game/'mods'/auth['filename']).write_bytes(raw_files[auth['filename']]);(bad_game/'mods/other-mod.jar').write_bytes(unrelated)
  mode={'value':'corrupt'}
  class Handler(http.server.BaseHTTPRequestHandler):
   def log_message(self,*a):pass
   def do_GET(self):
    current=json.loads(json.dumps(manifest))
    if mode['value']=='duplicate':current['files'][-1]=current['files'][0]
    if mode['value']=='external':current['files'][0]['url']='https://example.invalid/file.jar'
    if mode['value']=='three':current['files']=current['files'][:3]
    if mode['value']=='map':current['files'][-1]['id']='homecraftmap'
    if self.path=='/api/launcher/manifest':data=json.dumps(current).encode()
    else:
     from urllib.parse import unquote
     name=unquote(self.path).split('/')[-1];data=raw_files[name]
     if mode['value']=='corrupt' and name.startswith('realtime-'):data=bytes([data[0]^1])+data[1:]
    self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
  with http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler) as fake:
   thread=threading.Thread(target=fake.serve_forever,daemon=True);thread.start();origin='http://127.0.0.1:'+str(fake.server_port)
   r=cli('update',game_dir=bad_game,origin=origin);check(r.returncode!=0 and 'SHA-256' in r.stderr,'corrupt downloaded JAR fails SHA256 validation')
   check({f.name for f in (bad_game/'mods').iterdir()}=={auth['filename'],'other-mod.jar'} and (bad_game/'mods'/auth['filename']).read_bytes()==raw_files[auth['filename']],'failed download preserves installed files without a partial pack')
   for value in ['duplicate','external','three','map']:
    mode['value']=value;r=cli('check',origin=origin);check(r.returncode!=0,'unsafe or incomplete manifest rejected: '+value)
   fake.shutdown();thread.join(timeout=2)
  launch_game=base/'launch game';(launch_game/'mods').mkdir(parents=True);external=base/'external launcher.sh';marker=base/'launched';external.write_text('#!/bin/sh\nprintf launched > '+str(marker)+'\n');external.chmod(0o755)
  r=cli('launch','--skip-graphics','--launcher-exe',str(external),game_dir=launch_game)
  for _ in range(30):
   if marker.exists():break
   time.sleep(.05)
  check(r.returncode==0 and marker.exists(),'Linux launch command starts the configured external launcher')
  check({f.name for f in (launch_game/'mods').iterdir()}==set(raw_files),'launch automatically installs the complete pack before starting the external launcher')
 finally:
  server.terminate()
  try:server.wait(timeout=5)
  except subprocess.TimeoutExpired:server.kill();server.wait()
  logs.close()
report={'status':'PASS','checks':len(checks),'details':checks,'method':'Real disposable Node HTTP site + real Linux shell script and Java launcher; no Minecraft game or live website deployed.'}
if args.report:args.report.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print('Client delivery:',len(checks),'checks PASSED')
