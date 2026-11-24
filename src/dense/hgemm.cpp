// src/dense/hgemm.cpp - (Lapilli, V100) a prompt chunk's NVFP4 products on cuBLAS's FP16 tensor-core GEMM (hgemm.hpp).
#include "hgemm.hpp"

#include "basalt/kernels/elementwise.hpp"
#include "basalt/kernels/iq_kernels.hpp"
#include "basalt/log.hpp"

#include <cublas_v2.h>
#include <cuda_runtime.h>

#include <algorithm>
#include <cstdlib>

namespace basalt::dense {

namespace {
constexpr int kTypeNvfp4 = 40;              // ggml NVFP4: 64 values in a 36-byte block (4 UE4M3 scales, 32 bytes of E2M1)
constexpr int64_t kNvfp4Block = 64, kNvfp4BlockBytes = 36;

}  // namespace

Hgemm::~Hgemm() {
    if (blas_) cublasDestroy((cublasHandle_t) blas_);
    if (x_) cudaFree(x_);
    if (w_) cudaFree(w_);
}

bool Hgemm::ready(size_t x_elems, size_t w_elems) {
    if (tried_) return ok_;
    tried_ = true;
    cublasHandle_t h = nullptr;
    if (cudaMalloc((void**) &x_, x_elems * 2) != cudaSuccess || cudaMalloc((void**) &w_, w_elems * 2) != cudaSuccess ||
        cublasCreate(&h) != CUBLAS_STATUS_SUCCESS) {
        cudaGetLastError();
        if (x_) cudaFree(x_);
        if (w_) cudaFree(w_);
        x_ = w_ = nullptr;
        basalt::log::warn("basalt dense", "prompt hgemm: no room for its FP16 images (%.0f MiB): the prompt products stay on MMQ",
                          (double) (x_elems + w_elems) * 2 / 1048576.0);
        return false;
    }
    blas_ = h;
    if (const char* e = std::getenv("BASALT_DENSE_HGEMM_ALGO"); e != nullptr && e[0] >= '0' && e[0] <= '9') {
        const int n = std::atoi(e);
        if (n == 99) algo_ = (int) CUBLAS_GEMM_DEFAULT_TENSOR_OP;
        else if (n >= 0 && n <= 15) algo_ = (int) CUBLAS_GEMM_ALGO0_TENSOR_OP + n;
    }
    x_elems_ = x_elems;
    w_elems_ = w_elems;
    ok_ = true;
    basalt::log::info("basalt dense", "prompt hgemm: NVFP4 prompt products on the FP16 tensor cores (%.0f MiB of FP16 images)",
                      (double) (x_elems + w_elems) * 2 / 1048576.0);
    return true;
}

void Hgemm::act(const float* x, int64_t T, int64_t cols, void* stream) {
    if ((size_t) (T * cols) > x_elems_) {
        basalt::log::error("basalt dense", "prompt hgemm: %lld x %lld activations for an image of %zu", (long long) T,
                           (long long) cols, x_elems_);
        std::exit(1);
    }
    kernels::f32_to_f16_sat(x, x_, T * cols, stream);
    x_rows_ = T;
    x_cols_ = cols;
}

void Hgemm::product(const void* w, int64_t rows, int64_t cols, float* y, int64_t ldy, int64_t T, void* stream) {
    if (!try_product(w, rows, cols, y, ldy, T, stream)) std::exit(1);
}

bool Hgemm::try_product(const void* w, int64_t rows, int64_t cols, float* y, int64_t ldy, int64_t T, void* stream) {
    if (T != x_rows_ || cols != x_cols_ || cols % kNvfp4Block != 0) {
        basalt::log::error("basalt dense", "prompt hgemm: a %lld x %lld product on %lld x %lld activations", (long long) rows,
                           (long long) cols, (long long) x_rows_, (long long) x_cols_);
        std::exit(1);
    }
    cublasHandle_t h = (cublasHandle_t) blas_;
    if (cublasSetStream(h, (cudaStream_t) stream) != CUBLAS_STATUS_SUCCESS) return false;
    // the weight rows decoded a slice at a time (a multiple of 4 rows: iq_dequant_f16 takes whole 256-value groups)
    const int64_t fit = (int64_t) (w_elems_ / (size_t) cols) / 4 * 4;
    const int64_t slice = std::max<int64_t>(4, std::min<int64_t>(rows, fit));
    const size_t row_bytes = (size_t) (cols / kNvfp4Block) * kNvfp4BlockBytes;
    const float one = 1.0f, zero = 0.0f;
    for (int64_t r0 = 0; r0 < rows; r0 += slice) {
        const int64_t n = std::min<int64_t>(slice, rows - r0);
        kernels::iq_dequant_f16(kTypeNvfp4, (const uint8_t*) w + (size_t) r0 * row_bytes, n * cols, w_, stream, nullptr);
        // column-major view: Y^T[n, T] (rows r0.. of each output row) = W_slice[n, K] . X^T[K, T]
        const cublasStatus_t st = cublasGemmEx(h, CUBLAS_OP_T, CUBLAS_OP_N, (int) n, (int) T, (int) cols, &one, w_, CUDA_R_16F,
                                               (int) cols, x_, CUDA_R_16F, (int) cols, &zero, y + r0, CUDA_R_32F, (int) ldy,
                                               CUBLAS_COMPUTE_32F, (cublasGemmAlgo_t) algo_);
        if (st != CUBLAS_STATUS_SUCCESS) {
            basalt::log::error("basalt dense", "prompt hgemm: cublasGemmEx (algorithm %d, %lld x %lld x %lld) failed: status %d",
                               algo_, (long long) n, (long long) T, (long long) cols, (int) st);
            return false;
        }
    }
    return true;
}

}  // namespace basalt::dense
