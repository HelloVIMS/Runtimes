# VIMS Agent Shell Runtimes

Pre-compiled, cross-platform binaries for the eight VIMS agent shells, keyed
on each upstream project's commit SHA. Built daily on this public repo's
free GitHub Actions minutes; consumed by [VIMS](https://vims.com)
and anyone else who wants reproducible shell runtimes without a 90-minute
cold compile.

## Shells

| Shell      | Upstream                                         | Language              |
|------------|--------------------------------------------------|-----------------------|
| openclaw   | https://github.com/openclaw/openclaw             | TypeScript / Node     |
| zeroclaw   | https://github.com/zeroclaw-labs/zeroclaw        | Rust                  |
| nanoclaw   | https://github.com/qwibitai/nanoclaw             | TypeScript / Node     |
| nemoclaw   | https://github.com/nvidia/nemoclaw               | Python (NeMo)         |
| mirofish   | https://github.com/mirofish/mirofish             | Python (PyInstaller)  |
| picoclaw   | https://github.com/sipeed/picoclaw               | Go                    |
| hermes     | https://github.com/hermes-runtime/hermes         | Python (pipx)         |
| openfang   | https://github.com/openfang/openfang             | Rust (Tauri)          |

## Targets

`darwin-arm64` · `darwin-amd64` · `linux-amd64` · `linux-arm64` · `windows-amd64`

## Layout

Each release is `<shell>-<sha12>` where `<sha12>` is the first 12 chars of
the upstream commit. The release contains one asset per platform:

```
openclaw-a3b2c1d4e5f6
├── openclaw-darwin-arm64
├── openclaw-darwin-amd64
├── openclaw-linux-amd64
├── openclaw-linux-arm64
└── openclaw-windows-amd64.exe
```

## Usage

### Resolve current upstream SHAs

```bash
git ls-remote https://github.com/openclaw/openclaw HEAD | cut -f1 | head -c 12
```

### Download a specific binary

```bash
SHA12=a3b2c1d4e5f6
curl -fL -o openclaw \
  https://github.com/HelloVIMS/Runtimes/releases/download/openclaw-$SHA12/openclaw-linux-amd64
chmod +x openclaw
```

### Or with `gh`:

```bash
gh release download openclaw-$SHA12 \
  --repo HelloVIMS/Runtimes \
  --pattern 'openclaw-linux-amd64'
```

## Building

The full build matrix runs on schedule a weekly schedule and on manual
dispatch. Per-shell SHA-keyed cache means re-runs against unchanged
upstreams are near-instant.

```bash
gh workflow run build-runtimes.yml --repo HelloVIMS/Runtimes
gh workflow run build-runtimes.yml --repo HelloVIMS/Runtimes \
  -f only=mirofish,openfang   # rebuild a subset
```

## Licensing

Binaries are redistributed under each upstream project's original license.
This repo's workflow + scripts are MIT (see `LICENSE`). Verify the license
of the specific shell you redistribute.

## Trust model

These binaries are reproducible from the commit SHA referenced in the
release tag. Build provenance is recorded in each release's notes (CI run
URL + timestamp). 
