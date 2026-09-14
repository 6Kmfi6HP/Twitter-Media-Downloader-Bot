import { describe, it, expect } from 'vitest';
import { normalizeTweetKey } from '../utils';

describe('normalizeTweetKey', () => {
  const sameIdForms = [
    'https://x.com/user/status/123',
    'https://twitter.com/user/status/123',
    'https://mobile.twitter.com/user/status/123',
    'https://www.twitter.com/user/status/123',
    'https://www.x.com/user/status/123',
    'https://x.com/user/status/123?s=20&t=abcdefg',
    'https://twitter.com/user/status/123?s=20&t=abcdefg',
    'https://x.com/user/status/123/photo/1',
    'http://x.com/user/status/123',
    'https://X.COM/user/status/123',
    'https://x.com/i/web/status/123',
    'https://x.com/i/status/123',
    'https://twitter.com/i/web/status/123',
  ];

  it('同一 tweetId 的所有形态 → 同一 key', () => {
    const keys = sameIdForms.map(normalizeTweetKey);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('tweet:123');
  });

  it('不同 tweetId → 不同 key', () => {
    const a = normalizeTweetKey('https://x.com/user/status/123');
    const b = normalizeTweetKey('https://x.com/user/status/124');
    expect(a).toBe('tweet:123');
    expect(b).toBe('tweet:124');
    expect(a).not.toBe(b);
  });

  it('非 status URL → tweet:url: 前缀且不同 URL 不同 key', () => {
    const a = normalizeTweetKey('https://example.com/foo/bar?x=1#frag');
    const b = normalizeTweetKey('https://example.com/baz');
    expect(a).toBe('tweet:url:https://example.com/foo/bar');
    expect(b).toBe('tweet:url:https://example.com/baz');
    expect(a).not.toBe(b);
  });

  it('非 status URL：去尾斜杠、host 小写、去 query/hash', () => {
    expect(normalizeTweetKey('https://EXAMPLE.com/foo/')).toBe('tweet:url:https://example.com/foo');
    expect(normalizeTweetKey('https://example.com/foo?a=1&b=2')).toBe('tweet:url:https://example.com/foo');
    expect(normalizeTweetKey('https://example.com/foo#section')).toBe('tweet:url:https://example.com/foo');
  });

  it('无 status id 的 twitter URL 走 fallback 归一化', () => {
    expect(normalizeTweetKey('https://x.com/user')).toBe('tweet:url:https://x.com/user');
    expect(normalizeTweetKey('https://x.com/user/status')).toBe('tweet:url:https://x.com/user/status');
  });
});
