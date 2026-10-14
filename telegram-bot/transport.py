"""HTTP transport, Telegram and transcription. No credentials in source."""
import os
import json
import uuid
from urllib.error import HTTPError
from urllib.request import Request,urlopen

class APIError(Exception):
    def __init__(self, status):
        self.status = status
        super().__init__(f'API status {status}')

def request(url, method='GET', payload=None, headers=None, raw=None, timeout=90):
    headers = dict(headers or {})
    data = raw
    if payload is not None:
        data = json.dumps(payload).encode()
        headers['Content-Type'] = 'application/json'
    try:
        with urlopen(Request(url, data=data, headers=headers, method=method), timeout=timeout) as response:
            body = response.read()
            return json.loads(body) if 'json' in response.headers.get('Content-Type', '') else body
    except HTTPError as exc:
        raise APIError(exc.code) from None

def multipart(fields, filename, content, mimetype):
    boundary = uuid.uuid4().hex
    chunks = []
    for key, value in fields.items():
        chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
    chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: {mimetype}\r\n\r\n'.encode())
    chunks.extend([content, f'\r\n--{boundary}--\r\n'.encode()])
    return b''.join(chunks), {'Content-Type': f'multipart/form-data; boundary={boundary}'}

class Telegram:
    def __init__(self, token):
        self.base = 'https://api.telegram.org/bot' + token + '/'
        self.filebase = 'https://api.telegram.org/file/bot' + token + '/'

    def call(self, method, **payload):
        result = request(self.base + method, 'POST', payload)
        if not result.get('ok'):
            raise APIError(result.get('error_code', 500))
        return result['result']

    def say(self, chat, text):
        self.call('sendMessage', chat_id=chat, text=text[:4000])

    def voice(self, voice):
        if voice.get('file_size', 0) > 10_000_000 or voice.get('duration', 0) > 300:
            raise ValueError('Отправьте голосовое сообщение до 5 минут и до 10 МБ.')
        file = self.call('getFile', file_id=voice['file_id'])
        data = request(self.filebase + file['file_path'])
        if len(data) > 10_000_000:
            raise ValueError('Файл слишком большой.')
        return data

    def document(self, chat, data, filename='expenses.xlsx'):
        raw, headers = multipart({'chat_id': chat}, filename, data,
                                 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        # Telegram expects the multipart field to be called document.
        raw = raw.replace(b'name="file";', b'name="document";', 1)
        result = request(self.base + 'sendDocument', 'POST', headers=headers, raw=raw)
        if not result.get('ok'):
            raise APIError(result.get('error_code', 500))

class AI:
    def __init__(self, key, timezone):
            self.headers = {'Authorization': 'Bearer ' + key}
            self.timezone = timezone

    def transcribe(self, data):
            raw, headers = multipart({'model': os.getenv('TRANSCRIBE_MODEL', 'gpt-4o-mini-transcribe'),
                                      'language': 'ru', 'prompt': 'Тенге, хозрасходы, канцелярские товары.'},
                                     'voice.ogg', data, 'audio/ogg')
            return request('https://api.openai.com/v1/audio/transcriptions', 'POST',
                           headers={**self.headers, **headers}, raw=raw)['text']
