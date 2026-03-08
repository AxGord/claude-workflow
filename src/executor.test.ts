import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Executor } from "./executor.js";
import type { StateDefinition } from "./types.js";

describe("Executor", () => {
  let executor: Executor;

  beforeEach(() => {
    executor = new Executor();
  });

  describe("exec", () => {
    it("runs successful command", async () => {
      const state: StateDefinition = { type: "exec", command: "echo hello" };
      const result = await executor.execute(state, {});
      expect(result.success).toBe(true);
      expect(result.type).toBe("exec");
      expect(result.stdout).toContain("hello");
      expect(result.exit_code).toBe(0);
    });

    it("captures stderr", async () => {
      const state: StateDefinition = { type: "exec", command: "echo err >&2" };
      const result = await executor.execute(state, {});
      expect(result.success).toBe(true);
      expect(result.stderr).toContain("err");
    });

    it("reports failure for non-zero exit", async () => {
      const state: StateDefinition = { type: "exec", command: "exit 42" };
      const result = await executor.execute(state, {});
      expect(result.success).toBe(false);
      expect(result.exit_code).toBe(42);
    });

    it("respects timeout", async () => {
      const state: StateDefinition = { type: "exec", command: "sleep 60", timeout: 100 };
      const result = await executor.execute(state, {});
      expect(result.success).toBe(false);
    }, 5000);

    it("truncates output > 10KB", async () => {
      // Generate ~15KB of output
      const state: StateDefinition = {
        type: "exec",
        command: "python3 -c \"print('x' * 15000)\"",
      };
      const result = await executor.execute(state, {});
      expect(result.success).toBe(true);
      expect(result.stdout!.length).toBeLessThanOrEqual(10 * 1024 + 20); // 10KB + truncation marker
      expect(result.stdout).toContain("...[truncated]");
    });

    it("substitutes template vars in command", async () => {
      const state: StateDefinition = { type: "exec", command: "echo {{name}}" };
      const result = await executor.execute(state, { name: "test_value" });
      expect(result.stdout).toContain("test_value");
    });

    it("passes env vars", async () => {
      const state: StateDefinition = {
        type: "exec",
        command: "echo $MY_VAR",
        env: { MY_VAR: "{{val}}" },
      };
      const result = await executor.execute(state, { val: "hello_env" });
      expect(result.stdout).toContain("hello_env");
    });
  });

  describe("exec background", () => {
    it("returns PID and success", async () => {
      const state: StateDefinition = { type: "exec", command: "sleep 0.1", background: true };
      const result = await executor.execute(state, {});
      expect(result.success).toBe(true);
      expect(result.pid).toBeTypeOf("number");
      expect(result.pid).toBeGreaterThan(0);
    });
  });

  describe("fetch", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("handles successful GET", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve("response body"),
      });

      const state: StateDefinition = { type: "fetch", url: "https://example.com/api" };
      const result = await executor.execute(state, {});

      expect(result.success).toBe(true);
      expect(result.type).toBe("fetch");
      expect(result.status).toBe(200);
      expect(result.body).toBe("response body");
    });

    it("reports HTTP error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        text: () => Promise.resolve("not found"),
      });

      const state: StateDefinition = { type: "fetch", url: "https://example.com/missing" };
      const result = await executor.execute(state, {});

      expect(result.success).toBe(false);
      expect(result.status).toBe(404);
      expect(result.error).toBe("HTTP 404");
    });

    it("reports network error", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network failure"));

      const state: StateDefinition = { type: "fetch", url: "https://example.com/down" };
      const result = await executor.execute(state, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe("Network failure");
    });

    it("retries on failure then succeeds", async () => {
      let attempt = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        attempt++;
        if (attempt < 3) return Promise.reject(new Error("retry me"));
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve("ok"),
        });
      });

      const state: StateDefinition = {
        type: "fetch",
        url: "https://example.com/flaky",
        retry: { max: 3, interval: 10 },
      };
      const result = await executor.execute(state, {});

      expect(result.success).toBe(true);
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it("fails after exhausting retries", async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error("always fail"));

      const state: StateDefinition = {
        type: "fetch",
        url: "https://example.com/dead",
        retry: { max: 2, interval: 10 },
      };
      const result = await executor.execute(state, {});

      expect(result.success).toBe(false);
      expect(result.error).toBe("always fail");
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it("substitutes template vars in url", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: () => Promise.resolve("ok"),
      });

      const state: StateDefinition = { type: "fetch", url: "https://{{host}}/api" };
      await executor.execute(state, { host: "example.com" });

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://example.com/api",
        expect.any(Object),
      );
    });
  });
});
