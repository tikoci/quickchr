---
applyTo: "cspell.json,project-words.txt"
---

# Spell-check (cSpell)

Spelling is enforced by cSpell, wired into `bun run check` (and therefore CI) via
`bun run lint:cspell` (`cspell lint .`). Config lives in `cspell.json`; the
project dictionary is `project-words.txt`. Both the VS Code cSpell extension and
the CLI read these — there is no `cSpell.words` in `.vscode/settings.json`.

- **Add real vocabulary to `project-words.txt`** — QEMU, RouterOS, networking,
  and tikoci domain terms. Keep it sorted and lowercase (cSpell matches
  case-insensitively, so the lowercase form covers all casings). The editor
  "Add to dictionary" quick-fix appends here automatically.
- **Put non-vocabulary in `cspell.json` `ignoreWords`** — British/locale variants
  (`behaviour`, `licences`), doc placeholders (`myapp`, `myuser`), and one-off
  test sentinels or key fragments (`findme`, `lukqg`). These aren't terms worth
  teaching as vocabulary.
- If a word only flags because Markdown/code is malformed, fix the source first
  rather than teaching cSpell the broken token.
- `ignorePaths` covers generated/vendored output (`node_modules`, `dist`,
  `coverage`, `bun.lock`). Don't silence a whole real source file to dodge one
  typo — fix the token instead.
