import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";
import { fileURLToPath } from "url";

// WebdriverIO config for driving the REAL ADE binary via tauri-driver.
// Adapted from the official Tauri v2 WebdriverIO example. Linux/Windows only —
// macOS has no WKWebView WebDriver (see docs/QA.md).

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Debug binary from `tauri build --debug --no-bundle`. Cargo package is `ade`,
// so on Linux it lands here. If your build names it differently (e.g. the
// productName "ADE"), set ADE_BINARY to the absolute path to override.
const application =
  process.env.ADE_BINARY ||
  path.resolve(projectRoot, "src-tauri", "target", "debug", "ade");

// Tracks the tauri-driver child so we can tear it down between sessions.
let tauriDriver;
let exiting = false;

export const config = {
  runner: "local",
  host: "127.0.0.1",
  port: 4444,
  specs: ["./specs/**/*.e2e.mjs"],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      // tauri-driver reads this to launch the binary under the native webview driver.
      "tauri:options": { application },
    },
  ],
  logLevel: "info",
  reporters: ["spec"],
  framework: "mocha",
  mochaOpts: { ui: "bdd", timeout: 120000 },

  // Build the real app once before the run; tauri-driver launches this exact
  // binary. ADE_QA_SEED (when implemented) makes the backend seed deterministic
  // board data on boot so specs have stable fixtures.
  onPrepare: () => {
    const res = spawnSync(
      "npm",
      ["run", "tauri", "build", "--", "--debug", "--no-bundle"],
      { cwd: projectRoot, stdio: "inherit", shell: true }
    );
    if (res.status !== 0) {
      throw new Error(`tauri build failed with status ${res.status}`);
    }
  },

  // tauri-driver proxies WebDriver requests to the platform's native driver
  // (WebKitWebDriver on Linux). It must be on PATH at ~/.cargo/bin.
  beforeSession: () => {
    tauriDriver = spawn(
      path.resolve(os.homedir(), ".cargo", "bin", "tauri-driver"),
      [],
      { stdio: [null, process.stdout, process.stderr] }
    );
    tauriDriver.on("error", (error) => {
      console.error("tauri-driver error:", error);
      process.exit(1);
    });
    tauriDriver.on("exit", (code) => {
      if (!exiting) {
        console.error("tauri-driver exited with code:", code);
        process.exit(1);
      }
    });
  },

  afterSession: () => {
    exiting = true;
    tauriDriver?.kill();
  },
};
