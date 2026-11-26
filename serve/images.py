"""(Lapilli) Images beside the chat: Qwen-Image-2.1 through stable-diffusion.cpp's sd-server, run by this
server as a second engine on the same cards.

sd-server (leejet/stable-diffusion.cpp, MIT) is used as it is published: this module starts it on 127.0.0.1 only (behind this
server, on its port), on one card, without peer access between the cards, and talks to its native job API
(/sdcpp/v1/img_gen, /sdcpp/v1/jobs/{id}, .../cancel). The cards hold one engine at a time: an image job takes the shown
model's turn and its fifo, like a chat request, unloads the chat engine and starts sd-server; it keeps the fifo until it ends.
A chat request that comes next waits for it, then Service.ensure_loaded calls release_gpu (this module's stop) before it
loads the chat engine again.

Jobs are this server's own (ids, states, progress, the newest preview, the images): the page polls them; the OpenAI route
(POST /v1/images/generations) waits for its job. Requests are checked here: a model of this list, a size in multiples of 32
within bounds, a few reference images of bounded size, numbers in range."""
from __future__ import annotations

import base64
import binascii
import itertools
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from serve.engine import lifeline
from serve.images_install import Installer, ffmpeg_path, sd_cli_next_to

# The models the page and the API can ask for, in the order the page shows them. Each one: sd-server's recipe,
# its own files by slot (a name pattern in the slot's folder of the model directory: the first file that matches, by name;
# a model never takes another one's file because a name sorts first, as the first version did), its schedule (fixed: the
# model's own, steps and guidance are not sent), and its reference images (optional, or required for an editing model).
# A new model is one more entry here and its files in the model directory. Optional: "loras", LoRAs applied to it (a name pattern
# in loras/ and a multiplier: an acceleration such as Lightning), and "send": False for a model whose schedule is its recipe's
# own (the Turbo's custom sigmas: neither steps nor guidance are sent); a fixed model otherwise sends its own steps and guidance.
QWEN21 = {"llm": "text_encoders/Qwen3VL-8B*.gguf", "llm_vision": "text_encoders/mmproj-Qwen3VL-8B*.gguf",
          "vae": "vae/qwen_image_2.1_vae*.safetensors"}
EDIT_2511 = {"diffusion_model": "diffusion_models/qwen-image-edit-2511*.gguf", "llm": "text_encoders/Qwen2.5-VL-7B-Instruct*.gguf",
             "llm_vision": "text_encoders/Qwen2.5-VL-7B-Instruct*mmproj*.gguf", "vae": "vae/qwen_image_vae*.safetensors"}
MODELS = {
    "turbo": {"recipe": "qwen-image-21-turbo", "label": "Qwen Image 2.1 Turbo", "steps": 8, "cfg": 1.0, "fixed": True, "send": False,
              "refs": "optional", "description": "Fast. Makes images, and edits them from reference images.", "files": {"diffusion_model": "diffusion_models/qwen_image_2.1_turbo*.gguf", **QWEN21}},
    "base": {"recipe": "qwen-image-21", "label": "Qwen Image 2.1", "steps": 40, "cfg": 6.0, "fixed": False,
             "refs": "optional", "description": "Slower and finer, with guidance and a negative prompt.", "files": {"diffusion_model": "diffusion_models/qwen_image_2.1-*.gguf", **QWEN21}},
    # Qwen Image Edit 2511: its recipe sets zero_cond_t (sd.cpp's docs: without it the edits degrade), euler and a flow
    # shift of 3. Measured (sd-cli and this server, the same reference and instruction, seed 42): sd.cpp gives the
    # vision encoder each reference at its OWN size (src/api/generation_image.cpp, "reference_<i>_original"; Qwen's own
    # pipeline makes it ~384×384 first), and beyond ~0.6 megapixels the edits drift: 768×768 right, 896×896 a wrong sign,
    # 1024×1024 a drawing; a 512×512 output from a 1024 reference, an unrelated scene; the same with the text encoder on the
    # CPU (so not the V100). And it is their SUM: two references of 768×768 (a bakery, a lighthouse to hang in it), the
    # instruction ignored and the inside drawn; the same two at 528×528, right. So the references TOGETHER are read at
    # 768×768 at most ("refs_area_max": the page makes them smaller when it sends them, the server refuses beyond); the VAE
    # takes each at the output's area anyway. The output at about 1 megapixel ("area_max": the model card's size; and 20
    # steps already take ~4 min at 1024×1024).
    # Lightning: lightx2v's 8-step LoRA, no guidance: 64 s instead of ~4 min, as right.
    "edit-2511-lightning": {"recipe": "qwen-image-edit-2511", "label": "Qwen Image Edit 2511 Lightning", "steps": 8, "cfg": 1.0,
                            "fixed": True, "refs_area_max": 768 * 768, "area_max": 1024 * 1024, "refs": "required",
                            "description": "Edits your images in 8 steps, about four times faster.",
                            "files": EDIT_2511, "loras": [{"file": "loras/Qwen-Image-Edit-2511-Lightning-8steps*.safetensors",
                                                           "multiplier": 1.0}]},
    # 20 steps: the recipe's 40 take twice the time (~8 min at 1024×1024); the guidance of Qwen's model card (4.0)
    "edit-2511": {"recipe": "qwen-image-edit-2511", "label": "Qwen Image Edit 2511", "steps": 20, "cfg": 4.0, "fixed": False,
                  "refs_area_max": 768 * 768, "area_max": 1024 * 1024, "refs": "required",
                  "description": "Edits your images and keeps faces, objects and text as they are.", "files": EDIT_2511},
}
# (Lapilli) VIDEO: Wan 2.2 TI2V-5B (Apache 2.0), a prompt or a start image to a video, with its recipe's own
# settings (euler, guidance 5, flow shift 5, 20 steps); 24 frames a second, the model's (sd-cli writes 16 by default); 1 + 4k
# frames, 121 at most (5 s). Measured on a V100 (sd-cli, 33 frames): 832×480 66 s, 1280×704 161 s, 704×704 from an
# image 85 s. sd-server writes AVI (MJPEG; built without WebM): ffmpeg (--images-ffmpeg) makes the MP4 the page plays; without
# ffmpeg a video model is not offered.
WAN22_5B = {"diffusion_model": "diffusion_models/Wan2.2-TI2V-5B*.gguf", "t5xxl": "text_encoders/umt5-xxl*.gguf",
            "vae": "vae/wan2.2_vae*.safetensors"}
MODELS["wan22-5b"] = {"kind": "video", "recipe": "wan22-ti2v-5b", "label": "Wan 2.2 Video", "steps": 20, "cfg": 5.0,
                      "fixed": False, "fps": 24, "frames_max": 121, "frames_step": 4, "area_max": 1280 * 704,
                      "refs": "optional", "refs_max": 1, "required": ("diffusion_model", "t5xxl", "vae"),
                      "description": "Makes videos of up to 5 seconds from a prompt, or brings a start image to life.",
                      "files": WAN22_5B,
                      # the negative prompt of stable-diffusion.cpp's own Wan 2.2 TI2V-5B examples (docs/dgl/wan, text and
                      # image to video: Wan's default), sent when the request gives none
                      "negative_default": "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，"
                                          "低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，"
                                          "毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走",
                      # the VAE decoding of the frames, measured on a V100 (five videos from 33 frames at 832×480 to
                      # 121 at 1280×704): 2.1 to 2.2 µs a pixel of each frame, 108 s for 5 s at 832×480, 236 s at 1280×704;
                      # sd-server gives no progress for it: the page tells the time left from this
                      "decode_us_per_px": 2.2}
# (Lapilli) VIDEO WITH SOUND: LTX-2.3 Distilled 1.1 (Lightricks, "LTX-2 Community License":
# worldwide and free, paid only above 10 M$ of yearly revenue): 22 B parameters drawing the frames and the sound together,
# sd-server's recipe ltx23-distilled (euler, guidance 1, 8 steps, 24 frames a second, 1 + 8k frames), Gemma 3 12B reading
# the prompt. Measured on a V100 with sd-cli (5 s, 121 frames): 768×512 in 73 s (steps 41 s, frames decoded in 15 s, sound
# in 4 s), from a start image at 640×640 in 93 s, 1280×704 in 165 s; the sound: stereo 48 kHz. unsloth's GGUF publishes the
# connectors and decoders of "distilled" only: they suit 1.1 (its output drawn right, the same frames-to-frames evenness).
LTX23 = {"diffusion_model": "diffusion_models/ltx-2.3-22b-distilled-1.1*.gguf", "llm": "text_encoders/gemma-3-12b-it*.gguf",
         "embeddings_connectors": "text_encoders/ltx-2.3-22b-distilled_embeddings_connectors*.safetensors",
         "vae": "vae/ltx-2.3-22b-distilled_video_vae*.safetensors", "audio_vae": "vae/ltx-2.3-22b-distilled_audio_vae*.safetensors"}
MODELS["ltx23"] = {"kind": "video", "recipe": "ltx23-distilled", "label": "LTX-2.3 Video", "steps": 8, "cfg": 1.0,
                   "fixed": True, "send": False, "fps": 24, "frames_max": 121, "frames_step": 8, "area_max": 1280 * 704,
                   "refs": "optional", "refs_max": 1, "audio": True,
                   "required": ("diffusion_model", "llm", "embeddings_connectors", "vae", "audio_vae"),
                   "description": "Makes videos with their sound, up to 5 seconds, from a prompt or a start image.",
                   "files": LTX23,
                   # its decoding, measured (three videos of 121 frames, 640×640 to 1280×704): 0.31 to 0.33 µs a pixel of each
                   # frame, and the sound 4.1 s for 121 frames
                   "decode_us_per_px": 0.32, "decode_audio_s_per_frame": 0.034}
REQUIRED_SLOTS = ("diffusion_model", "llm", "vae")
READ_SHOWN = 256 << 20           # model files read for a job beyond this: its "preparing" says it reads them, and how far
SIDE_MIN, SIDE_MAX, AREA_MAX, MULTIPLE = 256, 2816, 2400 * 1792, 32   # the model card's largest sizes are ~4.3 MP
PROMPT_MAX = 4000
REFS_MAX, REF_MAX_BYTES = 4, 16 * 1024 * 1024
COUNT_MAX = 4
STEPS_MAX = 100
CFG_MAX = 20.0
SEED_MAX = 2 ** 53
JOBS_KEPT = 40                      # finished jobs kept for polling, newest first
PREVIEW_MODE = "proj"               # a latent projection: a rough preview at almost no cost (the full VAE costs seconds)
STATES_DONE = ("completed", "failed", "cancelled")
DATA_URL = re.compile(r"^data:image/(png|jpeg|jpg|webp);base64,", re.I)


class ImagesError(ValueError):
    """A request this module refuses: its message is the reason, for a 400."""


@dataclass
class ImagesConfig:
    server: str | list                          # sd-server's executable (or a whole command: the tests' fake server)
    models: str                                 # its model directory (diffusion_models/, text_encoders/, vae/)
    card: int = 0                               # the one card it may see
    port: int = 8099                            # on 127.0.0.1 only
    cap_gib: int = 40                           # Windows: the hard cap of its working set, from its start
    log: str | None = None                      # its output; next to the engine's log by default
    ffmpeg: str | None = None                   # ffmpeg: a video job's AVI made MP4 for the page; video needs it


@dataclass
class Job:
    id: str
    params: dict
    source: str = "page"
    state: str = "queued"           # queued, waiting, switching, starting, generating, completed, failed, cancelled
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    progress: dict = field(default_factory=dict)
    preview: str | None = None      # base64 PNG of the newest preview frame
    images: list = field(default_factory=list)   # base64 PNGs
    video: bytes | None = None      # a video job's MP4 (served apart: GET /api/images/jobs/{id}/video)
    poster: bytes | None = None     # its first frame as a JPEG (GET /api/images/jobs/{id}/poster): the gallery's thumbnail
    video_info: dict | None = None  # its frames, fps and bytes
    error: str | None = None
    remote: str | None = None       # sd-server's job id
    cancel: bool = False
    done: threading.Event = field(default_factory=threading.Event)

    def view(self, with_images: bool = True) -> dict:
        out = {"id": self.id, "state": self.state, "source": self.source, "created": self.created, "started": self.started,
               "finished": self.finished, "params": {k: v for k, v in self.params.items() if k != "refs"},
               "refs": len(self.params.get("refs") or []), "progress": self.progress, "preview": self.preview,
               "error": self.error, "count": len(self.images), "now": time.time(),
               "kind": MODELS.get(self.params.get("model"), {}).get("kind", "image")}
        if self.video is not None:
            out["video"] = dict(self.video_info or {}, bytes=len(self.video), mime="video/mp4",
                                poster=len(self.poster) if self.poster else 0)
        if with_images:
            out["images"] = list(self.images)
        return out


def _side(v, name: str) -> int:
    if isinstance(v, bool) or not isinstance(v, int):
        raise ImagesError(f"{name}: a whole number of pixels")
    if v < SIDE_MIN or v > SIDE_MAX or v % MULTIPLE:
        raise ImagesError(f"{name}: from {SIDE_MIN} to {SIDE_MAX} pixels, a multiple of {MULTIPLE}")
    return v


def check(req: dict) -> dict:
    """The parameters of a job from a request (the page's or the API's), checked; ImagesError for what is refused."""
    prompt = req.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ImagesError("prompt: describe the image")
    if len(prompt) > PROMPT_MAX:
        raise ImagesError(f"prompt: {PROMPT_MAX} characters at most")
    model = req.get("model", "turbo")
    if model not in MODELS:
        raise ImagesError("model: " + ", ".join(MODELS))
    width, height = _side(req.get("width", 1024), "width"), _side(req.get("height", 1024), "height")
    if width * height > AREA_MAX:
        raise ImagesError(f"size: {width}x{height} is more than {AREA_MAX:,} pixels")
    out = {"prompt": prompt, "model": model, "width": width, "height": height}
    m = MODELS[model]
    if m.get("kind") == "video":                     # a video: its frames (1 + 4k), one at a time, one start image
        frames = req.get("frames", 49)
        step, top = m.get("frames_step", 4), m.get("frames_max", 121)
        if isinstance(frames, bool) or not isinstance(frames, int) or not step + 1 <= frames <= top or (frames - 1) % step:
            raise ImagesError(f"frames: from {step + 1} to {top}, one more than a multiple of {step}")
        out["frames"] = frames
        if req.get("count", 1) != 1:
            raise ImagesError("count: a video is made one at a time")
    neg = req.get("negative_prompt")
    if neg is not None:
        if not isinstance(neg, str) or len(neg) > PROMPT_MAX:
            raise ImagesError(f"negative_prompt: text of {PROMPT_MAX} characters at most")
        if neg.strip():
            out["negative_prompt"] = neg
    steps = req.get("steps")
    if steps is not None:
        if isinstance(steps, bool) or not isinstance(steps, int) or not 1 <= steps <= STEPS_MAX:
            raise ImagesError(f"steps: from 1 to {STEPS_MAX}")
        out["steps"] = steps
    cfg = req.get("cfg")
    if cfg is not None:
        if isinstance(cfg, bool) or not isinstance(cfg, (int, float)) or not 0 <= cfg <= CFG_MAX:
            raise ImagesError(f"cfg: from 0 to {CFG_MAX:g}")
        out["cfg"] = float(cfg)
    seed = req.get("seed", -1)
    if isinstance(seed, bool) or not isinstance(seed, int) or not -1 <= seed <= SEED_MAX:
        raise ImagesError("seed: -1 (random) or a whole number")
    out["seed"] = seed
    count = req.get("count", 1)
    if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= COUNT_MAX:
        raise ImagesError(f"count: from 1 to {COUNT_MAX}")
    out["count"] = count
    refs = req.get("refs") or []
    refs_max = m.get("refs_max", REFS_MAX)
    if not isinstance(refs, list) or len(refs) > refs_max:
        raise ImagesError(f"refs: {refs_max} reference images at most" if refs_max > 1 else "refs: one start image at most")
    clean = []
    for i, r in enumerate(refs):
        if not isinstance(r, str) or not DATA_URL.match(r):
            raise ImagesError(f"refs[{i}]: a PNG, JPEG or WebP image as a data: URL")
        raw = r.split(",", 1)[1]
        if len(raw) * 3 // 4 > REF_MAX_BYTES:
            raise ImagesError(f"refs[{i}]: {REF_MAX_BYTES // (1024 * 1024)} MiB at most")
        try:
            base64.b64decode(raw, validate=True)
        except (binascii.Error, ValueError):
            raise ImagesError(f"refs[{i}]: the image data is not valid base64") from None
        clean.append(r)
    if clean:
        out["refs"] = clean
    return out


def image_size(data_url: str) -> tuple | None:
    """The width and height of a PNG, JPEG or WebP image given as a data: URL, read from its header (None when unknown)."""
    import struct
    try:
        raw = base64.b64decode(data_url.split(",", 1)[1], validate=False)     # whole: a photo's metadata can come first
    except (binascii.Error, ValueError, IndexError):
        return None
    if raw[:8] == b"\x89PNG\r\n\x1a\n" and raw[12:16] == b"IHDR":
        return struct.unpack(">II", raw[16:24])
    if raw[:2] == b"\xff\xd8":                     # JPEG: the first start-of-frame marker
        i = 2
        while i + 9 < len(raw):
            if raw[i] != 0xFF or raw[i + 1] == 0xFF:  # outside a marker, or a fill byte before one
                i += 1
                continue
            marker = raw[i + 1]
            if marker == 0x01 or 0xD0 <= marker <= 0xD8:   # markers without a length
                i += 2
                continue
            size = struct.unpack(">H", raw[i + 2:i + 4])[0]
            if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                h, w = struct.unpack(">HH", raw[i + 5:i + 9])
                return w, h
            i += 2 + size
        return None
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        kind = raw[12:16]
        if kind == b"VP8 " and len(raw) >= 30:
            return struct.unpack("<H", raw[26:28])[0] & 0x3FFF, struct.unpack("<H", raw[28:30])[0] & 0x3FFF
        if kind == b"VP8L" and len(raw) >= 25:
            b = int.from_bytes(raw[21:25], "little")
            return (b & 0x3FFF) + 1, ((b >> 14) & 0x3FFF) + 1
        if kind == b"VP8X" and len(raw) >= 30:
            return int.from_bytes(raw[24:27], "little") + 1, int.from_bytes(raw[27:30], "little") + 1
    return None


def refusal(params: dict, model: dict) -> str | None:
    """Why this model refuses these checked parameters here, or None. The one judgment: the server applies it, the bench's
    fake server imports it (the page makes its references smaller beforehand, with the limits GET /api/images gives)."""
    label = model["label"]
    if model["refs"] == "required" and not params.get("refs"):
        return f"refs: the {label} model edits images: add the image to edit"
    if model.get("area_max") and params["width"] * params["height"] > model["area_max"]:
        quoi = "videos" if model.get("kind") == "video" else "images"
        return f"size: the {label} model makes {quoi} of {model['area_max'] / 1e6:.1f} megapixels at most here"
    if model.get("refs_area_max") and params.get("refs"):
        total = 0
        for i, r in enumerate(params["refs"]):
            size = image_size(r)
            if size is None:
                return f"refs[{i}]: the size of this image could not be read"
            total += size[0] * size[1]
        if total > model["refs_area_max"]:
            return (f"refs: the {label} model reads its reference images together at up to "
                    f"{model['refs_area_max'] / 1e6:.2f} megapixels here, {total / 1e6:.2f} sent: make them smaller")
    return None


def openai_params(req: dict) -> dict:
    """An OpenAI images request (POST /v1/images/generations) as this module's parameters."""
    size = req.get("size", "1024x1024")
    m = re.fullmatch(r"(\d+)x(\d+)", size) if isinstance(size, str) else None
    if not m:
        raise ImagesError("size: WIDTHxHEIGHT, for example 1024x1024")
    fmt = req.get("response_format", "b64_json")
    if fmt != "b64_json":
        raise ImagesError("response_format: only b64_json (this server keeps no image files)")
    model = req.get("model")
    names = {"base": "base", "qwen-image-2.1": "base", "qwen-image-21": "base",
             "edit-2511": "edit-2511", "qwen-image-edit-2511": "edit-2511", "edit-2511-lightning": "edit-2511-lightning"}
    model = names.get(model.lower(), "turbo") if isinstance(model, str) else "turbo"
    return check({"prompt": req.get("prompt"), "model": model, "width": int(m.group(1)), "height": int(m.group(2)),
                  "count": req.get("n", 1), "seed": req.get("seed", -1),
                  **({"negative_prompt": req["negative_prompt"]} if "negative_prompt" in req else {})})


class Images:
    """sd-server as this server's second engine, and the jobs it runs."""

    def __init__(self, cfg: ImagesConfig, router):
        self.cfg, self.router = cfg, router
        self.lock = threading.Lock()
        self.proc = None
        self.server_state = "stopped"           # stopped, starting, ready
        self.loaded_kind: str | None = None     # "image" or "video": the kind of the last model sd-server ran (the pill)
        self.jobs: dict[str, Job] = {}
        self.order: list[str] = []
        self.queue: list[Job] = []
        self.wake = threading.Condition(self.lock)
        self.ids = itertools.count(1)
        self.closing = False
        # (Lapilli) the tab's "Install": a model's files from the catalog, into the model folder
        self.installer = Installer(cfg.models, sd_cli_next_to(cfg.server), cap=lambda proc: _cap(proc, cfg.cap_gib, "sd-cli"))
        self.worker = threading.Thread(target=self._work, name="images", daemon=True)
        self.worker.start()

    # ------------------------------------------------------------------------------------------------ the files
    def files(self) -> dict:
        """Each model's catalog files by slot (relative ids, as sd-server lists them), for the models whose required files are
        all there; the vision projector only when found (editing needs it); its LoRA files under "@loras" (file names in loras/)."""
        out = {}
        ffmpeg = self.ffmpeg()
        for name, m in MODELS.items():
            slots, loras = self._found(m)
            if (all(k in slots for k in m.get("required", REQUIRED_SLOTS)) and (m["refs"] != "required" or "llm_vision" in slots)
                    and len(loras) == len(m.get("loras", ()))
                    and (m.get("kind") != "video" or ffmpeg)):
                out[name] = {**slots, **({"@loras": loras} if loras else {})}
        return out

    def _found(self, m: dict) -> tuple[dict, list]:
        """A model's files in the folder: its slots (the first file that matches each, by name) and its LoRAs."""
        root = Path(self.cfg.models)
        slots = {}
        for slot, pattern in m["files"].items():
            folder, glob = pattern.split("/", 1)
            found = [f for f in sorted((root / folder).glob(glob)) if f.is_file()
                     and (slot != "llm" or "mmproj" not in f.name.lower())]
            if found:
                slots[slot] = f"{folder}/{found[0].name}"
        loras = []
        for lo in m.get("loras", ()):
            folder, glob = lo["file"].split("/", 1)
            found = [f for f in sorted((root / folder).glob(glob)) if f.is_file()]
            if found:
                loras.append((found[0].name, lo["multiplier"]))
        return slots, loras

    def ffmpeg(self) -> str | None:
        """the ffmpeg of the videos: the one given (--images-ffmpeg), else the one Install put in the model folder,
        else the system's (PATH); nothing when none is there (the video models are then not offered)."""
        if self.cfg.ffmpeg:
            return self.cfg.ffmpeg if Path(self.cfg.ffmpeg).is_file() else None
        p = ffmpeg_path(self.cfg.models)
        return str(p) if p.is_file() else shutil.which("ffmpeg")

    # ------------------------------------------------------------------------------------------------ the install
    def _plan(self, name: str) -> dict | None:
        slots, loras = self._found(MODELS[name])
        return self.installer.plan(name, slots, [n for n, _ in loras], self.ffmpeg() is not None)

    def install(self, name: str, accept) -> dict:
        """Start installing a model from the catalog (images_install), or refuse with the reason (a ValueError, a 400)."""
        if name not in MODELS:
            raise ImagesError(f"unknown model: {name!r}")
        return self.installer.start(name, MODELS[name]["label"], self._plan(name), accept, done=self._installed)

    def install_cancel(self) -> dict | None:
        return self.installer.cancel()

    def _installed(self) -> None:
        """After an install: an idle sd-server is stopped, so that its next start sees the new files."""
        with self.lock:
            busy = any(j.state in ("waiting", "switching", "starting", "generating") for j in self.jobs.values())
        if not busy and self._alive():
            self.stop()

    def state(self) -> dict:
        # (seen in a real test) the install's state FIRST: a "done" install has put all its files when it
        # says so, so the files read after it include them (read the other way round, a model just installed was still
        # "Not installed yet · 0.0 GB" for one reading: its last file arrived between the two)
        install_job = self.installer.view()
        files = self.files()
        with self.lock:
            # without their previews: a stopped or failed job keeps its last one (its own route gives it), forty of them
            # would weigh hundreds of KB here
            jobs = [{k: v for k, v in self.jobs[i].view(with_images=False).items() if k != "preview"} for i in self.order[:JOBS_KEPT]]
            server = self.server_state if self._alive() else "stopped"
        install = {k: self._plan(k) for k in MODELS if k not in files}
        return {"configured": True, "server": server, "card": self.cfg.card,
                "install_job": install_job,
                "models": {k: {"label": v["label"], "description": v["description"], "available": k in files,
                               "install": None if install.get(k) is None else {x: y for x, y in install[k].items() if x != "names"},
                               "steps": v["steps"], "cfg": v["cfg"], "fixed": v["fixed"], "refs": v["refs"],
                               "edit": "llm_vision" in files.get(k, {}) or v.get("kind") == "video", "fast": bool(v.get("loras")),
                               "refs_area_max": v.get("refs_area_max"), "area_max": v.get("area_max"),
                               "kind": v.get("kind", "image"), "fps": v.get("fps"), "frames_max": v.get("frames_max"),
                               "frames_step": v.get("frames_step"), "refs_max": v.get("refs_max", REFS_MAX),
                               "negative_default": bool(v.get("negative_default")), "decode_us_per_px": v.get("decode_us_per_px"),
                               "audio": bool(v.get("audio")), "decode_audio_s_per_frame": v.get("decode_audio_s_per_frame")}
                           for k, v in MODELS.items()},
                "limits": {"side_min": SIDE_MIN, "side_max": SIDE_MAX, "area_max": AREA_MAX, "multiple": MULTIPLE,
                           "refs_max": REFS_MAX, "count_max": COUNT_MAX, "steps_max": STEPS_MAX, "cfg_max": CFG_MAX},
                "jobs": jobs, "now": time.time()}

    def summary(self) -> dict:
        """For /metrics, so that every tab's status pill tells what the cards do: the image server's state, the job using the
        cards (no preview, no image: a few hundred bytes) and how many wait after it."""
        with self.lock:
            run = next((j for j in self.jobs.values() if j.state in ("waiting", "switching", "starting", "generating")), None)
            queued = sum(1 for j in self.jobs.values() if j.state == "queued")
            server = self.server_state if self._alive() else "stopped"
            # the kind of model the cards hold: "Video model loaded" after a video, in every tab's pill
            loaded = self.loaded_kind if server == "ready" else None
            job = None if run is None else {"id": run.id, "state": run.state, "source": run.source, "progress": dict(run.progress),
                                            "model": run.params["model"], "width": run.params["width"],
                                            "height": run.params["height"], "count": run.params["count"],
                                            "kind": MODELS.get(run.params["model"], {}).get("kind", "image")}
        return {"server": server, "job": job, "queued": queued, "loaded": loaded}

    # ------------------------------------------------------------------------------------------------- the jobs
    def submit(self, params: dict, source: str = "page") -> Job:
        files = self.files()
        if params["model"] not in files:
            raise ImagesError(f"the {MODELS[params['model']]['label']} files are not in {self.cfg.models}")
        if params.get("refs") and MODELS[params["model"]].get("kind") != "video" and "llm_vision" not in files[params["model"]]:
            raise ImagesError("editing with reference images needs the vision projector (mmproj) in text_encoders/")
        non = refusal(params, MODELS[params["model"]])
        if non:
            raise ImagesError(non)
        with self.lock:
            if self.closing:
                raise ImagesError("the server is stopping")
            job = Job(id=f"img-{next(self.ids)}-{int(time.time())}", params=params, source=source)
            self.jobs[job.id] = job
            self.order.insert(0, job.id)
            for old in self.order[JOBS_KEPT:]:
                if self.jobs[old].state in STATES_DONE:
                    del self.jobs[old]
            self.order = [i for i in self.order if i in self.jobs]
            self.queue.append(job)
            self.wake.notify_all()
        return job

    def get(self, job_id: str) -> Job | None:
        with self.lock:
            return self.jobs.get(job_id)

    def cancel(self, job_id: str) -> Job | None:
        with self.lock:
            job = self.jobs.get(job_id)
            if job is None or job.state in STATES_DONE:
                return job
            job.cancel = True
            if job in self.queue:
                self.queue.remove(job)
                self._finish(job, "cancelled", "cancelled before it started")
        if job.remote and job.state == "generating":
            self._http("POST", f"/sdcpp/v1/jobs/{job.remote}/cancel", {})
        return job

    def wait(self, job: Job, timeout: float) -> bool:
        return job.done.wait(timeout)

    def _finish(self, job: Job, state: str, error: str | None = None) -> None:
        job.state, job.finished = state, time.time()
        if error:
            job.error = error
        job.done.set()

    def _work(self) -> None:
        while True:
            with self.lock:
                while not self.queue and not self.closing:
                    self.wake.wait()
                if self.closing:
                    return
                job = self.queue.pop(0)
            try:
                self._run(job)
            except Exception as e:                      # a job never takes the worker down
                with self.lock:
                    if job.state not in STATES_DONE:
                        self._finish(job, "failed", str(e) or type(e).__name__)

    def _run(self, job: Job) -> None:
        svc = self.router.shown()
        job.state = "waiting"                           # for the cards: a chat request or a load may hold them
        turn = self.router.join(svc)
        try:
            while not self.router.wait(turn, 0.5):
                if job.cancel:
                    return self._finish(job, "cancelled", "cancelled while waiting for the cards")
            while not svc.fifo.acquire(timeout=0.5):
                if job.cancel:
                    return self._finish(job, "cancelled", "cancelled while waiting for the cards")
            try:
                if job.cancel:
                    return self._finish(job, "cancelled", "cancelled while waiting for the cards")
                job.started = time.time()
                if svc.loaded():
                    job.state = "switching"                 # the chat engine leaves the cards
                    svc.engine.unload()
                    if getattr(svc, "vision", None) is not None and hasattr(svc.vision, "unload"):
                        svc.vision.unload()
                    print("[server] chat model unloaded: the cards make images", flush=True)
                if not self._alive():
                    job.state = "starting"
                    self._start()
                self._generate(job)
            finally:
                svc.fifo.release()
        finally:
            self.router.leave(turn)

    def _generate(self, job: Job) -> None:
        p, files = job.params, self.files()
        model = MODELS[p["model"]]
        video = model.get("kind") == "video"
        slots = {k: v for k, v in files[p["model"]].items() if not k.startswith("@")}
        body = {"prompt": p["prompt"], "width": p["width"], "height": p["height"], "seed": p["seed"],
                "preview": PREVIEW_MODE, "preview_interval": 1, "output_format": "avi" if video else "png",
                "model": {"recipe": model["recipe"], "models": slots}}
        if video:                                    # one sequence: its frames, the model's frame rate, a start image
            body.update(video_frames=p["frames"], fps=model["fps"])
            if p.get("refs"):
                body["init_image"] = p["refs"][0]
        else:
            body["batch_count"] = p["count"]
        if files[p["model"]].get("@loras"):
            body["lora"] = self._loras(files[p["model"]]["@loras"])
        neg = p.get("negative_prompt") or model.get("negative_default")
        if neg:
            body["negative_prompt"] = neg
        if p.get("refs") and not video:
            body["ref_images"] = p["refs"]
        sample = {}
        send = model.get("send", True)                  # the Turbo keeps its recipe's own 8-step schedule
        steps = p.get("steps", model["steps"] if send else None)
        cfg = p.get("cfg", model["cfg"] if send else None)
        if steps is not None:
            sample["sample_steps"] = steps
        if cfg is not None:
            sample["guidance"] = {"txt_cfg": cfg}
        if sample:
            body["sample_params"] = sample
        # (soir) what sd-server reads for this job: after a change of model it reads the other model's files (~17 GB for
        # the Turbo; 3 min 15 s from a hard disk, measured) under its "preparing" stage: shown, measured, as it goes
        read0, size = _read_bytes(self.proc), self._files_size(files[p["model"]])
        code, out = self._http("POST", "/sdcpp/v1/vid_gen" if video else "/sdcpp/v1/img_gen", body)
        if code != 202 or not isinstance(out, dict) or "id" not in out:
            return self._finish(job, "failed", _remote_error(out) or f"the image server refused the job ({code})")
        job.remote, job.state = out["id"], "generating"
        self.loaded_kind = model.get("kind", "image")
        cancel_sent = False
        while True:
            time.sleep(0.5)
            if job.cancel and not cancel_sent:
                self._http("POST", f"/sdcpp/v1/jobs/{job.remote}/cancel", {})
                cancel_sent = True
            code, st = self._http("GET", f"/sdcpp/v1/jobs/{job.remote}", None)
            if code != 200 or not isinstance(st, dict):
                if not self._alive():
                    return self._finish(job, "failed", "the image server stopped during the job")
                continue
            job.progress = st.get("progress") or {}
            if job.progress.get("stage") in (None, "loading", "preparing", "conditioning"):
                now = _read_bytes(self.proc)
                if read0 is not None and now is not None and size and now - read0 >= READ_SHOWN:
                    job.progress = dict(job.progress, read_bytes=min(now - read0, size), files_bytes=size)
            pv = st.get("preview")
            if isinstance(pv, dict) and pv.get("b64_json"):
                job.preview = pv["b64_json"]
            status = st.get("status")
            if status == "completed":
                res = st.get("result") or {}
                if video:
                    try:
                        avi = base64.b64decode(res.get("b64_json") or "")
                        job.video, job.poster = self._mp4(avi)
                    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as e:
                        job.preview = None
                        return self._finish(job, "failed", f"the video could not be made MP4: {e}")
                    # with its sound: the AVI's own stream headers say it ("auds", LTX-2.3's PCM track)
                    job.video_info = {"frames": res.get("frame_count"), "fps": res.get("fps") or model["fps"],
                                      "audio": b"auds" in avi[:65536]}
                else:
                    job.images = [im.get("b64_json") for im in (res.get("images") or []) if im.get("b64_json")]
                job.preview = None
                return self._finish(job, "completed")
            if status in ("failed", "cancelled"):
                return self._finish(job, status, _remote_error(st) or status)

    def _mp4(self, avi: bytes) -> tuple[bytes, bytes | None]:
        """sd-server's AVI (MJPEG frames, and PCM sound for a model that makes it) as an MP4 every browser plays
        (H.264, AAC): ffmpeg, measured at 0.2 to 0.3 s for 33 frames, 4 to 5 times lighter; and, by the same
        call, its first frame as a JPEG (the gallery's thumbnail, whatever video the browser can read)."""
        if not avi[:4] == b"RIFF":
            raise RuntimeError("the image server gave no AVI")
        with tempfile.TemporaryDirectory(prefix="lapilli-video-") as d:
            src, dst, img = Path(d) / "in.avi", Path(d) / "out.mp4", Path(d) / "poster.jpg"
            src.write_bytes(avi)
            # "scale=out_range=tv": the MJPEG frames are full range; ffmpeg 8 keeps it in the MP4 (yuvj420p, measured)
            # where many players show it washed out or too dark: the standard range, the same colors (2 of 255 apart,
            # as the full range: the compression's), 10 % lighter
            r = subprocess.run([self.ffmpeg() or "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(src),
                                "-vf", "scale=out_range=tv", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "medium",
                                "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", str(dst),
                                "-map", "0:v:0", "-frames:v", "1", "-q:v", "3", str(img)],
                               stdin=subprocess.DEVNULL, capture_output=True, timeout=600)
            if r.returncode or not dst.is_file():
                raise RuntimeError((r.stderr or b"").decode("utf-8", "replace").strip()[-300:] or f"ffmpeg ended with {r.returncode}")
            return dst.read_bytes(), (img.read_bytes() if img.is_file() else None)

    def _files_size(self, model_files: dict) -> int:
        """The bytes of a model's files (its slots and its LoRAs): what sd-server reads when it changes to this model."""
        total = 0
        for k, v in model_files.items():
            for rel in ([f"loras/{n}" for n, _ in v] if k == "@loras" else [v]):
                try:
                    total += (Path(self.cfg.models) / rel).stat().st_size
                except OSError:
                    pass
        return total

    def _loras(self, wanted: list) -> list:
        """sd-server's own ids of these LoRA files (GET /sdapi/v1/loras: paths under its LoRA directory), never guessed."""
        code, listed = self._http("GET", "/sdapi/v1/loras", None)
        if code != 200 or not isinstance(listed, list):
            raise RuntimeError("the image server did not list its LoRAs")
        out = []
        for name, mult in wanted:
            ids = [x.get("path") for x in listed if isinstance(x, dict) and Path(str(x.get("path", ""))).name == name]
            if not ids:
                raise RuntimeError(f"the image server does not list the LoRA {name}")
            out.append({"path": ids[0], "multiplier": mult})
        return out

    # ---------------------------------------------------------------------------------------------- the process
    def _alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def _start(self) -> None:
        """sd-server on 127.0.0.1, one card, no peer access, its working set capped from its start (Windows)."""
        env = dict(os.environ)
        env.pop("GGML_CUDA_P2P", None)
        env["CUDA_VISIBLE_DEVICES"] = str(self.cfg.card)
        head = list(self.cfg.server) if isinstance(self.cfg.server, (list, tuple)) else [self.cfg.server]
        args = head + ["--model-dir", self.cfg.models, "--listen-ip", "127.0.0.1",
                       "--listen-port", str(self.cfg.port), "-W", "1024", "-H", "1024"]
        log = self.cfg.log or os.path.join(os.path.dirname(os.path.abspath(self.cfg.models)), "sd-server.log")
        self.server_state = "starting"
        self.loaded_kind = None
        with open(log, "ab") as out:
            self.proc = lifeline.popen(args, env=env, stdout=out, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
        _cap(self.proc, self.cfg.cap_gib)
        deadline = time.time() + 60
        while time.time() < deadline:
            if not self._alive():
                self.server_state = "stopped"
                raise RuntimeError(f"the image server stopped at start (exit code {self.proc.poll()}, log {log})")
            code, _ = self._http("GET", "/sdcpp/v1/capabilities", None, timeout=2)
            if code == 200:
                self.server_state = "ready"
                print(f"[server] image server ready on 127.0.0.1:{self.cfg.port} (card {self.cfg.card})", flush=True)
                return
            time.sleep(0.5)
        self.stop()
        raise RuntimeError("the image server did not answer within 60 s")

    def stop(self) -> None:
        """Stop sd-server (its exact process); the cards are the chat engine's again."""
        p = self.proc
        if p is None or p.poll() is not None:
            self.server_state = "stopped"
            return
        p.terminate()
        try:
            p.wait(timeout=30)
        except Exception:
            p.kill()
            p.wait(timeout=10)
        self.server_state = "stopped"
        print("[server] image server stopped: the cards are the chat model's", flush=True)

    def release_gpu(self) -> None:
        """Service.ensure_loaded, before the chat engine loads: free the card (the caller holds the fifo, so no job runs)."""
        if self._alive():
            self.stop()

    def close(self) -> None:
        with self.lock:
            self.closing = True
            for job in self.queue:
                self._finish(job, "cancelled", "the server is stopping")
            self.queue.clear()
            self.wake.notify_all()
        self.stop()

    def _http(self, method: str, path: str, body, timeout: float = 30):
        url = f"http://127.0.0.1:{self.cfg.port}{path}"
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"} if data else {})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"null")
            except ValueError:
                return e.code, None
        except (OSError, ValueError):
            return 0, None


def _remote_error(obj) -> str | None:
    if not isinstance(obj, dict):
        return None
    err = obj.get("error")
    if isinstance(err, dict):
        return err.get("message") or err.get("code")
    return err if isinstance(err, str) else None


def _read_bytes(proc) -> int | None:
    """The bytes this process has read so far, or None. sd-server reads its model files (it maps them only with --mmap, which
    Lapilli does not pass): Windows, GetProcessIoCounters (ReadTransferCount); Linux, /proc/<pid>/io (rchar)."""
    if proc is None or proc.poll() is not None:
        return None
    try:
        if os.name == "nt":
            import ctypes

            class IoCounters(ctypes.Structure):
                _fields_ = [(n, ctypes.c_ulonglong) for n in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
                                                             "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]
            io = IoCounters()
            if not ctypes.windll.kernel32.GetProcessIoCounters(ctypes.c_void_p(int(proc._handle)), ctypes.byref(io)):
                return None
            return int(io.ReadTransferCount)
        for line in Path(f"/proc/{proc.pid}/io").read_text().splitlines():
            if line.startswith("rchar:"):
                return int(line.split()[1])
    except (OSError, ValueError, AttributeError):
        return None
    return None


def _cap(proc, gib: int, what: str = "image server") -> None:
    """Windows: a hard cap of the process's working set (the machine's RAM is shared); elsewhere nothing."""
    if os.name != "nt" or proc is None:
        return
    import ctypes
    k32 = ctypes.windll.kernel32
    ok = k32.SetProcessWorkingSetSizeEx(ctypes.c_void_p(int(proc._handle)), ctypes.c_size_t(64 << 20),
                                        ctypes.c_size_t(int(gib) << 30), 0x2 | 0x4)
    print(f"[server] {what} working set cap {gib} GiB: {'set' if ok else 'NOT set'}", flush=True)
