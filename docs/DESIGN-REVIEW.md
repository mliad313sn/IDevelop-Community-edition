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

## Roadmap (next rounds)

| Item                                                                                                                    | Source     | Size  |
| ----------------------------------------------------------------------------------------------------------------------- | ---------- | ----- |
| Restructure the sidebar: Dashboard first, "Getting started" with a progress pill, collapse advanced sections by default | UX         | 1 day |
| Dashboard setup banner states progress and links to the next step                                                       | UX         | 2 h   |
| Row actions as an overflow menu; hide empty columns; sticky actions column                                              | Visual, UX | 3 h   |
| Card layout for tables below 768 px; filters in a collapsible panel                                                     | Content    | 3 h   |
| One filter-bar pattern across pages                                                                                     | Visual     | 3 h   |
| Readiness legend ("Ready = every required skill met"); role column in the gap report                                    | UX         | 2 h   |
| Standardise terms: pillar → sub-domain → skill; "Skills framework" in navigation                                        | UX         | 1 h   |
| Locale-aware number formatting (78,2 % in French)                                                                       | Content    | 2 h   |
| Choose one English spelling (UK) across all English strings                                                             | Content    | 1 h   |
| Remaining uppercase labels in inline view styles; org-chart avatar colours from the Horizon palette                     | Visual     | 2 h   |
| Localised PWA manifest                                                                                                  | Content    | 1 h   |

## Kept, by consensus

- The token system with four measured colour themes and the Appearance menu.
- The airy sidebar with pill navigation, gradient page banners and soft
  surfaces.
- The checklist that reads real data, the secure first run, and the product's
  strict "not measured ≠ zero" honesty.
