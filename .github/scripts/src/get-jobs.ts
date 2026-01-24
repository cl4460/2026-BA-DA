import * as fs from "fs";
import * as path from "path";

import {
  EXCLUDE_TITLE_PATTERNS,
  HEADERS,
  INCLUDE_TITLE_PATTERNS,
  MARKERS,
  MAX_AGE_DAYS,
  README_PATH,
  REGIONS,
  UPSTREAM_SOURCES,
} from "./config";

type Category = keyof typeof MARKERS;
type Region = (typeof REGIONS)[number];
type UpstreamSource = (typeof UPSTREAM_SOURCES)[number];

type Row = {
  company: string;
  position: string;
  location: string;
  salary: string;
  posting: string;
  age: string;
  ageDays: number;
  jobUrl: string;
  sourceCell: string;
  category: Category;
};

type RegionTables = Record<Category, Row[]>;

const CATEGORY_PRIORITY: Record<Category, number> = {
  faang: 3,
  quant: 2,
  other: 1,
};

function normalizeText(input: string): string {
  return (
    input
      // Strip HTML tags
      .replace(/<[^>]*>/g, " ")
      // Decode common entities
      .replace(/&amp;/g, "&")
      .replace(/&nbsp;/g, " ")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      // Normalize whitespace
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase()
  );
}

function extractHref(html: string): string | null {
  const match = html.match(/href="([^"]+)"/i);
  return match ? match[1] : null;
}

function parseAgeDays(ageCell: string): number | null {
  const n = Number.parseInt(ageCell.replace(/[^0-9]/g, ""), 10);
  if (!Number.isFinite(n)) return null;
  if (n < 0) return null;
  return n;
}

function isTargetRole(positionCell: string): boolean {
  const title = normalizeText(positionCell);

  // Exclude first to reduce obvious false positives.
  if (EXCLUDE_TITLE_PATTERNS.some((re) => re.test(title))) return false;

  return INCLUDE_TITLE_PATTERNS.some((re) => re.test(title));
}

function extractTableBlock(
  markdown: string,
  marker: { start: string; end: string }
): string {
  const startIdx = markdown.indexOf(marker.start);
  const endIdx = markdown.indexOf(marker.end);

  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
    throw new Error(
      `Could not find table markers: ${marker.start} ... ${marker.end}`
    );
  }

  return markdown.slice(startIdx + marker.start.length, endIdx).trim();
}

function parseTableRows(
  tableBlock: string,
  source: UpstreamSource,
  region: Region,
  category: Category
): Row[] {
  const lines = tableBlock
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"));

  if (lines.length < 2) return [];

  const headerCols = lines[0]
    .split("|")
    .slice(1, -1)
    .map((c) => c.trim());
  const hasSalary = headerCols.some((c) => c.toLowerCase() === "salary");

  const rows: Row[] = [];

  // Skip header + separator.
  for (const line of lines.slice(2)) {
    const cols = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());

    // Expect either:
    // - 5 cols: Company, Position, Location, Posting, Age
    // - 6 cols: Company, Position, Location, Salary, Posting, Age
    if ((hasSalary && cols.length < 6) || (!hasSalary && cols.length < 5)) {
      continue;
    }

    const company = cols[0] ?? "";
    const position = cols[1] ?? "";
    const location = cols[2] ?? "";

    const salary = hasSalary ? cols[3] ?? "" : "";
    const posting = hasSalary ? cols[4] ?? "" : cols[3] ?? "";
    const age = hasSalary ? cols[5] ?? "" : cols[4] ?? "";

    const jobUrl = extractHref(posting);
    const ageDays = parseAgeDays(age);

    // If we cannot uniquely identify the posting, skip to prevent duplicates/pollution.
    if (!jobUrl) continue;
    if (ageDays === null) continue;
    if (ageDays > MAX_AGE_DAYS) continue;
    if (!isTargetRole(position)) continue;

    const sourceCell = `<a href="https://github.com/${source.repo}/blob/main/${region.upstreamPath}"><strong>${source.label}</strong></a>`;

    rows.push({
      company,
      position,
      location,
      salary,
      posting,
      age: `${ageDays}d`,
      ageDays,
      jobUrl,
      sourceCell,
      category,
    });
  }

  return rows;
}

async function fetchUpstreamMarkdown(
  source: UpstreamSource,
  region: Region
): Promise<string> {
  const url = `${source.baseUrl}/${region.upstreamPath}`;
  try {
    const res = await fetch(url, {
      // Helps some CDNs / proxies that dislike missing UA.
      headers: { "user-agent": "ba-da-college-jobs-sync" },
    });

    if (!res.ok) {
      throw new Error(
        `Failed to fetch ${url}: ${res.status} ${res.statusText}`
      );
    }

    return await res.text();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Fetch failed for ${url}: ${message}`);
  }
}

/**
 * Merge rows across upstream sources, deduping by jobUrl.
 *
 * If the same job appears multiple times:
 * - Prefer higher category priority (faang > quant > other)
 * - Prefer more recent (smaller ageDays)
 * - Prefer the one that has salary filled in
 */
function mergeAndDedupe(rows: Row[]): RegionTables {
  const byUrl = new Map<string, Row>();

  for (const row of rows) {
    const existing = byUrl.get(row.jobUrl);
    if (!existing) {
      byUrl.set(row.jobUrl, row);
      continue;
    }

    const existingPriority = CATEGORY_PRIORITY[existing.category] ?? 0;
    const candidatePriority = CATEGORY_PRIORITY[row.category] ?? 0;

    if (candidatePriority > existingPriority) {
      byUrl.set(row.jobUrl, row);
      continue;
    }
    if (candidatePriority < existingPriority) {
      continue;
    }

    // Same priority: choose the more recent posting.
    if (row.ageDays < existing.ageDays) {
      byUrl.set(row.jobUrl, row);
      continue;
    }
    if (row.ageDays > existing.ageDays) {
      continue;
    }

    // Same age: prefer salary.
    const existingHasSalary = (existing.salary || "").trim().length > 0;
    const candidateHasSalary = (row.salary || "").trim().length > 0;
    if (candidateHasSalary && !existingHasSalary) {
      byUrl.set(row.jobUrl, row);
    }
  }

  const tables: RegionTables = { faang: [], quant: [], other: [] };

  for (const row of byUrl.values()) {
    tables[row.category].push(row);
  }

  // Sort each table by recency (age ascending).
  (Object.keys(tables) as Category[]).forEach((cat) => {
    tables[cat].sort((a, b) => a.ageDays - b.ageDays);
  });

  return tables;
}

function renderMarkdownTable(rows: Row[]): string {
  let table = `| ${HEADERS.join(" | ")} |\n`;
  table += `|${HEADERS.map(() => "---").join("|")}|\n`;

  for (const r of rows) {
    const cols = [
      r.company,
      r.position,
      r.location,
      r.salary || "",
      r.posting,
      r.age,
      r.sourceCell,
    ];
    table += `| ${cols.join(" | ")} |\n`;
  }

  return table;
}

function renderRegionPage(
  region: Region,
  tables: RegionTables,
  updated: string
): string {
  const total = tables.faang.length + tables.quant.length + tables.other.length;

  const header =
    region.id === "usa"
      ? `## 2026 USA Business Analyst & Data Analyst Full-Time (New Grad) Positions :mortar_board::eagle:\n`
      : `## 2026 International Business Analyst & Data Analyst Full-Time (New Grad) Positions :mortar_board::globe_with_meridians:\n`;

  return [
    header,
    `Updated: **${updated} (UTC)**`,
    "",
    `Total roles: **${total}**`,
    "",
    "### FAANG+",
    "",
    MARKERS.faang.start,
    renderMarkdownTable(tables.faang),
    MARKERS.faang.end,
    "",
    "### Quant",
    "",
    MARKERS.quant.start,
    renderMarkdownTable(tables.quant),
    MARKERS.quant.end,
    "",
    "### Other",
    "",
    MARKERS.other.start,
    renderMarkdownTable(tables.other),
    MARKERS.other.end,
    "",
    "<a name=\"bottom\"></a>",
    "",
  ].join("\n");
}

function renderReadme(
  usaCount: number,
  intlCount: number,
  updated: string
): string {
  const upstreamLines = UPSTREAM_SOURCES.map(
    (s) => `- [${s.repo}](https://github.com/${s.repo})`
  ).join("\n");

  return [
    "# 2026 Business Analyst & Data Analyst Full-Time (New Grad) Positions",
    "",
    "This repository is an **auto-updating** list of Business Analyst / Data Analyst full-time roles (focused on new-grad/early-career postings).",
    "",
    "It syncs daily from the public upstream job lists and filters by title keywords:",
    upstreamLines,
    "",
    "If you want to adjust what counts as a BA/DA role, edit:",
    "- `.github/scripts/src/config.ts` (INCLUDE_TITLE_PATTERNS / EXCLUDE_TITLE_PATTERNS)",
    "",
    `Last updated: **${updated} (UTC)**`,
    "",
    "## Quick Links",
    "",
    `- USA: [NEW_GRAD_USA.md](/NEW_GRAD_USA.md) — **${usaCount}** roles`,
    `- International: [NEW_GRAD_INTL.md](/NEW_GRAD_INTL.md) — **${intlCount}** roles`,
    "",
    "## Notes / Limitations",
    "",
    "- This list is only as comprehensive as the upstream sources; it will **miss** companies that are not present there.",
    "- Title-based filtering can produce false positives/negatives. Expect to tune the keyword rules.",
    "- GitHub disables scheduled workflows by default on forks — you must enable Actions in your repo settings for daily updates to run.",
    "",
  ].join("\n");
}

async function buildRegionTables(region: Region): Promise<RegionTables> {
  const allRows: Row[] = [];

  for (const source of UPSTREAM_SOURCES) {
    const md = await fetchUpstreamMarkdown(source, region);

    const faangBlock = extractTableBlock(md, MARKERS.faang);
    const quantBlock = extractTableBlock(md, MARKERS.quant);
    const otherBlock = extractTableBlock(md, MARKERS.other);

    allRows.push(...parseTableRows(faangBlock, source, region, "faang"));
    allRows.push(...parseTableRows(quantBlock, source, region, "quant"));
    allRows.push(...parseTableRows(otherBlock, source, region, "other"));
  }

  return mergeAndDedupe(allRows);
}

async function main() {
  const updated = new Date().toISOString().slice(0, 10);

  const regionTables: Record<string, RegionTables> = {};
  for (const region of REGIONS) {
    regionTables[region.id] = await buildRegionTables(region);
  }

  // Write per-region pages.
  for (const region of REGIONS) {
    const outPath = path.join(__dirname, region.outputPath);
    const page = renderRegionPage(region, regionTables[region.id], updated);
    fs.writeFileSync(outPath, page, { encoding: "utf8" });
  }

  // Write README.
  const usaTables = regionTables["usa"];
  const intlTables = regionTables["intl"];

  const usaCount =
    (usaTables?.faang.length ?? 0) +
    (usaTables?.quant.length ?? 0) +
    (usaTables?.other.length ?? 0);

  const intlCount =
    (intlTables?.faang.length ?? 0) +
    (intlTables?.quant.length ?? 0) +
    (intlTables?.other.length ?? 0);

  const readmePath = path.join(__dirname, README_PATH);
  fs.writeFileSync(readmePath, renderReadme(usaCount, intlCount, updated), {
    encoding: "utf8",
  });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exitCode = 1;
});
