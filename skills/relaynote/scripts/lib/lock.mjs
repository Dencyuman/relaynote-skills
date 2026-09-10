import fs from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
/** Process lock with stale-owner recovery; never steal from a live refresh. */
export async function locked(directory, fn) {
  const until = Date.now() + 65000;
  while (true) {
    try {
      await fs.mkdir(directory, { mode: 0o700 });
      await fs.writeFile(directory + "/pid", String(process.pid), {
        mode: 0o600,
      });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(
        await fs.readFile(directory + "/pid", "utf8").catch(() => 0),
      );
      const stat = await fs.stat(directory).catch(() => null);
      let alive = true;
      if (pid)
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
      if (stat && !alive && Date.now() - stat.mtimeMs > 1000) {
        await fs.rm(directory, { recursive: true, force: true });
        continue;
      }
      if (stat && !pid && Date.now() - stat.mtimeMs > 65000) {
        await fs.rm(directory, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > until)
        throw new Error("Another authentication operation is still running");
      await delay(50);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
