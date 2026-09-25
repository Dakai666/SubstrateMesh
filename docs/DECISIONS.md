# 決策紀錄

## 已決定（2026-09-24）

| # | 主題 | 決定 | 理由 |
|---|---|---|---|
| D1 | 定位 | 個人上下文基質；不做 Observer、不做 Orchestrator | 劃清邊界才能長壽；協作是 agent 框架的事 |
| D2 | 治理 | Agent 提案 → Keeper 守門 → 使用者最終權威 | 防止記憶被幻覺與一次性情緒污染 |
| D3 | 分層 | 憲法／偏好／經驗／原始，權限隨層遞減 | 兼顧「長期不變」與「自我迭代」 |
| D4 | 範圍 | 「關於我」優先，工作與專案逐步擴展 | 價值密度最高 |
| D5 | 首要 client | 先以 Claude Code 為基礎；之後 opencode、hermes、loom（皆支援 MCP） | |
| D6 | 儲存正本 | Git + 純文字檔；SQLite 僅為可重建索引 | 人類可讀、git 即審計、格式最長壽 |
| D7 | 程式與記憶分離 | `SubstrateMesh`（程式）與私有 `vault`（記憶）兩個 repo | 程式可重寫，記憶不動 |
| D8 | 檔案顆粒度 | 一條知識一檔 + 自動生成主題視圖 | diff 乾淨、出處可追溯 |
| D9 | 技術棧 | TypeScript | MCP SDK 成熟，貼近 Claude Code／opencode 生態 |
| D10 | Keeper 形式 | 排程啟動的 headless Claude Code + `KEEPER.md` 規格 | 最快落地；規格不綁模型 |
| D11 | 提交機制 | 第一版只做 MCP 主動提交，並記錄提交情況 | 先觀察品質，再決定是否加 hook |
| D12 | 讀取路徑 | 純 MCP 拉取；以 MCP `instructions` 動態提供核心摘要 | 單一來源，不改各 agent 設定 |
| D13 | 審查系統 | 自建輕量 PR 系統；資料格式先行，UI 後補 | 不依賴 GitHub 等外部平台的存續 |
| D14 | 通知 | 暫不做即時通知；以定期檢閱／主動邀請 Keeper 為主 | 視日後狀況再選管道 |
| D15 | 冷啟動 | 訪談 → 匯入各 agent 記憶 → 匯入對話歷史 → 對帳 | 依來源信任度由高到低 |
| D16 | 部署 | 使用者 7x24 的 Mac；遠端經 Tailscale | |
| D17 | `get_context` | 只給索引與摘要，細節由 agent 以 `recall` 自行調閱 | 保持簡單 |
| D18 | 衝突判定 | 個案直接與使用者討論；Keeper 先給情境判斷 | |
| D19 | 基準測試 | 不定期的輕量使用者記憶基準測試，採反巴納姆原則 | 衡量「AI 更懂我」 |
| D20 | 口吻 | 知識區分 stated／observed／inferred；推測不得進憲法層 | 懂但不自以為懂 |
| D21 | 默契 | 新增 `calibration` 類型：紅線以外的授權隨證據成長 | 默契是長出來的 |
| D22 | 揭露分級 | card／profile／private；名片 → 數位自傳 | 同一份 vault 依對象投影 |
| D23 | Agent 觀點 | 寫在提案的 `rationale`；以 `scope.agents` 容納「差別待遇」 | 不強求單一真相、不同質化各 agent |
| D24 | 問卷收集 | 盲測問卷交給各 AI；回覆經 `substrate import` 轉為提案，原文存於 raw/imports | 第三方轉述不建議入憲法層、推測信心度上限 0.6 |
| D25 | 關鍵字檢索 | CJK 單字（低權重）+ 二字組、常用簡繁正規化、英文輕度詞形還原，BM25 計分；比對範圍含 claim、領域／情境、類型中文名、內文、證據原話；低於最高分 25% 的結果視為雜訊 | 零依賴；跨語言與同義詞需語意檢索（本地 embedding）補足 |
| D26 | 語意檢索 | 選用的本地 embedding（Ollama／OpenAI 相容端點，環境變數設定）；BM25 以最高分正規化，cosine 低於絕對下限（預設 0.4）視為 0、其餘在〔下限, 最高〕間線性映射，兩者以 α=0.5 加權；25% 相對門檻套在合併分數上。向量以內容 hash 快取於 vault `.index/`（不進 git、不經 MCP 暴露），對全部 active 條目建立，計分只限可見條目；連不上時退回純 BM25 並暫停 60 秒 | 語意只加分不扣分：實測 `SOUL.md`、`喵吉` 等專有名詞的正確命中 cosine 低於下限，拿 cosine 否決 BM25 會誤殺。下限依 qwen3-embedding:0.6b 在實際 vault 上校準（相關 0.40–0.55、無關 ≤ 0.39），換模型需重新校準 |
| D27 | 標籤與關聯 | 條目新增 `tags` 與 `links`（derived_from／contradicts／refines／example_of／related）；雙向關係只存一端。新增 `relink` 提案（只改標籤與關聯），agent 以 `propose_links` 提出；`recall` 支援標籤篩選並附一跳關聯，張力優先顯示。關聯只從呼叫者可見的條目取；提交時看不到與不存在的目標回報相同訊息。Keeper 以 `suggest_links`（embedding 預設 0.72，BM25 0.15；依實際 vault 校準）與 `list_tags`（同義候選 0.68）整理，確認後仍走提案 | 落實「記錄張力與例外」；整理工具只列候選，不直接改寫，維持職責分離。單詞標籤的 embedding 相似度不可靠（實測 life/loom > 寫作/writing），因此同義標籤不自動合併 |

## 實作狀態

- **v0.1**（2026-09-24）：vault 讀寫與 git 自動提交、記憶 PR 全流程與硬性不變式、
  MCP server（stdio／HTTP + bearer token）、動態 instructions、CLI 審查、主題視圖、Keeper 規格範本。
  尚未實作：SQLite 索引（目前逐檔掃描，個人規模足夠）、web 審查 UI、敘事視圖、基準測試、對話歷史匯入。問卷回覆匯入已於 D24 加入。

## 待討論

- [x] `get_context` 的組裝策略：層級優先，層內以 BM25 + 語意混合分數排序（D25、D26）
- [ ] 知識衝突的判定方法：語意重疊與 scope 交集如何偵測（D27 先以 `suggest_links` 列候選、由 Keeper 判斷）
- [ ] Keeper 排程頻率與每次運作的成本上限
- [ ] vault 的遠端備份位置與加密方式
- [ ] 多 agent 同時寫入 proposals 時的 git 提交策略（daemon 批次 commit）
- [ ] 敏感資訊的 scope／權限模型（哪些 agent 能讀哪些層、哪些領域）
- [ ] 如何衡量「AI 更懂我」：例如每個 session 的糾正次數趨勢
- [x] vault repo 命名：SubstrateMesh_mine（私有）
- [ ] 威脅模型：vault 含個資，需以資安標準設計（加密、存取控制、MCP 認證、稽核）
- [ ] 敘事視圖（數位自傳）的生成方式與頻率
