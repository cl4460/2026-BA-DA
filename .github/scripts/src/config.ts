// Central configuration for the job list generator.
//
// Goal (per user requirements):
// - BA / DA only
// - USA only
// - Expand beyond a single upstream (Jobright) by adding:
//   - Additional GitHub curated lists
//   - Direct official ATS feeds (Greenhouse / Lever / Ashby) discovered from seed lists
//
// IMPORTANT REALITY CHECK:
// - You cannot legally/robustly scrape LinkedIn/Indeed at scale from GitHub Actions.
// - The safest “broad + official” approach is to pull from ATS public APIs.

export type TrackId = "new_grad" | "intern";

export const TRACKS = [
  {
    id: "new_grad",
    label: "Full-Time (New Grad / Entry Level)",
    output: "NEW_GRAD_USA.md",
  },
  {
    id: "intern",
    label: "Internships",
    output: "INTERN_USA.md",
  },
] as const satisfies ReadonlyArray<{ id: TrackId; label: string; output: string }>;

// NOTE: ATS kinds are not in SOURCES (they are discovered dynamically),
// but we keep them in the type for uniform handling.
export type SourceKind =
  | "speedyapply"
  | "jobright"
  | "github_table"
  | "ats_greenhouse"
  | "ats_lever"
  | "ats_ashby";

export type Source = {
  id: string;
  name: string;
  kind: SourceKind;
  sourceUrl: string;

  // speedyapply: fetch markdown tables from upstream USA files
  rawBaseUrl?: string;
  upstreamPathByTrack?: Partial<Record<TrackId, string>>;

  // jobright / github_table: fetch README.md (or a markdown file)
  readmeRawUrl?: string;
  track?: TrackId;

  // short label shown in the output table
  shortLabel: string;
};

export const SOURCES: readonly Source[] = [
  // ---- Supplemental: SpeedyApply lists (not BA/DA curated) ----
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
    shortLabel: "SA-AI",
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
    shortLabel: "SA-SWE",
  },

  // ---- High recall: Jobright BA/DA (last ~7 days) ----
  {
    id: "jr_da_ng",
    name: "Jobright Data Analysis (New Grad)",
    kind: "jobright",
    track: "new_grad",
    sourceUrl: "https://github.com/jobright-ai/2026-Data-Analysis-New-Grad",
    readmeRawUrl: "https://raw.githubusercontent.com/jobright-ai/2026-Data-Analysis-New-Grad/master/README.md",
    shortLabel: "JR-DA",
  },
  {
    id: "jr_ba_ng",
    name: "Jobright Business Analyst (New Grad)",
    kind: "jobright",
    track: "new_grad",
    sourceUrl: "https://github.com/jobright-ai/2026-Business-Analyst-New-Grad",
    readmeRawUrl: "https://raw.githubusercontent.com/jobright-ai/2026-Business-Analyst-New-Grad/master/README.md",
    shortLabel: "JR-BA",
  },
  {
    id: "jr_da_intern",
    name: "Jobright Data Analysis (Internship)",
    kind: "jobright",
    track: "intern",
    sourceUrl: "https://github.com/jobright-ai/2026-Data-Analysis-Internship",
    readmeRawUrl: "https://raw.githubusercontent.com/jobright-ai/2026-Data-Analysis-Internship/master/README.md",
    shortLabel: "JR-DA",
  },
  {
    id: "jr_ba_intern",
    name: "Jobright Business Analyst (Internship)",
    kind: "jobright",
    track: "intern",
    sourceUrl: "https://github.com/jobright-ai/2026-Business-Analyst-Internship",
    readmeRawUrl: "https://raw.githubusercontent.com/jobright-ai/2026-Business-Analyst-Internship/master/README.md",
    shortLabel: "JR-BA",
  },

  // ---- Additional GitHub lists (NOT Jobright) ----
  // These are broad lists; we filter aggressively for BA/DA titles.
  {
    id: "simp_ng",
    name: "Simplify New Grad Positions (broad)",
    kind: "github_table",
    track: "new_grad",
    sourceUrl: "https://github.com/SimplifyJobs/New-Grad-Positions",
    // IMPORTANT: SimplifyJobs repos often use the `dev` branch (NOT `main`).
    readmeRawUrl: "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README.md",
    shortLabel: "SIM",
  },
  {
    id: "simp_intern",
    name: "Simplify Summer 2026 Internships (broad)",
    kind: "github_table",
    track: "intern",
    sourceUrl: "https://github.com/SimplifyJobs/Summer2026-Internships",
    // IMPORTANT: SimplifyJobs repos often use the `dev` branch (NOT `main`).
    readmeRawUrl: "https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/README.md",
    shortLabel: "SIM",
  },

  // Vansh/Ouckah community lists (very broad; filtered for BA/DA)
  {
    id: "vansh_ng",
    name: "Vansh New Grad 2026 (broad)",
    kind: "github_table",
    track: "new_grad",
    sourceUrl: "https://github.com/vanshb03/New-Grad-2026",
    // Vansh repos typically use the `dev` branch.
    readmeRawUrl: "https://raw.githubusercontent.com/vanshb03/New-Grad-2026/dev/README.md",
    shortLabel: "VAN",
  },
  {
    id: "vansh_intern",
    name: "Vansh Summer 2026 Internships (broad)",
    kind: "github_table",
    track: "intern",
    sourceUrl: "https://github.com/vanshb03/Summer2026-Internships",
    // Vansh repos typically use the `dev` branch.
    readmeRawUrl: "https://raw.githubusercontent.com/vanshb03/Summer2026-Internships/dev/README.md",
    shortLabel: "VAN",
  },
] as const;

// ===== ATS Seed Sources =====
// We use these to discover company job boards for official postings.
// The script only extracts Greenhouse/Lever/Ashby links from the markdown text.

export type AtsSeedSource = {
  id: string;
  name: string;
  rawUrls: string[]; // fallback list; first successful fetch wins
  shortLabel: string;
};

export const ATS_SEED_SOURCES: readonly AtsSeedSource[] = [
  // These seed sources are extremely high-signal for “companies currently hiring”
  // because they are community-maintained (and contain lots of ATS links).
  {
    id: "seed_simplify_ng",
    name: "Seed: Simplify New Grad Positions",
    rawUrls: ["https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README.md"],
    shortLabel: "SEED-SIM-NG",
  },
  {
    id: "seed_simplify_intern",
    name: "Seed: Simplify Summer 2026 Internships",
    rawUrls: ["https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/README.md"],
    shortLabel: "SEED-SIM-IN",
  },
  {
    id: "seed_vansh_ng",
    name: "Seed: Vansh New Grad 2026",
    rawUrls: ["https://raw.githubusercontent.com/vanshb03/New-Grad-2026/dev/README.md"],
    shortLabel: "SEED-VAN-NG",
  },
  {
    id: "seed_vansh_intern",
    name: "Seed: Vansh Summer 2026 Internships",
    rawUrls: ["https://raw.githubusercontent.com/vanshb03/Summer2026-Internships/dev/README.md"],
    shortLabel: "SEED-VAN-IN",
  },

  {
    id: "remote_jobs_resources",
    name: "Remote Jobs Resources (company list)",
    // Branch can be main or master depending on repo state.
    rawUrls: [
      "https://raw.githubusercontent.com/ineelhere/remote-jobs-resources/main/README.md",
      "https://raw.githubusercontent.com/ineelhere/remote-jobs-resources/master/README.md",
    ],
    shortLabel: "SEED-RJR",
  },
  {
    id: "remote_jobs",
    name: "Remote Jobs (job list; used only for ATS link discovery)",
    // Branch can be main or master depending on repo state.
    rawUrls: [
      "https://raw.githubusercontent.com/maurobonfietti/remote-jobs/main/README.md",
      "https://raw.githubusercontent.com/maurobonfietti/remote-jobs/master/README.md",
    ],
    shortLabel: "SEED-RJ",
  },
];

// ===== Role filters =====
//
// IMPORTANT:
// - Jobright repos are already role-curated; applying strict INCLUDE filters can drop tons of valid rows.
// - For other sources, INCLUDE filters are necessary or you'll get SWE/PM noise.

export const INCLUDE_TITLE_PATTERNS: readonly RegExp[] = [
  // core
  /\bdata\s+analyst\b/i,
  /\bbusiness\s+(systems?\s+)?analyst\b/i,

  // closely related analytics titles
  /\bbusiness\s+intelligence\b/i,
  /\bbusiness\s+intelligence\s+analyst\b/i,
  /\bbi\s+analyst\b/i,
  /\banalytics\s+analyst\b/i,
  /\bdata\s+analytics\b/i,
  /\binsights?\s+analyst\b/i,
  /\bclient\s+insights?\s+analyst\b/i,
  /\bcustomer\s+insights?\s+analyst\b/i,
  /\breporting\s+analyst\b/i,
  /\bdata\s+governance\s+analyst\b/i,
  /\bdata\s+quality\s+analyst\b/i,

  // “analyst” variants that are often effectively BA/DA
  /\bproduct\s+analyst\b/i,
  /\bmarketing\s+analyst\b/i,
  /\boperations?\s+analyst\b/i,
  /\bstrategy\s+analyst\b/i,
  /\brevenue\s+analyst\b/i,
  /\bpricing\s+analyst\b/i,
  /\bresearch\s+analyst\b/i,
  /\bprogram\s+analyst\b/i,
];

// Hard excludes (applied to ALL sources)
export const EXCLUDE_TITLE_PATTERNS: readonly RegExp[] = [
  // explicitly not wanted
  /\bquant\b/i,
  /\bquantitative\b/i,
  /\btrading\b/i,
  /\bprop(\s|-)?trading\b/i,
  /\bhigh(\s|-)?frequency\b/i,

  // keep the scope BA/DA (Jobright DA lists can include DS/ML)
  /\bdata\s+scientist\b/i,
  /\bdata\s+science\b/i,
  /\bmachine\s+learning\b/i,
  /\bdeep\s+learning\b/i,
  /\bcomputer\s+vision\b/i,
  /\bnlp\b/i,
  /\bllm\b/i,
  /\bgen\s?ai\b/i,
  /\bartificial\s+intelligence\b/i,
  /\bml\s+engineer\b/i,

  // keep out pure engineering roles
  /\bdata\s+engineer\b/i,
  /\banalytics\s+engineer\b/i,
  /\bsoftware\s+engineer\b/i,

  // academic research roles
  /\bpost[-\s]?doc\b/i,
  /\bpostdoctoral\b/i,
  /\bdoctoral\b/i,
  /\bph\.?d\b/i,
];

// Additional excludes for FULL-TIME list only.
// NOTE: Do NOT exclude roman numerals (II/III) — Jobright and many employers use those for normal analyst ladders.
export const EXCLUDE_NEW_GRAD_ONLY_PATTERNS: readonly RegExp[] = [
  // internship / co-op keywords
  /\bintern\b/i,
  /\binternship\b/i,
  /\bco[-\s]?op\b/i,
  /\bstage\b/i,
  /\bplacement\b/i,
  /\bpracticum\b/i,

  // seniority keywords (these are usually not entry level)
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
// We do negative filtering: drop only explicit non-US.

export const EXPLICIT_NON_US_LOCATION_PATTERNS: readonly RegExp[] = [
  /\bCanada\b/i,
  /\bUnited\s+Kingdom\b/i,
  /(?<!New\s)England\b/i,
  /\bScotland\b/i,
  /\bWales\b/i,
  /\bNorthern\s+Ireland\b/i,

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
  /\bHong\s+Kong\b/i,
  /\bSingapore\b/i,
  /\bJapan\b/i,
  /\bKorea\b/i,
  /\bTaiwan\b/i,

  /\bAustralia\b/i,
  /\bNew\s+Zealand\b/i,

  // Canadian provinces (often appear without the word "Canada")
  /\bOntario\b/i,
  /\bBritish\s+Columbia\b/i,
  /\bAlberta\b/i,
  /\bQuebec\b/i,
  /\bNova\s+Scotia\b/i,
  /\bManitoba\b/i,
  /\bSaskatchewan\b/i,
  /\bNew\s+Brunswick\b/i,
  /\bNewfoundland\b/i,
  /\bPrince\s+Edward\s+Island\b/i,
];