import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { readJsonFile, writeJsonFile } from "../src/utils";

describe("JSON serializer", () => {
  it("writes and reads state consistently", () => {
    const file = path.join(process.cwd(), "src", "plugins", "postNewsJSON", "_tmp_state_test.json");
    const payload = { version: 1, items: [{ id: "a", text: "hello" }] };

    writeJsonFile(file, payload);
    const loaded = readJsonFile(file, { version: 1, items: [] as Array<{ id: string; text: string }> });

    expect(loaded).toEqual(payload);
    fs.unlinkSync(file);
  });
});
