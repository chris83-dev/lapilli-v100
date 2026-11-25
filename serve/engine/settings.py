"""(Lapilli) The engine settings the server's own page changes: the context length and the image input. They are kept per
model file next to its conversations (modelfile.cache_dir, lapilli-settings.json) and applied by restarting the engine; at
start the command line (or --config) still wins, then the page's choice, then the defaults: images on when the file
carries a projector (`--vision dynamic` holds no VRAM at rest), and a context of DEFAULT_CONTEXT tokens (the model's own
length when shorter). People run Lapilli without anything around it, so the page is where they set it; a tool that starts
the server follows what it serves rather than passing these flags."""
import json
import os
from pathlib import Path

FILE = "lapilli-settings.json"
# without a choice. 65,536: 32,768 was short for code with thinking on Flash-Next (a model that
# keeps earlier turns' thinking in its context filled it in two exchanges); the engines with elastic caches back only
# their first 32,768 positions at start and grow on use
DEFAULT_CONTEXT = 65536
MIN_CONTEXT = 4096
VISION_FLAG = "--vision"       # the engine's flag for the in-engine encoder (`--vision dynamic` at the server)


def load(path) -> dict:
    """The kept settings, {} when there are none or the file cannot be read (a broken file is ignored, not fatal)."""
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    out = {}
    n = data.get("max_context")
    if isinstance(n, int) and not isinstance(n, bool) and n > 0:
        out["max_context"] = n
    if data.get("vision") in ("on", "off"):
        out["vision"] = data["vision"]
    return out


def save(path, data: dict) -> None:
    """Write the settings next to the model's conversations, whole or not at all (a temporary file renamed over it)."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps({k: data[k] for k in ("max_context", "vision") if k in data}, indent=1) + "\n",
                   encoding="utf-8")
    os.replace(tmp, p)


def native_context(meta: dict) -> int | None:
    """The context length the model file was made for (its `*.context_length`), None when it does not say."""
    for k, v in (meta.get("gguf_kv") or {}).items():
        if k.endswith(".context_length") and isinstance(v, int) and not isinstance(v, bool) and v > 0:
            return v
    return None


def default_context(native: int | None) -> int:
    return min(DEFAULT_CONTEXT, native) if native else DEFAULT_CONTEXT


def context_choices(native: int | None) -> list[int]:
    """The lengths the page offers: powers of two from MIN_CONTEXT up to the model's own length, and that length."""
    top = native or 1 << 20
    out, n = [], MIN_CONTEXT
    while n <= top:
        out.append(n)
        n *= 2
    if top not in out and top >= MIN_CONTEXT:
        out.append(top)
    return out


def check_context(n, native: int | None) -> int:
    """A context the page may ask for, as an int; ValueError says why not."""
    if isinstance(n, bool) or not isinstance(n, int):
        raise ValueError("context: a whole number of tokens")
    if n < MIN_CONTEXT:
        raise ValueError(f"context: at least {MIN_CONTEXT} tokens")
    if native and n > native:
        raise ValueError(f"context: this model reads at most {native} tokens")
    return n


def flag_given(words, flag: str) -> bool:
    return any(w == flag or w.startswith(flag + "=") for w in words)


def with_context(args: list[str], n: int) -> list[str]:
    """The engine arguments with `--max-context n`: the last one given replaced, or one added."""
    out = list(args)
    for i in range(len(out) - 1, -1, -1):
        if out[i] == "--max-context" and i + 1 < len(out):
            out[i + 1] = str(n)
            return out
        if out[i].startswith("--max-context="):
            out[i] = f"--max-context={n}"
            return out
    return out + ["--max-context", str(n)]


def with_vision(args: list[str], on: bool) -> list[str]:
    """The engine arguments with the in-engine image encoder on (one bare --vision) or off (none)."""
    out = [w for w in args if w != VISION_FLAG]
    return out + [VISION_FLAG] if on else out


def context_of(args: list[str]) -> int | None:
    """The --max-context the engine arguments give (the last one), None when none does."""
    n = None
    for i, w in enumerate(args):
        if w == "--max-context" and i + 1 < len(args):
            n = args[i + 1]
        elif w.startswith("--max-context="):
            n = w.split("=", 1)[1]
    try:
        return int(n) if n is not None else None
    except ValueError:
        return None
