# The Images tab: pictures and videos on V100

The Lapilli page's **Images** tab draws a picture from a prompt, edits your own pictures, and makes videos of up to five
seconds, with their sound for LTX-2.3. Behind it, the Lapilli server runs [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)'s
`sd-server` (leejet, MIT), as it is published, as a second engine on the same cards.

The cards hold one engine at a time. A picture or a video takes the chat model's turn, like a chat request: the server
unloads the chat model and starts `sd-server` on one card. The next chat message waits for the job to end, then the server
stops `sd-server` and loads the chat model again. `sd-server` listens on `127.0.0.1` only, behind the Lapilli server.

Back to the [README](../README.md).

## Install a model from the page

The Windows archive holds `sd-server.exe` and `sd-cli.exe` in `bin\` (stable-diffusion.cpp, built for sm_70, MIT): the server
turns the Images tab on by itself. It comes with no model. Open the tab, choose a model marked *Not installed yet*, read and
accept its licenses, then click **Install**:

- the server downloads the model's files from Hugging Face, at the revisions every figure here was measured with, checks
  each file's size and SHA-256, and only then puts it in `models\images\` (a file two models share comes once);
- a cut download goes on from where it stopped, even after a restart of the server; **Cancel the install** stops it;
- Qwen Image 2.1 Turbo has no ready file: the server downloads its BF16 file and makes it with `sd-cli` (about two minutes,
  with about 22 GB free during it), then removes the BF16 file;
- the video models also need ffmpeg: on Windows the server downloads gyan.dev's ffmpeg 9.1 build (GPL) into
  `models\images\ffmpeg\`; on Linux, install ffmpeg with your package manager.

| In the page | To download | On the disk |
|---|---|---|
| Qwen Image 2.1 Turbo | 24.8 GB | 18.1 GB |
| Qwen Image 2.1 | 18.2 GB (7.7 GB with the Turbo) | 18.2 GB (7.7 GB with the Turbo) |
| Qwen Image Edit 2511 Lightning | 32.9 GB | 32.9 GB |
| Qwen Image Edit 2511 | 32.1 GB (nothing with the Lightning one) | 32.1 GB |
| Wan 2.2 Video | 13.0 GB, with ffmpeg | 13.1 GB |
| LTX-2.3 Video | 39.5 GB, with ffmpeg | 39.6 GB |

A model is offered once its files are all there. `--images-models DIR` puts the models elsewhere; `--images-server off`
turns the tab off.

## By hand (Linux, or your own files)

Everything the page does can be done by hand: build `sd-server`, put the files in the model folder, start the server with
the three options of step 4. The page then offers what it finds.

### 1. Build `sd-server` for sm_70

From an *x64 Native Tools Command Prompt for VS 2022*, with the same CUDA Toolkit as Lapilli (12.6 to 12.9):

```bat
git clone https://github.com/leejet/stable-diffusion.cpp sd.cpp && cd sd.cpp
git checkout 79dc7ca9074d79419a46380cdb95a4524db9b74c
git submodule update --init ggml
cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DSD_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=70 "-DSD_CUDA_CUTLASS_PATH=" -DGGML_CUDA_NO_PEER_COPY=ON -DSD_WEBP=OFF -DSD_WEBM=OFF -DSD_SERVER_BUILD_FRONTEND=OFF
cmake --build build
```

`build\bin\` then holds `sd-server.exe` (for the page) and `sd-cli.exe` (for the one conversion below).

- `79dc7ca9` is the revision every figure here was measured with (`master`, November 24, 2026). It runs every model below on
  a V100 without any change.
- `-DSD_CUDA_CUTLASS_PATH=` leaves CUTLASS out: it only speeds up INT8 and BF16 safetensors weights, and the large files below
  are GGUF.
- `-DGGML_CUDA_NO_PEER_COPY=ON`: no direct copies between cards (see the README on peer access).
- `-DSD_WEBP=OFF -DSD_WEBM=OFF`: `sd-server` then writes a video as AVI (MJPEG, with PCM sound for LTX-2.3), which the Lapilli
  server turns into an MP4 (H.264, AAC sound) with `ffmpeg` for the browser.
- `-DSD_SERVER_BUILD_FRONTEND=OFF`: `sd-server`'s own web page is not needed.

### 2. Get `ffmpeg` (for the videos)

Any recent `ffmpeg.exe` works. Tested: 8.1.3, the static `win64-gpl` build of [FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds).
It turns a five-second AVI into an MP4 in about a third of a second.

### 3. The model files

All in one folder, in four sub-folders: `diffusion_models\`, `text_encoders\`, `vae\` and `loras\`. The server finds each file by
its name, so keep the names below. Every revision is the one measured; each file's license is on its page.

#### Qwen Image 2.1 Turbo and Qwen Image 2.1 (26 GB)

| File | Folder | Size | From |
|---|---|---|---|
| `qwen_image_2.1_turbo-Q8_0.gguf` | `diffusion_models\` | 7.6 GB | converted from Comfy-Org's BF16 file (below) |
| `qwen_image_2.1-Q8_0.gguf` | `diffusion_models\` | 7.7 GB | [leejet/Qwen-Image-2.1-GGUF](https://huggingface.co/leejet/Qwen-Image-2.1-GGUF) (`0bca76da`) |
| `Qwen3VL-8B-Instruct-Q8_0.gguf` | `text_encoders\` | 8.7 GB | [Qwen/Qwen3-VL-8B-Instruct-GGUF](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF) (`f982a075`) |
| `mmproj-Qwen3VL-8B-Instruct-F16.gguf` | `text_encoders\` | 1.2 GB | the same page |
| `qwen_image_2.1_vae_bf16.safetensors` | `vae\` | 0.7 GB | [Comfy-Org/Qwen-Image-2.1](https://huggingface.co/Comfy-Org/Qwen-Image-2.1) (`aacf31a6`), `vae/` |

The Turbo has no GGUF of its own: convert Comfy-Org's BF16 file (`diffusion_models/qwen_image_2.1_turbo_bf16.safetensors`,
14.2 GB, same page and revision) once, with the `sd-cli.exe` built above (about two minutes):

```bat
sd-cli.exe -M convert --diffusion-model qwen_image_2.1_turbo_bf16.safetensors -o <models>\diffusion_models\qwen_image_2.1_turbo-Q8_0.gguf --type q8_0
```

The BF16 file can go once the GGUF is made. Licenses: Qwen Image 2.1 is under the
[Qwen Research License](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE); Qwen3-VL-8B-Instruct, the text
encoder, under Apache 2.0.

#### Qwen Image Edit 2511 and Qwen Image Edit 2511 Lightning (33 GB)

| File | Folder | Size | From |
|---|---|---|---|
| `qwen-image-edit-2511-Q8_0.gguf` | `diffusion_models\` | 22.4 GB | [unsloth/Qwen-Image-Edit-2511-GGUF](https://huggingface.co/unsloth/Qwen-Image-Edit-2511-GGUF) (`52838251`) |
| `Qwen2.5-VL-7B-Instruct.Q8_0.gguf` | `text_encoders\` | 8.1 GB | [mradermacher/Qwen2.5-VL-7B-Instruct-GGUF](https://huggingface.co/mradermacher/Qwen2.5-VL-7B-Instruct-GGUF) (`cfa2baa0`) |
| `Qwen2.5-VL-7B-Instruct.mmproj-f16.gguf` | `text_encoders\` | 1.4 GB | the same page |
| `qwen_image_vae.safetensors` | `vae\` | 0.3 GB | [Comfy-Org/Qwen-Image](https://huggingface.co/Comfy-Org/Qwen-Image) (`1f12b17b`), `split_files/vae/` |
| `Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors` | `loras\` | 0.8 GB | [lightx2v/Qwen-Image-Edit-2511-Lightning](https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning) (`107d238d`), for the Lightning entry only |

All under Apache 2.0.

#### Wan 2.2 Video (13 GB)

| File | Folder | Size | From |
|---|---|---|---|
| `Wan2.2-TI2V-5B-Q8_0.gguf` | `diffusion_models\` | 5.4 GB | [QuantStack/Wan2.2-TI2V-5B-GGUF](https://huggingface.co/QuantStack/Wan2.2-TI2V-5B-GGUF) (`57437632`) |
| `umt5-xxl-encoder-Q8_0.gguf` | `text_encoders\` | 6.0 GB | [city96/umt5-xxl-encoder-gguf](https://huggingface.co/city96/umt5-xxl-encoder-gguf) (`b535255b`) |
| `wan2.2_vae.safetensors` | `vae\` | 1.4 GB | [Comfy-Org/Wan-2.2](https://huggingface.co/Comfy-Org/Wan-2.2) (`5df3a4a3`), `split_files/vae/` |

All under Apache 2.0.

#### LTX-2.3 Video, with sound (39 GB)

| File | Folder | Size | From |
|---|---|---|---|
| `ltx-2.3-22b-distilled-1.1-Q8_0.gguf` | `diffusion_models\` | 22.8 GB | [unsloth/LTX-2.3-GGUF](https://huggingface.co/unsloth/LTX-2.3-GGUF) (`96e8ed49`), `distilled-1.1/` |
| `ltx-2.3-22b-distilled_embeddings_connectors.safetensors` | `text_encoders\` | 2.3 GB | the same page, `text_encoders/` |
| `gemma-3-12b-it-Q8_0.gguf` | `text_encoders\` | 12.5 GB | [unsloth/gemma-3-12b-it-GGUF](https://huggingface.co/unsloth/gemma-3-12b-it-GGUF) (`d15e4c7d`) |
| `ltx-2.3-22b-distilled_video_vae.safetensors` | `vae\` | 1.5 GB | [unsloth/LTX-2.3-GGUF](https://huggingface.co/unsloth/LTX-2.3-GGUF) (`96e8ed49`), `vae/` |
| `ltx-2.3-22b-distilled_audio_vae.safetensors` | `vae\` | 0.4 GB | the same page, `vae/` |

unsloth publishes the connectors and the two decoders for "distilled" only: they suit the 1.1 model (its pictures and its sound
are right). Licenses: LTX-2.3 is under the [LTX-2 Community License](https://github.com/Lightricks/LTX-2/blob/main/LICENSE-2)
(free below a yearly revenue of 10 million dollars); Gemma 3, its text encoder, under Google's
[Gemma Terms of Use](https://ai.google.dev/gemma/terms).

### 4. Start the server with the Images tab

With the Windows archive, nothing to add: `bin\sd-server.exe`, `models\images\` and the ffmpeg Install put there are the
defaults. With your own build or folders, add three options to the model's usual command (see the README), for example
with the 27B:

```bat
bin\basalt.exe serve models\Qwen3.8-27B-QUASAR-NVFP4.basalt --gpu 0 --kv int8 --port 8080 --images-server C:\sd\sd-server.exe --images-models C:\sd\models --images-ffmpeg C:\ffmpeg\bin\ffmpeg.exe
```

| Option | What it does |
|---|---|
| `--images-server EXE` | `sd-server`: the Images tab and `POST /v1/images/generations` (default: `bin\sd-server.exe` when it is there; `off`: no tab) |
| `--images-models DIR` | the model folder of step 3 (default: `models\images\`) |
| `--images-ffmpeg EXE` | `ffmpeg`: the video models need it (default: the one Install put in the model folder, else the system's) |
| `--images-card N` | the one card `sd-server` may use (default 0) |
| `--images-port PORT` | `sd-server`'s port, on `127.0.0.1` only (default 8099) |
| `--images-cap-gib GIB` | Windows: a hard cap on `sd-server`'s working set, from its start (default 40) |

Keep the model files on an SSD: a job reads the files of its model at start (about 35 GiB for LTX-2.3).

## What to expect on one V100

| In the page | Steps | Measured |
|---|---|---|
| Qwen Image 2.1 Turbo | 8 | 11.4 s for 1024 × 1024 |
| Qwen Image 2.1 | 40 | 101 s for 1024 × 1024 |
| Qwen Image Edit 2511 Lightning | 8 | 55 s for 1024 × 1024 |
| Qwen Image Edit 2511 | 20 | 229 s for 1024 × 1024 |
| Wan 2.2 Video | 20 | 276 s for 5 s at 832 × 480 |
| LTX-2.3 Video | 8 | 59 s for 5 s at 768 × 512, with its sound |

Measured through the Lapilli server on the machine of the README, November 27, 2026, from the click to the finished file, the
model already loaded (the second job in a row). The first job after a chat message, or after a change of model, starts
`sd-server` and reads the model's files first: 12 s more for the Turbo, its files on an NVMe SSD. While it
draws, the page shows a rough preview of the picture and the time left; the time a video's frames take to decode is known in
advance from its size, and the page counts it down.

## Sizes and limits

- Pictures: each side a multiple of 32, from 256 to 2,816 pixels, at most 2,400 × 1,792 pixels in all. Up to four pictures in
  one job.
- Videos: up to 121 frames, five seconds at 24 frames a second, at most 1,280 × 704 pixels; one start picture at most.
- Editing: up to four reference pictures of 16 MB each, read at 768 × 768 pixels **together** at most (the page makes them
  smaller when it sends them); the edited picture at about one megapixel. stable-diffusion.cpp hands each reference to the
  vision encoder at its own size, where Qwen's own pipeline makes it about 384 × 384; beyond about 0.6 megapixels of references,
  the edits drift ([issue #2427](https://github.com/leejet/stable-diffusion.cpp/issues/2427); fixed upstream after the
  revision above by [#2433](https://github.com/leejet/stable-diffusion.cpp/pull/2433), not measured here yet).
- A prompt of up to 4,000 characters.

## The API

- `POST /v1/images/generations`, in OpenAI's form: it waits for its job and returns the pictures.
- `GET /api/images`: what the tab can do (its models, their limits) and the recent jobs; `POST /api/images/jobs` starts a job,
  `GET /api/images/jobs/<id>` follows it, `POST /api/images/jobs/<id>/cancel` stops it. A video's MP4 is at
  `/api/images/jobs/<id>/video`.
- `POST /api/images/install` with `{"model": "<name>", "accept": true}` installs a model of the catalog (never an address),
  from the server's own page only; `POST /api/images/install/cancel` stops it; `GET /api/images` tells what each model
  needs (`install`) and how the install goes (`install_job`).

Back to the [README](../README.md).
