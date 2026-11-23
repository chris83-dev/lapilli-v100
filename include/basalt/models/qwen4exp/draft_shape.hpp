// include/basalt/models/qwen4exp/draft_shape.hpp - (Lapilli) whether the Flash-Next's draft policies (they do not read
// round times, so the same tokens give the same windows on every run) cost their windows by the shape measured on a V100
// (basalt::spec::DraftPolicy's v100_shape, draft_policy.cpp): a V100 (compute capability 7.x) as the current card when
// they are made, unless BASALT_DRAFT_SHAPE_V70=0 (read once: Basalt's shape, to compare).
#pragma once

#include <cuda_runtime.h>

#include <cstdlib>

namespace basalt::models::qwen4exp {

inline bool draft_v100_shape() {
    static const bool v = [] {
        const char* e = std::getenv("BASALT_DRAFT_SHAPE_V70");
        if (e != nullptr && e[0] == '0' && e[1] == 0) return false;
        int dev = 0, major = 0;
        if (cudaGetDevice(&dev) != cudaSuccess ||
            cudaDeviceGetAttribute(&major, cudaDevAttrComputeCapabilityMajor, dev) != cudaSuccess) {
            (void) cudaGetLastError();
            return false;
        }
        return major == 7;
    }();
    return v;
}

}  // namespace basalt::models::qwen4exp
