# Native host service and Compose transition

AgentMail's supported runtime is a native host service. Docker Compose remains available and is not removed. Do not delete named volumes and do not stop the current containers as part of this change. Interactive mail stays remote-only: no message mirror reads, no background sync worker, and no IMAP IDLE.

## Native layout

| Piece | Path |
| --- | --- |
| Hermes MCP wrapper | `tools/hermes-agentmail-mcp.sh` |
| Native launcher | `tools/agentmail-native-mcp.sh` |
| systemd user template | `deploy/systemd/user/agentmail@.service` |
| Data directory | `$HOME/.local/share/agentmail/<profile>/` |
| Attachment root | `$HOME/.local/share/agentmail/<profile>/outgoing` |
| SecretFabric env file | `$HOME/.config/agentmail/<profile>.env` |

`tools/hermes-agentmail-mcp.sh` derives the principal from `HERMES_HOME` and execs Node. `agentmail@<profile>.service` runs the same launcher with `--service`, which sets `AGENTMAIL_NATIVE_HOLD=1` so the process stays up without an MCP stdio session and without starting sync.

## Install and enable

Replace `<profile>` with the Hermes profile name (`default` for `~/.hermes`).

```bash
mkdir -p ~/.config/systemd/user ~/.config/agentmail
cp /home/mert/agent-mail-client/deploy/systemd/user/agentmail@.service ~/.config/systemd/user/agentmail@.service
install -m 700 -d ~/.config/agentmail
umask 077
cat > ~/.config/agentmail/<profile>.env <<'EOF'
SECRET_FABRIC_URL=http://127.0.0.1:3000
SECRET_FABRIC_API_TOKEN=replace-me
EOF
chmod 600 ~/.config/agentmail/<profile>.env
systemctl --user daemon-reload
systemctl --user enable --now agentmail@<profile>.service
```

If the checkout is not `~/agent-mail-client`, edit `WorkingDirectory` and `ExecStart` in the copied unit before `daemon-reload`.

Hermes MCP:

```bash
hermes mcp add agentmail -- /home/mert/agent-mail-client/tools/hermes-agentmail-mcp.sh
```

The wrapper still needs `SECRET_FABRIC_URL` and `SECRET_FABRIC_API_TOKEN` in the environment Hermes inherits.

## Compose

`compose.yaml` sets `AGENTMAIL_SERVICE_MODE=docker` and still runs only `node src/mcp/server.mjs`. `tools/provision-agentmail-profile.sh` can still build and start a profile stack. Leave existing containers and volumes running until you choose to retire them. The Hermes wrapper no longer attaches with `docker exec`.
