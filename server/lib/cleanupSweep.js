// Restart-safe backstop for POST /api/download's in-memory cleanup timer.
function createCleanupSweeper({ maxAgeMs, listFiles, deleteFile, isAutoCleanupObject, now = Date.now }) {
  // Keyed by name + LastModified so a re-upload under the same name gets a fresh window.
  let tracked = new Map();
  let running = false;

  async function sweep() {
    if (running) return [];
    running = true;
    try {
      const files = await listFiles();
      const current = now();
      const next = new Map();
      const removed = [];

      for (const file of files) {
        const id = `${file.name}|${new Date(file.modifiedAt).getTime()}`;
        // Age counts from first sighting, not LastModified: immune to B2 clock skew and slow uploads.
        const entry = tracked.get(id) || { since: current, foreign: false };
        next.set(id, entry);
        if (entry.foreign || current - entry.since < maxAgeMs) continue;

        try {
          if (!(await isAutoCleanupObject(file.name))) {
            entry.foreign = true;
            continue;
          }
          await deleteFile(file.name);
          next.delete(id);
          removed.push(file.name);
        } catch {
          // Left tracked, so the next run retries it.
        }
      }

      tracked = next;
      return removed;
    } finally {
      running = false;
    }
  }

  return { sweep };
}

function startCleanupSweep({ intervalMs, ...sweeperOptions }) {
  const { sweep } = createCleanupSweeper(sweeperOptions);
  // A failed run (e.g. B2 unreachable) is retried on the next interval.
  const run = () => sweep().catch(() => {});

  run();
  return setInterval(run, intervalMs);
}

module.exports = { createCleanupSweeper, startCleanupSweep };
