import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import {
  ATS_SEED_SOURCES,
  SOURCES,
  TRACKS,
  INCLUDE_TITLE_PATTERNS,
  EXCLUDE_TITLE_PATTERNS,
  EXCLUDE_NEW_GRAD_ONLY_PATTERNS,
  INTERN_TITLE_PATTERNS,
  EXPLICIT_NON_US_LOCATION_PATTERNS,
  type TrackId,
  type Source,
  type SourceKind,
  type AtsSeedSource,
} from "./config";

// ---- Types ----

type SponsorshipStatus = "Yes" | "Likely" | "No" | "Unknown";

type SponsorCacheEntry = {
  status: Exclude<SponsorshipStatus, "Yes">; // Jobright only emits Likely/No/Unknown
  note?: string;
  checkedAtIso: string;
  isClosed?: boolean;
};

type SponsorCache = Record<string, SponsorCacheEntry>;

type JobRow = {
  companyName: string;
  companyUrl: string | null;
  position: string;
  location: string;
  workModel: string | null;
  postingUrl: string;
  ageDays: number | null; // null when unknown

  sourceId: string;
  sourceKind: SourceKind;
  sourceShort: string;
  sourceUrl: string;

  sponsorship: SponsorshipStatus;
  sponsorshipNote?: string;
  isClosed?: boolean;

  track: TrackId;
};

type AtsKind = "greenhouse" | "lever" | "ashby";

type AtsBoard = {
  kind: AtsKind;
  slug: string;
  companyName: string;
  seedId: string;
  seedLabel: string;
};

// ---- Constants / Env ----

const APPLY_IMG_URL = "https://i.imgur.com/JpkfjIq.png";

const CACHE_DIR = path.join(process.cwd(), "cache");
const SPONSOR_CACHE_PATH = path.join(CACHE_DIR, "jobright_sponsor_cache.json");

// When true, only keep rows with sponsorship == Yes/Likely
const REQUIRE_SPONSORSHIP = (process.env.REQUIRE_SPONSORSHIP ?? "").toLowerCase() === "true";

// When true, drop rows where job posting is detected closed (Jobright only)
const DROP_CLOSED = (process.env.DROP_CLOSED ?? "true").toLowerCase() !== "false";

// If true, ALSO enforce INCLUDE_TITLE_PATTERNS for Jobright sources.
// Default is false (high recall). Turning this on will reduce counts a lot.
const STRICT_JOBRIGHT_TITLE_FILTER = (process.env.STRICT_JOBRIGHT_TITLE_FILTER ?? "").toLowerCase() === "true";

// Parallel HTTP requests when checking Jobright sponsorship
const SPONSOR_FETCH_CONCURRENCY = Number(process.env.SPONSOR_FETCH_CONCURRENCY ?? "6") || 6;

// Keep cache entries for at most N days (to prevent unbounded growth)
const SPONSOR_CACHE_KEEP_DAYS = Number(process.env.SPONSOR_CACHE_KEEP_DAYS ?? "60") || 60;

// ATS expansion
const ENABLE_ATS = (process.env.ENABLE_ATS ?? "true").toLowerCase() !== "false";
const ATS_FETCH_CONCURRENCY = Number(process.env.ATS_FETCH_CONCURRENCY ?? "8") || 8;
const ATS_REQUEST_TIMEOUT_MS = Number(process.env.ATS_REQUEST_TIMEOUT_MS ?? "20000") || 20000;
const ATS_MAX_BOARDS_PER_KIND = Number(process.env.ATS_MAX_BOARDS_PER_KIND ?? "120") || 120;
const ATS_MAX_PAGES_PER_BOARD = Number(process.env.ATS_MAX_PAGES_PER_BOARD ?? "5") || 5;

// ---- Basic helpers ----

function escapePipes(text: string): string {
  return text.replace(/\|/g, "\\|");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function ensureHttps(url: string | null): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("//")) return `https:${trimmed}`;
  // crude heuristic: only prefix if it looks like a hostname
  if (/^[\w.-]+\.[A-Za-z]{2,}($|\/)/.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

function stripUrlQuery(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

function isExplicitNonUsLocation(location: string): boolean {
  const loc = location.trim();
  if (!loc) return false; // keep unknown
  return EXPLICIT_NON_US_LOCATION_PATTERNS.some((re) => re.test(loc));
}

function inferWorkModel(location: string): string | null {
  const t = location.toLowerCase();
  if (!t) return null;
  if (t.includes("remote")) return "Remote";
  if (t.includes("hybrid")) return "Hybrid";
  if (t.includes("on-site") || t.includes("onsite") || t.includes("on site")) return "On Site";
  return null;
}

function computeAgeDays(nowUtc: Date, date: Date | null): number | null {
  if (!date) return null;
  const diffMs = nowUtc.getTime() - date.getTime();
  if (!Number.isFinite(diffMs)) return null;
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
}

function titleToTrack(title: string): TrackId {
  return matchesAny(INTERN_TITLE_PATTERNS, title) ? "intern" : "new_grad";
}

function shouldKeepTitle(track: TrackId, title: string, sourceKind: SourceKind): boolean {
  const t = title.trim();
  if (!t) return false;

  // Always exclude obvious non-target buckets
  if (matchesAny(EXCLUDE_TITLE_PATTERNS, t)) return false;

  if (track === "new_grad" && matchesAny(EXCLUDE_NEW_GRAD_ONLY_PATTERNS, t)) return false;

  // Jobright repos are already role-curated; filtering again kills recall.
  if (sourceKind === "jobright" && !STRICT_JOBRIGHT_TITLE_FILTER) return true;

  return matchesAny(INCLUDE_TITLE_PATTERNS, t);
}

function shouldKeepInternSanity(track: TrackId, title: string, sourceKind: SourceKind): boolean {
  const isInternTitle = matchesAny(INTERN_TITLE_PATTERNS, title);
  if (track === "new_grad") return !isInternTitle;

  // For internship list, only Jobright is curated; other sources must explicitly look like internships.
  if (sourceKind === "jobright") return true;
  return isInternTitle;
}

// ---- URL parsing helpers (markdown/HTML) ----

function parseHtmlOrMarkdownLink(cell: string): { text: string; url: string | null } {
  const trimmed = cell.trim();

  // HTML: <a href="...">Text</a>
  const htmlMatch = trimmed.match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/i);
  if (htmlMatch) {
    const url = ensureHttps(htmlMatch[1]?.trim() ?? null);
    const inner = htmlMatch[2]?.replace(/<[^>]+>/g, "") ?? "";
    return { text: normalizeWhitespace(inner) || normalizeWhitespace(trimmed), url };
  }

  // Markdown image-link (common in community job lists):
  //   [![Apply](https://...img...)](https://...apply...)
  // NOTE: A naive /\[[^\]]+\]\((url)\)/ regex will incorrectly grab the image URL.
  const mdImageLink = trimmed.match(/\[\s*!\[[^\]]*\]\([^)]*\)\s*\]\((https?:\/\/[^)\s]+)\)/i);
  if (mdImageLink) {
    return {
      text: "Apply",
      url: ensureHttps((mdImageLink[1] ?? "").trim() || null),
    };
  }

  // Markdown link ANYWHERE in the cell (handles wrappers like **[Text](url)**)
  const mdAnywhere = trimmed.match(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/);
  if (mdAnywhere) {
    return {
      text: normalizeWhitespace(mdAnywhere[1] ?? ""),
      url: ensureHttps((mdAnywhere[2] ?? "").trim() || null),
    };
  }

  // Bare URL fallback
  const bare = trimmed.match(/https?:\/\/[^\s)]+/i);
  if (bare) {
    return { text: normalizeWhitespace(trimmed), url: ensureHttps(bare[0].trim() || null) };
  }

  // Fallback: plain text
  return { text: normalizeWhitespace(trimmed), url: null };
}

function parseAgeToDays(ageCell: string): number | null {
  const t = ageCell.trim();
  if (!t) return null;

  const d = t.match(/^(\d+)\s*d$/i);
  if (d) return Number(d[1]);

  const h = t.match(/^(\d+)\s*h$/i);
  if (h) return 0;

  const w = t.match(/^(\d+)\s*w$/i);
  if (w) return Number(w[1]) * 7;

  const mo = t.match(/^(\d+)\s*mo$/i);
  if (mo) return Number(mo[1]) * 30;

  return null;
}

// ---- Networking ----

async function fetchText(url: string, timeoutMs = 20000): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "job-list-bot/1.1 (+https://github.com)",
        Accept: "text/plain,text/markdown,text/html,application/json,*/*",
      },
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status} for ${url}`);
    }

    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchTextOrNull(url: string, timeoutMs = 20000): Promise<string | null> {
  try {
    return await fetchText(url, timeoutMs);
  } catch (err) {
    console.warn(`[warn] fetch failed: ${url}\n       ${(err as Error).message}`);
    return null;
  }
}

async function fetchJsonOrNull<T>(url: string, timeoutMs = 20000): Promise<T | null> {
  const txt = await fetchTextOrNull(url, timeoutMs);
  if (!txt) return null;
  try {
    return JSON.parse(txt) as T;
  } catch (err) {
    console.warn(`[warn] json parse failed: ${url}\n       ${(err as Error).message}`);
    return null;
  }
}

// ---- Markdown table parsing for GitHub lists ----

function parsePipeRow(line: string): string[] {
  // expects something like: | a | b | c |
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return [];
  const parts = trimmed.split("|");
  // drop leading/trailing empty
  return parts
    .slice(1, -1)
    .map((c) => normalizeWhitespace(c.replace(/<br\s*\/?\s*>/gi, " ")));
}

function parseAllPipeTables(markdown: string): Array<{ headers: string[]; rows: string[][] }> {
  const lines = markdown.split(/\r?\n/);
  const tables: Array<{ headers: string[]; rows: string[][] }> = [];

  for (let i = 0; i < lines.length - 1; i += 1) {
    const line = (lines[i] ?? "").trim();
    const next = (lines[i + 1] ?? "").trim();

    if (!line.startsWith("|") || !next.startsWith("|")) continue;

    // separator row usually contains ---
    if (!/\|\s*:?-{2,}/.test(next)) continue;

    const headers = parsePipeRow(line);
    if (headers.length < 3) continue;

    const rows: string[][] = [];
    i += 2; // move to first data row

    while (i < lines.length) {
      const rowLine = (lines[i] ?? "").trim();
      if (!rowLine.startsWith("|")) {
        i -= 1; // step back because outer loop will increment
        break;
      }
      const row = parsePipeRow(rowLine);
      if (row.length === headers.length) rows.push(row);
      i += 1;
    }

    tables.push({ headers, rows });
  }

  return tables;
}

function headerIndex(headers: string[], needles: string[]): number {
  const lower = headers.map((h) => h.toLowerCase());
  for (const n of needles) {
    const idx = lower.findIndex((h) => h === n.toLowerCase());
    if (idx !== -1) return idx;
  }
  for (const n of needles) {
    const idx = lower.findIndex((h) => h.includes(n.toLowerCase()));
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseMaybeDate(dateText: string, nowUtc: Date): Date | null {
  const t = normalizeWhitespace(dateText);
  if (!t) return null;

  // YYYY-MM-DD
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // common formats like "Jan 5" or "Jan 05" or "Jan 05, 2026"
  // If year missing, assume current UTC year.
  const hasYear = /\b\d{4}\b/.test(t);
  const year = hasYear ? "" : `, ${nowUtc.getUTCFullYear()}`;
  const d = new Date(`${t}${year} UTC`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseGithubTableMarkdown(markdown: string, source: Source, track: TrackId, nowUtc: Date): JobRow[] {
  const tables = parseAllPipeTables(markdown);
  const rows: JobRow[] = [];

  for (const table of tables) {
    const idxCompany = headerIndex(table.headers, ["company", "employer"]);
    const idxRole = headerIndex(table.headers, ["role", "position", "title", "job"]);
    const idxLocation = headerIndex(table.headers, ["location"]);

    // link column names vary a lot
    const idxLink = headerIndex(table.headers, ["application", "apply", "link", "url", "posting"]);
    const idxDate = headerIndex(table.headers, ["date", "posted"]);
    const idxWork = headerIndex(table.headers, ["work model", "workplace", "work"]);

    // Must have at least company/role/location.
    if (idxCompany === -1 || idxRole === -1 || idxLocation === -1) continue;

    let lastCompany: { name: string; url: string | null } | null = null;

    for (const r of table.rows) {
      const companyCell = r[idxCompany] ?? "";
      const roleCell = r[idxRole] ?? "";
      const locCell = r[idxLocation] ?? "";

      const companyParsed = parseHtmlOrMarkdownLink(companyCell);
      let companyName = companyParsed.text;
      let companyUrl = companyParsed.url;

      // handle ↳ / empty company cell
      if (!companyName || companyName === "↳" || companyName === "->") {
        if (lastCompany) {
          companyName = lastCompany.name;
          companyUrl = lastCompany.url;
        }
      } else {
        lastCompany = { name: companyName, url: companyUrl };
      }

      const roleParsed = parseHtmlOrMarkdownLink(roleCell);
      const position = roleParsed.text;

      const location = normalizeWhitespace(locCell);
      if (!companyName || !position || !location) continue;
      if (isExplicitNonUsLocation(location)) continue;

      // determine posting url
      let postingUrl: string | null = null;
      if (idxLink !== -1) {
        const linkParsed = parseHtmlOrMarkdownLink(r[idxLink] ?? "");
        postingUrl = linkParsed.url;
      }
      if (!postingUrl) postingUrl = roleParsed.url;
      if (!postingUrl) continue;

      const workModelCell = idxWork !== -1 ? normalizeWhitespace(r[idxWork] ?? "") : "";
      const workModel = workModelCell || inferWorkModel(location);

      const dateCell = idxDate !== -1 ? normalizeWhitespace(r[idxDate] ?? "") : "";
      const dt = dateCell ? parseMaybeDate(dateCell, nowUtc) : null;
      const ageDays = computeAgeDays(nowUtc, dt);

      rows.push({
        companyName,
        companyUrl,
        position,
        location,
        workModel,
        postingUrl,
        ageDays,
        sourceId: source.id,
        sourceKind: source.kind,
        sourceShort: source.shortLabel,
        sourceUrl: source.sourceUrl,
        sponsorship: "Unknown",
        track,
      });
    }
  }

  return rows;
}

// ---- SpeedyApply parsing (existing upstream format) ----

function parseSpeedyapplyMarkdown(markdown: string, source: Source, track: TrackId): JobRow[] {
  const lines = markdown.split(/\r?\n/);

  let headerCells: string[] | null = null;
  let colIndex: Record<string, number> = {};

  const rows: JobRow[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // detect header row
    if (!headerCells && trimmed.startsWith("|") && trimmed.includes("Company") && trimmed.includes("Position")) {
      headerCells = parsePipeRow(trimmed);
      colIndex = {};
      headerCells.forEach((h, idx) => {
        colIndex[h.toLowerCase()] = idx;
      });
      continue;
    }

    // skip until we have header
    if (!headerCells) continue;

    // stop if table ends
    if (!trimmed.startsWith("|")) {
      // allow trailing
      continue;
    }

    // skip separator row
    if (/\|\s*:?-{2,}/.test(trimmed)) continue;

    const cells = parsePipeRow(trimmed);
    if (cells.length !== headerCells.length) continue;

    const companyCell = cells[colIndex["company"] ?? -1] ?? "";
    const positionCell = cells[colIndex["position"] ?? -1] ?? "";
    const locationCell = cells[colIndex["location"] ?? -1] ?? "";
    const applyCell = cells[colIndex["apply"] ?? -1] ?? "";

    const companyParsed = parseHtmlOrMarkdownLink(companyCell);
    const companyName = companyParsed.text;
    const companyUrl = companyParsed.url;

    const positionParsed = parseHtmlOrMarkdownLink(positionCell);
    const jobTitle = positionParsed.text;

    const location = normalizeWhitespace(locationCell);
    if (!location || isExplicitNonUsLocation(location)) continue;

    let jobUrl = positionParsed.url;
    if (!jobUrl) {
      const applyParsed = parseHtmlOrMarkdownLink(applyCell);
      jobUrl = applyParsed.url;
    }
    if (!companyName || !jobTitle || !jobUrl) continue;

    // optional columns
    const workModelCell = cells[colIndex["work model"] ?? -1] ?? "";
    const workModel = workModelCell ? normalizeWhitespace(workModelCell) : inferWorkModel(location);

    const ageCell = cells[colIndex["age"] ?? -1] ?? "";
    const ageDays = ageCell ? parseAgeToDays(ageCell) : null;

    rows.push({
      companyName,
      companyUrl,
      position: jobTitle,
      location,
      workModel,
      postingUrl: jobUrl,
      ageDays,
      sourceId: source.id,
      sourceKind: source.kind,
      sourceShort: source.shortLabel,
      sourceUrl: source.sourceUrl,
      sponsorship: "Unknown",
      track,
    });
  }

  return rows;
}

// ---- Jobright parsing ----

function parseJobrightMonthDay(dateText: string, nowUtc: Date): Date | null {
  // Examples in Jobright README: "Jan 24" or "Jan 24"; assume current year (UTC)
  const t = normalizeWhitespace(dateText);
  if (!t) return null;
  const year = nowUtc.getUTCFullYear();
  const d = new Date(`${t}, ${year} UTC`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseJobrightReadme(markdown: string, source: Source, track: TrackId, nowUtc: Date): JobRow[] {
  const lines = markdown.split(/\r?\n/);
  const rows: JobRow[] = [];

  const sourceShort = source.shortLabel;

  // Find first table header
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (line.startsWith("|") && /\bCompany\b/i.test(line) && /\bPosition\b/i.test(line) && /\bLocation\b/i.test(line)) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) return rows;

  const headers = parsePipeRow(lines[headerIdx] ?? "");
  const idxCompany = headerIndex(headers, ["company"]);
  const idxPosition = headerIndex(headers, ["position", "role", "title"]);
  const idxLocation = headerIndex(headers, ["location"]);
  const idxWorkModel = headerIndex(headers, ["work model", "workplace"]);
  const idxPosting = headerIndex(headers, ["posting", "apply", "link"]);
  const idxDate = headerIndex(headers, ["date", "posted"]);
  const idxAge = headerIndex(headers, ["age"]);

  let lastCompany: { name: string; url: string | null } | null = null;

  for (let i = headerIdx + 2; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    if (!line.startsWith("|")) {
      // stop on next section
      if (line.startsWith("## ")) break;
      continue;
    }

    // skip separator rows
    if (/\|\s*:?-{2,}/.test(line)) continue;

    const cells = parsePipeRow(line);
    if (cells.length !== headers.length) continue;

    const companyCell = cells[idxCompany] ?? "";
    const positionCell = cells[idxPosition] ?? "";
    const locationCell = cells[idxLocation] ?? "";
    const workModelCell = idxWorkModel !== -1 ? cells[idxWorkModel] ?? "" : "";
    const postingCell = idxPosting !== -1 ? cells[idxPosting] ?? "" : "";
    const dateCell = idxDate !== -1 ? cells[idxDate] ?? "" : "";
    const ageCell = idxAge !== -1 ? cells[idxAge] ?? "" : "";

    let companyParsed = parseHtmlOrMarkdownLink(companyCell);
    let companyName = companyParsed.text;
    let companyUrl = companyParsed.url;

    if (!companyName || companyName === "↳" || companyName === "->") {
      if (lastCompany) {
        companyName = lastCompany.name;
        companyUrl = lastCompany.url;
      }
    } else {
      lastCompany = { name: companyName, url: companyUrl };
    }

    const positionParsed = parseHtmlOrMarkdownLink(positionCell);
    const jobTitle = positionParsed.text;

    const location = normalizeWhitespace(locationCell);
    if (!location || isExplicitNonUsLocation(location)) continue;

    // Jobright README usually links the job title to jobright page
    let jobUrl = positionParsed.url;
    if (!jobUrl) {
      const postingParsed = parseHtmlOrMarkdownLink(postingCell);
      jobUrl = postingParsed.url;
    }
    if (!companyName || !jobTitle || !jobUrl) continue;

    const workModel = workModelCell ? normalizeWhitespace(workModelCell) : inferWorkModel(location);

    // Prefer explicit age column if present; otherwise derive from date column
    let ageDays: number | null = null;
    const parsedAge = parseAgeToDays(ageCell);
    if (parsedAge !== null) {
      ageDays = parsedAge;
    } else {
      const dt = dateCell ? parseJobrightMonthDay(dateCell, nowUtc) : null;
      ageDays = computeAgeDays(nowUtc, dt);
    }

    rows.push({
      companyName,
      companyUrl,
      position: jobTitle,
      location,
      workModel,
      postingUrl: jobUrl,
      ageDays,
      sourceId: source.id,
      sourceKind: source.kind,
      sourceShort,
      sourceUrl: source.sourceUrl,
      sponsorship: "Unknown",
      track,
    });
  }

  return rows;
}

// ---- Sponsorship enrichment (Jobright only) ----

function loadSponsorCache(): SponsorCache {
  try {
    if (!existsSync(SPONSOR_CACHE_PATH)) return {};
    const raw = readFileSync(SPONSOR_CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as SponsorCache;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch (err) {
    console.warn(`[warn] failed to load sponsor cache: ${(err as Error).message}`);
    return {};
  }
}

function pruneSponsorCache(cache: SponsorCache, keepDays: number): void {
  const now = Date.now();
  const keepMs = keepDays * 24 * 60 * 60 * 1000;

  for (const [url, entry] of Object.entries(cache)) {
    const ts = Date.parse(entry.checkedAtIso);
    if (!Number.isFinite(ts)) continue;
    if (now - ts > keepMs) delete cache[url];
  }
}

function saveSponsorCache(cache: SponsorCache): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  const json = JSON.stringify(cache, null, 2);
  writeFileSync(SPONSOR_CACHE_PATH, json, { encoding: "utf-8" });
}

function parseJobrightSponsorship(html: string): { status: Exclude<SponsorshipStatus, "Yes">; note?: string; isClosed?: boolean } {
  const lower = html.toLowerCase();

  const isClosed = lower.includes("this job has closed") || lower.includes("job is no longer available");

  if (lower.includes("no h1b")) {
    return { status: "No", note: "No H1B", isClosed };
  }
  if (lower.includes("h1b sponsor likely")) {
    return { status: "Likely", note: "H1B Sponsor Likely", isClosed };
  }
  if (lower.includes("h1b sponsor")) {
    return { status: "Likely", note: "H1B Sponsor", isClosed };
  }

  return { status: "Unknown", isClosed };
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  let running = 0;

  await new Promise<void>((resolve) => {
    const launchNext = (): void => {
      if (queue.length === 0 && running === 0) {
        resolve();
        return;
      }
      while (running < concurrency && queue.length > 0) {
        const item = queue.shift()!;
        running += 1;
        fn(item)
          .catch((err) => {
            console.warn(`[warn] concurrency task failed: ${(err as Error).message}`);
          })
          .finally(() => {
            running -= 1;
            launchNext();
          });
      }
    };
    launchNext();
  });
}

async function enrichJobrightSponsorship(rows: JobRow[], cache: SponsorCache): Promise<void> {
  const jobrightRows = rows.filter((r) => r.postingUrl.includes("jobright.ai"));

  const uniqueUrls: string[] = [];
  const seen = new Set<string>();
  for (const r of jobrightRows) {
    const key = stripUrlQuery(r.postingUrl);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueUrls.push(key);
    }
  }

  const urlsToFetch = uniqueUrls.filter((u) => !cache[u]);

  if (urlsToFetch.length > 0) {
    console.log(`[info] sponsorship: fetching ${urlsToFetch.length} Jobright pages (concurrency=${SPONSOR_FETCH_CONCURRENCY})`);
  }

  await mapWithConcurrency(urlsToFetch, SPONSOR_FETCH_CONCURRENCY, async (url) => {
    const html = await fetchTextOrNull(url, 20000);
    const checkedAtIso = new Date().toISOString();

    if (!html) {
      cache[url] = { status: "Unknown", checkedAtIso };
      return;
    }

    const parsed = parseJobrightSponsorship(html);
    cache[url] = { status: parsed.status, note: parsed.note, isClosed: parsed.isClosed, checkedAtIso };
  });

  for (const r of jobrightRows) {
    const key = stripUrlQuery(r.postingUrl);
    const entry = cache[key];
    if (!entry) continue;
    r.sponsorship = entry.status;
    r.sponsorshipNote = entry.note;
    r.isClosed = entry.isClosed;
  }
}

// ---- Sponsorship heuristics for official ATS jobs ----

function sponsorshipFromText(raw: string): { status: SponsorshipStatus; note?: string } {
  const text = normalizeWhitespace(stripHtmlTags(raw)).toLowerCase();
  if (!text) return { status: "Unknown" };

  const negative = [
    /no\s+visa\s+sponsorship/i,
    /unable\s+to\s+sponsor/i,
    /cannot\s+sponsor/i,
    /will\s+not\s+sponsor/i,
    /does\s+not\s+sponsor/i,
    /without\s+sponsorship/i,
    /not\s+provide\s+.*sponsorship/i,
    /not\s+offer\s+.*sponsorship/i,
  ];

  const positive = [
    /visa\s+sponsorship\s+(is\s+)?available/i,
    /will\s+sponsor/i,
    /sponsorship\s+available/i,
    /h-?1b\s+sponsorship/i,
    /we\s+sponsor\s+visas?/i,
  ];

  if (negative.some((re) => re.test(text))) return { status: "No", note: "Text: no sponsorship" };
  if (positive.some((re) => re.test(text))) return { status: "Yes", note: "Text: sponsorship available" };

  // Soft hint: mentions H-1B / OPT without clear yes/no.
  if (/\bh-?1b\b/i.test(text) || /\bopt\b/i.test(text) || /\bcpt\b/i.test(text)) {
    return { status: "Likely", note: "Text mentions visa terms" };
  }

  return { status: "Unknown" };
}

// ---- ATS discovery from seed markdown ----

function prettyCompanyFromSlug(slug: string): string {
  const cleaned = slug.replace(/[-_]+/g, " ").trim();
  if (!cleaned) return slug;
  return cleaned
    .split(" ")
    .map((w) => (w.length <= 2 ? w.toUpperCase() : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
}

function extractAtsBoardsFromSeed(markdown: string, seed: AtsSeedSource): AtsBoard[] {
  const boards = new Map<string, AtsBoard>();

  const add = (kind: AtsKind, slugRaw: string, companyNameMaybe: string | null): void => {
    const slug = slugRaw.trim();
    if (!slug) return;

    const key = `${kind}:${slug.toLowerCase()}`;
    const existing = boards.get(key);

    const companyName = companyNameMaybe?.trim() || (existing?.companyName ?? prettyCompanyFromSlug(slug));

    if (!existing) {
      boards.set(key, {
        kind,
        slug,
        companyName,
        seedId: seed.id,
        seedLabel: seed.shortLabel,
      });
      return;
    }

    // Prefer longer/more descriptive company names from markdown link text.
    if (companyNameMaybe && companyName.length > existing.companyName.length) {
      existing.companyName = companyName;
    }
  };

  // 1) markdown links: [Name](url)
  const mdLinkRe = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  for (const m of markdown.matchAll(mdLinkRe)) {
    const name = normalizeWhitespace(m[1] ?? "");
    const url = (m[2] ?? "").trim();

    const gh = url.match(/https?:\/\/boards\.greenhouse\.io\/([A-Za-z0-9_-]+)/i);
    if (gh) {
      add("greenhouse", gh[1]!, name);
      continue;
    }
    const lv = url.match(/https?:\/\/jobs\.lever\.co\/([A-Za-z0-9_-]+)/i);
    if (lv) {
      add("lever", lv[1]!, name);
      continue;
    }
    const as = url.match(/https?:\/\/jobs\.ashbyhq\.com\/([A-Za-z0-9_-]+)/i);
    if (as) {
      add("ashby", as[1]!, name);
      continue;
    }
  }

  // 2) plain urls (no name)
  const ghRe = /https?:\/\/boards\.greenhouse\.io\/([A-Za-z0-9_-]+)/gi;
  for (const m of markdown.matchAll(ghRe)) add("greenhouse", m[1]!, null);

  const lvRe = /https?:\/\/jobs\.lever\.co\/([A-Za-z0-9_-]+)/gi;
  for (const m of markdown.matchAll(lvRe)) add("lever", m[1]!, null);

  const asRe = /https?:\/\/jobs\.ashbyhq\.com\/([A-Za-z0-9_-]+)/gi;
  for (const m of markdown.matchAll(asRe)) add("ashby", m[1]!, null);

  return Array.from(boards.values());
}

async function discoverAtsBoards(nowUtc: Date): Promise<AtsBoard[]> {
  const all: AtsBoard[] = [];

  for (const seed of ATS_SEED_SOURCES) {
    let md: string | null = null;
    for (const url of seed.rawUrls) {
      md = await fetchTextOrNull(url, 25000);
      if (md) break;
    }
    if (!md) {
      console.warn(`[warn] ATS seed fetch failed for ${seed.id}`);
      continue;
    }

    const extracted = extractAtsBoardsFromSeed(md, seed);
    console.log(`[info] ATS seed=${seed.id}: extracted boards=${extracted.length}`);
    all.push(...extracted);
  }

  // De-dupe across seeds
  const dedup = new Map<string, AtsBoard>();
  for (const b of all) {
    const key = `${b.kind}:${b.slug.toLowerCase()}`;
    const prev = dedup.get(key);
    if (!prev) {
      dedup.set(key, b);
      continue;
    }
    // Prefer more descriptive company name
    if (b.companyName.length > prev.companyName.length) dedup.set(key, b);
  }

  // Cap per kind to avoid timeouts
  const byKind: Record<AtsKind, AtsBoard[]> = {
    greenhouse: [],
    lever: [],
    ashby: [],
  };

  const sorted = Array.from(dedup.values()).sort((a, b) => {
    if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
    return a.slug.localeCompare(b.slug);
  });

  for (const b of sorted) {
    if (byKind[b.kind].length >= ATS_MAX_BOARDS_PER_KIND) continue;
    byKind[b.kind].push(b);
  }

  const capped = [...byKind.greenhouse, ...byKind.lever, ...byKind.ashby];
  console.log(
    `[info] ATS boards capped per kind=${ATS_MAX_BOARDS_PER_KIND}: greenhouse=${byKind.greenhouse.length}, lever=${byKind.lever.length}, ashby=${byKind.ashby.length}, total=${capped.length}`,
  );

  // Slight jitter to avoid hitting the exact same boards every run when the seed list is huge.
  // Deterministic per 6h window.
  const window = Math.floor(nowUtc.getTime() / (6 * 60 * 60 * 1000));
  const shuffled = capped
    .map((b) => ({ b, k: simpleHash(`${window}:${b.kind}:${b.slug}`) }))
    .sort((x, y) => x.k - y.k)
    .map((x) => x.b);

  return shuffled;
}

function simpleHash(s: string): number {
  // simple deterministic hash -> 32-bit int
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ---- ATS fetchers ----

async function fetchGreenhouseBoard(board: AtsBoard, nowUtc: Date): Promise<JobRow[]> {
  const rows: JobRow[] = [];
  const perPage = 100;

  for (let page = 1; page <= ATS_MAX_PAGES_PER_BOARD; page += 1) {
    const url =
      `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.slug)}/jobs` +
      `?content=true&page=${page}&per_page=${perPage}`;

    const data = await fetchJsonOrNull<{ jobs?: any[] }>(url, ATS_REQUEST_TIMEOUT_MS);
    const jobs = data?.jobs;
    if (!jobs || !Array.isArray(jobs) || jobs.length === 0) break;

    for (const j of jobs) {
      const title = normalizeWhitespace(String(j?.title ?? ""));
      if (!title) continue;

      const track = titleToTrack(title);

      const location = normalizeWhitespace(String(j?.location?.name ?? j?.location ?? ""));
      if (!location) continue;
      if (isExplicitNonUsLocation(location)) continue;

      if (!shouldKeepTitle(track, title, "ats_greenhouse")) continue;
      if (!shouldKeepInternSanity(track, title, "ats_greenhouse")) continue;

      const postingUrl = ensureHttps(String(j?.absolute_url ?? "")) ?? `https://boards.greenhouse.io/${board.slug}`;

      const updatedAt = String(j?.updated_at ?? j?.updatedAt ?? j?.created_at ?? j?.createdAt ?? "");
      const dt = updatedAt ? new Date(updatedAt) : null;
      const ageDays = computeAgeDays(nowUtc, dt && !Number.isNaN(dt.getTime()) ? dt : null);

      const content = String(j?.content ?? "");
      const sponsor = content ? sponsorshipFromText(content) : { status: "Unknown" as const };

      const workModel = inferWorkModel(location);

      rows.push({
        companyName: board.companyName,
        companyUrl: `https://boards.greenhouse.io/${board.slug}`,
        position: title,
        location,
        workModel,
        postingUrl,
        ageDays,
        sourceId: `gh:${board.slug}`,
        sourceKind: "ats_greenhouse",
        sourceShort: "GH",
        sourceUrl: `https://boards.greenhouse.io/${board.slug}`,
        sponsorship: sponsor.status,
        sponsorshipNote: sponsor.note,
        track,
      });
    }

    if (jobs.length < perPage) break;
  }

  return rows;
}

async function fetchLeverBoard(board: AtsBoard, nowUtc: Date): Promise<JobRow[]> {
  const url = `https://api.lever.co/v0/postings/${encodeURIComponent(board.slug)}?mode=json`;
  const data = await fetchJsonOrNull<any[]>(url, ATS_REQUEST_TIMEOUT_MS);
  if (!data || !Array.isArray(data)) return [];

  const rows: JobRow[] = [];

  for (const j of data) {
    const title = normalizeWhitespace(String(j?.text ?? j?.title ?? ""));
    if (!title) continue;

    const track = titleToTrack(title);

    const location = normalizeWhitespace(String(j?.categories?.location ?? j?.location ?? ""));
    if (!location) continue;
    if (isExplicitNonUsLocation(location)) continue;

    if (!shouldKeepTitle(track, title, "ats_lever")) continue;
    if (!shouldKeepInternSanity(track, title, "ats_lever")) continue;

    const postingUrl =
      ensureHttps(String(j?.hostedUrl ?? "")) ??
      ensureHttps(String(j?.applyUrl ?? "")) ??
      `https://jobs.lever.co/${board.slug}`;

    const createdAt = Number(j?.createdAt ?? j?.created_at ?? NaN);
    const dt = Number.isFinite(createdAt) ? new Date(createdAt) : null;
    const ageDays = computeAgeDays(nowUtc, dt && !Number.isNaN(dt.getTime()) ? dt : null);

    const desc = String(j?.descriptionPlain ?? j?.description ?? "");
    const sponsor = desc ? sponsorshipFromText(desc) : { status: "Unknown" as const };

    const workModel = inferWorkModel(location);

    rows.push({
      companyName: board.companyName,
      companyUrl: `https://jobs.lever.co/${board.slug}`,
      position: title,
      location,
      workModel,
      postingUrl,
      ageDays,
      sourceId: `lever:${board.slug}`,
      sourceKind: "ats_lever",
      sourceShort: "LV",
      sourceUrl: `https://jobs.lever.co/${board.slug}`,
      sponsorship: sponsor.status,
      sponsorshipNote: sponsor.note,
      track,
    });
  }

  return rows;
}

async function fetchAshbyBoard(board: AtsBoard, nowUtc: Date): Promise<JobRow[]> {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.slug)}`;
  const data = await fetchJsonOrNull<any>(url, ATS_REQUEST_TIMEOUT_MS);
  if (!data || typeof data !== "object") return [];

  const jobs: any[] =
    (Array.isArray((data as any).jobs) ? (data as any).jobs : null) ??
    (Array.isArray((data as any).jobPostings) ? (data as any).jobPostings : null) ??
    (Array.isArray((data as any).postings) ? (data as any).postings : null) ??
    [];

  if (!Array.isArray(jobs) || jobs.length === 0) return [];

  const rows: JobRow[] = [];

  for (const j of jobs) {
    const title = normalizeWhitespace(String(j?.title ?? j?.name ?? ""));
    if (!title) continue;

    const track = titleToTrack(title);

    const location = normalizeWhitespace(String(j?.location ?? j?.locationName ?? j?.location?.name ?? ""));
    if (!location) continue;
    if (isExplicitNonUsLocation(location)) continue;

    if (!shouldKeepTitle(track, title, "ats_ashby")) continue;
    if (!shouldKeepInternSanity(track, title, "ats_ashby")) continue;

    const postingUrl =
      ensureHttps(String(j?.jobUrl ?? "")) ??
      ensureHttps(String(j?.url ?? "")) ??
      `https://jobs.ashbyhq.com/${board.slug}`;

    const published = String(j?.publishedAt ?? j?.published_at ?? j?.createdAt ?? j?.created_at ?? "");
    const dt = published ? new Date(published) : null;
    const ageDays = computeAgeDays(nowUtc, dt && !Number.isNaN(dt.getTime()) ? dt : null);

    const desc = String(j?.descriptionHtml ?? j?.description ?? j?.descriptionPlain ?? "");
    const sponsor = desc ? sponsorshipFromText(desc) : { status: "Unknown" as const };

    const workModel = inferWorkModel(location);

    rows.push({
      companyName: board.companyName,
      companyUrl: `https://jobs.ashbyhq.com/${board.slug}`,
      position: title,
      location,
      workModel,
      postingUrl,
      ageDays,
      sourceId: `ashby:${board.slug}`,
      sourceKind: "ats_ashby",
      sourceShort: "AS",
      sourceUrl: `https://jobs.ashbyhq.com/${board.slug}`,
      sponsorship: sponsor.status,
      sponsorshipNote: sponsor.note,
      track,
    });
  }

  return rows;
}

async function collectAtsRows(nowUtc: Date): Promise<JobRow[]> {
  const boards = await discoverAtsBoards(nowUtc);

  const rows: JobRow[] = [];

  console.log(`[info] ATS fetching boards total=${boards.length} (concurrency=${ATS_FETCH_CONCURRENCY})`);

  await mapWithConcurrency(boards, ATS_FETCH_CONCURRENCY, async (b) => {
    try {
      let out: JobRow[] = [];
      if (b.kind === "greenhouse") out = await fetchGreenhouseBoard(b, nowUtc);
      else if (b.kind === "lever") out = await fetchLeverBoard(b, nowUtc);
      else out = await fetchAshbyBoard(b, nowUtc);

      if (out.length > 0) rows.push(...out);
    } catch (err) {
      console.warn(`[warn] ATS fetch failed (${b.kind}:${b.slug}): ${(err as Error).message}`);
    }
  });

  console.log(`[info] ATS produced rows=${rows.length}`);
  return rows;
}

// ---- Output rendering ----

function formatUpdatedUtc(now: Date): string {
  const iso = now.toISOString();
  return iso.replace("T", " ").slice(0, 16);
}

function renderApplyCell(url: string): string {
  const safeUrl = url.replace(/"/g, "%22");
  return `<a href="${safeUrl}" target="_blank"><img src="${APPLY_IMG_URL}" width="90" alt="Apply"/></a>`;
}

function renderCompanyCell(companyName: string, companyUrl: string | null): string {
  const name = escapePipes(companyName);
  if (companyUrl) return `[${name}](${companyUrl})`;
  return name;
}

function renderSourceCell(sourceShort: string, sourceUrl: string): string {
  const text = escapePipes(sourceShort);
  return `[${text}](${sourceUrl})`;
}

function renderSponsorshipCell(status: SponsorshipStatus, note?: string): string {
  if (status === "Yes") return "Yes";
  if (status === "Likely") return "Likely";
  if (status === "No") return "No";
  if (note) return `Unknown (${escapePipes(note)})`;
  return "Unknown";
}

function sortRows(rows: JobRow[]): JobRow[] {
  const rank = (s: SponsorshipStatus): number => {
    if (s === "Yes") return 0;
    if (s === "Likely") return 1;
    if (s === "Unknown") return 2;
    return 3;
  };

  return [...rows].sort((a, b) => {
    const ra = rank(a.sponsorship);
    const rb = rank(b.sponsorship);
    if (ra !== rb) return ra - rb;

    const aa = a.ageDays ?? 9999;
    const ab = b.ageDays ?? 9999;
    return aa - ab;
  });
}

function dedupeRows(rows: JobRow[]): JobRow[] {
  const byUrl = new Map<string, JobRow>();

  const score = (r: JobRow): number => {
    // Prefer sponsorship signal + known age
    const s = r.sponsorship === "Yes" ? 3 : r.sponsorship === "Likely" ? 2 : r.sponsorship === "Unknown" ? 1 : 0;
    const a = r.ageDays !== null ? 1 : 0;
    return s * 10 + a;
  };

  for (const r of rows) {
    const key = stripUrlQuery(r.postingUrl);
    const prev = byUrl.get(key);
    if (!prev) {
      byUrl.set(key, r);
      continue;
    }

    const prevScore = score(prev);
    const curScore = score(r);

    if (curScore > prevScore) {
      byUrl.set(key, r);
      continue;
    }
    if (curScore === prevScore) {
      const prevAge = prev.ageDays ?? 9999;
      const curAge = r.ageDays ?? 9999;
      if (curAge < prevAge) byUrl.set(key, r);
    }
  }

  // Secondary dedupe: same company+title+location
  const byFingerprint = new Map<string, JobRow>();
  for (const r of byUrl.values()) {
    const fp = `${r.companyName.toLowerCase()}|${r.position.toLowerCase()}|${r.location.toLowerCase()}`;
    const prev = byFingerprint.get(fp);
    if (!prev) {
      byFingerprint.set(fp, r);
      continue;
    }

    if (score(r) > score(prev)) {
      byFingerprint.set(fp, r);
      continue;
    }
    if (score(r) === score(prev)) {
      const prevAge = prev.ageDays ?? 9999;
      const curAge = r.ageDays ?? 9999;
      if (curAge < prevAge) byFingerprint.set(fp, r);
    }
  }

  return Array.from(byFingerprint.values());
}

function renderMarkdownFile(track: TrackId, rows: JobRow[], updatedUtc: string): string {
  const trackMeta = TRACKS.find((t) => t.id === track);
  const title = `# 2026 USA Business Analyst & Data Analyst ${trackMeta?.label ?? track} Positions`;

  const total = rows.length;

  const sourceCounts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.sourceShort] = (acc[r.sourceShort] ?? 0) + 1;
    return acc;
  }, {});

  const sourceBreakdownLines = Object.entries(sourceCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `- **${k}**: ${v}`);

  const headerLines = [
    title,
    "",
    `Updated: **${updatedUtc} (UTC)**`,
    "",
    `Total roles: **${total}**`,
    "",
    "Source breakdown (after filters):",
    ...sourceBreakdownLines,
    "",
    "Sponsorship is best-effort: (a) Jobright H1B labels when available, (b) keyword heuristics from ATS job descriptions. Always verify on the official posting.",
    "",
    "<!-- TABLE_START -->",
    "| Company | Position | Location | Work Model | Sponsorship | Posting | Age | Source |",
    "|---|---|---|---|---|---|---|---|",
  ];

  const bodyLines = rows.map((r) => {
    const company = renderCompanyCell(r.companyName, r.companyUrl);
    const position = escapePipes(r.position);
    const location = escapePipes(r.location);
    const workModel = escapePipes(r.workModel ?? "");
    const sponsorship = renderSponsorshipCell(r.sponsorship, r.sponsorshipNote);
    const posting = renderApplyCell(r.postingUrl);
    const age = r.ageDays === null ? "" : `${r.ageDays}d`;
    const source = renderSourceCell(r.sourceShort, r.sourceUrl);

    return `| ${company} | ${position} | ${location} | ${workModel} | ${sponsorship} | ${posting} | ${age} | ${source} |`;
  });

  const footerLines = ["<!-- TABLE_END -->", "", '<a name="bottom"></a>', ""];

  return [...headerLines, ...bodyLines, ...footerLines].join("\n");
}

function renderReadme(counts: Record<TrackId, number>, updatedUtc: string): string {
  return [
    "# 2026 USA Business Analyst & Data Analyst Jobs (Full-Time + Internships)",
    "",
    "This repository is an **auto-updating** list of BA/DA roles in the **United States only** (full-time + internships).",
    "",
    "## Data Sources (expanded)",
    "",
    "We aggregate from multiple sources to avoid single-site coverage gaps:",
    "- Jobright BA/DA trackers (curated lists; often last ~7 days)",
    "- SimplifyJobs community lists (broad; filtered for BA/DA)",
    "- Official ATS job boards (Greenhouse / Lever / Ashby) discovered from public seed lists",
    "- SpeedyApply lists (supplemental; filtered for BA/DA)",
    "",
    `Last updated: **${updatedUtc} (UTC)**`,
    "",
    "## Quick Links",
    "",
    "### Full-Time (New Grad / Entry Level)",
    `- [NEW_GRAD_USA.md](/NEW_GRAD_USA.md) — **${counts.new_grad}** roles`,
    "",
    "### Internships",
    `- [INTERN_USA.md](/INTERN_USA.md) — **${counts.intern}** roles`,
    "",
    "## Update Schedule",
    "",
    "- GitHub Actions runs on a **6-hour schedule (UTC)** (best effort; GitHub may delay scheduled runs).",
    "- Forks do not run scheduled workflows by default — enable Actions in your repo settings.",
    "",
    "## Notes / Limitations",
    "",
    "- We do NOT scrape LinkedIn/Indeed (ToS + reliability). We rely on GitHub lists and ATS public APIs.",
    "- Sponsorship is **best-effort** (heuristics). Always confirm on the official posting.",
    "- Location strings are messy; we drop explicit non-US, but still sanity-check.",
    "",
    "## Power-user options (workflow env vars)",
    "",
    "- `ENABLE_ATS=false` : disable ATS expansion (faster runs, fewer sources)",
    "- `ATS_MAX_BOARDS_PER_KIND=200` : increase coverage (may risk timeouts)",
    "- `REQUIRE_SPONSORSHIP=true` : keep only rows with `Yes` or `Likely` sponsorship",
    "- `STRICT_JOBRIGHT_TITLE_FILTER=true` : also apply title regex filtering to Jobright (reduces counts)",
    "",
  ].join("\n");
}

// ---- Collection orchestration ----

async function collectRowsForTrack(track: TrackId, nowUtc: Date): Promise<JobRow[]> {
  const rows: JobRow[] = [];

  for (const source of SOURCES) {
    if (source.kind === "speedyapply") {
      const base = source.rawBaseUrl;
      const relPath = source.upstreamPathByTrack?.[track];
      if (!base || !relPath) continue;

      const url = `${base}/${relPath}`;
      const md = await fetchTextOrNull(url, 25000);
      if (!md) continue;

      rows.push(...parseSpeedyapplyMarkdown(md, source, track));
    } else if (source.kind === "jobright") {
      if (source.track !== track) continue;
      const url = source.readmeRawUrl;
      if (!url) continue;

      const md = await fetchTextOrNull(url, 25000);
      if (!md) continue;

      rows.push(...parseJobrightReadme(md, source, track, nowUtc));
    } else if (source.kind === "github_table") {
      if (source.track !== track) continue;
      const url = source.readmeRawUrl;
      if (!url) continue;

      const md = await fetchTextOrNull(url, 30000);
      if (!md) continue;

      rows.push(...parseGithubTableMarkdown(md, source, track, nowUtc));
    }
  }

  return rows;
}

async function main(): Promise<void> {
  const now = new Date();
  const updatedUtc = formatUpdatedUtc(now);

  const sponsorCache = loadSponsorCache();
  pruneSponsorCache(sponsorCache, SPONSOR_CACHE_KEEP_DAYS);

  const allRows: JobRow[] = [];

  for (const trackMeta of TRACKS) {
    console.log(`[info] collecting track=${trackMeta.id}`);
    const trackRows = await collectRowsForTrack(trackMeta.id, now);

    const filtered = trackRows
      .filter((r) => shouldKeepTitle(trackMeta.id, r.position, r.sourceKind))
      .filter((r) => shouldKeepInternSanity(trackMeta.id, r.position, r.sourceKind))
      .filter((r) => Boolean(r.postingUrl));

    allRows.push(...filtered);
  }

  // ATS expansion
  if (ENABLE_ATS) {
    try {
      const atsRows = await collectAtsRows(now);
      allRows.push(...atsRows);
    } catch (err) {
      console.warn(`[warn] ATS collection failed: ${(err as Error).message}`);
    }
  } else {
    console.log("[info] ATS disabled (ENABLE_ATS=false)");
  }

  // Sponsorship enrichment (Jobright only)
  await enrichJobrightSponsorship(allRows, sponsorCache);
  saveSponsorCache(sponsorCache);

  // Optionally drop closed postings
  const afterClosed = DROP_CLOSED ? allRows.filter((r) => !r.isClosed) : allRows;

  // Optional: require sponsorship Yes/Likely
  const afterSponsorshipFilter = REQUIRE_SPONSORSHIP
    ? afterClosed.filter((r) => r.sponsorship === "Yes" || r.sponsorship === "Likely")
    : afterClosed;

  const counts: Record<TrackId, number> = {
    new_grad: 0,
    intern: 0,
  };

  for (const trackMeta of TRACKS) {
    const subset = afterSponsorshipFilter.filter((r) => r.track === trackMeta.id);
    const deduped = dedupeRows(subset);
    const sorted = sortRows(deduped);

    counts[trackMeta.id] = sorted.length;

    const content = renderMarkdownFile(trackMeta.id, sorted, updatedUtc);
    const outPath = path.join(process.cwd(), "..", "..", trackMeta.output); // repo root

    console.log(`[info] writing ${trackMeta.output} (${sorted.length} rows)`);
    writeFileSync(outPath, content, { encoding: "utf-8" });
  }

  const readmeContent = renderReadme(counts, updatedUtc);
  const readmePath = path.join(process.cwd(), "..", "..", "README.md");
  writeFileSync(readmePath, readmeContent, { encoding: "utf-8" });

  console.log("[done] job list update complete");
}

void main();
