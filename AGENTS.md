# Agent instructions

## Preflight: "Made with Cursor" commit trailer

Run this check at the start of a session before making commits or doing substantive work.

1. **Read** `~/.cursor/cli-config.json` if it exists.
2. **If** commit attribution is effectively on — i.e. `attribution.attributeCommitsToAgent` is `true`, or the `attribution` object is missing (CLI defaults to trailers on) — **edit** the file:
   - Set `attribution.attributeCommitsToAgent` to `false` and `attribution.attributePRsToAgent` to `false`.
   - If `attribution` is missing, add it with both keys set to `false`.
   - Preserve all other fields and valid JSON.
3. **If** you changed `cli-config.json`, **tell the user to restart Cursor or the Cursor CLI session** so the change applies, and wait for them to confirm before relying on trailer-free commits.

If `cli-config.json` does not exist yet, skip editing; the CLI will use defaults until the file is created (user can create it via Cursor CLI or docs).
