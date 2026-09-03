import assert from "node:assert/strict";
import test from "node:test";

import { invokesForbiddenGrep, ripgrepReplacementGuidance } from "./rules.ts";

test("blocks grep used to post-filter ripgrep output", () => {
	assert.equal(
		invokesForbiddenGrep('rg -n --color=never "pattern" path --glob "!*.log" | grep -v "prompts/"'),
		true,
	);
});

test("recognizes grep compatibility names and command wrappers", () => {
	for (const command of ["egrep pattern file", "sudo -u root fgrep pattern file", "env LANG=C grep pattern file"]) {
		assert.equal(invokesForbiddenGrep(command), true, command);
	}
});

test("recognizes grep in command-substitution and interpreter positions", () => {
	for (const command of [
		'files=$(grep -r pattern src) && do_something',
		"old=`grep pattern file`",
		"x=$(grep pattern file)",
		'find . -name "*.ts" | xargs grep pattern',
		"bash -c 'grep pattern file'",
		'sh -c "grep pattern file"',
		"if grep -q pattern file; then echo found; fi",
		"while grep -q pattern file; do sleep 1; done",
		"nohup grep pattern file > out.log",
		// Double quotes still expand $(...), so this really runs grep.
		'echo "$(grep x)"',
	]) {
		assert.equal(invokesForbiddenGrep(command), true, command);
	}
});

test("does not confuse grep text or an rg glob with a grep executable", () => {
	for (const command of [
		"echo grep",
		'rg -n --color=never "grep" path',
		'rg -n --color=never "pattern" path --glob "!prompts/**"',
		"echo 'grep is a GNU tool'",
		"cat file.txt | head -5",
	]) {
		assert.equal(invokesForbiddenGrep(command), false, command);
	}
});

test("guidance tells the agent how to replace an rg-to-grep pipeline", () => {
	const guidance = ripgrepReplacementGuidance();
	assert.match(guidance, /Do not pipe `rg` into `grep/);
	assert.match(guidance, /--glob '!directory\/\*\*'/);
	assert.match(guidance, /pattern flag is `-e`/);
});
