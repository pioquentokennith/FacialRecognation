# Third-party notices

- Electron — MIT; Chromium and other bundled component licenses are included in the Electron distribution.
- React / React DOM — MIT.
- React Router — MIT.
- better-sqlite3 — MIT; SQLite is public domain.
- Lucide icons — ISC.
- Python embeddable runtime — Python Software Foundation License, included in the bundled runtime.
- MediaPipe — Apache 2.0, https://github.com/google-ai-edge/mediapipe. The Face Landmarker task model is distributed from Google's MediaPipe model storage. The license is included in `backend/models/MEDIAPIPE_LICENSE`.
- OpenCV / opencv-contrib-python — Apache 2.0 and bundled third-party notices in the installed package.
- SFace recognition model — Apache 2.0, https://github.com/opencv/opencv_zoo/tree/main/models/face_recognition_sface. License included in `backend/models/SFACE_LICENSE`.
- NumPy, Matplotlib, Pillow, and other Python runtime dependency licenses are retained in the bundled packages and their distribution metadata. Exact versions are recorded in `backend/requirements.lock.txt`.
- Legacy face-api models remain in the source `public/models/` folder for historical reference, with the original license, but are not included in the version 1.1 application build.
- The automated test images `tests/fixtures/face1.png` and `tests/fixtures/face2.png` come from the same face-api.js repository's `test/images` directory. They are upstream software-test fixtures, are not shipped in the installed application, and are not retained in a normal workspace database.

Dependency license files remain in their installed packages. Development tooling includes Vite, Playwright, electron-builder, concurrently, and wait-on under their respective open-source licenses.
