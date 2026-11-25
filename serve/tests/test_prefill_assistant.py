"""llama.cpp's prefill-assistant: a conversation that ends with an assistant message continues it, its text
or, when it has written none yet, its thinking; the template's rendering is cut right after that text, the reply is parsed
from there (text goes on as text), and what llama.cpp refuses is refused. Every dialect, no engine, no pack."""
from __future__ import annotations

import http.client
import json
import unittest
from pathlib import Path

from serve.engine.mock import MockEngine
from serve.frontend import ChatTemplate, openai_to_messages
from serve.handler import serve
from serve.models.deepseek41 import DeepSeek41, DeepseekTemplate
from serve.models.hy4flash import OFFICIAL_SUFFIX, Hy4Flash, Tags
from serve.models.inkling2 import Inkling2
from serve.models.qwen import Qwen
from serve.router import Router
from serve.service import Service
from serve.util.text import IM_END, ByteTokenizer

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
QWEN = ROOT / "serve/chat_template.jinja"
PARTIAL = "def area(r):\n    return 3.14159 * r"          # a reply the context cut in the middle of its code
THOUGHT = "The user wants a function. I will write"


class HyTokenizer(ByteTokenizer):
    SPECIALS = Tags(OFFICIAL_SUFFIX).all()


def services():
    """One service per dialect, each with its own template (the vendored ones for Hy4-flash and Inkling 2)."""
    tok = ByteTokenizer()
    out = {"qwen": Service(MockEngine(tok, "ok", max_context=8192), tok, ChatTemplate.from_file(QWEN), model_name="qwen", dialect=Qwen()),
           "deepseek": Service(MockEngine(tok, "ok", max_context=8192), tok, DeepseekTemplate(), model_name="ds", dialect=DeepSeek41())}
    hy = Hy4Flash()
    htok = HyTokenizer()
    out["hy4"] = Service(MockEngine(htok, "ok", max_context=8192), htok,
                         hy.template((FIXTURES / "hy4_flash_chat_template.jinja").read_text(encoding="utf-8")), model_name="hy4", dialect=hy)
    ink = Inkling2()
    out["inkling"] = Service(MockEngine(tok, "ok", max_context=8192), tok,
                             ink.template((FIXTURES / "inkling2_chat_template.jinja").read_text(encoding="utf-8")),
                             model_name="inkling", dialect=ink)
    return out


def conversation(**last):
    return [{"role": "user", "content": "Write a function that returns the area of a circle."}, {"role": "assistant", **last}]


def text_of(svc, messages, kwargs=None, cont=None):
    """(prompt text the engine gets, the parser's start in thinking) for `messages`."""
    ids, thinking, _ = svc.prepare(messages, None, dict(kwargs or {}), cont=cont)
    return svc.tok.decode(list(ids)), thinking


class Continued(unittest.TestCase):
    def test_every_dialect_ends_the_prompt_with_the_text_it_continues(self):
        for name, svc in services().items():
            with self.subTest(name):
                prompt, thinking = text_of(svc, conversation(content=PARTIAL))
                self.assertTrue(prompt.endswith(PARTIAL), repr(prompt[-160:]))
                self.assertFalse(thinking)                        # the text goes on as text: its thinking is over
                # the conversation before it is what the model read before it began its answer
                before, _ = text_of(svc, conversation(content=PARTIAL)[:1], cont=False)
                head = svc.render_text(conversation(content=PARTIAL)[:1], None, svc.thinking_kwargs({}))[0]
                self.assertTrue(prompt.startswith(head[:len(head) - 40]), name)

    def test_a_reply_with_only_thinking_continues_its_thinking(self):
        for name, svc in services().items():
            with self.subTest(name):
                try:
                    prompt, thinking = text_of(svc, conversation(content="", reasoning_content=THOUGHT))
                except ValueError as e:                           # a template that never shows the thinking it was given
                    self.assertIn("cannot be continued", str(e))
                    continue
                self.assertTrue(prompt.endswith(THOUGHT), repr(prompt[-160:]))
                self.assertTrue(thinking)

    def test_qwen_continues_after_an_empty_thinking_block(self):
        prompt, _ = text_of(services()["qwen"], conversation(content=PARTIAL))
        self.assertTrue(prompt.endswith("<|im_start|>assistant\n<think>\n\n</think>\n\n" + PARTIAL), repr(prompt[-120:]))
        self.assertNotIn(IM_END, prompt[-len(PARTIAL) - 5:])

    def test_an_empty_assistant_message_is_left_out(self):
        svc = services()["qwen"]
        a, _ = text_of(svc, conversation(content=""))
        b, _ = text_of(svc, conversation(content="")[:1])
        self.assertEqual(a, b)

    def test_continue_final_message_false_and_the_server_switch_answer_after_it(self):
        for cont, prefill in ((False, True), (None, False)):
            svc = services()["qwen"]
            svc.prefill_assistant = prefill
            prompt, thinking = text_of(svc, conversation(content=PARTIAL), cont=cont)
            self.assertIn(PARTIAL.strip() + IM_END, prompt)          # the reply closed, a new answer opened after it
            self.assertTrue(prompt.endswith("<|im_start|>assistant\n<think>\n"), repr(prompt[-60:]))
            self.assertTrue(thinking)

    def test_what_llama_cpp_refuses_is_refused(self):
        svc = services()["qwen"]
        two = conversation(content="one") + [{"role": "assistant", "content": "two"}]
        with self.assertRaisesRegex(ValueError, "2 or more assistant messages"):
            svc.prepare(two, None, {})
        calls = conversation(content="", tool_calls=[{"id": "c1", "type": "function", "function": {"name": "f", "arguments": "{}"}}])
        with self.assertRaisesRegex(ValueError, "tool calls"):
            svc.prepare(calls, None, {})
        with self.assertRaisesRegex(ValueError, "does not end with an assistant message"):
            svc.prepare(conversation(content=PARTIAL)[:1], None, {}, cont=True)

    def test_the_text_kept_as_written_when_the_template_keeps_it(self):
        svc = services()["qwen"]
        prompt, _ = text_of(svc, conversation(content=PARTIAL + " "))
        self.assertTrue(prompt.endswith(PARTIAL), repr(prompt[-40:]))      # Qwen's template trims: the cut follows it


class Switch(unittest.TestCase):
    def test_on_by_default_and_off_by_both_paths(self):
        from serve.config import build_parser
        from serve.tests.test_config import parse
        self.assertTrue(build_parser().get_default("prefill_assistant"))
        self.assertFalse(parse(["--no-prefill-assistant"])[0].prefill_assistant)
        self.assertFalse(parse([], {"server": {"prefill-assistant": False}})[0].prefill_assistant)
        self.assertTrue(parse([], {"server": {"prefill-assistant": True}})[0].prefill_assistant)


class OverHttp(unittest.TestCase):
    def test_the_reply_is_only_the_new_text_and_the_engine_reads_the_open_message(self):
        tok = ByteTokenizer()
        engine = MockEngine(tok, " ** 2", max_context=8192)
        svc = Service(engine, tok, ChatTemplate.from_file(QWEN), model_name="qwen", dialect=Qwen())
        router = Router([svc])
        httpd = serve(router, port=0)
        try:
            def post(body):
                c = http.client.HTTPConnection("127.0.0.1", httpd.server_address[1], timeout=30)
                try:
                    c.request("POST", "/v1/chat/completions", json.dumps(body), {"Content-Type": "application/json"})
                    r = c.getresponse()
                    return r.status, json.loads(r.read())
                finally:
                    c.close()
            code, body = post({"model": "qwen", "messages": conversation(content=PARTIAL)})
            self.assertEqual(code, 200, body)
            self.assertEqual(body["choices"][0]["message"]["content"], " ** 2")
            self.assertFalse(body["choices"][0]["message"].get("reasoning_content"))
            seen = tok.decode(engine.last_prompt)
            self.assertTrue(seen.endswith(PARTIAL), repr(seen[-80:]))
            code, body = post({"model": "qwen", "messages": conversation(content=PARTIAL), "continue_final_message": "yes"})
            self.assertEqual(code, 400, body)
            code, body = post({"model": "qwen", "messages": openai_to_messages({"messages": conversation(content=PARTIAL)})[0][:1],
                               "continue_final_message": True})
            self.assertEqual(code, 400, body)
        finally:
            router.stop()
            httpd.shutdown()
            httpd.server_close()


if __name__ == "__main__":
    unittest.main()
