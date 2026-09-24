# SubstrateMesh

> Agent 來來去去，模型一代代更替；關於「你」的知識，應該屬於你，並且持續成長。

SubstrateMesh 是一個**個人上下文基質（Personal Context Substrate）**：一個常駐在你自己機器上的中間層，
讓所有 AI agent（Claude Code、opencode、hermes、loom…）透過 MCP 共同讀取、共同提交關於使用者的知識，
並由守門人 **Keeper** 審查、整理、代謝，使它成為能用很久很久的個人數位資產。

- **Agent 只能提案**（記憶 PR），不能直接改寫你。
- **Keeper 守門**：審查、合併、拒絕、延後、上呈；不能合併自己的提案，不能動憲法層。
- **你是最終權威**：憲法層只有你能改。
- **正本是純文字 + git**：程式可以重寫十次，記憶不動。

## 文件

- [願景](docs/VISION.md) — 為什麼要做、核心信念、刻意不做的事
- [架構](docs/ARCHITECTURE.md) — 分層、資料模型、記憶 PR、MCP 介面、Keeper、部署
- [決策紀錄](docs/DECISIONS.md) — 已拍板的決策與仍待討論的問題

## 快速開始

需要 Node.js 20 以上與 git。

```bash
npm install && npm run build
npm link                                   # 取得 substrate 指令（或用 node dist/cli.js）

substrate init ~/substrate-vault           # 建立 vault（獨立的 git repo，建議推到私有遠端備份）
```

在 `~/substrate-vault/constitution/` 寫下你的憲法層（見該資料夾的 README）。

### 方式一：stdio（單一 agent，開發用）

```bash
claude mcp add substrate -- substrate serve --stdio --agent claude-code --vault ~/substrate-vault
```

### 方式二：常駐 daemon（多 agent，建議）

```bash
substrate token add claude-code            # 每個 agent 一個 token，只顯示一次
substrate token add loom --clearance card  # 揭露權限：card | profile | private
substrate token add keeper --role keeper

substrate serve --http --port 7077         # 預設只綁 127.0.0.1；遠端請經 Tailscale 並設定 --host

claude mcp add --transport http substrate http://127.0.0.1:7077/mcp \
  --header "Authorization: Bearer <token>"
```

- Token 設定檔預設在 `~/.config/substrate/tokens.json`，**不在 vault 內**，且只保存 SHA-256 雜湊。
- Agent 的身分、角色與揭露權限由 token 決定，agent 無法自報為 Keeper。
- 可選的 `X-Substrate-Session` header 會記錄在提案證據中，方便追溯。
- stdio 模式下若多個 agent 各自啟動行程寫入同一個 vault，git 可能短暫鎖定（已有重試）；多 agent 請用 daemon。

### 審查記憶 PR

```bash
substrate proposals                        # 待審清單（--status escalated|deferred|all）
substrate proposals show <id>
substrate proposals merge <id> --note "理由" [--layer constitution]
substrate proposals reject <id> --note "理由"
substrate views                            # 重建 views/ 下給人閱讀的主題視圖
```

### Keeper（排程的 headless Claude Code）

Keeper 的角色規格在 vault 的 `.keeper/KEEPER.md`，審查準則在 `.keeper/policy.yaml`。
以 keeper token 設定一份 MCP 設定檔後，由排程（例如 launchd／cron）定期執行：

```bash
claude -p "你是 SubstrateMesh 的 Keeper。先閱讀 ~/substrate-vault/.keeper/KEEPER.md 與 policy.yaml，然後執行一次審查流程，最後整理需要使用者判斷的事項。" \
  --mcp-config ~/.config/substrate/keeper-mcp.json
```

## MCP 工具

| 工具 | 誰可用 | 用途 |
|---|---|---|
| `get_context` | 全部 | 依任務回傳關於使用者的精簡索引（憲法層優先） |
| `recall` | 全部 | 以 id 或關鍵字調閱細節與證據原話 |
| `propose_memory` | 全部 | 提交記憶 PR |
| `record_example` | 全部 | 保存使用者完整接受的優秀產出 |
| `list_proposals`／`show_proposal` | Keeper | 檢視提案 |
| `merge_proposal`／`reject_proposal`／`defer_proposal`／`escalate_proposal` | Keeper | 裁決 |
| `comment_proposal`／`expire_memories` | Keeper | 討論與代謝 |

連線時，server 會透過 MCP `instructions` 動態注入「畫像使用守則」、「何時提交記憶」與名片等級的核心摘要。

## 開發

```bash
npm run typecheck
npm test
```
