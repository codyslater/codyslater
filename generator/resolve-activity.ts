// CLI for the daily workflow: read a GraphQL contributionCalendar response from
// a file and print the two step outputs.
//
//   npx tsx generator/resolve-activity.ts calendar.json
//     seed=20261119
//     activity=1,0,2,2,1,2,2,2,1,2,1,2,4,2
//
// Exit 3 with a reason on stderr when the file is not a usable calendar or shows
// no active day: the workflow then keeps its older seed source and omits
// --activity, which the generator reads as a neutral week.
import fs from 'node:fs';
import { activityFromCalendar, daysFromGraphql } from './calendar.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: tsx generator/resolve-activity.ts <calendar.json>');
  process.exit(2);
}
try {
  const resolved = activityFromCalendar(daysFromGraphql(JSON.parse(fs.readFileSync(file, 'utf8'))));
  if (!resolved) throw new Error('calendar: no active day in the response');
  console.log(`seed=${resolved.seed}`);
  console.log(`activity=${resolved.levels.join(',')}`);
} catch (e) {
  console.error(`resolve-activity: ${(e as Error).message}`);
  process.exit(3);
}
