import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────
const SEARXNG_URL = process.env.SEARXNG_URL || "http://127.0.0.1:8088";
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || "http://172.21.0.9:8191";

// Load API keys from .env (never hardcoded)
function loadEnv(): { EXA_API_KEY?: string; TAVILY_API_KEY?: string } {
  const envPath = join(__dirname, ".env");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
  return {
    EXA_API_KEY: process.env.EXA_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
  };
}
const { EXA_API_KEY, TAVILY_API_KEY } = loadEnv();

// ── Sequential queue (FIFO + jitter) ─────────────────────────────────
// Every search call waits for the previous to finish + 200-500ms jitter,
// so we never fire multiple requests from the same IP simultaneously.
let queueTail: Promise<unknown> = Promise.resolve();

async function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = queueTail.then(fn, fn);
  queueTail = run.catch(() => undefined);
  return run;
}

function jitter(min = 200, max = 500): Promise<void> {
  const delay = min + Math.random() * (max - min);
  return new Promise((r) => setTimeout(r, delay));
}

// ── Types ────────────────────────────────────────────────────────────
interface SearchResult {
  title: string;
  url: string;
  text: string;
  score?: number;
  engine?: string;
  publishedDate?: string;
}

// ── Exa (primary) ────────────────────────────────────────────────────
async function exaSearch(query: string, numResults: number, timeRange?: string): Promise<SearchResult[]> {
  if (!EXA_API_KEY) throw new Error("EXA_API_KEY not set");
  const body: Record<string, unknown> = {
    query,
    numResults: Math.min(numResults, 10),
    type: "auto",
    contents: {
      // Highlights give LLM-relevant snippets without dumping whole pages
      highlights: { maxCharacters: 500 },
    },
  };
  if (timeRange) body.startPublishedDate = timeRangeToIso(timeRange);
  const resp = await fetch("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "x-api-key": EXA_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`Exa HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.results || []).map((r: any) => ({
    title: r.title || "",
    url: r.url || "",
    text: r.highlights?.join(" ") || r.text?.slice(0, 500) || "",
    score: r.score,
    engine: "exa",
    publishedDate: r.publishedDate,
  }));
}

// ── Tavily (fallback) ────────────────────────────────────────────────
async function tavilySearch(query: string, numResults: number, timeRange?: string): Promise<SearchResult[]> {
  if (!TAVILY_API_KEY) throw new Error("TAVILY_API_KEY not set");
  const body: Record<string, unknown> = {
    api_key: TAVILY_API_KEY,
    query,
    search_depth: "basic",
    max_results: Math.min(numResults, 10),
    include_answer: false,
    include_raw_content: false,
    include_images: false,
  };
  if (timeRange) body.time_range = timeRange;
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`Tavily HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.results || []).map((r: any) => ({
    title: r.title || "",
    url: r.url || "",
    text: (r.content || "").slice(0, 500),
    score: r.score,
    engine: "tavily",
    publishedDate: r.published_date,
  }));
}

// ── SearXNG (last resort — proven engines only) ─────────────────────
const CATEGORY_ENGINES: Record<string, string> = {
  general: "google cse,bing",
  it: "github,npm,docker hub,stackoverflow",
  science: "arxiv,crossref,openalex",
};

async function searxSearch(query: string, category: string, numResults: number, timeRange?: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: "json",
    pageno: "1",
    categories: category,
    engines: CATEGORY_ENGINES[category] || "",
  });
  if (timeRange) params.set("time_range", timeRange);
  const resp = await fetch(`${SEARXNG_URL}/search?${params.toString()}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`SearXNG HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.results || []).slice(0, numResults).map((r: any) => ({
    title: r.title || "",
    url: r.url || "",
    text: r.content || "",
    score: r.score,
    engine: r.engine || "searxng",
    publishedDate: r.publishedDate,
  }));
}

// ── FlareSolverr (last-resort for blocked engines) ──────────────────
// If SearXNG engines are CAPTCHA-blocked, fetch the search URL through
// FlareSolverr which runs a real browser to solve challenges.
async function flareSearch(query: string, category: string, numResults: number): Promise<SearchResult[]> {
  const engineList = CATEGORY_ENGINES[category]?.split(",")[0] || "bing";
  const searchUrl = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&categories=${category}&engines=${encodeURIComponent(engineList)}`;
  const resp = await fetch(`${FLARESOLVERR_URL}/v1`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      cmd: "request.get",
      url: searchUrl,
      maxTimeout: 30000,
    }),
    signal: AbortSignal.timeout(35000),
  });
  if (!resp.ok) throw new Error(`FlareSolverr HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.solution?.response) {
    try {
      const parsed = JSON.parse(data.solution.response);
      return (parsed.results || []).slice(0, numResults).map((r: any) => ({
        title: r.title || "",
        url: r.url || "",
        text: r.content || "",
        engine: "flaresolverr",
      }));
    } catch {
      // HTML response — nothing parseable here without extra work
    }
  }
  return [];
}

// ── Orchestrator: Exa → Tavily → SearXNG → FlareSolverr ─────────────
async function searchWithFallback(
  query: string,
  category: string,
  numResults: number,
  timeRange?: string,
): Promise<{ source: string; results: SearchResult[] }> {
  // Exa first
  try {
    const results = await exaSearch(query, numResults, timeRange);
    if (results.length > 0) return { source: "exa", results };
    console.error(`[searxng-mcp] exa empty for "${query}"`);
  } catch (e: any) {
    console.error(`[searxng-mcp] exa failed for "${query}": ${e.message}`);
  }
  await jitter();

  // Tavily second
  try {
    const results = await tavilySearch(query, numResults, timeRange);
    if (results.length > 0) return { source: "tavily", results };
    console.error(`[searxng-mcp] tavily empty for "${query}"`);
  } catch (e: any) {
    console.error(`[searxng-mcp] tavily failed for "${query}": ${e.message}`);
  }
  await jitter();

  // SearXNG proven engines third
  try {
    const results = await searxSearch(query, category, numResults, timeRange);
    if (results.length > 0) return { source: "searxng", results };
    console.error(`[searxng-mcp] searxng empty for "${query}"`);
  } catch (e: any) {
    console.error(`[searxng-mcp] searxng failed for "${query}": ${e.message}`);
  }
  await jitter();

  // FlareSolverr last resort
  try {
    const results = await flareSearch(query, category, numResults);
    if (results.length > 0) return { source: "flaresolverr", results };
  } catch (e: any) {
    console.error(`[searxng-mcp] flaresolverr failed for "${query}": ${e.message}`);
  }

  return { source: "none", results: [] };
}

// ── Helpers ──────────────────────────────────────────────────────────
function timeRangeToIso(timeRange: string): string {
  const now = new Date();
  const days = { day: 1, week: 7, month: 30, year: 365 }[timeRange] || 30;
  now.setDate(now.getDate() - days);
  return now.toISOString();
}

function buildMcpText(source: string, query: string, results: SearchResult[], numResults: number): string {
  return JSON.stringify({
    query,
    source, // exa | tavily | searxng | flaresolverr | none
    results: results.slice(0, numResults),
    resultCount: results.length,
  });
}

// ── Tools ────────────────────────────────────────────────────────────
const server = new McpServer({
  name: "searxng-web-search",
  version: "2.0.0",
});

const commonParams = {
  query: z.string().describe("The search query"),
  numResults: z.number().optional().default(8).describe("Number of results to return (default 8, max 10)"),
  timeRange: z.enum(["day", "week", "month", "year"]).optional().describe("Time range filter"),
};

server.tool(
  "web_search",
  "General web search for broad discovery: blog posts, docs, discussions, news. Backed by Exa (primary), Tavily (fallback), then SearXNG (Google CSE/Bing). Use for 'what is X', landscape surveys, finding links. Not for code or papers — use tech_search / academic_search.",
  commonParams,
  async ({ query, numResults, timeRange }) => {
    return enqueue(async () => {
      await jitter();
      const start = performance.now();
      const { source, results } = await searchWithFallback(query, "general", numResults, timeRange);
      console.error(`[searxng-mcp] web_search "${query}" source=${source} results=${results.length} time=${Math.round(performance.now() - start)}ms`);
      return { content: [{ type: "text", text: buildMcpText(source, query, results, numResults) }] };
    });
  },
);

server.tool(
  "tech_search",
  "Technical and code research: search GitHub repos/issues, npm packages, Docker Hub, Stack Overflow. Backed by Exa (primary), Tavily (fallback), then SearXNG. Use for implementation questions, finding libraries, repo discovery, community consensus on tools. Not for general info or academic papers.",
  commonParams,
  async ({ query, numResults, timeRange }) => {
    return enqueue(async () => {
      await jitter();
      const start = performance.now();
      const { source, results } = await searchWithFallback(query, "it", numResults, timeRange);
      console.error(`[searxng-mcp] tech_search "${query}" source=${source} results=${results.length} time=${Math.round(performance.now() - start)}ms`);
      return { content: [{ type: "text", text: buildMcpText(source, query, results, numResults) }] };
    });
  },
);

server.tool(
  "academic_search",
  "Academic and scientific research: search arXiv, Crossref, OpenAlex papers. Backed by Exa (primary), Tavily (fallback), then SearXNG. Use for research papers, algorithms, primary sources, citation-graph context.",
  commonParams,
  async ({ query, numResults, timeRange }) => {
    return enqueue(async () => {
      await jitter();
      const start = performance.now();
      const { source, results } = await searchWithFallback(query, "science", numResults, timeRange);
      console.error(`[searxng-mcp] academic_search "${query}" source=${source} results=${results.length} time=${Math.round(performance.now() - start)}ms`);
      return { content: [{ type: "text", text: buildMcpText(source, query, results, numResults) }] };
    });
  },
);

// ── Startup ──────────────────────────────────────────────────────────
async function ensureSearXNG(): Promise<void> {
  const healthUrl = `${SEARXNG_URL}/search?q=health&format=json`;
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      console.error("[searxng-mcp] SearXNG is already running");
      return;
    }
  } catch {
    // Not reachable — will attempt to start below
  }
  console.error("[searxng-mcp] SearXNG not running, attempting to start...");
  try {
    const { execSync } = await import("child_process");
    execSync("docker compose -f /home/shreyas/DockerContainers/searxng/docker-compose.yml up -d", { timeout: 60000, stdio: "pipe" });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const checkRes = await fetch(healthUrl, { signal: AbortSignal.timeout(3000) });
        if (checkRes.ok) {
          console.error("[searxng-mcp] SearXNG started and is healthy");
          return;
        }
      } catch {
        // Not ready yet
      }
    }
    console.error("[searxng-mcp] SearXNG started but still not healthy after 60 s — continuing anyway");
  } catch (err: any) {
    console.error(`[searxng-mcp] Failed to start SearXNG: ${err.message} — continuing without it`);
  }
}

const transport = new StdioServerTransport();
await ensureSearXNG();
console.error(`[searxng-mcp] exa=${EXA_API_KEY ? "configured" : "MISSING"} tavily=${TAVILY_API_KEY ? "configured" : "MISSING"}`);
await server.connect(transport);
console.error("[searxng-mcp] server started, listening on stdio");
