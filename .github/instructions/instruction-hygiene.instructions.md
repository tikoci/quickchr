---
applyTo: "AGENTS.md,**/AGENTS.md,CLAUDE.md,.github/copilot-instructions.md,.github/instructions/**"
---

# Instruction Hygiene

When adding or editing durable agent instructions, keep one canonical source per
topic and point to it from other surfaces.

- Use the narrowest `applyTo` pattern that covers the files governed by the rule.
- Preserve existing front matter and path scopes unless the scope itself is wrong.
- If two instruction files overlap, keep the most specific file normative and
  turn the broader file into a pointer.
- Do not add Codex-only entrypoint files; root `AGENTS.md` is the portable router
  for Codex and other agents.
