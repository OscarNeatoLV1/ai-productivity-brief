// Daily Productivity Brief — Oscar's first AI-powered app.
//
// Flow:  1) pull the day's sealed shift from Firebase  ->  2) compute the numbers
//        ->  3) hand the numbers to Claude, which writes a plain-English brief.
//
// Run it:   npm run brief              (latest sealed day)
//           npm run brief 2026-08-25   (a specific date)
//
// No API key yet? It still runs — it prints the computed stats + the exact
// prompt it *would* send to Claude, so you can see it working today.

import Anthropic from "@anthropic-ai/sdk";
import { readFile, writeFile } from "node:fs/promises";

// ---- WHERE THE NUMBERS COME FROM (changed 2026-08-26) ----
// This used to read /archives — the hand-typed Associate Tracker in the Managers
// Console. Associate Live replaced that tracker, so /archives stopped being written
// on 2026-08-19 and every brief after it re-reported the same stale Wednesday
// without ever looking wrong: "latest date in the archive" is still a real date.
//
// The live source is the Flow-fed board's own sealed archive, /flow-live/history,
// which carries what the old node never had — picks, units, and machine timestamps
// with breaks already excluded. If a brief ever goes stale again, check that
// yesterday actually got sealed (End shift, or the poller's midnight rollover).
const FLOW_HISTORY_URL =
  process.env.FLOW_HISTORY_URL || "https://neato-ops-default-rtdb.firebaseio.com/flow-live/history";
const MODEL = "claude-haiku-4-5"; // cheap + great for summaries; "claude-opus-4-8" for max quality

// Two work bases, measured in different units and never mixed.
//
// PICKING IS GRADED ON PICKS/HR (live 2026-08-25, approved by Alison), matching
// Associate Live and the TV dashboard. Standard 12.8 picks/hr = the median of 72
// person-days over 42 days. It earns the grade because a bulk pallet move is ONE
// pick, so it can't inflate the rate the way it inflates cases: spread across those
// person-days is 16% on picks/hr vs 67% on cases/hr vs 122% on units/hr.
//
// Cases and units are still reported in FULL — as totals, which is what the floor
// actually asks for — and their per-hour rates ride along as context. They are
// deliberately UNGRADED: colouring or scoring a cases figure by a picks percentage
// makes the number and its verdict disagree, which is the exact bug picks/hr fixed.
const BASES = {
  pick: { label: "picking", unit: "picks/hr", std: 12.8 },
  load: { label: "loading", qtyLabel: "pallets", unit: "plt/hr", std: 26 },
};

// Pick-size bands from the poller, in case-equivalents. NEVER report picks/hr
// without the size beside it: small-pick share correlates +0.62 with picks/hr, so
// the rate alone reads as effort when it is partly mix.
const BAND_LABELS = ["1 case or less", "2-6 cases", "7-48 cases", "49-95 cases", "96+ cases"];

// ---- small helpers ----
const arr = (x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : []);
const round = (n) => Math.round(n * 10) / 10;
const sum = (xs) => xs.reduce((s, x) => s + (x || 0), 0);
// Deliberately regex-free: the escaping round-trip through the shell ate the
// backslash in \S twice, leaving /S+/g — which quietly matched nothing and passed
// every name through unchanged. A split/join can't be mangled that way.
const titleCase = (n) => n.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w)).join(" ");

// ---- 1) compute stats for one sealed day ----
//
// Per-PERSON figures are quoted from the board's own published fields
// (picksPerHr, casesPerHr, medPickEq, load.palletsPerHr) rather than recomputed
// here. Two views of the same shift that disagree by a rounding step is how a lead
// stops trusting both, and the board is what people look at on the wall.
// Only the CREW roll-up is computed, because the board doesn't publish one.

function pickRow(p) {
  const hrs = p.activeHours || 0;
  return {
    casesPicked: p.cases || 0,
    unitsPicked: p.units || 0,
    picks: p.picks || 0,
    activeHours: round(hrs), // breaks already excluded upstream
    picksPerHr: p.picksPerHr ?? null,
    std: BASES.pick.std,
    pctToStd: p.picksPerHr == null ? null : Math.round((p.picksPerHr / BASES.pick.std) * 100),
    aboveStd: p.picksPerHr != null && p.picksPerHr >= BASES.pick.std,
    // Ships with every picks figure. See BAND_LABELS.
    medPickSize: p.medPickEq == null ? null : round(p.medPickEq),
    // Context only — never graded, never compared to the picks percentage.
    casesPerHr: p.casesPerHr ?? null,
    unitsPerHr: p.unitsPerHr ?? null,
  };
}

// LOADING HAS TWO CLOCKS AND THEY ARE NOT INTERCHANGEABLE. `activeMin` is the wider
// scan span; the RATE runs on `rateSec`, scan-to-scan with truck setup excluded,
// because that is the basis the 26 plt/hr standard was derived on. Deriving the rate
// from activeMin instead turned one loader's 77.3 plt/hr into 63.5 in the crew line
// — the brief disagreeing with the board about the same 18 pallets.
const loadHours = (runs) => sum(runs.map((r) =>
  r.rateSec != null ? r.rateSec : (r.activeSec || (new Date(r.end) - new Date(r.start)) / 1000))) / 3600;

function loadRow({ pallets, loads, spanMin, hrs, palletsPerHr, pct }) {
  const rate = palletsPerHr ?? (hrs > 0 ? round(pallets / hrs) : null);
  return {
    pallets: pallets || 0,
    loads: loads ?? null,
    // spanMinutes / ratedHours deliberately NOT published — see note above.
    // A rate off a short window is a burst, not a pace. The rate clock also drops
    // truck setup, so the fewer trucks it spans the more it reads like the loader
    // never stopped. 18 pallets over 14 rated minutes prints 297% of standard and
    // that is a property of the window, not a great day — say so rather than
    // letting a lead take it to a stand-up.
    shortWindow: hrs > 0 && hrs < 0.5,
    palletsPerHr: rate,
    std: BASES.load.std,
    pctToStd: pct ?? (rate == null ? null : Math.round((rate / BASES.load.std) * 100)),
    aboveStd: rate != null && rate >= BASES.load.std,
  };
}

function statsForDay(day) {
  const pickers = arr(day.pickers).filter(Boolean);
  const loadRuns = arr(day.loadRuns).filter(Boolean);
  const flags = [];

  // One grouping of load runs by person, used for every loading number below so
  // the per-person lines and the crew line can never be built on different clocks.
  // An open run is skipped: its pallets and its time are both still accumulating.
  const runsBy = new Map();
  for (const r of loadRuns) {
    if (!r.user || r.open) continue;
    if (!runsBy.has(r.user)) runsBy.set(r.user, []);
    runsBy.get(r.user).push(r);
  }

  const associates = pickers.map((p) => {
    const name = titleCase((p.fullName || p.username || "").replace(/_/g, " ").trim()) || "(unnamed)";
    const out = { name };
    // Only report a basis someone actually worked, so a picking-only day stays a
    // picking-only brief instead of announcing zero pallets.
    if ((p.picks || 0) > 0 || (p.cases || 0) > 0 || (p.units || 0) > 0) out.picking = pickRow(p);
    if (p.load && (p.load.pallets || 0) > 0) {
      out.loading = loadRow({
        pallets: p.load.pallets,
        loads: p.load.loads,
        spanMin: p.load.activeMin,
        hrs: loadHours(runsBy.get(p.username) || []),
        // Quoted from the board, so this line and the wall screen agree exactly.
        palletsPerHr: p.load.palletsPerHr,
        pct: p.load.pct == null ? null : Math.round(p.load.pct),
      });
      if (p.load.suspectRole)
        flags.push(`${name} is credited with the loading but mostly picked that day — check the loader is right`);
    }
    return out;
  });

  // A loader who never picked has no Flow picks, so the poller may not list them as a
  // picker at all. Falling back to the run list keeps their pallets on the board —
  // otherwise a pure loader's whole day reads as absence, which is the one thing
  // this brief must not do.
  const covered = new Set(pickers.map((p) => p.username));
  for (const [user, runs] of runsBy) {
    if (covered.has(user)) continue;
    const spanSec = sum(runs.map((r) => (new Date(r.end) - new Date(r.start)) / 1000));
    associates.push({
      name: titleCase((runs[0].loaderName || user).replace(/_/g, " ")),
      loading: loadRow({
        pallets: sum(runs.map((r) => r.pallets)),
        loads: runs.length,
        spanMin: Math.round(spanSec / 60),
        hrs: loadHours(runs),
      }),
    });
  }

  // Crew roll-ups. Picks/hr is total picks over total ACTIVE hours, not an average
  // of the per-person rates — a 20-minute picker would otherwise weigh the same as
  // a full shift. Pick-size bands are counts, so they add up honestly across people.
  const team = {};
  const pickHrs = sum(pickers.map((p) => p.activeHours));
  const picks = sum(pickers.map((p) => p.picks));
  const cases = sum(pickers.map((p) => p.cases));
  const units = sum(pickers.map((p) => p.units));
  if (picks > 0 || cases > 0 || units > 0) {
    const rate = pickHrs > 0 ? picks / pickHrs : null;
    const bands = pickers.reduce(
      (acc, p) => acc.map((n, i) => n + ((p.pickBands || [])[i] || 0)),
      [0, 0, 0, 0, 0]);
    team.picking = {
      // What Oscar asked to lead with: the day's output in whole cases and units.
      casesPicked: cases,
      unitsPicked: units,
      picks,
      activeHours: round(pickHrs),
      picksPerHr: rate == null ? null : round(rate),
      std: BASES.pick.std,
      pctToStd: rate == null ? null : Math.round((rate / BASES.pick.std) * 100),
      aboveStd: rate != null && rate >= BASES.pick.std,
      pickSizeMix: Object.fromEntries(BAND_LABELS.map((l, i) => [l, bands[i]])),
      // The one mix figure that is comparable day to day. Without it the model was
      // reading the raw band counts and guessing the DIRECTION wrong — it called a
      // day that skewed further toward small picks "a shift toward heavier picks".
      // Small picks are what lift picks/hr (r = +0.62), so this is the honest
      // companion to the rate, and it is a fact rather than an impression.
      smallPickShare: picks > 0 ? Math.round(((bands[0] + bands[1]) / picks) * 100) : null,
      casesPerHr: pickHrs > 0 ? Math.round(cases / pickHrs) : null,
      unitsPerHr: pickHrs > 0 ? Math.round(units / pickHrs) : null,
      pickerCount: pickers.filter((p) => (p.picks || 0) > 0).length,
    };
  }

  const loaders = associates.filter((a) => a.loading);
  if (loaders.length) {
    // Built from the runs, not by summing the per-person rows: the rate clock is
    // rateSec (see loadHours), and re-deriving it from the rounded row figures is
    // what made the crew line contradict the loader it was summarising.
    const allRuns = [...runsBy.values()].flat();
    const plt = sum(allRuns.map((r) => r.pallets));
    const hrs = loadHours(allRuns);
    const rate = hrs > 0 ? plt / hrs : null;
    team.loading = {
      pallets: plt,
      loads: allRuns.length,
      palletsPerHr: rate == null ? null : round(rate),
      std: BASES.load.std,
      pctToStd: rate == null ? null : Math.round((rate / BASES.load.std) * 100),
      aboveStd: rate != null && rate >= BASES.load.std,
      shortWindow: hrs > 0 && hrs < 0.5,
      loaderCount: loaders.length,
    };
  }

  // Data flags are about ATTRIBUTION now, not clock entry. Hand-typed start/end
  // times are gone — every timestamp comes from a handheld — so the old structural
  // checks (end before start, zero-minute segments, overlaps) have nothing left to
  // check. What can still be wrong is WHO a run belongs to.
  for (const r of loadRuns) {
    const at = `truck ${r.truck || "?"}`;
    if (r.unattributed) flags.push(`${at}: ${r.pallets || 0} pallets aren't attributed to anyone, so they're missing from every loader's rate`);
    else if (r.ambiguous) flags.push(`${at}: more than one person could be the loader — credited to ${r.loaderName || r.user}, worth a look`);
    else if (r.suspectRole) flags.push(`${at}: credited to ${r.loaderName || r.user}, who mostly picked that day — check the loader is right`);
    if (r.open) flags.push(`${at}: still shows as open, so its pallets and time are only partly counted`);
  }

  const named = (basis, above) => associates
    .filter((a) => a[basis]?.pctToStd != null && a[basis].aboveStd === above)
    .map((a) => a.name);

  return {
    date: day.date,
    sealedAt: day.archivedAt || null,
    associateCount: associates.length,
    team,
    aboveStd: Object.fromEntries(["picking", "loading"].filter((b) => team[b]).map((b) => [b, named(b, true)])),
    belowStd: Object.fromEntries(["picking", "loading"].filter((b) => team[b]).map((b) => [b, named(b, false)])),
    associates: associates.sort((a, b) => (b.picking?.pctToStd ?? b.loading?.pctToStd ?? -1) - (a.picking?.pctToStd ?? a.loading?.pctToStd ?? -1)),
    dataFlags: flags,
  };
}

// ---- main ----
// Retry the archive fetch — after the laptop wakes for the 6 AM run, Wi-Fi can
// take a bit to reconnect, so a not-ready network self-heals instead of failing.
//
// Each attempt MUST have its own deadline. fetch() has no default timeout, and a
// half-connected adapter right after wake doesn't refuse the connection, it just
// never answers — so without a signal the very first attempt hangs forever, the
// retries below never happen, and Task Scheduler kills the whole run at its time
// limit having logged nothing at all. That was the 2026-07-28 silent no-brief.
// Budget: TRIES x TIMEOUT + (TRIES-1) x WAIT must stay under the task's limit.
const TRIES = +process.env.FETCH_TRIES || 10;
const TIMEOUT_MS = +process.env.FETCH_TIMEOUT_MS || 15000;
const WAIT_MS = +process.env.FETCH_WAIT_MS || 30000;

async function fetchJson(url, what, tries = TRIES, waitMs = WAIT_MS) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    // Log BEFORE the call, not only on failure. Three silent no-briefs (07-28,
    // 08-12, 08-13) all left a log that could not distinguish "never reached the
    // fetch" from "wedged inside an attempt" — the only two states worth telling
    // apart. On 08-12 a single failure line was followed by 14 minutes of silence,
    // meaning attempt 2 hung and its own AbortSignal.timeout never fired; that
    // shouldn't be possible, so the next occurrence needs to show which attempt
    // owns the hang rather than leaving it to be inferred.
    console.error(`Fetching ${what}, attempt ${attempt}/${tries}...`);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (e) {
      // A timeout surfaces as a bare TimeoutError/AbortError, which reads as
      // nothing useful in the log — name it so the cause is obvious later.
      const reason = e?.name === "TimeoutError" || e?.name === "AbortError"
        ? `no response in ${TIMEOUT_MS / 1000}s`
        : (e?.cause?.code || e.message);
      if (attempt === tries) throw e;
      console.error(`${what} attempt ${attempt}/${tries} failed (${reason}); waiting ${waitMs / 1000}s for network...`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

// ---- deliver at most once per calendar day ----
// Four triggers now start this task (6 AM, logon, unlock, resume-from-sleep) so that a
// 6 AM run which lost the network is covered by the next time the laptop is opened.
// That is only safe if a repeat run is a cheap no-op, so this guard sits BEFORE the
// archive fetch and touches no network. Slack is otherwise the ONLY record that a brief
// went out, so this marker file is the idempotency key — don't delete it casually.
const SENT_MARKER = new URL("./.last-sent.json", import.meta.url);
// Local date, deliberately NOT toISOString(): the laptop runs Pacific, where a UTC date
// rolls over at 4/5 PM local, which would let a single calendar day deliver twice.
const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const FORCE = process.argv.includes("--force");

if (!FORCE) {
  try {
    const seen = JSON.parse(await readFile(SENT_MARKER, "utf8"));
    if (seen.sentOn === localDay()) {
      console.log(`Already delivered today (${seen.sentOn} — brief covered ${seen.briefedDate}). Pass --force to send anyway.`);
      process.exit(0);
    }
  } catch {
    // No marker yet, or it's unreadable/corrupt. Fall through and send: a missing
    // marker must never be the reason a brief is skipped.
  }
}

// Pull the day list shallow, then only the one or two days we actually need. The old
// code pulled every archived day in one request to find the latest date; this node
// carries full per-run detail, so that would grow without bound.
const DEMO = process.env.BRIEF_DEMO === "1";
const loadDay = async (d) => DEMO
  ? JSON.parse(await readFile(new URL("./sample-archive.json", import.meta.url), "utf8"))
  : fetchJson(`${FLOW_HISTORY_URL}/${d}.json`, `shift ${d}`);

let dates;
if (DEMO) {
  const s = JSON.parse(await readFile(new URL("./sample-archive.json", import.meta.url), "utf8"));
  dates = [s.date];
  console.log("(demo mode: sample-archive.json — unset BRIEF_DEMO for live data)\n");
} else {
  const keys = await fetchJson(`${FLOW_HISTORY_URL}.json?shallow=true`, "the day list");
  // Re-sealing a day leaves the old copy behind as `2026-08-24-superseded-<stamp>`.
  // Those are real keys and they sort AFTER the clean date, so an unfiltered
  // "latest key" would brief a superseded shift. Only bare YYYY-MM-DD counts.
  dates = Object.keys(keys || {}).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
}

const date = process.argv.slice(2).find((a) => !a.startsWith("--")) || dates[dates.length - 1];
if (!dates.includes(date)) {
  console.error(`No sealed shift for ${date}. Available: ${dates.slice(-8).join(", ")}`);
  process.exit(1);
}

const today = statsForDay(await loadDay(date));
// compare to the previous day that has data
const prevDate = dates[dates.indexOf(date) - 1];
const prev = prevDate && !DEMO ? statsForDay(await loadDay(prevDate)) : null;

// HOW THE LAST BREAKAGE HID: /archives quietly stopped being written on 2026-08-19
// and the brief kept reporting that Wednesday every morning for a week. Nothing looked
// wrong, because "the latest date in the archive" is always a real date with real
// numbers in it. The source is fixed, but the FAILURE MODE isn't source-specific — an
// unsealed shift produces exactly the same silence — so the brief now says its own age
// out loud. Monday covering Friday is 3 days, so only 4+ is worth flagging.
const daysOld = Math.round((new Date(localDay()) - new Date(today.date)) / 86400000);

const payload = {
  today,
  previous: prev ? { date: prev.date, team: prev.team } : null,
  briefRunOn: localDay(),
  daysOld,
  stale: daysOld >= 4,
};

const system =
  "You are an operations analyst writing a short daily Outbound productivity brief for a warehouse lead. " +
  "Two kinds of work are tracked on separate bases and must NEVER be combined or compared to each other: PICKING and LOADING. " +
  "PICKING: lead with the day's OUTPUT — total cases picked and total units picked, as whole numbers with thousands separators. " +
  "Cases and units are different things and are never added together or converted into one another. " +
  `Then give the picks-per-hour figures: the crew's picks/hr and its percentage of the ${BASES.pick.std} picks/hr standard, and each picker's percentage. ` +
  "Picks per hour is the ONLY graded picking measure — it went live 2026-08-25. " +
  "Give EVERY picker's percentage as an explicit number next to their name. Never write only 'above standard' for someone whose percentage you were given — the percentages are the point of this section. " +
  "Cases/hr and units/hr may be mentioned as context but are NEVER graded, NEVER given a percentage, and NEVER described as above or below standard. " +
  "Mention the pick-size context alongside a picks/hr figure, because the rate rises with smaller picks — never quote the rate on its own as if it were pure effort. " +
  "For pick-size use smallPickShare (the percentage of picks that were 6 cases-equivalent or smaller) and compare it to the prior day's smallPickShare. Do not describe the mix as heavier or lighter from the raw band counts. " +
  `LOADING: report total pallets and pallets/hour against a standard of ${BASES.load.std} plt/hr, with who was above and below. ` +
  "For loading, quote pallets and the rate only. Do NOT state the minutes or hours: the pallet count spans a wider window than the rate clock, so putting both in one sentence reads as a contradiction. " +
  "If loading 'shortWindow' is true, you MUST caveat the loading rate in the same breath as the percentage: it is measured scan-to-scan with truck setup excluded over a short window, so it reads high and is not a shift-long pace. Do not present it as a standout performance, and do not celebrate it. State the caveat WITHOUT quoting any duration — there are two loading clocks and naming either one beside the rate contradicts the other, which is why no duration is given to you. " +
  "Write 5-8 sentences or tight bullets, plain English, no fluff. " +
  "Name who was above and below standard within each basis — the same person can appear in both. " +
  "If a prior day is given, note the trend for each basis separately. " +
  "If there are data flags, mention them as things to double-check. Be encouraging but honest. " +
  "If a basis has no data for the day, omit it silently — do not report it as zero, missing, or a problem. " +
  "If 'stale' is true, OPEN with one short warning line: this is the most recent sealed shift, give its date and how many days old it is, and say the newer shifts may not have been ended. Then write the brief as normal. If 'stale' is false, do not mention the age at all. " +
  // Haiku filled a gap by inventing a reason: it called a slow picker's day "day one"
  // when nothing in the payload said anything about tenure. A brief that invents one
  // fact is a brief a lead has to fact-check, which is worse than no brief.
  "CRITICAL: state ONLY what is in the data. You do not know anyone's tenure, schedule, assignment, training, effort or attitude, and you must never guess at a CAUSE for a number. " +
  "If a rate moved and the data does not say why, say it moved and stop. Never invent a reason. " +
  "This includes crew size and pick mix: you may report those figures beside the rate, but do not claim one CAUSED the other. " +
  // Slack renders mrkdwn, not Markdown: '#' and '**' come through as literal characters.
  "FORMAT: this is delivered as a Slack message. Use Slack mrkdwn only — *single asterisks* for bold, '-' for bullets. " +
  "Do NOT use '#' headings, '**double asterisks', tables, or a title line (the sender adds one).";

// ---- 3) generate the brief (or dry-run if no key) ----
if (!process.env.ANTHROPIC_API_KEY) {
  console.log("=== COMPUTED STATS (no API key set — dry run) ===\n");
  console.log(JSON.stringify(payload, null, 2));
  console.log("\n=== This is exactly what would be sent to Claude ===");
  console.log("\nSYSTEM:\n" + system);
  console.log("\nAdd your key (see README) then run again to get the written brief. \u{1F4A1}");
  process.exit(0);
}

// Timeout and retries are set EXPLICITLY. The SDK defaults are timeout = 10 min and
// maxRetries = 2, and timeouts are themselves retried — so one hung call can burn ~30
// min of wall clock while Task Scheduler kills this run at 15. That is exactly how the
// 2026-08-12 brief died: the archive fetch retried correctly (hardened in July), then
// this call hung past the limit and logged nothing at all.
// 60s is generous for a ~250-output-token brief; worst case is now 3 x 60s.
const client = new Anthropic({ timeout: 60_000, maxRetries: 2 });

// Log before each network stage. Without this a hang leaves NO line in brief.log and
// there is no way to tell which of the three calls wedged.
console.log("Calling Claude...");
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
  console.log("Sending to Slack...");
  // Same failure mode as the archive fetch: a bare fetch() has NO default timeout, so a
  // half-connected adapter after wake-from-sleep never answers rather than refusing.
  // The brief has already printed above, so a Slack failure is logged and swallowed
  // instead of taking down a run whose real work is done.
  try {
    const r = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
    // ONLY a confirmed send marks the day done. If Slack failed, leave the marker
    // untouched so the next trigger retries rather than assuming delivery happened.
    if (j.ok) await writeFile(SENT_MARKER, JSON.stringify({ sentOn: localDay(), briefedDate: date }) + "\n");
  } catch (e) {
    console.log(`\n⚠️ Slack send failed (${e.name}): ${e.message}`);
  }
}
