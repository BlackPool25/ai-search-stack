# AI Search Stack

Self-hosted, agent-ready search infrastructure. A Model Context Protocol (MCP) server that gives LLM agents three focused search tools backed by a resilient fallback chain — **Exa → Tavily → SearXNG** — so an agent always gets results without hammering any single provider from the same IP.

## Why

General-purpose SearXNG scraping gets blocked (Google, Brave, DuckDuckGo, Startpage all fingerprint/rate-limit datacenter IPs; Tor exits are pre-flagged). Meanwhile, searching "everything, everywhere" on every query wastes tokens and burns API credits on irrelevant slices.

This stack solves both:

1. **Three focused tools** — general web, technical/code, academic — so an agent queries the right slice, not a shotgun.
2. **API-first fallback chain** — Exa and Tavily are API-key based (no IP blocking). SearXNG's proven engines are only the last resort.
3. **Sequential queue with jitter** — search calls are serialized (FIFO + 200–500ms jitter), so no concurrent same-IP bursts that trigger rate limits.

## Tools exposed to the agent

| Tool | Category | Primary → Fallback |
|------|----------|--------------------|
| `web_search` | general | Exa → Tavily → SearXNG (Google CSE, Bing) |
| `tech_search` | technical/code | Exa → Tavily → SearXNG (GitHub, npm, Docker Hub, Stack Overflow) |
| `academic_search` | academic | Exa → Tavily → SearXNG (arXiv, Crossref, OpenAlex) |

Each result is balanced for LLM consumption: title, URL, ~500-char snippet, score, source engine. No raw page dumps.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Agent (any MCP client)                                  │
│    └─ web_search / tech_search / academic_search         │
└───────────────────────┬──────────────────────────────────┘
                        │ FIFO queue + 200–500ms jitter
┌───────────────────────▼──────────────────────────────────┐
│  MCP server (mcp-server/index.ts)                        │
│    fallback chain:                                       │
│      1. Exa (api.exa.ai)          — API key              │
│      2. Tavily (api.tavily.com)   — API key              │
│      3. SearXNG (127.0.0.1:8088)  — proven engines only  │
│      4. FlareSolverr (optional)   — CAPTCHA last resort  │
└───────────────────────┬──────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────┐
│  SearXNG (Docker) — 9 proven engines, no junk            │
│  general: google cse, bing                               │
│  it:      github, npm, docker hub, stackoverflow         │
│  science: arxiv, crossref, openalex                      │
└──────────────────────────────────────────────────────────┘
```

## Requirements

- Docker + Docker Compose
- Node.js 20+ (for the MCP server)
- [Exa API key](https://exa.ai) (free tier available)
- [Tavily API key](https://tavily.com) (free tier: 1,000 calls/month)
- Optional: [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr) for CAPTCHA-heavy fallbacks

## Setup

```bash
# 1. Clone
git clone https://github.com/BlackPool25/ai-search-stack.git
cd ai-search-stack

# 2. Create the shared docker network
docker network create searxng-net

# 3. Configure secrets
cp mcp-server/.env.example mcp-server/.env
#    fill in EXA_API_KEY and TAVILY_API_KEY

# 4. Set the SearXNG secret
echo "SEARXNG_SECRET=$(openssl rand -hex 32)" > .env

# 5. Start SearXNG
docker compose up -d

# 6. Install MCP server deps
cd mcp-server && npm install && cd ..

# 7. Register the MCP server with your agent (opencode.json example)
```

```jsonc
// opencode.json — add to your agent's MCP servers
{
  "mcp": {
    "searxng": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/ai-search-stack/mcp-server/index.ts"],
      "env": {
        "EXA_API_KEY": "...",
        "TAVILY_API_KEY": "..."
      }
    }
  }
}
```

## Usage notes for agents

- **`web_search`** — general discovery: "what is X", landscape surveys, finding links/docs.
- **`tech_search`** — implementation questions, finding libraries, repo discovery, community consensus.
- **`academic_search`** — papers, algorithms, primary sources, citation context.
- Results include a `source` field (`exa` / `tavily` / `searxng` / `flaresolverr`) so you know which backend answered.

## Why only 9 SearXNG engines?

All other default engines were removed after live testing from this deployment's IP:

- **Blocked by Cloudflare or rate-limits**: Brave, DuckDuckGo, Startpage, Dogpile, Mojeek, Hacker News, Stack Exchange (some work intermittently).
- **Google HTML engine**: broken since 2026-07-01 (requires JS execution); only the CSE API variant works.
- **Image/video/news engines**: irrelevant for code/paper research — they pollute agent context.

SearXNG remains a *fallback*, not a primary. Exa/Tavily do the heavy lifting with API-key auth that never gets IP-blocked.

## Security

- API keys live in `mcp-server/.env` (gitignored). Never commit them.
- `SEARXNG_SECRET` is injected via environment variable, not hardcoded.
- SearXNG binds to `127.0.0.1` only.
- No Tor, no third-party proxies — the API-first design removes the need for IP rotation.

## License

MIT
