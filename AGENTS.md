## Communicate clearly

Prefer ASD-STE100 Simplified Technical English for communication.

When to use STE:
- An agent's output (explanation, instruction, log message, tool description) reads as dense, jargon-heavy, or ambiguous.
- Text will be consumed by another agent, a translation pipeline, or a non-native English reader, and misparsing has a real cost.
- You are writing a prompt, system message, or tool description and want to remove ambiguity before a model ever sees it.
- You want a before/after comparison showing exactly which rule was violated and how the rewrite fixes it.

This skill is not for creative or marketing text — STE is deliberately flat and literal. Do not apply it to text where voice, nuance, or persuasion is the point.
