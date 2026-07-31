# Mimir Scribe third-party notices

This file carries the full-text and attribution notices for third-party code
and model assets added specifically for Mimir Scribe. It is packaged with the
desktop application. The complete locked Rust and JavaScript component
inventory and declared license expressions are packaged beside it as
`SBOM.spdx.json` and `THIRD_PARTY_LICENSES.md`; `Cargo.lock` and `bun.lock`
remain the resolution authorities checked against that inventory.

## Fastrepl Anarlog

- Source: https://github.com/fastrepl/anarlog
- Audited commit: `08aad83f0c5cef1317d74a31519ae3190d726504`
- Copyright: Copyright (c) 2023-present Fastrepl, Inc.
- License: MIT
- Use: narrowly adapted capture and detection behavior in the Mimir-owned
  `mimir-meeting-audio` and `mimir-meeting-detect` crates.
- Detailed extraction boundary and source hashes:
  `vendor/anarlog/NOTICE.md` and `vendor/anarlog/import-manifest.tsv`.

MIT License

Copyright (c) 2023-present Fastrepl, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## whisper-rs and whisper-rs-sys

- Source: https://codeberg.org/tazz4843/whisper-rs
- Packages: `whisper-rs` 0.16.0 and `whisper-rs-sys` 0.15.0
- Registry checksums:
  - `whisper-rs`: `2088172d00f936c348d6a72f488dc2660ab3f507263a195df308a3c2383229f6`
  - `whisper-rs-sys`: `6986c0fe081241d391f09b9a071fbcbb59720c3563628c3c829057cf69f2a56f`
- License: The Unlicense
- Use: Rust bindings and build integration for the managed local transcriber.

This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or distribute
this software, either in source code form or as a compiled binary, for any
purpose, commercial or non-commercial, and by any means.

In jurisdictions that recognize copyright laws, the author or authors of this
software dedicate any and all copyright interest in the software to the
public domain. We make this dedication for the benefit of the public at large
and to the detriment of our heirs and successors. We intend this dedication
to be an overt act of relinquishment in perpetuity of all present and future
rights to this software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to https://unlicense.org.

## whisper.cpp

- Source: https://github.com/ggerganov/whisper.cpp
- Embedded version: 1.8.3, distributed inside `whisper-rs-sys` 0.15.0
- Copyright: Copyright (c) 2023-2024 The ggml authors
- License: MIT
- Use: Metal-accelerated local Whisper inference.

MIT License

Copyright (c) 2023-2024 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## OpenAI Whisper Small multilingual model

- Upstream model: OpenAI Whisper Small multilingual, 244 million parameters
- Conversion repository: https://huggingface.co/ggerganov/whisper.cpp
- Immutable repository commit:
  `c521a4b02f422512d734391fdf08bb08c0862f68`
- Artifact: `ggml-small.bin`
- Exact length: `487601967` bytes
- SHA-256:
  `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`
- License: MIT; OpenAI states that Whisper code and model weights are
  released under this license.
- Distribution: downloaded on explicit user action, never embedded in Mimir;
  verified before installation and again before every load; removable in
  Scribe settings.

MIT License

Copyright (c) 2022 OpenAI

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
