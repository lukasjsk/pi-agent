import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const extensionsRoot = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(path));
		else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(path);
	}
	return files;
}

test("active extension sources use canonical Pi package imports", () => {
	const forbiddenImports = [
		{ name: "legacy Pi package scope", pattern: /["']@mariozechner\/pi-[^"']+["']/g },
		{ name: "legacy TypeBox package", pattern: /["']@sinclair\/typebox(?:\/[^"']*)?["']/g },
	];
	const violations: string[] = [];

	for (const file of sourceFiles(extensionsRoot)) {
		const contents = readFileSync(file, "utf8");
		for (const { name, pattern } of forbiddenImports) {
			for (const match of contents.matchAll(pattern)) {
				const path = relative(extensionsRoot, file).split(sep).join("/");
				violations.push(`${path}: ${name} (${match[0]})`);
			}
		}
	}

	assert.deepEqual(violations, [], `legacy imports found:\n${violations.join("\n")}`);
});
