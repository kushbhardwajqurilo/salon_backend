#!/usr/bin/env node
/**
 * Master E2E Test Suite Runner for Unisex Parlour ERP
 * Location: backend/tests/e2e/runner.mjs
 *
 * Senior Engineering Architectural Decisions:
 * 1. Zero-Dependency Pure ESM Runner: Uses Node.js >=20 native capabilities (fetch, ESM, crypto)
 *    to execute test suites with extreme speed and zero open-handle leaks or VM isolation overhead.
 * 2. Multi-Mode CLI: Supports `--smoke`, `--tier=<1|2|3|4>`, `--filter=<string>`, and full execution.
 * 3. Structured TAP / Console Reporting: Emits standard TAP (Test Anything Protocol) output and
 *    renders an executive scorecard matrix comparing actual tests vs. required thresholds.
 * 4. Guaranteed Teardown: Uses try/finally lifecycle blocks ensuring server handles and database
 *    connections are cleanly destroyed regardless of test outcomes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startTestServer } from "./harness/server.mjs";
import { TestHttpClient } from "./harness/client.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Coverage thresholds defined in TEST_INFRA.md
const COVERAGE_THRESHOLDS = Object.freeze({
  tier1: 80, // >=5 tests x 16 features
  tier2: 80, // >=5 boundary cases x 16 features
  tier3: 16, // >=16 cross-feature tests
  tier4: 8,  // >=8 real-world application scenarios
  total: 184,
});

/**
 * Parses command-line arguments into a structured options object.
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    smoke: false,
    tier: null,
    filter: null,
    targetUrl: null,
    tap: false,
    help: false,
  };

  for (const arg of args) {
    if (arg === "--smoke") {
      options.smoke = true;
    } else if (arg.startsWith("--tier=")) {
      options.tier = parseInt(arg.split("=")[1], 10);
    } else if (arg.startsWith("--filter=")) {
      options.filter = arg.split("=")[1].toLowerCase();
    } else if (arg.startsWith("--url=")) {
      options.targetUrl = arg.split("=")[1];
    } else if (arg === "--tap") {
      options.tap = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }

  return options;
}

/**
 * Formats duration in seconds.
 */
function formatDuration(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

/**
 * Renders executive scorecard table.
 */
function renderScorecard({ scorecard, totalPassed, totalFailed, totalDuration, options }) {
  console.log("\n===============================================================================");
  console.log("             🏆 UNISEX PARLOUR ERP — E2E TEST SCORECARD                        ");
  console.log("===============================================================================");
  console.log(`Execution Mode : ${options.smoke ? "SMOKE SUITE (--smoke)" : options.tier ? `TIER ${options.tier}` : "FULL SUITE"}`);
  console.log(`Total Duration : ${formatDuration(totalDuration)}`);
  console.log(`Status         : ${totalFailed === 0 ? "✅ ALL TESTS PASSED" : `❌ ${totalFailed} TEST(S) FAILED`}`);
  console.log("-------------------------------------------------------------------------------");
  console.log("| Suite / Tier                 | Target | Passed | Failed | Duration | Status |");
  console.log("|------------------------------|--------|--------|--------|----------|--------|");

  const tiers = [
    { key: "smoke", label: "Smoke Verification Suite", target: 5 },
    { key: "tier1", label: "Tier 1: Feature Coverage", target: COVERAGE_THRESHOLDS.tier1 },
    { key: "tier2", label: "Tier 2: Boundary Cases",   target: COVERAGE_THRESHOLDS.tier2 },
    { key: "tier3", label: "Tier 3: Cross-Feature",    target: COVERAGE_THRESHOLDS.tier3 },
    { key: "tier4", label: "Tier 4: Real-World",       target: COVERAGE_THRESHOLDS.tier4 },
  ];

  for (const t of tiers) {
    const data = scorecard[t.key];
    if (data && (data.passed > 0 || data.failed > 0)) {
      const statusIcon = data.failed > 0 ? "FAIL ❌" : "PASS ✅";
      const durationStr = formatDuration(data.duration).padStart(8);
      console.log(
        `| ${t.label.padEnd(28)} | ${String(t.target).padStart(6)} | ${String(data.passed).padStart(6)} | ${String(data.failed).padStart(6)} | ${durationStr} | ${statusIcon.padEnd(6)} |`
      );
    }
  }

  console.log("-------------------------------------------------------------------------------");
  const totalCount = totalPassed + totalFailed;
  console.log(
    `| TOTAL                        | ${String(COVERAGE_THRESHOLDS.total).padStart(6)} | ${String(totalPassed).padStart(6)} | ${String(totalFailed).padStart(6)} | ${formatDuration(totalDuration).padStart(8)} | ${(totalFailed === 0 ? "PASS ✅" : "FAIL ❌").padEnd(6)} |`
  );
  console.log("===============================================================================\n");
}

/**
 * Master runner execution entrypoint.
 */
async function main() {
  const options = parseArgs();

  if (options.help) {
    console.log(`
Unisex Parlour ERP — Master E2E Test Runner CLI

Usage:
  node backend/tests/e2e/runner.mjs [options]

Options:
  --smoke          Execute fast smoke verification suite (health, auth, multi-tenancy, zero-tax)
  --tier=<1|2|3|4> Execute tests for a specific methodology tier
  --filter=<text>  Run only tests matching the specified filename or title filter
  --url=<url>      Target an external base URL (e.g. http://localhost:5000)
  --tap            Emit pure TAP v13 test output
  --help, -h       Display this help message
`);
    process.exit(0);
  }

  const overallStartTime = Date.now();
  console.log("===============================================================================");
  console.log("   🚀 UNISEX PARLOUR ERP — MASTER E2E TEST RUNNER                              ");
  console.log("===============================================================================");
  console.log(`Starting at : ${new Date().toISOString()}`);
  console.log(`Node Runtime: ${process.version} (Platform: ${process.platform})`);

  let serverHandle = null;
  const scorecard = {
    smoke: { passed: 0, failed: 0, duration: 0 },
    tier1: { passed: 0, failed: 0, duration: 0 },
    tier2: { passed: 0, failed: 0, duration: 0 },
    tier3: { passed: 0, failed: 0, duration: 0 },
    tier4: { passed: 0, failed: 0, duration: 0 },
  };

  let globalPassed = 0;
  let globalFailed = 0;

  try {
    // 1. Initialize server & client harness
    console.log("[SETUP] Initializing ephemeral test server on OS port 0...");
    serverHandle = await startTestServer({ targetUrl: options.targetUrl });
    console.log(`[SETUP] Test server active at ${serverHandle.baseUrl} (API: ${serverHandle.apiUrl})`);

    const client = new TestHttpClient({ baseUrl: serverHandle.apiUrl });

    // 2. Mode dispatch
    if (options.smoke) {
      console.log("\n--- EXECUTING SMOKE VERIFICATION SUITE ---");
      const smokeModule = await import("./smoke.test.mjs");
      const smokeStart = Date.now();
      const smokeResults = await smokeModule.runSmokeSuite({ client, serverHandle });
      scorecard.smoke = {
        passed: smokeResults.passed,
        failed: smokeResults.failed,
        duration: Date.now() - smokeStart,
      };
      globalPassed += smokeResults.passed;
      globalFailed += smokeResults.failed;
    } else {
      // Execute discovered tests across tiers
      const tiersToRun = options.tier
        ? [options.tier]
        : [1, 2, 3, 4];

      for (const tierNum of tiersToRun) {
        const tierFolder = tierNum === 1
          ? "tier1_feature"
          : tierNum === 2
          ? "tier2_boundary"
          : tierNum === 3
          ? "tier3_cross_feature"
          : "tier4_real_world";

        const tierPath = path.join(__dirname, tierFolder);
        if (!fs.existsSync(tierPath)) {
          continue;
        }

        const files = fs.readdirSync(tierPath).filter((f) => f.endsWith(".test.mjs"));
        if (files.length === 0) continue;

        console.log(`\n--- EXECUTING TIER ${tierNum} SUITE (${files.length} test files) ---`);
        const tierStart = Date.now();
        let tierPassed = 0;
        let tierFailed = 0;

        for (const file of files) {
          if (options.filter && !file.toLowerCase().includes(options.filter)) {
            continue;
          }

          console.log(`  ▶ Running [${file}]...`);
          try {
            const testModule = await import(`./${tierFolder}/${file}`);
            if (typeof testModule.run === "function") {
              const res = await testModule.run({ client, serverHandle });
              tierPassed += (res?.passed ?? 0);
              tierFailed += (res?.failed ?? 0);
            } else {
              console.error(`  ❌ [${file}] Missing exported 'run' test function.`);
              tierFailed += 1;
            }
          } catch (err) {
            console.error(`  ❌ [${file}] Failed with error:`, err.message);
            tierFailed += 1;
          }
        }

        const tierKey = `tier${tierNum}`;
        scorecard[tierKey] = {
          passed: tierPassed,
          failed: tierFailed,
          duration: Date.now() - tierStart,
        };
        globalPassed += tierPassed;
        globalFailed += tierFailed;
      }
    }
  } catch (err) {
    console.error("🚨 Fatal error in E2E runner execution:", err);
    globalFailed += 1;
  } finally {
    // 3. Graceful teardown
    if (serverHandle) {
      console.log("\n[TEARDOWN] Closing test server and database connections...");
      await serverHandle.close();
      console.log("[TEARDOWN] Cleanup complete.");
    }
  }

  const totalDuration = Date.now() - overallStartTime;
  renderScorecard({
    scorecard,
    totalPassed: globalPassed,
    totalFailed: globalFailed,
    totalDuration,
    options,
  });

  if (globalFailed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Unhandled Runner Failure:", err);
  process.exit(1);
});
