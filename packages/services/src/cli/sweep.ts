import { connect, ownerUrl } from "@taxops/db";
import { sweepDeadlines } from "../notifications";

// Run on a schedule (e.g. hourly/daily cron): `pnpm notify:sweep`. Idempotent; safe to run as often as you like.
const owner = connect(ownerUrl(), { max: 2 });
try {
  const { sent } = await sweepDeadlines(owner.db, { windowDays: Number(process.env.NOTIFY_WINDOW_DAYS ?? 3) });
  console.log(`Deadline sweep complete: ${sent} notification(s) created.`);
} finally {
  await owner.close();
}
