# pstack, ported to Claude Code

Upstream: [cursor/plugins/pstack](https://github.com/cursor/plugins/tree/main/pstack) v0.15.2, MIT, by Lauren Tan (poteto).

pstack ships as a **Cursor** plugin (`.cursor-plugin/plugin.json`). Claude Code reads a different
manifest (`.claude-plugin/plugin.json`) and a different marketplace format, so neither
`/add-plugin pstack` nor `/plugin marketplace add cursor/plugins` works here.

What ports cleanly is the content: pstack's skills are plain `SKILL.md` files with YAML
frontmatter, the same shape Claude Code reads. So instead of a plugin install, the skills and
agents were vendored into this repo's `.claude/` directory, where Claude Code discovers them
automatically:

```
.claude/skills/    47 skills  (23 principle-*, 24 workflow)
.claude/agents/     2 agents  (poteto-agent, comment-sicko)
.claude/pstack/     the upstream guide, README, LICENSE, and this file
```

## Getting started

1. `/setup-pstack` — pick models per role. Read its banner first; the Claude Code version writes
   a plain config file rather than an always-applied rule.
2. `/poteto-mode` — the main entry point. It routes to the other skills and its 23 playbooks.

Everything else is situational and `poteto-mode` reaches for it as needed. The upstream guide is
in `guide/`, starting at `guide/README.md`.

## What was changed in the port

| Cursor | Claude Code | Where |
|---|---|---|
| `.cursor/skills/` | `.claude/skills/` | create-verification-skill, maintain-verification-skill, automate-me |
| `~/.cursor/skills/`, `~/.cursor/plugins/` | `~/.claude/skills/`, `~/.claude/plugins/` | automate-me, reflect reviewers |
| `~/.cursor/rules/pstack-models.mdc` | `~/.claude/pstack-models.md` | setup-pstack, arena, swarm, interrogate, poteto-mode |
| `~/.cursor/projects/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl` | `~/.claude/projects/<slug>/<session-uuid>.jsonl` | recall, reflect, show-me-your-work, automate-me, session-pickup, eval, orchestrate, worktree-audit.sh |
| slug = path with leading `/` dropped | slug = path with **every** `/` → `-`, leading one included | same as above |
| `Task` tool | `Agent` tool | poteto-mode, interrogate, setup-pstack, orchestrate |
| `AskQuestion` | `AskUserQuestion` | poteto-mode, setup-pstack, automate-me, autonomous-run |
| `create-skill` (Cursor built-in) | `anthropic-skills:skill-creator` | reflect, automate-me, poteto-mode, authoring-a-skill |
| `deslop` / `/deslop` (`cursor-team-kit`) | `/simplify` (Claude Code built-in) | poteto-mode, opening-a-pr, multi-phase-plan, autopilot-* |
| `control-ui` / `control-cli` (`cursor-team-kit`) | the `run` skill | poteto-mode, shipping, multi-phase-plan, orchestrate, autopilot-* |
| `claude-fable-5-1-thinking-max` | `fable` | arena, swarm, poteto-mode, setup-pstack |
| `claude-opus-5-thinking-xhigh` | `opus` | same |
| `gpt-5.6-sol-max` | `opus` | same |
| `grok-4.6-fast-xhigh` / `-medium-fast` | `sonnet` / `haiku` | same |

Frontmatter was also normalised: skill `name` values must be lowercase-hyphenated and match their
directory in Claude Code, so `Poteto Mode` → `poteto-mode` and `Make Bot UI` → `make-bot-ui`.
Cursor-only keys (`mode`, `icon`, `color`, `reminder`, `paths`) and the agent key `is_background`
were dropped.

## What is degraded, and why

**`make-bot-ui` does not work.** It drives Cursor's automations webhook API
(`api2.cursor.sh/automations/webhook/<id>`), which has no Claude Code equivalent. The skill carries
a banner saying so. Claude Code Routines (`create_trigger` on the Claude Code Remote MCP server)
are the nearest analogue, but the API differs enough that the steps don't transfer. Kept as
reference, not instructions.

**The model panel is single-vendor now.** pstack's `arena` and `interrogate` deliberately spread
work across vendors so that a GPT model judges a Grok candidate and so on. Claude Code's `Agent`
tool only takes `opus`, `sonnet`, `haiku`, and `fable`, so the four-way cross-vendor panel became a
three-model one. "Prefer a different model family from the parent's" still helps, but it is a
weaker check than upstream intends.

**Reasoning-effort budgets have nothing to set.** Cursor slugs carry an effort token
(`-thinking-max`, `-fast-xhigh`) that `/setup-pstack`'s budget ladder rewrites. Claude Code model
values carry no such token, so the `large`/`medium`/`small` budget mapping is inert. Pick models
per role and skip the budget step.

**`~/.claude/pstack-models.md` is not auto-loaded.** In Cursor it was an `alwaysApply: true` rule.
Claude Code has no equivalent directory, so the file is read explicitly by the skills that consult
it (`arena`, `swarm`, `interrogate`, `poteto-mode`). That works, but a skill that forgets to read
it silently falls back to defaults. Move the settings into `CLAUDE.md` if you want them always in
context.

**`/loop`, cloud agents, and `gh` all survive.** Playbooks referencing them (`autonomous-run`,
`orchestrate`, `autopilot-*`, `babysit`) map onto real Claude Code features. Note this repo's
sessions use GitHub MCP tools rather than the `gh` CLI, so substitute those where a playbook shells
out to `gh`.

**The 23 `principle-*` skills are untouched.** They are pure prose with no tool or path
assumptions, so they carry over exactly as upstream wrote them.

## Re-syncing from upstream

The port is mechanical, so a refresh is mostly re-running the same substitutions:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/cursor/plugins.git
cd plugins && git sparse-checkout set pstack
```

Then diff `pstack/skills/` against `.claude/skills/` and reapply the table above to whatever is
new. Check upstream's version in `.cursor-plugin/plugin.json` against the v0.15.2 recorded here.
