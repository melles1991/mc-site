"""Run explicitly: python3 -m unittest discover -s manual-qa -v"""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('deploy', Path(__file__).resolve().parents[1]/'deployment/deploy.py')
d = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(d)

class Deployment(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root/'deployment').mkdir()
        shutil.copyfile(d.ROOT/'deployment/homecraft.nginx.conf', self.root/'deployment/homecraft.nginx.conf')
        self.root_patch = patch.object(d, 'ROOT', self.root)
        self.root_patch.start()
        self.config = self.root/'public-site.conf'
        self.original = 'server { listen 80; server_name lihvodruida.pp.ua; }\n'
        self.config.write_text(self.original)
        (self.root/'data').mkdir()
        (self.root/'data/users.json').write_text(json.dumps([{'role':'admin'}]))
        self.calls = []

    def tearDown(self):
        self.root_patch.stop()
        self.temp.cleanup()

    def test_idempotent_managed_block(self):
        first=d.render(self.original)
        self.assertEqual(first, d.render(first))
        self.assertEqual(first.count(d.BEGIN),1)
        self.assertIn(self.original.strip(), first)

    def test_unmanaged_domain_refused(self):
        with self.assertRaises(RuntimeError):
            d.render('server_name homecraft-mc.pp.ua;')

    def test_broken_markers_refused(self):
        for text in [d.BEGIN, d.END, d.BEGIN+'\n'+d.END+'\n'+d.BEGIN+'\n'+d.END]:
            with self.assertRaises(RuntimeError):d.render(text)

    def test_write_preserves_bind_inode(self):
        before=self.config.stat().st_ino
        d.write_in_place(self.config,'changed')
        self.assertEqual(before,self.config.stat().st_ino)

    def publish_failure(self, stage):
        checks=0
        reloads=0
        def run(cmd,*args,**kwargs):
            nonlocal checks,reloads
            self.calls.append(cmd)
            if cmd[-1]=='-t':
                checks+=1
                if stage=='test' and checks==2:raise RuntimeError('nginx validation failed')
            if cmd[-1]=='reload':
                reloads+=1
                if stage=='reload' and reloads==1:raise RuntimeError('reload failed')
        actions=[]
        def volume(*args):
            actions.append(args[-1])
            if stage=='certificate' and args[-1]=='install':raise RuntimeError('partial certificate write')
        with patch.object(d,'info',return_value=({'Image':'existing-image'},'existing-volume',self.config)), \
             patch.object(d,'health'),patch.object(d,'validate_cert'),patch.object(d,'run',side_effect=run), \
             patch.object(d,'volume_step',side_effect=volume):
            with self.assertRaises(RuntimeError):d.publish()
        self.assertEqual(self.config.read_text(), self.original)
        self.assertEqual(actions,['install','restore'])
        self.assertTrue(any(cmd[-1]=='reload' for cmd in self.calls))
        self.assertEqual(len(list((self.root/'deployment-backups').glob('*/public-site.conf'))),1)

    def test_nginx_test_failure_restores_config_cert(self):self.publish_failure('test')
    def test_reload_failure_restores_config_cert(self):self.publish_failure('reload')
    def test_partial_certificate_failure_restores(self):self.publish_failure('certificate')

    def test_two_successful_publishes_keep_single_block(self):
        import io
        with patch.object(d,'info',return_value=({'Image':'existing'},'volume',self.config)), \
             patch.object(d,'health'),patch.object(d,'validate_cert'),patch.object(d,'run'), \
             patch.object(d,'volume_step') as volume, \
             patch.object(d.urllib.request,'urlopen',side_effect=lambda *a,**k:io.BytesIO(b'{"ready":true}')):
            d.publish()
            d.publish()
            self.assertEqual(self.config.read_text().count(d.BEGIN),1)
            self.assertIn('server_name lihvodruida.pp.ua',self.config.read_text())
            self.assertEqual([c.args[-1] for c in volume.call_args_list],['install','install'])

    def test_no_administrator_never_changes_nginx(self):
        (self.root/'data/users.json').write_text('[]')
        with patch.object(d,'info',return_value=({},'volume',self.config)),patch.object(d,'health'), \
             patch.object(d,'validate_cert'),patch.object(d,'volume_step') as volume:
            with self.assertRaises(RuntimeError):d.publish()
            volume.assert_not_called()
        self.assertEqual(self.config.read_text(),self.original)

    def test_cert_helper_uses_existing_volume_not_nginx_exec(self):
        with patch.object(d,'run') as run:
            d.volume_step({'Image':'sha256:existing'},'actual-volume','backup-fixture','install')
        args=run.call_args.args[0]
        self.assertEqual(args[:3],['docker','run','--rm'])
        self.assertIn('type=volume,source=actual-volume,target=/certs',args)
        self.assertIn('--network',args)
        self.assertIn('none',args)
        self.assertNotIn('exec',args)
        self.assertIn('sha256:existing',args)

    def test_setup_permissions_have_caps_and_no_project_down(self):
        calls=[]
        with patch.object(d,'compose',side_effect=lambda *a,**k:calls.append(a)),patch.object(d,'health'):
            (self.root/'config').mkdir()
            (self.root/'config/site.env').write_text('EXISTING_SECRET=untouched')
            d.setup_stopped()
        permissions=next(cmd for cmd in calls if cmd[0]=='run')
        for name in ['CHOWN','DAC_OVERRIDE','FOWNER']:self.assertIn(name,permissions)
        self.assertNotIn('down',[a[0] for a in calls])
        self.assertEqual((self.root/'config/site.env').read_text(),'EXISTING_SECRET=untouched')
        self.assertTrue(list((self.root/'deployment-backups').glob('*/config/site.env')))

    def test_real_openssl_rejects_wrong_hostname_and_key(self):
        certdir=self.root/'certificates'
        certdir.mkdir()
        def generate(name, filename):
            subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes',
                '-days','2','-keyout',str(certdir/(filename+'.key')),
                '-out',str(certdir/(filename+'.pem')),'-subj','/CN='+name],
                check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        generate('wrong.example','origin')
        with patch.object(d,'CERT_SOURCE',certdir):
            with self.assertRaisesRegex(RuntimeError,'does not cover'):d.validate_cert()
            generate(d.DOMAIN,'origin')
            d.validate_cert()
            generate(d.DOMAIN,'other')
            shutil.copyfile(certdir/'other.key',certdir/'origin.key')
            with self.assertRaisesRegex(RuntimeError,'do not match'):d.validate_cert()

    def test_existing_override_is_kept_and_edge_is_explicit(self):
        (self.root/'compose.override.yaml').write_text('services: {}\n')
        with patch.object(d,'run',return_value='') as run:d.compose('config','--quiet')
        cmd=run.call_args.args[0]
        self.assertIn(str(self.root/'compose.override.yaml'),cmd)
        self.assertIn(str(self.root/'deployment/compose.edge.yaml'),cmd)
        self.assertEqual((self.root/'compose.override.yaml').read_text(),'services: {}\n')

if __name__=='__main__':unittest.main()
