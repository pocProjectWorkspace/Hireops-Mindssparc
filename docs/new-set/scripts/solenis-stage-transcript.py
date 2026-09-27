#!/usr/bin/env python3
"""
Stage the notetaker demo on the Solenis environment — one panel round with a
real transcript + AI notes, generated BEFORE the meeting so the recruiter opens
it finished.

Runs against the LIVE Solenis API with a recruiter's own session (Supabase
password grant), exactly what the browser does. No direct DB writes except the
one SQL step in the runbook (candidate email → demo inbox).

Reads SUPABASE_URL / SUPABASE_ANON_KEY from the linked Railway project
(`railway variables --service api --json`), so run it from the repo root,
which is linked to the Solenis project `welcoming-sparkle`.

Usage:
  python3 docs/new-set/scripts/solenis-stage-transcript.py schedule
  python3 docs/new-set/scripts/solenis-stage-transcript.py request-recording <interviewId>
  python3 docs/new-set/scripts/solenis-stage-transcript.py upload <interviewId> <file.m4a>
  python3 docs/new-set/scripts/solenis-stage-transcript.py status <interviewId>

Runbook: docs/new-set/SOLENIS-staged-transcript-runbook.md
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

API = os.environ.get("HIREOPS_API_BASE", "https://api-production-c213.up.railway.app")
RECRUITER = os.environ.get("HIREOPS_RECRUITER", "ashwin.kumar@solenis.com")
PASSWORD = os.environ.get("HIREOPS_PASSWORD", "TestPassword123!")

# Karthik Subramanian · SAP Plant Accountant · seeded at stage tech_interview
APPLICATION_ID = "00000000-0000-4000-9000-22000000000c"
PANEL_MANEESH = "074d32ff-16eb-41ad-a9b7-c8abf1828851"  # maneesh.gupta@solenis.com
PANEL_RAGHU = "fca6194d-e7d5-4e21-bea7-98cfd4968af3"  # raghu.mehra@solenis.com (HM)


def railway_env():
    out = subprocess.check_output(["railway", "variables", "--service", "api", "--json"])
    d = json.loads(out)
    return d["SUPABASE_URL"], d["SUPABASE_ANON_KEY"]


def signin(email, pw):
    url, anon = railway_env()
    req = urllib.request.Request(
        url + "/auth/v1/token?grant_type=password",
        data=json.dumps({"email": email, "password": pw}).encode(),
        headers={"apikey": anon, "Content-Type": "application/json"},
    )
    return json.load(urllib.request.urlopen(req))["access_token"]


def _unwrap(r):
    return r.get("result", {}).get("data", r) if isinstance(r, dict) else r


def query(jwt, name, inp=None):
    url = API + "/trpc/" + name
    if inp is not None:
        url += "?input=" + urllib.parse.quote(json.dumps(inp))
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + jwt})
    try:
        return _unwrap(json.load(urllib.request.urlopen(req)))
    except urllib.error.HTTPError as e:
        return {"http": e.code, "body": e.read().decode()[:600]}


def mutate(jwt, name, inp):
    req = urllib.request.Request(
        API + "/trpc/" + name,
        data=json.dumps(inp).encode(),
        headers={"Authorization": "Bearer " + jwt, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        return _unwrap(json.load(urllib.request.urlopen(req)))
    except urllib.error.HTTPError as e:
        return {"http": e.code, "body": e.read().decode()[:600]}


def cmd_schedule(jwt):
    r = mutate(
        jwt,
        "scheduleInterview",
        {
            "applicationId": APPLICATION_ID,
            "roundNumber": 1,
            "scheduledStart": "2026-09-29T04:30:00.000Z",  # 10:00 IST Mon 29 Sep
            "durationMinutes": 45,
            "mode": "video",
            "meetingUrl": "https://teams.microsoft.com/l/meetup-join/solenis-gbs-panel-karthik",
            "panelMembershipIds": [PANEL_MANEESH, PANEL_RAGHU],
            "leadMembershipId": PANEL_MANEESH,
        },
    )
    print(json.dumps(r, indent=2)[:1500])
    if isinstance(r, dict) and r.get("interviewId"):
        print("\nINTERVIEW_ID =", r["interviewId"])
        print("Invitation sent to:", r.get("invitationSentTo"))


def cmd_request_recording(jwt, interview_id):
    print(json.dumps(mutate(jwt, "setInterviewRecordingRequested", {"interviewId": interview_id, "requested": True}), indent=2)[:800])


def cmd_upload(jwt, interview_id, path):
    size = os.path.getsize(path)
    ext = path.rsplit(".", 1)[-1].lower()
    ctype = {"m4a": "audio/mp4", "mp3": "audio/mpeg", "webm": "audio/webm", "ogg": "audio/ogg"}[ext]
    start = mutate(jwt, "startInterviewMediaUpload", {"interviewId": interview_id, "contentType": ctype, "sizeBytes": size})
    if not isinstance(start, dict) or "uploadUrl" not in start:
        print("start failed:", start)
        return
    print("recordingId:", start["recordingId"], "storageKey:", start["storageKey"])
    with open(path, "rb") as f:
        req = urllib.request.Request(start["uploadUrl"], data=f.read(), method="PUT", headers={"Content-Type": ctype})
        resp = urllib.request.urlopen(req)
        print("PUT:", resp.status)
    # duration hint: ffprobe if available
    dur = None
    try:
        dur = int(float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path]).decode().strip()))
    except Exception:
        pass
    done = mutate(jwt, "completeInterviewMediaUpload", {"interviewId": interview_id, "durationSeconds": dur})
    print(json.dumps(done, indent=2)[:800])


def cmd_status(jwt, interview_id):
    print(json.dumps(query(jwt, "getInterviewRecordingState", {"interviewId": interview_id}), indent=2)[:2000])


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    jwt = signin(RECRUITER, PASSWORD)
    cmd = sys.argv[1]
    if cmd == "schedule":
        cmd_schedule(jwt)
    elif cmd == "request-recording":
        cmd_request_recording(jwt, sys.argv[2])
    elif cmd == "upload":
        cmd_upload(jwt, sys.argv[2], sys.argv[3])
    elif cmd == "status":
        cmd_status(jwt, sys.argv[2])
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
