// transport.test.ts — §R8 result transport: 10KB in-context cap, UTF-8-safe
// truncation, session-scoped overflow paths, marker composition.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
	OVERFLOW_CAP_BYTES,
	inContextBody,
	newSpawnId,
	overflowFilePath,
	overflowMarker,
	truncateUtf8,
} from "./transport.ts";

test("truncateUtf8 leaves text under the cap untouched", () => {
	assert.equal(truncateUtf8("hello", 100), "hello");
	assert.equal(truncateUtf8("hello", 5), "hello");
});

test("truncateUtf8 cuts at a byte boundary without splitting code points", () => {
	const text = "a".repeat(3) + "🚀".repeat(5) + "b".repeat(3); // each emoji is 4 bytes UTF-8
	const out = truncateUtf8(text, 10); // 3 + 4 = 7 fits; 7 + 4 = 11 does not
	assert.equal(Buffer.byteLength(out, "utf8"), 7);
	assert.equal(out, "aaa🚀");
});

test("overflowFilePath is session-scoped and degrades to 'unknown' without a session id", () => {
	assert.equal(
		overflowFilePath({ root: "/tmp", sessionId: "sess-1", spawnId: "scout-ab12" }),
		"/tmp/pi-subagents/sess-1/scout-ab12.md",
	);
	assert.equal(
		overflowFilePath({ root: "/tmp", spawnId: "scout-ab12" }),
		"/tmp/pi-subagents/unknown/scout-ab12.md",
	);
});

test("newSpawnId prefixes the agent name and is unique across calls", () => {
	const a = newSpawnId("scout");
	const b = newSpawnId("scout");
	assert.match(a, /^scout-[0-9a-f]{8}$/);
	assert.notEqual(a, b);
});

test("overflowMarker references the overflow path", () => {
	const marker = overflowMarker("/tmp/pi-subagents/s/x.md");
	assert.match(marker, /full report saved to \/tmp\/pi-subagents\/s\/x\.md/);
});

test("inContextBody truncates the body to fit the budget after marker + non-body bytes", () => {
	const path = "/tmp/pi-subagents/s/scout-ab12.md";
	const nonBody = 2000;
	const body = "x".repeat(20_000);
	const out = inContextBody(body, nonBody, path);
	const total = Buffer.byteLength(out, "utf8") + nonBody;
	assert.ok(total <= OVERFLOW_CAP_BYTES, `total ${total} must fit the cap`);
	assert.ok(out.startsWith("x"));
	assert.ok(out.endsWith(overflowMarker(path)));
	assert.ok(out.includes("x".repeat(1000))); // meaningful head survives
});

test("inContextBody drops the body entirely when no useful budget remains", () => {
	const path = "/tmp/pi-subagents/s/scout-ab12.md";
	const out = inContextBody("y".repeat(50_000), OVERFLOW_CAP_BYTES - 100, path);
	assert.equal(out, overflowMarker(path));
});

test("inContextBody never emits a body that exceeds the cap by itself", () => {
	const path = "/tmp/pi-subagents/s/scout-ab12.md";
	for (const nonBody of [0, 500, 4000, 8000]) {
		const out = inContextBody("z".repeat(40_000), nonBody, path);
		assert.ok(
			Buffer.byteLength(out, "utf8") + nonBody <= OVERFLOW_CAP_BYTES,
			`nonBody=${nonBody}`,
		);
	}
});