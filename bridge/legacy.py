"""Adapter for the optional original Windows Work folder and Sandbox tools."""

import asyncio
import json
import os
from pathlib import Path
import sys
import threading

root = Path(sys.argv[1])
sys.path.insert(0, str(root / 'Runtime' / 'tools'))
import agent

request = json.loads(sys.stdin.readline())
stop = threading.Event()


def monitor_stop():
    pending = b''
    while chunk := os.read(sys.stdin.fileno(), 128):
        pending += chunk
        if b'STOP\n' in pending:
            stop.set()
            return


def emit(kind, value):
    event = {'type': 'delta', 'text': value} if kind == 'text' else {
        'type': 'status', 'message': value
    }
    print(json.dumps(event, ensure_ascii=False), flush=True)


threading.Thread(target=monitor_stop, daemon=True).start()
try:
    # The Rust backend has already verified that this identifier is on the local server.
    agent.ensure_model = lambda model, _emit: model
    asyncio.run(agent.run_turn(request['history'], request['question'], emit, stop,
                               use_tools=True, model=request['model']))
except Exception as error:
    print(json.dumps({'type': 'error', 'message': str(error)}, ensure_ascii=False), flush=True)
    raise SystemExit(1)
