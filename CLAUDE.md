# CLAUDE.md — pi-mobile

## Project

Browser UI for pi coding agent sessions. Bun + TypeScript server, vanilla JS frontend.

```bash
# Dev
bun src/server.ts --host 100.114.118.78 --port 4317
```

## Production service

The systemd service `pi-mobile` runs from `/root/pi-mobile` (the **main** branch checkout).

```bash
systemctl restart pi-mobile
systemctl status pi-mobile
journalctl -u pi-mobile -n 50
```

## ⚠️ Worktree rules

If your current working directory is inside `.worktrees/` (e.g. `/root/pi-mobile/.worktrees/worktree-wt-*/`), you are in a **git worktree** — an isolated branch for development.

**You MUST follow these rules:**

1. **Only edit files inside your worktree directory.** Never `cd` to `/root/pi-mobile` to edit files there.
2. **Do NOT restart the `pi-mobile` systemd service.** The service runs from main and is unrelated to your worktree branch.
3. **Do NOT modify `/root/pi-mobile/` files directly.** Your changes go in your worktree only.
4. **To test your changes**, run the dev server from your worktree directory:
   ```bash
   cd /root/pi-mobile/.worktrees/worktree-wt-YOURNAME
   bun src/server.ts --port 4318  # Use a different port than production
   ```
5. When done, commit in your worktree branch. The main branch is merged separately.

**How to check if you're in a worktree:**
```bash
# If this returns a path under .worktrees/, you're in a worktree
pwd
git rev-parse --show-toplevel
```
