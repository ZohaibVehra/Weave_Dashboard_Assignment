import { update90DayJsonWithLatestDay } from "./gitHub.js";

async function main() {
  try {
    await update90DayJsonWithLatestDay();
    console.log("Daily PR JSON update complete");
    process.exit(0);
  } catch (err) {
    console.error("Daily update failed:", err);
    process.exit(1);
  }
}

main();