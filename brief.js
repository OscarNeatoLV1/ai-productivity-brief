// Daily Productivity Brief — Oscar's first AI-powered app.
//
// Flow:  1) pull the day's sessions from Firebase  ->  2) compute the numbers
//        ->  3) hand the numbers to Claude, which writes a plain-English brief.
//
// Run it:   npm run brief              (latest day in the archive)
//           npm run brief 2026-07-14   (a specific date)
//
// No API key yet? It still runs — it prints the computed stats + the exact
// prompt it *would* send to Claude, so you can see it working today.

import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";

// Set ARCHIVE_URL in .env to your own data source (a JSON endpoint of saved
// sessions). If it's unset, the app runs in demo mode against sample-archive.json
// so anyone can try it without a live backend.
const ARCHIVE_URL = process.env.ARCHIVE_URL;
const STD = 187; // cases/hour standard
const MODEL = "claude-haiku-4-5"; // cheap + great for summaries; "claude-opus-4-8" for max quality

// ---- small helpers ----
const arr = (x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : []);
const toMin = (t) => (/^\d{1,2}:\d{2}$/.test(t || "") ? (+t.split(":")[0]) * 60 + +t.split(":")[1] : null);
const round = (n) => Math.round(n * 10) / 10;

// ---- 1) compute stats for one date ----
function statsForDate(all, date) {
  const sessions = Object.values(all).filter((s) => s && s.date === date);
  const people = {}; // name -> { cases, mins, flags:Set }
  const flags = [];

  for (const s of sessions) {
    for (const a of arr(s.associates).filter(Boolean)) {
      const name = (a.name || "").trim() || "(blank name)";
      const p = (people[name] = people[name] || { cases: 0, mins: 0 });
      arr(a.segments).filter(Boolean).forEach((g, i) => {
        const c = Number(g.cases);
        const st = toMin(g.start), en = toMin(g.end);
        if (!isNaN(c) && c > 0) p.cases += c;
        if (st != null && en != null && en > st) p.mins += en - st;
        if (st != null && en != null && en > st && c > 0) {
          const rate = c / ((en - st) / 60);
          if (rate > 400) flags.push(`${name}: seg ${i + 1} shows ${Math.round(rate)} cs/hr (likely a bad time entry)`);
        }
      });
    }
  }

  const associates = Object.entries(people).map(([name, p]) => {
    const hrs = p.mins / 60;
    const cph = hrs > 0 ? p.cases / hrs : null;
    return {
      name,
      cases: p.cases,
      hours: round(hrs),
      csPerHr: cph == null ? null : round(cph),
      pctToStd: cph == null ? null : Math.round((cph / STD) * 100),
      aboveStd: cph != null && cph >= STD,
    };
  }).sort((a, b) => (b.csPerHr || 0) - (a.csPerHr || 0));

  const totalCases = associates.reduce((s, a) => s + a.cases, 0);
  const totalHrs = associates.reduce((s, a) => s + a.hours, 0);
  const teamCph = totalHrs > 0 ? totalCases / totalHrs : 0;

  return {
    date,
    std: STD,
    sessions: sessions.length,
    associateCount: associates.length,
    totalCases,
    teamCsPerHr: round(teamCph),
    teamPctToStd: Math.round((teamCph / STD) * 100),
    aboveStd: associates.filter((a) => a.aboveStd).map((a) => a.name),
    belowStd: associates.filter((a) => a.csPerHr != null && !a.aboveStd).map((a) => a.name),
    associates,
    dataFlags: flags,
  };
}

// ---- main ----
let all;
if (ARCHIVE_URL) {
  all = await (await fetch(ARCHIVE_URL)).json();
} else {
  all = JSON.parse(await readFile(new URL("./sample-archive.json", import.meta.url), "utf8"));
  console.log("(demo mode: sample-archive.json — set ARCHIVE_URL in .env for live data)\n");
}
const dates = [...new Set(Object.values(all).map((s) => s?.date).filter(Boolean))].sort();
const date = process.argv[2] || dates[dates.length - 1];
if (!dates.includes(date)) {
  console.error(`No sessions for ${date}. Available: ${dates.slice(-8).join(", ")}`);
  process.exit(1);
}

const today = statsForDate(all, date);
// week-over-week-ish: compare to the previous date that has data
const prevDate = dates[dates.indexOf(date) - 1];
const prev = prevDate ? statsForDate(all, prevDate) : null;

const payload = {
  today,
  previous: prev ? { date: prev.date, teamCsPerHr: prev.teamCsPerHr, teamPctToStd: prev.teamPctToStd } : null,
};

const system =
  "You are an operations analyst writing a short daily Picker Productivity brief for a warehouse Outbound lead. " +
  `The standard (STD) is ${STD} cases/hour. Write 4-6 sentences or tight bullets, plain English, no fluff. ` +
  "Lead with the headline: team cases and cases/hour vs standard. Name who was above and below standard. " +
  "If there was a prior day, note the trend. If there are data flags, mention them as things to double-check. " +
  "Be encouraging but honest.";

// ---- 3) generate the brief (or dry-run if no key) ----
if (!process.env.ANTHROPIC_API_KEY) {
  console.log("=== COMPUTED STATS (no API key set — dry run) ===\n");
  console.log(JSON.stringify(payload, null, 2));
  console.log("\n=== This is exactly what would be sent to Claude ===");
  console.log("\nSYSTEM:\n" + system);
  console.log("\nAdd your key (see README) then run again to get the written brief. \u{1F4A1}");
  process.exit(0);
}

const client = new Anthropic(); // reads ANTHROPIC_API_KEY
const res = await client.messages.create({
  model: MODEL,
  max_tokens: 1024,
  system,
  messages: [{ role: "user", content: "Write today's brief from this data:\n\n" + JSON.stringify(payload, null, 2) }],
});
const brief = res.content.find((b) => b.type === "text")?.text ?? "";

console.log(`\n\u{1F4E6} Picker Productivity Brief — ${date}\n`);
console.log(brief);
console.log(`\n(model: ${MODEL} · ${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens)`);

// ---- optional: post to Slack if a webhook is configured ----
if (process.env.SLACK_WEBHOOK_URL) {
  await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `*📦 Picker Productivity Brief — ${date}*\n\n${brief}` }),
  });
  console.log("\n✅ Posted to Slack.");
}
