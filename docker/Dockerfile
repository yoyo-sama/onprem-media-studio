# One image, one container: API + front end + llama-server + the diffusion
# and video runtimes. Target: DGX OS / Ubuntu on ARM64 with a GB10 (sm_121).
#
# The NGC PyTorch image is multi-arch and ships CUDA 13, nvcc and a PyTorch
# build that knows Blackwell; bump BASE_IMAGE only after a real render passes.
ARG BASE_IMAGE=nvcr.io/nvidia/pytorch:25.11-py3

FROM ${BASE_IMAGE} AS llama
# Pinned llama.cpp release; GB10 is compute capability 12.1.
ARG LLAMA_CPP_REF=b11982
ARG CUDA_ARCHS=121
RUN apt-get update && apt-get install -y --no-install-recommends cmake git && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${LLAMA_CPP_REF} https://github.com/ggml-org/llama.cpp /src/llama.cpp
WORKDIR /src/llama.cpp
RUN cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=${CUDA_ARCHS} \
        -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF -DCMAKE_BUILD_TYPE=Release \
 && cmake --build build --target llama-server -j "$(nproc)" \
 && mkdir -p /opt/llama && cp build/bin/llama-server /opt/llama/ \
 && find build -name '*.so*' -exec cp -a {} /opt/llama/ \;

FROM ${BASE_IMAGE} AS fastvideo
# FastVideo (Apache-2.0) runs MiniMax H3. Pinned commit; its CUDA kernels are
# built here for the GB10 (sm_121a: no GPU is visible during a build), against
# the base image's torch. FastVideo pins torch==2.12.0 while NGC 25.11 ships
# 2.10: it is installed without its dependencies so the base image's torch
# stays (docs/H3.md § Torch version), and docker/fastvideo-requirements.txt
# lists the rest.
ARG FASTVIDEO_REF=7203b4976eefcd70a52728ca1281797ce96734eb
ARG FASTVIDEO_KERNEL_ARCH=12.1a
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
RUN git clone https://github.com/hao-ai-lab/FastVideo /src/fastvideo \
 && cd /src/fastvideo && git checkout ${FASTVIDEO_REF} \
 && git submodule update --init --recursive fastvideo-kernel/include/cutlass fastvideo-kernel/include/tk
WORKDIR /src/fastvideo
RUN pip install --no-cache-dir scikit-build-core cmake ninja \
 && TORCH_CUDA_ARCH_LIST=${FASTVIDEO_KERNEL_ARCH} MAX_JOBS=4 \
    pip wheel --no-cache-dir --no-build-isolation --no-deps -w /wheels ./fastvideo-kernel .

FROM ${BASE_IMAGE}
ENV PYTHONUNBUFFERED=1 \
    STUDIO_DATA_DIR=/data \
    STUDIO_LLAMA_SERVER=/opt/llama/llama-server \
    LD_LIBRARY_PATH=/opt/llama:${LD_LIBRARY_PATH} \
    HF_HUB_ENABLE_HF_TRANSFER=0
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=llama /opt/llama /opt/llama
COPY --from=fastvideo /wheels /wheels
WORKDIR /app
COPY docker/fastvideo-requirements.txt ./docker/
# torch comes from the base image: never let pip replace it with a generic wheel.
# The pip installs below are constrained to the torch, torchvision and triton
# builds the base image ships (on top of any constraint the base image sets).
RUN pip list --format=freeze | grep -iE '^(torch|torchvision|torchaudio|triton|pytorch-triton)==' \
        > /etc/studio-base-constraints.txt \
 && cat /etc/studio-base-constraints.txt
RUN export PIP_CONSTRAINT="${PIP_CONSTRAINT:+$PIP_CONSTRAINT }/etc/studio-base-constraints.txt" \
 && pip install --no-cache-dir --no-deps /wheels/*.whl \
 && pip install --no-cache-dir -r docker/fastvideo-requirements.txt \
 && rm -rf /wheels
COPY pyproject.toml ./
COPY studio ./studio
COPY web ./web
RUN export PIP_CONSTRAINT="${PIP_CONSTRAINT:+$PIP_CONSTRAINT }/etc/studio-base-constraints.txt" \
 && pip install --no-cache-dir ".[inference]"
EXPOSE 8090
VOLUME ["/data"]
CMD ["python", "-m", "studio"]
