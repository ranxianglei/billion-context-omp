const glob = new Bun.Glob("tests/*.test.ts");
const files = [...glob.scanSync(".")].sort();
let failed = false;
for (const file of files) {
  const proc = Bun.spawn([process.execPath, "test", file], {
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) failed = true;
}
if (failed) process.exit(1);
