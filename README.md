<div align="right"><a href="./README.en.md">English</a></div>

# pi-claude-mask

Pi 扩展，将指定的 Anthropic Messages 提供商伪装为本地 Claude Code CLI 发出的请求。

## 它做什么

一些网关或代理服务会校验请求来源是否为 Claude Code。本扩展在网络层面将 Pi 的请求伪装成 Claude Code CLI，包括：

- **User-Agent**：与本地 `claude` 二进制一致，格式为 `claude-cli/<version> (external, sdk-cli)`
- **system[0]**：注入 Claude Code 的标识句 `You are Claude Code, Anthropic's official CLI for Claude.`，Pi 自身的 prompt 保留在后续 system 块中
- **metadata.user_id**：包含稳定的逐提供商设备 ID 和从 Pi 会话派生的会话 ID
- **工具名称**：Pi 工具以 `mcp__pi__<name>` 格式发送，响应中自动还原
- **TLS**：使用 `node:https` 发起请求，TLS 指纹与 Claude Code 一致

本扩展**不会**注册模型、修改 base URL 或管理 API key。这些仍在 `models.json` 和 `auth.json` 中配置。

## 安装

```bash
pi install git:github.com/iluluyu/pi-claude-mask
```

## 使用

### 交互式切换

在 Pi 中输入：

```
/claude-mask
```

列出所有 Anthropic Messages 类型的提供商，`[x]` 表示已启用伪装。选择后按 Done 立即保存并生效，按 Esc 取消。

状态栏会显示 `mask: <提供商名>` 或 `mask: off`。

### 配置文件

路径：`~/.pi/agent/pi-claude-mask.json`

```json
{
  "providers": ["your-provider"]
}
```

`providers` 为空数组或文件不存在时，不伪装任何提供商。

## 设备 ID

每个提供商有独立的设备 ID，存放在：

```
~/.pi/agent/pi-claude-mask/devices/<provider>
```

删除某个提供商的设备 ID 文件会使该提供商的 prompt-cache 前缀失效。

## Claude Code 版本号

User-Agent 中的版本号默认跟随本地 `claude` 二进制。如需覆盖：

```bash
export PI_CLAUDE_MASK_CC_VERSION=2.1.288
```

## 自动重试

遇到限流或过载错误（在收到任何内容之前），扩展会自动重试，最多 3 次。

默认匹配规则（不区分大小写）：

- `rate limit`
- `too many requests`
- `overloaded`
- `\b429\b`
- `\b529\b`

可在配置文件中通过 `retryPatterns` 字段自定义，值为正则字符串数组：

```json
{
  "providers": ["your-provider"],
  "retryPatterns": ["rate limit", "too many requests", "overloaded", "\\b429\\b", "\\b529\\b"]
}
```

## 许可证

MIT
