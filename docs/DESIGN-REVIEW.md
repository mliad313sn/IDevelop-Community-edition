# UX & design committee — review round 1

Four reviewers assessed IDevelop Community Edition 1.0 on 32 screenshots of the
running product (light, dark, 390 px and 320 px widths, French) populated with the
fictional demo organisation, plus the theme, layout and locale sources.

| Lens                                   | Findings | Addressed in round 1 |
| -------------------------------------- | -------- | -------------------- |
| Visual design                          | 12       | 9                    |
| Accessibility (WCAG 2.2 AA)            | 10       | 10                   |
| UX flows & onboarding                  | 12       | 7                    |
| Content, internationalisation & mobile | 12       | 9                    |

## Done in round 1

**Accessibility**

- Input borders raised to ≥ 3.3:1 in every mode (1.4.11); focus ring follows the
  colour theme.
- Appearance menu rebuilt as a disclosure with two native radio groups (mode,
  colour theme). It closes on Escape, on an outside click and when focus leaves.
  It fits a 320 px screen.
- New **Match device** mode, which follows the operating system and is the
  default, with `color-scheme` so native controls follow dark mode.
- Avatar and help-button text holds ≥ 4.98:1 on both gradient stops in every
  theme.
- Current sidebar page marked with `aria-current="page"` and a ring, not by colour
  alone.
- Scroll padding so fixed elements never hide the focused control.
- `horizonThemes` test extended: input borders, gradient ink, brand on canvas.

**Visual design**

- Brand typeface self-hosted (`public/vendor/fonts/`, SIL OFL), so it renders
  offline and on air-gapped installs.
- Last legacy traces removed: gold gradient stops, accent rails on table hover,
  cards, toasts and KPI cards, uppercase labels. The report builder no longer
  uses the grid texture, monospace logo or square inputs.
- Readable selects in Dusk; left-aligned select text.
- Shared empty-state component (icon, title, guidance, one action), first used
  on Campaigns. Campaigns header aligned with every other page.

**Content & internationalisation**

- `?lng=` now wins over the stored language cookie and is remembered.
- No French labels in the English UI (health gauge).
- Friendlier copy in both languages, for example "Sign out", "Live data" and
  "A few steps left and you're ready to go".
- Other copy fixes:
    - "Getting started" used consistently for the setup page.
    - Phone and level-scale placeholders corrected.
    - Starter role renamed to "Health & Safety Officer".

**Onboarding & mobile**

- The setup page offers the starter framework and the demo organisation when
  the instance is empty, and the README documents both.
- The campaign step on the setup page now states when it is required.
- Employee form: single asterisk; fields turn red only after interaction.
- Mobile: top-bar title truncates or hides and header actions wrap. The
  proficiency legend and help button no longer cover content.

## Done in round 2

- **Getting started, everywhere it matters.** SuperAdmins see a "Getting
  started" link with a progress pill (for example 5/6) at the top of the
  sidebar until the required steps are done. The dashboard banner states
  "5 of 6 steps done · Next: …", shows a progress bar and links straight to the
  next step.
- **Row actions.** Roles use compact icon buttons with accessible names and a
  sticky actions column; the Description column disappears when no role has
  one.
- **Card tables below 768 px.** `.table-cards` turns rows into labelled cards
  (roles, employees, skills, gap report). `main.js` fills each cell's label from
  its column header, so any table can opt in with one class.
- **One filter-bar pattern.** `.filter-bar` (and the historical page-local
  names) share one surface, wrap instead of overflowing and stack to full width
  on a phone.
- **Readiness explained.** Legends on the dashboard and the gap report: "Ready =
  every required skill met", and unrated skills never count as zero. The gap
  report gains a Role column.
- **Words and numbers.** UK English throughout the English catalogue; pillar →
  sub-domain → skill and "Skills framework" in navigation; percentages follow
  the page language (78,2 % in French).
- **Leftovers.** Inline uppercase labels removed; org-chart avatars use the
  Horizon gradient; PWA manifest localised (French and English).

## Still open

| Item                                                                 | Source | Size  |
| -------------------------------------------------------------------- | ------ | ----- |
| Move Dashboard to the top of the sidebar; collapse advanced sections | UX     | 1 day |
| Overflow ("more") menu for tables with more than four row actions    | Visual | 3 h   |
| Card layout for the self-assessment grid below 768 px                | Mobile | 3 h   |

## Kept, by consensus

- The token system with four measured colour themes and the Appearance menu.
- The airy sidebar with pill navigation, gradient page banners and soft
  surfaces.
- The checklist that reads real data, the secure first run, and the product's
  strict "not measured ≠ zero" honesty.
