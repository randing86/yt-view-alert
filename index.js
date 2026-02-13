import fs from "fs";
import nodemailer from "nodemailer";
import "dotenv/config";

const {
  YOUTUBE_API_KEY,
  VIDEO_ID,
  EMAIL_FROM,
  EMAIL_TO,
  EMAIL_APP_PASSWORD,
  TIMEZONE, // optional, e.g. "America/Los_Angeles"
} = process.env;

if (!YOUTUBE_API_KEY || !VIDEO_ID || !EMAIL_FROM || !EMAIL_TO || !EMAIL_APP_PASSWORD) {
  console.error("Missing required env vars. Check your .env file.");
  process.exit(1);
}

const STATE_PATH = "./state.json";

function getTodayDateString() {
  // Produces YYYY-MM-DD in a chosen timezone (defaults to local machine TZ if TIMEZONE not set)
  const now = new Date();
  if (TIMEZONE) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    return `${y}-${m}-${d}`;
  }
  // local timezone fallback
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      lastDate: typeof parsed.lastDate === "string" ? parsed.lastDate : null,
      lastViews: Number.isFinite(parsed.lastViews) ? parsed.lastViews : null,
    };
  } catch {
    return { lastDate: null, lastViews: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

async function getViewCount() {
  const url =
    `https://www.googleapis.com/youtube/v3/videos` +
    `?part=statistics&id=${encodeURIComponent(VIDEO_ID)}` +
    `&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`YouTube API error ${res.status}: ${text}`);
  }

  const data = await res.json();
  const item = data.items?.[0];
  const viewCountStr = item?.statistics?.viewCount;

  if (!viewCountStr) {
    throw new Error("Could not read statistics.viewCount from API response.");
  }

  return Number(viewCountStr);
}

function makeTransporter() {
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: EMAIL_FROM,
      pass: EMAIL_APP_PASSWORD,
    },
  });
}

async function sendEmail({ subject, text }) {
  const transporter = makeTransporter();
  await transporter.sendMail({
    from: EMAIL_FROM,
    to: EMAIL_TO,
    subject,
    text,
  });
}

function formatDelta(delta) {
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toLocaleString()}`;
}

async function main() {
  const today = getTodayDateString();
  const state = loadState();

  // Prevent duplicates if Task Scheduler accidentally runs twice in one day
  if (state.lastDate === today) {
    console.log(`[SKIP] Already sent for ${today}. lastViews=${state.lastViews}`);
    return;
  }

  const viewsToday = await getViewCount();

  // Compute delta vs yesterday (or last run)
  let delta = null;
  let pct = null;

  if (Number.isFinite(state.lastViews) && state.lastViews !== null) {
    delta = viewsToday - state.lastViews;
    if (state.lastViews > 0) {
      pct = (delta / state.lastViews) * 100;
    }
  }

  const subject = `Daily YouTube Views (${today})`;

  const lines = [];
  lines.push(`Video: https://www.youtube.com/watch?v=${VIDEO_ID}`);
  lines.push(`Date: ${today}`);
  lines.push(``);
  lines.push(`Total views: ${viewsToday.toLocaleString()}`);

  if (delta === null) {
    lines.push(`Change vs prior day: (first run — baseline created)`);
  } else {
    lines.push(`Change vs prior day: ${formatDelta(delta)} views` + (pct === null ? "" : ` (${pct.toFixed(2)}%)`));
  }

  // Optional: include what we used as "yesterday"
  if (state.lastDate && Number.isFinite(state.lastViews)) {
    lines.push(``);
    lines.push(`Prior baseline (${state.lastDate}): ${state.lastViews.toLocaleString()} views`);
  }

  await sendEmail({ subject, text: lines.join("\n") });

  // Save for tomorrow’s comparison
  saveState({ lastDate: today, lastViews: viewsToday });

  console.log(`[SENT] ${today} views=${viewsToday} delta=${delta ?? "n/a"}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

console.log({
  YOUTUBE_API_KEY: !!process.env.YOUTUBE_API_KEY,
  VIDEO_ID: process.env.VIDEO_ID,
  EMAIL_FROM: process.env.EMAIL_FROM,
  EMAIL_TO: process.env.EMAIL_TO,
  EMAIL_APP_PASSWORD: !!process.env.EMAIL_APP_PASSWORD,
});

