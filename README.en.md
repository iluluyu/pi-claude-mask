<div align="right"><a href="./README.md">中文</a> | <a href="./README.en.md">English</a></div>

# pi-claude-mask

A Pi extension that disguises selected Anthropic Messages providers as the local Claude Code CLI on the wire.

## What It Does

Some gateways validate that incoming requests originate from Claude Code. This extension makes Pi's requests look like they come from the Claude Code CLI:

- **User-Agent** — matches the local `claude` binary: `claude-cli/<version> (external, sdk-cli)`
- **system[0]** — injects the Claude Code identity line: `You are Claude Code, Anthropic's official CLI for Claude.` Pi's own prompt remains in later system blocks.
- **metadata.user_id** — carries a stable per-provider device ID and a session ID derived from the Pi session
- **Tool names** — Pi tools are sent as `mcp__pi__<name>` and restored in the response
- **TLS** — requests go through `node:https`, so the TLS fingerprint matches Claude Code

This extension does **not** register models, change base URLs, or manage API keys. Those stay in `models.json` and `auth.json`.

## Install

```bash
pi install git:github.com/iluluyu/pi-claude-mask
```

## Usage

### Interactive Toggle

Inside Pi, run:

```
/claude-mask
```

This lists all Anthropic Messages providers. `[x]` means masked. Hit Done to save and apply immediately; Esc to cancel.

The status line shows `mask: <provider>` or `mask: off`.

### Config File

Path: `~/.pi/agent/pi-claude-mask.json`

```json
{
  "providers": ["your-provider"]
}
```

An empty array or a missing file means no provider is masked.

## Device ID

Each provider gets its own device ID, stored at:

```
~/.pi/agent/pi-claude-mask/devices/<provider>
```

Deleting a provider's device ID file invalidates that provider's prompt-cache prefix.

## Claude Code Version

The User-Agent version defaults to whatever the local `claude` binary reports. To override:

```bash
export PI_CLAUDE_MASK_CC_VERSION=2.1.288
```

## Auto-Retry

If a rate-limit or overload error arrives before any content has streamed, the extension retries up to 3 times.

Default patterns (case-insensitive):

- `rate limit`
- `too many requests`
- `overloaded`
- `\b429\b`
- `\b529\b`

Customize via the `retryPatterns` field in the config file — an array of regex strings:

```json
{
  "providers": ["your-provider"],
  "retryPatterns": ["rate limit", "too many requests", "overloaded", "\\b429\\b", "\\b529\\b"]
}
```

## License

MIT
