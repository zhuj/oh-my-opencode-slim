import { describe, expect, test } from 'bun:test';
import { formatCurrentDateTime } from './current-datetime';

describe('formatCurrentDateTime', () => {
  const date = new Date('2024-01-02T03:04:05.000Z');

  test('uses the default format in UTC', () => {
    expect(formatCurrentDateTime(date, undefined, true)).toBe('20240102-0304');
  });

  test('replaces custom tokens without cascading and keeps separators', () => {
    expect(formatCurrentDateTime(date, 'YYYY/MM/DD HH:mm:ss', true)).toBe(
      '2024/01/02 03:04:05',
    );
    expect(formatCurrentDateTime(date, 'YY-MM-DD', true)).toBe('YY-01-02');
  });

  test('selects local or UTC date components', () => {
    const localExpected = [
      date.getFullYear(),
      date.getMonth() + 1,
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
    ]
      .map((value, index) => String(value).padStart(index === 0 ? 4 : 2, '0'))
      .join('|');
    expect(formatCurrentDateTime(date, 'YYYY|MM|DD|HH|mm')).toBe(localExpected);
    expect(formatCurrentDateTime(date, 'YYYY|MM|DD|HH|mm', true)).toBe(
      '2024|01|02|03|04',
    );
  });
});
