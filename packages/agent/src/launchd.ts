import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const PLIST_PATH = join(
  homedir(),
  'Library',
  'LaunchAgents',
  'com.airelay.agent.plist',
);

export function generatePlist(execPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.airelay.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>${execPath}</string>
    <string>agent</string>
    <string>_run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${homedir()}/.config/airelay/agent.log</string>
  <key>StandardErrorPath</key>
  <string>${homedir()}/.config/airelay/agent.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${homedir()}</string>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
</dict>
</plist>
`;
}

export function install(execPath: string): void {
  const plist = generatePlist(execPath);
  writeFileSync(PLIST_PATH, plist);
  execSync(`launchctl load ${PLIST_PATH}`);
  console.log(`Installed and started: ${PLIST_PATH}`);
}

export function uninstall(): void {
  try {
    execSync(`launchctl unload ${PLIST_PATH}`);
  } catch { /* already unloaded */ }
  try {
    unlinkSync(PLIST_PATH);
  } catch { /* already removed */ }
  console.log('Agent daemon stopped and removed.');
}

export function isRunning(): boolean {
  try {
    const out = execSync('launchctl list com.airelay.agent 2>/dev/null').toString();
    return out.includes('com.airelay.agent');
  } catch {
    return false;
  }
}
