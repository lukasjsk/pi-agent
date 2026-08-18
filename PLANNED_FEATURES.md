Features planned for the future:

- analyze and plan should take into consideration previous conversation - currently it only takes into consideration the prompt itself. If there is previous compaction it should take that into consideration, otherwise analysis and plan does not have enough information.
- create a new session from compaction - currently there is whole chat history visible, even though it looks like that after first subsequent prompt context only contains compacted info - needs confirmation
- play sound on finished job when waiting for user input.
- update context-usage display in footer to display also used context size in tokens, not just in percentage. It should be displayed as 0.12k, 23.1k (k suffix until 100k, then switch to M), 0.12M, 1.12M - we should stop with M suffix