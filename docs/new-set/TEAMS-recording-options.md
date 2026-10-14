# Getting Teams interview recordings into HireOps — two options, scoped

29 Sep 2026. Context: the notetaker pipeline (consent → recording → transcript → AI notes →
retention) is live on Solenis. Today the recording enters by **manual upload** after the call
(`interview_recordings.source = 'manual_upload'`). The schema already reserves
`'vendor_bot'` for an automatic path. This note scopes the two automatic paths.

Both options feed the **same** pipeline — consent gate, transcription, notes, retention and
audit are unchanged. The consent rule does not move: nothing is fetched or recorded for an
interview whose candidate has not consented.

## Option A — pull Teams' own recording/transcript from Microsoft 365 (Graph API)

**How it works.** The panel records the Teams meeting as they would anyway (or the meeting is
set to auto-record). After the meeting, HireOps is notified (or polls), finds the meeting from
the interview's Teams join link, and downloads the recording — and optionally Teams' own
transcript, which already carries **real speaker names** from the Solenis directory.

**Microsoft pieces** (all documented, GA):
- `onlineMeeting` recordings + transcripts APIs; transcripts arrive as `.vtt`
  ([list transcripts](https://learn.microsoft.com/en-us/graph/api/onlinemeeting-list-transcripts?view=graph-rest-1.0),
  [GA announcement](https://devblogs.microsoft.com/microsoft365dev/microsoft-graph-apis-for-microsoft-teams-meeting-transcripts-now-generally-available/)).
- App permissions `OnlineMeetingRecording.Read.All`, `OnlineMeetingTranscript.Read.All`
  (+ `OnlineMeetings.Read.All` to resolve the meeting from its join URL)
  ([permission reference](https://graphpermissions.merill.net/permission/OnlineMeetingTranscript.Read.All)).
- A tenant **application access policy** granted to the interview organisers — app-only access
  is refused without it ([Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/2264627/how-to-get-meeting-transcript-record-content-using)).
- Change notifications when a recording/transcript is ready (subscription + renewal)
  ([docs](https://learn.microsoft.com/en-us/graph/teams-changenotifications-callrecording-and-calltranscript)).
- Limits: scheduled / calendar-backed meetings only (not channel meetings); someone must record.

**What Solenis IT must do.** Admin-consent the HireOps app in their Entra tenant; run the
access-policy PowerShell for the recruiter/panel organisers; confirm Teams recording +
transcription are enabled for those users. Enterprise security review is the real lead time.

**Build (HireOps).** ~5–7 executor-days:
1. Per-tenant Microsoft 365 connection in `integration_credentials` (KEK-wrapped, exists) + admin
   setup screen (tenant id, consent link, health check). ~1.5 d
2. Resolve interview → Teams meeting from the stored `meeting_url` at schedule time; store the
   meeting id. ~1 d
3. Change-notification webhook (validation token, subscription renewal job) with a polling
   fallback. First inbound webhook route in the codebase. ~1.5 d
4. Fetch recording (+ `.vtt` transcript) → `interview_recordings` (new source `teams_graph`) →
   existing drain. Use Teams' transcript with names when present; AssemblyAI otherwise. ~1.5 d
5. Tests + fixtures, consent gate re-checked at fetch time. ~1 d

**Calendar time:** 1–2 weeks build + Solenis IT approval (typically 1–4 weeks). **Not demo-able
against the Solenis tenant by 8 Oct**; possibly on MindsSparc's own M365 tenant if it has Teams
recording enabled.

**Cost:** no per-minute vendor fee; transcription either free (Teams' own) or AssemblyAI
(~$0.28/hr).

**Why it fits Solenis:** Microsoft shop; audio never passes through a third party; nothing new
joins the call; real speaker names.

## Option B — a meeting bot joins the call (Recall.ai)

**How it works.** When an interview is scheduled with a Teams link, HireOps books a bot
("HireOps Notetaker") to join at the start time. The organiser admits it from the lobby; it
records; when the meeting ends Recall calls our webhook and we fetch the recording/transcript
into the same pipeline.

**Vendor:** [Recall.ai](https://www.recall.ai/product/meeting-bot-api/microsoft-teams) —
**$0.50 per recording hour**, +$0.15/hr if using their transcription, 7 days free storage
([2026 pricing](https://www.recall.ai/blog/new-recall-ai-pricing-for-2026)). Also works for
Zoom / Google Meet, which matters for other clients.

**Build (HireOps).** ~4–5 executor-days:
1. Recall client + per-tenant key in `integration_credentials`; `local` fixture mode. ~1 d
2. Bot lifecycle bound to interview schedule / reschedule / cancel (only when recording is
   requested AND consent granted). ~1.5 d
3. Signed webhook route (HMAC verify, idempotent) → fetch media → `source = 'vendor_bot'`. ~1.5 d
4. Recruiter card shows bot status (scheduled / in call / done / not admitted). ~0.5 d

**What Solenis must accept:** an external participant in interview calls; guest/lobby policy
that allows it; a third-party sub-processor (DPA, data region) handling interview audio.

**Cost:** ~$0.50–0.65/hr on top of transcription (~₹45–55 per interview hour).

## Recommendation

- **For the 8 Oct demo:** show the live upload flow and say plainly that automatic capture is
  the next step. Do not claim the bot or Graph pull exists.
- **For Solenis:** **Option A** first — it keeps audio inside Microsoft 365, adds no participant
  to the call, gives real speaker names, and has no per-minute vendor fee. Start the Solenis IT
  consent conversation now; it is the long pole.
- **Option B** as the multi-platform fallback for clients not on Teams, or if Solenis IT will
  not grant the Graph permissions.

## Questions for Solenis IT
1. Will you admin-consent an app with `OnlineMeetingRecording.Read.All` /
   `OnlineMeetingTranscript.Read.All`, scoped by an application access policy to the TA team?
2. Are Teams recording and transcription enabled for recruiters and panel members today?
3. Are interviews scheduled from Outlook/Teams calendars (required) or channel meetings?
4. Would an external meeting bot be allowed into interview calls (lobby / guest policy)?
