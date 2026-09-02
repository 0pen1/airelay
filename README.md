# airelay

> 通过手机远程控制本机 AI Agent 会话。支持 Claude Code、Codex、Gemini CLI 等多种 CLI Agent。

手机和本机均无公网 IP，通过一台公网 VPS 中继。两端各自主动向中继建立 WebSocket 长连接，中继仅做消息路由。本机 AI 进程由 tmux 托管，Agent 进程重启后会话依然存活。

## 架构

```
[手机浏览器]  ──WSS──►  [公网 VPS 中继]  ◄──WSS──  [本机 Agent]
  xterm.js               WebSocket 路由           tmux control mode
  语音输入               SQLite 认证存储           ↕
  会话列表 UI                                     claude / codex / … 进程
```

详见 [DESIGN.md](./DESIGN.md)。

## 特性

- **会话持久**：Agent 进程重启后，tmux 托管的 AI 会话继续存活，可重新接入
- **多 Agent**：通过 `agents.json` 配置，新增一个 CLI Agent 只需加一行
- **安全认证**：Agent 用 HMAC-SHA256，手机用一次性 JWT + 可复用 session_token
- **断线重连**：手机网络中断后凭 session_token 自动重连，无需重新扫码
- **语音输入**：浏览器原生 Web Speech API（iOS 需 Safari）
- **排他锁**：同一会话同时只允许一个手机接入

## 包结构

| 包 | 说明 |
|----|------|
| `packages/shared` | 协议类型定义、HMAC/JWT 加密、校验工具 |
| `packages/relay`  | VPS 中继服务（Node.js + ws + node:sqlite） |
| `packages/agent`  | 本机 daemon（tmux control mode 驱动 + WS 客户端） |
| `packages/web`    | 手机前端（xterm.js + Web Speech API） |

## 开发

```bash
pnpm install
pnpm build        # 构建全部包，并把 web 产物复制到 relay
```

## 部署

**VPS 侧**（配合 nginx + certbot）：

```bash
npm install -g airelay
airelay-relay init
airelay-relay register <host_id> <host_secret>
airelay-relay start
```

**本机侧**：

```bash
npm install -g airelay
brew install tmux
airelay setup           # 生成 host 身份，输出 VPS 注册命令
airelay agent start     # 写入 launchd 并启动
airelay gen-token       # 终端打印二维码，手机扫码接入
```

## 环境要求

- Node.js 22.5+（中继使用内置 `node:sqlite`）
- tmux（本机）
- 现代浏览器（手机端）

## License

MIT
