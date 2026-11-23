// src/models/inkling2/kernels/attn_prompt.cu - Inkling 2's prompt attention: a chunk's rows against every key before them,
// flash style on the tensor cores, with each query's relative bias over the last kExtent positions and its sink.
//
// A block takes kPos positions of the chunk and one key/value head. Its rows are the group's three query heads over those
// positions, head-major: warp w owns query head w / kWarpsPerHead of the group at 16 consecutive positions. Keys stream through shared
// memory in tiles of kKeys. S = Q K^T runs on fp16 tensor cores with fp32 accumulation. The relative bias of a warp's rows
// against a tile is one more product, R (the rows' relative states) times the band of the bias table the tile's distances
// span, moved through shared memory into the scores' layout. The softmax is online in fp32 (base 2), O += P V runs on fp16
// tensor cores with fp32 accumulation, and the sink joins the denominator at the end. A key at or after the chunk's first
// position comes from the chunk's own buffer (a full layer's cache, a sliding-window layer's stage), an earlier one from
// the cache (a window ring or the full cache).
#include "basalt/kernels/volta_compat.cuh"
#include "basalt/models/inkling2/prompt_kernels.hpp"

#include <cuda_fp16.h>
#include <cuda_fp8.h>
#include <cuda_runtime.h>
#include <mma.h>

#include <cmath>
#include <cstdlib>
#include <stdexcept>
#include <string>

namespace basalt::models::inkling2 {
namespace {

constexpr int kPos = 64;                  // positions a block
constexpr int kWarpsPerHead = kPos / 16;  // 16 positions a warp
constexpr int kWarps = 3 * kWarpsPerHead;
constexpr int kThreads = kWarps * 32;
constexpr int kKeys = 32;                 // keys a tile
constexpr int kLd = kHeadDim + 8;         // padded fp16 row of a key tile (halves): ldmatrix without bank conflicts
constexpr int kBand = 96;                 // band rows: the distances a tile spans for the block (kPos + kKeys - 1)
constexpr int kBandLd = kRel + 8;         // padded band row (halves)
constexpr int kGCols = 48;                // distances a warp's rows span against a tile (16 + kKeys - 1), whole n-tiles
constexpr int kGLd = 55;                  // padded row of the exchanged bias (floats): two-way bank conflicts at most
constexpr float kLog2e = 1.4426950408889634f;
static_assert(kBand >= kPos + kKeys - 1 && kGCols >= 16 + kKeys - 1 && kGCols % 8 == 0 && kGLd >= kGCols, "band sizes");

struct KvTile {
    __half k[kKeys][kLd];
    __half v[kKeys][kLd];
};
// A tile beyond the bias's reach needs neither the band nor the exchange, so the next such tile streams into the
// exchange's room while the block works on the current one.
struct Smem {
    KvTile t0;
    __half band[kBand][kBandLd];
    union {
        KvTile t1;
        float gx[kWarps][16][kGLd];
    } u;
};
static_assert(sizeof(KvTile) <= sizeof(float) * kWarps * 16 * kGLd, "the second tile fits in the exchange");

void check(const char* what) {
    const cudaError_t e = cudaGetLastError();
    if (e != cudaSuccess) throw std::runtime_error(std::string("inkling2 ") + what + ": " + cudaGetErrorString(e));
}

__device__ __forceinline__ unsigned smem_u32(const void* p) { return (unsigned) __cvta_generic_to_shared(p); }
// ldmatrix is sm_75 and mma.m16n8k16 sm_80: on Volta the fork's volta_compat emulation provides them (the fork's
// gqa_attn and window-gemm kernels take the same route), and cp.async's copies become synchronous shared stores
__device__ __forceinline__ void ldsm_x2(unsigned& r0, unsigned& r1, const void* p) {
    uint32_t r[2];
    basalt::volta::ldsm<2, false>(r, smem_u32(p));
    r0 = r[0]; r1 = r[1];
}
__device__ __forceinline__ void ldsm_x4(unsigned& r0, unsigned& r1, unsigned& r2, unsigned& r3, const void* p) {
    uint32_t r[4];
    basalt::volta::ldsm<4, false>(r, smem_u32(p));
    r0 = r[0]; r1 = r[1]; r2 = r[2]; r3 = r[3];
}
__device__ __forceinline__ void ldsm_x4_t(unsigned& r0, unsigned& r1, unsigned& r2, unsigned& r3, const void* p) {
    uint32_t r[4];
    basalt::volta::ldsm<4, true>(r, smem_u32(p));
    r0 = r[0]; r1 = r[1]; r2 = r[2]; r3 = r[3];
}
__device__ __forceinline__ void mma16816(float (&c)[4], unsigned a0, unsigned a1, unsigned a2, unsigned a3, unsigned b0,
                                         unsigned b1) {
    const uint32_t a[4] = {a0, a1, a2, a3}, b[2] = {b0, b1};
    const float cin[4] = {c[0], c[1], c[2], c[3]};
    basalt::volta::mma_m16n8k16_f32<false>(c, a, b, cin);
}
__device__ __forceinline__ void cp16(void* dst, const void* src, bool ok) {
    basalt::volta::cp_async_cg16(smem_u32(dst), src, ok ? 16 : 0);
}
__device__ __forceinline__ unsigned pack_h2(float lo, float hi) {
    const __half2 h = __floats2half2_rn(lo, hi);
    return *reinterpret_cast<const unsigned*>(&h);
}
__device__ __forceinline__ float quad_max(float v) {
    v = fmaxf(v, __shfl_xor_sync(0xffffffffu, v, 1));
    return fmaxf(v, __shfl_xor_sync(0xffffffffu, v, 2));
}
__device__ __forceinline__ float quad_sum(float v) {
    v += __shfl_xor_sync(0xffffffffu, v, 1);
    return v + __shfl_xor_sync(0xffffffffu, v, 2);
}
// Two E4M3 codes as an fp16 pair (exact).
__device__ __forceinline__ uint32_t e4m3x2_to_h2(uint16_t u) {
    const __half2_raw h = __nv_cvt_fp8x2_to_halfraw2((__nv_fp8x2_storage_t) u, __NV_E4M3);
    return (uint32_t) h.x | ((uint32_t) h.y << 16);
}

// One tile of keys and values into shared memory: key k0 + j at row j, zero outside [lo, hi].  fp16 tiles are requested
// (cp.async, the caller commits and waits), E4M3 tiles converted and stored before the return.
template <bool FP8, int NT = kThreads>
__device__ __forceinline__ void load_tile(const AttnPromptArgs& a, KvTile& sm, int kvh, int64_t k0, int64_t lo, int64_t hi, int tid) {
    if constexpr (!FP8) {
        constexpr int kPieces = kKeys * kHeadDim / 8;   // 16-byte pieces of one tile
        for (int c = tid; c < 2 * kPieces; c += NT) {
            const bool isv = c >= kPieces;
            const int rem = isv ? c - kPieces : c;
            const int j = rem / (kHeadDim / 8), col = (rem % (kHeadDim / 8)) * 8;
            const int64_t key = k0 + j;
            const bool ok = key >= lo && key <= hi;
            const bool fresh = key >= a.pos0;
            const int64_t cap = fresh ? a.chunk_cap : a.cap;
            const __half* base = static_cast<const __half*>(fresh ? (isv ? a.v_chunk : a.k_chunk) : (isv ? a.v_cache : a.k_cache));
            const __half* src = base + ((size_t) (ok ? key % cap : 0) * kKvHeads + kvh) * kHeadDim + col;
            cp16(isv ? &sm.v[j][col] : &sm.k[j][col], src, ok);
        }
    } else {
        constexpr int kPieces = kKeys * kHeadDim / 16;  // 16 codes a piece
        for (int c = tid; c < 2 * kPieces; c += NT) {
            const bool isv = c >= kPieces;
            const int rem = isv ? c - kPieces : c;
            const int j = rem / (kHeadDim / 16), col = (rem % (kHeadDim / 16)) * 16;
            const int64_t key = k0 + j;
            const bool ok = key >= lo && key <= hi;
            uint4 u = make_uint4(0u, 0u, 0u, 0u);
            if (ok) {
                const bool fresh = key >= a.pos0;
                const int64_t cap = fresh ? a.chunk_cap : a.cap;
                const uint8_t* base = static_cast<const uint8_t*>(fresh ? (isv ? a.v_chunk : a.k_chunk) : (isv ? a.v_cache : a.k_cache));
                u = *reinterpret_cast<const uint4*>(base + ((size_t) (key % cap) * kKvHeads + kvh) * kHeadDim + col);
            }
            const uint32_t w[4] = {u.x, u.y, u.z, u.w};
            uint32_t h[8];
#pragma unroll
            for (int i = 0; i < 4; ++i) {
                h[2 * i] = e4m3x2_to_h2((uint16_t) (w[i] & 0xFFFFu));
                h[2 * i + 1] = e4m3x2_to_h2((uint16_t) (w[i] >> 16));
            }
            __half* dst = isv ? &sm.v[j][col] : &sm.k[j][col];
            *reinterpret_cast<uint4*>(dst) = make_uint4(h[0], h[1], h[2], h[3]);
            *reinterpret_cast<uint4*>(dst + 8) = make_uint4(h[4], h[5], h[6], h[7]);
        }
    }
}

template <bool FP8>
__global__ void __launch_bounds__(kThreads, 1) attn_prompt_kernel(const AttnPromptArgs a, const int rows, float* __restrict__ out) {
    extern __shared__ __align__(16) unsigned char smem_raw[];
    Smem& sm = *reinterpret_cast<Smem*>(smem_raw);
    const int tid = threadIdx.x, lane = tid & 31, w = tid >> 5;
    const int g = lane >> 2, tq = lane & 3;
    const int kvh = blockIdx.y;
    const int i0 = (int) (gridDim.x - 1 - blockIdx.x) * kPos;   // the block's first row: the blocks with the most keys first
    const int64_t q0 = a.pos0 + i0;
    const int head = kvh * 3 + w / kWarpsPerHead;
    const int jw = (w % kWarpsPerHead) * 16;                     // the warp's first position in the block
    const int64_t pw = q0 + jw;
    const int ia = i0 + jw + g, ib = ia + 8;                     // the thread's two rows
    const bool va = ia < rows, vb = ib < rows;
    const int64_t hi = a.pos0 + min(rows, i0 + kPos) - 1;        // the block's last position: its last key
    const int64_t lo = a.window > 0 ? max((int64_t) 0, q0 - a.window + 1) : 0;   // its first key

    // the rows' queries and relative states as fp16 fragments (rows past the chunk read row 0 and are never stored)
    uint32_t qf[kHeadDim / 16][4], rf[4];
    {
        const float* qa = a.q + ((size_t) (va ? ia : 0) * kHeads + head) * kHeadDim + 2 * tq;
        const float* qb = a.q + ((size_t) (vb ? ib : 0) * kHeads + head) * kHeadDim + 2 * tq;
#pragma unroll
        for (int kk = 0; kk < kHeadDim / 16; ++kk) {
            const float2 x0 = *reinterpret_cast<const float2*>(qa + 16 * kk);
            const float2 x1 = *reinterpret_cast<const float2*>(qb + 16 * kk);
            const float2 x2 = *reinterpret_cast<const float2*>(qa + 16 * kk + 8);
            const float2 x3 = *reinterpret_cast<const float2*>(qb + 16 * kk + 8);
            qf[kk][0] = pack_h2(x0.x, x0.y);
            qf[kk][1] = pack_h2(x1.x, x1.y);
            qf[kk][2] = pack_h2(x2.x, x2.y);
            qf[kk][3] = pack_h2(x3.x, x3.y);
        }
        const float* ra = a.r + ((size_t) (va ? ia : 0) * kHeads + head) * kRel + 2 * tq;
        const float* rb = a.r + ((size_t) (vb ? ib : 0) * kHeads + head) * kRel + 2 * tq;
        rf[0] = pack_h2(ra[0], ra[1]);
        rf[1] = pack_h2(rb[0], rb[1]);
        rf[2] = pack_h2(ra[8], ra[9]);
        rf[3] = pack_h2(rb[8], rb[9]);
    }

    float o[kHeadDim / 8][4];
#pragma unroll
    for (int n = 0; n < kHeadDim / 8; ++n) o[n][0] = o[n][1] = o[n][2] = o[n][3] = 0.f;
    float m_a = -INFINITY, m_b = -INFINITY, l_a = 0.f, l_b = 0.f;
    const float scale2 = a.scale * kLog2e;
    float (*gx)[kGLd] = sm.u.gx[w];

    // a tile is far when no distance of the block's rows to its keys reaches below kExtent: no bias, no band, no exchange
    // (Lapilli) not `far`: Windows' minwindef.h defines it as an empty macro
    const auto far_tile = [&](int64_t k0) { return q0 - k0 - (kKeys - 1) >= kExtent; };
    int cur = 0;          // the room the current tile is in (1: the exchange's)
    bool ready = false;   // the current tile was requested during the tile before
    for (int64_t k0 = lo / kKeys * kKeys; k0 <= hi; k0 += kKeys) {
        __syncthreads();   // every warp is done with the previous tile
        if (!ready) {
            cur = 0;
            load_tile<FP8>(a, sm.t0, kvh, k0, lo, hi, tid);
            basalt::volta::cp_async_commit();
        }
        // a far tile followed by a far tile: the next one is requested into the other room before this one is used
        const bool next = !FP8 && far_tile(k0) && k0 + kKeys <= hi && far_tile(k0 + kKeys);
        if (next) {
            load_tile<FP8>(a, cur ? sm.t0 : sm.u.t1, kvh, k0 + kKeys, lo, hi, tid);
            basalt::volta::cp_async_commit();
            basalt::volta::cp_async_wait<1>();
        } else {
            basalt::volta::cp_async_wait<0>();
        }
        const KvTile& kt = cur ? sm.u.t1 : sm.t0;
        ready = next;
        if (next) cur ^= 1;
        // the bias band: row b holds the table's column d = q0 - k0 - (kKeys - 1) + b, zero outside [0, kExtent)
        if (!far_tile(k0))
            for (int idx = tid; idx < kBand * kRel; idx += kThreads) {
                const int t = idx / kBand, b = idx % kBand;
                const int64_t d = q0 - k0 - (kKeys - 1) + b;
                sm.band[b][t] = __float2half_rn(d >= 0 && d < kExtent ? a.rel_table[(size_t) t * kExtent + d] : 0.f);
            }
        __syncthreads();

        // a warp none of whose rows sees a key of the tile skips it; one whose rows see every key needs no mask
        const int64_t p_first = pw, p_last = pw + 15;
        if (k0 > p_last || (a.window > 0 && k0 + kKeys - 1 <= p_first - a.window)) continue;
        const bool whole = k0 + kKeys - 1 <= p_first && (a.window <= 0 || k0 > p_last - a.window);

        // S = Q K^T
        float s[kKeys / 8][4];
#pragma unroll
        for (int n = 0; n < kKeys / 8; ++n) s[n][0] = s[n][1] = s[n][2] = s[n][3] = 0.f;
#pragma unroll
        for (int kk = 0; kk < kHeadDim / 16; ++kk) {
#pragma unroll
            for (int n = 0; n < kKeys / 8; n += 2) {
                unsigned b0, b1, b2, b3;
                ldsm_x4(b0, b1, b2, b3, &kt.k[n * 8 + (lane & 7) + ((lane >> 4) << 3)][kk * 16 + ((lane >> 3) & 1) * 8]);
                mma16816(s[n], qf[kk][0], qf[kk][1], qf[kk][2], qf[kk][3], b0, b1);
                mma16816(s[n + 1], qf[kk][0], qf[kk][1], qf[kk][2], qf[kk][3], b2, b3);
            }
        }
        // the scores in base 2 with the bias: G[j][c] = r_j . table[:, pw - k0 - (kKeys - 1) + c] for the warp's rows j,
        // and key k0 + kk of row j sits at c = j - kk + kKeys - 1
        if (p_first - (k0 + kKeys - 1) < kExtent) {
            float ga[kGCols / 8][4];
#pragma unroll
            for (int nt = 0; nt < kGCols / 8; ++nt) {
                ga[nt][0] = ga[nt][1] = ga[nt][2] = ga[nt][3] = 0.f;
                unsigned b0, b1;
                ldsm_x2(b0, b1, &sm.band[jw + nt * 8 + (lane & 7)][((lane >> 3) & 1) * 8]);
                mma16816(ga[nt], rf[0], rf[1], rf[2], rf[3], b0, b1);
            }
#pragma unroll
            for (int nt = 0; nt < kGCols / 8; ++nt) {
                gx[g][nt * 8 + 2 * tq] = ga[nt][0];
                gx[g][nt * 8 + 2 * tq + 1] = ga[nt][1];
                gx[g + 8][nt * 8 + 2 * tq] = ga[nt][2];
                gx[g + 8][nt * 8 + 2 * tq + 1] = ga[nt][3];
            }
            __syncwarp();
#pragma unroll
            for (int n = 0; n < kKeys / 8; ++n)
#pragma unroll
                for (int e = 0; e < 4; ++e) {
                    const int j = g + (e >> 1) * 8, kk = n * 8 + 2 * tq + (e & 1);
                    s[n][e] = fmaf(s[n][e], scale2, gx[j][j - kk + kKeys - 1] * kLog2e);
                }
            __syncwarp();
        } else {
#pragma unroll
            for (int n = 0; n < kKeys / 8; ++n)
#pragma unroll
                for (int e = 0; e < 4; ++e) s[n][e] *= scale2;
        }
        if (!whole) {
#pragma unroll
            for (int n = 0; n < kKeys / 8; ++n)
#pragma unroll
                for (int e = 0; e < 4; ++e) {
                    const int64_t key = k0 + n * 8 + 2 * tq + (e & 1), p = pw + g + (e >> 1) * 8;
                    if (key > p || (a.window > 0 && key <= p - a.window)) s[n][e] = -INFINITY;
                }
        }
        // the online softmax: rows a (s[n][0..1]) and b (s[n][2..3])
        float mx_a = m_a, mx_b = m_b;
#pragma unroll
        for (int n = 0; n < kKeys / 8; ++n) {
            mx_a = fmaxf(mx_a, fmaxf(s[n][0], s[n][1]));
            mx_b = fmaxf(mx_b, fmaxf(s[n][2], s[n][3]));
        }
        mx_a = quad_max(mx_a);
        mx_b = quad_max(mx_b);
        const float ca = mx_a == -INFINITY ? 1.f : exp2f(m_a - mx_a), cb = mx_b == -INFINITY ? 1.f : exp2f(m_b - mx_b);
        m_a = mx_a;
        m_b = mx_b;
        float ps_a = 0.f, ps_b = 0.f;
#pragma unroll
        for (int n = 0; n < kKeys / 8; ++n) {
            s[n][0] = s[n][0] == -INFINITY ? 0.f : exp2f(s[n][0] - m_a);
            s[n][1] = s[n][1] == -INFINITY ? 0.f : exp2f(s[n][1] - m_a);
            s[n][2] = s[n][2] == -INFINITY ? 0.f : exp2f(s[n][2] - m_b);
            s[n][3] = s[n][3] == -INFINITY ? 0.f : exp2f(s[n][3] - m_b);
            ps_a += s[n][0] + s[n][1];
            ps_b += s[n][2] + s[n][3];
        }
        l_a = l_a * ca + ps_a;
        l_b = l_b * cb + ps_b;
#pragma unroll
        for (int n = 0; n < kHeadDim / 8; ++n) {
            o[n][0] *= ca;
            o[n][1] *= ca;
            o[n][2] *= cb;
            o[n][3] *= cb;
        }
        // O += P V
        unsigned pf[kKeys / 16][4];
#pragma unroll
        for (int j = 0; j < kKeys / 16; ++j) {
            pf[j][0] = pack_h2(s[2 * j][0], s[2 * j][1]);
            pf[j][1] = pack_h2(s[2 * j][2], s[2 * j][3]);
            pf[j][2] = pack_h2(s[2 * j + 1][0], s[2 * j + 1][1]);
            pf[j][3] = pack_h2(s[2 * j + 1][2], s[2 * j + 1][3]);
        }
#pragma unroll
        for (int n = 0; n < kHeadDim / 8; n += 2)
#pragma unroll
            for (int j = 0; j < kKeys / 16; ++j) {
                unsigned b0, b1, b2, b3;
                ldsm_x4_t(b0, b1, b2, b3, &kt.v[j * 16 + (lane & 15)][n * 8 + (lane >> 4) * 8]);
                mma16816(o[n], pf[j][0], pf[j][1], pf[j][2], pf[j][3], b0, b1);
                mma16816(o[n + 1], pf[j][0], pf[j][1], pf[j][2], pf[j][3], b2, b3);
            }
    }

    // the sink beside the keys, then the rows out
    l_a = quad_sum(l_a);
    l_b = quad_sum(l_b);
    const float sa = va ? a.sink[(size_t) ia * kHeads + head] * kLog2e : 0.f;
    const float sb = vb ? a.sink[(size_t) ib * kHeads + head] * kLog2e : 0.f;
    const float ma = fmaxf(m_a, sa), mb = fmaxf(m_b, sb);
    const float fa = exp2f(m_a - ma), fb = exp2f(m_b - mb);
    const float inv_a = fa / (l_a * fa + exp2f(sa - ma)), inv_b = fb / (l_b * fb + exp2f(sb - mb));
#pragma unroll
    for (int n = 0; n < kHeadDim / 8; ++n) {
        const int col = n * 8 + 2 * tq;
        if (va) *reinterpret_cast<float2*>(out + ((size_t) ia * kHeads + head) * kHeadDim + col) = make_float2(o[n][0] * inv_a, o[n][1] * inv_a);
        if (vb) *reinterpret_cast<float2*>(out + ((size_t) ib * kHeads + head) * kHeadDim + col) = make_float2(o[n][2] * inv_b, o[n][3] * inv_b);
    }
}

// ---------------------------------------------------------------- (Lapilli, V100) the prompt on Volta's tensor cores
// attn_prompt_v70_kernel: attn_prompt_kernel's arithmetic on nvcuda::wmma 16x16x16 (fp16 in, fp32 accumulate), the V100's own
// tensor cores, where the m16n8k16 mma and ldmatrix above are emulated with shuffles and FMAs (2.4 TFLOP/s: 46 % of a 16K
// prompt's GPU time on a V100). The same tiles of kKeys keys at absolute multiples of kKeys and the same steps for a row
// (S = Q K^T, the bias G = R band, the masks, the online softmax in base 2, O = O c + P V, the sink at the end), so a row's
// bits do not depend on the chunk it is read in; another rounding than the emulated kernel (the tensor cores' order of a
// 16-deep product). A block is kPos70 positions x the group's 3 heads, 6 warps of 16 rows (half the emulated kernel's
// positions: Q in shared memory beside the warps' G and P). Volta's WMMA accumulator layout (measured for the 27B,
// gqa_attn.cu): element e of a lane is row r0 + (e & 2), column 8 ((lane >> 3) & 1) + 4 (e >> 2) + (lane & 2) + (e & 1),
// r0 = (lane & 1) + 8 ((lane >> 2) & 1) + 4 ((lane >> 4) & 1); the 4 lanes of a row differ in bits 1 and 3.
constexpr int kPos70 = 32;                  // positions a block
constexpr int kWph70 = kPos70 / 16;         // warps a head
constexpr int kWarps70 = 3 * kWph70;
constexpr int kThreads70 = kWarps70 * 32;
constexpr int kRows70 = 3 * kPos70;
constexpr int kGCols70 = 48;                // the distances a warp's rows span against a tile (16 + kKeys - 1): three tiles of 16
constexpr int kBand70 = kPos70 - 16 + kGCols70;   // band rows: warp jw reads jw .. jw + kGCols70 - 1
constexpr int kRLd70 = kRel + 8;            // halves
constexpr int kPLd70 = kKeys + 8;           // halves
static_assert(kGCols70 >= 16 + kKeys - 1 && kGCols70 % 16 == 0 && kKeys % 16 == 0, "v70 tile sizes");
static_assert(kRel == 16, "G = R band is one 16-deep WMMA step");

union alignas(32) WarpX70 {   // a warp's G (read into its scores), then its P (written after)
    float g[16][kGCols70];
    __half p[16][kPLd70];
};
struct alignas(32) Smem70 {
    alignas(32) __half q[kRows70][kLd];     // warp w's 16 rows at 16 w, fp16 (as the emulated kernel's fragments)
    alignas(32) __half r[kRows70][kRLd70];  // their relative states
    alignas(32) KvTile t;
    alignas(32) __half band[kBand70][kBandLd];
    WarpX70 x[kWarps70];
};

// the column (key or dimension) of accumulator element e of this lane, within its 16x16 tile
__device__ __forceinline__ int acc_col70(int lane, int e) { return 8 * ((lane >> 3) & 1) + 4 * (e >> 2) + (lane & 2) + (e & 1); }

template <bool FP8>
__global__ void __launch_bounds__(kThreads70, 1) attn_prompt_v70_kernel(const AttnPromptArgs a, const int rows, float* __restrict__ out) {
    using namespace nvcuda;
    extern __shared__ __align__(32) unsigned char smem_raw[];
    Smem70& sm = *reinterpret_cast<Smem70*>(smem_raw);
    const int tid = threadIdx.x, lane = tid & 31, w = tid >> 5;
    const int kvh = blockIdx.y;
    const int i0 = (int) (gridDim.x - 1 - blockIdx.x) * kPos70;   // the block's first row: the blocks with the most keys first
    const int64_t q0 = a.pos0 + i0;
    const int head = kvh * 3 + w / kWph70;
    const int jw = (w % kWph70) * 16;                              // the warp's first position in the block
    const int64_t pw = q0 + jw;
    const int r0 = (lane & 1) + 8 * ((lane >> 2) & 1) + 4 * ((lane >> 4) & 1);
    const int ia = i0 + jw + r0, ib = ia + 2;                      // the lane's two rows (elements 0, 1, 4, 5 and 2, 3, 6, 7)
    const bool va = ia < rows, vb = ib < rows;
    const int64_t hi = a.pos0 + min(rows, i0 + kPos70) - 1;        // the block's last position: its last key
    const int64_t lo = a.window > 0 ? max((int64_t) 0, q0 - a.window + 1) : 0;   // its first key

    // the block's queries and relative states in fp16 (rows past the chunk read row 0 and are never stored)
    for (int idx = tid; idx < kRows70 * kHeadDim / 2; idx += kThreads70) {
        const int rr = idx / (kHeadDim / 2), c = (idx % (kHeadDim / 2)) * 2, ww = rr / 16;
        const int irow = i0 + (ww % kWph70) * 16 + rr % 16, hh = kvh * 3 + ww / kWph70;
        const float2 x = *reinterpret_cast<const float2*>(a.q + ((size_t) (irow < rows ? irow : 0) * kHeads + hh) * kHeadDim + c);
        *reinterpret_cast<__half2*>(&sm.q[rr][c]) = __floats2half2_rn(x.x, x.y);
    }
    for (int idx = tid; idx < kRows70 * kRel / 2; idx += kThreads70) {
        const int rr = idx / (kRel / 2), c = (idx % (kRel / 2)) * 2, ww = rr / 16;
        const int irow = i0 + (ww % kWph70) * 16 + rr % 16, hh = kvh * 3 + ww / kWph70;
        const float2 x = *reinterpret_cast<const float2*>(a.r + ((size_t) (irow < rows ? irow : 0) * kHeads + hh) * kRel + c);
        *reinterpret_cast<__half2*>(&sm.r[rr][c]) = __floats2half2_rn(x.x, x.y);
    }

    wmma::fragment<wmma::accumulator, 16, 16, 16, float> fo[kHeadDim / 16];
#pragma unroll
    for (int n = 0; n < kHeadDim / 16; ++n) wmma::fill_fragment(fo[n], 0.0f);
    float m_a = -INFINITY, m_b = -INFINITY, l_a = 0.f, l_b = 0.f;   // l: this lane's share of its rows' sums
    const float scale2 = a.scale * kLog2e;
    WarpX70& wx = sm.x[w];

    const auto far_tile = [&](int64_t k0) { return q0 - k0 - (kKeys - 1) >= kExtent; };
    for (int64_t k0 = lo / kKeys * kKeys; k0 <= hi; k0 += kKeys) {
        __syncthreads();   // every warp is done with the previous tile (and the queries are written)
        load_tile<FP8, kThreads70>(a, sm.t, kvh, k0, lo, hi, tid);
        basalt::volta::cp_async_commit();
        basalt::volta::cp_async_wait<0>();
        // the bias band: row b holds the table's column d = q0 - k0 - (kKeys - 1) + b, zero outside [0, kExtent)
        if (!far_tile(k0))
            for (int idx = tid; idx < kBand70 * kRel; idx += kThreads70) {
                const int t = idx / kBand70, b = idx % kBand70;
                const int64_t d = q0 - k0 - (kKeys - 1) + b;
                sm.band[b][t] = __float2half_rn(d >= 0 && d < kExtent ? a.rel_table[(size_t) t * kExtent + d] : 0.f);
            }
        __syncthreads();

        // a warp none of whose rows sees a key of the tile skips it; one whose rows see every key needs no mask
        const int64_t p_first = pw, p_last = pw + 15;
        if (k0 > p_last || (a.window > 0 && k0 + kKeys - 1 <= p_first - a.window)) continue;
        const bool whole = k0 + kKeys - 1 <= p_first && (a.window <= 0 || k0 > p_last - a.window);

        // S = Q K^T: the warp's 16 rows against keys 0..15 and 16..31 of the tile
        wmma::fragment<wmma::accumulator, 16, 16, 16, float> fs[kKeys / 16];
#pragma unroll
        for (int ct = 0; ct < kKeys / 16; ++ct) wmma::fill_fragment(fs[ct], 0.0f);
#pragma unroll
        for (int kk = 0; kk < kHeadDim; kk += 16) {
            wmma::fragment<wmma::matrix_a, 16, 16, 16, __half, wmma::row_major> fa;
            wmma::load_matrix_sync(fa, &sm.q[w * 16][kk], kLd);
#pragma unroll
            for (int ct = 0; ct < kKeys / 16; ++ct) {
                wmma::fragment<wmma::matrix_b, 16, 16, 16, __half, wmma::col_major> fb;
                wmma::load_matrix_sync(fb, &sm.t.k[ct * 16][kk], kLd);
                wmma::mma_sync(fs[ct], fa, fb, fs[ct]);
            }
        }
        // the scores in base 2 with the bias: G[j][c] = r_j . band[jw + c], and key kk of row j sits at c = j - kk + kKeys - 1
        if (p_first - (k0 + kKeys - 1) < kExtent) {
            wmma::fragment<wmma::matrix_a, 16, 16, 16, __half, wmma::row_major> fr;
            wmma::load_matrix_sync(fr, &sm.r[w * 16][0], kRLd70);
#pragma unroll
            for (int nt = 0; nt < kGCols70 / 16; ++nt) {
                wmma::fragment<wmma::matrix_b, 16, 16, 16, __half, wmma::col_major> fb;
                wmma::load_matrix_sync(fb, &sm.band[jw + nt * 16][0], kBandLd);
                wmma::fragment<wmma::accumulator, 16, 16, 16, float> fg;
                wmma::fill_fragment(fg, 0.0f);
                wmma::mma_sync(fg, fr, fb, fg);
                wmma::store_matrix_sync(&wx.g[0][nt * 16], fg, kGCols70, wmma::mem_row_major);
            }
            __syncwarp();
#pragma unroll
            for (int ct = 0; ct < kKeys / 16; ++ct)
#pragma unroll
                for (int e = 0; e < 8; ++e) {
                    const int j = r0 + (e & 2), kk = 16 * ct + acc_col70(lane, e);
                    fs[ct].x[e] = fmaf(fs[ct].x[e], scale2, wx.g[j][j - kk + kKeys - 1] * kLog2e);
                }
        } else {
#pragma unroll
            for (int ct = 0; ct < kKeys / 16; ++ct)
#pragma unroll
                for (int e = 0; e < 8; ++e) fs[ct].x[e] *= scale2;
        }
        if (!whole) {
#pragma unroll
            for (int ct = 0; ct < kKeys / 16; ++ct)
#pragma unroll
                for (int e = 0; e < 8; ++e) {
                    const int64_t key = k0 + 16 * ct + acc_col70(lane, e), p = pw + r0 + (e & 2);
                    if (key > p || (a.window > 0 && key <= p - a.window)) fs[ct].x[e] = -INFINITY;
                }
        }
        // the online softmax: rows a (elements 0, 1, 4, 5) and b (2, 3, 6, 7), a row's 4 lanes in bits 1 and 3
        float mx_a = m_a, mx_b = m_b;
#pragma unroll
        for (int ct = 0; ct < kKeys / 16; ++ct)
#pragma unroll
            for (int e = 0; e < 8; ++e) {
                if (e & 2) mx_b = fmaxf(mx_b, fs[ct].x[e]);
                else mx_a = fmaxf(mx_a, fs[ct].x[e]);
            }
        mx_a = fmaxf(mx_a, __shfl_xor_sync(0xffffffffu, mx_a, 2));
        mx_a = fmaxf(mx_a, __shfl_xor_sync(0xffffffffu, mx_a, 8));
        mx_b = fmaxf(mx_b, __shfl_xor_sync(0xffffffffu, mx_b, 2));
        mx_b = fmaxf(mx_b, __shfl_xor_sync(0xffffffffu, mx_b, 8));
        const float ca = mx_a == -INFINITY ? 1.f : exp2f(m_a - mx_a), cb = mx_b == -INFINITY ? 1.f : exp2f(m_b - mx_b);
        m_a = mx_a;
        m_b = mx_b;
        __syncwarp();   // G is read: the warp's room takes P
        float ps_a = 0.f, ps_b = 0.f;
#pragma unroll
        for (int ct = 0; ct < kKeys / 16; ++ct)
#pragma unroll
            for (int e = 0; e < 8; ++e) {
                const float v = fs[ct].x[e];
                const float pr = v == -INFINITY ? 0.f : exp2f(v - ((e & 2) ? m_b : m_a));
                if (e & 2) ps_b += pr;
                else ps_a += pr;
                wx.p[r0 + (e & 2)][16 * ct + acc_col70(lane, e)] = __float2half_rn(pr);
            }
        l_a = l_a * ca + ps_a;
        l_b = l_b * cb + ps_b;
#pragma unroll
        for (int n = 0; n < kHeadDim / 16; ++n)
#pragma unroll
            for (int e = 0; e < 8; ++e) fo[n].x[e] *= (e & 2) ? cb : ca;
        __syncwarp();
        // O += P V
#pragma unroll
        for (int ks = 0; ks < kKeys; ks += 16) {
            wmma::fragment<wmma::matrix_a, 16, 16, 16, __half, wmma::row_major> fp;
            wmma::load_matrix_sync(fp, &wx.p[0][ks], kPLd70);
#pragma unroll
            for (int n = 0; n < kHeadDim / 16; ++n) {
                wmma::fragment<wmma::matrix_b, 16, 16, 16, __half, wmma::row_major> fv;
                wmma::load_matrix_sync(fv, &sm.t.v[ks][n * 16], kLd);
                wmma::mma_sync(fo[n], fp, fv, fo[n]);
            }
        }
    }

    // the sink beside the keys, then the rows out
    l_a += __shfl_xor_sync(0xffffffffu, l_a, 2);
    l_a += __shfl_xor_sync(0xffffffffu, l_a, 8);
    l_b += __shfl_xor_sync(0xffffffffu, l_b, 2);
    l_b += __shfl_xor_sync(0xffffffffu, l_b, 8);
    const float sa = va ? a.sink[(size_t) ia * kHeads + head] * kLog2e : 0.f;
    const float sb = vb ? a.sink[(size_t) ib * kHeads + head] * kLog2e : 0.f;
    const float ma = fmaxf(m_a, sa), mb = fmaxf(m_b, sb);
    const float fa = exp2f(m_a - ma), fb = exp2f(m_b - mb);
    const float inv_a = fa / (l_a * fa + exp2f(sa - ma)), inv_b = fb / (l_b * fb + exp2f(sb - mb));
#pragma unroll
    for (int n = 0; n < kHeadDim / 16; ++n)
#pragma unroll
        for (int e = 0; e < 8; e += 2) {
            const int col = 16 * n + acc_col70(lane, e);
            if (e & 2) {
                if (vb) *reinterpret_cast<float2*>(out + ((size_t) ib * kHeads + head) * kHeadDim + col) =
                            make_float2(fo[n].x[e] * inv_b, fo[n].x[e + 1] * inv_b);
            } else if (va) {
                *reinterpret_cast<float2*>(out + ((size_t) ia * kHeads + head) * kHeadDim + col) =
                    make_float2(fo[n].x[e] * inv_a, fo[n].x[e + 1] * inv_a);
            }
        }
}

// (Lapilli) the current card is a Volta (compute capability 7.x) and BASALT_INK_ATTN_V70 is not 0 (read once): the prompt
// runs attn_prompt_v70_kernel there (=0: the emulated kernel, to compare)
bool prompt_v70() {
    static const bool off = [] {
        const char* e = std::getenv("BASALT_INK_ATTN_V70");
        return e != nullptr && e[0] == '0' && e[1] == 0;
    }();
    if (off) return false;
    static int cc[kOptInDevices] = {};
    const int d = opt_in_device();
    if (cc[d] == 0) {
        int dev = 0, major = 0;
        if (cudaGetDevice(&dev) != cudaSuccess || cudaDeviceGetAttribute(&major, cudaDevAttrComputeCapabilityMajor, dev) != cudaSuccess) {
            (void) cudaGetLastError();
            major = -1;
        }
        cc[d] = major;
    }
    return cc[d] == 7;
}

}  // namespace

void attention_prompt(const AttnPromptArgs& a, int rows, float* out, void* stream) {
    if (rows <= 0) return;
    cudaStream_t s = (cudaStream_t) stream;
    if (prompt_v70()) {   // (Lapilli) a V100: the tensor-core kernel (attn_prompt_v70_kernel)
        const dim3 grid70((unsigned) ((rows + kPos70 - 1) / kPos70), kKvHeads);
        static bool sized70[kOptInDevices] = {};
        if (bool& z = sized70[opt_in_device()]; !z) {
            cudaFuncSetAttribute(attn_prompt_v70_kernel<true>, cudaFuncAttributeMaxDynamicSharedMemorySize, (int) sizeof(Smem70));
            cudaFuncSetAttribute(attn_prompt_v70_kernel<false>, cudaFuncAttributeMaxDynamicSharedMemorySize, (int) sizeof(Smem70));
            z = true;
        }
        if (a.fp8) attn_prompt_v70_kernel<true><<<grid70, kThreads70, sizeof(Smem70), s>>>(a, rows, out);
        else attn_prompt_v70_kernel<false><<<grid70, kThreads70, sizeof(Smem70), s>>>(a, rows, out);
        check("attention_prompt (V100)");
        return;
    }
    const dim3 grid((unsigned) ((rows + kPos - 1) / kPos), kKvHeads);
    static bool sized[kOptInDevices] = {};   // the opt-in is per device
    if (bool& z = sized[opt_in_device()]; !z) {
        cudaFuncSetAttribute(attn_prompt_kernel<true>, cudaFuncAttributeMaxDynamicSharedMemorySize, (int) sizeof(Smem));
        cudaFuncSetAttribute(attn_prompt_kernel<false>, cudaFuncAttributeMaxDynamicSharedMemorySize, (int) sizeof(Smem));
        z = true;
    }
    if (a.fp8) attn_prompt_kernel<true><<<grid, kThreads, sizeof(Smem), s>>>(a, rows, out);
    else attn_prompt_kernel<false><<<grid, kThreads, sizeof(Smem), s>>>(a, rows, out);
    check("attention_prompt");
}

}  // namespace basalt::models::inkling2
