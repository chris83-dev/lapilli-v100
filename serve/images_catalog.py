"""(Lapilli) What the Images tab's "Install" downloads: each file of each model of serve/images.py's
MODELS, from Hugging Face at a fixed revision, checked by its size and its SHA-256: the files this fork measured on a V100.
Nothing else is ever downloaded: a request names a model of this list, never an address.

A file is shared when two models use it (the Qwen3-VL encoder of the two Qwen Image 2.1 models; the Edit 2511 files of its two
entries): it is downloaded once. Qwen Image 2.1 Turbo has no GGUF of its own: its BF16 file is downloaded, converted by
sd-cli (the program built with sd-server) and removed. The video models need ffmpeg: on Windows, gyan.dev's versioned
build (FFmpeg, GPL), downloaded the same way; elsewhere, the system's (a package manager installs it)."""

HF = "https://huggingface.co/{repo}/resolve/{rev}/{path}"

# name in the model folder -> its folder, its source and what it must be
FILES = {
    "qwen_image_2.1-Q8_0.gguf": {
        "dir": "diffusion_models", "repo": "leejet/Qwen-Image-2.1-GGUF", "rev": "0bca76da6edd8a18211e9717454615c1bbaaf6ed",
        "path": "qwen_image_2.1-Q8_0.gguf", "size": 7687155744,
        "sha256": "f8b244b00937f0e444a40dbf7866460871b89b30142594973b6012d1b471dc0a"},
    "Qwen3VL-8B-Instruct-Q8_0.gguf": {
        "dir": "text_encoders", "repo": "Qwen/Qwen3-VL-8B-Instruct-GGUF", "rev": "f982a07559d4a2f6c8744d840bf6fccab30eea96",
        "path": "Qwen3VL-8B-Instruct-Q8_0.gguf", "size": 8709519456,
        "sha256": "0d264b3941185d00a74f75c4245521dae088ff1efc90ab8d1754e83f5844adb0"},
    "mmproj-Qwen3VL-8B-Instruct-F16.gguf": {
        "dir": "text_encoders", "repo": "Qwen/Qwen3-VL-8B-Instruct-GGUF", "rev": "f982a07559d4a2f6c8744d840bf6fccab30eea96",
        "path": "mmproj-Qwen3VL-8B-Instruct-F16.gguf", "size": 1159029824,
        "sha256": "ca524100ebf825c9a870db1c580d03879e0da0ab2541697e2458e64891cf9d38"},
    "qwen_image_2.1_vae_bf16.safetensors": {
        "dir": "vae", "repo": "Comfy-Org/Qwen-Image-2.1", "rev": "aacf31a6d48e707f352ecba714cee0680da3479b",
        "path": "vae/qwen_image_2.1_vae_bf16.safetensors", "size": 675509688,
        "sha256": "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9"},
    # the Turbo: made here from its BF16 file (below), by `sd-cli -M convert --type q8_0`
    "qwen_image_2.1_turbo-Q8_0.gguf": {
        "dir": "diffusion_models", "convert_from": "qwen_image_2.1_turbo_bf16.safetensors", "type": "q8_0", "size": 7591554912,
        "sha256": "c800649b06d32f2d6dfc0406c627479b363be7424fd2fcb4b2c236750368367b"},
    "qwen-image-edit-2511-Q8_0.gguf": {
        "dir": "diffusion_models", "repo": "unsloth/Qwen-Image-Edit-2511-GGUF", "rev": "52838251db242ddd8e8d0118de36c71006d7c397",
        "path": "qwen-image-edit-2511-Q8_0.gguf", "size": 22354590304,
        "sha256": "0bf71797bf27dac40e3d8c1dc344309cb53f2a08beed6a96120dd77164b3806f"},
    "Qwen2.5-VL-7B-Instruct.Q8_0.gguf": {
        "dir": "text_encoders", "repo": "mradermacher/Qwen2.5-VL-7B-Instruct-GGUF", "rev": "cfa2baa09946b211c107e6e104948987a64dd2c1",
        "path": "Qwen2.5-VL-7B-Instruct.Q8_0.gguf", "size": 8098524160,
        "sha256": "577bfb3e41f93f00414e594c56a38bbe91207b3b636ab7faf343e34a20aa73ca"},
    "Qwen2.5-VL-7B-Instruct.mmproj-f16.gguf": {
        "dir": "text_encoders", "repo": "mradermacher/Qwen2.5-VL-7B-Instruct-GGUF", "rev": "cfa2baa09946b211c107e6e104948987a64dd2c1",
        "path": "Qwen2.5-VL-7B-Instruct.mmproj-f16.gguf", "size": 1354162912,
        "sha256": "2f9b49529bf463c165223e21f10320655a74da61bb64bf7b9fa8b3892cc46926"},
    "qwen_image_vae.safetensors": {
        "dir": "vae", "repo": "Comfy-Org/Qwen-Image", "rev": "1f12b17be14c89b026c51a91d67c32f84bb047bc",
        "path": "split_files/vae/qwen_image_vae.safetensors", "size": 253806246,
        "sha256": "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f"},
    "Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors": {
        "dir": "loras", "repo": "lightx2v/Qwen-Image-Edit-2511-Lightning", "rev": "107d238d68b8387e32843d0b4a2e24ceb0d3ad86",
        "path": "Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors", "size": 849608296,
        "sha256": "a9e81a58a78f260f67b337a6f615e8fa4cd3bc79847c77b7d61a581b789b1ba8"},
    "Wan2.2-TI2V-5B-Q8_0.gguf": {
        "dir": "diffusion_models", "repo": "QuantStack/Wan2.2-TI2V-5B-GGUF", "rev": "57437632ddd08bdcbd1508c866aa22e126ed51d2",
        "path": "Wan2.2-TI2V-5B-Q8_0.gguf", "size": 5400179040,
        "sha256": "57bece983817ab2f957546683bb670f13be7d99022d45674840cd999a050ea8f"},
    "umt5-xxl-encoder-Q8_0.gguf": {
        "dir": "text_encoders", "repo": "city96/umt5-xxl-encoder-gguf", "rev": "b535255bee98c2b0a59ea7c0ae2dcd0c6657b3b7",
        "path": "umt5-xxl-encoder-Q8_0.gguf", "size": 6043068256,
        "sha256": "2521d4de0bf9e1cc6549866463ceae85e4ec3239bc6063f7488810be39033bbc"},
    "wan2.2_vae.safetensors": {
        "dir": "vae", "repo": "Comfy-Org/Wan-2.2", "rev": "5df3a4a3ed0628002308022198249dbbbd045d09",
        "path": "split_files/vae/wan2.2_vae.safetensors", "size": 1409400960,
        "sha256": "e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156"},
    "ltx-2.3-22b-distilled-1.1-Q8_0.gguf": {
        "dir": "diffusion_models", "repo": "unsloth/LTX-2.3-GGUF", "rev": "96e8ed4925ead3db9ff4d0084f165ef6a74f28d0",
        "path": "distilled-1.1/ltx-2.3-22b-distilled-1.1-Q8_0.gguf", "size": 22755540000,
        "sha256": "813fd61eecf3df2ef5ac5a942d226ee7e44b6cec68ed803549aefaa410cd397e"},
    "gemma-3-12b-it-Q8_0.gguf": {
        "dir": "text_encoders", "repo": "unsloth/gemma-3-12b-it-GGUF", "rev": "d15e4c7dc21dc55d56bf8549db57a71ad8a2a35d",
        "path": "gemma-3-12b-it-Q8_0.gguf", "size": 12510212576,
        "sha256": "a774cd9c6f289a6159f4a3f92a7ebca887e15073f92016d53c3593cb440a5982"},
    "ltx-2.3-22b-distilled_embeddings_connectors.safetensors": {
        "dir": "text_encoders", "repo": "unsloth/LTX-2.3-GGUF", "rev": "96e8ed4925ead3db9ff4d0084f165ef6a74f28d0",
        "path": "text_encoders/ltx-2.3-22b-distilled_embeddings_connectors.safetensors", "size": 2312144712,
        "sha256": "c61cbb396e2a8175d8b2da51f0fdac885a4ccd22c9f64dafa5aa2c455dc8a507"},
    "ltx-2.3-22b-distilled_video_vae.safetensors": {
        "dir": "vae", "repo": "unsloth/LTX-2.3-GGUF", "rev": "96e8ed4925ead3db9ff4d0084f165ef6a74f28d0",
        "path": "vae/ltx-2.3-22b-distilled_video_vae.safetensors", "size": 1452256522,
        "sha256": "e68d6d8f8a42942ac9b862cc315beb3bc30805a8876c7ad63ba5bf7a2b8e168a"},
    "ltx-2.3-22b-distilled_audio_vae.safetensors": {
        "dir": "vae", "repo": "unsloth/LTX-2.3-GGUF", "rev": "96e8ed4925ead3db9ff4d0084f165ef6a74f28d0",
        "path": "vae/ltx-2.3-22b-distilled_audio_vae.safetensors", "size": 364853140,
        "sha256": "3cd6a6eb8cb28f5ecc12f1f3126952b2a3d2b0b42ad3270e63cefafafe0d9b57"},
}

# the sources that are not kept: downloaded into the install folder, used, then removed
SOURCES = {
    "qwen_image_2.1_turbo_bf16.safetensors": {
        "repo": "Comfy-Org/Qwen-Image-2.1", "rev": "aacf31a6d48e707f352ecba714cee0680da3479b",
        "path": "diffusion_models/qwen_image_2.1_turbo_bf16.safetensors", "size": 14230280616,
        "sha256": "8b74237a7f505773e2c66726fa696444b4c704585c93a347cff9044937f7914a"},
}

# Windows: ffmpeg for the video models (gyan.dev's versioned "essentials" build: its releases stay; FFmpeg is GPL, so it is
# downloaded at the user's request, never shipped with Lapilli); only ffmpeg.exe and the build's license are kept
FFMPEG = {"url": "https://github.com/GyanD/codexffmpeg/releases/download/9.1/ffmpeg-9.1-essentials_build.zip",
          "size": 119467219, "sha256": "b9bbbb3acece000cbeec994f856649354e52c773807841e78908374b24d658fd",
          "exe": "bin/ffmpeg.exe", "license_file": "LICENSE"}

LICENSES = {
    "qwen-research": ("Qwen Research License", "https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE"),
    "apache-2.0": ("Apache 2.0", "https://www.apache.org/licenses/LICENSE-2.0"),
    "ltx-2": ("LTX-2 Community License", "https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2"),
    "gemma": ("Gemma Terms of Use (its text encoder)", "https://ai.google.dev/gemma/terms"),
    "ffmpeg": ("FFmpeg, GPL (for the videos)", "https://ffmpeg.org/legal.html"),
}

# each model of serve/images.py's MODELS: the catalog file of each of its slots and LoRAs, its licenses (in the order shown)
MODEL_FILES = {
    "turbo": {"slots": {"diffusion_model": "qwen_image_2.1_turbo-Q8_0.gguf", "llm": "Qwen3VL-8B-Instruct-Q8_0.gguf",
                        "llm_vision": "mmproj-Qwen3VL-8B-Instruct-F16.gguf", "vae": "qwen_image_2.1_vae_bf16.safetensors"},
              "licenses": ["qwen-research", "apache-2.0"]},
    "base": {"slots": {"diffusion_model": "qwen_image_2.1-Q8_0.gguf", "llm": "Qwen3VL-8B-Instruct-Q8_0.gguf",
                       "llm_vision": "mmproj-Qwen3VL-8B-Instruct-F16.gguf", "vae": "qwen_image_2.1_vae_bf16.safetensors"},
             "licenses": ["qwen-research", "apache-2.0"]},
    "edit-2511-lightning": {"slots": {"diffusion_model": "qwen-image-edit-2511-Q8_0.gguf", "llm": "Qwen2.5-VL-7B-Instruct.Q8_0.gguf",
                                      "llm_vision": "Qwen2.5-VL-7B-Instruct.mmproj-f16.gguf", "vae": "qwen_image_vae.safetensors"},
                            "loras": ["Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors"],
                            "licenses": ["apache-2.0"]},
    "edit-2511": {"slots": {"diffusion_model": "qwen-image-edit-2511-Q8_0.gguf", "llm": "Qwen2.5-VL-7B-Instruct.Q8_0.gguf",
                            "llm_vision": "Qwen2.5-VL-7B-Instruct.mmproj-f16.gguf", "vae": "qwen_image_vae.safetensors"},
                  "licenses": ["apache-2.0"]},
    "wan22-5b": {"slots": {"diffusion_model": "Wan2.2-TI2V-5B-Q8_0.gguf", "t5xxl": "umt5-xxl-encoder-Q8_0.gguf",
                           "vae": "wan2.2_vae.safetensors"},
                 "licenses": ["apache-2.0", "ffmpeg"]},
    "ltx23": {"slots": {"diffusion_model": "ltx-2.3-22b-distilled-1.1-Q8_0.gguf", "llm": "gemma-3-12b-it-Q8_0.gguf",
                        "embeddings_connectors": "ltx-2.3-22b-distilled_embeddings_connectors.safetensors",
                        "vae": "ltx-2.3-22b-distilled_video_vae.safetensors", "audio_vae": "ltx-2.3-22b-distilled_audio_vae.safetensors"},
              "licenses": ["ltx-2", "gemma", "ffmpeg"]},
}
