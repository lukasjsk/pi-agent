import assert from "node:assert/strict";
import test from "node:test";

import {
	ModelResolutionError,
	parseModelEntry,
	parseModelRef,
	refId,
	resolveModelChain,
	type ModelRegistryLike,
} from "./models.ts";

function model(provider: string, id: string) {
	return { provider, id };
}

/** Registry with only the given models available (catalogue = all registered, available = authed). */
function registry(
	known: Array<{ provider: string; id: string }>,
	available?: Array<{ provider: string; id: string }>,
): ModelRegistryLike {
	const all = known.map((m) => ({ ...m }));
	const usable = new Set((available ?? known).map((m) => `${m.provider}/${m.id}`));
	return {
		find: (provider, id) => all.find((m) => m.provider === provider && m.id === id) ?? undefined,
		getAvailable: () => all.filter((m) => usable.has(`${m.provider}/${m.id}`)),
	};
}

test("parseModelRef splits on the first slash and rejects malformed refs", () => {
	assert.deepEqual(parseModelRef("github-copilot/gpt-5.6-terra"), { provider: "github-copilot", id: "gpt-5.6-terra" });
	assert.deepEqual(parseModelRef("provider/openai/gpt"), { provider: "provider", id: "openai/gpt" });
	assert.throws(() => parseModelRef("nosegment"), ModelResolutionError);
	assert.throws(() => parseModelRef("/leading"));
	assert.throws(() => parseModelRef("trailing/"));
});

test("per-spawn override replaces the list entirely — even a fully unusable list is ignored (§R4.4)", () => {
	const resolved = resolveModelChain({
		definitionModel: ["ghost/none"],
		overrideModel: "a/override",
		registry: registry([{ provider: "a", id: "override" }]), // "ghost/none" not in catalogue
	});
	assert.deepEqual(resolved.chain, [{ model: { provider: "a", id: "override" } }]);
	assert.deepEqual(resolved.diagnostics, []);
	// The override is definitive: no parent fallback net is appended.
	assert.equal(resolved.chain.length, 1);
});

test("an override not in the registry is a spawn error", () => {
	assert.throws(
		() => resolveModelChain({ overrideModel: "ghost/missing", registry: registry([]) }),
		(error: unknown) => /model "ghost\/missing" not found in the model registry/.test(String(error)),
	);
});

test("the first list entry with valid auth wins; unusable entries are skipped with diagnostics (§R4.1)", () => {
	const resolved = resolveModelChain({
		definitionModel: ["ghost/none", "a/unauthed", "b/ok"],
		registry: registry(
			[{ provider: "a", id: "unauthed" }, { provider: "b", id: "ok" }],
			[{ provider: "b", id: "ok" }], // a/unauthed is registered but has no valid auth
		),
	});
	assert.deepEqual(resolved.chain, [{ model: { provider: "b", id: "ok" } }]);
	assert.deepEqual(resolved.diagnostics, [
		"skipped ghost/none (not in the model catalogue)",
		"skipped a/unauthed (no valid auth)",
	]);
});

test("a fully exhausted list is a ModelResolutionError carrying per-candidate info (§R4.3)", () => {
	assert.throws(
		() =>
			resolveModelChain({
				definitionModel: ["ghost/none", "a/unauthed"],
				registry: registry([{ provider: "a", id: "unauthed" }], []),
			}),
		(error: unknown) => {
			assert.match(String(error), /no usable model in the fallback list/);
			assert.match(String(error), /ghost\/none/);
			assert.match(String(error), /a\/unauthed/);
			return true;
		},
	);
});

test("a malformed list entry fails the spawn fast (consistent with unknown tools)", () => {
	assert.throws(
		() => resolveModelChain({ definitionModel: ["not-a-ref"], registry: registry([]) }),
		/not a "provider\/model-id" reference/,
	);
});

test("a list without a registry cannot be resolved — no silent parent fallback (§R4.3)", () => {
	assert.throws(
		() => resolveModelChain({ definitionModel: ["a/one"] }),
		/no model registry available/,
	);
});

test("chain entries are the registry's full model objects, not parsed {provider,id} stubs", () => {
	const fullModel = { provider: "b", id: "ok", reasoning: true, api: "openai-responses" };
	const resolved = resolveModelChain({
		definitionModel: ["b/ok"],
		registry: {
			find: () => fullModel,
			getAvailable: () => [fullModel],
		},
	});
	assert.equal(resolved.chain[0].model, fullModel); // identity: the child needs reasoning/api/etc.
});

test("no list and no override → the parent's model, or the platform default when absent", () => {
	const withParent = resolveModelChain({ parentModel: { provider: "p", id: "m" } });
	assert.deepEqual(withParent.chain, [{ model: { provider: "p", id: "m" } }]);

	const withoutParent = resolveModelChain({});
	assert.deepEqual(withoutParent.chain, []);
	assert.deepEqual(withoutParent.diagnostics, []);
});

test("a malformed parent model object is ignored rather than crashing", () => {
	assert.deepEqual(resolveModelChain({ parentModel: "not-a-model" }).chain, []);
});

test("parseModelEntry splits a trailing @level pin from the ref", () => {
	assert.deepEqual(parseModelEntry("a/b"), { model: { provider: "a", id: "b" } });
	assert.deepEqual(parseModelEntry("a/b@max"), { model: { provider: "a", id: "b" }, thinkingLevel: "max" });
	// Splits on the LAST @ — model ids may legally contain one.
	assert.deepEqual(parseModelEntry("a/b@c@low"), { model: { provider: "a", id: "b@c" }, thinkingLevel: "low" });
	// Levels are case-insensitive.
	assert.deepEqual(parseModelEntry("a/b@MEDIUM"), { model: { provider: "a", id: "b" }, thinkingLevel: "medium" });
});

test("parseModelEntry rejects an unknown thinking level", () => {
	assert.throws(
		() => parseModelEntry("a/b@ultra"),
		(error: unknown) => /invalid thinking level "@ultra"/.test(String(error)),
	);
});

test("the parent's model is appended as the final chain entry, deduped by ref id", () => {
	const parent = { provider: "p", id: "parent" };
	const resolved = resolveModelChain({
		definitionModel: ["b/ok", "p/parent"],
		registry: registry([{ provider: "b", id: "ok" }, parent]),
		parentModel: parent,
	});
	assert.deepEqual(resolved.chain.map((e) => refId(e.model)), ["b/ok", "p/parent"]);
});

test("a fully exhausted list lands on the parent's model instead of failing", () => {
	const parent = { provider: "p", id: "parent" };
	const resolved = resolveModelChain({
		definitionModel: ["ghost/none", "a/unauthed"],
		registry: registry([{ provider: "a", id: "unauthed" }], []),
		parentModel: parent,
	});
	assert.deepEqual(resolved.chain, [{ model: parent }]);
	assert.equal(resolved.diagnostics.length, 2);
});

test("per-entry thinking pins survive resolution; unpinned entries stay unpinned", () => {
	const resolved = resolveModelChain({
		definitionModel: ["a/local@medium", "b/terra"],
		registry: registry([{ provider: "a", id: "local" }, { provider: "b", id: "terra" }]),
	});
	assert.deepEqual(resolved.chain.map((e) => e.thinkingLevel), ["medium", undefined]);
});
