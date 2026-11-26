"""(Lapilli) The Images tab's "Install": it downloads a model's files from the catalog
(serve/images_catalog.py) into the model folder, so that someone who starts Lapilli with no image model at all gets one from
the page. One install at a time, in its own thread; the page follows it through GET /api/images.

* What a model needs: the catalog file of each of its slots (and LoRAs) that the folder does not have, ffmpeg for a video
  model (Windows: downloaded; elsewhere, the system's), and room for all of it on the disk (the Turbo: its BF16 source too).
* Each file arrives under <models>/.install/<name>.part, hashed as it comes, and is renamed into its folder only when its size
  and its SHA-256 are right: a half file is never taken for a model's file. A cut connection is retried and resumed (an HTTP
  range); after a restart of the server, Install resumes the part already there (hashed again first). Cancel stops the install
  and removes the part being downloaded; the files already finished stay (they are right, and another model may use them).
* The licenses come with the request: it says accept: true, or it is refused."""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

from serve.images_catalog import FFMPEG, FILES, HF, LICENSES, MODEL_FILES, SOURCES

CHUNK = 8 << 20
RETRIES = 6                    # a cut connection: tried again after 2, 4, 8, 16, 30, 30 s, from where it stopped
MARGIN = 2 << 30               # room kept free on the disk beyond what the files need
USER_AGENT = "lapilli-images-install"
WINDOWS = os.name == "nt"


class InstallError(ValueError):
    """An install this module refuses or could not finish: its message is the reason, for the page."""


class Cancelled(Exception):
    pass


def ffmpeg_path(models: str | os.PathLike) -> Path:
    """Where Install puts ffmpeg (Windows): <models>/ffmpeg/ffmpeg.exe."""
    return Path(models) / "ffmpeg" / ("ffmpeg.exe" if WINDOWS else "ffmpeg")


def sd_cli_next_to(server) -> str | None:
    """sd-cli, built with sd-server: the Turbo's conversion. Next to sd-server, or nothing (a test's fake server)."""
    if not isinstance(server, (str, os.PathLike)) or not str(server):
        return None
    p = Path(server).with_name("sd-cli.exe" if WINDOWS else "sd-cli")
    return str(p) if p.is_file() else None


def _gb(n: int) -> str:
    """Bytes as the page and Windows show them: binary GB (the page's free space reads as in the file explorer)."""
    return f"{n / 1073741824:.1f} GB"


class Installer:
    def __init__(self, models: str, sd_cli: str | None = None, cap=None, opener=None):
        self.models = Path(models)
        self.parts = self.models / ".install"
        self.sd_cli = sd_cli
        self.cap = cap                          # cap(proc): the working-set cap of a program it starts (Windows)
        self.open = opener or urllib.request.urlopen
        self.lock = threading.Lock()
        self.job: dict | None = None
        self.cancel_flag = threading.Event()
        self.proc: subprocess.Popen | None = None
        self.thread: threading.Thread | None = None

    # --------------------------------------------------------------------------------------------- what is needed
    def plan(self, model: str, found: dict, loras_found: list, ffmpeg_ok: bool) -> dict | None:
        """What Install would do for a model, from what the folder has (found: its slots, loras_found: its LoRA files)."""
        spec = MODEL_FILES.get(model)
        if spec is None:
            return None
        names = [n for slot, n in spec["slots"].items() if slot not in found]
        names += [n for n in spec.get("loras", ()) if n not in loras_found]
        names = list(dict.fromkeys(names))                 # a file two slots share: once
        download = disk = peak = 0
        for n in names:
            e = FILES[n]
            if "convert_from" in e:
                src = SOURCES[e["convert_from"]]
                download += src["size"]
                peak = max(peak, src["size"])               # the source is there until its conversion is done
            else:
                download += e["size"]
            disk += e["size"]
        ffmpeg = ("ffmpeg" in spec["licenses"]) and not ffmpeg_ok
        if ffmpeg and WINDOWS:
            download += FFMPEG["size"]
            disk += 3 * FFMPEG["size"]                      # the archive, then ffmpeg.exe (about 1.4 times the archive)
        need = disk + peak
        free = shutil.disk_usage(self._existing(self.models)).free
        why = None
        if ffmpeg and not WINDOWS:
            why = "The videos need ffmpeg: install it with your package manager, then restart the server."
        elif any("convert_from" in FILES[n] for n in names) and not self.sd_cli:
            why = "sd-cli is missing next to sd-server: it makes this model's file."
        elif free < need + MARGIN:
            why = f"It needs {_gb(need + MARGIN)} free on this disk; {_gb(free)} are free."
        return {"files": len(names) + (1 if ffmpeg and WINDOWS else 0), "download": download, "disk": need, "free": free,
                "licenses": [{"name": LICENSES[k][0], "url": LICENSES[k][1]} for k in spec["licenses"]
                             if k != "ffmpeg" or ffmpeg],
                "blocked": why, "names": names, "ffmpeg": ffmpeg and WINDOWS,
                "convert": any("convert_from" in FILES[n] for n in names)}

    @staticmethod
    def _existing(p: Path) -> Path:
        while not p.exists() and p.parent != p:
            p = p.parent
        return p

    # ---------------------------------------------------------------------------------------------- the install
    def running(self) -> bool:
        return self.thread is not None and self.thread.is_alive()

    def start(self, model: str, label: str, plan: dict, accept: bool, done=None) -> dict:
        """Start installing a model, or say why not (InstallError). done(): called after a success (ffmpeg found again)."""
        if self.running():
            raise InstallError("Another install is running: wait for it, or stop it.")
        if plan is None:
            raise InstallError(f"{model}: this model cannot be installed from the page.")
        if accept is not True:
            raise InstallError("Accept the licenses first.")
        if plan["blocked"]:
            raise InstallError(plan["blocked"])
        if not plan["files"]:
            raise InstallError(f"{label} is already installed.")
        self.cancel_flag.clear()
        self.job = {"model": model, "label": label, "state": "starting", "file": None, "step": 0, "steps": plan["files"],
                    "done": 0, "total": plan["download"], "speed": None, "left_s": None, "error": None,
                    "started": time.time(), "finished": None}
        self.thread = threading.Thread(target=self._run, args=(plan, done), name="images-install", daemon=True)
        self.thread.start()
        return self.view()

    def cancel(self) -> dict | None:
        if not self.running():
            return self.view()
        self.cancel_flag.set()
        p = self.proc
        if p is not None and p.poll() is None:
            p.terminate()                                  # the conversion's exact process
        return self.view()

    def view(self) -> dict | None:
        with self.lock:
            return dict(self.job, now=time.time()) if self.job else None

    def _set(self, **kw) -> None:
        with self.lock:
            self.job.update(kw)

    def _run(self, plan: dict, done) -> None:
        try:
            self.parts.mkdir(parents=True, exist_ok=True)
            step = 0
            for n in plan["names"]:
                e = FILES[n]
                dest = self.models / e["dir"] / n
                if "convert_from" in e:
                    src_name = e["convert_from"]
                    step += 1
                    src = self.parts / src_name
                    self._download(src_name, SOURCES[src_name], src, step)
                    self._convert(n, e, src, dest)
                    src.unlink(missing_ok=True)
                else:
                    step += 1
                    self._download(n, e, dest, step)
            if plan["ffmpeg"]:
                step += 1
                self._ffmpeg(step)
            self._set(state="done", finished=time.time(), file=None, speed=None, left_s=0)
            print(f"[images] installed: {self.job['label']}", flush=True)
            if done:
                done()
        except Cancelled:
            self._set(state="cancelled", finished=time.time(), speed=None, left_s=None)
            print(f"[images] install stopped: {self.job['label']}", flush=True)
        except Exception as e:                            # noqa: BLE001 (any failure is the install's, shown to the page)
            self._set(state="failed", finished=time.time(), error=str(e) or type(e).__name__, speed=None, left_s=None)
            print(f"[images] install failed: {self.job['label']}: {e}", flush=True)
        finally:
            self.proc = None
            try:
                self.parts.rmdir()                         # only when empty: a part kept for a resume stays
            except OSError:
                pass

    # ------------------------------------------------------------------------------------------------ one file
    def _download(self, name: str, e: dict, dest: Path, step: int, url: str | None = None) -> None:
        url = url or HF.format(**e)
        part = self.parts / (name + ".part")
        self._set(state="downloading", file=name, step=step)
        base = self.job["done"]
        if dest.is_file() and dest.stat().st_size == e["size"]:      # already here (a source an earlier install finished)
            if self._hash(dest) == e["sha256"]:
                self._set(done=base + e["size"])
                return
            dest.unlink()
        h = hashlib.sha256()
        have = 0
        if part.exists():                                  # an earlier install stopped here: hash it, then go on
            if part.stat().st_size > e["size"]:
                part.unlink()
            else:
                h, have = self._hash(part, keep=True), part.stat().st_size
        self._set(state="downloading")
        self._progress(base, have, reset=True)
        tries = 0
        try:
            while have < e["size"]:
                headers = {"User-Agent": USER_AGENT}
                if have:
                    headers["Range"] = f"bytes={have}-"
                try:
                    with self.open(urllib.request.Request(url, headers=headers), timeout=60) as r:
                        if have and getattr(r, "status", 200) != 206:   # the range was not served: from the start
                            h, have = hashlib.sha256(), 0
                        with open(part, "ab" if have else "wb") as out:
                            while b := r.read(CHUNK):
                                out.write(b)
                                h.update(b)
                                have += len(b)
                                self._progress(base, have)
                                if self.cancel_flag.is_set():
                                    raise Cancelled()
                                if have > e["size"]:
                                    break
                    tries = 0
                except urllib.error.HTTPError as err:
                    if 400 <= err.code < 500 and err.code not in (408, 429):     # refused, not cut: no use trying again
                        raise InstallError(f"{name}: the server refused it (HTTP {err.code}).") from None
                    tries = self._again(name, have, tries, err)
                except (urllib.error.URLError, OSError, TimeoutError) as err:
                    tries = self._again(name, have, tries, err)
                if have > e["size"]:
                    break
        except Cancelled:
            part.unlink(missing_ok=True)                   # closed by now: the part being downloaded goes
            raise
        if have != e["size"] or h.hexdigest() != e["sha256"]:
            part.unlink(missing_ok=True)
            raise InstallError(f"{name} arrived damaged (its checksum differs): it was removed; Install downloads it again.")
        dest.parent.mkdir(parents=True, exist_ok=True)
        os.replace(part, dest)
        self._set(done=base + e["size"])

    def _again(self, name: str, have: int, tries: int, err) -> int:
        """A cut connection: wait (2, 4, 8, 16, 30, 30 s), then go on from where it stopped; fail after RETRIES."""
        tries += 1
        if tries > RETRIES:
            raise InstallError(f"{name}: the download failed ({err}); {_gb(have)} kept: Install goes on from there.")
        self._set(state="retrying")
        for _ in range(min(30, 2 ** tries) * 4):
            time.sleep(0.25)
            if self.cancel_flag.is_set():
                raise Cancelled()
        self._set(state="downloading")
        return tries

    def _hash(self, path: Path, keep: bool = False, state: str = "checking"):
        """The SHA-256 of a file already on the disk; keep: the hash object, to go on with it. Its state: "checking" (what an
        earlier install left), or "verifying" (the file the conversion just made: seen in the real test, the page said
        "Checking what an earlier install left" for the half minute the Turbo's new file took)."""
        self._set(state=state)
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while b := f.read(CHUNK):
                h.update(b)
                if self.cancel_flag.is_set():
                    raise Cancelled()                      # nothing removed: what was there stays for the next time
        return h if keep else h.hexdigest()

    def _progress(self, base: int, have: int, reset: bool = False) -> None:
        now = time.time()
        with self.lock:
            j = self.job
            if reset or "_t" not in j:
                j["_t"], j["_b"] = now, base + have
            j["done"] = base + have
            dt = now - j["_t"]
            if dt >= 1.0:                                  # the speed over the last second or so, smoothed
                v = (j["done"] - j["_b"]) / dt
                j["speed"] = v if j["speed"] is None else 0.7 * j["speed"] + 0.3 * v
                j["_t"], j["_b"] = now, j["done"]
                if j["speed"]:
                    j["left_s"] = max(0, (j["total"] - j["done"]) / j["speed"])

    # -------------------------------------------------------------------------------------------- the Turbo
    def _convert(self, name: str, e: dict, src: Path, dest: Path) -> None:
        """sd-cli makes the GGUF from its BF16 source (about two minutes); the result is checked by its size and its SHA-256
        (sd-cli's conversion gives the same bytes every time: the one measured on the V100)."""
        out = self.parts / ("converting-" + name)
        out.unlink(missing_ok=True)
        self._set(state="converting", file=name, speed=None, left_s=None)
        log = self.parts / "convert.log"
        with open(log, "ab") as f:
            self.proc = subprocess.Popen([self.sd_cli, "-M", "convert", "--diffusion-model", str(src), "-o", str(out),
                                          "--type", e["type"]], stdin=subprocess.DEVNULL, stdout=f, stderr=subprocess.STDOUT)
        if self.cap:
            self.cap(self.proc)
        code = self.proc.wait()
        self.proc = None
        if self.cancel_flag.is_set():
            out.unlink(missing_ok=True)
            raise Cancelled()
        if code != 0 or not out.is_file():
            out.unlink(missing_ok=True)
            raise InstallError(f"{name}: sd-cli could not make it (exit code {code}; see {log}).")
        if out.stat().st_size != e["size"] or self._hash(out, state="verifying") != e["sha256"]:
            out.unlink(missing_ok=True)
            raise InstallError(f"{name}: sd-cli made another file than the one measured (another sd-cli?): it was removed.")
        dest.parent.mkdir(parents=True, exist_ok=True)
        os.replace(out, dest)
        log.unlink(missing_ok=True)

    # --------------------------------------------------------------------------------------------------- ffmpeg
    def _ffmpeg(self, step: int) -> None:
        z = self.parts / "ffmpeg.zip"
        self._download("ffmpeg.zip", FFMPEG, z, step, url=FFMPEG["url"])
        self._set(state="extracting", file="ffmpeg.exe")
        target = ffmpeg_path(self.models)
        target.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(z) as arc:
            for m in arc.namelist():
                low = m.replace("\\", "/")
                if low.endswith("/" + FFMPEG["exe"]) or low.endswith("/" + FFMPEG["license_file"]):
                    leaf = target.name if low.endswith(FFMPEG["exe"]) else "LICENSE.txt"
                    tmp = target.parent / (leaf + ".part")
                    with arc.open(m) as src, open(tmp, "wb") as dst:
                        shutil.copyfileobj(src, dst, CHUNK)
                    os.replace(tmp, target.parent / leaf)
        z.unlink(missing_ok=True)
        if not target.is_file():
            raise InstallError("ffmpeg.exe was not in its archive.")
