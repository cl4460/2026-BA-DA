/**
 * Configuration for syncing and filtering jobs from upstream repos.
 *
 * IMPORTANT:
 * - This fork no longer depends on SpeedyApply's private Supabase keys.
 * - Instead, it fetches already-updated markdown tables from public upstream repos
 *   and filters them down to Business Analyst / Data Analyst related roles.
 */

export const UPSTREAM_SOURCES = [
  {
    id: "swe",
    label: "SWE",
    repo: "speedyapply/2026-SWE-College-Jobs",
    baseUrl:
      "https://raw.githubusercontent.com/speedyapply/2026-SWE-College-Jobs/main",
  },
  {
    id: "ai",
    label: "AI",
    repo: "speedyapply/2026-AI-College-Jobs",
    baseUrl:
      "https://raw.githubusercontent.com/speedyapply/2026-AI-College-Jobs/main",
  },
] as const;

export const REGIONS = [
  {
    id: "usa",
    label: "USA",
    upstreamPath: "NEW_GRAD_USA.md",
    outputPath: "../../../NEW_GRAD_USA.md",
  },
  {
    id: "intl",
    label: "International",
    upstreamPath: "NEW_GRAD_INTL.md",
    outputPath: "../../../NEW_GRAD_INTL.md",
  },
] as const;

export const README_PATH = "../../../README.md";

/**
 * Tuning knobs
 *
 * Be conservative:
 * - Too broad (e.g., just "analyst") will pollute the list with finance/risk/quant roles.
 * - Too narrow may miss roles like "BI Analyst" or "Business Systems Analyst".
 */
export const INCLUDE_TITLE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bdata\s+analyst\b/i,
  /\bbusiness\s+(systems\s+)?analyst\b/i,
  /\bbusiness\s+intelligence\b/i,
  /\bbi\s+analyst\b/i,
  /\bdata\s+analytics\s+analyst\b/i,
];

/**
 * Extra exclusions to reduce false positives.
 *
 * NOTE: Upstream "new grad" lists sometimes contain non-new-grad roles;
 * these rules try to filter out obvious mismatches.
 */
export const EXCLUDE_TITLE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bintern(ship)?\b/i,
  /\bsenior\b/i,
  /\bsr\.?\b/i,
  /\bstaff\b/i,
  /\bprincipal\b/i,
  /\blead\b/i,
  /\bmanager\b/i,
  /\bdirector\b/i,
  /\bvp\b/i,
  /\bvice\s+president\b/i,
  /\bphd\b/i,
  /\bpostdoc\b/i,
];

/**
 * Upstream repos claim they prioritize postings within the last ~120 days.
 * This is a safety net in case older rows slip in.
 */
export const MAX_AGE_DAYS = 120;

/**
 * Output table columns.
 *
 * We always include a Salary column; if upstream doesn't provide it, it will be blank.
 */
export const HEADERS = [
  "Company",
  "Position",
  "Location",
  "Salary",
  "Posting",
  "Age",
  "Source",
];

export const MARKERS = {
  faang: {
    start: "<!-- TABLE_FAANG_START -->",
    end: "<!-- TABLE_FAANG_END -->",
  },
  quant: {
    start: "<!-- TABLE_QUANT_START -->",
    end: "<!-- TABLE_QUANT_END -->",
  },
  other: { start: "<!-- TABLE_START -->", end: "<!-- TABLE_END -->" },
} as const;
