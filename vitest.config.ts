import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setupGlobals.ts", "./tests/setupTests.ts"],
    globals: true,
    /**
     * 重型表单测试的天花板，不是随手调大的数。
     *
     * vitest 默认 testTimeout 是 5000ms，而本机（32 核、冷启动后）实测就有 6 个用例
     * 超过 2s、最长约 3.8s（PiProviderForm / ProviderForm.codexManagedAccount 这类
     * 十几步 userEvent 链）。CI 的 ubuntu runner 只有 4 核，同一套全量在这里 42s、
     * 在那边 129s —— 约 3 倍负载，于是这些用例会越过 5s 被**误判**成超时：
     * 617cebca 的 CI 就是这样红了 `PiProviderForm > edits Pi thinking-map …`
     * （本机 1.8s，CI "Test timed out in 5000ms"），与 App.test.tsx 历史上反复
     * 出现的两条超时是同一类问题。
     *
     * 20s 给足 3 倍负载以上的余量，同时真挂死的用例仍然会结束，只是慢一点；
     * 不去逐条加 timeout 是因为这条线整族都在同一侧，漏一条就再红一次 CI。
     */
    testTimeout: 20_000,
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
