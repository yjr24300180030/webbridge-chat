import sys
import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'local'))
from connector import Relay, fingerprint
from bridge import Bridge


class ConnectorTests(unittest.TestCase):
    def setUp(self):
        self.bridge=Bridge('test-token')
        self.relay=Relay({'connector_id':'test'},self.bridge,sqlite3.connect(':memory:'))

    def test_unknown_page_never_falls_back_to_personal_tab(self):
        import time
        self.bridge.pages['personal']={'seen':time.time(),'snapshot':{},'command':None}
        with self.assertRaises(RuntimeError):self.bridge.send('missing','hello')
        self.assertIsNone(self.bridge.pages['personal']['command'])

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
