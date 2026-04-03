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

## Install

```bash
git clone https://github.com/basedcorp99/pi-mobile.git
cd pi-mobile
./setup.sh
```

The setup script:
- Installs bun dependencies
- Creates a `pi-mobile` launcher in `~/.bin` and adds it to PATH
- Installs a repo-owned systemd unit at `/etc/systemd/system/pi-mobile.service`
- Enables + starts the `pi-mobile` service
- Installs the custom `/review` Pi extension to `~/.pi/agent/extensions/review.ts`
- Optionally installs voice transcription (Parakeet model, ~640MB)

`pi-mobile` itself is a standalone web app repo, not a Pi package you should add to `~/.pi/agent/settings.json` under `packages`.
The `/review` extension source lives in `pi-extension/review.ts` and is copied into Pi's normal extension directory by `./setup.sh`.

After setup:

```bash
pi-mobile                              # manual run
sudo systemctl restart pi-mobile       # managed service restart
journalctl -u pi-mobile -f             # live logs
```

By default, `./setup.sh` installs the systemd service using:
- `PI_MOBILE_HOST` if set
- otherwise your Tailscale IPv4 if available
- otherwise `127.0.0.1`

You can override service bind settings during setup:

```bash
PI_MOBILE_HOST=127.0.0.1 PI_MOBILE_PORT=4317 ./setup.sh
```

See [RUNBOOK.md](./RUNBOOK.md) for systemd, Tailscale / Cloudflare / TLS / auth details, plus notes on the installed `/review` extension.

## Prerequisites

- [bun](https://bun.sh) runtime
- [pi](https://github.com/badlogic/pi-mono) coding agent

Optional (for voice input):
- python3, numpy, onnxruntime
- ffmpeg

---

## Voice transcription (Parakeet)

Voice is optional — if not installed, the mic button is disabled and the server returns "Parakeet not available".

The easiest way to set it up is `./setup.sh --all`. It installs everything to user directories (`~/.bin`, `~/.local/share`) — no sudo required.

### Manual setup

<details>
<summary>Click to expand manual voice setup</summary>

#### 1) Install runtime deps

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg python3 python3-pip
python3 -m pip install --upgrade numpy onnxruntime
```

#### 2) Install transcriber script

The script is included in the repo as `parakeet-transcribe`. Copy it somewhere in PATH:

```bash
cp parakeet-transcribe ~/.bin/
chmod +x ~/.bin/parakeet-transcribe
```

pi-mobile checks these locations (first match wins):
- `~/.bin/parakeet-transcribe`
- `/usr/local/bin/parakeet-transcribe`

#### 3) Download model files

```bash
curl -L https://blob.handy.computer/parakeet-v3-int8.tar.gz -o /tmp/parakeet-v3-int8.tar.gz
mkdir -p ~/.local/share
tar -xzf /tmp/parakeet-v3-int8.tar.gz -C ~/.local/share
rm /tmp/parakeet-v3-int8.tar.gz
```

pi-mobile checks these locations (first match wins):
- `~/.local/share/parakeet-tdt-0.6b-v3-int8`
- `/usr/local/share/parakeet-tdt-0.6b-v3-int8`

Required files are listed in [`PARAKEET_MODEL_FILES.txt`](./PARAKEET_MODEL_FILES.txt).

#### 4) Health check

```bash
test -x ~/.bin/parakeet-transcribe && echo "ok: script"
for f in $(cat PARAKEET_MODEL_FILES.txt); do
  test -f ~/.local/share/parakeet-tdt-0.6b-v3-int8/$f || echo "missing: $f"
done
```

</details>

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
