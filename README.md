# 2026 Business Analyst & Data Analyst Full-Time (New Grad) Positions

This repository maintains an **auto-updating** list of Business Analyst / Data Analyst full-time roles (focused on new-grad/early-career postings).

## How it updates

Every day, a GitHub Action:
1. Fetches the latest markdown job tables from the public upstream repos:
   - `speedyapply/2026-SWE-College-Jobs`
   - `speedyapply/2026-AI-College-Jobs`
2. Filters roles by title keywords (see `.github/scripts/src/config.ts`).
3. Rewrites the tables in this repository.

## Quick links

- USA: [NEW_GRAD_USA.md](/NEW_GRAD_USA.md)
- International: [NEW_GRAD_INTL.md](/NEW_GRAD_INTL.md)

## Important limitations

- This list is only as comprehensive as the upstream sources; it will **miss** companies that aren't included there.
- Title filtering can produce false positives/negatives. Expect to tune `INCLUDE_TITLE_PATTERNS` / `EXCLUDE_TITLE_PATTERNS`.
- GitHub disables scheduled workflows by default in forks. You must enable Actions in your fork for daily updates.
