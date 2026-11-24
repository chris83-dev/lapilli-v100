"""(Lapilli) The page's Engine settings: the kept file, the start's order (command line, page, default), the queued change
applied by restarting the engine (and undone when the new settings cannot start), and the HTTP routes."""
import json
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from serve.engine import settings as page
from serve.engine.errors import EngineStartError
from serve.engine.mock import MockEngine
from serve.engine.process import ProcessEngine
from serve.frontend import ChatTemplate
from serve.handler import serve
from serve.service import Service
from serve.util.text import ByteTokenizer

TEMPLATE = Path(__file__).resolve().parents[1] / "chat_template.jinja"


class SpawnEngine(ProcessEngine):
    """A loaded engine whose restarts read the context from their spawn arguments; one above `fits` does not start."""
    takes_text = False

    def __init__(self, tok, args, fits=65536):
        self.reply = MockEngine(tok, "Hello.", max_context=4096)
        self.spawn = ("engine", list(args), None, None, None)
        self.fits = fits
        self.info, self.last, self.progress = {}, {}, None
        self.loaded_now, self.unloaded = True, False
        self.max_context = page.context_of(args) or 8192
        self.starts = []                                   # the spawn arguments of each start

    def alive(self):
        return self.loaded_now

    def exit_code(self):
        return None

    def restart(self, tries=None):
        args = self.spawn[1]
        n = page.context_of(args) or 8192
        self.starts.append(list(args))
        if n > self.fits:
            self.loaded_now = False
            raise EngineStartError(f"not enough free device memory for a context of {n} tokens")
        self.max_context, self.loaded_now, self.unloaded = n, True, False

    def close(self):
        self.loaded_now = False

    def unload(self):
        self.close()
        self.unloaded = True

    def generate(self, *args, **kwargs):
        yield from self.reply.generate(*args, **kwargs)


class KeptFile(unittest.TestCase):
    def test_round_trip_and_broken_files(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / page.FILE
            self.assertEqual(page.load(p), {})                          # none yet
            page.save(p, {"max_context": 131072, "vision": "off", "other": 1})
            self.assertEqual(page.load(p), {"max_context": 131072, "vision": "off"})
            p.write_text("{not json", encoding="utf-8")
            self.assertEqual(page.load(p), {})                          # a broken file is ignored
            p.write_text(json.dumps({"max_context": True, "vision": "maybe"}), encoding="utf-8")
            self.assertEqual(page.load(p), {})                          # values it does not know are dropped

    def test_choices_and_checks(self):
        self.assertEqual(page.context_choices(65536), [4096, 8192, 16384, 32768, 65536])
        self.assertEqual(page.context_choices(40960)[-2:], [32768, 40960])   # the model's own length, not a power of two
        self.assertEqual(page.context_choices(1048576)[-1], 1048576)
        self.assertEqual(page.default_context(1048576), 32768)
        self.assertEqual(page.default_context(16384), 16384)
        self.assertEqual(page.check_context(65536, 65536), 65536)
        for bad in (2048, 131072, "8192", True, 8192.0):
            with self.assertRaises(ValueError):
                page.check_context(bad, 65536)

    def test_argument_rewrites(self):
        a = ["--model", "m.basalt", "--max-context", "32768", "--kv", "int8"]
        self.assertEqual(page.with_context(a, 8192), ["--model", "m.basalt", "--max-context", "8192", "--kv", "int8"])
        self.assertEqual(page.with_context(["--model", "m"], 8192), ["--model", "m", "--max-context", "8192"])
        self.assertEqual(page.with_context(["--max-context=4096"], 8192), ["--max-context=8192"])
        self.assertEqual(page.with_context(["--max-context", "1", "--max-context", "2"], 9), ["--max-context", "1", "--max-context", "9"])
        self.assertEqual(page.with_vision(["--model", "m", "--vision"], False), ["--model", "m"])
        self.assertEqual(page.with_vision(["--model", "m"], True), ["--model", "m", "--vision"])
        self.assertEqual(page.with_vision(["--vision", "--model", "m"], True), ["--model", "m", "--vision"])
        self.assertEqual(page.context_of(["--max-context", "4096", "--max-context=8192"]), 8192)
        self.assertIsNone(page.context_of(["--model", "m"]))


class Applied(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        tok = ByteTokenizer()
        self.engine = SpawnEngine(tok, ["--model", "m.basalt", "--max-context", "32768", "--vision"])
        self.svc = Service(self.engine, tok, ChatTemplate.from_file(TEMPLATE))
        self.svc.page_settings = {"path": str(Path(self.dir.name) / page.FILE), "native_context": 65536,
                                  "context_source": "default", "vision_source": "default", "vision_available": True}
        from serve.engine.vision import EngineVision
        self.svc.vision = EngineVision({"mode": "dynamic", "gpu": True})
        self.svc.vision.attach(self.engine)
        self.httpd = serve(self.svc, port=0)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.dir.cleanup()

    def wait_state(self, *done, timeout=10.0):
        t0 = time.time()
        while time.time() - t0 < timeout:
            st = self.svc.engine_settings()["state"]
            if st.get("status") in done:
                return st
            time.sleep(0.02)
        self.fail(f"state still {self.svc.engine_settings()['state']}")

    def request(self, path, body=None, headers=None):
        data = None if body is None else json.dumps(body).encode()
        h = {"Content-Type": "application/json"} if body is not None else {}
        h.update(headers or {})
        req = urllib.request.Request(self.base + path, data=data, headers=h, method="POST" if body is not None else "GET")
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def test_get_tells_what_runs_and_what_the_page_may_offer(self):
        code, body = self.request("/api/engine-settings")
        self.assertEqual(code, 200)
        self.assertTrue(body["supported"])
        self.assertEqual(body["context"]["value"], 32768)
        self.assertEqual(body["context"]["model_max"], 65536)
        self.assertEqual(body["context"]["choices"], [4096, 8192, 16384, 32768, 65536])
        self.assertEqual(body["vision"], {"value": "on", "available": True, "source": "default"})

    def test_a_new_context_restarts_the_engine_and_is_kept(self):
        code, body = self.request("/api/engine-settings", {"context": 65536})
        self.assertEqual((code, body["status"]), (202, "pending"))
        st = self.wait_state("ok", "failed")
        self.assertEqual(st["status"], "ok")
        self.assertEqual(self.engine.max_context, 65536)
        self.assertEqual(page.context_of(self.engine.starts[-1]), 65536)
        self.assertIn("--vision", self.engine.starts[-1])              # the image input unchanged
        self.assertEqual(page.load(self.svc.page_settings["path"]), {"max_context": 65536})
        self.assertEqual(self.svc.engine_settings()["context"]["source"], "page")

    def test_vision_off_then_on(self):
        self.request("/api/engine-settings", {"vision": "off"})
        self.assertEqual(self.wait_state("ok", "failed")["status"], "ok")
        self.assertIsNone(self.svc.vision)
        self.assertNotIn("--vision", self.engine.starts[-1])
        self.request("/api/engine-settings", {"vision": "on"})
        self.assertEqual(self.wait_state("ok", "failed")["status"], "ok")
        self.assertIsNotNone(self.svc.vision)
        self.assertIn("--vision", self.engine.starts[-1])
        self.assertEqual(page.load(self.svc.page_settings["path"]), {"vision": "on"})

    def test_a_context_that_does_not_start_goes_back(self):
        self.engine.fits = 32768
        self.request("/api/engine-settings", {"context": 65536})
        st = self.wait_state("failed", "ok")
        self.assertEqual(st["status"], "failed")
        self.assertIn("not enough free device memory", st["error"])
        self.assertIs(st["restored"], True)
        self.assertNotIn("restore_error", st)
        self.assertEqual(self.engine.max_context, 32768)                # running again with what ran before
        self.assertEqual(page.context_of(self.engine.spawn[1]), 32768)
        self.assertEqual(page.load(self.svc.page_settings["path"]), {})  # nothing kept

    def test_when_the_previous_settings_fail_too_the_state_says_so(self):
        self.engine.fits = 16384                                        # neither 65,536 nor the 32,768 it ran with
        self.request("/api/engine-settings", {"context": 65536})
        st = self.wait_state("failed", "ok")
        self.assertEqual(st["status"], "failed")
        self.assertIs(st["restored"], False)
        self.assertIn("65536", st["error"])
        self.assertIn("32768", st["restore_error"])
        self.assertEqual(page.context_of(self.engine.spawn[1]), 32768)  # the previous arguments kept for the next try
        self.assertEqual(page.load(self.svc.page_settings["path"]), {})

    def test_refusals(self):
        code, body = self.request("/api/engine-settings", {"context": 1024})
        self.assertEqual(code, 400)
        self.assertIn("at least", body["error"]["message"])
        code, _ = self.request("/api/engine-settings", {"context": 131072})
        self.assertEqual(code, 400)                                     # longer than the model reads
        code, _ = self.request("/api/engine-settings", {"context": 8192}, headers={"Origin": "http://evil.example"})
        self.assertEqual(code, 403)                                     # only from the server's own page
        self.svc.page_settings["context_source"] = "command line"
        code, body = self.request("/api/engine-settings", {"context": 8192})
        self.assertEqual(code, 400)
        self.assertIn("command line", body["error"]["message"])
        self.svc.page_settings["vision_available"] = False
        self.svc.page_settings["vision_source"] = "default"
        code, body = self.request("/api/engine-settings", {"vision": "on"})
        self.assertEqual(code, 400)
        code, _ = self.request("/api/engine-settings", {})
        self.assertEqual(code, 400)


if __name__ == "__main__":
    unittest.main()
