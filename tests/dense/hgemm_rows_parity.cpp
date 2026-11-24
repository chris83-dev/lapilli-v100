// tests/dense/hgemm_rows_parity.cpp - (Lapilli, V100) the prompt chunks' NVFP4 products on cuBLAS's FP16 tensor cores
// (src/dense/hgemm.hpp, BASALT_DENSE_HGEMM=1) keep a row's result whatever the other rows of its chunk (the rule "C"):
// the same activation rows, read in a chunk of 4096 rows and again alone or in smaller chunks, at the start, the middle
// and the end of the chunk, give the same bits. At the 27B's shapes (gate/up 17408 x 5120, down 5120 x 17408, a small
// 1024 x 5120, and the 27B's other shapes), with random NVFP4 blocks (any E2M1 code, UE4M3 scales from a safe set). Also
// times the full chunk of each algorithm it tries.
// Exit 77 without a GPU, 1 on the first difference.
#include "dense/hgemm.hpp"
#include "basalt/prefill/moe_mmq.hpp"

#include <cuda_runtime.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <random>
#include <string>
#include <vector>

namespace {

void ck(cudaError_t e, const char* what) {
    if (e != cudaSuccess) {
        std::fprintf(stderr, "%s: %s\n", what, cudaGetErrorString(e));
        std::exit(1);
    }
}

constexpr int64_t kFull = 4096;

struct Shape {
    int64_t n, k;
    const char* name;
};

}  // namespace

int main() {
    int devices = 0;
    if (cudaGetDeviceCount(&devices) != cudaSuccess || devices == 0) {
        std::printf("no GPU: skipped\n");
        return 77;
    }
    // the 27B's prompt products (Qwen3.8-27B: n_embd 5120, n_ff 17408, 24 heads of 256 with their gates, 4 KV heads, a
    // GDN of 16 key heads and 48 value heads of 128)
    const Shape shapes[] = {{17408, 5120, "gate/up 17408x5120"}, {5120, 17408, "down 5120x17408"},
                            {10240, 5120, "gdn qkv 10240x5120"}, {6144, 5120, "gdn z 6144x5120"},
                            {5120, 6144, "out / o 5120x6144"}, {12288, 5120, "attn q 12288x5120"},
                            {1024, 5120, "attn k/v 1024x5120"}};
    int64_t max_nk = 0, max_k = 0;
    for (const Shape& s : shapes) {
        max_nk = std::max(max_nk, s.n * s.k);
        max_k = std::max(max_k, s.k);
    }
    basalt::dense::Hgemm hg;
    if (!hg.ready((size_t) (kFull * max_k), (size_t) max_nk)) {
        std::fprintf(stderr, "no room for the FP16 images\n");
        return 1;
    }
    std::mt19937 rng(20261124);
    std::normal_distribution<float> nd(0.f, 1.f);
    const uint8_t scales[] = {0x28, 0x30, 0x34, 0x38, 0x3C, 0x40};   // UE4M3 0.125 .. 2
    cudaStream_t st = nullptr;
    ck(cudaStreamCreate(&st), "cudaStreamCreate");
    bool default_same = true;
    // the algorithm the engine takes (Hgemm's default, or BASALT_DENSE_HGEMM_ALGO) decides the result; BASALT_PARITY_ALGO=all
    // sweeps every algorithm (99 = cuBLAS's own pick, then 100 to 115), =N only 100 + N (99: cuBLAS's own pick); unset: the
    // engine's and cuBLAS's own pick
    const int engine_algo = hg.algo();
    const char* ao = std::getenv("BASALT_PARITY_ALGO");
    const bool sweep = ao != nullptr && std::strcmp(ao, "all") == 0;
    const int algo_only = ao && !sweep ? (std::atoi(ao) == 99 ? 99 : 100 + std::atoi(ao)) : -1;
    for (const Shape& sh : shapes) {
        const int64_t blocks = sh.n * (sh.k / 64);
        std::vector<uint8_t> hw((size_t) blocks * 36);
        for (int64_t b = 0; b < blocks; ++b) {
            uint8_t* blk = hw.data() + (size_t) b * 36;
            for (int j = 0; j < 4; ++j) blk[j] = scales[rng() % 6];
            for (int j = 4; j < 36; ++j) blk[j] = (uint8_t) (rng() & 0xFF);
        }
        std::vector<float> hx((size_t) (kFull * sh.k));
        for (float& v : hx) v = nd(rng);
        void* dw = nullptr;
        float *dx = nullptr, *dy = nullptr, *dys = nullptr;
        // MMQ reads a matrix past its end (zeroed bytes there: read_past_bytes)
        const size_t past = basalt::prefill::mmq::read_past_bytes(40, sh.k);
        ck(cudaMalloc(&dw, hw.size() + past), "cudaMalloc w");
        ck(cudaMemset(dw, 0, hw.size() + past), "memset w");
        ck(cudaMalloc((void**) &dx, hx.size() * 4), "cudaMalloc x");
        ck(cudaMalloc((void**) &dy, (size_t) (kFull * sh.n) * 4), "cudaMalloc y");
        ck(cudaMalloc((void**) &dys, (size_t) (kFull * sh.n) * 4), "cudaMalloc ys");
        ck(cudaMemcpy(dw, hw.data(), hw.size(), cudaMemcpyHostToDevice), "copy w");
        ck(cudaMemcpy(dx, hx.data(), hx.size() * 4, cudaMemcpyHostToDevice), "copy x");
        cudaEvent_t e0, e1;
        ck(cudaEventCreate(&e0), "event");
        ck(cudaEventCreate(&e1), "event");
        std::vector<float> full((size_t) (kFull * sh.n)), part((size_t) (kFull * sh.n));
        const int64_t cases[][2] = {{1, 0}, {7, 0}, {64, 0}, {300, 0}, {1000, 0}, {17, 2000}, {300, 3796}, {1, 4095}, {2048, 2048}};
        // cuBLAS's own pick (99) and each fixed tensor-op algorithm (100 + N): the engine's default is the first
        for (int algo = 99; algo <= 115; ++algo) {
            if (algo_only >= 0 ? algo != algo_only : !sweep && algo != 99 && algo != engine_algo) continue;
            hg.set_algo(algo);
            hg.act(dx, kFull, sh.k, st);
            if (!hg.try_product(dw, sh.n, sh.k, dy, sh.n, kFull, st)) {
                cudaGetLastError();
                std::printf("%-20s algo %3d: not supported\n", sh.name, algo);
                continue;
            }
            ck(cudaEventRecord(e0, st), "record");
            hg.act(dx, kFull, sh.k, st);
            hg.try_product(dw, sh.n, sh.k, dy, sh.n, kFull, st);
            ck(cudaEventRecord(e1, st), "record");
            ck(cudaEventSynchronize(e1), "sync");
            float ms = 0;
            ck(cudaEventElapsedTime(&ms, e0, e1), "elapsed");
            ck(cudaMemcpy(full.data(), dy, full.size() * 4, cudaMemcpyDeviceToHost), "copy y");
            int same = 0, total = 0;
            std::string first_diff;
            for (const auto& c : cases) {
                const int64_t M = c[0], at = c[1];
                hg.act(dx + (size_t) (at * sh.k), M, sh.k, st);
                if (!hg.try_product(dw, sh.n, sh.k, dys, sh.n, M, st)) {
                    cudaGetLastError();
                    ++total;
                    if (first_diff.empty()) first_diff = "a chunk of " + std::to_string(M) + " rows failed";
                    continue;
                }
                ck(cudaStreamSynchronize(st), "sync");
                ck(cudaMemcpy(part.data(), dys, (size_t) (M * sh.n) * 4, cudaMemcpyDeviceToHost), "copy ys");
                const float* ref = full.data() + (size_t) (at * sh.n);
                int64_t bad = -1;
                for (int64_t i = 0; i < M * sh.n; ++i)
                    if (std::memcmp(&ref[i], &part[(size_t) i], 4) != 0) {
                        bad = i;
                        break;
                    }
                ++total;
                if (bad < 0) {
                    ++same;
                } else if (first_diff.empty()) {
                    char buf[200];
                    std::snprintf(buf, sizeof buf, "rows %lld..%lld alone: row %lld col %lld %.9g vs %.9g", (long long) at,
                                  (long long) (at + M - 1), (long long) (at + bad / sh.n), (long long) (bad % sh.n), ref[bad],
                                  part[(size_t) bad]);
                    first_diff = buf;
                }
            }
            if (algo == engine_algo) default_same = default_same && same == total;
            std::printf("%-20s algo %3d: %7.2f ms, %5.1f TFLOPS ; %d/%d chunks the same bits%s%s\n", sh.name, algo, ms,
                        2.0 * (double) kFull * (double) sh.n * (double) sh.k / (ms * 1e-3) / 1e12, same, total,
                        first_diff.empty() ? "" : " ; first: ", first_diff.c_str());
            std::fflush(stdout);
        }
        // BASALT_PARITY_MMQ=1: the same question of MMQ, the route the prompt takes without BASALT_DENSE_HGEMM (q8_1 rows, its
        // stream-k work split sized by the chunk): told, not judged
        if (const char* mq = std::getenv("BASALT_PARITY_MMQ"); mq != nullptr && mq[0] == '1') {
            namespace mmq = basalt::prefill::mmq;
            void* xq = nullptr;
            int32_t *bounds = nullptr, *iota = nullptr;
            ck(cudaMalloc(&xq, mmq::q8_bytes(kFull, sh.k)), "cudaMalloc xq");
            ck(cudaMalloc((void**) &bounds, 2 * sizeof(int32_t)), "cudaMalloc bounds");
            ck(cudaMalloc((void**) &iota, (size_t) kFull * sizeof(int32_t)), "cudaMalloc iota");
            std::vector<int32_t> hi((size_t) kFull);
            for (int64_t i = 0; i < kFull; ++i) hi[(size_t) i] = (int32_t) i;
            ck(cudaMemcpy(iota, hi.data(), hi.size() * 4, cudaMemcpyHostToDevice), "copy iota");
            mmq::Context ctx;
            mmq::load(40, sh.n);
            const auto run = [&](int64_t at, int64_t M, float* out) {
                const int32_t hb[2] = {0, (int32_t) M};
                ck(cudaMemcpy(bounds, hb, sizeof hb, cudaMemcpyHostToDevice), "copy bounds");
                mmq::quantize(dx + (size_t) (at * sh.k), nullptr, xq, 40, sh.k, sh.k, M, st);
                mmq::Product p;
                p.w = dw;
                p.type = 40;
                p.w_rows = sh.n;
                p.w_cols = sh.k;
                p.expert_bytes = mmq::matrix_bytes(40, sh.n, sh.k);
                p.n = 1;
                p.xq = xq;
                p.bounds = bounds;
                p.ids = iota;
                p.total_rows = M;
                p.max_rows = M;
                p.dst = out;
                p.ld_dst = sh.n;
                ctx.run(p, st);
                ck(cudaStreamSynchronize(st), "sync mmq");
            };
            run(0, kFull, dy);
            ck(cudaEventRecord(e0, st), "record");
            run(0, kFull, dy);
            ck(cudaEventRecord(e1, st), "record");
            ck(cudaEventSynchronize(e1), "sync");
            float ms = 0;
            ck(cudaEventElapsedTime(&ms, e0, e1), "elapsed");
            ck(cudaMemcpy(full.data(), dy, full.size() * 4, cudaMemcpyDeviceToHost), "copy y");
            int same = 0, total = 0;
            std::string first_diff;
            for (const auto& c : cases) {
                const int64_t M = c[0], at = c[1];
                run(at, M, dys);
                ck(cudaMemcpy(part.data(), dys, (size_t) (M * sh.n) * 4, cudaMemcpyDeviceToHost), "copy ys");
                const float* ref = full.data() + (size_t) (at * sh.n);
                int64_t bad = -1;
                for (int64_t i = 0; i < M * sh.n; ++i)
                    if (std::memcmp(&ref[i], &part[(size_t) i], 4) != 0) {
                        bad = i;
                        break;
                    }
                ++total;
                if (bad < 0) {
                    ++same;
                } else if (first_diff.empty()) {
                    char buf[200];
                    std::snprintf(buf, sizeof buf, "rows %lld..%lld alone: row %lld col %lld %.9g vs %.9g", (long long) at,
                                  (long long) (at + M - 1), (long long) (at + bad / sh.n), (long long) (bad % sh.n), ref[bad],
                                  part[(size_t) bad]);
                    first_diff = buf;
                }
            }
            std::printf("%-20s MMQ     : %7.2f ms, %5.1f TFLOPS ; %d/%d chunks the same bits%s%s\n", sh.name, ms,
                        2.0 * (double) kFull * (double) sh.n * (double) sh.k / (ms * 1e-3) / 1e12, same, total,
                        first_diff.empty() ? "" : " ; first: ", first_diff.c_str());
            std::fflush(stdout);
            cudaFree(xq);
            cudaFree(bounds);
            cudaFree(iota);
        }
        cudaEventDestroy(e0);
        cudaEventDestroy(e1);
        cudaFree(dw);
        cudaFree(dx);
        cudaFree(dy);
        cudaFree(dys);
    }
    cudaStreamDestroy(st);
    std::printf(default_same ? "RESULT: a row's bits do not depend on its chunk (the engine's algorithm %d)\n"
                             : "RESULT: DIFFERENT bits across chunk sizes with the engine's algorithm %d\n", engine_algo);
    return default_same ? 0 : 1;
}
