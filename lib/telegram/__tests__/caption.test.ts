import { describe, it, expect } from 'vitest';
import { escapeHtml, truncateForCaption } from '../caption';

describe('escapeHtml', () => {
  it('escapes a string with HTML tags', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;'
    );
  });

  it('escapes ampersand, double quotes, and single quotes', () => {
    // ampersand must be escaped FIRST so we do not double-escape
    expect(escapeHtml('Tom & "Jerry" \'s\'')).toBe(
      'Tom &amp; &quot;Jerry&quot; &#39;s&#39;'
    );
  });

  it('leaves a string with no special characters unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });

  it('escapes all five entities individually', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('handles an empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('truncateForCaption', () => {
  it('returns the original string when it is within the limit', () => {
    expect(truncateForCaption('short text', 1024)).toBe('short text');
  });

  it('truncates to limit-3 chars + "..." when over the limit', () => {
    const text = 'a'.repeat(2000);
    const result = truncateForCaption(text, 1024);
    expect(result.length).toBe(1024);
    expect(result.endsWith('...')).toBe(true);
    expect(result.startsWith('a'.repeat(100))).toBe(true);
  });

  it('returns the original string when length equals the limit exactly', () => {
    const text = 'a'.repeat(1024);
    expect(truncateForCaption(text, 1024)).toBe(text);
  });

  it('returns the original string when length is below the limit', () => {
    const text = 'a'.repeat(1023);
    expect(truncateForCaption(text, 1024)).toBe(text);
  });

  it('handles an empty string', () => {
    expect(truncateForCaption('', 1024)).toBe('');
  });

  it('works with a custom limit', () => {
    const text = 'a'.repeat(20);
    expect(truncateForCaption(text, 10)).toBe('aaaaaaa...');
  });
});

describe('escapeHtml + truncateForCaption ordering', () => {
  it('preserves HTML entities when escape runs before truncation', () => {
    const raw = '<'.repeat(1100);
    const escaped = escapeHtml(raw);
    const truncated = truncateForCaption(escaped, 1024);
    // Truncated string ends with ellipsis and contains no half-escaped entity
    expect(truncated.endsWith('...')).toBe(true);
    expect(truncated.includes('&lt;')).toBe(true);
    // No bare `<` left in the truncated output
    expect(truncated.slice(0, -3).includes('<')).toBe(false);
  });
});
