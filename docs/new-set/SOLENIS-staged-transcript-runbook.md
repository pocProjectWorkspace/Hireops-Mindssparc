# Solenis staged transcript — notetaker demo (C2)

Goal: before Tuesday, one Solenis panel round exists with candidate consent, a
recording, a real AssemblyAI transcript and Claude notes, so the recruiter opens
it **finished** on stage. Optionally a second upload is done live.

State on 27 Sep: AssemblyAI key is set on the Solenis workers (healthy);
Anthropic credential exists on the tenant; API is on today's main.
Candidate: **Karthik Subramanian · SAP Plant Accountant**, seeded at stage
`tech_interview` (application `00000000-0000-4000-9000-22000000000c`).
Panel: Maneesh Gupta (lead) + Raghu Mehra. Recruiter: Ashwin Kumar.
Recording: a 4-minute synthetic panel round (two voices, product costing /
material ledger content) — copy it from the session scratchpad:
`/private/tmp/claude-501/-Users-sutharsanparthasaarathy-Desktop-Workspace-hireops/25d7da5b-ffd7-4a22-b96b-33f66c6a5720/scratchpad/panel-round-karthik.m4a`
into `public/solenis demo data/` (gitignored). If the scratchpad is gone, any
3–5 min m4a/mp3 of two people talking works.

All commands from the repo root (linked to the Solenis Railway project).

## 1. Point the candidate at the demo inbox (SQL, Solenis DB)

Consent is only capturable by the candidate clicking the interview-confirm link,
and Resend test mode delivers only to `digitalfuturity@outlook.com`.

```sql
UPDATE public.persons
   SET email_primary = 'digitalfuturity@outlook.com',
       email_normalised = 'digitalfuturity@outlook.com',
       updated_at = now()
 WHERE id = (SELECT c.person_id FROM public.applications a
             JOIN public.candidates c ON c.id = a.candidate_id
             WHERE a.id = '00000000-0000-4000-9000-22000000000c')
RETURNING full_name, email_primary;
```
Connection string: `railway variables --service api --json | jq -r .DATABASE_URL`.

## 2. Schedule the round (as Ashwin, via the live API)

```
python3 docs/new-set/scripts/solenis-stage-transcript.py schedule
```
Prints `INTERVIEW_ID`. The workers drain the invitation within a minute.

## 3. Candidate confirms + consents (you, in the demo inbox)

Open the "Interview scheduled" email in `digitalfuturity@outlook.com`, click the
confirm link, tick **"I consent to this interview being recorded"**, confirm.
This writes the append-only consent row (`captured_via = candidate_confirm_link`).
There is deliberately no internal shortcut for this.

## 4. Recruiter asks for the recording

```
python3 docs/new-set/scripts/solenis-stage-transcript.py request-recording <INTERVIEW_ID>
```

## 5. Upload the recording

```
python3 docs/new-set/scripts/solenis-stage-transcript.py upload <INTERVIEW_ID> "public/solenis demo data/panel-round-karthik.m4a"
```
Signed PUT straight to storage, then `completeInterviewMediaUpload` enqueues the
transcript. Expect `enqueued: true`.

## 6. Watch it land

```
python3 docs/new-set/scripts/solenis-stage-transcript.py status <INTERVIEW_ID>
railway logs --service workers | grep -iE "transcript|asr|notes" | tail
```
Transcript for 4 minutes of audio takes ~1–2 min at AssemblyAI; AI notes follow
on the next drain tick. Then sign in as Ashwin → Interviews → the round → the
recording panel shows transcript + machine-written notes with model and prompt
version. That is the screen to open on stage.

## On stage

Show the finished round first (consent shown, recruiter toggle, transcript,
notes, provenance line, retention setting). If there is time, upload a second
short clip live and let the audience watch the status move.

## Undo

Delete nothing. The round, consent log and recording are legitimate demo data
on the pilot tenant. To reuse the candidate email later, reverse step 1.
