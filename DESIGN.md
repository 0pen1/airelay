# airelay 设计文档

> 通过手机远程控制本机 AI Agent 会话的系统，支持 Claude Code、Codex、Gemini CLI 等多种 Agent。

---

## 目录

1. [系统概述](#1-系统概述)
2. [整体架构](#2-整体架构)
3. [包结构](#3-包结构)
4. [组件职责](#4-组件职责)
5. [消息协议](#5-消息协议)
6. [安全设计](#6-安全设计)
7. [Driver 抽象（多 Agent 支持）](#7-driver-抽象多-agent-支持)
8. [会话生命周期](#8-会话生命周期)
9. [CLI 命令](#9-cli-命令)
10. [手机端 Web UI](#10-手机端-web-ui)
11. [VPS 部署](#11-vps-部署)
12. [本机 Agent 安装](#12-本机-agent-安装)
13. [未来规划](#13-未来规划)

---

## 1. 系统概述

手机和本机均无公网 IP，通过一台公网 VPS 作为中继。手机与本机 Agent 各自主动向中继建立 WebSocket 长连接，中继仅做消息路由，不保存业务状态。本机 AI 进程由 tmux 托管，Agent 进程重启后 AI 会话依然存活。

**核心约束：**

- 手机和本机均无公网 IP → 双端主动连出到中继
- Agent 崩溃重启后 Claude 进程不能死 → tmux 托管 AI 进程
- 只允许单个手机同时连入同一会话 → session 级排他锁
- 需要区分不同主机接入 → host_key + access_token 双层认证
- 手机支持语音输入 → Web Speech API（浏览器原生，无需后端）

---

## 2. 整体架构

```
[手机浏览器 - Safari/Chrome]
  xterm.js 终端渲染
  Web Speech API 语音输入
  会话列表 + Agent 选择 UI
         ↕ WSS (access_token 首次认证 / session_token 重连)
[公网 VPS - 中继服务器]
  WebSocket 路由层
  host 注册表 + session 路由表
  jti 黑名单 + session_token 表（SQLite 持久化）
  nginx TLS 终止 → Node.js 3000 端口
         ↕ WSS (HMAC-SHA256 认证，Mac 主动连出)
[本机 - launchd 常驻]
  Agent 进程 (Node.js)
  ├── Driver 管理层（PtyDriver / BrowserDriver）
  └── 会话表（session_id → tmux session + locked_by）
         ↕ tmux control mode
  tmux server（系统级，独立于 Agent 进程）
  ├── tmux session: airelay-<id_1>  → claude 进程
  ├── tmux session: airelay-<id_2>  → codex 进程
  └── tmux session: airelay-<id_3>  → gemini 进程
```

---

## 3. 包结构

采用 pnpm workspaces monorepo，单个 npm 包 `airelay` 发布，包含所有子命令。

```
airelay/
├── packages/
│   ├── shared/          # 协议类型定义、HMAC/JWT 工具函数
│   ├── relay/           # VPS 中继服务（Node.js + ws）
│   ├── agent/           # 本机 daemon（tmux 控制 + WS 客户端）
│   └── web/             # 手机前端（xterm.js，构建后嵌入 relay）
├── package.json         # pnpm workspaces 根配置
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

`web/` 在构建时被打包进 `relay/dist/public/`，relay 直接 serve 静态文件，不需要额外的静态托管。

**依赖关系：**

```
web      → shared
agent    → shared
relay    → shared
（web 构建产物被 relay serve，无运行时依赖）
```

---

## 4. 组件职责

### 4.1 shared

- 消息类型定义（TypeScript interface）
- `signHmac(secret, payload)` / `verifyHmac(secret, payload, sig, windowSec)`
- `signJwt(hostSecret, payload)` / `verifyJwt(hostSecret, token)`
- 错误码枚举
- Agent 配置文件类型（`AgentDriverConfig`）
- `validateSessionId(id: string): boolean`（UUID v4 正则，供 Agent 入口处拦截注入）

### 4.2 relay（VPS）

- 在 `/ws/agent` 接受本机 Agent 的 WebSocket 连接，验证 HMAC 后注册到 `agents` 表
- 在 `/ws/client` 接受手机的 WebSocket 连接，验证 JWT 后签发 `session_token`，手机凭 `session_token` 重连，不需要重新扫码
- 纯透传：把手机发的消息转给 Agent，把 Agent 发的消息转给绑定的手机
- 维护 jti 黑名单（SQLite 持久化，TTL 到期自动清除，relay 重启不丢失）
- Agent 断线时通知手机；手机断线时通知 Agent 解锁 session
- `GET /` serve 前端静态文件
- `GET /health` 健康检查

### 4.3 agent（本机）

- 启动时读取 `~/.config/airelay/host.key`（host_id + host_secret）
- 主动连接 relay，维持心跳（ping/pong 30s 间隔），断线自动重连（指数退避）
- 重启后执行 `tmux list-sessions -F '#{session_name}'` 并过滤 `airelay-` 前缀，恢复会话表（locked_by 全部重置为 null）
- 接收手机消息前校验 session_id 格式（UUID v4），不合法的消息直接丢弃
- 分发消息到对应 Driver
- 管理 session 级排他锁（`locked_by: connectionId | null`）
- 新建 session 时调用对应 Driver 的 `start()`，订阅 tmux control mode 输出流，实时推给手机
- 连接首次 attach 时分块推送 scrollback（每块 ≤ 64KB，见第 5 节）

### 4.4 web（手机前端）

- 登录页：扫 QR 码后自动填充 relay URL + host_id + token，或手动输入
- 会话列表页：展示所有 session（含 Agent 类型 icon、创建时间、是否被占用）
- 终端页：xterm.js 渲染，顶部显示当前 Agent 名称
- 工具栏：Ctrl+C、Ctrl+D、Tab、Esc、方向键等特殊键快捷按钮
- 语音按钮：按住录音，松开填入输入框（不自动发送，用户确认后手动提交）
- 响应式布局，优先 Safari/Chrome on iOS

---

## 5. 消息协议

所有消息为 JSON，通过 WebSocket text frame 传输。中继透传，不解析业务字段。

### 5.1 手机 → Agent

```jsonc
// 获取可用 Agent 类型列表
{ "type": "list_agent_types" }

// 获取当前所有会话
{ "type": "list_sessions" }

// 新建会话，指定 Agent 类型
{ "type": "new_session", "agent_id": "claude" }

// 接入已有会话
{ "type": "attach", "session_id": "abc123" }

// 发送输入
{ "type": "input", "session_id": "abc123", "data": "ls -la\n" }

// 终端 resize
{ "type": "resize", "session_id": "abc123", "cols": 80, "rows": 30 }

// 主动离开会话（不销毁）
{ "type": "detach", "session_id": "abc123" }
```

### 5.2 Agent → 手机

```jsonc
// Agent 类型列表
{
  "type": "agent_types",
  "agents": [
    { "id": "claude",  "name": "Claude Code",  "icon": "🤖", "available": true },
    { "id": "codex",   "name": "OpenAI Codex", "icon": "⚡", "available": true },
    { "id": "gemini",  "name": "Gemini CLI",   "icon": "💎", "available": true },
    { "id": "pi",      "name": "Pi",           "icon": "🌀", "available": false }
  ]
}

// 会话列表
{
  "type": "sessions_list",
  "sessions": [
    {
      "session_id": "abc123",
      "agent_id": "claude",
      "agent_name": "Claude Code",
      "icon": "🤖",
      "created_at": 1720000000,
      "locked_by": null
    }
  ]
}

// 新建会话成功
{ "type": "session_created", "session_id": "abc123", "agent_id": "claude" }

// attach 成功，携带 scrollback（最近 5000 行，分块发送，每块 ≤ 64KB）
{ "type": "attached", "session_id": "abc123" }
{ "type": "scrollback", "session_id": "abc123", "data": "...", "seq": 0, "done": false }
{ "type": "scrollback", "session_id": "abc123", "data": "...", "seq": 1, "done": true }

// 终端输出（实时流）
{ "type": "output", "session_id": "abc123", "data": "..." }

// AI 进程退出
{ "type": "session_exited", "session_id": "abc123", "code": 0 }

// 错误
{
  "type": "error",
  "code": "SESSION_OCCUPIED" | "SESSION_NOT_FOUND" | "AGENT_NOT_FOUND" | "AGENT_UNAVAILABLE",
  "message": "..."
}
```

### 5.3 中继控制消息（Agent ↔ Relay，不透传到手机）

```jsonc
// Agent 注册（连接建立后立即发送）
{ "type": "agent_hello", "host_id": "uuid", "version": "1.0.0" }

// 中继通知 Agent：手机断开了某个 session
{ "type": "client_disconnected", "session_id": "abc123" }

// 心跳（标准 WebSocket ping/pong，无需业务消息）
```

---

## 6. 安全设计

### 6.1 双层密钥

| 密钥 | 用途 | 保存位置 | 手机可见？ |
|------|------|----------|-----------|
| `host_secret` | Agent 向中继认证，持久 | `~/.config/airelay/host.key` | 否 |
| `access_token` (JWT) | 手机首次接入，一次性 | 扫 QR 码获取，不落盘 | 是，仅一次 |
| `session_token` | 手机断线重连，有 TTL | relay 在 JWT 验证通过后下发，手机 localStorage 存储 | 是 |

### 6.2 Agent → 中继认证（HMAC-SHA256）

每次建立 WebSocket 连接时，Agent 在请求头携带：

```
Authorization: HMAC host_id=<uuid>, ts=<unix_timestamp>, sig=<hex>
```

`sig = HMAC-SHA256(host_secret, "<host_id>:<ts>")`

中继验证：
1. 查找 `host_id` 对应的 `host_secret`
2. 验证 `|now - ts| ≤ 30s`（防重放）
3. 验证 `sig` 正确

### 6.3 手机 → 中继认证（JWT + session_token）

**首次接入（扫码）：**

`access_token` 为 HS256 JWT，由本机 `airelay gen-token` 签发，一次性使用：

```json
{
  "host_id": "uuid",
  "jti": "随机 UUID，防重放",
  "iat": 1720000000,
  "exp": 1720086400
}
```

中继验证步骤：
1. 解码 JWT，找到 `host_id` 对应的 `host_secret`
2. 用 `host_secret` 验证签名
3. 检查 `exp`
4. 检查 `jti` 不在黑名单中，验证通过后立即将 `jti` 写入黑名单（SQLite 持久化）
5. 签发 `session_token`（随机 32 字节 hex，存入 relay SQLite，TTL = 7天），通过首条消息下发给手机

**断线重连（session_token）：**

手机将 `session_token` 存入 `localStorage`，后续所有连接（含断线重连）直接使用：

```
Authorization: Bearer <session_token>
```

中继在 `session_tokens` 表中查找，验证未过期且未吊销。`session_token` 可多次使用，不走 jti 黑名单流程。手机端检测到 WebSocket 断开后自动重连，指数退避（初始 1s，最大 30s），顶部显示重连状态 banner。

### 6.4 传输层

- relay 只监听 127.0.0.1:3000
- nginx 负责 TLS 终止，仅对外暴露 443（WSS + HTTPS）
- HTTP 80 → 301 → HTTPS
- 手机前端读取 URL hash 中的 token 后，立即调用 `history.replaceState(null, '', '/')` 清除，防止 token 留在浏览器历史记录中

### 6.5 首次注册流程

```bash
# 1. Mac 侧生成身份
airelay setup
# 输出：
# host_id: 550e8400-e29b-41d4-a716-446655440000
# host_secret: <32字节hex>
# 在 VPS 上运行以下命令完成注册：
# airelay relay register 550e8400-e29b-41d4-a716-446655440000 <host_secret>

# 2. VPS 侧注册
airelay relay register <host_id> <host_secret>
```

---

## 7. Driver 抽象（多 Agent 支持）

### 7.1 接口定义

```typescript
// packages/agent/src/drivers/types.ts
interface AgentDriver {
  readonly agentId: string;
  start(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  sendInput(sessionId: string, data: string): Promise<void>;
  resize(sessionId: string, cols: number, rows: number): Promise<void>;
  getScrollback(sessionId: string): Promise<string>;
  onOutput(sessionId: string, cb: (data: string) => void): Disposable;
  onExit(sessionId: string, cb: (code: number) => void): Disposable;
}
```

### 7.2 PtyDriver（v1，所有 CLI 类 Agent）

底层用 tmux control mode 获取实时输出，所有 CLI 工具复用同一实现，仅启动命令不同。

**实时输出机制：** Agent 通过 `tmux -C attach-session -t <session_id>` 进入 control mode，tmux 以结构化文本流推送 `%output` 事件，Agent 解析后转发给手机。这是 tmux 官方支持的程序化接口，无需轮询文件。

```typescript
class PtyDriver implements AgentDriver {
  constructor(private config: { agentId: string; command: string; args: string[] }) {}

  async start(sessionId: string) {
    const tmuxId = `airelay-${sessionId}`;
    const cmd = [this.config.command, ...this.config.args].join(' ');
    await exec(`tmux new-session -d -s ${tmuxId} "${cmd}"`);
    this.attachControlMode(sessionId, tmuxId);
  }

  private attachControlMode(sessionId: string, tmuxId: string) {
    // tmux control mode: 每行输出以 %output <pane> <data> 格式推送
    const proc = spawn('tmux', ['-C', 'attach-session', '-t', tmuxId]);
    proc.stdout.on('data', (chunk: Buffer) => {
      const line = chunk.toString();
      if (line.startsWith('%output ')) {
        const data = line.slice(line.indexOf(' ', 8) + 1);  // 跳过 pane id
        this.outputCallbacks.get(sessionId)?.forEach(cb => cb(data));
      } else if (line.startsWith('%session-closed')) {
        this.exitCallbacks.get(sessionId)?.forEach(cb => cb(0));
      }
    });
  }

  async sendInput(sessionId: string, data: string) {
    // 二进制安全：load-buffer + paste-buffer，避免 send-keys 的转义问题
    const tmuxId = `airelay-${sessionId}`;
    const buf = Buffer.from(data).toString('base64');
    await exec(`printf '%s' '${buf}' | base64 -d | tmux load-buffer -`);
    await exec(`tmux paste-buffer -t ${tmuxId}`);
  }

  async getScrollback(sessionId: string) {
    const tmuxId = `airelay-${sessionId}`;
    const { stdout } = await exec(`tmux capture-pane -p -S -5000 -t ${tmuxId}`);
    return stdout;
  }

  async resize(sessionId: string, cols: number, rows: number) {
    const tmuxId = `airelay-${sessionId}`;
    await exec(`tmux resize-window -t ${tmuxId} -x ${cols} -y ${rows}`);
  }
}
```

### 7.3 BrowserDriver（v2 规划，Web 类 Agent）

用 Playwright 控制浏览器，为 Pi、Claude.ai 等无 CLI 的产品提供接入能力。每个目标网站需要单独实现选择器适配层。接口与 PtyDriver 相同，当前版本返回 `available: false`。

### 7.4 Agent 配置文件

`~/.config/airelay/agents.json`：

```json
{
  "agents": [
    {
      "id": "claude",
      "name": "Claude Code",
      "type": "pty",
      "command": "claude",
      "args": [],
      "icon": "🤖"
    },
    {
      "id": "codex",
      "name": "OpenAI Codex",
      "type": "pty",
      "command": "codex",
      "args": [],
      "icon": "⚡"
    },
    {
      "id": "gemini",
      "name": "Gemini CLI",
      "type": "pty",
      "command": "gemini",
      "args": [],
      "icon": "💎"
    },
    {
      "id": "pi",
      "name": "Pi",
      "type": "browser",
      "url": "https://pi.ai",
      "icon": "🌀"
    }
  ]
}
```

`airelay setup` 时自动探测已安装的 CLI（`which claude`、`which codex` 等）并写入此文件。新增 Agent 只需在配置文件中加一行，无需修改代码。

---

## 8. 会话生命周期

```
新建会话
  手机: { type: "new_session", agent_id: "claude" }
  Agent: 生成 session_id (UUID)
       → driver.start(session_id)        # tmux new-session
       → 注册 onOutput 回调
       → sessions[session_id] = { agent_id, locked_by: null, created_at }
       → 回复: { type: "session_created", session_id }
       → 自动执行 attach 流程

Attach 流程
  手机: { type: "attach", session_id }
  Agent: 检查 sessions[session_id].locked_by
       → 若非 null → { type: "error", code: "SESSION_OCCUPIED" }
       → 若为 null → locked_by = connectionId
                   → 推送 { type: "attached", session_id }
                   → 推送 { type: "scrollback", data: await driver.getScrollback() }
                   → 之后 onOutput 回调将 output 实时转发

运行中
  手机 → { type: "input" }    → driver.sendInput()
  手机 → { type: "resize" }   → driver.resize()
  AI 进程输出                  → { type: "output" } → 手机

手机主动断线（WebSocket close）
  中继 → Agent: { type: "client_disconnected", session_id }
  Agent: sessions[session_id].locked_by = null
       → AI 进程继续在 tmux 里运行

Agent 重启
  Agent 启动时: tmux list-sessions -F '#{session_name}'
             → 过滤 airelay- 前缀，恢复 sessions 表（locked_by 全部重置为 null）
             → 重新调用 attachControlMode 订阅各 session 的输出流
             → 重连中继

AI 进程退出（用户 exit 或 Ctrl+D）
  driver.onExit 触发
  Agent: → { type: "session_exited", session_id, code }
       → 从 sessions 表删除
       → 清理 /tmp/rc-<session_id>.log（可选，保留用于审计）
```

---

## 9. CLI 命令

### VPS 侧

```bash
# 初始化中继配置（生成中继自身的密钥存储）
airelay relay init

# 启动中继（生产环境由 systemd 管理，此命令用于调试）
airelay relay start [--port 3000]

# 注册一台本机 Agent
airelay relay register <host_id> <host_secret> [--name "My Mac"]

# 查看已注册的 Agent 主机
airelay relay hosts

# 吊销某主机（该主机的所有 token 立即失效）
airelay relay revoke-host <host_id>
```

### 本机侧

```bash
# 首次配置：交互式引导，生成 host_id/host_secret，输出 VPS 注册命令
airelay setup

# 启动本机 daemon（写入 launchd plist 并 load）
airelay agent start

# 停止 daemon
airelay agent stop

# 查看 daemon 状态和活跃会话
airelay agent status

# 重载 agents.json 配置（无需重启 daemon）
airelay agent reload

# 签发 access_token 并在终端打印 QR 码
airelay gen-token [--ttl 24h]

# 查看有效 token
airelay token list

# 立即吊销某 token
airelay token revoke <jti>
```

### QR 码内容（JSON，Base64 编码后嵌入二维码）

```json
{
  "url": "https://your-vps.example.com",
  "host_id": "550e8400-e29b-41d4-a716-446655440000",
  "token": "eyJhbGciOiJIUzI1NiJ9..."
}
```

手机扫码后自动跳转浏览器，URL 格式：`https://your-vps.example.com/#<base64_payload>`，前端 JS 解析后自动建立 WebSocket 连接。

---

## 10. 手机端 Web UI

### 10.1 页面结构

```
/  登录页（首次或 token 失效时）
   └── QR 扫码后自动跳转，或手动填入 URL + token
   
/sessions  会话列表页
   ├── 顶部：当前主机名 + 连接状态指示
   ├── 列表：每个 session 卡片（icon + agent 名 + 创建时间 + 状态）
   │         被占用的 session 显示为灰色不可点击
   └── FAB（右下角）：新建会话，点开 Agent 选择器

/terminal/:session_id  终端页
   ├── 顶部栏：返回按钮 + Agent icon + session 名 + 断开按钮
   ├── xterm.js 终端（占满剩余高度）
   ├── 特殊键工具栏：Ctrl+C / Ctrl+D / Tab / Esc / ↑↓←→
   └── 输入区：文本框 + 语音按钮 + 发送按钮
```

### 10.2 语音输入

```javascript
// 按住语音按钮开始录音，松开停止，结果填入输入框
const mic = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
mic.lang = navigator.language;   // 跟随系统语言，中文环境自动 zh-CN
mic.interimResults = true;       // 实时显示中间结果

mic.onresult = (e) => {
  const transcript = Array.from(e.results)
    .map(r => r[0].transcript).join('');
  inputBox.value = transcript;
  if (e.results[e.results.length - 1].isFinal) {
    mic.stop();
    inputBox.focus();
  }
};
```

**平台限制：** Web Speech API 在 iOS 上仅 Safari 支持，Chrome on iOS（底层 WebKit）不支持，需在文档和 UI 中注明。Android Chrome 完整支持。

### 10.3 xterm.js 配置要点

- `fontFamily: 'Menlo, Monaco, "Courier New", monospace'`
- `fontSize: 13`（移动端可调）
- `theme`：跟随系统 `prefers-color-scheme`，深色背景 `#1a1a1a`，避免纯黑
- 连接建立后立即 `fit()` 并发送 `resize` 消息同步终端尺寸
- 监听 `orientationchange` 重新 `fit()`

---

## 11. VPS 部署

### 11.1 系统要求

- Ubuntu 22.04 LTS / Debian 12，1核512MB 起
- Node.js 20 LTS
- nginx
- certbot

### 11.2 部署步骤

```bash
# 1. 安装
npm install -g airelay

# 2. 初始化
airelay relay init
# 配置文件写入 /etc/airelay/relay.conf

# 3. nginx 配置
# /etc/nginx/sites-available/airelay
server {
    listen 443 ssl;
    server_name your-vps.example.com;

    ssl_certificate /etc/letsencrypt/live/your-vps.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-vps.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 86400;  # WebSocket 长连接不超时
    }
}

server {
    listen 80;
    server_name your-vps.example.com;
    return 301 https://$host$request_uri;
}

# 4. TLS 证书
certbot --nginx -d your-vps.example.com

# 5. systemd 服务
# /etc/systemd/system/airelay-relay.service
[Unit]
Description=airelay relay
After=network.target

[Service]
ExecStart=/usr/local/bin/airelay relay start
Restart=always
User=nobody
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target

systemctl enable --now airelay-relay
```

---

## 12. 本机 Agent 安装

```bash
# 1. 安装
npm install -g airelay

# 2. 确保 tmux 已安装
brew install tmux   # macOS

# 3. 引导配置
airelay setup
# 交互式填入中继 URL，自动生成 host_id/host_secret
# 输出在 VPS 执行的注册命令

# 4. 在 VPS 上执行注册命令（上一步输出的）
airelay relay register <host_id> <host_secret>

# 5. 启动本机 daemon
airelay agent start
# 写入 ~/Library/LaunchAgents/com.airelay.agent.plist 并 launchctl load

# 6. 生成手机接入 token
airelay gen-token
# 终端显示 QR 码，手机扫码接入
```

---

## 13. 未来规划

### v2 功能

- **BrowserDriver**：用 Playwright 支持 Pi、Claude.ai 等无 CLI 的 Web 类 Agent
- **多主机**：手机选择接入哪台主机（家里的 Mac、公司的 Linux）
- **会话命名**：给 session 起一个有意义的名字（而不是 UUID）
- **文件传输**：从手机上传文件到本机，或从本机下载文件到手机
- **通知推送**：AI 回复完成后给手机发 Web Push Notification

### 技术债

- tmux `send-keys` 对特殊字符转义不完备，v1 用 `paste-buffer` 规避，v2 改用 node-pty 直接写 PTY fd（需要 Agent 和 tmux 的 socket 通信机制调整）
- scrollback 目前按行数缓存（5000行），v2 改为按会话轮次计数，更符合"10轮对话"语义
