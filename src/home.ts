import { homedir } from "node:os";

/** os.homedir() ignores HOME/USERPROFILE under Bun; respect env first. */
export function homeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || homedir();
}
