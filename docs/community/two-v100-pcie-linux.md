# Two V100 PCIe on Linux, both in use: a user's report

Reported by **koldfrontier**, November 2026. One dual-Xeon workstation with two 32 GB V100s, both serving one
Qwen3.8-Flash-Next pack to two request slots, on Ubuntu without Docker. It covers three things: Lapilli v0.4 against Strata
on the same machine, v0.5 against v0.4, and direct card-to-card copies (peer access).

These are client-side measurements from one machine with few repeats (medians, ranges where they matter). Small differences
between two columns are noise.

## The machine

| | |
|---|---|
| GPU | 2 x 32 GB V100 (one `Tesla V100-PCIE-32GB`, one `PG500-216`), PCIe 3.0 x16 each, 250 W |
| CPU | 2 x Intel Xeon Gold 6138 (20 cores each), both cards on one NUMA node |
| System RAM | 192 GB DDR4-2666 |
| System | Ubuntu 26.04, kernel 7.0, driver 580.178.04, CUDA Toolkit 12.8, gcc 14.3 as host compiler |
| Build | `-DCMAKE_CUDA_ARCHITECTURES=70 -DBASALT_MODELS=qwen4exp` |
| Options | `--gpu 0,1`, int8 KV, two slots of 262,144 tokens (`slot-full-context`), dynamic vision |

All experts fit in page-locked RAM, so no expert is read from the SSD. The engine reports that it uses AVX2 expert kernels
on this machine ("no AVX-512").

## Lapilli v0.4 against Strata 0.2.16

Same boot, same model: a converted Q5_K_M fine-tune of Qwen3.8-Flash-Next (gate/up experts Q5_K, down experts IQ4_NL). The
GGUF's hyper-connection tensors were converted with `--compat-bf16`; Strata read the GGUF as stored. Strata ran with two
slots and a local change that makes a picture wait for a busy slot.

| | Strata | Lapilli v0.4 |
|---|---:|---:|
| Two streams at once, each | 52.0 tokens/s | **69.8** |
| Two streams at once, together | 88.9 tokens/s | **111.7** |
| First token of the second request | 0.60 s | **0.42 s** |
| 55K-token prompt read beside a stream (including the wait) | 933 tokens/s | **1,011** |
| - longest stall of the other stream | 6.3 s | **0.3 s** |
| 109K-token prompt read beside a stream | 940 tokens/s | **1,084** |
| - longest stall of the other stream | 7.0 s | **0.19 s** |
| 236K-token prompt alone | 1,642 tokens/s | **1,921** |
| First token, short prompt | 0.38 s | **0.12 s** |
| One stream, 256-token answer | **86.1 tokens/s** | 76.3 |
| One stream, reasoning answer | **105.6 tokens/s** | 95.2 |
| 20 number cards, one per request | 18/20 | 18/20 |
| 32 / 128 number cards in one request, read right | **30 / 127** | 29 / 125 |
| - time for 128 cards | 175 s | **80 s** |
| Request errors | 0 | 0 |

The gain is in serving two requests. Alone, the two-slot int8 configuration was slower than Strata; with one slot and fp16
KV, Lapilli matched it (87.0 and 104.9 tokens/s). While a picture is read in its own slot, the other stream stalls for
about 1.3 s; Strata makes the picture wait about 9.6 s instead.

## v0.5 against v0.4

Same boot, same pack and options. The pack is another fine-tune (Q5_K, with Q5_1 down experts), so do not compare the
two tables.

| | v0.4 | v0.5 |
|---|---:|---:|
| Two streams, each / together | 62.7 / 113.4 tokens/s | 62.1 / 112.5 |
| One stream, 256-token answer | 80.7 tokens/s | 79.0 |
| One stream, reasoning answer | 92.2 (84.5-98.1) | 99.8 (81.1-105.1) |
| 109K-token prompt beside a stream / other stream's longest stall | 1,064 tokens/s / 0.24 s | 1,058 / 0.19 s |
| 236K-token prompt alone | 2,046 tokens/s | 2,050 |
| 20 number cards, one per request | 18/20 | 18/20, the same two misses |
| 32 / 128 number cards in one request | 31 / 116 | 29 / 124 |
| Request errors | 0 | 0 |

No measurable difference on this pack. `BASALT_MULTI_V70=auto` gave 64.6 / 115.0 tokens/s for two streams, within the
spread. Greedy answers are not repeatable here: the same v0.4 server matched itself on 5 of 16 prompts, so a greedy text
comparison cannot tell the versions apart.

## Tests on Linux

| | v0.4 | v0.5 |
|---|---:|---:|
| Server tests | 1,124 OK, 3 skipped | 1,137 OK, 3 skipped |
| CPU tests | 81/81 (with `model_layering` fixed locally) | 83/84 (`model_layering`) |
| GPU tests | 106/122 | 111/125 |

- `model_layering` fails on v0.4 and v0.5 for comments in shared code that name a model. It does not affect the build.
- The 14 GPU failures of v0.5 are 14 of v0.4's 16; `gqa_attn_parity` and `gqa_far_parity` now pass.
- By their errors, 12 of them need something a V100 lacks (an `sm_70` kernel image, thread-block clusters, FP8/FP4, the
  fused hyper-connection read).
- Two are bitwise differences between two paths: `prefill_hc_up_mix_test` (BF16), and `dec_moe_parity_kq`, where "combine,
  own wait (landing late)" differs in 16 of 2,560 values on one fixture layer.

## Peer access between two V100s

Lapilli leaves peer access off on Volta because direct copies between two V100s were found to return wrong data. On this
machine a byte-exact test found none:

- [`p2p-integrity`](https://github.com/Cinderella-Man/geforce-dynbar1-p2p) (commit `e5ad35d`, `--max-mib 4096`), a
  byte-exact test of copies, kernel loads and kernel stores both ways: **PASS**, 264 cases, 2,112 transfers, 1,403.6 GiB,
  no mismatch, and no Xid, AER, DMAR or NVRM line in the kernel log.
- `p2pBandwidthLatencyTest`: both ways at once 7.7 GB/s without peer access, **19.5 GB/s** with it; one way 8.8 to
  10.3 GB/s against 10.25; write latency 15 to 71 us against 1.6 us.
- v0.5 with `BASALT_PEER_NO_P2P=0`: the load took 72.6 s and 72.4 s, against 82.3 to 85.5 s in three loads
  without it (one of them v0.4). No clear change in serving speed. The answer checks showed no corruption, but they are
  weak, because greedy answers are not repeatable; the byte-exact test is the evidence.

The cards sit on one NUMA node (`NODE` in `nvidia-smi topo -m`) with `iommu=pt`. This is one board: it does not contradict
the wrong data seen elsewhere, and others should run an integrity test before turning it on.

Back to the [README](../../README.md).
