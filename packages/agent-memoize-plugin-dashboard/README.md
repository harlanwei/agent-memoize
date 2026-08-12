# @naevic/agent-memoize-plugin-dashboard

Debugging plugin for [`agent-memoize`](https://www.npmjs.com/package/@naevic/agent-memoize):
logs every memory creation/refresh (`memory.created`) and every recall access
(`memory.accessed`), and serves an HTTP dashboard to inspect the logs.

## Install

```sh
npm install -D @naevic/agent-memoize-plugin-dashboard
```

## Configure

`.agent-memoize/config.json`:

```json
{
  "version": 1,
  "plugins": [
    { "id": "files" },
    { "id": "markdown" },
    { "id": "core-filter" },
    { "id": "agent" },
    { "id": "dashboard", "options": { "port": 8888 } }
  ]
}
```

Open `http://127.0.0.1:8888` to see the activity stream (auto-refreshes every 2 s). Raw logs
are available at `/api/logs`; they are also appended as JSONL to
`.agent-memoize/logs/dashboard.jsonl`. On startup the dashboard replays the most recent
`maxLogs` entries from that file, so history from previous agent sessions stays visible
(record ids continue across restarts).

**Multiple agents on the same project**: when another agent's session already serves this
project's dashboard, the new instance detects it and switches to **log-only mode** — it does
not bind the port, it only appends to the shared JSONL file, which the running dashboard tails
and shows within ~2 s. If the port is instead held by an unrelated service, the dashboard
falls back to a random port and logs the URL.

Every record carries an `accessor` field (the MCP client name, e.g. `claude-code`, `codex`)
shown in the dashboard's agent column.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `port` | `8888` | Dashboard port (`0` picks a free port) |
| `maxLogs` | `1000` | In-memory ring buffer size |
| `logFile` | `.agent-memoize/logs/dashboard.jsonl` | JSONL log file; `false` disables file persistence |
