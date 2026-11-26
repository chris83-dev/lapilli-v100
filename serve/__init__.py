"""Basalt serve: the OpenAI- and Anthropic-compatible server in front of the engine."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LAPILLI_VERSION = "0.6.0"   # (Lapilli) this release; the engine reports its own version, Basalt's (BASALT_VERSION)
