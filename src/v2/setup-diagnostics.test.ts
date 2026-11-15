import { describe, expect, test } from 'bun:test';
import {
  ALLOWED_COLLISION_CODES,
  BLOCKING_DIAGNOSTIC_CODES,
  type DiscoveryView,
  isDiscoveryAcceptable,
} from './project-skill-diagnostics';

function result(diagnostics: DiscoveryView['diagnostics']): DiscoveryView {
  return { diagnostics };
}

describe('isDiscoveryAcceptable production predicate', () => {
  test('accepts when complete and only allowed collisions present', () => {
    expect(
      isDiscoveryAcceptable({
        discovery: result([
          { code: 'duplicate-name', path: '/a', name: 'x' },
          { code: 'host-name-conflict', path: '/b', name: 'y' },
        ]),
        nativeScanComplete: true,
        editorInventoryComplete: true,
      }),
    ).toBe(true);
  });

  test('rejects when unreadable-root is present', () => {
    expect(
      isDiscoveryAcceptable({
        discovery: result([
          { code: 'duplicate-name', path: '/a', name: 'x' },
          { code: 'unreadable-root', path: '/root' },
        ]),
        nativeScanComplete: true,
        editorInventoryComplete: true,
      }),
    ).toBe(false);
  });

  test('rejects when native scan incomplete regardless of diagnostics', () => {
    expect(
      isDiscoveryAcceptable({
        discovery: result([]),
        nativeScanComplete: false,
        editorInventoryComplete: true,
      }),
    ).toBe(false);
  });

  test('rejects when editor inventory incomplete regardless of diagnostics', () => {
    expect(
      isDiscoveryAcceptable({
        discovery: result([{ code: 'duplicate-name', path: '/a', name: 'x' }]),
        nativeScanComplete: true,
        editorInventoryComplete: false,
      }),
    ).toBe(false);
  });

  test('rejects unknown diagnostic codes', () => {
    expect(
      isDiscoveryAcceptable({
        discovery: result([
          { code: 'duplicate-name', path: '/a', name: 'x' },
          { code: 'unexpected-code', path: '/z' },
        ]),
        nativeScanComplete: true,
        editorInventoryComplete: true,
      }),
    ).toBe(false);
  });

  test('allowed and blocking sets match expected codes', () => {
    expect(ALLOWED_COLLISION_CODES.has('duplicate-name')).toBe(true);
    expect(ALLOWED_COLLISION_CODES.has('host-name-conflict')).toBe(true);
    expect(BLOCKING_DIAGNOSTIC_CODES.has('unreadable-root')).toBe(true);
    expect(ALLOWED_COLLISION_CODES.has('unreadable-root')).toBe(false);
  });
});
