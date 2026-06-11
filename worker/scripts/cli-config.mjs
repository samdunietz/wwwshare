// Same resolution as the CLI's loadEnv(): $XDG_CONFIG_HOME/wwwshare/.env,
// defaulting XDG_CONFIG_HOME to ~/.config. Shared so set-config and
// rotate-token can never disagree with the CLI about where config lives.
import os from "node:os";
import path from "node:path";

export function cliConfigPath() {
  const xdgConfigHome =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfigHome, "wwwshare", ".env");
}
