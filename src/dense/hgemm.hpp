// src/dense/hgemm.hpp - (Lapilli, V100) a prompt chunk's NVFP4 products on cuBLAS's FP16 tensor-core GEMM.
//
// The V100 has no FP4 tensor cores: MMQ emulates the int8 products on tiles of HMMA and rescales every 16 values (one
// UE4M3 scale per 16 E2M1 values), which held the 27B's prompt read at ~49 TFLOPS of the card's 125 (72 % of a 16K read,
// nvprof). Here the weights are decoded to FP16 (exact: an E2M1 value times its UE4M3 scale needs at most
// 6 bits of mantissa and stays within FP16's range), the activations rounded to FP16 rows instead of MMQ's q8_1
// blocks, and the product runs on cublasGemmEx with FP32 sums, the tensor scale left out as MMQ leaves it. The idea:
// ninfer-v100 (Apache-2.0), which stages FP16 activations and runs its prompt GEMMs on the tensor cores.
#pragma once

#include <cstddef>
#include <cstdint>

namespace basalt::dense {

class Hgemm {
public:
    Hgemm() = default;
    ~Hgemm();
    Hgemm(const Hgemm&) = delete;
    Hgemm& operator=(const Hgemm&) = delete;

    /// Allocates the FP16 images once: `x_elems` activation values (a chunk's rows at the widest input), `w_elems` weight
    /// values (the largest matrix), and the cuBLAS handle. False when the card has no room (said once): MMQ stays.
    bool ready(size_t x_elems, size_t w_elems);
    bool usable() const { return ok_; }

    /// x: T rows of `cols` FP32 values (ld = cols) into the FP16 activation image (saturated at +-65504).
    void act(const float* x, int64_t T, int64_t cols, void* stream);

    /// y [T][rows] (ld = ldy) = W . x for W the NVFP4 matrix (ggml type 40, rows x cols, row-major blocks) and the
    /// activation image `act` left: the product without the matrix's tensor scale, as MMQ leaves it.
    void product(const void* w, int64_t rows, int64_t cols, float* y, int64_t ldy, int64_t T, void* stream);
    /// product, false on a cuBLAS error instead of stopping the process (the parity test tries every algorithm)
    bool try_product(const void* w, int64_t rows, int64_t cols, float* y, int64_t ldy, int64_t T, void* stream);

    /// The cublasGemmAlgo_t of the products, the same at every shape: CUBLAS_GEMM_ALGO4_TENSOR_OP (104) unless
    /// BASALT_DENSE_HGEMM_ALGO=N picks CUBLAS_GEMM_ALGO<N>_TENSOR_OP (100 + N), or =99 cuBLAS's own pick at each shape
    /// (CUBLAS_GEMM_DEFAULT_TENSOR_OP). Measured on a V100 (dense_hgemm_rows_parity): cuBLAS's own pick takes
    /// another algorithm for a chunk of other rows and rounds a row otherwise (rule "C" broken: 0 to 7 chunks of 9 keep
    /// the full chunk's bits); 104 keeps them at every shape tried, 62 / 76 / 54 TFLOPS against 73 / 77 / 54 (gate/up,
    /// down, a small one).
    void set_algo(int algo) { algo_ = algo; }
    int algo() const { return algo_; }

private:
    void* blas_ = nullptr;
    uint16_t* x_ = nullptr;
    uint16_t* w_ = nullptr;
    size_t x_elems_ = 0, w_elems_ = 0;
    int64_t x_rows_ = 0, x_cols_ = 0;
    bool ok_ = false, tried_ = false;
    int algo_ = 104;   // CUBLAS_GEMM_ALGO4_TENSOR_OP
};

}  // namespace basalt::dense
