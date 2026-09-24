# 憲法層

這個資料夾只有**你本人**能修改。Keeper 與 agent 只能讀取，最多透過記憶 PR「建議你考慮修改」。

每個檔案一個主題，例如：

- `identity.md` — 你是誰
- `autonomy.md` — 自主邊界與紅線：什麼事永遠要先問
- `principles.md` — 原則與禁區
- `goals.md` — 長期目標

檔案可加上 frontmatter 控制揭露分級（預設 `profile`）：

```markdown
---
title: 自主邊界與紅線
disclosure: card   # card 名片｜profile 畫像｜private 私密
---
```

`card` 等級的內容會在每個 agent 連線時自動注入，請保持精簡。
