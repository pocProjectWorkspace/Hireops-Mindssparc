# HireOps — Design System Specification

**Status:** v1, May 2026
**Audience:** Engineering (Claude Code consumes this when building portal screens), product review (you, when reviewing Claude Code's output), Claude Design (which reads `packages/ui` for design context)
**Companion to:** `competitive-landscape.md` (the bar), `requirements.md` §3 (personas), `partner-wireflows.md` (a primary consumer of the partner portal vocabulary)
**Implementation home:** `packages/ui` — tokens as CSS variables, components as React, Storybook scaffolded for documentation

This spec is prescriptive. Where it's prescriptive, follow it. Where it isn't (motion, illustration, photography), use judgement informed by §1's principles. When unsure, ask before improvising — the cost of one ambiguous answer is much lower than the cost of inconsistent screens shipped across four frontends.

---

## 1. Philosophy

### 1.1 The bar

HireOps's design system has to clear four bars simultaneously: **Ashby's visual quality, Workday's integration depth, Greenhouse's structured rigour, with Indian GCC fluency.** No single product on the market clears all four — that gap is why HireOps can exist.

The visual quality bar is the highest constraint. Recruiters at Kyndryl will compare HireOps against Ashby the moment they log in. Failing that comparison is fatal even if the platform's depth is greater. So the design system is built explicitly to pass the Ashby test: clean, modern, dense without clutter, fast, embedded AI rather than bolted-on.

### 1.2 Principles

These are the principles every design decision is measured against. When two principles conflict, the higher-numbered one wins.

1. **Density without clutter.** Show dense data on every screen recruiters and partners use. The trick is restraint: generous whitespace, hierarchical typography, restrained colour, room to breathe. The Lovable codebase's instinct toward maximalism (every page has KPI tiles, tables, tabs, and charts) is wrong. Learn to leave things off the screen.
2. **Speed visible to users.** Page loads under 2s P95 on 4G; interactions under 200ms P95. Slowness on enterprise tools is the single most complained-about product attribute in market reviews of iCIMS and Workday. Design patterns that produce slow pages (heavy modal stacks, infinite-scroll-with-images, blocking AI calls in the foreground) are anti-patterns by default.
3. **AI surfaces look like the product.** Most criticised AI integrations (Zoho, pre-Paradox Workday) feel bolted on — different visual language, different interaction patterns, separate "AI tab." HireOps's AI components use the same tokens, same primitives, same affordances as the rest of the product. AI patterns get their own catalogue (§5) precisely because that consistency is design work, not just placement.
4. **Trustworthiness signalled, not asserted.** Every AI score, every fairness flag, every automated decision shows its reasoning on demand — top contributing factors, confidence interval where relevant, override path always visible. Following Ashby's pattern of criterion-by-criterion explainability for AI-Assisted Application Review.
5. **Multi-persona coherence.** 13 tenant-facing personas across four frontends. Same shell, different navigation. Tokens, primitives, and patterns shared. A Kyndryl admin who logs in as themselves and views the partner portal to debug an issue shouldn't feel like they've switched products.
6. **Accessibility automatic, not bolted on.** WCAG 2.1 AA is the floor for enterprise sales. Tokens make it automatic — no token combination produces a contrast ratio below 4.5:1 for body text. Focus indicators always visible. Keyboard nav across every flow.
7. **India-acceptable defaults.** ₹ for currency, IST for timezone, dd-mm-yyyy for dates, Indian phone formats, visual layouts that don't break on longer Hindi text. These are platform defaults, tenant-overridable.
8. **Mobile-first for the mobile-primary personas.** Hiring managers, panellists, and candidates use mobile primarily. Their flows are designed mobile-first, not mobile-responsive. Recruiters and admins are desktop-first; mobile-responsive is acceptable for them.

### 1.3 Anti-patterns to avoid

Specific patterns from competing products that we deliberately do not adopt:

- **Workday's training-heavy UX.** Multiple market reviewers describe Workday as "powerful but clunky," "needs significant training." We cannot afford this at GCC volume. Every primary action should be obvious to a first-day user.
- **iCIMS's "powerful but cluttered" navigation.** Tab proliferation is a feature trap. Maximum two levels of navigation visible at once.
- **Bolted-on AI features (Zoho's pattern).** AI doesn't get its own tab, its own colour, its own modal pattern. AI components live within product surfaces using product primitives.
- **Greenhouse's bureaucratic rigidity.** Match the rigour of structured scorecards, not the workflow friction. Required structure should feel like assistance, not gating.
- **Per-seat upsell aesthetics (iCIMS pattern).** Every screen gated behind upsells. Wrong model for the platform.
- **Ashby's English-only US-centric defaults.** Our defaults are India-first and i18n-ready from day one.
- **OpenCATS-era visual design.** Self-evident.

### 1.4 Restraint about Ashby

Ashby is the visual benchmark, not the template. Where Ashby has a specific pattern that maps cleanly to our context (kanban virtualisation, criterion-by-criterion explainability, MCP support, embedded analytics), we follow the pattern with attribution. Where Ashby's choices reflect their context not ours (US-centric defaults, premium pricing UX, single-tenant architecture, Google Calendar primary), we explicitly diverge.

The goal is not to look like Ashby. The goal is to clear the bar Ashby set without copying their work.

---

## 2. Tokens

All tokens are defined as CSS custom properties in `packages/ui/src/tokens.css`, with TypeScript constants mirroring them in `packages/ui/src/tokens.ts` for programmatic access. Every component consumes tokens — no hard-coded values anywhere except in the token files themselves.

### 2.1 Colour

**The neutral scale is the foundation.** Most surfaces are neutral. Status and accent colours appear sparingly, where they earn their presence.

```css
/* Neutrals — the workhorse scale */
--color-neutral-50:  #fafafa;  /* page background */
--color-neutral-100: #f5f5f5;  /* card background, subtle separators */
--color-neutral-200: #e5e5e5;  /* borders, dividers */
--color-neutral-300: #d4d4d4;  /* hover borders */
--color-neutral-400: #a3a3a3;  /* placeholder text, disabled */
--color-neutral-500: #737373;  /* secondary text */
--color-neutral-600: #525252;  /* primary text on light */
--color-neutral-700: #404040;  /* headings */
--color-neutral-800: #262626;  /* high-emphasis text */
--color-neutral-900: #171717;  /* maximum-emphasis text, charts */

/* Brand — used sparingly, primary actions only */
--color-brand-50:  #eff6ff;
--color-brand-100: #dbeafe;
--color-brand-500: #3b82f6;  /* primary action */
--color-brand-600: #2563eb;  /* primary hover */
--color-brand-700: #1d4ed8;  /* primary active */

/* Semantic — never decorative */
--color-status-positive-50:  #f0fdf4;
--color-status-positive-500: #22c55e;
--color-status-positive-700: #15803d;

--color-status-warning-50:  #fffbeb;
--color-status-warning-500: #f59e0b;
--color-status-warning-700: #b45309;

--color-status-error-50:  #fef2f2;
--color-status-error-500: #ef4444;
--color-status-error-700: #b91c1c;

--color-status-info-50:  #eff6ff;
--color-status-info-500: #3b82f6;  /* same hue as brand; semantic context distinguishes */

/* Partner portal accent — slightly warmer */
--color-partner-accent-500: #ea580c;  /* used for partner-portal navigation chrome only */
--color-partner-accent-50:  #fff7ed;

/* AI-specific — the AI components use a distinct neutral-but-warmer palette */
--color-ai-surface:    #faf5ff;  /* subtle purple-tinted background for AI suggestions */
--color-ai-border:     #e9d5ff;
--color-ai-accent:     #7c3aed;  /* AI confidence indicator, AI-suggested-input border */
```

**Rules:**
- Status colours are semantic. Green only for success/positive. Red only for errors/destructive. Amber only for warnings or in-flight cautious states. **No green for "primary action."** Most design systems botch this.
- The partner portal uses `--color-partner-accent-*` only for navigation chrome (top bar, sidebar accent). Body content uses the same neutral and brand scales as the internal portal.
- AI components have their own token set (`--color-ai-*`). Used only by components in §5. Don't leak into general UI.
- Per-tenant white-labelling overrides `--color-brand-*` only. Status, neutral, and AI tokens are platform-fixed.

**Contrast ratios (WCAG 2.1 AA enforced at the token level):**
- Body text on `--color-neutral-50`: must use `--color-neutral-700` or darker (ratio ≥ 7.2:1, AAA)
- Secondary text on `--color-neutral-50`: `--color-neutral-500` minimum (ratio 4.6:1, AA)
- Disabled text: `--color-neutral-400` only on `--color-neutral-100` or lighter
- Primary action text: white on `--color-brand-500` or darker (ratio ≥ 4.5:1)

### 2.2 Typography

**One typeface family for the platform.** Inter for UI, JetBrains Mono for code/IDs/data densely-displayed numbers. Both have excellent Devanagari support for Hindi tenant rendering.

```css
--font-family-ui:   'Inter', system-ui, -apple-system, sans-serif;
--font-family-mono: 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace;

/* Type scale — modular, ratio 1.25 */
--font-size-xs:   0.75rem;   /* 12px — labels, fine print */
--font-size-sm:   0.875rem;  /* 14px — secondary body, dense table cells */
--font-size-base: 1rem;      /* 16px — primary body */
--font-size-md:   1.125rem;  /* 18px — emphasised body */
--font-size-lg:   1.25rem;   /* 20px — section heading */
--font-size-xl:   1.5rem;    /* 24px — page heading */
--font-size-2xl:  1.875rem;  /* 30px — display */
--font-size-3xl:  2.25rem;   /* 36px — hero */

--font-weight-regular:  400;
--font-weight-medium:   500;
--font-weight-semibold: 600;
--font-weight-bold:     700;

--line-height-tight:   1.25;
--line-height-normal:  1.5;
--line-height-relaxed: 1.75;
```

**Hindi/Indic script consideration:** Devanagari rendering increases line height by ~10-15% due to vertically-stacked diacritics. Components that may render Hindi (candidate-facing surfaces, partner portal candidate communication) should use `line-height: var(--line-height-relaxed)` rather than `--line-height-normal`, or set explicit `line-height: 1.6em` to avoid clipping. Test with the longest realistic Hindi string (~30-40% longer than English) for any layout containing user-controlled text.

### 2.3 Spacing

4-pixel base, geometric scale. Used for padding, margin, gap. Reduces decision fatigue — components either use the scale or they don't compile.

```css
--space-0:  0;
--space-1:  0.25rem;  /*  4px */
--space-2:  0.5rem;   /*  8px */
--space-3:  0.75rem;  /* 12px */
--space-4:  1rem;     /* 16px */
--space-5:  1.25rem;  /* 20px */
--space-6:  1.5rem;   /* 24px */
--space-8:  2rem;     /* 32px */
--space-10: 2.5rem;   /* 40px */
--space-12: 3rem;     /* 48px */
--space-16: 4rem;     /* 64px */
--space-20: 5rem;     /* 80px */
--space-24: 6rem;     /* 96px */
```

### 2.4 Elevation

Three levels, no more. Shadow-based, not border-based.

```css
--elevation-1: 0 1px 2px 0 rgb(0 0 0 / 0.05);                                        /* card resting */
--elevation-2: 0 4px 6px -1px rgb(0 0 0 / 0.10), 0 2px 4px -2px rgb(0 0 0 / 0.10);   /* hover, subtle popover */
--elevation-3: 0 20px 25px -5px rgb(0 0 0 / 0.10), 0 8px 10px -6px rgb(0 0 0 / 0.10); /* modal, dropdown */
```

**No higher elevation.** Higher shadows look like 2010s bootstrap. If something needs more visual prominence than `--elevation-3`, it's a different content type, not a deeper shadow.

### 2.5 Border radius

```css
--radius-sm: 0.25rem;  /* 4px — small elements like badges */
--radius-md: 0.5rem;   /* 8px — buttons, inputs, cards */
--radius-lg: 0.75rem;  /* 12px — large cards, modals */
--radius-full: 9999px; /* pills, avatars */
```

### 2.6 Density

**One default density level.** Following the principle of restraint: comfortable density is platform default. Recruiter-only screens that genuinely need data density (the candidates list, the pipeline kanban) opt into compact mode at the screen level.

```css
/* Default — comfortable density */
--density-row-height:    44px;   /* table rows, list items */
--density-input-height:  40px;   /* form inputs */
--density-button-height: 40px;
--density-card-padding:  var(--space-6);  /* 24px */

/* Recruiter compact — only for: candidates list, pipeline kanban, panel feedback inbox */
[data-density="compact"] {
  --density-row-height:    36px;
  --density-input-height:  32px;
  --density-button-height: 32px;
  --density-card-padding:  var(--space-4);  /* 16px */
}
```

No "dense" level in v1. The two levels above are sufficient and the cost of a third (testing every screen at every density) is not worth the marginal data density gain.

### 2.7 Z-index

Five tokens; no ad-hoc z-index values anywhere in the codebase.

```css
--z-base:    0;
--z-dropdown: 100;
--z-sticky:   200;  /* sticky table headers, sticky filters */
--z-overlay:  300;  /* modal backdrops */
--z-modal:    400;
--z-toast:    500;
```

### 2.8 Locale and formatting

Platform defaults; tenant-overridable via `tenants.settings`. Formatters live in `packages/ui/src/formatters.ts` — never use raw `Intl` or `toLocaleString` in component code.

```typescript
// Defaults
export const PLATFORM_DEFAULTS = {
  currency: 'INR',
  currencySymbol: '₹',
  timezone: 'Asia/Kolkata',
  dateFormat: 'dd-MM-yyyy',     // 09-05-2026 not 05/09/2026
  numberFormat: 'en-IN',         // 1,00,000 not 100,000 (Indian comma grouping)
  phoneFormat: 'IN',             // +91 98xxx xxxxx
  locale: 'en-IN',
};
```

Currency display always uses the symbol (`₹`), never ISO code (`INR`), unless explicitly disambiguating multi-currency contexts. CTC and salary fields show in lakhs (`₹22 LPA`) for India contexts following local convention; other locales follow their convention via tenant override.

---

## 3. Layout primitives

Three layout primitives compose to produce every screen. Used everywhere; no flexbox or grid is written ad-hoc except inside these primitives.

### 3.1 `<Stack>`

Vertical layout with consistent gap. Replaces `<div>` with margin-bottom proliferation.

```tsx
<Stack gap="4">     {/* gap-4 = 16px between children */}
  <Heading />
  <Body />
  <Actions />
</Stack>
```

Props: `gap` (a spacing token, default `4`), `align` (`start` | `center` | `end` | `stretch`, default `stretch`).

### 3.2 `<Inline>`

Horizontal layout with wrap and consistent gap.

```tsx
<Inline gap="3" wrap>
  <Tag />
  <Tag />
  <Tag />
</Inline>
```

Props: `gap`, `wrap` (boolean), `align` (vertical alignment), `justify` (horizontal distribution).

### 3.3 `<Container>`

Page-level horizontal padding and max-width. Three sizes.

```tsx
<Container size="md">
  {/* page content */}
</Container>
```

Props: `size` — `sm` (max-width 640px, used for forms), `md` (max-width 1024px, default), `lg` (max-width 1280px, dashboards), `full` (no max-width, kanbans).

---

## 4. Foundational primitives

Eight primitives. Every screen is built from these plus Layer 2 components (which emerge during Phase 2).

### 4.1 `<Button>`

The most-used component. Get this right.

**Variants:**
- `primary` — the single most important action on a screen. Use exactly one. Brand colour fill.
- `secondary` — common alternative actions. Neutral fill, subtle border.
- `tertiary` — low-emphasis actions, often inline. No background, brand-coloured text.
- `destructive` — irreversible or dangerous actions. Red fill.

**Sizes:** `sm` (32px height, density-compact only), `md` (40px height, default), `lg` (48px height, mobile primary actions).

**States:** default, hover, focus, active, disabled, loading. Loading state shows a spinner + retains label width to prevent layout shift.

**Props:**
```typescript
type ButtonProps = {
  variant?: 'primary' | 'secondary' | 'tertiary' | 'destructive';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
  type?: 'button' | 'submit' | 'reset';
  onClick?: (e: MouseEvent) => void;
  children: ReactNode;
};
```

**Accessibility:** focus ring uses `outline: 2px solid var(--color-brand-500); outline-offset: 2px`. Focus visible on keyboard navigation, hidden on mouse click (`:focus-visible`).

**Loading state:** `aria-busy="true"` and `aria-disabled="true"`. Spinner replaces icon, never the text.

### 4.2 `<Input>`

Text input. Used for every text-entry field plus number, email, tel, search variants.

**Variants by `type`:** `text` (default), `email`, `tel`, `number`, `password`, `search`.

**States:** default, hover, focus, error, disabled, readonly.

**Props:**
```typescript
type InputProps = {
  type?: HTMLInputType;
  size?: 'sm' | 'md';
  label?: string;            // generates <label> wrapping; required for accessibility
  hint?: string;              // help text below
  error?: string;             // error message below; flips border to status-error
  required?: boolean;         // visually marked with *
  disabled?: boolean;
  readOnly?: boolean;
  prefix?: ReactNode;         // e.g. ₹ for currency
  suffix?: ReactNode;         // e.g. unit indicator
  // ...all standard input props passed through
};
```

**Validation:** error state is set declaratively by parent (form library). Component never validates; it only displays.

**Phone variant:** when `type="tel"` and locale is India, prefixes country code `+91` and applies `XX XXX XXXXX` format mask on display.

### 4.3 `<Select>` / `<Combobox>`

Distinguish:
- `<Select>` — small option set (≤ 10 items), no search needed. Native-like dropdown.
- `<Combobox>` — large option set, searchable, supports async loading.

Same accessibility contract — keyboard navigable, screen-reader announced.

**Combobox specifically:** debounce search at 250ms, virtualise list when > 50 options, show "no results" state with a configurable empty message.

### 4.4 `<Checkbox>` / `<Radio>` / `<Switch>`

- `<Checkbox>` — multi-select within a group, or single binary opt-in (e.g. "I agree to terms").
- `<Radio>` — exclusive choice within a small group (≤ 5 options).
- `<Switch>` — instant-toggle for a binary system state (e.g. "Notifications enabled"). NOT for form submission booleans.

The `<Switch>`-vs-`<Checkbox>` distinction is the most-violated rule in design systems. The rule: if the change takes effect immediately and reverts immediately on toggle, it's a switch. If the change takes effect on form submit, it's a checkbox.

### 4.5 `<Card>`

Surface for grouped content. Three subtypes:

- `<Card>` (default) — neutral background, `--elevation-1`, `--space-6` padding.
- `<Card variant="hover">` — same, but elevation lifts to `--elevation-2` on hover. Used for interactive cards (clickable lists).
- `<Card variant="ghost">` — no background, no elevation, just padding and rounded corners. Used for grouping content visually without visual weight.

Props: `variant`, `padding` (override default), `as` (HTML element to render as, default `div`).

### 4.6 `<Stack>` / `<Inline>` / `<Container>`

See §3 above. These are foundational primitives even though they're layout-only.

---

## 5. AI components

The most consequential section of this spec. AI components are where HireOps either looks like a 2026 product or like an ATS with AI features grafted on. Five core patterns. Each addresses a specific moment in the AI interaction loop.

These components live in `packages/ui/src/ai/*` and use the `--color-ai-*` token set distinctly from the rest of the UI. The AI accent is subtle — a slight tint, a thin border, a small icon — never aggressive. The user should always know an AI is involved, but the AI should never feel like a separate product.

### 5.1 `<AISuggestedInput>`

Pattern: a field where the AI has pre-filled a suggestion the user can edit. Common in: JD authoring (AI drafts the JD, user edits), candidate-message templates (AI suggests response, user refines), offer letter language.

**Visual signal:** when the field contains AI-generated content, a subtle `--color-ai-border` left border indicates "this came from AI." The moment the user starts typing, the AI border fades out — the content is now theirs.

**Affordances:**
- A small `[AI]` indicator in the field's top-right corner while the AI border is visible
- A "Regenerate" tertiary button below the field
- "Used as written: AI [model]" or "Edited from AI suggestion" footnote saved in audit log

**Props:**
```typescript
type AISuggestedInputProps = {
  value: string;
  onChange: (newValue: string, isAIGenerated: boolean) => void;
  generatedBy: string;          // model identifier for audit
  onRegenerate: () => void;
  isGenerating: boolean;
  // ...standard input props
};
```

### 5.2 `<AIScoreWithExplanation>`

Pattern: an AI score (e.g. candidate-vs-JD match) with on-demand explanation of contributing factors. Following Ashby's pattern of criterion-by-criterion explainability for AI-Assisted Application Review.

**Visual:**
- The score number displayed prominently (e.g. `82` in a circle/pill) with a colour band: green ≥ 75, amber 50-74, red < 50
- A small chevron toggle "Why?" beneath the score
- On expansion: list of top 3-5 contributing factors, each with its own mini-score and a one-line rationale

**Critical:** the score is advisory. It is never the primary sort key for life-affecting decisions without human override. If quality calibration drops below thresholds (Spearman ρ < 0.4 per `requirements.md` §5.4), the score is presented as advisory-only with a less prominent visual treatment.

**Props:**
```typescript
type AIScoreWithExplanationProps = {
  score: number;                // 0-100
  factors: Array<{
    name: string;
    contribution: number;       // -100 to 100 (positive or negative)
    rationale: string;          // one-line explanation
  }>;
  modelVersion: string;
  generatedAt: Date;
  size?: 'sm' | 'md' | 'lg';
};
```

### 5.3 `<AIThinking>`

Pattern: an AI is doing work that takes meaningful time (resume parsing, JD generation, candidate scoring, content scanning). Communicates that work is happening without blocking.

**Visual:**
- Subtle pulsing dot animation (NOT a spinner — spinners feel like errors)
- A short, specific status string ("Reading the CV..." not "Loading...")
- For longer operations, multi-step progress: "Reading CV → Extracting structure → Matching to JD"

**Critical UX rule:** don't lie about progress. If the AI takes 8 seconds and you show progress that hits 90% in 2 seconds and then stalls, that's worse than showing honest pulse-animation for the full 8.

**Props:**
```typescript
type AIThinkingProps = {
  status?: string;              // current step description
  steps?: string[];             // multi-step progress
  currentStep?: number;         // 0-indexed
  inline?: boolean;             // inline (small) vs block (full-width)
};
```

### 5.4 `<AIError>`

Pattern: an AI call failed. Graceful degradation to manual fallback. The failure should not block the user from completing the task.

**Visual:**
- Subtle error indicator (NOT a red banner — the AI failure is recoverable, not catastrophic)
- Plain explanation: "We couldn't auto-score this candidate. You can score manually or try again."
- Two actions: `[Try again]` (tertiary), `[Continue without AI]` (secondary)

**Critical UX rule:** the error message is honest about the failure ("Anthropic API rate limit," "Resume parser couldn't read this PDF") but never technical-y to the point of being intimidating. Translate `429 Too Many Requests` to "Our AI service is temporarily busy."

**Audit:** every AI failure logs to `ai_usage_logs` with the error type. Aggregated weekly for engineering review.

### 5.5 `<AIOverride>`

Pattern: the user has the ability and visible affordance to overrule any AI decision. This is the trustworthiness requirement (§1.2 principle 4) made tangible.

**Visual:**
- Wherever an AI decision is shown (a score, a flag, a recommendation), an `[Override]` link appears in proximity
- Clicking it opens a small modal: "Override AI [decision]" with a required reason field and confirm
- The override is logged in `audit_logs` with actor, AI decision, override decision, reason

**Where it appears:**
- AI score with explanation → "Override score" link in the explanation drawer
- AI-flagged content (partner message scanner) → "Override flag (allow)" with required reason
- AI knockout question evaluation → "Override knockout (advance candidate)" with required reason
- Bias flag on offer comp → "Override bias warning" with required reason

**Why this matters:** market reviews of Workday + Paradox specifically call out "AI feels imposed" as a complaint. AI that can't be overridden feels like surveillance. AI that can be overridden, with the override path always visible, builds trust.

---

## 6. Domain components (Layer 2)

These are the components that emerge during Phase 2 from real screens. They are not built upfront — listing them here is the contract for what they must support when they're built.

### 6.1 `<DataTable>`

The single component that handles 10 to 10,000 rows. Built when the recruiter candidates list (INT-04 in the backlog) needs it.

**Required capabilities:**
- Server-side pagination (no client-side for >100 rows)
- Server-side filtering via filter chip bar
- Server-side sorting via column header click
- Column resize, reorder, hide (persisted per-user)
- Row virtualisation when > 50 rows visible
- Multi-row select via checkbox column
- Bulk action bar that appears when ≥ 1 row selected
- Empty / loading / error states
- Sticky header on scroll
- Keyboard navigation (arrow keys move through rows; Enter activates row click)
- Mobile responsive: collapses to card list on viewport < 640px

**Performance budget:**
- Initial render P95 < 200ms with 50 rows
- Pagination transition P95 < 300ms
- Bulk operations on selection up to 50 rows P95 < 5s end-to-end (per `requirements.md` §9.6)

**Accessibility:**
- Table role with proper `<th>` / `<td>` semantics (not div-based)
- Sortable columns announce sort state to screen readers
- Filter changes announce row count changes
- Bulk action bar focus-traps when active

### 6.2 `<KPITile>`

Used on every dashboard. Built when the recruiter dashboard (INT-03) needs it.

Shows: label, primary number, secondary metric (often a delta vs prior period), optional sparkline, optional click-through to a filtered list view.

**Visual restraint:** four KPI tiles in a row maximum. More than that and the dashboard becomes "page of numbers." If you need more than four, group into a secondary tile cluster on scroll.

### 6.3 `<StatusBadge>`

Pill-shaped badge for stage transitions, status indicators, status counts.

Variants by colour: positive, warning, error, info, neutral. Sizes: sm, md.

Critical rule: status colour matches semantic meaning (§2.1). "Submitted" is neutral, not green. "Hired" is positive. "Rejected" is neutral, not red (rejection is not an error). "Failed BGV" is error.

### 6.4 `<AvatarStack>`

Multiple avatars overlapping with count for overflow ("+3"). Used for: panel composition, request approvers, team membership, partner-org users.

### 6.5 `<FormField>` / `<FormSection>` / `<FormActions>`

Form composition primitives. Built when the apply form and partner submit wizard need them.

`<FormField>`: wraps a single `<Input>` / `<Select>` / etc. with label, hint, error, required indicator.
`<FormSection>`: groups related fields with a heading and optional description.
`<FormActions>`: sticky footer with primary/secondary actions; primary is always rightmost on desktop, always topmost on mobile.

### 6.6 Empty / Loading / Error states

Codified for every list, table, dashboard.

- **Empty:** illustrative icon (line-art, single-colour), one-line headline, one-line explanation, one CTA if action is possible
- **Loading:** skeleton states matching final content layout, never spinners for primary content (spinners only for secondary in-progress operations)
- **Error:** quiet error indicator, plain language explanation, retry action where possible

These three states are the most-skipped part of design systems and the most-noticed by users when missing. Every list/table component must declare empty, loading, and error states explicitly.

---

## 7. Patterns

### 7.1 Persona shell

Same shell, different navigation per persona. The shell is a single component (`<AppShell>`) that takes a navigation config.

Visual structure:
- **Top bar:** product name (left), search (center, when applicable), notifications + user menu (right)
- **Left sidebar:** primary navigation items per persona, collapsible to icon-only
- **Main content area:** persona-specific routes
- **Bottom bar (mobile only):** primary persona actions

Persona-specific colour treatments:
- Internal portal (recruiter / HM / panel / HR Ops / People Ops / IT / Admin): standard `--color-brand-*` accents
- Candidate portal: standard `--color-brand-*` accents (consistent visual language with internal — candidates feel like they're in the company's hiring system)
- Partner portal: `--color-partner-accent-*` for navigation chrome only — body content unchanged. Reasoning: partner users feel like guests, the visual difference signals "partnership space, not Kyndryl-internal"
- Careers site: lighter visual weight, brand-forward for the tenant (logo prominent, brand colour drives hero), professional but warmer than internal portal

### 7.2 Mobile breakpoints and budgets

```css
--breakpoint-sm: 640px;   /* phone landscape */
--breakpoint-md: 768px;   /* small tablet */
--breakpoint-lg: 1024px;  /* tablet landscape, small laptop */
--breakpoint-xl: 1280px;  /* desktop */
```

**Mobile-first personas (HM, panel, candidate):** flows designed for 375px viewport, touch targets ≥ 44x44px (per Apple HIG). Core actions reachable in ≤ 5 taps from notification entry. P95 page load < 2s on 4G Mumbai/Bangalore baseline (~10 Mbps down, ~80ms RTT) per `requirements.md` §3.1.

**Desktop-first personas (recruiter, HR Ops, admin):** flows designed for 1280px viewport, mobile-responsive but not mobile-optimised. Acceptable to gate complex operations (bulk actions, multi-column data tables) behind larger viewports.

### 7.3 Localisation

Text expansion budgets:
- Hindi text: assume 30-40% longer than English
- Tamil/Telugu: assume 25-35% longer
- All container components must accommodate +40% text expansion without breaking layout
- Test with longest realistic strings, not lorem ipsum

Bidirectional script support is not required for POC (no Arabic, Hebrew, or Urdu in scope) but the design system must not preclude it. CSS uses logical properties (`padding-inline-start`, not `padding-left`) where it doesn't add complexity.

### 7.4 Accessibility

WCAG 2.1 AA enforced at the token level (§2.1) and the component level. Specific commitments:

- All interactive elements keyboard-reachable in tab order
- Focus indicators visible on `:focus-visible` (keyboard) but not `:focus` (mouse)
- Form errors announced by screen reader via `aria-describedby`
- Modal dialogs use `aria-modal="true"` and trap focus
- Lists with > 10 items use semantic `<ul>` / `<ol>` with proper roles
- Tables use proper `<th>` / `<td>` with `scope` attributes
- Colour is never the only indicator of state — pair with icon, text, or position

### 7.5 Loading and progressive disclosure

The platform uses progressive disclosure aggressively to manage density:

- Primary information visible immediately
- Secondary information one click away (expand/collapse, drawer, tab)
- Tertiary information accessible via menu or settings

Specifically:
- Candidate detail page: tab structure (Profile / Applications / Interviews / Communications / Audit) per `requirements.md` §10.1
- Partner detail (Kyndryl admin view): tab structure (Overview / Users / Reqs / Commercials / Pipeline / Audit) per `partner-wireflows.md` §5.3
- Requisition detail: tab structure (Candidates / Interviews / Approvals / Comments)

Tabs in this design system are **flat, not nested**. Two levels of tabs is a pattern smell — restructure the information hierarchy instead.

---

## 8. Multi-tenant white-labelling

Per `multi-tenancy-adr.md` §5.1, each tenant has a `tenant_settings` JSONB column carrying cosmetic config: logo URL, primary brand colour, locale defaults, "powered by HireOps" toggle.

**What's tenant-overridable:**
- Logo (top bar, login screens, email templates)
- `--color-brand-500` and derived shades (`-50`, `-100`, `-600`, `-700` derived from a single brand-500 input)
- Locale defaults (currency, timezone, date format, number format)
- "Powered by HireOps" badge visibility in footer

**What's NOT tenant-overridable:**
- Status colours (positive/warning/error semantics are platform-fixed)
- Neutral scale (typography legibility depends on this)
- AI component tokens (`--color-ai-*`)
- Spacing scale, type scale, density tokens
- Layout primitives, primitive components

Reasoning: tenants want their brand on the surface. They don't want their brand on the underlying interaction patterns. The platform's quality bar requires the latter to be consistent.

---

## 9. What this spec does not cover

- **Motion / animation library.** Beyond minimal rules (no spinners for primary content, no progress bars that lie), motion is deferred. When it comes up in implementation, refer back to the principles in §1.
- **Illustration / iconography library.** Lucide is the icon library (already in dependencies). Illustration is per-screen judgement; no platform illustration library v1.
- **Marketing / sales-page design.** This spec is for the product. Marketing surfaces are designed independently.
- **Email template design.** Notification email templates are a separate spec. They follow the colour and typography tokens but use different layout primitives (inline CSS, table-based for client compatibility).
- **Print / PDF rendering.** Offer letters, invoices, partner contracts. Separate spec when needed.
- **Layer 2 components beyond §6.** Components emerge from real screens. The list in §6 is the contract for what those components must support, not an upfront component library.

---

## 10. Implementation checklist

When `packages/ui` is built out:

- [ ] All tokens defined in `tokens.css` and mirrored in `tokens.ts`
- [ ] Eight foundational primitives (§4) implemented with all variants and states
- [ ] Three layout primitives (§3) implemented
- [ ] Five AI components (§5) implemented with tokens, states, and audit hooks
- [ ] Storybook stories for every primitive and AI component
- [ ] Visual regression tests for primitives (Chromatic or Percy if used)
- [ ] Accessibility tests via @axe-core/react in CI
- [ ] Token contrast ratios verified via automated tooling (e.g., axe-core or pa11y)
- [ ] All formatters (currency, date, number, phone) live in `formatters.ts` with tenant locale support
- [ ] Tenant white-labelling demonstrated with a non-default brand colour applied across all primitives

---

## 11. Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-05-09 | Single doc rather than split tokens-vs-components | Easier to grep and reference; emergence of Layer 2 components doesn't justify splitting |
| 2026-05-09 | Anchor explicitly to Ashby with restraint | Generic design specs produce generic products; specific anchoring with selective divergence produces distinctive ones |
| 2026-05-09 | One density level default (vs three) | Multiple densities multiplies testing surface; comfortable + recruiter-compact is sufficient |
| 2026-05-09 | Status colours strictly semantic | Most design systems botch this; baking it in at token level prevents drift |
| 2026-05-09 | AI components get their own token set | AI surfaces being visually distinct-but-not-bolted-on requires explicit design work |
| 2026-05-09 | Partner portal uses `--color-partner-accent-*` for chrome only | Partner users feel like guests; visual difference signals partnership space |
| 2026-05-09 | Tenant white-labelling allows brand colour but not interaction patterns | Brand belongs to tenants; quality bar belongs to the platform |
| 2026-05-09 | Layer 2 components emerge from screens, not built upfront | Avoids over-engineering components nobody consumes |

(Future amendments to this spec should be appended here, not edited inline.)
