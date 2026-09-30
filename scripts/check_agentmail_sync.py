#!/usr/bin/env python3
"""Read AgentMail checkpoint and container status without using Hermes or MCP.

The durable worker does not use sync_jobs. This script reports checkpoint
counts and the container process only.

Usage:
  python3 /home/mert/check_agentmail_sync.py
  python3 /home/mert/check_agentmail_sync.py --container agentmail-work-agent
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone

NODE_SCRIPT = r'''
import Database from 'better-sqlite3';
const db = new Database('/data/agentmail.db', { readonly: true });
const tables = new Set(db.prepare("select name from sqlite_master where type='table'").all().map(x => x.name));
const accounts = tables.has('active_accounts')
  ? db.prepare('select account_id,email,provider,enabled,owner_principal from active_accounts order by account_id').all()
  : [];
const folders = tables.has('folders')
  ? db.prepare('select * from folders').all()
  : [];
const checkpoints = tables.has('sync_checkpoints')
  ? db.prepare('select * from sync_checkpoints').all()
  : [];
console.log(JSON.stringify({accounts, folders, checkpoints}));
'''


def run(cmd: list[str]) -> str:
    p = subprocess.run(cmd, text=True, capture_output=True)
    if p.returncode:
        detail = (p.stderr or p.stdout).strip()
        raise RuntimeError(f"command failed ({p.returncode}): {' '.join(cmd)}\n{detail}")
    return p.stdout


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--container', default='agentmail-default')
    args = ap.parse_args()

    try:
        inspect = json.loads(run(['docker', 'inspect', '--format', '{{json .}}', args.container]))
        state = inspect.get('State', {})
        command = ' '.join(inspect.get('Config', {}).get('Cmd') or [])
        print(f"Checked: {datetime.now(timezone.utc).isoformat()}")
        print(f"Container: {args.container}")
        print(f"State: {state.get('Status')}  Restart: {inspect.get('HostConfig', {}).get('RestartPolicy', {}).get('Name')}")
        print(f"Command: {command}")
        if 'sync-runtime-worker' in command:
            print('Worker: durable sync worker')

        raw = run(['docker', 'exec', args.container, 'node', '--input-type=module', '-e', NODE_SCRIPT])
        data = json.loads(raw)
        print('\nAccounts:')
        for account in data['accounts']:
            print(f"- {account['account_id']} <{account['email']}> owner={account.get('owner_principal')} enabled={account.get('enabled')}")

        folder_map = {(x.get('account_id'), x.get('folder_id')): x for x in data['folders']}
        print('\nCheckpoints:')
        for cp in data['checkpoints']:
            folder = folder_map.get((cp.get('account_id'), cp.get('mailbox_id', cp.get('folder_id'))), {})
            mailbox_id = cp.get('mailbox_id', cp.get('folder_id'))
            remote = cp.get('remote_messages')
            local = cp.get('local_message_count')
            has_counts = isinstance(remote, (int, float)) and isinstance(local, (int, float)) and remote >= 0 and local >= 0
            if has_counts:
                remote = int(remote)
                local = int(local)
                remaining = max(remote - local, 0)
                counts = f"downloaded={local} total={remote} remaining={remaining}"
            else:
                counts = f"downloaded={local if isinstance(local, (int, float)) else 'unknown'} total=unknown remaining=unknown"
            error = cp.get('error_class')
            error_text = f" error={error}" if error else ""
            print(
                f"- {cp.get('account_id')}/{folder.get('path', mailbox_id)}: "
                f"{counts} status={cp.get('status')} "
                f"lastUid={cp.get('last_uid')} uidNext={cp.get('uid_next')} "
                f"uidValidity={cp.get('uid_validity')} "
                f"updated={cp.get('updated_at')}{error_text}"
            )
        return 0
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
