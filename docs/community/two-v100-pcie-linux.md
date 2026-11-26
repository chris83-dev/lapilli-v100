# Two V100 32 GB cards on Linux: a three-engine comparison

Reported by **nkhaooat**, November 2026. A full weekend of campaigns put Lapilli side by side with Strata and sFNX on
the same two cards, the same Qwen3.8-Flash-Next `UD-Q4_K_XL` backbone and, in the closest run, one identical Q8 n-gram
payload in all three engines. The full report, methodology and machine-readable results live in a separate maintained
repository (links at the bottom); this page is the short version, as the other community reports are.

## The machine

| | |
|---|---|
| GPUs | 2 x Tesla V100 32 GB, both physical PCIe cards on Gen3 x8 links |
| GPU note | the second card runs cross-flashed SXM2 VBIOS, so software reports it as "V100-SXM2-32GB"; same PCIe silicon and form factor |
| Power limits | both cards at their VBIOS defaults throughout: 250 W (PCIe VBIOS), 300 W (SXM2 VBIOS); no thermal throttling recorded |
| Peer access | enabled (AMD IOMMU off); a peer-correctness gate ran inside every campaign |
| CPU | AMD Ryzen 9 7945HX3D |
| System RAM | 96 GB (about 93.5 GiB visible to Linux) |
| OS | Linux |
| Lapilli build | commit `f9b7dd0` (v0.5), binary `sha256 42c67d9e...` |
| Pack | Qwen3.8-Flash-Next `UD-Q4_K_XL` with the Q8 n-gram table, int8 KV cache, 262,144-token context, two slots |

## The test

One frozen suite of 974 trials per arm (966 graded): local tasks, HumanEval, long-context retrieval, concurrency, and an
XML tool-protocol suite, with fixed seeds and positive-temperature sampling. Every GPU arm ran alone in a bounded service
with the cards exclusive; the production stack was stopped and restored around each arm. Engines ran their own best
configurations: Lapilli with MTP8 drafts, sFNX with DFlash2 spec4, Strata with DFlash2 spec4.

## Quality, the closest run

The same backbone and the same Q8 n-gram payload in all three engines. Passes out of 966 graded trials:

| Engine | Passes | local | HumanEval | long ctx | concurrency | tools |
|---|---:|---:|---:|---:|---:|---:|
| Strata DFlash2 Q4 | 864 | 366 | 316 | 6/6 | 16/16 | 160 |
| Lapilli MTP8 | 860 | 363 | 316 | 5/6 | 16/16 | 160 |
| sFNX DFlash2 | 858 | 365 | 314 | 6/6 | 14/16 | 159 |

Six passes separate three complete serving configurations on one sampled suite. Paired, Lapilli and sFNX split 24 to 22.
These gaps sit inside suite noise: the report treats them as a tie and says so.

## Speed, the same run

Solo decode tokens/s (two repeats each); prompt reading on fresh requests at about 35.8K tokens:

| Engine | edit | code | prose | prompt reading | first token at 35.8K |
|---|---:|---:|---:|---:|---:|
| **Lapilli MTP8** | **146.2** | **117.6** | 78.8 | 1,453 tok/s | 24.7 s |
| sFNX DFlash2 | 107.7 | 101.3 | **84.1** | **2,060 tok/s** | **17.5 s** |
| Strata DFlash2 Q4 | 59.5 | 77.1 | 61.4 | 384 tok/s | 93.4 s |

Lapilli led edit and new-code decode and the tested two-client aggregate; sFNX led fresh prompt reading and solo prose.

## What it shows

- **On quality, Lapilli holds its own** against the other two engines on identical payload material, including the tools
  group, where it matched Strata and beat sFNX by one.
- **Edit and code decode is where Lapilli leads clearly** on this box: 146.2 against 107.7 and 59.5 tokens/s.
- **The two-card PCIe box is a real serving platform**: 262K context, two slots, int8 KV, at these rates, with the n-gram
  table read from disk.
- **The suite is honest about ties.** The campaigns ran complete-reviewed arms with pinned binaries and configs; the
  report publishes every failure and capped output as a failure rather than regrading.

## Limits, as the report states them

One machine, one weekend, one sampled suite. Templates, packing, arithmetic, drafter, cache policies and storage
placement still differ between the engines, so nothing here isolates speculation as a cause. The prompt-fixture suite and
raw traces stay private; the public repository publishes curated aggregates, artifact hashes and a shareable prompt-reading
probe instead.

## The full report

- Full report with all campaigns, limitations and artifact pins: [v100-inference-benchmarks v2026.11.26](https://github.com/nkhaooat/v100-inference-benchmarks/blob/v2026.11.26/docs/reports/2026-11-26-v100-comparison.md)
- Machine-readable results: [summary.json](https://github.com/nkhaooat/v100-inference-benchmarks/blob/v2026.11.26/results/2026-11-26/summary.json)
- Methodology and reproduction limits: [methodology.md](https://github.com/nkhaooat/v100-inference-benchmarks/blob/v2026.11.26/docs/methodology.md)

Back to the [README](../../README.md).
