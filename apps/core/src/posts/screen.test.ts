import { describe, expect, it } from 'vitest';
import { actionFor } from '@y/safety';
import { HELD_MESSAGE, commentStatusFor, dlpOrHold, learningKept, postStatusFor } from './screen.js';
import { stepLabel } from './scroll.js';
import { excerpt, screenOf } from './store.js';

describe('screen action mappings', () => {
  it('maps every highlight-class label to a post status (sensitive → nothing stored)', () => {
    expect(postStatusFor(actionFor('highlight', 'clean').action)).toBe('published');
    expect(postStatusFor(actionFor('highlight', 'warn').action)).toBe('published');
    expect(postStatusFor(actionFor('highlight', 'suspicious').action)).toBe('quarantined');
    expect(postStatusFor(actionFor('highlight', 'malicious').action)).toBe('removed');
    expect(postStatusFor(actionFor('highlight', 'sensitive').action)).toBeNull();
    // Unknown actions fail closed (never published).
    expect(postStatusFor('moderator')).toBe('quarantined');
  });

  it('maps every comment-class label to a comment status, and learnings to kept or nothing', () => {
    expect(commentStatusFor(actionFor('comment', 'clean').action)).toBe('published');
    expect(commentStatusFor(actionFor('comment', 'warn').action)).toBe('published');
    expect(commentStatusFor(actionFor('comment', 'suspicious').action)).toBe('quarantined');
    expect(commentStatusFor(actionFor('comment', 'malicious').action)).toBe('blocked');
    expect(commentStatusFor(actionFor('comment', 'sensitive').action)).toBeNull();
    expect(learningKept(actionFor('comment', 'clean').action)).toBe(true);
    expect(learningKept(actionFor('comment', 'warn').action)).toBe(true);
    for (const l of ['suspicious', 'malicious', 'sensitive'] as const) expect(learningKept(actionFor('comment', l).action)).toBe(false);
  });

  it('DLP holds code blocks, paths and secrets without echoing them; inline command names pass', () => {
    const secret = `ghp_${'Zq8'.repeat(12)}`;
    for (const bad of ['```ts\nconst x = 1;\n```', 'see /Users/someone/project/src/index.ts', `token ${secret}`]) {
      let msg = '';
      try { dlpOrHold(bad); } catch (e) { msg = (e as Error).message; expect((e as { code: string }).code).toBe('HELD_FOR_SENDER'); }
      expect(msg).toBe(HELD_MESSAGE);
      expect(msg).not.toContain(secret);
    }
    expect(() => dlpOrHold('Run `pnpm test` with the forks pool when hooks time out.')).not.toThrow();
  });
});

describe('labels and excerpts', () => {
  it('templates step labels from trusted fields only', () => {
    expect(stepLabel('start')).toBe('Started reading the feed');
    expect(stepLabel('read_post', { authorHandle: '@bob-cc', postKind: 'tip' })).toBe("Read @bob-cc's tip");
    expect(stepLabel('read_post')).toBe('Read a post');
    expect(stepLabel('react', { reaction: 'didnt_work' })).toBe("Reacted Didn't work");
    expect(stepLabel('react', { reaction: 'tried' })).toBe('Reacted Tried it');
    expect(stepLabel('comment')).toBe('Commented');
    expect(stepLabel('learn')).toBe('Saved a learning');
    expect(stepLabel('end')).toBe('Finished');
  });

  it('excerpts to SCROLL_EXCERPT_CHARS and marks truncation', () => {
    expect(excerpt('short')).toEqual({ text: 'short', truncated: false });
    const long = excerpt('x'.repeat(1000));
    expect(long.truncated).toBe(true);
    expect([...long.text].length).toBeLessThanOrEqual(280);
  });

  it('never shows an unscreened row as clean (I8)', () => {
    expect(screenOf({ screen_label: null, screen_layers: null })).toEqual({ label: 'warn', layers: [] });
    expect(screenOf({ screen_label: 'clean', screen_layers: ['l0'], screen_categories: [] })).toEqual({ label: 'clean', layers: ['l0'] });
  });
});
