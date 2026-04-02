# pi-mobile

Web UI for the `pi` coding agent (mobile + desktop).

`pi-mobile` runs the agent on the host machine and lets you control sessions from browser clients (phone, tablet, laptop).

## What it supports

- Live session streaming (assistant text, reasoning, tools)
- Create/resume/release sessions
- Model + thinking controls
- Prompt images (upload/paste/camera picker)
- Ask-tool dialogs, commands list, mobile-friendly sidebar
- Optional push notifications
- Optional Face ID / Touch ID gate

Sessions are JSONL on disk, same location as native `pi` CLI.

## Quick start

```bash
bun install
bun run dev -- --port 4317
```

Open `http://localhost:4317`.

See [RUNBOOK.md](./RUNBOOK.md) for Tailscale / Cloudflare / auth setup.

---

## Voice transcription (Parakeet) setup

`pi-mobile` uses local Parakeet transcription when you tap the mic button.

### 1) Install runtime deps

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg python3 python3-pip
python3 -m pip install --upgrade numpy onnxruntime
```

### 2) Install transcriber script

Expected path:

- `/usr/local/bin/parakeet-transcribe`

Make sure it is executable:

```bash
sudo chmod +x /usr/local/bin/parakeet-transcribe
```

### 3) Download model files (Handy source URLs)

These model archives are the same ones Handy uses:

- Recommended (V3): `https://blob.handy.computer/parakeet-v3-int8.tar.gz`
- Optional (V2): `https://blob.handy.computer/parakeet-v2-int8.tar.gz`
- Handy model docs: `https://handy.computer/docs/models`

Install V3 to the path expected by `pi-mobile`:

```bash
curl -L https://blob.handy.computer/parakeet-v3-int8.tar.gz -o /tmp/parakeet-v3-int8.tar.gz
sudo mkdir -p /usr/local/share
sudo tar -xzf /tmp/parakeet-v3-int8.tar.gz -C /usr/local/share
```

Expected final model dir:

- `/usr/local/share/parakeet-tdt-0.6b-v3-int8`

Required files in that directory are listed in [`PARAKEET_MODEL_FILES.txt`](./PARAKEET_MODEL_FILES.txt).

> Note: model binaries are large and are intentionally not committed to git.

### 4) Health check

```bash
test -x /usr/local/bin/parakeet-transcribe && echo "ok: script"
for f in $(cat PARAKEET_MODEL_FILES.txt); do test -f "/usr/local/share/parakeet-tdt-0.6b-v3-int8/$f" || echo "missing: $f"; done
```

If script or model files are missing, `/api/voice/transcribe` returns:

`Parakeet not available on this server`

---

## Data locations

| What | Path |
|------|------|
| Sessions (JSONL) | `~/.pi/agent/sessions/` |
| Saved repos | `~/.pi/agent/pi-web/repos.json` |
| Face ID credentials | `~/.pi/agent/pi-web/faceid-credentials.json` |

## Session semantics

- **Abort**: stops current run, keeps runtime alive.
- **Release**: aborts and disposes runtime so you can safely resume the same JSONL in native `pi`.

Do not open the same session in `pi-mobile` and native `pi` at the same time.

## Credits

Built on top of [pi](https://github.com/badlogic/pi-mono) by [badlogic](https://github.com/badlogic).
