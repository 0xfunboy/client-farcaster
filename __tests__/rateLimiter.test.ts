import { beforeEach, describe, expect, it } from "vitest";
import { writeJsonFile, resolvePackagePath } from "../src/utils";
import { __testOnly_createRateLimiter } from "../src/post";

describe("Farcaster rate limiter", () => {
  beforeEach(() => {
    const rateStateFile = resolvePackagePath("src", "plugins", "postNewsJSON", "rateLimitState.json");
    writeJsonFile(rateStateFile, { version: 1, postedAt: [] as number[] });
  });

  it("blocks when hourly quota is reached", () => {
    const limiter = __testOnly_createRateLimiter();
    const now = Date.now();

    limiter.trackPost(now - 1_000);
    limiter.trackPost(now - 2_000);

    const allowed = limiter.canPost(now, 2, 100);
    expect(allowed.ok).toBe(false);
    expect(allowed.reason).toContain("hour quota reached");
  });

  it("allows when below quota", () => {
    const limiter = __testOnly_createRateLimiter();
    const now = Date.now();

    const allowed = limiter.canPost(now, 10, 100);
    expect(allowed.ok).toBe(true);
  });
});
