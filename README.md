# pi-claude-mask

Make selected [Pi](https://github.com/earendil-works/pi) providers look like the Claude Code CLI on the wire. The extension does not register models, endpoints, or API keys. Those stay in `models.json` and `auth.json`.

## Install

```bash
pi install git:github.com/iluluyu/pi-claude-mask
```

Restart Pi, then run `/claude-mask`. The picker lists Anthropic Messages providers. `[x]` means that provider is masked. **Done** saves the choice and applies it immediately. **Esc** cancels. The status line shows `mask: ...`.

You can also edit `~/.pi/agent/pi-claude-mask.json`:

```json
{
  "providers": ["your-provider"]
}
```

An empty list, or a missing file, leaves every provider on Pi's normal client.

## What it changes

For each selected provider's Anthropic Messages requests:

- `User-Agent` follows the local `claude` binary (`claude-cli/<version> (external, sdk-cli)`). Override it with `PI_CLAUDE_MASK_CC_VERSION`.
- `system[0]` is `You are Claude Code, Anthropic's official CLI for Claude.` Pi's own prompt stays in the following system blocks.
- `metadata.user_id` carries a stable per-provider device id and a session id derived from the Pi session. Device ids live in `~/.pi/agent/pi-claude-mask/devices/<provider>`. Do not rotate one unless you intend to drop that provider's prompt-cache prefix.
- Pi tool names are sent as `mcp__pi__<name>` and restored in the response stream.
- Requests use `node:https`, matching Claude Code's TLS stack.

Optional `retryPatterns` are case-insensitive regular expressions. A matching error that arrives before any content is retried up to three times. The default patterns are generic rate-limit errors.

## 中文

```bash
pi install git:github.com/iluluyu/pi-claude-mask
```

安装后执行 `/claude-mask`，勾选需要伪装成 Claude Code 的 Anthropic Messages 供应商。未勾选的供应商保持 pi 原样调用。
