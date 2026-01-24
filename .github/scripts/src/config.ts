// Central configuration for the job list generator.
// Keep this file small and explicit — anything fuzzy will reduce precision.

export type RegionId = "usa" | "intl";
export type TrackId = "new_grad" | "intern";

export const REGIONS = [
  { id: "usa", label: "USA" },
  { id: "intl", label: "International" },
] as const satisfies ReadonlyArray<{ id: RegionId; label: string }>;

export const TRACKS = [
  {
    id: "new_grad",
    label: "Full-Time (New Grad)",
    outputByRegion: {
      usa: "NEW_GRAD_USA.md",
      intl: "NEW_GRAD_INTL.md",
    },
  },
  {
    id: "intern",
    label: "Internships",
    outputByRegion: {
      usa: "INTERN_USA.md",
      intl: "INTERN_INTL.md",
    },
  },
] as const satisfies ReadonlyArray<{
  id: TrackId;
  label: string;
  outputByRegion: Record<RegionId, string>;
}>;

export type SourceKind = "speedyapply" | "jobright";

export type Source = {
  id: string;
  name: string;
  kind: SourceKind;
  sourceUrl: string;

  // speedyapply: fetch markdown tables from upstream files
  rawBaseUrl?: string;
  upstreamPathByTrackRegion?: Partial<Record<TrackId, Partial<Record<RegionId, string>>>>;

  // jobright: fetch README.md from upstream repo
  readmeRawUrl?: string;
  track?: TrackId;
};

export const SOURCES: readonly Source[] = [
  // Original upstream sources (good coverage for "tech-ish" roles, but BA/DA coverage is limited)
  {
    id: "speedy_ai",
    name: "SpeedyApply AI",
    kind: "speedyapply",
    sourceUrl: "https://github.com/speedyapply/2026-AI-College-Jobs",
    rawBaseUrl: "https://raw.githubusercontent.com/speedyapply/2026-AI-College-Jobs/main",
    upstreamPathByTrackRegion: {
      new_grad: { usa: "NEW_GRAD_USA.md", intl: "NEW_GRAD_INTL.md" },
      intern: { usa: "INTERN_USA.md", intl: "INTERN_INTL.md" },
    },
  },
  {
    id: "speedy_swe",
    name: "SpeedyApply SWE",
    kind: "speedyapply",
    sourceUrl: "https://github.com/speedyapply/2026-SWE-College-Jobs",
    rawBaseUrl: "https://raw.githubusercontent.com/speedyapply/2026-SWE-College-Jobs/main",
    upstreamPathByTrackRegion: {
      new_grad: { usa: "NEW_GRAD_USA.md", intl: "NEW_GRAD_INTL.md" },
      intern: { usa: "INTERN_USA.md", intl: "INTERN_INTL.md" },
    },
  },

  // Additional high-recall sources for BA/DA (updated frequently, includes H1B signal on job pages)
  {
    id: "jr_da_ng",
    name: "Jobright Data Analysis (New Grad)",
    kind: "jobright",
    track: "new_grad",
    sourceUrl: "https://github.com/jobright-ai/2026-Data-Analysis-New-Grad",
    readmeRawUrl: "https://raw.githubusercontent.com/jobright-ai/2026-Data-Analysis-New-Grad/master/README.md",
  },
  {
    id: "jr_ba_ng",
    name: "Jobright Business Analyst (New Grad)",
    kind: "jobright",
    track: "new_grad",
    sourceUrl: "https://github.com/jobright-ai/2026-Business-Analyst-New-Grad",
    readmeRawUrl: "https://raw.githubusercontent.com/jobright-ai/2026-Business-Analyst-New-Grad/master/README.md",
  },
  {
    id: "jr_da_intern",
    name: "Jobright Data Analysis (Internship)",
    kind: "jobright",
    track: "intern",
    sourceUrl: "https://github.com/jobright-ai/2026-Data-Analysis-Internship",
    readmeRawUrl: "https://raw.githubusercontent.com/jobright-ai/2026-Data-Analysis-Internship/master/README.md",
  },
  {
    id: "jr_ba_intern",
    name: "Jobright Business Analyst (Internship)",
    kind: "jobright",
    track: "intern",
    sourceUrl: "https://github.com/jobright-ai/2026-Business-Analyst-Internship",
    readmeRawUrl: "https://raw.githubusercontent.com/jobright-ai/2026-Business-Analyst-Internship/master/README.md",
  },
] as const;

// ===== Role filters (precision vs recall trade-offs) =====
// Keep the include list narrow to avoid pulling in generic "Analyst" roles that are not BA/DA.
// If you need higher recall, expand INCLUDE_TITLE_PATTERNS carefully.

export const INCLUDE_TITLE_PATTERNS: readonly RegExp[] = [
  /\bdata\s+analyst\b/i,
  /\bdata\s+analytics\s+analyst\b/i,
  /\bbusiness\s+analyst\b/i,
  /\bbusiness\s+data\s+analyst\b/i,
  /\bbusiness\s+systems?\s+analyst\b/i,
  /\bbusiness\s+intelligence\b/i,
  /\bbi\s+analyst\b/i,
  /\bdata\s+governance\s+analyst\b/i,
  /\bdata\s+quality\s+analyst\b/i,
];

// Roles to hard-exclude (applied to both tracks)
export const EXCLUDE_TITLE_PATTERNS: readonly RegExp[] = [
  /\bquant\b/i,
  /\bquantitative\b/i,
  /\btrading\b/i,
  /\bprop(\s|-)?trading\b/i,
  /\bhigh(\s|-)?frequency\b/i,
];

// Extra exclusions for "new grad / full-time" output only.
// (We intentionally do NOT apply these exclusions to internships.)
export const EXCLUDE_NEW_GRAD_ONLY_PATTERNS: readonly RegExp[] = [
  /\bintern\b/i,
  /\binternship\b/i,
  /\bco[-\s]?op\b/i,
  /\bstage\b/i, // FR "stage" = internship
  /\bplacement\b/i,
  /\bpracticum\b/i,

  /\bsenior\b/i,
  /\bsr\.?\b/i,
  /\bprincipal\b/i,
  /\bstaff\b/i,
  /\blead\b/i,
  /\bmanager\b/i,
  /\bdirector\b/i,
  /\bhead\b/i,
  /\bvp\b/i,
  /\bvice\s+president\b/i,
  /\bii\b/i, // e.g. Analyst II (often not entry level)
  /\biii\b/i,
  /\biv\b/i,
];

// Keywords that strongly indicate an internship (used for sanity-checking / rescue categorization)
export const INTERN_TITLE_PATTERNS: readonly RegExp[] = [
  /\bintern\b/i,
  /\binternship\b/i,
  /\bco[-\s]?op\b/i,
  /\bstage\b/i,
  /\bplacement\b/i,
  /\bpracticum\b/i,
];

// A lightweight location heuristic to split USA vs International.
// This is NOT perfect — upstream sources often have inconsistent location strings.
export const USA_LOCATION_PATTERNS: readonly RegExp[] = [
  /\bUnited States\b/i,
  /\bUSA\b/i,
  /\bUS\b/i,
  /\bRemote in USA\b/i,
  // US state abbreviations as ", CA", ", NY", etc.
  /,\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/,
  /\bWashington, DC\b/i,
];
