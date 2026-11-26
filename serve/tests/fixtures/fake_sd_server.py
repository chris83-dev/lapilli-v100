"""A stand-in for stable-diffusion.cpp's sd-server in the tests of serve/images.py: its native job API as its
documentation (examples/server/api.md) describes it: GET /sdcpp/v1/capabilities, POST /sdcpp/v1/img_gen (202 and a job id),
GET /sdcpp/v1/jobs/{id} (progress through the sampling steps with a preview, then the result), POST .../cancel. Every
request body it gets is written, one JSON line each, to the file named by FAKE_SD_LOG; the environment it saw too (its
CUDA_VISIBLE_DEVICES, whether GGML_CUDA_P2P was set).
    python fake_sd_server.py --model-dir D --listen-ip 127.0.0.1 --listen-port P [...]"""
import base64
import json
import os
import struct
import sys
import threading
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer



def _png() -> str:
    """A valid 1x1 RGBA PNG, built here (no file)."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    raw = chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(b"\x00\xff\x80\x00\xff"))
    return base64.b64encode(b"\x89PNG\r\n\x1a\n" + raw + chunk(b"IEND", b"")).decode()


PNG = _png()
# a video job's result: a tiny real MJPEG AVI (5 frames of 64×64, made by ffmpeg), as sd-server gives one
AVI = base64.b64encode(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "tiny.avi"), "rb").read()).decode()
# LTX-2.3's AVI carries its sound: 5 MJPEG frames and 0.21 s of PCM, stereo 48 kHz (a 440 Hz tone)
AVI_SON = base64.b64encode(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "tiny-son.avi"), "rb").read()).decode()
STEPS = 4
LOG = os.environ.get("FAKE_SD_LOG")
MODEL_DIR = None
jobs, lock = {}, threading.Lock()
loaded = {"recipe": None}       # (soir) like sd-server: a change of recipe reads the other model's files ("preparing")


def note(obj):
    if LOG:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj) + "\n")


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/sdcpp/v1/capabilities":
            return self.send(200, {"preview_modes": ["none", "proj", "tae", "vae"]})
        if self.path == "/sdapi/v1/loras":             # the files of loras/, as sd-server lists them
            d = os.path.join(MODEL_DIR, "loras") if MODEL_DIR else ""
            names = sorted(os.listdir(d)) if d and os.path.isdir(d) else []
            return self.send(200, [{"name": os.path.splitext(n)[0], "path": n} for n in names])
        if self.path.startswith("/sdcpp/v1/jobs/"):
            jid = self.path.rsplit("/", 1)[1]
            with lock:
                j = jobs.get(jid)
                if j is None:
                    return self.send(404, {"error": "not found"})
                if j["cancel"]:
                    j["status"] = "cancelled"
                elif j["load"]:                              # one file read per reading, under "preparing"
                    with open(os.path.join(MODEL_DIR, j["load"].pop(0)), "rb") as f:
                        while f.read(1 << 20):
                            pass
                    j["status"] = "generating"
                    return self.send(200, {"id": jid, "kind": "img_gen", "status": "generating",
                                           "progress": {"stage": "preparing"}, "preview": None, "result": None, "error": None})
                elif j["polls"] < STEPS:
                    j["polls"] += 1
                    j["status"] = "generating"
                else:
                    j["status"] = "completed"
                out = {"id": jid, "kind": "img_gen", "status": j["status"],
                       "progress": {"stage": "sampling", "completed": min(j["polls"], STEPS), "total": STEPS, "unit": "steps"},
                       "preview": {"pass": 1, "step": j["polls"], "total_steps": STEPS, "b64_json": PNG} if j["status"] == "generating" else None,
                       "result": ({"output_format": "avi", "mime_type": "video/x-msvideo", "fps": j["fps"], "frame_count": 5,
                                   "b64_json": AVI_SON if j.get("son") else AVI} if j["video"] else
                                  {"output_format": "png", "images": [{"index": i, "b64_json": PNG} for i in range(j["count"])]})
                       if j["status"] == "completed" else None,
                       "error": {"code": "cancelled", "message": "job cancelled by client"} if j["status"] == "cancelled" else None}
            return self.send(200, out)
        self.send(404, {"error": "not found"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path in ("/sdcpp/v1/img_gen", "/sdcpp/v1/vid_gen"):
            video = self.path.endswith("vid_gen")
            note({"vid_gen" if video else "img_gen": body})
            with lock:
                jid = f"job_{len(jobs) + 1}"
                recipe = (body.get("model") or {}).get("recipe")
                load = []
                if recipe != loaded["recipe"]:
                    load = list(((body.get("model") or {}).get("models") or {}).values()) + [
                        "loras/" + x["path"] for x in body.get("lora") or []]
                    loaded["recipe"] = recipe
                jobs[jid] = {"polls": 0, "cancel": False, "status": "queued", "count": body.get("batch_count", 1), "load": load,
                             "video": video, "fps": body.get("fps", 16), "son": video and str(recipe).startswith("ltx")}
            return self.send(202, {"id": jid, "kind": "img_gen", "status": "queued", "poll_url": f"/sdcpp/v1/jobs/{jid}"})
        if self.path.startswith("/sdcpp/v1/jobs/") and self.path.endswith("/cancel"):
            jid = self.path.split("/")[-2]
            note({"cancel": jid})
            with lock:
                if jid in jobs:
                    jobs[jid]["cancel"] = True
            return self.send(200, {"id": jid, "cancel_requested": True})
        self.send(404, {"error": "not found"})


def main():
    global MODEL_DIR
    args = sys.argv[1:]
    port = int(args[args.index("--listen-port") + 1])
    MODEL_DIR = args[args.index("--model-dir") + 1]
    note({"argv": args, "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES"),
          "ggml_cuda_p2p": "GGML_CUDA_P2P" in os.environ})
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()


if __name__ == "__main__":
    main()
