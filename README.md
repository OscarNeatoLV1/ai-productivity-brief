# Daily Productivity Brief

An AI-generated daily warehouse-productivity summary. It pulls a day's sealed
shift from a JSON data source, computes the numbers (cases and units picked,
picks/hour vs a standard, pallets/hour vs a standard, per-associate performance,
data-quality flags), and asks **Claude** to
write a short plain-English brief a lead can read in 10 seconds.

> Ships with sample data — clone it and run `npm run brief` to see it work.
> Point `FLOW_HISTORY_URL` at your own data source for live briefs.

## What it shows off (resume-wise)
- Calling the **Claude API** from a real app
- Turning raw operational data into a decision-ready summary
- Prompt design (a system prompt + structured data payload)

## Run it

```bash
npm install
npm run brief              # latest sealed day
npm run brief 2026-08-25   # a specific date
```

**No API key yet?** It still runs — it prints the computed stats and the exact
prompt it would send to Claude (a "dry run"), so you can see it working today.

## Turn on the AI brief
1. Get an API key at https://console.anthropic.com (Settings → API Keys).
2. `copy .env.example .env` and paste your key into `ANTHROPIC_API_KEY`.
3. `npm run brief` — now it writes the brief.

## Options
- **Your own data:** set `FLOW_HISTORY_URL` in `.env` to the base path of your sealed-shift archive (a Firebase Realtime DB node, no trailing `.json`), where each child is one day keyed `YYYY-MM-DD`. `BRIEF_DEMO=1` = offline demo with `sample-archive.json`.
- **Model:** `MODEL` in `brief.js` is `claude-haiku-4-5` (cheap, ~$0.001/brief). Use `claude-opus-4-8` for max quality.
- **Slack DM:** set `SLACK_BOT_TOKEN` (a Slack app bot token) and `SLACK_DM_TO` (your Slack user ID) in `.env` to have the brief DM'd to you.
- **Run it every morning:** schedule `npm run brief` with Windows Task Scheduler.

## How it works (the 3 steps)
1. `statsForDay()` — computes the day's total cases and units picked, team picks/hr vs the 12.8 standard, pallets/hr vs the 26 standard, per-associate numbers, and flags bad data.
   Picking is **graded on picks/hr only**; cases/hr and units/hr ride along as ungraded context, because a bulk pallet move is one pick but hundreds of cases.
2. Builds a `system` prompt (the analyst's instructions) + a `user` message (the JSON stats).
3. `client.messages.create()` — Claude returns the written brief.
