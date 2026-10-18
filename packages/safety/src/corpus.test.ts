import { LABEL_SEVERITY } from '@y/schema';
import { describe, expect, it, vi } from 'vitest';

// @y/redact may still be a stub: make scanSecrets throw so the local fallback is exercised.
vi.mock('@y/redact', () => ({
  scanSecrets: () => {
    throw new Error('not implemented: scanSecrets');
  },
}));

const { attacks, benign } = await import('./corpus.js');
const { screen } = await import('./index.js');

const atLeast = (label: keyof typeof LABEL_SEVERITY, min: keyof typeof LABEL_SEVERITY) => LABEL_SEVERITY[label] >= LABEL_SEVERITY[min];

describe('L0 corpus (no judge: L0-only mode)', () => {
  it('has ~40 attacks and ~40 benign samples with unique ids', () => {
    expect(attacks.length).toBeGreaterThanOrEqual(38);
    expect(benign.length).toBeGreaterThanOrEqual(38);
    const ids = [...attacks, ...benign].map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('catches every deterministic attack at its minimum label and flags no benign sample as malicious', async () => {
    const attackResults = await Promise.all(
      attacks.map(async (a) => ({ a, out: await screen({ contentClass: a.cls, contentId: 'm_01K8Z0T7Q3W4E5R6T7Y8V9A0P4', text: a.text }) })),
    );
    const benignResults = await Promise.all(
      benign.map(async (b) => ({ b, out: await screen({ contentClass: b.cls, contentId: 'm_01K8Z0T7Q3W4E5R6T7Y8V9A0P4', text: b.text }) })),
    );

    const caught = attackResults.filter(({ a, out }) => atLeast(out.verdict.label, a.min));
    const flagged = attackResults.filter(({ out }) => out.verdict.label !== 'clean');
    const det = attackResults.filter(({ a }) => a.deterministic);
    const detCaught = det.filter(({ a, out }) => atLeast(out.verdict.label, a.min));
    const maliciousBenign = benignResults.filter(({ out }) => out.verdict.label === 'malicious');
    const fpSuspicious = benignResults.filter(({ out }) => LABEL_SEVERITY[out.verdict.label] >= 2);
    const warnBenign = benignResults.filter(({ out }) => out.verdict.label === 'warn');
    const securityOverWarn = benignResults.filter(({ b, out }) => b.security && LABEL_SEVERITY[out.verdict.label] > LABEL_SEVERITY.warn);

    const pct = (n: number, d: number) => `${((100 * n) / Math.max(1, d)).toFixed(1)}%`;
    const report = [
      `L0 corpus report`,
      `  attacks: ${attacks.length}; caught at min label: ${caught.length} (${pct(caught.length, attacks.length)}); flagged (≠ clean): ${flagged.length} (${pct(flagged.length, attacks.length)})`,
      `  deterministic classes: ${detCaught.length}/${det.length} (${pct(detCaught.length, det.length)})`,
      `  benign: ${benign.length}; malicious: ${maliciousBenign.length}; suspicious/sensitive (FP): ${fpSuspicious.length} (${pct(fpSuspicious.length, benign.length)}); warn: ${warnBenign.length}`,
      `  security-themed benign above warn: ${securityOverWarn.length}`,
      ...attackResults.filter(({ a, out }) => !atLeast(out.verdict.label, a.min)).map(({ a, out }) => `  MISS ${a.id}: got ${out.verdict.label}, want ≥ ${a.min}`),
      ...fpSuspicious.map(({ b, out }) => `  FP ${b.id}: ${out.verdict.label} [${out.verdict.l0.findings.map((f) => f.rule).join(', ')}]`),
      ...warnBenign.map(({ b, out }) => `  warn ${b.id}${b.security ? ' (security)' : ''}: [${out.verdict.l0.findings.filter((f) => f.severity !== 'info').map((f) => f.rule).join(', ')}]`),
    ].join('\n');
    console.log(report);

    expect(detCaught.length, report).toBe(det.length);
    expect(maliciousBenign.map(({ b }) => b.id), report).toEqual([]);
    expect(securityOverWarn.map(({ b }) => b.id), report).toEqual([]);
    expect(fpSuspicious.length / benign.length, report).toBeLessThanOrEqual(0.05);
  });

  it('L0 runs well under 10 ms for 4,000 chars', async () => {
    const { l0Scan } = await import('./index.js');
    const text = benign.map((b) => b.text).join('\n').repeat(3).slice(0, 4000);
    l0Scan(text, 'highlight');
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) l0Scan(text, 'highlight');
    const per = (performance.now() - t0) / 20;
    console.log(`L0 latency: ${per.toFixed(2)} ms / 4,000 chars`);
    expect(per).toBeLessThan(10);
  });
});
