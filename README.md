# 2026 USA Business Analyst & Data Analyst Jobs (Full-Time + Internships)

This repository is an **auto-updating** list of BA/DA roles in the **United States only** (full-time + internships).

## Data Sources (expanded)

We aggregate from multiple sources to avoid single-site coverage gaps:
- Jobright BA/DA trackers (curated lists; often last ~7 days)
- SimplifyJobs community lists (broad; filtered for BA/DA)
- Official ATS job boards (Greenhouse / Lever / Ashby) discovered from public seed lists
- SpeedyApply lists (supplemental; filtered for BA/DA)

Last updated: **2026-02-20 07:01 (UTC)**

## Quick Links

### Full-Time (New Grad / Entry Level)
- [NEW_GRAD_USA.md](/NEW_GRAD_USA.md) — **355** roles

### Internships
- [INTERN_USA.md](/INTERN_USA.md) — **148** roles

## Update Schedule

- GitHub Actions runs on a **6-hour schedule (UTC)** (best effort; GitHub may delay scheduled runs).
- Forks do not run scheduled workflows by default — enable Actions in your repo settings.

## Notes / Limitations

- We do NOT scrape LinkedIn/Indeed (ToS + reliability). We rely on GitHub lists and ATS public APIs.
- Sponsorship is **best-effort** (heuristics). Always confirm on the official posting.
- Location strings are messy; we drop explicit non-US, but still sanity-check.

## Power-user options (workflow env vars)

- `ENABLE_ATS=false` : disable ATS expansion (faster runs, fewer sources)
- `ATS_MAX_BOARDS_PER_KIND=200` : increase coverage (may risk timeouts)
- `REQUIRE_SPONSORSHIP=true` : keep only rows with `Yes` or `Likely` sponsorship
- `STRICT_JOBRIGHT_TITLE_FILTER=true` : also apply title regex filtering to Jobright (reduces counts)
