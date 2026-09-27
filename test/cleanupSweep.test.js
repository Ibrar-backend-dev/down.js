const test = require('node:test');
const assert = require('node:assert/strict');

const { createCleanupSweeper } = require('../server/lib/cleanupSweep');

const MAX_AGE_MS = 45000;

function makeBucket(objects) {
  const store = new Map(objects.map((o) => [o.name, { ours: true, modifiedAt: new Date('2026-01-01T00:00:00Z'), ...o }]));
  const calls = { head: [], delete: [] };
  return {
    store,
    calls,
    listFiles: async () => [...store.values()].map(({ name, modifiedAt }) => ({ name, size: 1, createdAt: modifiedAt, modifiedAt })),
    isAutoCleanupObject: async (name) => {
      calls.head.push(name);
      return store.get(name).ours;
    },
    deleteFile: async (name) => {
      calls.delete.push(name);
      store.delete(name);
    }
  };
}

function makeSweeper(bucket, clock) {
  return createCleanupSweeper({
    maxAgeMs: MAX_AGE_MS,
    listFiles: bucket.listFiles,
    deleteFile: bucket.deleteFile,
    isAutoCleanupObject: bucket.isAutoCleanupObject,
    now: () => clock.time
  });
}

test('sweep keeps an object for maxAgeMs after first seeing it, then deletes it', async () => {
  const bucket = makeBucket([{ name: 'a.mp4' }]);
  const clock = { time: 0 };
  const { sweep } = makeSweeper(bucket, clock);

  assert.deepEqual(await sweep(), []);
  clock.time = MAX_AGE_MS - 1;
  assert.deepEqual(await sweep(), []);
  clock.time = MAX_AGE_MS;
  assert.deepEqual(await sweep(), ['a.mp4']);
  assert.equal(bucket.store.size, 0);
});

test('a fresh sweeper (e.g. after a restart) still removes files the old process left behind', async () => {
  // Uploaded long before this process started - its in-memory timer died with the old process.
  const bucket = makeBucket([{ name: 'orphan.mp4', modifiedAt: new Date('2025-01-01T00:00:00Z') }]);
  const clock = { time: 1_000_000 };
  const { sweep } = makeSweeper(bucket, clock);

  assert.deepEqual(await sweep(), [], 'never deletes on its first sighting');
  clock.time += MAX_AGE_MS;
  assert.deepEqual(await sweep(), ['orphan.mp4']);
});

test('sweep never deletes objects without the auto-cleanup marker, and checks each one only once', async () => {
  const bucket = makeBucket([{ name: 'someone-elses-backup.zip', ours: false }]);
  const clock = { time: 0 };
  const { sweep } = makeSweeper(bucket, clock);

  await sweep();
  clock.time = MAX_AGE_MS;
  await sweep();
  clock.time = MAX_AGE_MS * 2;
  await sweep();

  assert.deepEqual(bucket.calls.delete, []);
  assert.deepEqual(bucket.calls.head, ['someone-elses-backup.zip']);
  assert.ok(bucket.store.has('someone-elses-backup.zip'));
});

test('a re-upload under the same name gets a fresh window instead of inheriting the old one', async () => {
  const bucket = makeBucket([{ name: 'video.mp4', modifiedAt: new Date('2026-01-01T00:00:00Z') }]);
  const clock = { time: 0 };
  const { sweep } = makeSweeper(bucket, clock);

  await sweep();
  clock.time = 30000;
  bucket.store.get('video.mp4').modifiedAt = new Date('2026-01-01T00:00:30Z');
  await sweep();
  // 45s after the first version was seen, but only 15s after the re-upload.
  clock.time = MAX_AGE_MS;
  assert.deepEqual(await sweep(), []);
  clock.time = 30000 + MAX_AGE_MS;
  assert.deepEqual(await sweep(), ['video.mp4']);
});

test('a failed delete is retried on the next run', async () => {
  const bucket = makeBucket([{ name: 'flaky.mp4' }]);
  const realDelete = bucket.deleteFile;
  let failNext = true;
  bucket.deleteFile = async (name) => {
    if (failNext) {
      failNext = false;
      throw new Error('network blip');
    }
    return realDelete(name);
  };
  const clock = { time: 0 };
  const { sweep } = makeSweeper(bucket, clock);

  await sweep();
  clock.time = MAX_AGE_MS;
  assert.deepEqual(await sweep(), []);
  assert.deepEqual(await sweep(), ['flaky.mp4']);
});
