"""(Lapilli, V100) Images beside the chat (serve/images.py): the checks of a request, OpenAI's request, and the switch
of the cards against a stand-in sd-server run as a real process (fixtures/fake_sd_server.py): a job unloads the chat
engine and starts the image server, a chat load afterwards stops it first; what sd-server is asked (the recipe, the
catalog files, the Turbo's own schedule kept, the base's steps and guidance); a cancel; the HTTP routes."""
from __future__ import annotations

import base64
import os
import http.client
import json
import socket
import sys
import subprocess
import tempfile
import time
import unittest
from unittest import mock
from pathlib import Path

from serve.frontend import ChatTemplate
from serve.handler import serve
from serve.images import AREA_MAX, Images, ImagesConfig, ImagesError, check, openai_params
from serve.router import Router
from serve.service import Service
from serve.tests.test_lifecycle import ResidentEngine
from serve.util.text import ByteTokenizer

ROOT = Path(__file__).resolve().parents[2]
FAKE = Path(__file__).resolve().parent / "fixtures" / "fake_sd_server.py"
QWEN = ROOT / "serve/chat_template.jinja"
REF = "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"0" * 64).decode()


def png_url(w: int, h: int) -> str:
    """A real PNG of w×h (gray), as a data: URL: the edit model reads the size of its references from their header."""
    import struct
    import zlib

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
    rows = b"".join(b"\x00" + b"\x80" * w for _ in range(h))
    raw = chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b"")
    return "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\n" + raw).decode()


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


EDIT_2511 = ("diffusion_models/qwen-image-edit-2511-Q8_0.gguf", "text_encoders/Qwen2.5-VL-7B-Instruct.Q8_0.gguf",
             "text_encoders/Qwen2.5-VL-7B-Instruct.mmproj-f16.gguf", "vae/qwen_image_vae.safetensors")


WAN22 = ("diffusion_models/Wan2.2-TI2V-5B-Q8_0.gguf", "text_encoders/umt5-xxl-encoder-Q8_0.gguf", "vae/wan2.2_vae.safetensors")
# LTX-2.3 Distilled: the 1.0 model sits beside the 1.1 (the catalog takes the 1.1), Gemma 3 12B and its mmproj beside it
LTX23 = ("diffusion_models/ltx-2.3-22b-distilled-Q8_0.gguf", "diffusion_models/ltx-2.3-22b-distilled-1.1-Q8_0.gguf",
         "text_encoders/gemma-3-12b-it-Q8_0.gguf", "text_encoders/ltx-2.3-22b-distilled_embeddings_connectors.safetensors",
         "vae/ltx-2.3-22b-distilled_video_vae.safetensors", "vae/ltx-2.3-22b-distilled_audio_vae.safetensors")
# ffmpeg for the video tests: LAPILLI_TEST_FFMPEG, or the one on the PATH
FFMPEG = os.environ.get("LAPILLI_TEST_FFMPEG") or __import__("shutil").which("ffmpeg")


def models_dir(root: Path, vision: bool = True, edit: bool = False, video: bool = False, ltx: bool = False) -> Path:
    m = root / "modeles"
    for rel in ("diffusion_models/qwen_image_2.1-Q8_0.gguf", "diffusion_models/qwen_image_2.1_turbo-Q8_0.gguf",
                "text_encoders/Qwen3VL-8B-Instruct-Q8_0.gguf", "vae/qwen_image_2.1_vae_bf16.safetensors") + \
            (("text_encoders/mmproj-Qwen3VL-8B-Instruct-F16.gguf",) if vision else ()) + (EDIT_2511 if edit else ()) + \
            (WAN22 if video else ()) + (LTX23 if ltx else ()):
        (m / rel).parent.mkdir(parents=True, exist_ok=True)
        (m / rel).write_bytes(b"x")
    return m


class Checks(unittest.TestCase):
    def test_a_good_request(self):
        p = check({"prompt": "a fox", "width": 1024, "height": 768, "seed": 7, "count": 2, "refs": [REF]})
        self.assertEqual((p["model"], p["width"], p["height"], p["seed"], p["count"], len(p["refs"])), ("turbo", 1024, 768, 7, 2, 1))

    def test_what_is_refused(self):
        for req, word in (({"prompt": " "}, "prompt"), ({"prompt": "x" * 4001}, "prompt"), ({"prompt": "a", "model": "sdxl"}, "model"),
                          ({"prompt": "a", "width": 1000}, "width"), ({"prompt": "a", "height": 128}, "height"),
                          ({"prompt": "a", "width": 2816, "height": 2816}, "size"), ({"prompt": "a", "steps": 0}, "steps"),
                          ({"prompt": "a", "cfg": 21}, "cfg"), ({"prompt": "a", "seed": -2}, "seed"),
                          ({"prompt": "a", "count": 5}, "count"), ({"prompt": "a", "refs": [REF] * 5}, "refs"),
                          ({"prompt": "a", "refs": ["http://example.org/a.png"]}, "refs[0]"),
                          ({"prompt": "a", "refs": ["data:image/png;base64,@@@"]}, "refs[0]"),
                          ({"prompt": "a", "width": True}, "width")):
            with self.subTest(req=str(req)[:60]):
                with self.assertRaisesRegex(ImagesError, "^" + word.replace("[", r"\[").replace("]", r"\]")):
                    check(req)

    def test_the_largest_sizes_of_the_model_card_pass(self):
        for w, h in ((2048, 2048), (2400, 1792), (2752, 1536), (1536, 2752), (2528, 1696)):
            self.assertLessEqual(w * h, AREA_MAX)
            check({"prompt": "a", "width": w, "height": h})

    def test_openai_request(self):
        p = openai_params({"prompt": "a fox", "size": "1536x1024", "n": 2})
        self.assertEqual((p["width"], p["height"], p["count"], p["model"]), (1536, 1024, 2, "turbo"))
        self.assertEqual(openai_params({"prompt": "a", "model": "qwen-image-2.1"})["model"], "base")
        self.assertEqual(openai_params({"prompt": "a", "model": "qwen-image-edit-2511"})["model"], "edit-2511")
        with self.assertRaisesRegex(ImagesError, "response_format"):
            openai_params({"prompt": "a", "response_format": "url"})
        with self.assertRaisesRegex(ImagesError, "size"):
            openai_params({"prompt": "a", "size": "big"})


class Switch(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.log = root / "fake.jsonl"
        self.models = models_dir(root)
        import os
        self._env = os.environ.get("FAKE_SD_LOG")
        os.environ["FAKE_SD_LOG"] = str(self.log)
        os.environ["GGML_CUDA_P2P"] = "1"                  # the image server must not see it
        tok = ByteTokenizer()
        self.engine = ResidentEngine(tok)
        self.engine.restart = lambda tries=1, e=self.engine: ResidentEngine.restart(e)
        self.engine.restart()
        self.svc = Service(self.engine, tok, ChatTemplate.from_file(QWEN), model_name="chat")
        self.router = Router([self.svc])
        # the base interpreter: a venv's python.exe on Windows only LAUNCHES it, as a child (its reads would not be the
        # process's own, as sd-server.exe's are)
        self.images = Images(ImagesConfig(server=[getattr(sys, "_base_executable", sys.executable), str(FAKE)], models=str(self.models), card=1,
                                          port=free_port(), log=str(root / "sd.log"), ffmpeg=FFMPEG), self.router)
        self.svc.release_gpu = self.images.release_gpu

    def tearDown(self):
        import os
        self.images.close()
        os.environ.pop("GGML_CUDA_P2P", None)
        if self._env is None:
            os.environ.pop("FAKE_SD_LOG", None)
        else:
            os.environ["FAKE_SD_LOG"] = self._env
        self.tmp.cleanup()

    def notes(self):
        return [json.loads(l) for l in self.log.read_text(encoding="utf-8").splitlines()] if self.log.exists() else []

    def run_job(self, **req):
        job = self.images.submit(check({"prompt": "a fox", **req}))
        self.assertTrue(self.images.wait(job, 60), job.view(with_images=False))
        return job

    def test_a_job_unloads_the_chat_then_a_chat_load_stops_the_image_server(self):
        self.assertTrue(self.engine.alive())
        job = self.run_job()
        self.assertEqual(job.state, "completed", job.error)
        self.assertEqual(len(job.images), 1)
        self.assertFalse(self.engine.alive())               # the chat engine left the cards
        self.assertEqual(self.engine.closes, 1)
        self.assertTrue(self.images._alive())
        start = next(n for n in self.notes() if "argv" in n)
        self.assertEqual((start["cuda_visible_devices"], start["ggml_cuda_p2p"]), ("1", False))
        self.assertIn("127.0.0.1", start["argv"])
        with self.svc.fifo:                                 # a chat request: the image server goes, the engine comes back
            self.svc.ensure_loaded()
        self.assertFalse(self.images._alive())
        self.assertTrue(self.engine.alive())
        self.assertEqual(self.engine.starts, 2)

    def test_what_sd_server_is_asked(self):
        self.run_job()
        turbo = [n["img_gen"] for n in self.notes() if "img_gen" in n][-1]
        self.assertEqual(turbo["model"]["recipe"], "qwen-image-21-turbo")
        self.assertEqual(turbo["model"]["models"], {"diffusion_model": "diffusion_models/qwen_image_2.1_turbo-Q8_0.gguf",
                                                    "llm": "text_encoders/Qwen3VL-8B-Instruct-Q8_0.gguf",
                                                    "llm_vision": "text_encoders/mmproj-Qwen3VL-8B-Instruct-F16.gguf",
                                                    "vae": "vae/qwen_image_2.1_vae_bf16.safetensors"})
        self.assertNotIn("sample_params", turbo)            # the Turbo keeps its recipe's fixed 8-step schedule
        self.assertEqual((turbo["preview"], turbo["output_format"], turbo["width"]), ("proj", "png", 1024))
        self.run_job(model="base", refs=[REF], negative_prompt="blurry")
        base = [n["img_gen"] for n in self.notes() if "img_gen" in n][-1]
        self.assertEqual(base["model"]["recipe"], "qwen-image-21")
        self.assertEqual(base["model"]["models"]["diffusion_model"], "diffusion_models/qwen_image_2.1-Q8_0.gguf")
        self.assertEqual(base["sample_params"], {"sample_steps": 40, "guidance": {"txt_cfg": 6.0}})
        self.assertEqual((base["ref_images"], base["negative_prompt"]), ([REF], "blurry"))

    def test_a_cancel_reaches_sd_server(self):
        job = self.images.submit(check({"prompt": "a fox"}))
        deadline = time.time() + 30
        while job.state != "generating" and time.time() < deadline:
            time.sleep(0.05)
        self.images.cancel(job.id)
        self.assertTrue(self.images.wait(job, 30))
        self.assertEqual(job.state, "cancelled")
        self.assertTrue(any("cancel" in n for n in self.notes()))

    def test_each_model_takes_its_own_files(self):
        """The Edit 2511 files sort BEFORE the 2.1's ("qwen-image-edit" < "qwen_image_2.1", "Qwen2.5" < "Qwen3VL"):
        the first version picked files by sort order and would have given the 2.1 models the edit model and its encoder."""
        models_dir(Path(self.tmp.name), edit=True)
        f = self.images.files()
        self.assertEqual(f["base"], {"diffusion_model": "diffusion_models/qwen_image_2.1-Q8_0.gguf",
                                     "llm": "text_encoders/Qwen3VL-8B-Instruct-Q8_0.gguf",
                                     "llm_vision": "text_encoders/mmproj-Qwen3VL-8B-Instruct-F16.gguf",
                                     "vae": "vae/qwen_image_2.1_vae_bf16.safetensors"})
        self.assertEqual(f["turbo"]["diffusion_model"], "diffusion_models/qwen_image_2.1_turbo-Q8_0.gguf")
        self.assertEqual(f["edit-2511"], {"diffusion_model": "diffusion_models/qwen-image-edit-2511-Q8_0.gguf",
                                          "llm": "text_encoders/Qwen2.5-VL-7B-Instruct.Q8_0.gguf",
                                          "llm_vision": "text_encoders/Qwen2.5-VL-7B-Instruct.mmproj-f16.gguf",
                                          "vae": "vae/qwen_image_vae.safetensors"})
        st = self.images.state()["models"]
        self.assertEqual(list(st), ["turbo", "base", "edit-2511-lightning", "edit-2511", "wan22-5b", "ltx23"])   # the page's order
        self.assertFalse(st["edit-2511-lightning"]["available"])           # its LoRA is not in loras/ here
        self.assertEqual((st["edit-2511"]["refs"], st["edit-2511"]["steps"], st["edit-2511"]["cfg"], st["turbo"]["fixed"]),
                         ("required", 20, 4.0, True))
        self.assertEqual((st["edit-2511"]["refs_area_max"], st["edit-2511"]["area_max"], st["turbo"]["refs_area_max"]), (768 * 768, 1024 * 1024, None))

    def test_the_edit_model_edits(self):
        models_dir(Path(self.tmp.name), edit=True)
        with self.assertRaisesRegex(ImagesError, "^refs: the Qwen Image Edit 2511 model edits images"):
            self.images.submit(check({"prompt": "make it night", "model": "edit-2511"}))
        ref768 = png_url(768, 768)
        job = self.run_job(model="edit-2511", refs=[ref768])            # 768×768: the largest reference it reads right
        self.assertEqual(job.state, "completed", job.error)
        body = [n["img_gen"] for n in self.notes() if "img_gen" in n][-1]
        self.assertEqual(body["model"]["recipe"], "qwen-image-edit-2511")
        self.assertEqual(body["model"]["models"]["llm"], "text_encoders/Qwen2.5-VL-7B-Instruct.Q8_0.gguf")
        self.assertEqual(body["sample_params"], {"sample_steps": 20, "guidance": {"txt_cfg": 4.0}})
        self.assertEqual(body["ref_images"], [ref768])

    def test_the_edit_model_reads_its_references_small_enough(self):
        """(measured) sd.cpp gives the vision encoder each reference at its own size: beyond ~0.6 megapixels in all the
        edits drift (896×896 a wrong sign, 1024×1024 a drawing, on the GPU as on the CPU; two of 768×768, the instruction
        ignored). The references together: 768×768 at most, refused beyond with the reason; the output ~1 megapixel at most."""
        models_dir(Path(self.tmp.name), edit=True)
        with self.assertRaisesRegex(ImagesError, r"^refs: the Qwen Image Edit 2511 model reads its reference images together at up "
                                                 r"to 0\.59 megapixels here, 0\.80 sent: make them smaller$"):
            self.images.submit(check({"prompt": "night", "model": "edit-2511", "refs": [png_url(896, 896)]}))
        with self.assertRaisesRegex(ImagesError, r"^refs: .* 0\.59 megapixels here, 0\.60 sent"):      # two that fit alone
            self.images.submit(check({"prompt": "night", "model": "edit-2511", "refs": [png_url(544, 544), png_url(544, 560)]}))
        with self.assertRaisesRegex(ImagesError, "^size: the Qwen Image Edit 2511 model makes images of 1.0 megapixels at most"):
            self.images.submit(check({"prompt": "night", "model": "edit-2511", "width": 1376, "height": 1024, "refs": [png_url(256, 256)]}))
        with self.assertRaisesRegex(ImagesError, r"^refs\[1\]: the size of this image could not be read"):
            self.images.submit(check({"prompt": "night", "model": "edit-2511", "refs": [png_url(256, 256), REF]}))
        two = self.run_job(model="edit-2511", width=1024, height=768, refs=[png_url(528, 528), png_url(528, 528)])
        self.assertEqual(two.state, "completed", two.error)                 # 2 × 278,784 pixels: read right (measured)

    def test_a_model_with_a_lora(self):
        """A model may name LoRAs (an acceleration such as Lightning): offered only with its file, sent by the id
        sd-server lists for it, with its own fixed schedule (8 steps, guidance 1) sent too."""
        from serve import images as im
        models_dir(Path(self.tmp.name), edit=True)
        im.MODELS["edit-fast"] = {**im.MODELS["edit-2511"], "label": "Edit fast", "steps": 8, "cfg": 1.0, "fixed": True,
                                  "loras": [{"file": "loras/Lightning-8steps*.safetensors", "multiplier": 1.0}]}
        try:
            self.assertNotIn("edit-fast", self.images.files())          # its LoRA is not there yet
            (self.models / "loras").mkdir()
            (self.models / "loras/Lightning-8steps-V1.0-bf16.safetensors").write_bytes(b"x")
            self.assertTrue(self.images.state()["models"]["edit-fast"]["fast"])
            job = self.run_job(model="edit-fast", refs=[png_url(512, 512)])
            self.assertEqual(job.state, "completed", job.error)
            body = [n["img_gen"] for n in self.notes() if "img_gen" in n][-1]
            self.assertEqual(body["lora"], [{"path": "Lightning-8steps-V1.0-bf16.safetensors", "multiplier": 1.0}])
            self.assertEqual(body["sample_params"], {"sample_steps": 8, "guidance": {"txt_cfg": 1.0}})
            self.assertNotIn("@loras", body["model"]["models"])
        finally:
            del im.MODELS["edit-fast"]

    def test_a_change_of_model_says_what_it_reads(self):
        """(soir) after Edit 2511, the Turbo's first image waited 3 min 15 s under "preparing": sd-server read the
        Turbo's files from the hard disk. The job says it, measured: the bytes read for it, and the bytes of its files."""
        import serve.images as im
        for rel in ("diffusion_models/qwen_image_2.1_turbo-Q8_0.gguf", "text_encoders/Qwen3VL-8B-Instruct-Q8_0.gguf"):
            (self.models / rel).write_bytes(os.urandom(3 << 20))
        size = sum(f.stat().st_size for f in (self.models / r for r in (
            "diffusion_models/qwen_image_2.1_turbo-Q8_0.gguf", "text_encoders/Qwen3VL-8B-Instruct-Q8_0.gguf",
            "text_encoders/mmproj-Qwen3VL-8B-Instruct-F16.gguf", "vae/qwen_image_2.1_vae_bf16.safetensors")))
        seen = []
        with mock.patch.object(im, "READ_SHOWN", 1 << 20):
            for _ in range(2):                              # the first image reads the files; the second, same model, does not
                job = self.images.submit(check({"prompt": "a fox"}))
                marks = []
                while not self.images.wait(job, 0.05):
                    pr = dict(job.progress)
                    if "read_bytes" in pr:
                        marks.append((pr["stage"], pr["read_bytes"], pr["files_bytes"]))
                self.assertEqual(job.state, "completed", job.error)
                seen.append(marks)
        self.assertTrue(seen[0], "no reading shown for the first image")
        self.assertEqual({(st, fb) for st, _, fb in seen[0]}, {("preparing", size)})
        self.assertGreaterEqual(max(rb for _, rb, _ in seen[0]), 3 << 20)
        self.assertLessEqual(max(rb for _, rb, _ in seen[0]), size)
        self.assertEqual(seen[1], [])

    @unittest.skipUnless(FFMPEG, "ffmpeg is needed for the video tests (LAPILLI_TEST_FFMPEG)")
    def test_a_video_job(self):
        """Wan 2.2 TI2V-5B: sd-server's vid_gen with its frames, 24 frames a second, the start image as init_image,
        the AVI it gives (MJPEG) made MP4 by ffmpeg, the job telling its frames and frame rate."""
        models_dir(Path(self.tmp.name), video=True)
        st = self.images.state()["models"]["wan22-5b"]
        self.assertEqual((st["available"], st["kind"], st["fps"], st["frames_max"], st["frames_step"], st["refs_max"]),
                         (True, "video", 24, 121, 4, 1))
        debut = png_url(832, 480)
        job = self.run_job(model="wan22-5b", width=832, height=480, frames=33, refs=[debut])
        self.assertEqual(job.state, "completed", job.error)
        body = [n["vid_gen"] for n in self.notes() if "vid_gen" in n][-1]
        self.assertEqual((body["model"]["recipe"], body["video_frames"], body["fps"], body["output_format"], body["init_image"]),
                         ("wan22-ti2v-5b", 33, 24, "avi", debut))
        self.assertNotIn("ref_images", body)
        self.assertNotIn("batch_count", body)
        self.assertEqual(body["sample_params"], {"sample_steps": 20, "guidance": {"txt_cfg": 5.0}})
        self.assertTrue(body["negative_prompt"].startswith("色调艳丽，过曝，静态"))   # Wan's own, none being given
        self.assertEqual(len(body["negative_prompt"]), 137)
        self.assertEqual(job.video[4:8], b"ftyp")                       # an MP4
        self.assertEqual(job.poster[:3], b"\xff\xd8\xff")                 # its first frame, a JPEG
        # H.264 in the standard range (the MJPEG frames are full range: many players show that washed out)
        probe = Path(FFMPEG).with_name("ffprobe" + Path(FFMPEG).suffix)
        if probe.is_file():
            with tempfile.TemporaryDirectory() as d:
                (Path(d) / "v.mp4").write_bytes(job.video)
                out = subprocess.run([str(probe), "-v", "error", "-select_streams", "v:0", "-show_entries",
                                      "stream=codec_name,pix_fmt,color_range", "-of", "compact=p=0", str(Path(d) / "v.mp4")],
                                     capture_output=True, text=True, timeout=60).stdout.strip()
            self.assertEqual(out, "codec_name=h264|pix_fmt=yuv420p|color_range=tv")
        v = job.view(with_images=False)
        self.assertEqual((v["kind"], v["video"]["frames"], v["video"]["fps"], v["video"]["mime"], v["video"]["bytes"],
                          v["video"]["poster"]), ("video", 5, 24, "video/mp4", len(job.video), len(job.poster)))
        self.assertEqual(job.images, [])
        self.assertEqual((st["negative_default"], st["decode_us_per_px"]), (True, 2.2))
        # a negative prompt given is sent as it is
        job = self.run_job(model="wan22-5b", width=832, height=480, frames=9, negative_prompt="blurry, static")
        self.assertEqual(job.state, "completed", job.error)
        body = [n["vid_gen"] for n in self.notes() if "vid_gen" in n][-1]
        self.assertEqual((body["negative_prompt"], body["video_frames"]), ("blurry, static", 9))
        self.assertNotIn("init_image", body)
        # an image model has no default negative prompt
        self.assertFalse(self.images.state()["models"]["turbo"]["negative_default"])
        # the pill's "Video model loaded": the kind of the last model the image server ran, none once it stops
        self.assertEqual(self.images.summary()["loaded"], "video")
        self.assertEqual(self.run_job().state, "completed")             # a Turbo image after it
        self.assertEqual(self.images.summary()["loaded"], "image")
        self.images.release_gpu()
        self.assertIsNone(self.images.summary()["loaded"])

    @unittest.skipUnless(FFMPEG, "ffmpeg is needed for the video tests (LAPILLI_TEST_FFMPEG)")
    def test_an_ltx_video_with_its_sound(self):
        """LTX-2.3 Distilled 1.1: sd-server's recipe ltx23-distilled with its five files (the 1.1 model, not the 1.0
        beside it; Gemma, not its mmproj), no steps nor guidance sent (the recipe's 8 and 1), 24 frames a second; its AVI's sound
        kept in the MP4 (AAC) and told by the job."""
        root = Path(self.tmp.name)
        models_dir(root, video=True, ltx=True)
        (root / "modeles" / "text_encoders" / "gemma-3-12b-it-mmproj-F16.gguf").write_bytes(b"x")
        st = self.images.state()["models"]["ltx23"]
        self.assertEqual((st["available"], st["kind"], st["fps"], st["frames_step"], st["fixed"], st["audio"], st["decode_us_per_px"]),
                         (True, "video", 24, 8, True, True, 0.32))
        self.assertEqual(list(self.images.state()["models"])[-2:], ["wan22-5b", "ltx23"])
        job = self.run_job(model="ltx23", width=768, height=512, frames=121)
        self.assertEqual(job.state, "completed", job.error)
        body = [n["vid_gen"] for n in self.notes() if "vid_gen" in n][-1]
        self.assertEqual((body["model"]["recipe"], body["video_frames"], body["fps"]), ("ltx23-distilled", 121, 24))
        self.assertEqual(body["model"]["models"], {
            "diffusion_model": "diffusion_models/ltx-2.3-22b-distilled-1.1-Q8_0.gguf", "llm": "text_encoders/gemma-3-12b-it-Q8_0.gguf",
            "embeddings_connectors": "text_encoders/ltx-2.3-22b-distilled_embeddings_connectors.safetensors",
            "vae": "vae/ltx-2.3-22b-distilled_video_vae.safetensors", "audio_vae": "vae/ltx-2.3-22b-distilled_audio_vae.safetensors"})
        self.assertNotIn("sample_params", body)                 # the recipe's own 8 steps, guidance 1
        self.assertNotIn("negative_prompt", body)               # no default (guidance 1 makes no negative pass)
        self.assertEqual(job.view(with_images=False)["video"]["audio"], True)
        probe = Path(FFMPEG).with_name("ffprobe" + Path(FFMPEG).suffix)
        if probe.is_file():
            with tempfile.TemporaryDirectory() as d:
                (Path(d) / "v.mp4").write_bytes(job.video)
                out = subprocess.run([str(probe), "-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "compact=p=0",
                                      str(Path(d) / "v.mp4")], capture_output=True, text=True, timeout=60).stdout.split()
            self.assertEqual(sorted(out), ["codec_name=aac|codec_type=audio", "codec_name=h264|codec_type=video"])
        # Wan 2.2's video has no sound, and says so
        job = self.run_job(model="wan22-5b", width=832, height=480, frames=9)
        self.assertEqual((job.state, job.view(with_images=False)["video"]["audio"]), ("completed", False))
        # its frames go by 8
        with self.assertRaisesRegex(ImagesError, r"^frames: from 9 to 121, one more than a multiple of 8"):
            check({"prompt": "a storm", "model": "ltx23", "frames": 33 + 4})
        self.assertEqual(check({"prompt": "a storm", "model": "ltx23", "frames": 49})["frames"], 49)

    def test_the_video_checks(self):
        """A video: 1 + 4k frames up to 121, one at a time, one start image at most, 1280×704 at most."""
        for req, motif in (({"frames": 34}, r"^frames: from 5 to 121, one more than a multiple of 4"),
                           ({"frames": 125}, r"^frames: from 5 to 121"), ({"frames": True}, r"^frames"),
                           ({"count": 2}, r"^count: a video is made one at a time"),
                           ({"refs": [REF, REF]}, r"^refs: one start image at most")):
            with self.subTest(req=str(req)[:40]):
                with self.assertRaisesRegex(ImagesError, motif):
                    check({"prompt": "a fox", "model": "wan22-5b", **req})
        self.assertEqual(check({"prompt": "a fox", "model": "wan22-5b"})["frames"], 49)     # 2 s at 24 frames a second
        models_dir(Path(self.tmp.name), video=True)
        if FFMPEG:
            with self.assertRaisesRegex(ImagesError, "^size: the Wan 2.2 Video model makes videos of 0.9 megapixels at most"):
                self.images.submit(check({"prompt": "a fox", "model": "wan22-5b", "width": 1376, "height": 768}))

    def test_a_video_model_needs_ffmpeg(self):
        """Without ffmpeg the page could not play sd-server's AVI: the video model is not offered."""
        models_dir(Path(self.tmp.name), video=True)
        self.images.cfg.ffmpeg = None
        self.assertFalse(self.images.state()["models"]["wan22-5b"]["available"])
        self.images.cfg.ffmpeg = str(Path(self.tmp.name) / "absent" / "ffmpeg.exe")
        self.assertFalse(self.images.state()["models"]["wan22-5b"]["available"])

    def test_edit_2511_lightning(self):
        """The same files as Edit 2511, with lightx2v's Lightning LoRA: 8 steps and guidance 1 sent, the LoRA by
        sd-server's own id; offered only with its LoRA file."""
        models_dir(Path(self.tmp.name), edit=True)
        (self.models / "loras").mkdir()
        (self.models / "loras/Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors").write_bytes(b"x")
        self.assertTrue(self.images.state()["models"]["edit-2511-lightning"]["available"])
        job = self.run_job(model="edit-2511-lightning", refs=[png_url(768, 768)])
        self.assertEqual(job.state, "completed", job.error)
        body = [n["img_gen"] for n in self.notes() if "img_gen" in n][-1]
        self.assertEqual((body["model"]["recipe"], body["model"]["models"]["diffusion_model"]),
                         ("qwen-image-edit-2511", "diffusion_models/qwen-image-edit-2511-Q8_0.gguf"))
        self.assertEqual(body["lora"], [{"path": "Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors", "multiplier": 1.0}])
        self.assertEqual(body["sample_params"], {"sample_steps": 8, "guidance": {"txt_cfg": 1.0}})

    def test_an_edit_model_without_its_vision_projector_is_not_offered(self):
        models_dir(Path(self.tmp.name), edit=True)
        (self.models / "text_encoders/Qwen2.5-VL-7B-Instruct.mmproj-f16.gguf").unlink()
        self.assertNotIn("edit-2511", self.images.files())
        self.assertFalse(self.images.state()["models"]["edit-2511"]["available"])
        self.assertTrue(self.images.state()["models"]["base"]["available"])

    def test_editing_needs_the_vision_projector(self):
        (self.models / "text_encoders/mmproj-Qwen3VL-8B-Instruct-F16.gguf").unlink()
        with self.assertRaisesRegex(ImagesError, "vision projector"):
            self.images.submit(check({"prompt": "a", "refs": [REF]}))
        self.assertFalse(self.images.state()["models"]["turbo"]["edit"])


class Routes(Switch):
    def setUp(self):
        super().setUp()
        self.router.images = self.images
        self.httpd = serve(self.router, port=0)
        self.port = self.httpd.server_address[1]

    def tearDown(self):
        self.router.stop()
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def call(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        try:
            c.request(method, path, json.dumps(body) if body is not None else None,
                      {"Content-Type": "application/json", **(headers or {})})
            r = c.getresponse()
            return r.status, json.loads(r.read() or b"null")
        finally:
            c.close()

    @unittest.skipUnless(FFMPEG, "ffmpeg is needed for the video tests (LAPILLI_TEST_FFMPEG)")
    def test_the_video_route(self):
        """GET /api/images/jobs/{id}/video: the MP4 itself (video/mp4, its length), 404 for a job without one."""
        models_dir(Path(self.tmp.name), video=True)
        code, j = self.call("POST", "/api/images/jobs", {"prompt": "a fox", "model": "wan22-5b", "width": 832, "height": 480, "frames": 9})
        self.assertEqual(code, 202, j)
        job = self.images.get(j["id"])
        self.assertTrue(self.images.wait(job, 60))
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=60)
        try:
            c.request("GET", f"/api/images/jobs/{j['id']}/video")
            r = c.getresponse()
            data = r.read()
            self.assertEqual((r.status, r.getheader("Content-Type"), int(r.getheader("Content-Length"))), (200, "video/mp4", len(data)))
            self.assertEqual(data, job.video)
            c.request("GET", f"/api/images/jobs/{j['id']}/poster")
            r = c.getresponse()
            data = r.read()
            self.assertEqual((r.status, r.getheader("Content-Type"), data), (200, "image/jpeg", job.poster))
        finally:
            c.close()
        code, st = self.call("GET", f"/api/images/jobs/{j['id']}?images=0")
        self.assertEqual((code, st["kind"], st["video"]["mime"]), (200, "video/mp4"[:0] or "video", "video/mp4"))
        code, err = self.call("GET", "/api/images/jobs/img-0-0/video")
        self.assertEqual((code, err["error"]["message"]), (404, "no video for this job"))
        code, err = self.call("GET", "/api/images/jobs/img-0-0/poster")
        self.assertEqual((code, err["error"]["message"]), (404, "no poster for this job"))

    def test_the_page_routes(self):
        code, st = self.call("GET", "/api/images")
        self.assertEqual((code, st["configured"], st["models"]["turbo"]["available"], st["models"]["base"]["steps"]), (200, True, True, 40))
        code, job = self.call("POST", "/api/images/jobs", {"prompt": "a fox", "width": 512, "height": 512})
        deadline = time.time() + 30
        while job["state"] != "generating" and time.time() < deadline:   # a job with a preview, then stopped: it keeps it
            time.sleep(0.05)
            code, job = self.call("GET", f"/api/images/jobs/{job['id']}?images=0")
        while not job.get("preview") and time.time() < deadline:
            time.sleep(0.1)
            code, job = self.call("GET", f"/api/images/jobs/{job['id']}?images=0")
        self.call("POST", f"/api/images/jobs/{job['id']}/cancel", {})
        while job["state"] != "cancelled" and time.time() < deadline:
            time.sleep(0.1)
            code, job = self.call("GET", f"/api/images/jobs/{job['id']}?images=0")
        self.assertEqual(job["state"], "cancelled")
        self.assertTrue(job["preview"])                     # the page shows it behind "Stopped"
        code, st = self.call("GET", "/api/images")
        self.assertNotIn("preview", st["jobs"][0])          # the list stays light
        code, job = self.call("POST", "/api/images/jobs", {"prompt": "a fox", "width": 512, "height": 512})
        self.assertEqual(code, 202, job)
        deadline = time.time() + 60
        while job["state"] not in ("completed", "failed", "cancelled") and time.time() < deadline:
            time.sleep(0.2)
            code, job = self.call("GET", f"/api/images/jobs/{job['id']}?images=0")
        self.assertEqual(job["state"], "completed", job)
        self.assertNotIn("images", job)
        code, full = self.call("GET", f"/api/images/jobs/{job['id']}")
        self.assertEqual(len(full["images"]), 1)
        code, err = self.call("POST", "/api/images/jobs", {"prompt": "a fox", "width": 1000})
        self.assertEqual(code, 400, err)
        code, err = self.call("POST", "/api/images/jobs", {"prompt": "a"}, {"Origin": "http://evil.example"})
        self.assertEqual(code, 403, err)

    def test_metrics_tell_what_the_cards_make(self):
        code, m = self.call("GET", "/metrics")
        self.assertEqual((code, m["images"]), (200, {"server": "stopped", "job": None, "queued": 0, "loaded": None}))
        job = self.images.submit(check({"prompt": "a fox"}))
        seen, deadline = None, time.time() + 30
        while seen is None and time.time() < deadline:
            code, m = self.call("GET", "/metrics")
            j = m["images"]["job"]
            if j and j["state"] == "generating" and j["progress"].get("stage") == "sampling":
                seen = j
            time.sleep(0.05)
        self.assertIsNotNone(seen, "no generating job seen in /metrics")
        self.assertEqual((seen["id"], seen["model"], seen["width"], seen["count"], seen["source"], seen["kind"]),
                         (job.id, "turbo", 1024, 1, "page", "image"))
        self.assertNotIn("preview", seen)                   # /metrics stays small: no preview, no image
        self.assertTrue(self.images.wait(job, 60))
        code, m = self.call("GET", "/metrics")
        self.assertEqual((m["images"]["server"], m["images"]["job"], m["images"]["loaded"]), ("ready", None, "image"))
        code, v = self.call("GET", f"/api/images/jobs/{job.id}?images=0")
        self.assertLess(abs(v["now"] - time.time()), 5)    # the server's clock, for the page's timings

    def test_openai_generations(self):
        code, out = self.call("POST", "/v1/images/generations", {"prompt": "a fox", "size": "512x512", "n": 2})
        self.assertEqual(code, 200, out)
        self.assertEqual(len(out["data"]), 2)
        base64.b64decode(out["data"][0]["b64_json"], validate=True)


class NotConfigured(unittest.TestCase):
    def test_the_tab_says_so(self):
        tok = ByteTokenizer()
        engine = ResidentEngine(tok)
        router = Router([Service(engine, tok, ChatTemplate.from_file(QWEN), model_name="chat")])
        router.images = None
        httpd = serve(router, port=0)
        try:
            c = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=30)
            c.request("GET", "/api/images")
            r = c.getresponse()
            self.assertEqual((r.status, json.loads(r.read())), (200, {"configured": False}))
            c.request("GET", "/metrics")
            r = c.getresponse()
            self.assertNotIn("images", json.loads(r.read()))
        finally:
            router.stop()
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
