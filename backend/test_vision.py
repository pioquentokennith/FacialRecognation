"""Real offline model checks with public upstream test fixtures; no webcam access."""
from pathlib import Path
import base64
import unittest
import cv2
import numpy as np
from vision import FaceEngine, MODEL_ID

FIXTURES = Path(__file__).resolve().parent.parent / 'tests' / 'fixtures'


def fixture(name, size=320):
    image = cv2.imread(str(FIXTURES / name))
    if image is None:
        raise RuntimeError(f'Missing test fixture: {name}')
    canvas = np.full((480, 640, 3), 145, np.uint8)
    h, w = image.shape[:2]
    scale = min(size / w, size / h)
    resized = cv2.resize(image, (round(w * scale), round(h * scale)))
    y, x = (480 - resized.shape[0]) // 2, (640 - resized.shape[1]) // 2
    canvas[y:y + resized.shape[0], x:x + resized.shape[1]] = resized
    return canvas


def encode(image):
    success, jpeg = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, 90])
    assert success
    return 'data:image/jpeg;base64,' + base64.b64encode(jpeg).decode()


class VisionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = FaceEngine()

    @classmethod
    def tearDownClass(cls):
        cls.engine.close()

    def test_real_face_produces_normalized_signature(self):
        result = self.engine.analyze(encode(fixture('face1.png')))
        self.assertTrue(result['usable'], result)
        self.assertEqual(result['model'], MODEL_ID)
        self.assertEqual(len(result['descriptor']), 128)
        self.assertAlmostEqual(float(np.linalg.norm(result['descriptor'])), 1.0, places=6)
        self.assertEqual(len(result['points']), 5)

    def test_alignment_handles_rotation_scale_and_moderate_lighting(self):
        base = self.engine.analyze(encode(fixture('face1.png')))
        self.assertTrue(base['usable'], base['message'])
        image = fixture('face1.png', size=290)
        rotated = cv2.warpAffine(image, cv2.getRotationMatrix2D((320, 240), 7, 1), (640, 480), borderValue=(145, 145, 145))
        changed = cv2.convertScaleAbs(rotated, alpha=0.85, beta=12)
        result = self.engine.analyze(encode(changed))
        self.assertTrue(result['usable'], result['message'])
        score = float(np.dot(base['descriptor'], result['descriptor']))
        print(f'Alignment/lighting same-face cosine: {score:.3f}')
        self.assertGreater(score, 0.5)

    def test_different_person_is_below_matching_threshold(self):
        a = self.engine.analyze(encode(fixture('face1.png')))
        b = self.engine.analyze(encode(fixture('face2.png')))
        self.assertTrue(a['usable'], a['message'])
        self.assertTrue(b['usable'], b['message'])
        score = float(np.dot(a['descriptor'], b['descriptor']))
        print(f'Different-person cosine: {score:.3f}')
        self.assertLess(score, 0.45)

    def test_blank_frame_is_not_a_match(self):
        result = self.engine.analyze(encode(np.zeros((480, 640, 3), np.uint8)))
        self.assertFalse(result['usable'])
        self.assertEqual(result['code'], 'no_face')
        self.assertIsNone(result['descriptor'])

    def test_multiple_faces_are_rejected(self):
        canvas = np.full((480, 640, 3), 145, np.uint8)
        for name, x in [('face1.png', 40), ('face2.png', 360)]:
            canvas[120:360, x:x + 240] = cv2.resize(cv2.imread(str(FIXTURES / name)), (240, 240))
        result = self.engine.analyze(encode(canvas))
        self.assertEqual(result['code'], 'multiple_faces', result)
        self.assertFalse(result['usable'])

    def test_dark_frame_does_not_produce_descriptor(self):
        image = cv2.convertScaleAbs(fixture('face1.png'), alpha=0.18)
        result = self.engine.analyze(encode(image))
        self.assertFalse(result['usable'])
        self.assertIn(result['code'], ['dark', 'no_face'])
        self.assertIsNone(result['descriptor'])

    def test_invalid_input_fails_clearly(self):
        for data in ['not an image', 'data:image/jpeg;base64,garbage', 'x' * 1_500_001]:
            with self.assertRaises(ValueError):
                self.engine.analyze(data)


if __name__ == '__main__':
    unittest.main(verbosity=2)
