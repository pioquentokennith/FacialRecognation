# Presence Attendance 1.1 — offline Windows desktop

Electron + React attendance app with a **bundled local Python AI service**, **MediaPipe Face Landmarker**, **OpenCV SFace**, and **local SQLite**. No online database, cloud API, internet connection, or separately installed Python is required when using the Windows installer.

## Install / upgrade

Run `release-v1.1/Presence Attendance Setup 1.1.0.exe`. Close the old application before installing or launching the new version. The unpacked application is `release-v1.1/win-unpacked/Presence Attendance.exe`.

The package name and Windows application ID stay the same as version 1.0, so the existing local student, account, roster, and attendance database is reused. **Existing face-api registrations require one-time re-enrollment** because their face signatures cannot be compared with SFace. They are clearly marked **Re-enrollment required**. Older signatures remain stored until replaced or deleted; the upgrade does not discard attendance history.

Initial demo credentials for a new database:

| Role | Username | Password |
| --- | --- | --- |
| Admin | `admin` | `admin123` |
| Teacher | `teacher` | `teacher123` |

Existing databases keep their existing passwords. Change your password under **Settings & backup**. Admin manages Teachers under **Team accounts**.

## Enroll a face correctly

1. Sign in as Admin. Register the student, or locate the existing record under **Students**.
2. Select the face icon and obtain consent for local face enrollment.
3. Start the camera. The live overlay shows the detected face and five alignment points.
4. Follow the feedback: one face, head mostly upright, whole face visible, clear focus, and light in front of the person.
5. Capture **three usable samples** with small variations in angle. Allow a moment between captures. Inconsistent identities and exact repeated frames are rejected.
6. Select **Verify with fresh capture**. This fourth capture must agree with the saved samples; it is not included in the saved enrollment samples.
7. Only after verification succeeds, select **Save face enrollment**. The student shows **Enrolled · SFace**.

If replacing an enrollment, the previous registration remains intact until a successful save. Photographs and camera recordings are not stored. Only the three normalized face signatures, model identifier, and consent/enrollment timestamps are saved.

## Continuous face-assisted attendance

1. Open today's attendance. All active students at opening are added to the daily roster.
2. Select **Face-assisted**. The readiness panel shows usable registrations, old registrations needing upgrade, and students excluded from the roster.
3. If a student was registered after the day opened, Admin can explicitly select **Include newly registered students**. Existing roster snapshots are preserved and additions are audited. This also resolves an accidentally opened empty roster.
4. Start the camera. Scanning runs continuously; no repeated “Find student” clicks are needed.
5. MediaPipe checks face positioning. The local backend aligns the face and generates an SFace signature. Matching requires **three consistent, distinct frames spanning at least one second**.
6. A successful match stops the camera and displays the student's name and Student ID. Verify the identity, then select **Confirm & save attendance**.

No attendance is saved automatically. The main process requires a fresh, one-use recognition proof for face-assisted check-in. Proofs expire after two minutes and are invalidated if the enrollment changes. The database enforces one record per student per day.

### When scanning cannot match

- **No face / multiple faces:** adjust who is in view.
- **Dark / bright / blurred / tilted face:** follow the specific capture guidance.
- **Re-enrollment required:** Admin must replace the old face-api signature using the new engine.
- **Student outside the roster:** Admin explicitly includes the student on today's open day.
- **Unknown face:** the live signature did not meet the match threshold against enrolled roster students.
- **Ambiguous match:** two enrolled students scored too similarly; check for duplicate or incorrect registrations.
- **Offline service unavailable:** stop scanning and retry; reinstall if bundled dependencies are missing. Manual attendance stays available.

Expand **Scan diagnostics** to see face count, brightness, sharpness, processing time, and cosine similarity. Similarity is **not an accuracy percentage**. Avoid accepting an identity just because it has the highest score.

## Other features

- Admin and Teacher login, hashed passwords, logout, password changes, and login throttling.
- Student registration, case-insensitive unique IDs, searching, editing, archival, reactivation, and conditional permanent deletion.
- Manual attendance independent of camera/enrollment.
- Daily opening, closure, absent generation, reopening, Admin corrections, and change history.
- Dashboard totals and presence summary derived from actual roster and attendance records.
- Search and inclusive date-range/status/method report filters, including unrecorded roster entries.
- CSV export of all filtered rows, Unicode support, correct quoting, and spreadsheet-formula protection.
- Teacher account creation, editing, password reset, and deactivation/reactivation.
- Complete local backup, integrity/schema validation, restore, and automatic pre-restore recovery copy.
- Windows installer, app icon, desktop/Start Menu shortcuts, and single-instance launch.

Only Admin manages students/faces/accounts, adds roster members, closes/reopens days, corrects records, or performs backup/restore. Both roles can open today's day, check in students, review records, and export CSV.

## Attendance rules

- One attendance group and one record per student per device-local calendar day.
- Daily roster details are historical snapshots. Student profile edits do not rewrite old reports.
- New students do not join an already-open day automatically. Admin can explicitly append them with an audit record.
- Closing creates absent records for missing check-ins. Repeated closing does not duplicate absences.
- Closed days reject check-ins. Admin must reopen before corrections.
- A check-in on a reopened current day updates an absence in place.
- Historical corrections require a reason and do not invent a check-in timestamp.
- Resetting to “Not yet recorded” retains an audit event; closing again creates an absence if appropriate.
- Date is checked again at save time. After midnight, open/select the new day.
- Archival removes face signatures and excludes students from future rosters while preserving history. Reactivation requires new face enrollment.

## How the offline AI works

The renderer captures webcam frames (maximum 640×480) and sends them through a narrow Electron preload API. Electron communicates with its own Python service bound only to **127.0.0.1 on a random port**, authenticated by a per-launch token. The renderer never receives the service token or stored descriptors.

The service is started automatically, uses bundled model files, and stops when Electron closes or its parent pipe disappears. It performs no network downloads at runtime. SQLite remains managed by the Electron main process; the Python service handles CPU inference only.

MediaPipe returns dense face landmarks. Eye-corner midpoints, nose tip, and mouth corners are ordered in image coordinates and passed to OpenCV's five-point `FaceRecognizerSF.alignCrop`, producing SFace's expected 112×112 input. SFace generates a normalized 128-value embedding. Recognition compares cosine similarity, not raw landmark distances.

Current starting parameters are in `electron/face-service.cjs`:

- Match threshold: **0.45 cosine similarity**.
- Runner-up separation: **0.08**.
- Enrollment/fresh verification similarity: **0.50**.
- Three consistent distinct frames, spanning at least one second.

These thresholds are implementation defaults, not a measured accuracy claim for your classroom. Test with consenting volunteers on the actual webcam and lighting. Unknown-person, similar-looking-person, and varied-pose checks are important before relying on the system. Multi-frame consistency is not liveness or anti-spoofing detection.

## Local data and recovery

The exact SQLite path appears in **Settings & backup**, normally `%APPDATA%\presence-desktop\presence.sqlite`. It is outside the installation directory and preserved across upgrades and ordinary uninstall. Separate Windows profiles or devices do not synchronize.

**Save backup** creates a complete snapshot containing accounts, student details, attendance, rosters, signatures, and audit history. CSV reports are not restorable backups. **Restore backup** validates compatibility and integrity, saves a `recovery-<timestamp>.sqlite` beside the live database, replaces the data, cancels active scans, and logs out. Use passwords from the restored backup. Restoring an old face-api backup correctly marks those faces for re-enrollment.

If the database prevents startup, close the app and preserve its entire data folder. Replace it with a known-good backup and move aside the damaged database's `-wal`/`-shm` files before restarting. Never edit database files while the app is running. Local accounts are application-level controls; the unencrypted database remains accessible to the Windows user.

## Development and packaging

Requirements: Windows x64, Node.js 22.12+ (Node 24 recommended), npm, and internet for the initial development downloads.

```powershell
npm install
npm run backend:setup
npm run build
npm run dev
```

`backend:setup` downloads an isolated embeddable Python runtime, installs locked dependencies into `backend/runtime`, and downloads MediaPipe/SFace model files into `backend/models`. It does not require or modify a system Python installation. Model checksums are verified on build and backend startup.

```powershell
npm start
npm run dist
```

The installer and unpacked build are written to **release-v1.1/**. The Python runtime, native dependencies, models, and licenses are included as extra resources. The older `release/` output is not overwritten. The installer is unsigned; publisher signing can be configured when a certificate is available.

## Tests

```powershell
npm test
npm run test:vision
npm run build
npm run test:ui
npm run smoke
node scripts/smoke-packaged.cjs
node scripts/smoke-dev.cjs
```

- Database tests use isolated real SQLite databases and exercise persistence, permissions, corrections, exports, and recovery.
- Face-service tests check migration/roster status, held-out enrollment verification, ambiguous/unknown rejection, streak resets, proof expiry/reuse, changed enrollment, and cancellation.
- Python tests run actual MediaPipe and SFace inference on public test fixtures, including scale/rotation/lighting alignment, different identities, multiple faces, invalid input, and dark/blank frames.
- Electron UI tests exercise complete enrollment and continuous matching with changing camera-fixture frames, unknown-person rejection, human confirmation, camera release, and normal app workflows. Native file dialogs are substituted with temporary selected paths in automated export/backup tests.
- Packaged smoke tests start the distributed executable and its bundled Python service using temporary data.

These checks do not substitute for real-webcam testing or a separate clean-machine installer check. Tests do not change the normal workspace database.

## Main source files

- `backend/vision.py`: MediaPipe detection, quality checks, alignment, SFace inference.
- `backend/server.py`: authenticated local inference service and parent-lifetime handling.
- `electron/vision-backend.cjs`: automatic backend startup, requests, and shutdown.
- `electron/face-service.cjs`: enrollment, matching, streaks, and attendance proofs.
- `electron/database.cjs`: local data, permissions, attendance rules, and backup/restore.
- `src/components/FaceCapture.jsx`: continuous webcam loop, overlay, guidance, and verification.
- `src/components/FaceReadiness.jsx`: enrollment/roster diagnostics and audited roster additions.
- `src/pages/`: normal classroom management and reporting screens.

Outside this version: online databases, cloud synchronization, scheduling/sections, multiple daily sessions, late/time-out tracking, automatic updates, and liveness detection.
