"""(Lapilli, V100) The Images tab's "Install" (serve/images_install.py): a model's files downloaded from the catalog, against
a local HTTP server that serves ranges, cuts a connection, ignores a range or sends a damaged file. What a model needs (shared
files once, the Turbo's source counted, the room on the disk, ffmpeg for a video model), the refusals (licenses not accepted,
no room, another install running, nothing missing), a resume from a part left by an earlier install, a cut connection resumed,
a range the server ignores, a damaged file removed, a refused file not tried again, a cancel that removes the part, the Turbo
converted by a stand-in sd-cli, ffmpeg taken out of its archive, and the model offered by the tab once its files are there."""
from __future__ import annotations

import hashlib
import http.server
import io
import os
import shutil
import socketserver
import stat
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
import zipfile
from collections import namedtuple
from pathlib import Path
from unittest import mock

from serve import images_catalog as C
from serve import images_install as I
from serve.images import Images, ImagesConfig

Usage = namedtuple("Usage", "total used free")


def blob(n: int, seed: int) -> bytes:
    return bytes((i * 31 + seed) % 251 for i in range(n))


class Files(http.server.BaseHTTPRequestHandler):
    """Serves /<name> from .data; honors Range unless .no_range; .cut[name] = byte where the first answer stops;
    .refuse = names answered 404; .slow = seconds between chunks (a cancel arrives during a download)."""
    data, cut, no_range, refuse, slow, seen = {}, {}, set(), set(), 0.0, []

    def log_message(self, *a):
        pass

    def do_GET(self):
        name = self.path.rsplit("/", 1)[-1]
        Files.seen.append((name, self.headers.get("Range")))
        if name in Files.refuse or name not in Files.data:
            self.send_response(404)
            self.end_headers()
            return
        body, start = Files.data[name], 0
        rng = self.headers.get("Range")
        if rng and name not in Files.no_range:
            start = int(rng.split("=")[1].split("-")[0])
            self.send_response(206)
        else:
            self.send_response(200)
        part = body[start:]
        self.send_header("Content-Length", str(len(part)))
        self.end_headers()
        stop = Files.cut.pop(name, None)
        if stop is not None and stop > start:
            self.wfile.write(part[:stop - start])
            self.wfile.flush()
            self.connection.shutdown(2)                 # a cut connection, half way
            return
        for i in range(0, len(part), 4096):
            self.wfile.write(part[i:i + 4096])
            if Files.slow:
                time.sleep(Files.slow)


class Threads(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass                                            # a client that left (a cancel, a cut): expected here


class InstallTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = Threads(("127.0.0.1", 0), Files)
        threading.Thread(target=cls.http.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.http.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()

    def setUp(self):
        Files.data, Files.cut, Files.no_range, Files.refuse, Files.slow, Files.seen = {}, {}, set(), set(), 0.0, []
        self.tmp = Path(tempfile.mkdtemp(prefix="lapilli-install-"))
        self.models = self.tmp / "models"
        # a small catalog of the same shape: two models sharing a file, a converted one, a video one
        files = {"a.gguf": ("diffusion_models", 300_000, 1), "enc.gguf": ("text_encoders", 200_000, 2),
                 "vae.safetensors": ("vae", 50_000, 3), "w.gguf": ("diffusion_models", 120_000, 4),
                 "lora.safetensors": ("loras", 30_000, 5)}
        self.files = {}
        for n, (d, size, seed) in files.items():
            b = blob(size, seed)
            Files.data[n] = b
            self.files[n] = {"dir": d, "repo": "x/y", "rev": "0" * 40, "path": n, "size": size,
                             "sha256": hashlib.sha256(b).hexdigest()}
        src = blob(400_000, 9)
        conv = hashlib.sha256(b"converted:" + src).digest() * 1000       # what the stand-in sd-cli writes
        Files.data["t_bf16.safetensors"] = src
        self.sources = {"t_bf16.safetensors": {"repo": "x/y", "rev": "0" * 40, "path": "t_bf16.safetensors", "size": len(src),
                                               "sha256": hashlib.sha256(src).hexdigest()}}
        self.files["t.gguf"] = {"dir": "diffusion_models", "convert_from": "t_bf16.safetensors", "type": "q8_0",
                                "size": len(conv), "sha256": hashlib.sha256(conv).hexdigest()}
        self.model_files = {
            "one": {"slots": {"diffusion_model": "a.gguf", "llm": "enc.gguf", "vae": "vae.safetensors"}, "licenses": ["apache-2.0"]},
            "two": {"slots": {"diffusion_model": "w.gguf", "llm": "enc.gguf", "vae": "vae.safetensors"},
                    "loras": ["lora.safetensors"], "licenses": ["apache-2.0"]},
            "conv": {"slots": {"diffusion_model": "t.gguf", "llm": "enc.gguf"}, "licenses": ["qwen-research"]},
            "vid": {"slots": {"diffusion_model": "w.gguf", "vae": "vae.safetensors"}, "licenses": ["apache-2.0", "ffmpeg"]},
        }
        # a zip like gyan.dev's: <dir>/bin/ffmpeg.exe and <dir>/LICENSE
        z = io.BytesIO()
        with zipfile.ZipFile(z, "w") as arc:
            arc.writestr("ffmpeg-9.1-essentials_build/bin/ffmpeg.exe", b"MZ fake ffmpeg")
            arc.writestr("ffmpeg-9.1-essentials_build/LICENSE", b"GPL")
            arc.writestr("ffmpeg-9.1-essentials_build/bin/ffprobe.exe", b"not taken")
        Files.data["ffmpeg.zip"] = z.getvalue()
        self.ffmpeg = {"url": self.base + "/ffmpeg.zip", "size": len(z.getvalue()), "sha256": hashlib.sha256(z.getvalue()).hexdigest(),
                       "exe": "bin/ffmpeg.exe", "license_file": "LICENSE"}
        self.patches = [mock.patch.object(I, "FILES", self.files), mock.patch.object(I, "SOURCES", self.sources),
                        mock.patch.object(I, "MODEL_FILES", self.model_files), mock.patch.object(I, "FFMPEG", self.ffmpeg),
                        mock.patch.object(I, "HF", self.base + "/{path}"),
                        mock.patch.object(I.shutil, "disk_usage", lambda p: Usage(10**13, 0, 10**12)),
                        mock.patch.object(I, "RETRIES", 3), mock.patch.object(I, "CHUNK", 16384)]
        for p in self.patches:
            p.start()
        # the stand-in sd-cli: writes sha256(b"converted:" + source) * 1000 to -o
        self.cli = self.tmp / "sd-cli"
        self.cli.write_text("#!" + sys.executable + "\n"
                            "import hashlib, sys\n"
                            "a = sys.argv\n"
                            "src = open(a[a.index('--diffusion-model') + 1], 'rb').read()\n"
                            "open(a[a.index('-o') + 1], 'wb').write(hashlib.sha256(b'converted:' + src).digest() * 1000)\n")
        self.cli.chmod(self.cli.stat().st_mode | stat.S_IXUSR)

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def installer(self, cli=True) -> I.Installer:
        return I.Installer(str(self.models), sd_cli=str(self.cli) if cli else None)

    def wait(self, ins: I.Installer, max_s: float = 30) -> dict:
        t = time.time()
        while ins.running() and time.time() - t < max_s:
            time.sleep(0.02)
        self.assertFalse(ins.running(), "the install did not end")
        return ins.view()

    def there(self, name: str) -> bytes:
        return (self.models / self.files[name]["dir"] / name).read_bytes()

    # ------------------------------------------------------------------------------------------------- the plan
    def test_plan_counts_what_is_missing_once(self):
        ins = self.installer()
        p = ins.plan("one", {}, [], True)
        self.assertEqual(p["files"], 3)
        self.assertEqual(p["download"], 300_000 + 200_000 + 50_000)
        self.assertIsNone(p["blocked"])
        self.assertEqual([x["name"] for x in p["licenses"]], ["Apache 2.0"])
        # the encoder and the VAE are there (another model brought them): only the diffusion model and the LoRA
        p = ins.plan("two", {"llm": "text_encoders/enc.gguf", "vae": "vae/vae.safetensors"}, [], True)
        self.assertEqual(p["names"], ["w.gguf", "lora.safetensors"])
        # the converted model: its source is downloaded, and it is on the disk with its result until the conversion ends
        p = ins.plan("conv", {}, [], True)
        self.assertEqual(p["download"], 400_000 + 200_000)
        self.assertEqual(p["disk"], self.files["t.gguf"]["size"] + 200_000 + 400_000)
        self.assertIsNone(ins.plan("nope", {}, [], True))

    def test_plan_says_why_it_cannot(self):
        ins = self.installer(cli=False)
        self.assertIn("sd-cli", ins.plan("conv", {}, [], True)["blocked"])
        with mock.patch.object(I.shutil, "disk_usage", lambda p: Usage(10**9, 0, 100_000)):
            self.assertIn("free on this disk", ins.plan("one", {}, [], True)["blocked"])
        with mock.patch.object(I, "WINDOWS", False):
            why = ins.plan("vid", {}, [], False)["blocked"]
            self.assertIn("package manager", why)
            self.assertIsNone(ins.plan("vid", {}, [], True)["blocked"])     # the system's ffmpeg is there
        with mock.patch.object(I, "WINDOWS", True):
            p = ins.plan("vid", {}, [], False)
            self.assertIsNone(p["blocked"])
            self.assertTrue(p["ffmpeg"])
            self.assertEqual(p["files"], 3)
            self.assertIn("FFmpeg, GPL (for the videos)", [x["name"] for x in p["licenses"]])

    def test_refusals(self):
        ins = self.installer()
        plan = ins.plan("one", {}, [], True)
        for accept in (None, False, "yes", 1):
            with self.assertRaisesRegex(I.InstallError, "Accept the licenses"):
                ins.start("one", "One", plan, accept)
        with self.assertRaisesRegex(I.InstallError, "cannot be installed"):
            ins.start("nope", "Nope", None, True)
        with self.assertRaisesRegex(I.InstallError, "already installed"):
            ins.start("one", "One", ins.plan("one", {"diffusion_model": 1, "llm": 1, "vae": 1}, [], True), True)
        Files.slow = 0.01
        ins.start("one", "One", plan, True)
        with self.assertRaisesRegex(I.InstallError, "Another install"):
            ins.start("one", "One", plan, True)
        ins.cancel()
        self.wait(ins)

    # --------------------------------------------------------------------------------------------- the downloads
    def test_install_downloads_checks_and_places(self):
        ins = self.installer()
        ins.start("one", "One", ins.plan("one", {}, [], True), True)
        v = self.wait(ins)
        self.assertEqual(v["state"], "done", v)
        self.assertEqual(v["done"], v["total"])
        for n in ("a.gguf", "enc.gguf", "vae.safetensors"):
            self.assertEqual(self.there(n), Files.data[n])
        self.assertFalse((self.models / ".install").exists(), "the install folder stays only for a part kept")

    def test_resume_from_a_part_left_before(self):
        ins = self.installer()
        (self.models / ".install").mkdir(parents=True)
        (self.models / ".install" / "a.gguf.part").write_bytes(Files.data["a.gguf"][:123_456])
        ins.start("one", "One", ins.plan("one", {"llm": 1, "vae": 1}, [], True), True)
        self.assertEqual(self.wait(ins)["state"], "done")
        self.assertEqual(self.there("a.gguf"), Files.data["a.gguf"])
        self.assertIn(("a.gguf", "bytes=123456-"), Files.seen)

    def test_cut_connection_is_resumed(self):
        Files.cut["a.gguf"] = 100_000
        ins = self.installer()
        with mock.patch.object(I.time, "sleep", lambda s: None):        # no waiting between the tries
            ins.start("one", "One", ins.plan("one", {"llm": 1, "vae": 1}, [], True), True)
            v = self.wait(ins)
        self.assertEqual(v["state"], "done", v)
        self.assertEqual(self.there("a.gguf"), Files.data["a.gguf"])
        ranges = [r for n, r in Files.seen if n == "a.gguf"]
        self.assertEqual(ranges[0], None)
        self.assertTrue(ranges[1] and ranges[1].startswith("bytes="), ranges)

    def test_range_ignored_starts_again(self):
        Files.no_range.add("a.gguf")
        ins = self.installer()
        (self.models / ".install").mkdir(parents=True)
        (self.models / ".install" / "a.gguf.part").write_bytes(Files.data["a.gguf"][:50_000])
        ins.start("one", "One", ins.plan("one", {"llm": 1, "vae": 1}, [], True), True)
        self.assertEqual(self.wait(ins)["state"], "done")
        self.assertEqual(self.there("a.gguf"), Files.data["a.gguf"])

    def test_damaged_file_is_removed(self):
        self.files["a.gguf"]["sha256"] = "0" * 64
        ins = self.installer()
        ins.start("one", "One", ins.plan("one", {"llm": 1, "vae": 1}, [], True), True)
        v = self.wait(ins)
        self.assertEqual(v["state"], "failed")
        self.assertIn("damaged", v["error"])
        self.assertFalse((self.models / "diffusion_models" / "a.gguf").exists())
        self.assertFalse((self.models / ".install" / "a.gguf.part").exists())

    def test_refused_file_is_not_tried_again(self):
        Files.refuse.add("a.gguf")
        ins = self.installer()
        ins.start("one", "One", ins.plan("one", {"llm": 1, "vae": 1}, [], True), True)
        v = self.wait(ins)
        self.assertEqual(v["state"], "failed")
        self.assertIn("HTTP 404", v["error"])
        self.assertEqual(sum(1 for n, _ in Files.seen if n == "a.gguf"), 1)

    def test_cancel_removes_the_part(self):
        Files.slow = 0.02
        ins = self.installer()
        ins.start("one", "One", ins.plan("one", {"llm": 1, "vae": 1}, [], True), True)
        t = time.time()
        while (ins.view()["done"] < 20_000) and time.time() - t < 10:
            time.sleep(0.01)
        ins.cancel()
        v = self.wait(ins)
        self.assertEqual(v["state"], "cancelled")
        self.assertFalse((self.models / ".install" / "a.gguf.part").exists())
        self.assertFalse((self.models / "diffusion_models" / "a.gguf").exists())

    # ------------------------------------------------------------------------------------- the Turbo, ffmpeg
    def test_converted_model(self):
        ins = self.installer()
        etats = []
        vrai = ins._set
        ins._set = lambda **kw: (etats.append(kw["state"]) if "state" in kw else None, vrai(**kw))[1]
        ins.start("conv", "Conv", ins.plan("conv", {}, [], True), True)
        v = self.wait(ins)
        # the new file is checked under its own state, not "checking" (what an earlier install left)
        self.assertIn("verifying", etats)
        self.assertNotIn("checking", etats[etats.index("converting"):])
        self.assertEqual(v["state"], "done", v)
        self.assertEqual(hashlib.sha256(self.there("t.gguf")).hexdigest(), self.files["t.gguf"]["sha256"])
        self.assertFalse((self.models / ".install" / "t_bf16.safetensors").exists(), "the source is removed")

    def test_conversion_giving_other_bytes_is_refused(self):
        self.files["t.gguf"]["sha256"] = "1" * 64
        ins = self.installer()
        ins.start("conv", "Conv", ins.plan("conv", {"llm": 1}, [], True), True)
        v = self.wait(ins)
        self.assertEqual(v["state"], "failed")
        self.assertIn("another file", v["error"])
        self.assertFalse((self.models / "diffusion_models" / "t.gguf").exists())

    def test_ffmpeg_taken_out_of_its_archive(self):
        ins = self.installer()
        with mock.patch.object(I, "WINDOWS", True):
            ins.start("vid", "Vid", ins.plan("vid", {"diffusion_model": 1, "vae": 1}, [], False), True)
            v = self.wait(ins)
            target = I.ffmpeg_path(self.models)
        self.assertEqual(v["state"], "done", v)
        self.assertEqual(target.read_bytes(), b"MZ fake ffmpeg")
        self.assertEqual((target.parent / "LICENSE.txt").read_bytes(), b"GPL")
        self.assertEqual(sorted(x.name for x in target.parent.iterdir()), sorted([target.name, "LICENSE.txt"]))

    # -------------------------------------------------------------------------------- the tab, through Images
    def test_model_offered_once_installed(self):
        im = Images(ImagesConfig(server=[sys.executable, "-c", "pass"], models=str(self.models)), router=None)
        try:
            with mock.patch("serve.images.MODELS", {"one": {"label": "One", "description": "", "steps": 8, "cfg": 1.0,
                                                            "fixed": True, "refs": "optional",
                                                            "files": {"diffusion_model": "diffusion_models/a*.gguf",
                                                                      "llm": "text_encoders/enc*.gguf",
                                                                      "vae": "vae/vae*.safetensors"}}}):
                st = im.state()
                self.assertFalse(st["models"]["one"]["available"])
                self.assertEqual(st["models"]["one"]["install"]["files"], 3)
                self.assertNotIn("names", st["models"]["one"]["install"])
                with self.assertRaises(ValueError):
                    im.install("one", False)
                im.install("one", True)
                self.wait(im.installer)
                st = im.state()
                self.assertTrue(st["models"]["one"]["available"])
                self.assertIsNone(st["models"]["one"]["install"])
                self.assertEqual(st["install_job"]["state"], "done")
        finally:
            im.close()


    def test_state_reads_the_install_before_the_files(self):
        """(seen in a real test) the install's last file landed between the two readings of one GET: the
        model said "Not installed yet · 0.0 GB" next to "is installed". The install's state is read first now."""
        im = Images(ImagesConfig(server=[sys.executable, "-c", "pass"], models=str(self.models)), router=None)
        try:
            spec = {"one": {"label": "One", "description": "", "steps": 8, "cfg": 1.0, "fixed": True, "refs": "optional",
                            "files": {"diffusion_model": "diffusion_models/a*.gguf", "llm": "text_encoders/enc*.gguf",
                                      "vae": "vae/vae*.safetensors"}}}
            for n in ("a.gguf", "enc.gguf"):
                d = self.models / self.files[n]["dir"]
                d.mkdir(parents=True, exist_ok=True)
                (d / n).write_bytes(Files.data[n])

            def vue():                                   # the last file lands as the install says "done"
                d = self.models / "vae"
                d.mkdir(parents=True, exist_ok=True)
                (d / "vae.safetensors").write_bytes(Files.data["vae.safetensors"])
                return {"model": "one", "label": "One", "state": "done"}
            with mock.patch("serve.images.MODELS", spec), mock.patch.object(im.installer, "view", vue):
                st = im.state()
            self.assertEqual(st["install_job"]["state"], "done")
            self.assertTrue(st["models"]["one"]["available"], "a model whose install is done is installed in the same reading")
        finally:
            im.close()


if __name__ == "__main__":
    unittest.main()
