# pi-mobile

<video src="piwebdemo.mp4" autoplay loop muted playsinline width="400"></video>

Web UI for the `pi` coding agent, built on the `@mariozechner/pi-coding-agent` SDK.

`pi-mobile` runs the agent on whatever machine hosts the server. You connect from any device (laptop, phone, tablet) to control and view sessions through a browser.

- Create, resume, and stream sessions live (reasoning, tool calls, output)
- Stream assistant output, reasoning, and tool execution live
- Switch model and thinking level mid-session
- Mobile-friendly: keybar for Esc / Release / Take over / Enter, slide-out sidebar
- Commands menu shows session commands, prompt templates, and skills
- Image upload support for prompts, including mobile photo picker / paste
- Push notifications on iPhone home-screen installs when assistant messages arrive
- **Tailscale** — bind to your tailnet IP, auto-TLS with MagicDNS, no token needed
- **Cloudflare Tunnels** — expose securely with `cloudflared`, Cloudflare Access for auth
- **Face ID / Touch ID** — optional WebAuthn biometric access control on remote

SDK upstream: https://github.com/badlogic/pi-mono


https://github.com/user-attachments/assets/f21f9abf-23e5-43a1-9ef4-40ec70940e78


Sessions are JSONL on disk, same location as the native `pi` CLI.
 
## Quick start

```bash
bun install
bun run dev -- --port 4317
```

Open `http://localhost:4317`.

Note: Face ID (WebAuthn) is optional and generally requires a hostname like `localhost` or a real domain; raw IPs like `127.0.0.1` may fail. Enable it with `?faceid=1`.

See the Runbook (RUNBOOK.md) for Tailscale, Cloudflare, and token auth setup.

## Voice transcription (Parakeet) setup

`pi-mobile` uses local Parakeet transcription when you tap the mic button.

Required runtime dependencies:

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg python3 python3-pip
python3 -m pip install --upgrade numpy onnxruntime
```

Required files on the host:

- Transcriber script: `/usr/local/bin/parakeet-transcribe`
- Model directory: `/usr/local/share/parakeet-tdt-0.6b-v3-int8`
- Required model files are listed in [`PARAKEET_MODEL_FILES.txt`](./PARAKEET_MODEL_FILES.txt)

Note: model binaries are large and are not committed to git; install them on the server at the path above.

Quick health check:

```bash
test -x /usr/local/bin/parakeet-transcribe && echo "ok: script"
for f in $(cat PARAKEET_MODEL_FILES.txt); do test -f "/usr/local/share/parakeet-tdt-0.6b-v3-int8/$f" || echo "missing: $f"; done
```

If the script or model directory is missing, `/api/voice/transcribe` returns: `Parakeet not available on this server`.

## Data locations

| What | Path |
|------|------|
| Sessions (JSONL) | `~/.pi/agent/sessions/` |
| Saved repos | `~/.pi/agent/pi-web/repos.json` |
| Face ID credentials | `~/.pi/agent/pi-web/faceid-credentials.json` |

## Session semantics

- **Abort** stops the current run but keeps the session runtime alive. Never deletes JSONL.
- **Release** aborts and disposes the web runtime so you can safely resume the same JSONL in the native CLI (no concurrent writers).

Do not open the same session in `pi-web` and the native `pi` CLI simultaneously. Use Release in the web UI before resuming in the CLI.

## Credits

Built on top of [pi](https://github.com/badlogic/pi-mono) by [badlogic](https://github.com/badlogic).
