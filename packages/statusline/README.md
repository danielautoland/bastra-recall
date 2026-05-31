# @bastra-recall/statusline

Statusline for Claude Code, shipped with [bastra-recall](https://github.com/n0mad-ai/bastra-recall).

Built on [owloops/claude-powerline](https://github.com/owloops/claude-powerline) (MIT, vendored)
with a `bastra-status` segment that surfaces live recall/save activity from the bastra-recall daemon.

## Install

It is wired up automatically by `bastra install claude-code`. To add it by hand, point your
Claude Code `statusLine` setting at the binary:

```jsonc
// ~/.claude/settings.json
{
  "statusLine": {
    "type": "command",
    "command": "node <path>/@bastra-recall/statusline/dist/index.mjs --style=powerline",
    "refreshInterval": 1
  }
}
```

## License

MIT. Bundles `owloops/claude-powerline` under the MIT License.
