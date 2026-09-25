# 架構（草案）

## 1. 角色

```
Agents（提交者）  ──提案──►  Keeper（守門人）  ──上呈──►  使用者（最終權威）
Claude Code / opencode        審查・裁決・代謝             定期檢閱／不定期邀請
hermes / loom                 服務查詢
```

- **Agent**：透過 MCP 讀取上下文、提交記憶 PR。不能直接改寫知識。
- **Keeper**：一個**角色規格**（`.keeper/KEEPER.md`），不綁定模型。第一版由排程啟動的 headless Claude Code 擔任。
- **使用者**：大部分時間不介入；透過定期任務或主動邀請 Keeper，一起檢閱上呈的項目。

**職責分離**：Keeper 自己觀察到的東西也必須走一般提交流程，不得自己提交、自己合併。

## 2. 可變性分層

核心設計不是目錄，而是「**每一層知識，誰有權修改**」。

| 層 | 內容 | 誰能改 |
|---|---|---|
| **憲法層** | 身分、自主邊界、原則與禁區、長期目標、價值取捨 | 只有使用者。Keeper 只能建議 |
| **偏好層** | 表達風格、反模式、決策風格、能力地圖、技術環境 | Agent 提案 → 符合門檻則 Keeper 自動合併，可撤回 |
| **經驗層** | 糾正、lesson learned、優秀範例、當前焦點（含 TTL） | Agent 提案 → 格式與證據合格即合併 |
| **原始層** | 提案所附的原話、事件紀錄 | 僅追加，永不修改 |

代謝方向：經驗 →（晉升）→ 偏好 →（僅能建議）→ 憲法；偏好長期被推翻 →（降級）→ 有條件的規則。

## 3. 儲存：兩個 repo

- `SubstrateMesh`：程式碼（daemon、MCP server、Keeper 規格範本）。
- `vault`：**記憶本體**，私有 git repo，放在使用者的 Mac 上，並另外備份到遠端。

正本為純文字檔；SQLite 只當**可隨時重建的索引**。

```
vault/
├── constitution/          # 憲法層（使用者親筆）
│   ├── identity.md
│   ├── autonomy.md
│   ├── principles.md
│   └── goals.md
├── memory/                # 偏好層與經驗層：一條知識一個檔
│   └── mem_<ulid>.md
├── projects/<name>/       # 專案工作區
├── raw/YYYY-MM.jsonl      # 原始事件，append-only
├── proposals/             # 記憶 PR（狀態寫在檔內，不以資料夾搬移）
│   └── prop_<ulid>.md
├── views/                 # 自動生成的主題視圖（給人閱讀，勿手改）
└── .keeper/
    ├── KEEPER.md          # 守門人規格
    └── policy.yaml        # 自動合併門檻、TTL、來源信任度
```

## 4. 資料模型

### 知識條目 `memory/mem_<ulid>.md`

```yaml
---
id: mem_01J8...
layer: preference            # constitution | preference | experience
kind: preference             # preference | fact | principle | lesson | example | focus | calibration
voice: stated                # stated（使用者說的）| observed（觀察到的）| inferred（推測的）
claim: "回覆程式問題時，先給結論再展開細節"
scope:
  domain: coding
  contexts: [code-review]
  agents: ["*"]              # 適用哪些 agent；同一偏好可只對特定 agent 成立
disclosure: card             # card（名片）| profile（畫像）| private（自傳/私密）
confidence: 0.8
status: active               # active | superseded | archived
valid_from: 2026-09-24
valid_until: null            # 失效時間（人會改變，舊知識標記為過去而非刪除）
ttl: null                    # 例如當前焦點可設 30d
supersedes: []
tags: [coding, review]       # 自由標籤，正規化為小寫
links:                       # 與其他條目的關聯
  - to: mem_01J7...
    rel: derived_from        # derived_from | contradicts | refines | example_of | related
    note: "源自那次 review 被退件"
evidence:
  - proposal: prop_01J8...
    source: claude-code/session_xxx
    quote: "這段太長了，以後開頭先給結論"
    at: 2026-09-24T10:12:00+08:00
---
（可選）補充說明
```

### 記憶 PR `proposals/prop_<ulid>.md`

```yaml
---
id: prop_01J8...
status: pending              # pending | merged | rejected | deferred | escalated
proposer: claude-code
submitted_at: 2026-09-24T10:15:00+08:00
action: create               # create | update | supersede | archive
target: null                 # update/supersede 時指向 mem_...
claim: "..."
kind: preference
suggested_layer: preference
voice: observed
scope: { domain: coding, contexts: [code-review], agents: ["*"] }
confidence: 0.7
rationale: "提交者的觀點與推論理由（agent 的聲音記錄於此）"
evidence:
  - source: claude-code/session_xxx
    quote: "..."
    at: ...
resolution: null             # 合併後指向 mem_...；拒絕時寫理由
---

## Thread
<!-- Keeper 與使用者的審查討論，依時間追加 -->
```

- **被拒絕的提案保留**，避免同樣的錯誤推論被不同 agent 反覆提交。
- **沒有原話證據的提案**，Keeper 應降低權重。
- **`rationale` 是 agent 的觀點**。不同 agent 對使用者的觀察不一致，未必是錯誤——
  可能是使用者對不同 agent 本來就有不同期待（以 `scope.agents` 表達），不強求單一真相。

### 三種口吻（voice）

| voice | 意義 | 限制 |
|---|---|---|
| `stated` | 使用者親口說的 | 信任度最高 |
| `observed` | 由行為觀察到的 | 需多次獨立證據才能進偏好層 |
| `inferred` | Agent 的推測 | **永遠不能進入憲法層**；對外提供時必須標示為推測 |

### 默契校準（calibration）

紅線（永遠要問的事）屬於憲法層；紅線以外「哪些是瑣事可自行判斷」則是**會成長的記憶**。
`calibration` 條目依領域記錄「agent 自行判斷後的結果」，證據累積越多，該領域的授權範圍越大——
默契是**證據驅動的授權擴張**，而非一次定死的規則。

### 揭露分級（disclosure）

同一份 vault 依對象投影出不同深度：

- `card`（名片）：初次接觸的 agent 即可取得的基本認識。
- `profile`（畫像）：長期合作的 agent。
- `private`（自傳／私密）：僅限使用者明確授權的 agent 與 Keeper。

## 4.1 畫像使用守則（隨 MCP instructions 提供給所有 agent）

目標是「懂使用者，但不自以為懂」：

1. 畫像是**先驗**，不是**判決**；傾向不等於規則。
2. 風險高或不確定時，仍然要問。
3. **用畫像去做，不要拿畫像來說。** 不要以「我知道你喜歡…」來證明自己懂。
4. 推測（`inferred`）不得當成事實陳述。
5. 記錄張力與例外；不要把矛盾抹平成單一標籤。

## 5. 記憶 PR 生命週期

```
提交 ──► pending ──► Keeper 審查 ──┬─► merged     寫入 memory/，resolution 指向條目
                                   ├─► rejected   保留紀錄與理由
                                   ├─► deferred   等更多獨立證據
                                   └─► escalated  涉及憲法層或衝突 → 等使用者裁決
```

預設門檻（`policy.yaml`，可調）：

- **經驗層**：格式合法 + 附原話 → 合併。
- **偏好層**：≥ 2 個獨立 session 的證據，且與現有知識不衝突 → 自動合併；否則 `deferred`。
- **衝突**或**觸及憲法層** → 一律 `escalated`。

自建輕量 PR 系統的原則：**資料格式先行，UI 後補**。PR 本身就是 vault 裡的檔案，git 歷史即審查紀錄；
即使任何外部平台消失也照常運作。第一版以 CLI 與「和 Keeper 對話」審查，之後再由 daemon 提供 web UI。

## 6. MCP 介面

### 一般 agent

| 工具 | 用途 |
|---|---|
| `get_context(task, budget)` | 依任務與 token 預算組裝關於使用者的上下文 |
| `recall(query)` | 查詢特定主題，附出處與信心度 |
| `propose_memory(...)` | 提交記憶 PR |
| `record_example(...)` | 記錄一份使用者接受的優秀產出 |
| `propose_links(target, ...)` | 提出標籤或關聯調整（不改主張） |
| `list_tags()` | 可見條目的標籤詞彙與次數 |

`get_context` 只回傳**索引與摘要**；細節由 agent 自行以 `recall` 調閱，保持簡單。

**標籤與關聯**（D27）：`recall` 可依 `tags` 篩選；命中的條目會附上一跳關聯的一行摘要，
`contradicts` 標示為「⚠ 張力」並排在最前。`contradicts` 與 `related` 是雙向關係，只存一端、兩端都顯示。
關聯同樣經過揭露權限過濾：看不到的條目不會經由關聯露出，連 id 都不會。
agent 以 `propose_links`（`relink` 提案）調整標籤與關聯；Keeper 以 `suggest_links`、`list_tags` 整理。

**檢索**：BM25 關鍵字（D25）為基礎；設定本地 embedding 端點後，與語意相似度混合（D26），
補足跨語言（英文查詢、中文記憶）與換句話說。embedding 只在本機計算，連不上時自動退回純 BM25。

```sh
SUBSTRATE_EMBED_URL=http://127.0.0.1:11434 SUBSTRATE_EMBED_MODEL=qwen3-embedding:0.6b substrate serve --http
```

**讀取路徑 = 純 MCP 拉取。** daemon 在連線時透過 MCP `instructions` 欄位動態提供一份**精簡核心摘要**
（語言、自主邊界、反模式、如何與何時提交記憶），支援的 client（如 Claude Code）會自動注入系統提示；
細節再以 `get_context` / `recall` 取得。不修改各 agent 的設定檔，單一來源。

**提交路徑 = 第一版只做 MCP 主動提交。** 工具描述本身即教材，寫明何時該提交：
使用者糾正你、明確表達偏好、完整接受你的產出而未修改。
第一版需**記錄每個 session 的提交情況**，用以評估是否需要加入 hook 安全網。

### Keeper 專用（一般 agent 不可見）

`list_proposals`、`review`、`merge`、`reject`、`defer`、`escalate`、`consolidate`、`suggest_links`

## 7. Keeper

- 規格：`.keeper/KEEPER.md`（審查標準、分層規則、裁決權限）+ `policy.yaml`。
- 職責：審查 → 裁決 → 代謝（晉升/降級/封存/TTL 到期）→ 整理「需要使用者判斷的少數事項」→ 服務查詢。
- 代謝的安全規則：
  - 整理只產生**新版本**，不覆寫原始證據。
  - 每條濃縮出的知識都必須能**追溯到原始證據**。
  - 定期**從原始證據重新提煉**，而非在上一版摘要上反覆疊加（避免複利式失真）。

## 8. 冷啟動

依信任度由高到低：

1. **Keeper 結構化訪談**：建立憲法層與偏好層基準（信任度最高）。
2. **匯入各 agent 既有記憶與設定檔**（CLAUDE.md、AGENTS.md、opencode/hermes/loom 指令）→ 轉為提案。
3. **匯入對話歷史**（Claude Code 本機紀錄、各平台匯出檔）→ 轉為提案（信任度最低）。
4. Keeper 以訪談結果為基準**對帳**，衝突上呈使用者裁決。

### 訪談骨架（依對 agent 的價值排序）

1. 自主邊界：什麼可直接做、什麼必須先問
2. 反模式：討厭 AI 的哪些行為
3. 決策風格：要選項還是直接建議
4. 能力地圖：精通／熟悉／陌生
5. 表達偏好：語言、語氣、格式
6. 當前焦點（短 TTL）
7. 技術環境：OS、語言、慣用套件、程式風格
8. 價值取捨：速度 vs 品質、實驗 vs 穩定
9. 專案地圖：各專案之間的關係
10. 長期目標、原則與禁區

## 9. 部署

```
┌──────────── 使用者的 Mac（7x24）────────────┐
│  substrated（TypeScript 單一 daemon）        │
│   ├─ MCP server（HTTP，多 agent 同時連線）    │
│   ├─ vault 讀寫 + SQLite 索引                 │
│   └─ 排程器 → 定期喚醒 Keeper                 │
└──────────────────────────────────────────────┘
   ▲ 本機：Claude Code / opencode / loom / hermes
   ▲ 遠端：經 Tailscale 連入
```

## 10. 使用者記憶基準測試（Memory Bench）

不定期出考卷，直接考各 agent 對使用者的理解，也反過來檢驗記憶本身的品質。

- **反巴納姆原則**：答案必須具體、可證偽、能區分「這個使用者」與「一般人」。
  放諸四海皆準的回答（「你重視深度思考」）一律零分。
- **好題目必須能被答錯**：以情境判斷題為主，而非形容詞題。
- 若某題各 agent 普遍答錯，優先懷疑**記憶寫得不好**，而非 agent 沒讀。
- 題庫本身也存於 vault，隨畫像演化。

