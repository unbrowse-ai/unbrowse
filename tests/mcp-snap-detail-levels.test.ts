import { describe, expect, it } from "bun:test";
import {
  applySnapDetailLevel,
  type SnapDetailLevel,
} from "../src/api/browse-snap-detail-levels";

// Three fixture snapshots that resemble the Kuri a11y tree shape
// (interactive lines emit "[eN] role <name>", plus landmark roles).
// Sizes chosen to validate cap behavior at minimal / summary / full.

const WIKIPEDIA_SNAPSHOT = [
  '[e0] WebArea Wikipedia, the free encyclopedia',
  '  [e1] banner',
  '    [e2] link "Main page"',
  '    [e3] link "Contents"',
  '    [e4] link "Current events"',
  '    [e5] link "Random article"',
  '    [e6] link "About Wikipedia"',
  '  [e7] navigation "Site"',
  '    [e8] link "Donate"',
  '    [e9] link "Create account"',
  '    [e10] link "Log in"',
  '  [e11] main',
  '    [e12] heading "Welcome to Wikipedia,"',
  '    [e13] paragraph "the free encyclopedia that anyone can edit."',
  ...Array.from({ length: 200 }, (_, i) => `    [e${14 + i}] link "Article ${i}"`),
  '  [e215] contentinfo',
  '    [e216] link "Privacy policy"',
  '    [e217] link "About Wikipedia"',
  '    [e218] link "Disclaimers"',
].join('\n');

const HN_SNAPSHOT = [
  '[e0] WebArea Hacker News',
  '  [e1] banner',
  '    [e2] link "Hacker News"',
  '    [e3] link "new"',
  '    [e4] link "past"',
  '    [e5] link "comments"',
  '    [e6] link "ask"',
  '    [e7] link "show"',
  '    [e8] link "jobs"',
  '    [e9] link "submit"',
  '  [e10] main',
  ...Array.from({ length: 90 }, (_, i) => `    [e${11 + i}] link "Story ${i}: about distributed systems"`),
].join('\n');

const ERROR_STATE_SNAPSHOT = [
  '[e0] WebArea',
  '  [e1] alert "Sorry, something went wrong"',
  '  [e2] paragraph "Please try again later"',
].join('\n');

const EMPTY_SNAPSHOT = '';

describe('applySnapDetailLevel: byte caps and shape', () => {
  const cases: Array<{ name: string; snapshot: string }> = [
    { name: 'wikipedia-ish', snapshot: WIKIPEDIA_SNAPSHOT },
    { name: 'hn-ish', snapshot: HN_SNAPSHOT },
    { name: 'error-state', snapshot: ERROR_STATE_SNAPSHOT },
  ];

  it('minimal stays under 1024 chars on all three fixtures', () => {
    for (const c of cases) {
      const out = applySnapDetailLevel(c.snapshot, 'minimal', {
        current_url: 'https://example.com/foo',
        page_title: 'Example Domain',
      });
      const wire = JSON.stringify(out);
      expect(wire.length).toBeLessThan(1024);
      expect(typeof out.interactive_count).toBe('number');
      expect(typeof out.landmark_count).toBe('number');
      // root_aria must be present when snapshot is non-empty
      expect(typeof out.root_aria).toBe('string');
    }
  });

  it('summary stays under 8192 chars on all three fixtures and includes landmarks', () => {
    for (const c of cases) {
      const out = applySnapDetailLevel(c.snapshot, 'summary', {
        current_url: 'https://example.com/foo',
        page_title: 'Example Domain',
      });
      const wire = JSON.stringify(out);
      expect(wire.length).toBeLessThan(8192);
      expect(Array.isArray(out.landmarks)).toBe(true);
    }
  });

  it('summary surfaces error_state when snapshot contains alert role', () => {
    const out = applySnapDetailLevel(ERROR_STATE_SNAPSHOT, 'summary', {
      current_url: 'https://example.com/err',
      page_title: 'Error',
    });
    expect(out.error_state).toBeTruthy();
  });

  it('full preserves the raw snapshot (no regression)', () => {
    const out = applySnapDetailLevel(WIKIPEDIA_SNAPSHOT, 'full', {
      current_url: 'https://example.com/foo',
      page_title: 'Wiki',
    });
    expect(out.snapshot).toBe(WIKIPEDIA_SNAPSHOT);
  });

  it('default level (no detail_level passed) is minimal', () => {
    const out = applySnapDetailLevel(WIKIPEDIA_SNAPSHOT, undefined, {
      current_url: 'https://example.com/foo',
      page_title: 'Wiki',
    });
    const wire = JSON.stringify(out);
    expect(wire.length).toBeLessThan(1024);
    // shape matches minimal: no `snapshot` field, no `landmarks` array
    expect((out as Record<string, unknown>).snapshot).toBeUndefined();
    expect((out as Record<string, unknown>).landmarks).toBeUndefined();
  });

  it('empty snapshot yields zero counts at minimal and summary', () => {
    for (const level of ['minimal', 'summary'] as SnapDetailLevel[]) {
      const out = applySnapDetailLevel(EMPTY_SNAPSHOT, level, {
        current_url: 'https://example.com/empty',
        page_title: '',
      });
      expect(out.interactive_count).toBe(0);
      expect(out.landmark_count).toBe(0);
    }
  });

  it('full passes empty snapshot through unchanged', () => {
    const out = applySnapDetailLevel(EMPTY_SNAPSHOT, 'full', {
      current_url: 'https://example.com/empty',
      page_title: '',
    });
    expect(out.snapshot).toBe('');
  });

  it('byte-cap measurement: report sizes for the three fixtures', () => {
    // This test prints sizes for the three detail levels across all
    // three fixture snapshots. It asserts the cap invariants and
    // also logs the actual sizes so the agent reading test output
    // can record them in the commit message.
    for (const c of cases) {
      const mini = JSON.stringify(applySnapDetailLevel(c.snapshot, 'minimal', {
        current_url: 'https://example.com/x',
        page_title: c.name,
      }));
      const summ = JSON.stringify(applySnapDetailLevel(c.snapshot, 'summary', {
        current_url: 'https://example.com/x',
        page_title: c.name,
      }));
      const full = JSON.stringify(applySnapDetailLevel(c.snapshot, 'full', {
        current_url: 'https://example.com/x',
        page_title: c.name,
      }));
      console.log(`[snap-detail-sizes] ${c.name} minimal=${mini.length} summary=${summ.length} full=${full.length}`);
      expect(mini.length).toBeLessThan(1024);
      expect(summ.length).toBeLessThan(8192);
    }
  });
});
