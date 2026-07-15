# Daily Productivity Brief

An AI-generated daily warehouse-productivity summary. It pulls a day's picking
sessions from a JSON data source, computes the numbers (cases/hour vs a
standard, per-associate performance, data-quality flags), and asks **Claude** to
write a short plain-English brief a lead can read in 10 seconds.

> Ships with sample data — clone it and run `npm run brief` to see it work.
> Point `ARCHIVE_URL` at your own data source for live briefs.

## What it shows off (resume-wise)
- Calling the **Claude API** from a real app
- Turning raw operational data into a decision-ready summary
- Prompt design (a system prompt + structured data payload)

## Run it

```bash
npm install
npm run brief              # latest day in the archive
npm run brief 2026-07-14   # a specific date
```

**No API key yet?** It still runs — it prints the computed stats and the exact
prompt it would send to Claude (a "dry run"), so you can see it working today.

## Turn on the AI brief
1. Get an API key at https://console.anthropic.com (Settings → API Keys).
2. `copy .env.example .env` and paste your key into `ANTHROPIC_API_KEY`.
3. `npm run brief` — now it writes the brief.

## Options
- **Your own data:** set `ARCHIVE_URL` in `.env` to a JSON endpoint of saved sessions (e.g. a Firebase Realtime DB `.json` URL). Unset = demo mode with `sample-archive.json`.
- **Model:** `MODEL` in `brief.js` is `claude-haiku-4-5` (cheap, ~$0.001/brief). Use `claude-opus-4-8` for max quality.
- **Auto-post to Slack:** add a Slack Incoming Webhook URL to `SLACK_WEBHOOK_URL` in `.env`.
- **Run it every morning:** schedule `npm run brief` with Windows Task Scheduler.

## How it works (the 3 steps)
1. `statsForDate()` — computes team cs/hr, % to STD (187), per-associate numbers, and flags bad data.
2. Builds a `system` prompt (the analyst's instructions) + a `user` message (the JSON stats).
3. `client.messages.create()` — Claude returns the written brief.
