# Roadmap

French version: [fr/ROADMAP.md](fr/ROADMAP.md).

| Step | Content | Status |
|---|---|---|
| 1. Foundation | Repository, FastAPI server, job queue, model catalog and automatic download, Gemma through llama.cpp, Docker image for GB10, lessons from 1.4 | In progress: code and unit tests done; first build and LLM call on GB10 pending |
| 2. Image | Krea 2 (text to image, campaign, sheets) and Qwen Image 2.1 (image to image, keyframes with sheet + setting references; Qwen-Image-Edit 2509 dropped on 2026-10-29), each qualified by a real render compared with 1.4 | In progress: engines, image upload and references, unit tests and qualification cases done ([IMAGE-ENGINES.md](IMAGE-ENGINES.md)); first GPU run on the GB10 done (every case rendered); visual comparison with 1.4 pending |
| 3. Video | FastH3 OmniRef for reference-to-video (two-pass workflow validated on 2026-10-28), FastH3 for text/image/first-last-frame to video; storyboard cuts, Reference2Video and Relay move to H3; LTX 2.5 removed | In progress: engines (two-pass Ref2VA with our latent upscaler, LoRA stack, FP8 fallback), unit tests and qualification cases done ([H3.md](H3.md)); real renders on GB10 pending |
| 4. Parity and bare metal | Studio and Canvas front end ported (English code, FR/EN/ES/DE interface), gallery, in-app update, regression tests; bare-metal install script for DGX OS and Ubuntu | To do |

Later: Omarchy, Windows 11 (x86 and ARM64).
