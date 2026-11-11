"""Authenticated loopback inference service, owned by the Electron parent."""
import os
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '2')
os.environ.setdefault('MPLBACKEND', 'Agg')
import hmac
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
import sys
import threading
import traceback
from vision import FaceEngine, MODEL_ID


def serve():
    token = os.environ.get('PRESENCE_BACKEND_TOKEN', '')
    if len(token) < 32:
        raise RuntimeError('The desktop application must supply a backend session token.')
    engine = FaceEngine()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Never log images, descriptors, or request bodies.

        def do_POST(self):
            if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                self.respond(403, {'error': 'Unauthorized local request.'})
                return
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if length < 2 or length > 1_600_000:
                    raise ValueError('Invalid request size.')
                self.connection.settimeout(10)
                payload = json.loads(self.rfile.read(length))
                if self.path == '/health':
                    result = {'ready': True, 'model': MODEL_ID, 'pipeline': 'MediaPipe landmarks + OpenCV SFace', 'offline': True}
                elif self.path == '/analyze':
                    result = engine.analyze(payload.get('frame'))
                else:
                    self.respond(404, {'error': 'Unknown operation.'})
                    return
                self.respond(200, result)
            except (ValueError, TypeError, KeyError) as error:
                self.respond(400, {'error': str(error)})
            except Exception:
                traceback.print_exc(file=sys.stderr)
                self.respond(500, {'error': 'The local recognition engine could not process this frame. Stop the camera and retry.'})

        def respond(self, status, payload):
            data = json.dumps(payload, allow_nan=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    server = HTTPServer(('127.0.0.1', 0), Handler)
    # stdin is a private pipe held open by Electron. Parent exit closes it even
    # after an unexpected crash, preventing an orphan backend from remaining.
    def watch_parent():
        try:
            sys.stdin.buffer.read()
        finally:
            server.shutdown()
    threading.Thread(target=watch_parent, daemon=True).start()
    print(json.dumps({'ready': True, 'port': server.server_address[1], 'model': MODEL_ID}), flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
        engine.close()


if __name__ == '__main__':
    try:
        serve()
    except Exception:
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
