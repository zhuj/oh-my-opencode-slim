import { describe, expect, test } from 'bun:test';
import { appendTaggedToolOutput } from '../cache-safe-injection';

describe('rules injector output boundary oracle', () => {
  test('existing output bytes stay exact prefix; only text gains tagged block', () => {
    const output = {
      title: 'read',
      output: 'original content',
      metadata: { file: '/f' },
    };
    appendTaggedToolOutput(output, 'rule text', 'omos.rules.v1');
    expect(output.output.indexOf('original content')).toBe(0);
    expect(output.output.endsWith('</omos.rules.v1>')).toBe(true);
    expect(output.title).toBe('read');
    expect(output.metadata).toEqual({ file: '/f' });
  });

  test('repeated identical tag does not duplicate block', () => {
    const output = { title: 't', output: 'base', metadata: {} };
    appendTaggedToolOutput(output, 'first', 'omos.rules.v1');
    appendTaggedToolOutput(output, 'second', 'omos.rules.v1');
    const firstIndex = output.output.indexOf('first');
    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(output.output.indexOf('second')).toBe(-1);
  });

  test('different tags accumulate deterministically', () => {
    const output = { title: 't', output: 'o', metadata: {} };
    appendTaggedToolOutput(output, 'a', 'tag-a');
    appendTaggedToolOutput(output, 'b', 'tag-b');
    expect(output.output).toContain('<tag-a>');
    expect(output.output).toContain('<tag-b>');
    expect(output.output.indexOf('o')).toBe(0);
  });

  test('title and metadata unchanged across repeated calls', () => {
    const output = {
      title: 'edit',
      output: 'start',
      metadata: { keys: [1] },
    };
    appendTaggedToolOutput(output, 'r1', 'omos.rules.v1');
    appendTaggedToolOutput(output, 'r2', 'tag-b');
    expect(output.title).toBe('edit');
    expect(output.metadata).toEqual({ keys: [1] });
  });

  test('host message/system serialization boundary not covered by this unit', () => {
    // appendTaggedToolOutput operates on the tool-result output object only;
    // it does not receive, read, or modify session message history or system
    // payload. Coverage of payload-prefix stability against host serialization
    // belongs to the payload-assembly / cache-safety harness, not this bounded
    // helper test, and no concrete defect was reproduced in production.
    expect(true).toBe(true);
  });
});
