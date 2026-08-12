# @naevic/agent-memoize-plugin-dreaming

Postprocessing plugin for [`agent-memoize`](https://www.npmjs.com/package/@naevic/agent-memoize):
when stale/suspended memories accumulate to a configurable amount, the `memoize_status`
result is annotated with a `dreaming` section that tells the agent to spawn subagents to
verify the memories against their current sources and reorganize them into a more concise
format.

## Install

```sh
npm install -D @naevic/agent-memoize-plugin-dreaming
```

## Configure

`.agent-memoize/config.json`:

```json
{
  "version": 1,
  "plugins": [
    { "id": "files", "priority": 100 },
    { "id": "markdown", "priority": 100 },
    { "id": "core-filter", "priority": 100 },
    { "id": "agent", "priority": 100 },
    { "id": "dreaming", "priority": 100, "options": { "threshold": 15 } }
  ]
}
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `threshold` | `15` | Number of stale + suspended memories that triggers the dreaming guidance |
