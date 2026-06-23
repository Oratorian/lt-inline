# Bundled binaries

`install.ps1` (native mode) looks here for a prebuilt **`fasttext.exe`** so Windows
users don't need a C++ toolchain. LanguageTool needs the fastText *binary* (the
`fasttextBinary` property) in addition to the `lid.176.bin` language-id model, and
on Windows it must be runnable from any console (so the installer puts this dir on
your user PATH).

## What's here

    lt-stack/bin/fasttext.exe   ← the bundled fastText CLI

The installer copies it into the stack dir, adds that dir to your user PATH, and
writes `fasttextBinary=fasttext` (bare command name) into `server.properties`.
If it's missing (and not already on PATH), native-mode fastText setup aborts with
instructions.

## How `fasttext.exe` was built (Windows, CMake + MSVC)

fastText has **no `make` build on Windows** — use its CMakeLists.txt with the
MSVC compiler (Visual Studio or Build Tools, "Desktop development with C++").
From a Developer PowerShell for VS:

    git clone https://github.com/facebookresearch/fastText.git
    cd fastText
    cmake -B build -S .
    cmake --build build --config Release --target fasttext-bin
    # -> build\Release\fasttext.exe   (copy here as fasttext.exe)

Two MSVC fixes were needed in fastText's `CMakeLists.txt` (its code predates
modern MSVC): link `Threads::Threads` instead of bare `pthread`, and gate the
GCC-only flags (`-pthread -funroll-loops -O3 -march=native`) behind `if(NOT
MSVC)` (use `/O2` on MSVC). After building, run `fasttext.exe` once to confirm it
has no missing DLLs.

Source: <https://github.com/facebookresearch/fastText> — MIT license, archived but
stable, C++11.

## Linux

`install.sh` obtains fastText itself (package manager, else source build), so no
Linux binary needs to live here.
