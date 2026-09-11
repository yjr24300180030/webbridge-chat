import sys
import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
from connector import Relay, fingerprint, persistent_chat_path, project_id
from bridge import Bridge


class ConnectorTests(unittest.TestCase):
    def test_temporary_chat_url_not_bound_as_persistent_conversation(self):
        cid='6aa3ad63-b948-83e9-bc33-696bf5b47257'
        self.assertFalse(persistent_chat_path('/c/WEB:'+cid))
        self.assertFalse(persistent_chat_path('/'))
        self.assertTrue(persistent_chat_path('/c/'+cid))
        self.assertTrue(persistent_chat_path('/g/example/c/'+cid))

    def setUp(self):
        self.bridge=Bridge('test-token')
        self.relay=Relay({'connector_id':'test'},self.bridge,sqlite3.connect(':memory:'))

    def test_unknown_page_never_falls_back_to_personal_tab(self):
        import time
        self.bridge.pages['personal']={'seen':time.time(),'snapshot':{},'command':None}
        with self.assertRaises(RuntimeError):self.bridge.send('missing','hello')
        self.assertIsNone(self.bridge.pages['personal']['command'])

    def test_new_project_conversation_rejects_ordinary_home(self):
        self.relay.config['target_url']='https://chatgpt.com/g/g-p-abc123/project'
        with patch.object(self.relay,'open_page',return_value={'url':'https://chatgpt.com/','userCount':0,'assistantCount':0}):
            with self.assertRaisesRegex(RuntimeError,'指定 Project'):
                self.relay.process({'id':'j','conversation':'c','prompt':'hello'})

    def test_project_id_handles_named_and_plain_project_urls(self):
        self.assertEqual(project_id('https://chatgpt.com/g/g-p-abc123/project'),'g-p-abc123')
        self.assertEqual(project_id('https://chatgpt.com/g/g-p-abc123-my-project/c/xyz'),'g-p-abc123')
        self.assertIsNone(project_id('https://chatgpt.com/c/xyz'))

    def test_existing_conversation_keeps_original_url_after_project_change(self):
        self.relay.config['target_url']='https://chatgpt.com/g/g-p-abc123/project'
        saved=('https://chatgpt.com/c/original',fingerprint('old'),1)
        with patch.object(self.relay,'page',side_effect=[None,{'hasEditor':True}]), patch.object(self.relay,'update'), patch('connector.subprocess.run') as opened:
            self.relay.open_page({'conversation':'session'},saved)
        self.assertEqual(opened.call_args.args[0][-1],'https://chatgpt.com/c/original#bridge-chat=session')

    def test_duplicate_journal_prevents_second_submission(self):
        self.relay.db.execute('INSERT INTO journal VALUES(?,?,?)',('job','sending',None))
        with self.assertRaisesRegex(RuntimeError,'不会重复发送'):self.relay.process({'id':'job'})

    def test_existing_personal_content_rejected(self):
        job={'id':'j','conversation':'c','prompt':'hello'}
        with patch.object(self.relay,'open_page',return_value={'userCount':1,'lastUser':'private'}):
            with self.assertRaisesRegex(RuntimeError,'空白页面'):self.relay.process(job)

    def test_manually_changed_conversation_rejected(self):
        self.relay.db.execute('INSERT INTO sessions VALUES(?,?,?,?)',('c','https://chatgpt.com/c/abc',fingerprint('old'),1))
        page={'url':'https://chatgpt.com/c/other','lastUser':'old','assistantCount':1}
        with patch.object(self.relay,'open_page',return_value=page):
            with self.assertRaisesRegex(RuntimeError,'页面已切换'):self.relay.process({'id':'j','conversation':'c','prompt':'hello'})


if __name__=='__main__':unittest.main()
