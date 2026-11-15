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

// ── Free direct APIs (quality-first: paid Exa/Tavily first, these enrich fallback) ──
async function freeGet(url: string, headers: Record<string, string> = {}): Promise<any> {
  const resp = await fetch(url, {
    headers: { "User-Agent": "searxng-mcp/2.0 (research)", Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${new URL(url).host}`);
  return resp.json();
}

// Tech: GitHub repos + StackExchange + HN Algolia + npm/PyPI/crates (all keyless, verified)
async function techFreeSearch(query: string, numResults: number): Promise<SearchResult[]> {
  const per = Math.max(2, Math.ceil(numResults / 3));
  const q = encodeURIComponent(query);
  const jobs: Promise<SearchResult[]>[] = [
    freeGet(`https://api.github.com/search/repositories?q=${q}&per_page=${per}&sort=stars`).then((d: any) =>
      (d.items || []).map((r: any) => ({ title: r.full_name, url: r.html_url, text: r.description || "", score: r.stargazers_count / 100000, engine: "github-direct" })),
    ).catch(() => []),
    freeGet(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${q}&site=stackoverflow&pagesize=${per}&filter=!nNPvSNdWme`).then((d: any) =>
      (d.items || []).map((it: any) => ({ title: it.title, url: `https://stackoverflow.com/questions/${it.question_id}`, text: (it.excerpt || "").slice(0, 500), score: (it.score || 0) / 100, engine: "stackoverflow-direct" })),
    ).catch(() => []),
    freeGet(`https://hn.algolia.com/api/v1/search?query=${q}&hitsPerPage=${per}&tags=story`).then((d: any) =>
      (d.hits || []).filter((h: any) => h.title || h.story_title).map((h: any) => ({ title: h.title || h.story_title, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, text: `${h.points || 0}pts ${h.num_comments || 0} comments`, engine: "hn-direct" })),
    ).catch(() => []),
    freeGet(`https://registry.npmjs.org/-/v1/search?text=${q}&size=${per}`).then((d: any) =>
      (d.objects || []).map((o: any) => ({ title: o.package?.name || "", url: o.package?.links?.npm || "", text: (o.package?.description || "").slice(0, 300), engine: "npm-direct" })),
    ).catch(() => []),
  ];
  jobs.push(
    freeGet(`https://crates.io/api/v1/crates?q=${q}&per_page=${per}`, { Accept: "application/json" }).then((d: any) =>
      (d.crates || []).map((c: any) => ({ title: c.name, url: `https://crates.io/crates/${c.name}`, text: (c.description || "").slice(0, 300), engine: "crates-direct" })),
    ).catch(() => []),
  );
  const parts = await Promise.all(jobs);
  return parts.flat().slice(0, numResults);
}

// Academic: OpenAlex + arXiv (https) + Crossref polite pool (all keyless, verified)
async function academicFreeSearch(query: string, numResults: number): Promise<SearchResult[]> {
  const q = encodeURIComponent(query);
  const per = Math.max(2, Math.ceil(numResults / 2));
  const jobs: Promise<SearchResult[]>[] = [
    freeGet(`https://api.openalex.org/works?search=${q}&per-page=${per}&mailto=research@example.com`).then((d: any) =>
      (d.results || []).map((w: any) => ({ title: w.title || "", url: w.doi ? `https://doi.org/${w.doi.replace("https://doi.org/", "")}` : (w.primary_location?.landing_page_url || ""), text: (w.abstract_inverted_index ? "" : "") + (w.title || ""), score: (w.cited_by_count || 0) / 10000, engine: "openalex-direct", publishedDate: w.publication_year ? String(w.publication_year) : undefined })),
    ).catch(() => []),
    freeGet(`https://api.crossref.org/works?query=${q}&rows=${per}&mailto=research@example.com`, {}).then((d: any) =>
      (d.message?.items || []).map((it: any) => ({ title: (it.title || [""])[0], url: it.URL || (it.DOI ? `https://doi.org/${it.DOI}` : ""), text: (it.abstract || "").replace(/<[^>]+>/g, "").slice(0, 500), engine: "crossref-direct" })),
    ).catch(() => []),
  ];
  // arXiv is XML: fetch raw and extract titles/ids minimally
  jobs.push(
    (async () => {
      try {
        const resp = await fetch(`https://export.arxiv.org/api/query?search_query=all:${q}&max_results=${per}&sortBy=submittedDate`, {
          headers: { "User-Agent": "searxng-mcp/2.0 (research)" }, signal: AbortSignal.timeout(15000),
        });
        const xml = await resp.text();
        const out: SearchResult[] = [];
        for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
          const body = m[1];
          const title = (body.match(/<title>([\s\S]*?)<\/title>/)?.[1] || "").replace(/\s+/g, " ").trim();
          const id = body.match(/<id>(.*?)<\/id>/)?.[1]?.trim() || "";
          const summary = (body.match(/<summary>([\s\S]*?)<\/summary>/)?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 500);
          if (title) out.push({ title, url: id, text: summary, engine: "arxiv-direct" });
        }
        return out;
      } catch { return []; }
    })(),
  );
  const parts = await Promise.all(jobs);
  return parts.flat().slice(0, numResults);
}

// ── SearXNG (proven + expanded API-backed engines) ─────────────────────
const CATEGORY_ENGINES: Record<string, string> = {
  general: "google cse,bing,wikipedia,wikidata",
  it: "github,npm,docker hub,stackoverflow,pypi,crates.io,huggingface",
  science: "arxiv,crossref,openalex,semantic scholar,pubmed,europepmc",
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

// ── Orchestrator: Exa → Tavily → free direct → SearXNG → FlareSolverr (quality-first) ──
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

  // Free direct APIs third (keyless, high-precision for it/science)
  try {
    const results =
      category === "it" ? await techFreeSearch(query, numResults)
      : category === "science" ? await academicFreeSearch(query, numResults)
      : [];
    if (results.length > 0) return { source: "free-direct", results };
    console.error(`[searxng-mcp] free-direct empty for "${query}"`);
  } catch (e: any) {
    console.error(`[searxng-mcp] free-direct failed for "${query}": ${e.message}`);
  }
  await jitter();

  // SearXNG expanded engines fourth
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
  "General web search for broad discovery: blog posts, docs, discussions, news. Backed by Exa (primary), Tavily (fallback), then SearXNG (Google CSE/Bing). Use for 'what is X', landscape surveys, finding links. Not for academic papers — use academic_search.",
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

// tech_search DISABLED 2026-11-15: tech lane folded into web_search (quality-first).
// server.tool(
//   "tech_search",
//   "Technical and code research: search GitHub repos/issues, npm packages, Docker Hub, Stack Overflow. Backed by Exa (primary), Tavily (fallback), then SearXNG. Use for implementation questions, finding libraries, repo discovery, community consensus on tools. Not for general info or academic papers.",
//   commonParams,
//   async ({ query, numResults, timeRange }) => {
//     return enqueue(async () => {
//       await jitter();
//       const start = performance.now();
//       const { source, results } = await searchWithFallback(query, "it", numResults, timeRange);
//       console.error(`[searxng-mcp] tech_search "${query}" source=${source} results=${results.length} time=${Math.round(performance.now() - start)}ms`);
//       return { content: [{ type: "text", text: buildMcpText(source, query, results, numResults) }] };
//     });
//   },
// );

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
