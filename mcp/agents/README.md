# Kinux review subagents (Claude Code)

Four domain reviewers for Kinux's Reviewer role (`mcp/server.mjs --role reviewer`). Copy them into a
project's `.claude/agents/` and connect the server as an MCP server named `kinux`.

Each one may use only the three review tools (bundle, read_document, propose): no file reading, no
shell, no web, so it sees nothing outside the hashed bundle. It proposes; Kinux's verifiers decide
(`engine/review.mjs`); the report is rendered from accepted proposals only and can be replayed with no
model. The orchestrating session spawns the four in parallel, then calls `kinux_get_review`.

The pattern is Copperhead's model review (docs/LEARNINGS.md section 7); the verifiers are Kinux's.
