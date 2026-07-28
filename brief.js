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
const MODEL = "claude-haiku-4-5"; // cheap + great for summaries; "claude-opus-4-8" for max quality

// Two work bases, measured in different units and never mixed. Standards match
// the Associate Tracker in managers-console/lead-supervisor.html — keep them in sync.
//
// flagAbove is the "that can't be real" line for a single segment, and it is NOT
// a performance bar — it only exists to catch mistyped clock-in/out times. It sat
// at 400 cs/hr and fired on nearly every day once volume grew, so real 400-700
// cs/hr segments were being reported as errors. Raise it rather than let the flag
// get ignored; override with PICK_FLAG_ABOVE / LOAD_FLAG_ABOVE in .env.
const BASES = {
  pick: { label: "picking", qtyLabel: "cases", unit: "cs/hr", std: 187, flagAbove: +process.env.PICK_FLAG_ABOVE || 800 },
  load: { label: "loading", qtyLabel: "pallets", unit: "plt/hr", std: 26, flagAbove: +process.env.LOAD_FLAG_ABOVE || 110 },
};

// ---- small helpers ----
const arr = (x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : []);
const toMin = (t) => (/^\d{1,2}:\d{2}$/.test(t || "") ? (+t.split(":")[0]) * 60 + +t.split(":")[1] : null);
const round = (n) => Math.round(n * 10) / 10;
// Segments gained a `type` when loading was added; rows archived before that are
// all picking, so a missing type means 'pick'.
const basisOf = (g) => (g.type === "load" ? "load" : "pick");

// ---- 1) compute stats for one date ----
// One basis (picking or loading) rolled up into the numbers the brief talks about.
function summarize(bucket, key) {
  const b = BASES[key];
  const hrs = bucket.mins / 60;
  const rate = hrs > 0 ? bucket.qty / hrs : null;
  return {
    basis: b.label,
    [b.qtyLabel]: bucket.qty,
    hours: round(hrs),
    unit: b.unit,
    ratePerHr: rate == null ? null : round(rate),
    std: b.std,
    pctToStd: rate == null ? null : Math.round((rate / b.std) * 100),
    aboveStd: rate != null && rate >= b.std,
  };
}

function statsForDate(all, date) {
  const sessions = Object.values(all).filter((s) => s && s.date === date);
  const people = {}; // name -> { pick:{qty,mins}, load:{qty,mins} }
  const flags = [];

  for (const s of sessions) {
    for (const a of arr(s.associates).filter(Boolean)) {
      const name = (a.name || "").trim() || "(blank name)";
      const p = (people[name] = people[name] || { pick: { qty: 0, mins: 0 }, load: { qty: 0, mins: 0 } });
      arr(a.segments).filter(Boolean).forEach((g, i) => {
        const key = basisOf(g);
        const basis = BASES[key], bucket = p[key];
        // Quantity lives in `pallets` for loading and `cases` for picking. Never
        // read one as the other — that would silently corrupt the other basis.
        const c = Number(key === "load" ? g.pallets : g.cases);
        const st = toMin(g.start), en = toMin(g.end);
        if (!isNaN(c) && c > 0) bucket.qty += c;
        if (st != null && en != null && en > st) bucket.mins += en - st;
        if (st != null && en != null && en > st && c > 0) {
          const rate = c / ((en - st) / 60);
          if (rate > basis.flagAbove)
            flags.push(`${name}: ${basis.label} seg ${i + 1} shows ${Math.round(rate)} ${basis.unit} (likely a bad time entry)`);
        }
      });
    }
  }

  // Only report a basis someone actually worked, so a picking-only day stays a
  // picking-only brief instead of announcing zero pallets.
  const worked = (bucket) => bucket.mins > 0 || bucket.qty > 0;
  const bestPct = (o) => Math.max(...Object.keys(BASES).map((k) => o[BASES[k].label]?.pctToStd ?? -1));

  const associates = Object.entries(people).map(([name, p]) => {
    const out = { name };
    for (const k of Object.keys(BASES)) if (worked(p[k])) out[BASES[k].label] = summarize(p[k], k);
    return out;
  }).sort((a, b) => bestPct(b) - bestPct(a));

  const team = {};
  for (const k of Object.keys(BASES)) {
    const tot = Object.values(people).reduce(
      (s, p) => ({ qty: s.qty + p[k].qty, mins: s.mins + p[k].mins }), { qty: 0, mins: 0 });
    if (worked(tot)) team[BASES[k].label] = summarize(tot, k);
  }

  const named = (k, above) => associates
    .filter((a) => a[BASES[k].label]?.ratePerHr != null && a[BASES[k].label].aboveStd === above)
    .map((a) => a.name);

  return {
    date,
    sessions: sessions.length,
    associateCount: associates.length,
    team,
    aboveStd: Object.fromEntries(Object.keys(BASES).filter((k) => team[BASES[k].label]).map((k) => [BASES[k].label, named(k, true)])),
    belowStd: Object.fromEntries(Object.keys(BASES).filter((k) => team[BASES[k].label]).map((k) => [BASES[k].label, named(k, false)])),
    associates,
    dataFlags: flags,
  };
}

// ---- main ----
// Retry the archive fetch — after the laptop wakes for the 6 AM run, Wi-Fi can
// take a bit to reconnect, so a not-ready network self-heals instead of failing.
async function fetchArchive(url, tries = 10, waitMs = 30000) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (e) {
      const reason = (e && e.cause && e.cause.code) || e.message;
      if (attempt === tries) throw e;
      console.error(`Fetch attempt ${attempt}/${tries} failed (${reason}); waiting ${waitMs / 1000}s for network...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

let all;
if (ARCHIVE_URL) {
  all = await fetchArchive(ARCHIVE_URL);
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
  previous: prev ? { date: prev.date, team: prev.team } : null,
};

const system =
  "You are an operations analyst writing a short daily Outbound productivity brief for a warehouse lead. " +
  "Two kinds of work are tracked on separate bases and must NEVER be combined or compared to each other: " +
  `PICKING, measured in cases/hour against a standard of ${BASES.pick.std} cs/hr, and ` +
  `LOADING, measured in pallets/hour against a standard of ${BASES.load.std} plt/hr. ` +
  "Write 5-8 sentences or tight bullets, plain English, no fluff. " +
  "Give each basis present in the data its own headline: total quantity, rate, and % of standard. " +
  "Name who was above and below standard within each basis — the same person can appear in both. " +
  "If a prior day is given, note the trend for each basis separately. " +
  "If there are data flags, mention them as things to double-check. Be encouraging but honest. " +
  "If a basis has no data for the day, omit it silently — do not report it as zero, missing, or a problem.";

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

console.log(`\n\u{1F4E6} Outbound Productivity Brief — ${date}\n`);
console.log(brief);
console.log(`\n(model: ${MODEL} · ${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens)`);

// ---- optional: DM the brief to yourself on Slack ----
// Set SLACK_BOT_TOKEN (xoxb-...) and SLACK_DM_TO (your Slack user ID) in .env.
// It DMs *you*, so you can copy it into whatever channel you want.
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_DM_TO) {
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
    },
    body: JSON.stringify({
      channel: process.env.SLACK_DM_TO,
      text: `*📦 Outbound Productivity Brief — ${date}*\n\n${brief}`,
    }),
  });
  const j = await r.json();
  console.log(j.ok ? "\n✅ Sent to your Slack DM." : `\n⚠️ Slack error: ${j.error}`);
}
