/// <reference types="bun-types" />

import { expect, spyOn, test } from 'bun:test';
import { BackgroundTaskWaiters } from './background-task-wait';

test('removes subscriptions when a dependency read throws', async () => {
  // Given
  const waiters = new BackgroundTaskWaiters();
  const controller = new AbortController();
  const remove = spyOn(controller.signal, 'removeEventListener');
  let reads = 0;
  // When
  const waiting = waiters.wait(() => {
    reads++;
    throw new Error('record removed');
  }, controller.signal);
  // Then
  await expect(waiting).rejects.toThrow('record removed');
  expect(remove).toHaveBeenCalledTimes(1);
  waiters.notify();
  controller.abort();
  expect(reads).toBe(1);
  expect(remove).toHaveBeenCalledTimes(1);
  remove.mockRestore();
});
