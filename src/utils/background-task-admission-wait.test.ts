/// <reference types="bun-types" />

import { expect, spyOn, test } from 'bun:test';
import { waitForAdmission } from './background-task-admission-wait';
import { createBackgroundTaskAdmissionDeferred } from './background-task-concurrency';

test('cleans the abort listener once when readiness wins', async () => {
  // Given
  const ready = createBackgroundTaskAdmissionDeferred();
  const controller = new AbortController();
  const remove = spyOn(controller.signal, 'removeEventListener');
  const waiting = waitForAdmission(ready.promise, controller.signal);
  // When
  ready.resolve();
  await waiting;
  controller.abort();
  // Then
  expect(remove).toHaveBeenCalledTimes(1);
  remove.mockRestore();
});

test('isolates simultaneous waiters when cancellation wins', async () => {
  // Given
  const ready = createBackgroundTaskAdmissionDeferred();
  const controller = new AbortController();
  const remove = spyOn(controller.signal, 'removeEventListener');
  const cancelled = waitForAdmission(ready.promise, controller.signal);
  const survivor = waitForAdmission(ready.promise);
  // When
  controller.abort();
  // Then
  await expect(cancelled).rejects.toThrow(/aborted/);
  ready.resolve();
  await survivor;
  expect(remove).toHaveBeenCalledTimes(1);
  remove.mockRestore();
});
