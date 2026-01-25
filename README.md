# 2026 USA Business Analyst & Data Analyst Jobs (Full-Time + Internships)

This repository is an **auto-updating** list of BA/DA roles in the **United States only** (full-time new grad / entry level + internships).

## Quick Links

- Full-time (New Grad / Entry Level): [NEW_GRAD_USA.md](/NEW_GRAD_USA.md)
- Internships: [INTERN_USA.md](/INTERN_USA.md)

## Data Sources (expanded)

We aggregate from multiple sources to reduce single-site coverage gaps:

- **Jobright** BA/DA trackers (curated lists)
- **SimplifyJobs** community lists (broad; filtered for BA/DA)
- **Official ATS** public job board APIs (Greenhouse / Lever / Ashby) discovered from public seed lists
- **SpeedyApply** lists (supplemental; filtered for BA/DA)

## Update Schedule

- GitHub Actions runs on a **6-hour schedule (UTC)** (best effort; GitHub may delay scheduled runs).
- Scheduled workflows are often disabled by default on forks. If this is a fork, enable Actions in your repo settings.

## Notes / Limitations

- We do **NOT** scrape LinkedIn/Indeed (ToS + reliability). We rely on GitHub lists and ATS public APIs.
- Sponsorship is **best-effort** (heuristics). Always confirm on the official posting.
- Location strings are messy; we drop explicit non-US, but still sanity-check.

## Power-user options (workflow env vars)

You can set these in your GitHub Actions workflow (or repo variables):

- `ENABLE_ATS=false` : disable ATS expansion (faster runs, fewer sources)
- `ATS_MAX_BOARDS_PER_KIND=200` : increase coverage (may risk timeouts)
- `REQUIRE_SPONSORSHIP=true` : keep only rows with `Yes` or `Likely` sponsorship
- `STRICT_JOBRIGHT_TITLE_FILTER=true` : also apply title regex filtering to Jobright (reduces counts)
