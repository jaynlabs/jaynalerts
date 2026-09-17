import { expect, test } from "bun:test";
import { titleWithCwd } from "../src/cli/pi-hook.ts";

test("Pi hook title includes the project folder", () => {
	expect(titleWithCwd("/Users/example/src/my-project")).toBe("Pi · my-project");
});

test("Pi hook title falls back when cwd is unavailable", () => {
	expect(titleWithCwd(null)).toBe("Pi");
	expect(titleWithCwd("/")).toBe("Pi");
});
