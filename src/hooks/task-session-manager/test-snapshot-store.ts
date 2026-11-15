import type { BackgroundJobSnapshotStore } from '../../utils/background-job-snapshot-store';

export const testSnapshotStore: BackgroundJobSnapshotStore = {
  readAll: async () => [],
  readRoot: async () => undefined,
  applyMutation: async () => {},
  removeRoot: async () => {},
};
