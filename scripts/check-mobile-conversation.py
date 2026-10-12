"""Check the owner-private Site with real inference; credential is stdin-only.

Input: one JSON line with url and token. Optional report specifies an output path.
The token is never included in the report or command arguments.
"""
import json
import re
from pathlib import Path
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

if sys.stdin.isatty():
    import termios
    attrs = termios.tcgetattr(sys.stdin)
    attrs[3] &= ~termios.ECHO
    termios.tcsetattr(sys.stdin, termios.TCSANOW, attrs)
print('Ready for conversation suite JSON on stdin', flush=True)
config = json.loads(sys.stdin.readline())
base = config['url'].rstrip('/')
headers = {'OAI-Sites-Authorization': 'Bearer ' + config['token'], 'Content-Type': 'application/json'}
root = Path(__file__).resolve().parents[1]
cases = json.loads((root / 'mobile/conversation-cases.json').read_text())
if config.get('case_ids'):
    selected = set(config['case_ids'])
    cases = [case for case in cases if case['id'] in selected]
    assert len(cases) == len(selected), 'Unknown or duplicate case IDs'

def request(path, value=None):
    body = json.dumps(value).encode() if value is not None else None
    for attempt in range(3 if value is None else 1):
        try:
            with urllib.request.urlopen(urllib.request.Request(base + path, data=body, headers=headers), timeout=25) as response:
                return json.load(response)
        except (urllib.error.URLError, TimeoutError):
            if value is not None or attempt == 2:
                raise
            time.sleep(1)

health = request('/api/health')
assert health['models']['chat']['ready']
assert health['models']['chat']['model'] == 'unsloth/Qwen3-4B-Instruct-2507-GGUF'
report = {'checked_at':datetime.now(timezone.utc).isoformat(), 'site':base, 'health':health, 'cases':[],
          'scope':'Fixed conversation regressions, including server-clock calendar answers; not a broad capability benchmark.'}
print(json.dumps({'health':health}), flush=True)
previous = []
for case in cases:
    history = previous if case.get('continue_from_previous') else case.get('history',[])
    started = request('/api/jobs', {'kind':'chat', 'variant':'baseline', 'input':case['input'], 'history':history, **({'timeZone':case['timeZone']} if 'timeZone' in case else {})})
    deadline = time.monotonic() + 210
    while time.monotonic() < deadline:
        job = request('/api/jobs/' + started['id'])
        if job['status'] != 'running':
            break
        time.sleep(2)
    answer = job.get('answer', '')
    normalized = unicodedata.normalize('NFKC', answer)
    structure_ok = job['status'] == 'completed' and job.get('ok') is True and bool(answer.strip()) and job['model'] == health['models']['chat']['model'] and job['variant'] == 'baseline' and not any(e['type'].startswith('tool_') for e in job['events'])
    content_ok = (all(any(word in normalized for word in choices) for choices in case['all'])
        and len(answer.strip()) <= case.get('max_chars', 10000)
        and len([s for s in re.split(r'[。!?！？]+', answer) if s.strip()]) <= case.get('max_sentences', 10000)
        and not any(word in normalized for word in case.get('forbidden', [])))
    if 'calendar' in case:
        target = datetime.fromtimestamp(job['started'] / 1000, ZoneInfo(case.get('timeZone', 'UTC'))).date() + timedelta(days=case['calendar']['offset'])
        expected = (['月曜日','火曜日','水曜日','木曜日','金曜日','土曜日','日曜日'][target.weekday()]
            if case['calendar']['format'] == 'weekday' else
            (f'{target.year}年' if case['calendar']['format'] == 'date' else '') + f'{target.month}月{target.day}日')
        content_ok = content_ok and expected in normalized and job['timeZone'] == case.get('timeZone', 'UTC')
    else:
        expected = None
    result = {**case, 'history':history, 'answer':answer, 'reason':job.get('reason'), 'duration_ms':job.get('durationMs'), 'expected_calendar':expected, 'server_started_ms':job.get('started'), 'effective_time_zone':job.get('timeZone'), 'structure_ok':structure_ok, 'content_checks_ok':content_ok}
    previous = [*history, {'role':'user','content':case['input']}, {'role':'assistant','content':answer[:1000]}][-6:]
    report['cases'].append(result)
    print(json.dumps(result, ensure_ascii=False), flush=True)
report['requires_manual_review'] = True
report['passed'] = sum(c['structure_ok'] and c['content_checks_ok'] for c in report['cases'])
if config.get('report'):
    Path(config['report']).write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'passed':report['passed'], 'total':len(cases)}), flush=True)
raise SystemExit(0 if report['passed'] == len(cases) else 1)
