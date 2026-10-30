# Install the OGQ Claude usage reporter (instructions for an AI agent)

This repository is **code only** (version 0.1.0). It holds NO invitation, signing key, token, account data or admin file. You are helping an employee install a small
background reporter on THEIR OWN Mac. It reports Claude plan usage percentages (5-hour / 7-day) for the shared subscription the owner assigned to this device, by FILE HANDOFF.
Read all of this first.

## Ground rules (do not break these)
1. Work only inside this clone, the device kit folder and `~/.ogq-csm`. Never read or edit `~/.claude`, Claude settings, credentials, keychain or browser data.
2. Every command prints ONE JSON line. If it prints `needsConsent`, show the human the `question` text verbatim and re-run with the named flag ONLY after they say yes. Never invent consent, never run `sudo`.
3. The per-device **invitation** is private and single use. Never commit, push, upload, paste into chat or any web service, or copy it into this clone. Never run `git push` or `git commit` here.
4. Never print or send `~/.ogq-csm/device`, `~/.ogq-csm/private`, `~/.ogq-csm/data/identity-*`, `install.json` or anything holding a key. Only `outbox/enroll-request.json` and `outbox/readings/*.json` go to the owner.
5. Enrollment is **admin-mediated and NOT automatic**: after `enroll` the device stays `PENDING_ADMIN_APPROVAL` until the owner approves it. Report installation and admin approval as two separate statements; never claim approval early.

## Step 0 - get what only the owner can give (secure handoff, NOT GitHub)
You need two things from the owner, each for THIS Mac (one kit per device; a kit is bound to one account and expires):
- the **device kit folder** (contains `invite.json` and `package-config.json`), delivered by a private channel (AirDrop, encrypted message, in person). Keep it OUTSIDE this clone, e.g. `~/ogq-csm-kit`.
- the **12-character fingerprint** of this code, given through a DIFFERENT channel than the kit (and the commit/tag to check out, if the owner named one).
If either is missing or expired, STOP and ask the human to request it from the owner. Do not try to create or guess an invitation.

## Steps
Run from this clone (`node scripts/employee-install.mjs ...`; Node 20 or newer). After each step run `status`; its `next` field names the next command and consent question.
1. **Check** (read-only): `node scripts/employee-install.mjs preflight --kit-dir <kit folder> --expect-fingerprint <12 chars>`. If a required check fails (integrity, fingerprint, invite), stop and tell the human.
2. **Install**: `... install --kit-dir <kit folder> --expect-fingerprint <12 chars> --consent-install`. The invite moves into `~/.ogq-csm/private`. From now on use `node ~/.ogq-csm/app/scripts/employee-install.mjs <command>`.
3. **SDK**: `... sdk --consent-sdk` (pinned Claude Agent SDK 0.3.301, needs internet; offline: `--sdk-from <folder>`).
4. **Identify the Claude login** (the human must be logged in to the account for this device): `... observe --consent-observe`. If the e-mail is not available, stop.
5. **Link it**: ask "is the account logged in on this Mac the one assigned to this device?" then `... bind --consent-bind`.
6. **Enroll**: `... enroll --consent-enroll`. It prints a verification code and writes `~/.ogq-csm/outbox/enroll-request.json`.
7. **Hand off to the owner** (the human does this, privately - not GitHub): send `enroll-request.json` and read out the verification code. The kit folder can then be deleted by the human.
8. **Wait**: state `PENDING_ADMIN_APPROVAL`. When the owner returns `approval.json`, put it in `~/.ogq-csm/inbox/` and run `... finalize`.
9. **Background agents** (launchd): `... install-agents --consent-agents`.
10. **Report to the human, in two separate lines**: (a) installation state from `status` (phase, warnings); (b) admin approval: PENDING or APPROVED. Done only when `status` shows phase `RUNNING`.

## Later
- Health: `node ~/.ogq-csm/app/scripts/employee-install.mjs status`.
- Update: pull the owner-named tag here, re-run preflight with the NEW fingerprint, then `... update --package-dir <this clone> --consent-update`.
- Remove: `... uninstall --consent-uninstall` (`--purge` also deletes the device key; the device would then need a NEW kit).
- One Mac keeps one Claude login linked at a time. Do not install a second account on the same Mac unless the owner says how.

## If something fails
| Symptom | What to do |
| --- | --- |
| integrity / fingerprint mismatch | stop; this clone is not the owner's build |
| invite missing or expired | ask the owner for a new kit for this device |
| observe: e-mail not available | this login cannot be linked; tell the owner |
| finalize: still pending | nothing is wrong; the owner has not approved yet |
