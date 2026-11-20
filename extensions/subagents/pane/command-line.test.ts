// command-line.test.ts — the TUI adapter's argv → shell command line conversion.
// The viewer script and socket paths can contain spaces or shell signs, so every
// token must survive the multiplexer's command-string seam unchanged.

import { test } from "node:test";
import assert from "node:assert/strict";
import { toCommandLine } from "./command-line.ts";

test("toCommandLine quotes every token and joins with one space", () => {
	assert.equal(toCommandLine(["/usr/bin/bun", "/repo/viewer.ts", "--socket", "/tmp/x.sock"]),
		'"/usr/bin/bun" "/repo/viewer.ts" "--socket" "/tmp/x.sock"');
});

test("toCommandLine keeps a path with spaces as one quoted token", () => {
	assert.equal(toCommandLine(["/opt/my bin/bun", "/repo/a b/viewer.ts"]),
		'"/opt/my bin/bun" "/repo/a b/viewer.ts"');
});

test("toCommandLine escapes characters the shell would still read inside double quotes", () => {
	assert.equal(toCommandLine(['a"b', "a$b", "a`b", "a\\b"]), '"a\\"b" "a\\$b" "a\\`b" "a\\\\b"');
});

test("toCommandLine on an empty argv is an empty command", () => {
	assert.equal(toCommandLine([]), "");
});
