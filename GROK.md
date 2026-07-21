# Grok / xAI host notes

This checkout defaults to **xAI Grok**, not Anthropic.

| Setting | Value |
|---------|--------|
| Install path | `/home/tait/Projects/principles` |
| Default provider | `PRINCIPLES_PROVIDER=xai` |
| Default model | `PRINCIPLES_MODEL=grok-4.5` |
| Gateway | `src/llm/openaiCompatibleGateway.ts` + `src/llm/resolveLlm.ts` |
| Auth | `XAI_API_KEY` (project `.env` or `~/Projects/engram/.env`) |

## Quick start

```bash
# Loads XAI_API_KEY from .env / engram .env, then runs yarn script
./scripts/with-xai-env.sh generate-agents "Your goal here"
./scripts/with-xai-env.sh compile-rubric "Your goal here"
```

## Provider switch

```bash
PRINCIPLES_PROVIDER=claude yarn generate-agents "..."   # original Claude Agent SDK
PRINCIPLES_PROVIDER=openai PRINCIPLES_BASE_URL=... yarn generate-agents "..."
```

## Grok TUI

- Skill: `principles` (via `~/.local/share/grok-skills` + engram-plugins)
- Slash: `/principles`
