# Parser output schema

Canonical shape produced by `parseResume` / `parseResumeFromText` in
`@hireops/ai-client`. This is the contract every downstream consumer
depends on — recruiter triage screen, AI scoring, knockout evaluation,
partner submission ingestion. Stored in `candidates.parsed_skills` (jsonb).

The Zod schema (`parserOutputSchema`) and JSON Schema
(`parserOutputJsonSchema`, fed to the LLM via `completeStructured`) are
generated from the same source-of-truth in
`packages/ai-client/src/parsers/resume-schema.ts`. Bump `PARSER_VERSION`
on every schema change.

## Shape

```ts
{
  personal: {
    full_name:        string | null,
    email:            string | null,    // primary email, lowercased
    phone:            string | null,    // E.164 if extractable, else raw
    location_city:    string | null,
    location_country: string | null,    // ISO 3166-1 alpha-2 if extractable
    linkedin_url:     string | null,
    github_url:       string | null,
    portfolio_url:    string | null,
  },
  summary:                string | null,
  total_years_experience: number | null,    // parser-computed (see below)
  current_role: {                            // null if between jobs
    title:       string,
    company:     string,
    start_date:  string,                     // ISO 8601 YYYY-MM or YYYY
    location:    string | null,
    description: string | null,
  } | null,
  work_history: [                            // ordered most-recent first
    {
      title:           string,
      company:         string,
      start_date:      string,               // ISO 8601
      end_date:        string | null,        // null = current
      location:        string | null,
      description:     string | null,
      employment_type: 'full_time' | 'contract' | 'internship' | 'freelance' | null,
    }
  ],
  education: [
    {
      degree:         string,                // "B.Tech", "MBA", "PhD"
      field_of_study: string | null,
      institution:    string,
      start_year:     number | null,
      end_year:       number | null,
      grade:          string | null,         // free text (CGPA / %  / class)
    }
  ],
  skills: {
    technical:      [string],                // raw strings from the CV
    languages:      [string],                // human languages
    certifications: [
      { name: string, issuer: string | null, year: number | null }
    ],
    domain:         [string],                // "fintech", "healthcare", …
  },
  notice_period_days:    number | null,
  expected_compensation: {
    amount:   number,
    currency: string,                        // ISO 4217
    period:   'annual' | 'monthly',
  } | null,
  parse_metadata: {
    parser_version:   string,                // semver, bumped per schema change
    parsed_at:        string,                // ISO 8601 timestamp
    confidence_score: number,                // 0.0 – 1.0
    source_format:    'pdf_text' | 'pdf_scanned' | 'docx' | 'unknown',
    parser_model:     string,                // e.g. "claude-sonnet-4-6"
  }
}
```

## Conventions

### `current_role` mirrors `work_history[0]`

When `work_history[0].end_date` is `null`, the candidate is currently
employed in that role. `current_role` carries the same fields (minus
`end_date` and `employment_type`) for fast UI access. The parser sets it
defensively even if the LLM omits — see `computeCurrentRole` in
`resume.ts`. `null` when the candidate is between jobs.

### `total_years_experience` is parser-computed

The parser sums durations across `work_history` (treating `null`
`end_date` as today) and reconciles against any explicit "X years" claim
in the CV. The LLM is instructed to prefer the work-history sum when the
two disagree by more than 1 year — gaps, internships, and self-reporting
errors all show up in real CVs.

Stored as `number`, typically rounded to one decimal.

### `employment_type` is best-effort

Most Indian CVs don't say it. `null` when ambiguous; `'full_time'` is
NOT a safe default.

### `grade` is free text, not normalised

Indian grading varies wildly: "8.2 CGPA", "75.4%", "First Class
Distinction", "Division II". Normalising would lose information that
recruiters use to triage. Downstream tooling (e.g. score ranking) parses
on demand.

### Dates: ISO 8601 fragments

`YYYY-MM` when month is known; `YYYY` when only year is known. Never
full ISO datetime — month-level resolution is the most a CV gives.

### `confidence_score` interpretation

LLM-self-reported, prompted explicitly:

- **1.0** — every field extracted with certainty
- **0.7+** — high confidence, recruiter can trust the parse
- **0.5** — significant gaps or ambiguity; some fields are guesses
- **0.2** — most fields couldn't be confidently extracted
- **0.0** — parse failed (extraction error, empty text, LLM error, or
  schema violation). Returned by the parser instead of a thrown error so
  the apply form can prompt the candidate to re-upload.

UI threshold: candidate detail page surfaces "review carefully" below
0.7; apply form re-prompts at 0.0.

### `source_format`

- `pdf_text` — PDF with a real text layer (pdf-parse path)
- `pdf_scanned` — PDF with no text layer; OCR ran (tesseract.js path)
- `docx` — Word document (mammoth path)
- `unknown` — extraction failed (unsupported mime type, corrupt file).
  Always paired with `confidence_score = 0`.

### `parser_version`

Semver. Bump on every schema change. Stored alongside the parsed output
so downstream code can decide whether to re-parse:

- **Patch** — bug fix, no schema change. Downstream doesn't care.
- **Minor** — schema additions (new optional field). Old parses are
  still valid.
- **Major** — breaking change (field removed or shape changed).
  Downstream must re-parse or migrate.

`parser_model` is informational — what model the parser sent the prompt
to. `'local'` for LocalAIClient runs.

## Known limitations (Wave 1)

- **English only.** Non-English sections of a CV (Hindi summary, Arabic
  origin certificate text) appear inside `work_history[*].description`
  in raw form; they're not separately structured. Defer multi-language
  to Wave 2 once a tenant asks.
- **No per-tenant config.** Single canonical schema. A tenant that wants
  to extract custom fields (e.g. "willing to relocate") goes through a
  follow-up ticket.
- **Phase 2 quality bar = 4–5 seed CVs.** The 95% accuracy gate
  described in `requirements.md` §5.3 is a Phase 3 deliverable
  (AI-02-CORPUS), validated against the 100-CV Indian corpus.

## Re-parsing

Each row in `candidates` carries the version of the parser that produced
its `parsed_skills`. A future bulk re-parse job (when a major schema
change ships) reads `parsed_skills.parse_metadata.parser_version` and
re-parses the original CV blob (still stored on the candidate record)
through the current parser.
