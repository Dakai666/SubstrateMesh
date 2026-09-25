# SubstrateMesh — agent 協作規約

所有在這個 repo 工作的 agent（Claude Code、Codex、opencode…）都遵守這份文件。`CLAUDE.md` 只是引用它。

## 開發

- `npm run typecheck`、`npm test`（vitest）、`npm run build`（輸出 `dist/`）。
- 設計與決策寫在 `docs/ARCHITECTURE.md` 與 `docs/DECISIONS.md`（新決策依序編號 D<n>）。
- 程式註解、文件、提交訊息使用繁體中文；識別字與技術名詞用英文。
- 私下暱稱不得出現在任何 commit、PR、issue、文件或程式碼中；一律寫「Loom」或「Loom Agent」。

## 部署陷阱

- 本機常駐 daemon（launchd `local.substrate.daemon`）與 `substrate` CLI **直接執行這個資料夾的 `dist/cli.js`**。
  在功能分支上 `npm run build`，等於把尚未合併的程式交給正式環境（daemon 重啟時就會載入）。
  需要實際跑程式時用 `npx tsx src/cli.ts ...`；build 只在 main 上做。
- 不要自行重啟或停止 daemon：那是 agent 賴以運作的環境，由使用者執行。

## Keeper 規格：正本與同步

- `templates/KEEPER.md` 與 `templates/policy.yaml` 是 Keeper 規格的**正本**。`substrate init` 只在 vault
  沒有這兩個檔時才複製，之後不會自動更新。
- 修改範本、且變更已合併到 main 之後，要同步到使用者 vault 的 `.keeper/`（預設 `~/substrate-vault`，
  或 `$SUBSTRATE_VAULT`），並在 vault 另外提交。先確認差異：

  ```sh
  diff templates/KEEPER.md ~/substrate-vault/.keeper/KEEPER.md
  diff templates/policy.yaml ~/substrate-vault/.keeper/policy.yaml
  ```

  vault 端若有使用者自行修改的內容，要合併而不是覆蓋。
- 新增或修改 Keeper 工具（`src/server.ts` 的 `registerReviewTools`）時，要一併更新 `templates/KEEPER.md`，
  讓規格與實際可用的工具一致。

## 擔任 Keeper

在這個資料夾被要求「審查」或「當 Keeper」時：

1. 先讀 vault 的 `.keeper/KEEPER.md` 與 `.keeper/policy.yaml`，依其流程運作。
2. 裁決一律透過 MCP 的 Keeper 工具（`merge_proposal`、`reject_proposal` 等）。**不要用
   `substrate proposals merge/reject` CLI**：CLI 以使用者身分執行，會繞過 Keeper 的硬性不變式
   （不能合併自己的提案、不能動憲法層）。
3. vault 的遠端備份（push）由使用者決定，不要自行推送。
