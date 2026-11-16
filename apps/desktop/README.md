# Windows desktop scaffold — not yet built

This Tauri 2 shell packages the **same** Vite/React application; it does not replace the molecular
editor, duplicate laboratory chemistry, or install a hidden science service. FastAPI/PostgreSQL
remain separate services. There are no Rust commands/plugins or filesystem/shell IPC permissions.

## Current verification status

On the integration machine, `npm run desktop:check` reports `BLOCKED_NOT_BUILT` and exits 1:
`rustc`, `cargo` and `cargo-tauri` are unavailable. No Rust binary, installer, desktop screenshot,
WebView2 compatibility result or signed release is claimed. The dependency lock cannot honestly
be generated without Cargo and is **not** fabricated.

Versions were checked against crates.io on 2026-11-16:

| Component | Pin |
| --- | --- |
| Rust/Cargo MSVC toolchain | `1.95.0` |
| `tauri` crate | `=2.12.5` (requires Rust 1.95) |
| `tauri-build` crate | `=2.7.4` |
| `cargo-tauri` CLI | `2.12.4` |
| Initial target | `x86_64-pc-windows-msvc` |

Prerequisites: [Tauri's Windows setup](https://v2.tauri.app/start/prerequisites/#windows),
Visual Studio Build Tools **Desktop development with C++** and Windows SDK, Rust MSVC toolchain,
and Microsoft Edge WebView2 Evergreen. Only the Windows scaffold is configured; Linux/macOS
desktop support is not claimed.

## Bring-up on a prepared machine

Run from the repository root; install the external toolchains deliberately, not through an
implicit build-script download:

```powershell
rustup toolchain install 1.95.0 --profile minimal --component rustfmt --component clippy
cargo +1.95.0 install tauri-cli --version 2.12.4 --locked
npm ci
npm run desktop:lock
```

Review and commit the generated `apps\desktop\src-tauri\Cargo.lock` before treating subsequent
builds as dependency-reproducible. Then:

```powershell
npm run desktop:check
npm run desktop:build       # unsigned executable, Cargo --locked, no installer
npm run desktop:bundle      # unsigned NSIS candidate; not a signed/public release
```

The build hooks run the existing root web build. Icons are deterministically generated from
repository-owned source by `tools\release\create-icons.mjs` before compilation, without an image
download or additional package. `qa\results\desktop-*.json` preserves prerequisite/build outcomes.

Development normally starts the existing Vite command on 5273:

```powershell
npm run desktop:dev
```

If that task's existing dev server already owns 5273, explicitly reuse it instead of starting or
killing another server:

```powershell
$env:MATTERLAB_DESKTOP_EXISTING_DEV_SERVER = '1'
npm run desktop:dev
```

Do not start this during another agent's GPU verification window.

## Release gate

The manual `Experimental Windows desktop scaffold` workflow installs the pinned toolchain, checks
formatting, compiles with `--locked`, and runs Clippy. It can bootstrap the initial lock **only**
when the explicit `bootstrap_lock` input is enabled; that candidate is not a reproducible release.
Its unsigned executable and exact lockfile are review artifacts, never an automatic publication.

Before desktop support can be signed off:

- Commit/review the real Cargo dependency lock and pass the hosted/local Rust build.
- Exercise WebView2 workers/WASM, molecular editing, separate meter-scale Lab navigation,
  service authorization/origins, save/reopen, cancellation, downloads and offline behavior.
- Verify the configured CSP against the actual built application; do not disable it to hide
  failures. Native IPC remains unexposed.
- Test installer/uninstaller and generate/verify Authenticode signatures using a properly
  managed certificate. No signing secrets belong in this repository.
- Record the actual OS, GPU, WebView2 version and measured rendering/fallback behavior.

NSIS may download the WebView2 bootstrapper; this is not an offline all-in-one installer.
There is no automatic updater or embedded backend. A successful prerequisite probe is never
reported as a successful desktop build.
