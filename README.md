# RemoteGit

A GitHub Desktop-style Git client for repositories that live **on a server**. It connects over SSH, so the code stays on the server while you see changes, diffs, history and branches, and commit, push and pull from your Mac or Windows PC.

![Changes](docs/screenshot.png)
![History](docs/history.png)

## How it works

- Uses the SSH client already on your system (`ssh` on macOS, OpenSSH on Windows 10/11), so your keys, ssh-agent and `~/.ssh/config` just work.
- Keeps **one persistent SSH connection** per server and sends every git command through it, so a refresh is one quick command, not a new login.
- Nothing to install on the server besides `git` and `sh`.
- While the window is visible, status refreshes every 3 s. Changes made elsewhere on the server (VS Code, vim, …) show up on their own. When the window is hidden, the app does nothing.
- Built with Tauri, so the installer is a few MB and memory use is low.

## Features

- **Changes:** changed files with checkboxes, a diff with line numbers, and a commit of only the checked files (summary + description) with **Undo**.
- **History:** list of commits (unpushed ones have an ↑ arrow), commit details, changed files and diff.
- **Branches:** switch, create, and check out remote branches.
- **Fetch / Pull / Push / Publish branch** in one button, like GitHub Desktop. Right-click the button to pick a specific action.
- Right-click a file to discard changes, add it to `.gitignore`, or copy its path.
- Multiple servers and repositories. Repositories can be found on the server automatically (in `~`, `/var/www`, `/srv`).
- "Open in VS Code" opens the repo through Remote-SSH. "Copy SSH command" copies a command that opens a terminal in the repo folder.
- Light and dark mode, following the system.

Shortcuts: `⌘/Ctrl+Enter` commit · `⌘/Ctrl+1` / `2` Changes / History · `⌘/Ctrl+T` repository picker · `⌘/Ctrl+B` branches · `⌘/Ctrl+R` refresh · ↑/↓ arrows in lists.

## Connection requirements

RemoteGit signs in with an **SSH key**; it never fills in passwords. If `ssh user@server` works in a terminal without asking for a password, the app will work too. If not:

```bash
ssh-keygen -t ed25519        # if you don't have a key yet
ssh-copy-id user@server      # uploads the key to the server
```

On Windows (PowerShell), where `ssh-copy-id` isn't available:

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh user@server "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

**Pushing to GitHub from the server:** either the server has its own SSH key added to GitHub, or turn on **Forward my SSH agent** in the app's server settings so the server uses the keys from your computer.

## Build

### A) Automatically with GitHub Actions (easiest)

1. Open **Actions → Build → Run workflow**.
2. When it finishes (about 10 minutes), download from *Artifacts*:
   - `RemoteGit-macOS` → `.dmg` (universal: Apple Silicon and Intel)
   - `RemoteGit-Windows` → `.msi` and `.exe` installers

Pushing a tag (`git tag v0.1.0 && git push --tags`) also creates a draft GitHub Release with the installers.

### B) Locally

**macOS:**
```bash
xcode-select --install                                   # once
curl https://sh.rustup.rs -sSf | sh                       # once, installs Rust
npm ci
npm run build
# → src-tauri/target/release/bundle/dmg/RemoteGit_0.1.0_aarch64.dmg
```

**Windows:** install [Rust](https://rustup.rs), [Node.js](https://nodejs.org) and *Visual Studio Build Tools* (the "Desktop development with C++" workload). Then:
```powershell
npm ci
npm run build
# → src-tauri\target\release\bundle\msi\  and  \nsis\
```

### First launch (the app is not signed)

- **macOS:** a warning appears the first time you open it. Go to *System Settings → Privacy & Security* and click **Open Anyway**, or run `xattr -cr /Applications/RemoteGit.app` in a terminal.
- **Windows:** SmartScreen → **More info → Run anyway**.

## Development

```bash
npm run dev        # Tauri app with live UI reload
npm run preview    # UI in the browser at http://localhost:1420; commands run in a local sh instead of over SSH
npm test           # git logic tests against real repositories
cd src-tauri && cargo test   # SSH layer tests
```

Layout:

| File | What it does |
|---|---|
| `src-tauri/src/ssh.rs` | persistent SSH connection, framing of each command's output |
| `src-tauri/src/main.rs` | Tauri commands `ssh_connect`, `ssh_exec`, `ssh_disconnect` |
| `src/git.js` | git commands (safely escaped) and parsers for their output |
| `src/app.js` | UI (plain JavaScript, no framework, no build step) |
| `src/styles.css` | styling, light and dark mode |

## Not supported yet

Password login (keys only), resolving merge conflicts inside the app (conflicts are shown; resolve them in an editor, then commit), stash, image diffs, signing commits with a passphrase-protected key.
