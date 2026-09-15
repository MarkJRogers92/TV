import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "vitest";

test("ships the broadcast watermark as a PNG that Tunarr can overlay", () => {
  const watermark = readFileSync(
    resolve(process.cwd(), "web/public/marktv-watermark.png"),
  );

  expect(watermark.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  expect(watermark.byteLength).toBeGreaterThan(1_000);
});
