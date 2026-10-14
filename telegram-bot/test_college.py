import os
import tempfile
import unittest
from unittest.mock import patch
from college_bot import College, schedule_text


class BotTests(unittest.TestCase):
    def test_service_request_is_authenticated_and_identified(self):
        with patch.dict(os.environ, {'COLLEGE_APP_URL':'https://example.test','BOT_SERVICE_SECRET':'test-secret'}):
            client=College()
        with patch('college_bot.urlopen') as http:
            http.return_value.__enter__.return_value.read.return_value=b'{"ok":true}'
            self.assertTrue(client.call('state',{'user_id':'1'})['ok'])
            request=http.call_args.args[0]
            self.assertEqual(request.get_header('Authorization'),'Bearer test-secret')
            self.assertEqual(request.get_header('User-agent'),'DigitalCollege-TelegramBot/1.0')
            self.assertEqual(request.full_url,'https://example.test/api/bot/state')

    def test_schedule_preserves_draft_status(self):
        state={'group':'Group A','date':'2026-10-15','week':7,'status':'Проект расписания · не утверждено',
               'lessons':[{'start':'09:30','end':'10:50','slot':2,'subject':'Математика','room':'504','teacher':'Преподаватель'}]}
        message=schedule_text(state)
        self.assertIn('09:30–10:50',message)
        self.assertIn('не утверждено',message)
        self.assertIn('Аудитория: 504',message)


if __name__=='__main__':unittest.main()
