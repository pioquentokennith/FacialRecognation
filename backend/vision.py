"""Offline MediaPipe landmarks + five-point SFace alignment and embeddings."""
from pathlib import Path
import base64
import hashlib
import json
import math
import time

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks import python
from mediapipe.tasks.python import vision

MODEL_ID = 'sface-mediapipe-5pt-v1'
ROOT = Path(__file__).resolve().parent


class FaceEngine:
    def __init__(self):
        cv2.setNumThreads(2)
        model_dir = ROOT / 'models'
        checksums = json.loads((model_dir / 'checksums.json').read_text())
        for filename in ('face_landmarker.task', 'face_recognition_sface_2021dec.onnx'):
            if hashlib.sha256((model_dir / filename).read_bytes()).hexdigest() != checksums[filename]:
                raise RuntimeError(f'Offline model is damaged: {filename}. Repair the application installation.')
        options = vision.FaceLandmarkerOptions(
            base_options=python.BaseOptions(model_asset_path=str(model_dir / 'face_landmarker.task')),
            running_mode=vision.RunningMode.IMAGE,
            num_faces=3,
            min_face_detection_confidence=0.5,
            min_face_presence_confidence=0.5,
            min_tracking_confidence=0.5,
            output_face_blendshapes=False,
            output_facial_transformation_matrixes=False,
        )
        self.landmarker = vision.FaceLandmarker.create_from_options(options)
        self.recognizer = cv2.FaceRecognizerSF.create(str(model_dir / 'face_recognition_sface_2021dec.onnx'), '')

    def analyze(self, encoded):
        started = time.perf_counter()
        if not isinstance(encoded, str) or len(encoded) > 1_500_000:
            raise ValueError('Invalid camera frame size.')
        if not encoded.startswith('data:image/jpeg;base64,'):
            raise ValueError('Expected a JPEG camera frame.')
        raw = base64.b64decode(encoded.split(',', 1)[1], validate=True)
        image = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
        if image is None or image.shape[0] > 1080 or image.shape[1] > 1920:
            raise ValueError('Camera frame could not be decoded or is too large.')
        height, width = image.shape[:2]
        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        result = self.landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
        faces = result.face_landmarks
        response = {'model': MODEL_ID, 'faceCount': len(faces), 'usable': False,
                    'code': 'no_face', 'message': 'Looking for a face. Face the camera and keep your whole face in view.',
                    'box': None, 'points': [], 'quality': None, 'descriptor': None,
                    'frameHash': hashlib.sha256(raw).hexdigest()}
        if not faces:
            return response
        if len(faces) != 1:
            response.update(code='multiple_faces', message='More than one face is visible. Only one student should be in the frame.')
            return response
        landmarks = faces[0]
        points = np.array([[p.x * width, p.y * height] for p in landmarks], np.float32)
        # SFace expects image-left eye, image-right eye, nose, image-left mouth,
        # image-right mouth. Eye corner midpoints avoid gaze-dependent iris drift.
        left_eye = (points[33] + points[133]) / 2
        right_eye = (points[362] + points[263]) / 2
        eyes = sorted([left_eye, right_eye], key=lambda p: p[0])
        mouth = sorted([points[61], points[291]], key=lambda p: p[0])
        anchors = np.array([eyes[0], eyes[1], points[1], mouth[0], mouth[1]], np.float32)
        min_xy = np.min(points[:468], axis=0)
        max_xy = np.max(points[:468], axis=0)
        x0, y0 = np.maximum(min_xy, [0, 0]).astype(int)
        x1, y1 = np.minimum(max_xy, [width - 1, height - 1]).astype(int)
        response['box'] = {'x': float(x0 / width), 'y': float(y0 / height),
                           'width': float((x1 - x0) / width), 'height': float((y1 - y0) / height)}
        response['points'] = [[float(x / width), float(y / height)] for x, y in anchors]
        if x1 <= x0 or y1 <= y0:
            response.update(code='position', message='Keep your whole face inside the camera frame.')
            return response
        gray = cv2.cvtColor(image[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
        brightness = float(np.mean(gray))
        contrast = float(np.std(gray))
        # Measure sharpness at a fixed resolution for stable thresholds across cameras.
        sharpness = float(cv2.Laplacian(cv2.resize(gray, (160, 160)), cv2.CV_64F).var())
        eye_distance = float(np.linalg.norm(anchors[1] - anchors[0]))
        roll = math.degrees(math.atan2(float(anchors[1, 1] - anchors[0, 1]), float(anchors[1, 0] - anchors[0, 0])))
        eye_mid = (anchors[0] + anchors[1]) / 2
        yaw_proxy = abs(float(anchors[2, 0] - eye_mid[0])) / max(eye_distance, 1)
        response['quality'] = {'brightness': round(brightness), 'sharpness': round(sharpness, 1),
                               'roll': round(roll, 1), 'eyeDistance': round(eye_distance, 1)}
        problem = None
        if min(x0, y0) < 3 or x1 >= width - 3 or y1 >= height - 3:
            problem = ('position', 'Move back slightly so your whole face is inside the frame.')
        elif eye_distance < 38 or min(x1 - x0, y1 - y0) < 110:
            problem = ('too_small', 'Move closer. Your face is too small to compare reliably.')
        elif brightness < 48:
            problem = ('dark', 'Your face is too dark. Put a light in front of you, not behind you.')
        elif brightness > 225:
            problem = ('bright', 'Your face is overexposed. Reduce the light in front of you.')
        elif contrast < 13 or sharpness < 18:
            problem = ('blur', 'Hold still and clean or focus the camera lens.')
        elif abs(roll) > 22 or yaw_proxy > 0.32:
            problem = ('pose', 'Look toward the camera and keep your head mostly upright.')
        if problem:
            response.update(code=problem[0], message=problem[1])
            return response
        # OpenCV uses exactly the five points above to estimate a similarity warp
        # into the 112x112 SFace reference. Never compare raw landmark coordinates.
        face_row = np.concatenate(([x0, y0, x1 - x0, y1 - y0], anchors.flatten(), [1.0])).astype(np.float32)
        aligned = self.recognizer.alignCrop(image, face_row)
        feature = self.recognizer.feature(aligned).flatten().astype(np.float64)
        norm = float(np.linalg.norm(feature))
        if feature.size != 128 or not np.isfinite(feature).all() or norm < 1e-8:
            raise ValueError('The recognition model returned an invalid face signature. Please retry.')
        response.update(usable=True, code='ready', message='Face is clear. Hold still for recognition.',
                        descriptor=(feature / norm).tolist(), latencyMs=round((time.perf_counter() - started) * 1000))
        return response

    def close(self):
        self.landmarker.close()
