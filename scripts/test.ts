import { rmSync } from "node:fs";

const glob = new Bun.Glob("tests/*.test.ts");
const files = [...glob.scanSync(".")].sort();
let failed = false;
// Each test file runs in a fresh process with an ISOLATED fold-checkpoint
// dir (issue #130 persistence): snapshots restored from an EARLIER run in
// the real ~/.omp/acp-omp-folds/ would mark the replayed compress calls as
// already-applied and break livePhase.
const foldDir = `/tmp/acp-omp-test-folds-${process.pid}`;
rmSync(foldDir, { recursive: true, force: true });
for (const file of files) {
  const proc = Bun.spawn([process.execPath, "test", file], {
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, ACP_AUTO_UPDATE: "off", ACP_OMP_FOLD_DIR: foldDir },
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) failed = true;
}
if (failed) process.exit(1);
