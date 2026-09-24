import { defineConfig } from "vitest/config";

// 每筆寫入都會 git commit，測試需要較寬鬆的逾時
export default defineConfig({ test: { testTimeout: 20_000 } });
