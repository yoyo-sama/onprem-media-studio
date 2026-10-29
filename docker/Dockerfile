# One image, one container: API + front end + llama-server + (later) the
# diffusion runtimes. Target: DGX OS / Ubuntu on ARM64 with a GB10 (sm_121).
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

FROM ${BASE_IMAGE}
ENV PYTHONUNBUFFERED=1 \
    STUDIO_DATA_DIR=/data \
    STUDIO_LLAMA_SERVER=/opt/llama/llama-server \
    LD_LIBRARY_PATH=/opt/llama:${LD_LIBRARY_PATH} \
    HF_HUB_ENABLE_HF_TRANSFER=0
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --from=llama /opt/llama /opt/llama
WORKDIR /app
COPY pyproject.toml ./
COPY studio ./studio
COPY web ./web
# torch comes from the base image: never let pip replace it with a generic wheel.
RUN pip install --no-cache-dir .
EXPOSE 8090
VOLUME ["/data"]
CMD ["python", "-m", "studio"]
