# Running the Daily Brief on the Mac mini

The Mac mini is always-on, so it's the ideal home for this — no laptop sleep/wake
or Wi-Fi-not-ready issues. This guide moves the daily 6 AM brief over in a few
minutes. (Windows keeps working meanwhile; this just becomes the permanent home.)

## What you need
- The Mac mini, signed in
- Your current `.env` values from the Windows machine (the 4 secrets below) —
  copy them over securely (AirDrop / USB / password manager), **not** through git

## Steps (run in Terminal on the Mac mini)

### 1. Install Node (if not already)
```bash
# Install Homebrew if you don't have it: https://brew.sh
brew install node
node --version    # should be v20.6+ (needed for --env-file)
```

### 2. Get the project
```bash
mkdir -p ~/projects && cd ~/projects
git clone https://github.com/OscarNeatoLV1/ai-productivity-brief.git productivity-brief
cd productivity-brief
npm install
```

### 3. Create the `.env` (the secrets)
```bash
cp .env.example .env
nano .env      # paste your real values, then Ctrl+O, Enter, Ctrl+X
```
Fill in the four values (same as the Windows `.env`):
```
ANTHROPIC_API_KEY=sk-ant-...
ARCHIVE_URL=https://neato-ops-default-rtdb.firebaseio.com/archives.json
SLACK_BOT_TOKEN=xoxb-...
SLACK_DM_TO=U08D4F721T6
```

### 4. Test it once
```bash
bash run-brief.sh
tail -n 30 brief.log     # should show the brief + "Sent to your Slack DM."
```
Check your Slack DM — the brief should be there.

### 5. Schedule it daily at 6:00 AM
```bash
bash setup-macmini.sh
```
That installs a launchd job that runs `run-brief.sh` every morning at 6:00.
Because the Mac mini is always on, it just works — no wake/network tricks needed.

Verify it's loaded:
```bash
launchctl list | grep neato
```

## Managing it later
- **See logs:** `tail -f ~/projects/productivity-brief/brief.log`
- **Run manually anytime:** `bash ~/projects/productivity-brief/run-brief.sh`
- **Change the time:** edit `setup-macmini.sh` (the `Hour`/`Minute`) and re-run it
- **Stop it:** `launchctl unload ~/Library/LaunchAgents/com.neato.productivity-brief.plist`
- **Start it again:** `launchctl load ~/Library/LaunchAgents/com.neato.productivity-brief.plist`

## After it's confirmed working on the Mac
Turn off the Windows scheduled task so the brief doesn't send twice:
- Windows → Task Scheduler → **"Neato Productivity Brief"** → right-click → **Disable**
  (or in PowerShell: `Disable-ScheduledTask -TaskName "Neato Productivity Brief"`)

## Notes
- `brief.js` retries the data fetch (10× / 30s) if the network is briefly down —
  harmless on the always-on Mac, kept for robustness.
- Files: `brief.js` (app), `run-brief.sh` (launcher), `setup-macmini.sh` (scheduler
  installer), `run-brief.bat` (old Windows launcher — ignored, not needed on Mac).
