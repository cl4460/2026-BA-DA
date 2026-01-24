// Central configuration for the job list generator.
//
// This fork is intentionally **USA-only** and focused on:
// - Business Analyst (BA)
// - Data Analyst / Data Analysis (DA)
//
// IMPORTANT:
// - Upstream sources have inconsistent formatting.
// - If you over-filter titles or over-strictly classify locations, your list will look "too small".

export type TrackId = "new_grad" | "intern";

export const TRACKS = [
  {
    id: "new_grad",
    label: "Full-Time (New Grad)",
    output: "NEW_GRAD_USA.md",
  },
  {
    id: "intern",
    label: "Internships",
    output: "INTERN_USA.md",
  },
] as const satisfies ReadonlyArray<{ id: TrackId; label: string; output: string }>;

export type SourceKind = "speedyapply" | "jobright";

export type Source = {
  id: string;
  name: string;
  kind: SourceKind;
  sourceUrl: string;

  // speedyapply: fetch markdown tables from upstream USA files
  rawBaseUrl?: string;
  upstreamPathByTrack?: Partial<Record<TrackId, string>>;

  // jobright: fetch README.md from upstream repo
  readmeRawUrl?: string;
  track?: TrackId;
};

export const SOURCES: readonly Source[] = [
  // SpeedyApply sources (already split by USA/INTL upstream). Good as supplemental coverage.
  {
    id: "speedy_ai",
    name: "SpeedyApply AI",
    kind: "speedyapply",
    sourceUrl: "https://github.com/speedyapply/2026-AI-College-Jobs",
    rawBaseUrl: "https://raw.githubusercontent.com/speedyapply/2026-AI-College-Jobs/main",
    upstreamPathByTrack: {
      new_grad: "NEW_GRAD_USA.md",
      intern: "INTERN_USA.md",
    },
  },
  {
    id: "speedy_swe",
    name: "SpeedyApply SWE",
    kind: "speedyapply",
    sourceUrl: "https://github.com/speedyapply/2026-SWE-College-Jobs",
    rawBaseUrl: "https://raw.githubusercontent.com/speedyapply/2026-SWE-College-Jobs/main",
    upstreamPathByTrack: {
      new_grad: "NEW_GRAD_USA.md",
      intern: "INTERN_USA.md",
    },
  },

  // Jobright BA/DA repos (high recall). NOTE: their README is only last ~7 days, but updated daily.
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

// ===== Role filters =====
//
// We ONLY apply title filters to NON-Jobright sources.
// Reason: Jobright repos are already "role-curated"; filtering again is what causes the huge drop in counts.
//
// For SpeedyApply (and other future sources) we still need some filtering, otherwise you'd pull in random SWE roles.

export const INCLUDE_TITLE_PATTERNS: readonly RegExp[] = [
  // core
  /\bbusiness\s+(systems?\s+)?analyst\b/i,
  /\bdata\s+analyst\b/i,

  // common BA variants
  /\bbusiness\s+process\s+analyst\b/i,
  /\bbusiness\s+operations?\s+analyst\b/i,
  /\bbusiness\s+strategy\s+analyst\b/i,
  /\bbusiness\s+insights?\s+analyst\b/i,
  /\bbusiness\s+intelligence\b/i,
  /\bbi\s+analyst\b/i,

  // DA / analytics variants
  /\bdata\s+analytics\s+analyst\b/i,
  /\banalytics\s+analyst\b/i,
  /\binsights?\s+analyst\b/i,
  /\breporting\s+analyst\b/i,
  /\bperformance\s+analyst\b/i,
  /\bdata\s+quality\s+analyst\b/i,
  /\bdata\s+governance\s+analyst\b/i,
];

// Hard excludes (applied to ALL sources)
export const EXCLUDE_TITLE_PATTERNS: readonly RegExp[] = [
  // user explicitly doesn't want quant buckets showing up
  /\bquant\b/i,
  /\bquantitative\b/i,
  /\btrading\b/i,
  /\bprop(\s|-)?trading\b/i,
  /\bhigh(\s|-)?frequency\b/i,

  // keep the scope BA/DA ("Data Analysis" repos can include many data scientist roles)
  /\bdata\s+scientist\b/i,
  /\bdata\s+science\b/i,
  /\bmachine\s+learning\b/i,
  /\bdeep\s+learning\b/i,
  /\bcomputer\s+vision\b/i,
  /\bnlp\b/i,
  /\bllm\b/i,
  /\bgen\s?ai\b/i,
  /\bartificial\s+intelligence\b/i,
  /\bpost[-\s]?doc\b/i,
  /\bpostdoctoral\b/i,
  /\bdoctoral\b/i,
  /\bph\.?d\b/i,
];

// For full-time new grad list only (intern list can have "Sr" internship labels, MBA internships, etc.)
export const EXCLUDE_NEW_GRAD_ONLY_PATTERNS: readonly RegExp[] = [
  /\bintern\b/i,
  /\binternship\b/i,
  /\bco[-\s]?op\b/i,
  /\bstage\b/i,
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

  // usually non-entry-level ladder markers
  /\bii\b/i,
  /\biii\b/i,
  /\biv\b/i,
];

export const INTERN_TITLE_PATTERNS: readonly RegExp[] = [
  /\bintern\b/i,
  /\binternship\b/i,
  /\bco[-\s]?op\b/i,
  /\bstage\b/i,
  /\bplacement\b/i,
  /\bpracticum\b/i,
];

// ===== USA-only location filtering =====
//
// IMPORTANT: location strings are messy.
// - If we only do positive "USA regex", we will drop lots of US rows like "Boston" / "DFW" / zip codes.
// - So we do **negative filtering**: drop ONLY locations that are explicitly non-US.
//
// This increases recall and is closer to the user's requirement ("don't miss stuff").

export const EXPLICIT_NON_US_LOCATION_PATTERNS: readonly RegExp[] = [
  /\bCanada\b/i,
  /\bUnited Kingdom\b/i,
  /\bUK\b/i,
  /\bGermany\b/i,
  /\bFrance\b/i,
  /\bSpain\b/i,
  /\bItaly\b/i,
  /\bIreland\b/i,
  /\bNetherlands\b/i,
  /\bSweden\b/i,
  /\bNorway\b/i,
  /\bDenmark\b/i,
  /\bFinland\b/i,
  /\bSwitzerland\b/i,
  /\bAustria\b/i,
  /\bPoland\b/i,
  /\bCzech\b/i,
  /\bPortugal\b/i,
  /\bBelgium\b/i,

  /\bIndia\b/i,
  /\bChina\b/i,
  /\bHong Kong\b/i,
  /\bSingapore\b/i,
  /\bJapan\b/i,
  /\bKorea\b/i,
  /\bTaiwan\b/i,

  /\bAustralia\b/i,
  /\bNew Zealand\b/i,

  // Canadian provinces (often appear without the word "Canada")
  /\bOntario\b/i,
  /\bBritish Columbia\b/i,
  /\bAlberta\b/i,
  /\bQuebec\b/i,
  /\bNova Scotia\b/i,
  /\bManitoba\b/i,
  /\bSaskatchewan\b/i,
  /\bNew Brunswick\b/i,
  /\bNewfoundland\b/i,
  /\bPrince Edward Island\b/i,
];
