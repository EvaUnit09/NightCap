/**
 * Wall-clock redaction benches. Kept out of `npm test` so load on the
 * box cannot flake CI. Run with `npm run bench`.
 */
import { redact } from "../src/monitoring";
import { redactTextUncapped } from "../src/monitoring/redact";

function medianMs(fn: () => void, warm = 3, runs = 7): number {
  for (let i = 0; i < warm; i += 1) {
    fn();
  }
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

const hyphen4k = medianMs(() => {
  redact("a-".repeat(2048));
});
const apostrophe4k = medianMs(() => {
  redact("a'".repeat(2048));
});
const hyphen100k = medianMs(() => {
  redactTextUncapped("a-".repeat(50_000));
});
const denseAnd = medianMs(() => {
  redactTextUncapped("for me and Nia and ".repeat(300));
});
const denseTitle = medianMs(() => {
  redactTextUncapped("Mr. Nia ".repeat(300));
});

console.log(`4KB hyphen: ${hyphen4k.toFixed(2)}ms`);
console.log(`4KB apostrophe: ${apostrophe4k.toFixed(2)}ms`);
console.log(`100KB hyphen uncapped: ${hyphen100k.toFixed(2)}ms`);
console.log(`for-me-and dense: ${denseAnd.toFixed(2)}ms`);
console.log(`title-dense: ${denseTitle.toFixed(2)}ms`);
