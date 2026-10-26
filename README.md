# RemoteGit

Git klient v štýle GitHub Desktop pre repozitáre, ktoré sú **na serveri**. Pripája sa cez SSH, takže kód zostáva na serveri a na svojom Macu alebo Windowse vidíš zmeny, diffy, históriu, vetvy a robíš commit, push aj pull.

![Changes](docs/screenshot.png)
![History](docs/history.png)

## Ako to funguje

- Appka používa SSH klienta, ktorý je už v systéme (`ssh` na macOS, OpenSSH na Windows 10/11). Fungujú tvoje kľúče, ssh-agent aj `~/.ssh/config`.
- Na každý server sa otvorí **jedno trvalé SSH spojenie** a cezň idú všetky git príkazy. Obnovenie stavu je potom len jeden rýchly príkaz, nie nové prihlásenie.
- Na serveri netreba nič inštalovať, stačí `git` a `sh`.
- Kým je okno viditeľné, stav sa obnovuje každé 3 s. Zmeny, ktoré na serveri urobíš inde (vo VS Code alebo vo vim), sa v appke objavia samy. Keď je okno skryté, appka nič nerobí.
- Appka je postavená na Tauri, takže inštalátor má pár MB a spotreba RAM je nízka.

## Funkcie

- **Changes:** zoznam zmenených súborov so zaškrtávaním, diff s číslami riadkov a commit len zaškrtnutých súborov (summary + description) s tlačidlom **Undo**.
- **History:** zoznam commitov (nepushnuté majú šípku ↑), detail commitu, zoznam súborov a diff.
- **Vetvy:** prepínanie, vytvorenie novej vetvy a checkout vetvy z remote.
- **Fetch / Pull / Push / Publish branch** jedným tlačidlom, ako v GitHub Desktop. Pravým klikom na tlačidlo vyberieš konkrétnu akciu.
- Pravý klik na súbor ponúka Discard changes, pridanie do `.gitignore` a skopírovanie cesty.
- Viac serverov a viac repozitárov. Repá sa dajú na serveri vyhľadať automaticky (v `~`, `/var/www`, `/srv`).
- „Open in VS Code“ otvorí repo cez Remote-SSH. „Copy SSH command“ skopíruje príkaz na terminál priamo v priečinku repa.
- Svetlý aj tmavý režim podľa systému.

Skratky: `⌘/Ctrl+Enter` commit · `⌘/Ctrl+1` / `2` Changes / History · `⌘/Ctrl+T` výber repa · `⌘/Ctrl+B` vetvy · `⌘/Ctrl+R` obnoviť · šípky ↑/↓ v zoznamoch.

## Požiadavky na pripojenie

RemoteGit sa prihlasuje **SSH kľúčom**, heslo nevypĺňa. Ak `ssh user@server` v termináli funguje bez pýtania hesla, bude fungovať aj appka. Ak nie:

```bash
ssh-keygen -t ed25519        # ak ešte nemáš kľúč
ssh-copy-id user@server      # nahrá kľúč na server
```

Na Windows (PowerShell), kde `ssh-copy-id` nie je:

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh user@server "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"
```

**Push na GitHub zo servera:** buď má server vlastný SSH kľúč pridaný v GitHube, alebo v nastaveniach servera v appke zapni **Forward my SSH agent** a server potom použije kľúče z tvojho počítača.

## Build

### A) Automaticky cez GitHub Actions (najjednoduchšie)

1. Nahraj projekt do GitHub repozitára.
2. Otvor **Actions → Build → Run workflow**.
3. Po dobehnutí (cca 10 min) stiahneš v sekcii *Artifacts*:
   - `RemoteGit-macOS` → `.dmg` (univerzálny, Apple Silicon aj Intel)
   - `RemoteGit-Windows` → `.msi` a `.exe` inštalátor

Keď pushneš tag (`git tag v0.1.0 && git push --tags`), vytvorí sa aj draft GitHub Release s inštalátormi.

### B) Lokálne

**macOS:**
```bash
xcode-select --install                                   # raz
curl https://sh.rustup.rs -sSf | sh                       # raz, Rust
npm ci
npm run build
# → src-tauri/target/release/bundle/dmg/RemoteGit_0.1.0_aarch64.dmg
```

**Windows:** nainštaluj [Rust](https://rustup.rs), [Node.js](https://nodejs.org) a *Visual Studio Build Tools* (workload „Desktop development with C++“). Potom:
```powershell
npm ci
npm run build
# → src-tauri\target\release\bundle\msi\  a  \nsis\
```

### Prvé spustenie (appka nie je podpísaná)

- **macOS:** pri prvom otvorení vyskočí varovanie. Choď do *System Settings → Privacy & Security* a klikni **Open Anyway**. Alebo v termináli spusti `xattr -cr /Applications/RemoteGit.app`.
- **Windows:** SmartScreen → **More info → Run anyway**.

## Vývoj

```bash
npm run dev        # Tauri appka s okamžitým reloadom UI
npm run preview    # UI v prehliadači na http://localhost:1420, príkazy idú do lokálneho sh namiesto SSH
npm test           # testy git logiky proti skutočným repám
cd src-tauri && cargo test   # testy SSH vrstvy
```

Štruktúra:

| Súbor | Čo robí |
|---|---|
| `src-tauri/src/ssh.rs` | trvalé SSH spojenie, oddeľovanie výstupov príkazov |
| `src-tauri/src/main.rs` | Tauri príkazy `ssh_connect`, `ssh_exec`, `ssh_disconnect` |
| `src/git.js` | git príkazy (bezpečne escapované) a parsery ich výstupu |
| `src/app.js` | UI (čistý JavaScript bez frameworku a bez build kroku) |
| `src/styles.css` | vzhľad, svetlý a tmavý režim |

## Zatiaľ nepodporované

Prihlásenie heslom (len kľúče), riešenie merge konfliktov priamo v appke (konflikty sa zobrazia, vyriešiš ich v editore a potom commitneš), stash, diff obrázkov, podpisovanie commitov s heslom ku kľúču.
