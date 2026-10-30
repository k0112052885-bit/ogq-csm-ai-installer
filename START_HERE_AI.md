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

## Quick path: link registration (default - no kit, no invitation, no fingerprint to type)
**OGQ owner-provided intake endpoint (built into this repository, `join.json`):** https://ethan-macbookpro.tail40be41.ts.net:10000 (HTTPS intake only, intentionally public for device join; it is not the admin login UI). Use this exact address and do NOT ask the human for an address or a name: run `install --consent-install` with no `--server` and no `--label`, and the installer reads `join.json` and gives this Mac a neutral alias like `ogq-1a2b3c` (pass `--label` only if the human volunteers a short name; `--server` / `--label` always override the built-in values). After `install` and again after `join`, tell the human the alias and the verification code so they can pass both to the owner, who opens the join window and approves the device.
There is NO fingerprint in this path: do not ask the human for one (`preflight` prints none and checks every file against MANIFEST.json by itself). Nothing is needed from the human except consent. Nothing secret is needed: registration only creates a PENDING request that the owner must approve in the dashboard.
1. `node scripts/employee-install.mjs install --consent-install` (address and alias come from `join.json`; override with `--server <dashboard address> --label <short name>`; add `--profile <name> --claude-config-dir <absolute folder>` ONLY for a second Claude account on the same Mac, each profile with its own config folder and login; the default install needs neither).
2. From now on run every command from the INSTALLED copy, not from this clone: `node ~/.ogq-csm/app/scripts/employee-install.mjs <command>` (a profile install lives in `~/.ogq-csm-<profile>/app/scripts/`). The installed copy always uses its own folder, so two accounts on one Mac never mix. `status` prints `next`; follow it: `sdk --consent-sdk`, `observe --consent-observe`, `bind --consent-bind`. Before `bind`, ask the human whether the account logged in for THIS install (for a profile: the one logged in under its own `--claude-config-dir`) is the one meant.
3. **Register**: `join --consent-join`. It prints a **verification code**. If it says registration is closed, ask the owner to open it (Devices page, "link registration window") and run `join` again.
4. Tell the human to read the verification code to the owner. The owner types it in the dashboard and chooses which subscription this Mac reports for. State `PENDING_ADMIN_APPROVAL` until then; never claim approval early.
5. `install-agents --consent-agents`. The background agents pick up the owner's signed approval by themselves and start sending readings; `finalize` does the same on demand.
   Optional evidence check any time after the first poll: `node ~/.ogq-csm/app/scripts/employee-verify.mjs` (offline: says whether the stored 5h/7d reading came from the real SDK poller or looks synthetic) and, with the human's yes, `... employee-verify.mjs --live --yes` (one read-only SDK call: reports whether the 5-hour and 7-day windows are really returned, writes nothing). Report its answer as it is; a missing 5-hour window is a finding, not an error to hide.
6. Report two separate lines: (a) installation phase from `status`; (b) owner approval: PENDING or APPROVED. Done when `status` shows phase `RUNNING`.
Everything above runs through the same consent prompts; the human must say yes to each.
**Pin the code:** check out the commit the owner named and confirm `git rev-parse HEAD` equals it. If no commit was named, tell the human you would be installing whatever the repository holds today and continue only if they agree. The integrity manifest in this repository detects accidental damage only; the owner's commit is the trust anchor.
**Limits you must state, not hide:** a second Claude account on the same Mac needs its own Claude login in its own config folder (`CLAUDE_CONFIG_DIR=<folder> claude`, then log in); this installer cannot create that login. Registration works only while the owner has opened the window; if the HTTPS address does not answer, stop and tell the human.

## Alternative path: private device kit (only if the owner hands you one)
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
- Update: pull the owner-named commit or tag here, re-run `preflight --server <dashboard address> --label <short name>` (link mode shows no fingerprint and needs none; with a device kit use `--expect-fingerprint`), then `... update --package-dir <this clone> --consent-update`.
- Remove: `... uninstall --consent-uninstall` (`--purge` also deletes the device key; the device would then need a NEW kit).
- One Mac keeps one Claude login linked at a time. Do not install a second account on the same Mac unless the owner says how.

## If something fails
| Symptom | What to do |
| --- | --- |
| integrity / fingerprint mismatch | stop; this clone is not the owner's build |
| invite missing or expired | ask the owner for a new kit for this device |
| observe: e-mail not available | this login cannot be linked; tell the owner |
| finalize: still pending | nothing is wrong; the owner has not approved yet |
