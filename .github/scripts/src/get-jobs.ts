import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import {
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
} from "./config";

type SponsorshipStatus = "Likely" | "No" | "Unknown";

type SponsorCacheEntry = {
  status: SponsorshipStatus;
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

const APPLY_IMG_URL = "https://i.imgur.com/JpkfjIq.png";

const CACHE_DIR = path.join(process.cwd(), "cache");
const SPONSOR_CACHE_PATH = path.join(CACHE_DIR, "jobright_sponsor_cache.json");

// When true, only keep rows with sponsorship === "Likely"
const REQUIRE_SPONSORSHIP = (process.env.REQUIRE_SPONSORSHIP ?? "").toLowerCase() === "true";

// When true, drop rows where job posting is detected closed
const DROP_CLOSED = (process.env.DROP_CLOSED ?? "true").toLowerCase() !== "false";

// If true, ALSO enforce INCLUDE_TITLE_PATTERNS for Jobright sources.
// Default is false (high recall). Turning this on will reduce counts a lot.
const STRICT_JOBRIGHT_TITLE_FILTER = (process.env.STRICT_JOBRIGHT_TITLE_FILTER ?? "").toLowerCase() === "true";

// Limit parallel HTTP requests when checking sponsorship (avoid being rate-limited)
const SPONSOR_FETCH_CONCURRENCY = Number(process.env.SPONSOR_FETCH_CONCURRENCY ?? "6") || 6;

// Keep cache entries for at most N days (to prevent unbounded growth)
const SPONSOR_CACHE_KEEP_DAYS = Number(process.env.SPONSOR_CACHE_KEEP_DAYS ?? "60") || 60;

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

function parseHtmlOrMarkdownLink(cell: string): { text: string; url: string | null } {
  const trimmed = cell.trim();

  // HTML: <a href="...">Text</a>
  const htmlMatch = trimmed.match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/i);
  if (htmlMatch) {
    const url = ensureHttps(htmlMatch[1]?.trim() ?? null);
    const inner = htmlMatch[2]?.replace(/<[^>]+>/g, "") ?? "";
    return { text: normalizeWhitespace(inner) || normalizeWhitespace(trimmed), url };
  }

  // Markdown: cell may contain wrappers like **[Text](url)**.
  // So we search for a markdown link ANYWHERE in the cell.
  const mdAnywhere = trimmed.match(/\[([^\]]+)\]\(([^)]+)\)/);
  if (mdAnywhere) {
    return {
      text: normalizeWhitespace(mdAnywhere[1] ?? ""),
      url: ensureHttps((mdAnywhere[2] ?? "").trim() || null),
    };
  }

  return { text: normalizeWhitespace(trimmed), url: null };
}

function parseHrefFromHtmlAnchor(cell: string): string | null {
  const m = cell.match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>/i);
  return m ? ensureHttps(m[1]?.trim() ?? null) : null;
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

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((re) => re.test(text));
}

function isExplicitNonUsLocation(location: string): boolean {
  const loc = location.trim();
  if (!loc) return false; // keep unknown
  return EXPLICIT_NON_US_LOCATION_PATTERNS.some((re) => re.test(loc));
}

function shouldKeepTitle(track: TrackId, title: string, sourceKind: SourceKind): boolean {
  const t = title.trim();

  // Always exclude obvious non-target buckets
  if (matchesAny(EXCLUDE_TITLE_PATTERNS, t)) return false;

  if (track === "new_grad" && matchesAny(EXCLUDE_NEW_GRAD_ONLY_PATTERNS, t)) return false;

  // Jobright repos are already role-curated; filtering again kills recall.
  if (sourceKind === "jobright" && !STRICT_JOBRIGHT_TITLE_FILTER) return true;

  return matchesAny(INCLUDE_TITLE_PATTERNS, t);
}

function shouldKeepInternSanity(track: TrackId, title: string): boolean {
  const isInternTitle = matchesAny(INTERN_TITLE_PATTERNS, title);
  if (track === "new_grad") return !isInternTitle;
  return true;
}

async function fetchText(url: string, timeoutMs = 20000): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "job-list-bot/1.0 (+https://github.com)",
        Accept: "text/plain,text/html,*/*",
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

function parseSpeedyapplyMarkdown(markdown: string, source: Source, track: TrackId): JobRow[] {
  const lines = markdown.split(/\r?\n/);

  let headerCells: string[] | null = null;
  let colIndex: Record<string, number> = {};

  const rows: JobRow[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();

    // Detect table header row
    if (
      trimmed.startsWith("|") &&
      trimmed.toLowerCase().includes("company") &&
      trimmed.toLowerCase().includes("position") &&
      trimmed.toLowerCase().includes("location")
    ) {
      const cells = trimmed
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      headerCells = cells;

      colIndex = {};
      for (let c = 0; c < cells.length; c += 1) {
        colIndex[cells[c] ?? ""] = c;
      }

      // Skip the separator line next (|---|---|...)
      i += 1;
      continue;
    }

    // Parse rows after a detected header
    if (headerCells && trimmed.startsWith("|")) {
      const cells = trimmed
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());

      const companyCell = cells[colIndex["Company"] ?? -1] ?? "";
      const position = cells[colIndex["Position"] ?? -1] ?? "";
      const location = cells[colIndex["Location"] ?? -1] ?? "";
      const postingCell = cells[colIndex["Posting"] ?? -1] ?? "";
      const ageCell = cells[colIndex["Age"] ?? -1] ?? "";
      const sourceCell = cells[colIndex["Source"] ?? -1] ?? "";

      if (!position || !location || !postingCell) continue;

      const { text: companyName, url: companyUrlRaw } = parseHtmlOrMarkdownLink(companyCell);
      const companyUrl = ensureHttps(companyUrlRaw);

      const postingUrl = parseHrefFromHtmlAnchor(postingCell);
      if (!postingUrl) continue;

      const ageDays = parseAgeToDays(ageCell);

      const { text: sourceShort, url: sourceUrlRaw } = parseHtmlOrMarkdownLink(sourceCell);

      rows.push({
        companyName: companyName || "Unknown",
        companyUrl,
        position: normalizeWhitespace(position),
        location: normalizeWhitespace(location),
        workModel: null,
        postingUrl,
        ageDays,

        sourceId: source.id,
        sourceKind: source.kind,
        sourceShort: sourceShort || source.name,
        sourceUrl: ensureHttps(sourceUrlRaw) || source.sourceUrl,

        sponsorship: "Unknown",
        track,
      });

      continue;
    }

    // End of table if we hit a non-table line
    if (headerCells && !trimmed.startsWith("|")) {
      headerCells = null;
      colIndex = {};
    }
  }

  return rows;
}

function monthToIndex(mon: string): number | null {
  const m = mon.toLowerCase();
  const map: Record<string, number> = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };
  return Object.prototype.hasOwnProperty.call(map, m) ? map[m]! : null;
}

function parseJobrightMonthDay(dateText: string, nowUtc: Date): Date | null {
  const m = dateText.trim().match(/^([A-Za-z]{3})\s+(\d{1,2})$/);
  if (!m) return null;

  const monthIdx = monthToIndex(m[1] ?? "");
  if (monthIdx === null) return null;

  const day = Number(m[2]);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;

  let year = nowUtc.getUTCFullYear();
  let d = new Date(Date.UTC(year, monthIdx, day));

  // If parsed date is in the future (relative to now), assume last year.
  if (d.getTime() > nowUtc.getTime() + 24 * 60 * 60 * 1000) {
    year -= 1;
    d = new Date(Date.UTC(year, monthIdx, day));
  }

  return d;
}

function jobrightSourceShort(source: Source): string {
  // Keep it short for the table.
  if (source.id.startsWith("jr_da")) return "JR-DA";
  if (source.id.startsWith("jr_ba")) return "JR-BA";
  return "JR";
}

type JobrightLineParsed = {
  companyName: string;
  companyUrl: string | null;
  jobTitle: string;
  jobUrl: string;
  location: string;
  workModel: string | null;
  dateText: string | null;
};

function parseJobrightLineFreeform(
  line: string,
  lastCompany: { name: string; url: string | null } | null,
): { parsed: JobrightLineParsed | null; nextCompany: { name: string; url: string | null } | null } {
  const cleaned = line.replace(/^↳\s*/, "").trim();

  const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
  const links = Array.from(cleaned.matchAll(linkRe));
  if (links.length === 0) return { parsed: null, nextCompany: lastCompany };

  let companyName: string;
  let companyUrl: string | null;
  let jobTitle: string;
  let jobUrl: string;
  let rest = "";

  if (links.length >= 2) {
    companyName = normalizeWhitespace(links[0]?.[1] ?? "");
    companyUrl = ensureHttps(links[0]?.[2] ?? null);
    jobTitle = normalizeWhitespace(links[1]?.[1] ?? "");
    jobUrl = ensureHttps(links[1]?.[2] ?? null) ?? "";

    const secondLink = links[1];
    const afterSecond = secondLink ? cleaned.slice((secondLink.index ?? 0) + secondLink[0].length) : "";
    rest = afterSecond.trim();
  } else {
    if (!lastCompany) return { parsed: null, nextCompany: lastCompany };
    companyName = lastCompany.name;
    companyUrl = lastCompany.url;
    jobTitle = normalizeWhitespace(links[0]?.[1] ?? "");
    jobUrl = ensureHttps(links[0]?.[2] ?? null) ?? "";

    const firstLink = links[0];
    const afterFirst = firstLink ? cleaned.slice((firstLink.index ?? 0) + firstLink[0].length) : "";
    rest = afterFirst.trim();
  }

  if (!companyName || !jobTitle || !jobUrl || !rest) {
    return { parsed: null, nextCompany: lastCompany };
  }

  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return { parsed: null, nextCompany: lastCompany };

  const dateText = `${tokens[tokens.length - 2]} ${tokens[tokens.length - 1]}`.trim();
  const tokensNoDate = tokens.slice(0, -2);

  let workModel: string | null = null;
  if (tokensNoDate.length >= 2 && tokensNoDate.slice(-2).join(" ") === "On Site") {
    workModel = "On Site";
    tokensNoDate.splice(-2, 2);
  } else {
    const wm = tokensNoDate[tokensNoDate.length - 1];
    if (wm && ["Remote", "Hybrid", "Onsite", "On-Site"].includes(wm)) {
      workModel = wm === "On-Site" ? "On Site" : wm;
      tokensNoDate.pop();
    }
  }

  const location = normalizeWhitespace(tokensNoDate.join(" "));
  if (!location) return { parsed: null, nextCompany: lastCompany };

  const parsed: JobrightLineParsed = {
    companyName,
    companyUrl,
    jobTitle,
    jobUrl,
    location,
    workModel,
    dateText,
  };

  const nextCompany = { name: companyName, url: companyUrl };

  return { parsed, nextCompany };
}

function parseJobrightReadme(markdown: string, source: Source, track: TrackId): JobRow[] {
  const nowUtc = new Date();
  const lines = markdown.split(/\r?\n/);

  // Locate the section (Jobright uses emojis on this header; do not require end-of-line match)
  const startIdx = lines.findIndex((l) => /^##\s+daily job list\b/i.test(l.trim()));
  if (startIdx < 0) {
    console.warn(`[warn] jobright: could not find a "Daily Job List" section in ${source.readmeRawUrl ?? source.sourceUrl}`);
    return [];
  }

  // Find the header (either a table header line starting with |, or a freeform header)
  let headerIdx = -1;
  for (let i = startIdx + 1; i < Math.min(lines.length, startIdx + 60); i += 1) {
    const t = (lines[i] ?? "").trim();
    if (!t) continue;

    const lower = t.toLowerCase();
    if (lower.includes("company") && lower.includes("job") && lower.includes("location")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) headerIdx = startIdx;

  const headerLine = (lines[headerIdx] ?? "").trim();
  const isTable = headerLine.startsWith("|");

  const rows: JobRow[] = [];
  const sourceShort = jobrightSourceShort(source);

  if (isTable) {
    const headerCells = headerLine
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    const colIndex: Record<string, number> = {};
    for (let c = 0; c < headerCells.length; c += 1) {
      colIndex[headerCells[c] ?? ""] = c;
    }

    // Skip separator line if present
    let i = headerIdx + 1;
    if (i < lines.length && (lines[i] ?? "").trim().startsWith("|---")) i += 1;

    let lastCompany: { name: string; url: string | null } | null = null;

    for (; i < lines.length; i += 1) {
      const raw = lines[i] ?? "";
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("## ")) break;
      if (!line.startsWith("|")) continue;

      const cells = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      if (cells.length < 3) continue;

      const companyCell = cells[colIndex["Company"] ?? -1] ?? "";
      const jobCell = cells[colIndex["Job Title"] ?? colIndex["Job"] ?? -1] ?? "";
      const locationCell = cells[colIndex["Location"] ?? -1] ?? "";
      const workModelCell = cells[colIndex["Work Model"] ?? -1] ?? "";
      const dateCell = cells[colIndex["Date Posted"] ?? -1] ?? "";

      let companyName: string | null = null;
      let companyUrl: string | null = null;

      const companyCellTrim = companyCell.replace(/^↳\s*/, "").trim();
      if (companyCellTrim && companyCellTrim !== "↳") {
        const parsedCompany = parseHtmlOrMarkdownLink(companyCellTrim);
        companyName = parsedCompany.text || null;
        companyUrl = ensureHttps(parsedCompany.url);
        if (companyName) lastCompany = { name: companyName, url: companyUrl };
      } else if (lastCompany) {
        companyName = lastCompany.name;
        companyUrl = lastCompany.url;
      }

      const parsedJob = parseHtmlOrMarkdownLink(jobCell.replace(/^↳\s*/, "").trim());
      const jobTitle = parsedJob.text;
      const jobUrl = ensureHttps(parsedJob.url) ?? "";

      const location = normalizeWhitespace(locationCell);
      if (!location || isExplicitNonUsLocation(location)) continue;

      const workModel = workModelCell ? normalizeWhitespace(workModelCell) : null;
      const dateText = dateCell ? normalizeWhitespace(dateCell) : null;

      if (!companyName || !jobTitle || !jobUrl) continue;

      const date = dateText ? parseJobrightMonthDay(dateText, nowUtc) : null;
      const ageDays = date ? Math.max(0, Math.floor((nowUtc.getTime() - date.getTime()) / (24 * 60 * 60 * 1000))) : null;

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

  // Freeform format (rare, but keep for robustness)
  let lastCompany: { name: string; url: string | null } | null = null;

  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? "";
    const line = rawLine.trim();

    if (!line) continue;
    if (line.startsWith("## ")) break;
    if (line.startsWith("---")) continue;

    const { parsed, nextCompany } = parseJobrightLineFreeform(line, lastCompany);
    if (!parsed) continue;
    lastCompany = nextCompany;

    if (isExplicitNonUsLocation(parsed.location)) continue;

    const date = parsed.dateText ? parseJobrightMonthDay(parsed.dateText, nowUtc) : null;
    const ageDays = date ? Math.max(0, Math.floor((nowUtc.getTime() - date.getTime()) / (24 * 60 * 60 * 1000))) : null;

    rows.push({
      companyName: parsed.companyName,
      companyUrl: parsed.companyUrl,
      position: parsed.jobTitle,
      location: parsed.location,
      workModel: parsed.workModel,
      postingUrl: parsed.jobUrl,
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

function parseJobrightSponsorship(html: string): { status: SponsorshipStatus; note?: string; isClosed?: boolean } {
  const lower = html.toLowerCase();

  const isClosed = lower.includes("this job has closed") || lower.includes("job is no longer available");

  // Jobright pages often include these tokens
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

async function enrichSponsorship(rows: JobRow[], cache: SponsorCache): Promise<void> {
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

  // fetch only missing urls
  const urlsToFetch = uniqueUrls.filter((u) => !cache[u]);

  if (urlsToFetch.length > 0) {
    console.log(
      `[info] sponsorship: fetching ${urlsToFetch.length} jobright pages (concurrency=${SPONSOR_FETCH_CONCURRENCY})`,
    );
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

  // Apply cache to rows
  for (const r of jobrightRows) {
    const key = stripUrlQuery(r.postingUrl);
    const entry = cache[key];
    if (!entry) continue;
    r.sponsorship = entry.status;
    r.sponsorshipNote = entry.note;
    r.isClosed = entry.isClosed;
  }
}

function formatUpdatedUtc(now: Date): string {
  // "YYYY-MM-DD HH:mm"
  const iso = now.toISOString(); // UTC
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
  if (status === "Likely") return "Likely";
  if (status === "No") return "No";
  if (note) return `Unknown (${escapePipes(note)})`;
  return "Unknown";
}

function sortRows(rows: JobRow[]): JobRow[] {
  // Prioritize: sponsorship Likely first, then Unknown, then No; within that, newest first (age asc)
  const rank = (s: SponsorshipStatus): number => {
    if (s === "Likely") return 0;
    if (s === "Unknown") return 1;
    return 2;
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

  for (const r of rows) {
    const key = stripUrlQuery(r.postingUrl);
    const prev = byUrl.get(key);
    if (!prev) {
      byUrl.set(key, r);
      continue;
    }
    // Prefer the row that has sponsorship info and/or smaller age
    const prevScore = (prev.sponsorship !== "Unknown" ? 2 : 0) + (prev.ageDays !== null ? 1 : 0);
    const curScore = (r.sponsorship !== "Unknown" ? 2 : 0) + (r.ageDays !== null ? 1 : 0);

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

    // Prefer sponsorship Likely, then Unknown, then No
    const rank = (s: SponsorshipStatus): number => (s === "Likely" ? 0 : s === "Unknown" ? 1 : 2);
    const prevRank = rank(prev.sponsorship);
    const curRank = rank(r.sponsorship);
    if (curRank < prevRank) {
      byFingerprint.set(fp, r);
      continue;
    }
    if (curRank === prevRank) {
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

  const headerLines = [
    title,
    "",
    `Updated: **${updatedUtc} (UTC)**`,
    "",
    `Total roles: **${total}**`,
    "",
    "Sponsorship column is a best-effort signal (parsed from Jobright H1B labels when available). Always verify on the official posting.",
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
    "This repository is an **auto-updating** list of BA/DA roles in the **United States only** (full-time new grad + internships).",
    "",
    "**Key data sources:**",
    "- Jobright BA/DA trackers (high recall; README typically shows the last ~7 days).",
    "- SpeedyApply job lists (supplemental).",
    "",
    `Last updated: **${updatedUtc} (UTC)**`,
    "",
    "## Quick Links",
    "",
    "### Full-Time (New Grad)",
    `- [NEW_GRAD_USA.md](/NEW_GRAD_USA.md) — **${counts.new_grad}** roles`,
    "",
    "### Internships",
    `- [INTERN_USA.md](/INTERN_USA.md) — **${counts.intern}** roles`,
    "",
    "## Update Schedule",
    "",
    "- GitHub Actions runs on a **6-hour schedule (UTC)** (best effort; GitHub may delay scheduled runs).",
    "- Forks do not run scheduled workflows by default — you must enable Actions in your repo settings.",
    "",
    "## Notes / Limitations",
    "",
    "- Sponsorship is **not guaranteed** by any tag. Treat it as a prioritization signal, not a promise.",
    "- We filter out explicit non-US locations, but location strings are messy; you should still sanity-check.",
    "- Always verify work authorization requirements on the official job posting.",
    "",
    "## Power-user options (workflow env vars)",
    "",
    "- `REQUIRE_SPONSORSHIP=true` : keep only rows marked `Likely`.",
    "- `STRICT_JOBRIGHT_TITLE_FILTER=true` : also apply title regex filtering to Jobright sources (reduces counts a lot).",
    "",
  ].join("\n");
}

async function collectRowsForTrack(track: TrackId): Promise<JobRow[]> {
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

      rows.push(...parseJobrightReadme(md, source, track));
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
    const trackRows = await collectRowsForTrack(trackMeta.id);

    // Title filtering early (before sponsorship fetch)
    const filtered = trackRows
      .filter((r) => shouldKeepTitle(trackMeta.id, r.position, r.sourceKind))
      .filter((r) => shouldKeepInternSanity(trackMeta.id, r.position))
      .filter((r) => Boolean(r.postingUrl));

    allRows.push(...filtered);
  }

  // Sponsorship enrichment (jobright only)
  await enrichSponsorship(allRows, sponsorCache);
  saveSponsorCache(sponsorCache);

  // Optionally drop closed postings
  const afterClosed = DROP_CLOSED ? allRows.filter((r) => !r.isClosed) : allRows;

  // Optional: require sponsorship Likely
  const afterSponsorshipFilter = REQUIRE_SPONSORSHIP ? afterClosed.filter((r) => r.sponsorship === "Likely") : afterClosed;

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

  // README
  const readmeContent = renderReadme(counts, updatedUtc);
  const readmePath = path.join(process.cwd(), "..", "..", "README.md");
  writeFileSync(readmePath, readmeContent, { encoding: "utf-8" });

  console.log("[done] job list update complete");
}

void main();
