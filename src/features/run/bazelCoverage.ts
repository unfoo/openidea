import javaCoverageSource from "./bazelJavaCoverage.py?raw";
import { isBazelJUnit } from "./bazel";
import { executeAction } from "@/platform/actions";
import { call, commands, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { notifications } from "@/workbench/contributions";

export function bazelCoverageReportPath(line: string): string | null {
  const match = /LCOV coverage report is located at (.+\/_coverage_report\.dat)\s*$/.exec(line);
  return match?.[1] ?? null;
}

export async function prepareBazelJavaCoverage(
  config: RunConfig,
  labels: string[],
  configs: readonly RunConfig[],
): Promise<RunConfig | null> {
  const pin = /(?:^|[\\/])bash(?:\.exe)?$/.test(config.command) ? config : configs.find(isBazelJUnit);
  if (!pin || !config.cwd) return null;
  const verb = config.args.findIndex((arg) => arg === "test" || arg === "coverage");
  if (verb < 0) return null;
  const tools = await call(commands.sdkLocateTools([], config.cwd));
  const bytes = new TextEncoder().encode(javaCoverageSource);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const directory = `${tools.compileDir}/bazel-coverage`;
  const script = `${directory}/java-${hash.slice(0, 16)}.py`;
  try {
    await call(commands.fsCreateFileBytes(script, Array.from(bytes)));
  } catch (error) {
    if ((await call(commands.fsReadText(script))) !== javaCoverageSource) throw error;
  }
  const request = `${directory}/${crypto.randomUUID()}.json`;
  const data = JSON.stringify({
    root: config.cwd,
    labels,
    launcher: [config.command, ...config.args.slice(0, verb)],
    options: config.args.slice(verb + 1).filter((arg) => !labels.includes(arg)),
  });
  await call(commands.fsCreateFileBytes(request, Array.from(new TextEncoder().encode(data))));
  return {
    ...config,
    id: pin.id,
    command: pin.command,
    debugAdapter: null,
    args: ["-c", 'exec python3 "$@"', "--", script, request],
    params: { ...config.params, bazelCoverage: "lcov" },
  };
}

/** Installed for every launch, including a Run tab's Rerun and the toolbar. */
export function bazelCoverageFeedback(config: RunConfig) {
  if (!config.id.startsWith("plugin:unfoo.bazel:") || config.params?.bazelCoverage !== "lcov" || !config.cwd)
    return null;
  const root = config.cwd;
  const directory = `${root}/.openidea/bazel/coverage`;
  const name = (config.params.coverageName ?? "Bazel").replace(/[^\p{L}\p{N}._ -]/gu, "_");
  const filename = Array.from(name).slice(0, 80).join("") || "Bazel";
  const snapshot = `${directory}/${crypto.randomUUID()}/${filename}.info`;
  let report: Promise<unknown> | undefined;
  return {
    onLine(line: string) {
      const path = bazelCoverageReportPath(line);
      if (!path || report) return;
      // Copy this completed report before a later invocation replaces Bazel's shared report.
      report = call(commands.fsCopy(path, snapshot));
      void report.catch(() => undefined);
    },
    onExit(exitCode: number | null, stopped: boolean) {
      if (stopped || (exitCode !== 0 && exitCode !== 3)) return;
      if (useProject.getState().project?.root !== root) return;
      void (async () => {
        if (!report) throw new Error(tx`Bazel did not produce an LCOV coverage report.`);
        await report;
        if (useProject.getState().project?.root === root) await executeAction("coverage.importReport", snapshot);
      })().catch((error: unknown) =>
        notifications().notify({
          group: "run",
          level: "error",
          title: tx`Bazel coverage report unavailable`,
          body: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  };
}
