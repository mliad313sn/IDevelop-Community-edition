# IDevelop Community Edition — graphic chart

**Design language: "Open Horizon".** Calm, indigo-tinted surfaces; one confident
accent (Iris) for action and focus; one warm spark (Coral) used sparingly for
highlights. The identity says _growth, openness, community_ — and it must never
get in the way of reading data.

<p align="center"><img src="../public/brand/social-card.png" alt="IDevelop Community Edition social card" width="640"></p>

## 1. Logo

| Asset                              | File                                                                 | Use                                   |
| ---------------------------------- | -------------------------------------------------------------------- | ------------------------------------- |
| Mark (app icon)                    | `public/brand/idevelop-mark.svg`                                     | Sidebar, auth pages, About, app icons |
| Horizontal logo, dark backgrounds  | `public/brand/idevelop-logo.svg`                                     | README, docs, splash on dark          |
| Horizontal logo, light backgrounds | `public/brand/idevelop-logo-light.svg`                               | Print, light documents                |
| Favicon                            | `public/brand/favicon.svg`, `favicon-32.png`                         | Browser tabs                          |
| Apple touch icon                   | `public/brand/apple-touch-icon.png` (180 px)                         | iOS home screen                       |
| PWA icons                          | `public/icons/icon-192.png`, `icon-512.png`, `icon-512-maskable.png` | Install prompts, Android              |
| Social card                        | `public/brand/social-card.png` (1280×640)                            | Repository preview, `og:image`        |

**Construction.** A rounded tile (radius = 25 % of the side) filled with the Iris
gradient (`#9A8CFF` → `#5B4BE0`, top-left to bottom-right). A white rounded stem
forms the letter _i_; its dot is the Coral spark (`#FF7A59`). A translucent
ascending curve — the _horizon_ — rises behind the stem: progress along a path.

**Clear space** equals the dot's diameter on every side. **Minimum size**: 16 px
(favicon variant, which drops the horizon curve), 24 px for the full mark.

**Don'ts**: do not recolour the tile outside the Iris family, do not rotate or
stretch, do not place the mark on a busy photo without a solid backing, do not
use the Coral spark as a status colour.

**Wordmark**: "I" in the foreground text colour, "Develop" in Iris; the edition
line "COMMUNITY EDITION" in Coral, uppercase, tracking +2.6.

## 2. Colour

### 2.1 Brand colours

| Token             | Dark theme | Light theme | Role                                      |
| ----------------- | ---------- | ----------- | ----------------------------------------- |
| `--brand`         | `#7C6CFF`  | `#5B4BE0`   | Primary actions, active navigation, focus |
| `--brand-hover`   | `#9084FF`  | `#4C3DCC`   | Hover state                               |
| `--brand-pressed` | `#6656F0`  | `#4334B8`   | Pressed state                             |
| `--brand-text`    | `#9084FF`  | `#4A3BC9`   | Brand colour used as **text**             |
| `--spark`         | `#FF7A59`  | `#C2410C`   | Highlights, illustrations, the logo dot   |
| `--text-inverse`  | `#0A0C18`  | `#FFFFFF`   | Text on a brand fill                      |

Measured contrast (WCAG 2.x): brand-as-text ≥ 4.99:1 on every dark surface and
7.61:1 on white; button ink on brand fills 5.05:1 (dark) and 5.95–8.67:1 (light).

### 2.2 Surfaces and text

| Token                        | Dark       | Light                                             |
| ---------------------------- | ---------- | ------------------------------------------------- |
| `--bg-base` (page)           | `#0A0C18`  | `#F4F5FB`                                         |
| `--bg-panel` (sidebar, bars) | `#0F1222`  | `#FFFFFF`                                         |
| `--bg-card`                  | `#151931`  | `#FFFFFF`                                         |
| `--bg-elevated`              | `#1F2442`  | `#F8F8FD`                                         |
| `--text-primary`             | `#E4E8F0`  | `#161A2E`                                         |
| `--text-secondary`           | 55 % white | `#4A4F68`                                         |
| `--text-muted`               | 50 % white | `#5F647C` (≥ 5.04:1 on the darkest light surface) |

Status colours (`--emerald`, `--amber`, `--red`, `--blue` and their `-text`
variants) keep their meaning in every theme and are never replaced by the brand.

### 2.3 Data-visualisation palette ("Horizon")

Defined once in `src/utils/branding.js` (`CHART_IDENTITY.community`) and emitted
as `--chart-*` custom properties; exported to `docs/contracts/chart-identity.json`.

| Slot | Name  | Hex       | vs dark card `#151931` | vs white |
| ---- | ----- | --------- | ---------------------- | -------- |
| 1    | Iris  | `#7C6CFF` | 4.48:1                 | 3.86:1   |
| 2    | Rose  | `#CA72A7` | 5.33:1                 | 3.24:1   |
| 3    | Coral | `#DF5920` | 4.60:1                 | 3.76:1   |
| 4    | Slate | `#626A84` | 3.22:1                 | 5.37:1   |
| 5    | Ochre | `#8F8314` | 4.46:1                 | 3.87:1   |
| 6    | Sky   | `#187EAA` | 3.79:1                 | 4.56:1   |
| 7    | Lime  | `#728D35` | 4.59:1                 | 3.77:1   |
| 8    | Teal  | `#17A1A1` | 5.47:1                 | 3.16:1   |

| Semantic | Hex       | vs dark | vs white |
| -------- | --------- | ------- | -------- |
| Good     | `#1F7A56` | 3.27:1  | 5.28:1   |
| Warning  | `#866F13` | 3.54:1  | 4.89:1   |
| Danger   | `#E02929` | 3.72:1  | 4.65:1   |
| Neutral  | `#187EAA` | 3.79:1  | 4.56:1   |

Rules, all enforced by `tests/unit/chartIdentity.test.js`:

- every categorical and semantic colour clears **3:1** (WCAG 1.4.11) on both
  chart surfaces;
- adjacent series stay ≥ **20 ΔE** apart and every pair ≥ **12 ΔE** in simulated
  deuteranopia and protanopia (achieved: 52 and 13.5);
- warning vs danger ≥ **20 ΔE** under deuteranopia (achieved: 35.6);
- a marker-shape cycle (circle, diamond, triangle, square, rounded square) gives
  series a second, non-colour channel;
- the heat scale is never red-versus-green alone.

## 3. Typography

System font stacks by default, so the product renders identically offline and on
air-gapped hosts. When external fonts are allowed, **Plus Jakarta Sans** (UI —
open, friendly geometric humanist) and **JetBrains Mono** (numbers, codes,
identifiers) are loaded from Google Fonts; both are licensed under the SIL Open
Font License. Set `DISABLE_EXTERNAL_FONTS=1` to forbid any external request.

| Use (guidance)        | Size / weight                                |
| --------------------- | -------------------------------------------- |
| Page title            | 1.75 rem / 700                               |
| Section title         | 1.25 rem / 700                               |
| Body                  | 0.95–1 rem / 400                             |
| Labels, table headers | 0.72 rem / 700, uppercase, tracking +0.06 em |
| Numbers in KPIs       | tabular figures, 700                         |

## 4. Iconography

Font Awesome Free 6 (self-hosted under `public/vendor/fontawesome/`). No
pictographic emoji in the UI — `npm run lint:icons` fails the build if one
appears in a view.

## 5. Voice

Plain, specific and honest. Say what the number means and what it does _not_
cover ("5 of 5 dimensions not measured", never a fake 0 %). Bilingual parity:
every string exists in French and English.

## 6. Re-branding

| You want to…                                                                           | Change                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Put your organisation's name, logo, favicon, tagline, accent colour on an installation | _Settings → Branding_ (no code; stored in the database)                                                                                                                                 |
| Ship a fork with a different stock identity                                            | `src/config/product.js`, `public/brand/*`, `public/icons/*`, the `:root` tokens in `public/css/style.css`, `CHART_IDENTITY` in `src/utils/branding.js`, then `npm run contracts:export` |

The AGPL covers the code, not the name or the logo — see `NOTICE`.
