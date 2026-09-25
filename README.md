# SubstrateMesh

> Agent 來來去去，模型一代代更替；關於「你」的知識，應該屬於你，並且持續成長。

SubstrateMesh 是一個**個人上下文基質（Personal Context Substrate）**：一個常駐在你自己機器上的中間層，
讓所有 AI agent（Claude Code、opencode、hermes、loom…）透過 MCP 共同讀取、共同提交關於使用者的知識，
並由守門人 **Keeper** 審查、整理、代謝，使它成為能用很久很久的個人數位資產。

- **Agent 只能提案**（記憶 PR），不能直接改寫你。
- **Keeper 守門**：審查、合併、拒絕、延後、上呈；不能自行合併自己的提案（使用者同意並開了審查時段授權時例外），不能動憲法層。
- **你是最終權威**：憲法層只有你能改。
- **正本是純文字 + git**：程式可以重寫十次，記憶不動。

## 文件

- [願景](docs/VISION.md) — 為什麼要做、核心信念、刻意不做的事
- [架構](docs/ARCHITECTURE.md) — 分層、資料模型、記憶 PR、MCP 介面、Keeper、部署
- [決策紀錄](docs/DECISIONS.md) — 已拍板的決策與仍待討論的問題
- [畫像收集問卷](docs/questionnaire.md) — 交給不同 AI 回答，匯入後對帳、擴充與糾錯

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

### 語意檢索（選用）

預設以 BM25 關鍵字檢索。若本機有 embedding 模型（例如 Ollama），設定環境變數即可混合語意相似度，
補足跨語言（英文查詢、中文記憶）與換句話說：

```bash
ollama pull qwen3-embedding:0.6b
SUBSTRATE_EMBED_URL=http://127.0.0.1:11434 \
SUBSTRATE_EMBED_MODEL=qwen3-embedding:0.6b \
  substrate serve --http
```

- embedding 只在本機計算；向量快取在 vault 的 `.index/`（不進 git、不經 MCP 對外）。
- 連不上模型時自動退回純 BM25，不會讓查詢失敗。
- 以 launchd 常駐時，把變數加進 plist 的 `EnvironmentVariables`，再以 `launchctl bootout` + `bootstrap`
  重新載入（`kickstart -k` 不會重讀 plist）。
- 可調參數與校準方式見 [D26](docs/DECISIONS.md)；換模型需要重新校準 `SUBSTRATE_EMBED_MIN_COSINE`。

### 審查記憶 PR

```bash
substrate proposals                        # 待審清單（--status escalated|deferred|all）
substrate proposals show <id>
substrate proposals merge <id> [<id> ...] --note "理由" [--layer constitution]
substrate proposals reject <id> --note "理由"
substrate views                            # 重建 views/ 下給人閱讀的主題視圖
```

### 標籤與關聯

知識條目可以帶 `tags` 與 `links`（`derived_from` 源自、`contradicts` 張力、`refines` 細化、
`example_of` 範例、`related` 相關）。`recall` 命中時會附上一跳關聯，張力排在最前；
看不到的條目不會經由關聯露出。agent 以 `propose_links` 提出調整，同樣經 Keeper 審查。

```bash
substrate links suggest                    # 相似但尚未建立關聯的條目對（候選，需判斷）
substrate tags                             # 標籤詞彙表與可能的同義標籤
```

### 從其他 AI 收集畫像

把 [問卷](docs/questionnaire.md) 交給各個 AI，回覆存檔後匯入：

```bash
substrate import replies/chatgpt.md --source chatgpt
```

### Keeper

Keeper 的角色規格在 vault 的 `.keeper/KEEPER.md`，審查準則在 `.keeper/policy.yaml`
（正本是本 repo 的 `templates/`，更新後需同步到 vault，見 [AGENTS.md](AGENTS.md)）。

可以在本 repo 資料夾以 keeper token 連線的 Claude Code 隨需擔任，也可以由排程（例如 launchd／cron）定期執行：

```bash
claude -p "你是 SubstrateMesh 的 Keeper。先閱讀 ~/substrate-vault/.keeper/KEEPER.md 與 policy.yaml，然後執行一次審查流程，最後整理需要使用者判斷的事項。" \
  --mcp-config ~/.config/substrate/keeper-mcp.json
```

## MCP 工具

| 工具 | 誰可用 | 用途 |
|---|---|---|
| `get_context` | 全部 | 依任務回傳關於使用者的精簡索引（憲法層優先） |
| `recall` | 全部 | 以 id、關鍵字或標籤調閱細節與證據原話，附一跳關聯 |
| `propose_memory` | 全部 | 提交記憶 PR（可帶標籤與關聯） |
| `propose_links` | 全部 | 只調整既有知識的標籤或關聯 |
| `list_tags` | 全部 | 可見知識的標籤詞彙與次數 |
| `record_example` | 全部 | 保存使用者完整接受的優秀產出 |
| `list_proposals`／`show_proposal` | Keeper | 檢視提案 |
| `merge_proposal`／`reject_proposal`／`defer_proposal`／`escalate_proposal` | Keeper | 裁決 |
| `comment_proposal`／`expire_memories` | Keeper | 討論與代謝 |
| `suggest_links` | Keeper | 相似但尚未建立關聯的條目對 |

連線時，server 會透過 MCP `instructions` 動態注入「畫像使用守則」、「何時提交記憶」與名片等級的核心摘要。

## 開發

```bash
npm run typecheck
npm test
```

協作規約（含 `dist/` 與常駐 daemon 的部署陷阱）見 [AGENTS.md](AGENTS.md)。
