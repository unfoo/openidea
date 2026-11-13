import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { executeAction } from "@/platform/actions";
import { bazelCoverageFeedback, bazelCoverageReportPath, prepareBazelJavaCoverage } from "./bazelCoverage";
vi.mock("@/platform/actions", async (original) => ({
  ...(await original<typeof import("@/platform/actions")>()),
  executeAction: vi.fn(async () => {}),
}));
const root = "/work/app";
const config: RunConfig = {
  id: "plugin:unfoo.bazel:build-base",
  cwd: root,
  params: { bazelCoverage: "lcov" },
  name: "Coverage",
  kind: "plugin",
  command: "bash",
  args: [],
  env: {},
  detected: true,
  isTest: true,
  debugAdapter: null,
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  vi.clearAllMocks();
  useProject.setState({ project: { root } as never });
  vi.spyOn(commands, "fsCreateDir").mockResolvedValue({ status: "ok", data: null });
  vi.spyOn(commands, "fsCopy").mockResolvedValue({ status: "ok", data: null });
});
describe("Bazel coverage feedback", () => {
  it("imports this invocation snapshot when the helper already created the coverage directory", async () => {
    vi.mocked(commands.fsCreateDir).mockRejectedValue(new Error("already exists"));
    const feedback = bazelCoverageFeedback(config)!;
    feedback.onLine("INFO: LCOV coverage report is located at /output/_coverage/_coverage_report.dat");
    await settle();
    feedback.onExit(0, false);
    await settle();
    expect(commands.fsCopy).toHaveBeenCalledWith(
      "/output/_coverage/_coverage_report.dat",
      expect.stringMatching(/^\/work\/app\/\.openidea\/bazel\/coverage\/.+\.info$/),
    );
    expect(executeAction).toHaveBeenCalledWith("coverage.importReport", vi.mocked(commands.fsCopy).mock.calls[0]![1]);
  });
  it("creates a distinct report for each repeat", async () => {
    for (let i = 0; i < 2; i++) {
      const feedback = bazelCoverageFeedback(config)!;
      feedback.onLine("LCOV coverage report is located at /output/_coverage/_coverage_report.dat");
      await settle();
      feedback.onExit(0, false);
    }
    await settle();
    expect(commands.fsCopy).toHaveBeenCalledTimes(2);
    expect(vi.mocked(commands.fsCopy).mock.calls[0]![1]).not.toBe(vi.mocked(commands.fsCopy).mock.calls[1]![1]);
  });
  it.each([
    [0, true],
    [1, false],
  ])("does not import a stopped or failed build", async (code, stopped) => {
    const feedback = bazelCoverageFeedback(config)!;
    feedback.onLine("LCOV coverage report is located at /output/_coverage/_coverage_report.dat");
    await settle();
    feedback.onExit(code as number, stopped as boolean);
    await settle();
    expect(executeAction).not.toHaveBeenCalled();
  });
  it("ignores completion after switching projects", async () => {
    const feedback = bazelCoverageFeedback(config)!;
    feedback.onLine("LCOV coverage report is located at /output/_coverage/_coverage_report.dat");
    await settle();
    useProject.setState({ project: { root: "/other" } as never });
    feedback.onExit(0, false);
    await settle();
    expect(executeAction).not.toHaveBeenCalled();
  });
  it("recognizes an report path with spaces", () => {
    expect(
      bazelCoverageReportPath("INFO: LCOV coverage report is located at /with spaces/_coverage/_coverage_report.dat"),
    ).toBe("/with spaces/_coverage/_coverage_report.dat");
    expect(bazelCoverageReportPath("test output: no coverage generated")).toBeNull();
    expect(
      bazelCoverageReportPath("INFO: LCOV coverage report is located at /output/_coverage/_baseline_report.dat"),
    ).toBeNull();
  });
});

it("prepares the Java helper with a bounded request file and the original launcher", async () => {
  const stored = new Map<string, number[]>();
  vi.spyOn(commands, "sdkLocateTools").mockResolvedValue({
    status: "ok",
    data: { tools: [], compileDir: "/tools/run" },
  });
  vi.spyOn(commands, "fsCreateFileBytes").mockImplementation(async (path, data) => {
    stored.set(path, data);
    return { status: "ok", data: null };
  });
  const base: RunConfig = {
    ...config,
    command: "/bin/bash",
    args: ["scripts/bazel.sh", "coverage", "//pkg:spec", "--config=custom"],
  };
  const prepared = await prepareBazelJavaCoverage(base, ["//pkg:spec"], [base]);
  expect(prepared).toMatchObject({ id: base.id, command: base.command, cwd: root, params: { bazelCoverage: "lcov" } });
  expect(prepared?.args.slice(0, 3)).toEqual(["-c", 'exec python3 "$@"', "--"]);
  const request = JSON.parse(new TextDecoder().decode(new Uint8Array(stored.get(prepared!.args[4]!)!)));
  expect(request).toEqual({
    root,
    labels: ["//pkg:spec"],
    launcher: ["/bin/bash", "scripts/bazel.sh"],
    options: ["--config=custom"],
  });
  expect(base.args).toEqual(["scripts/bazel.sh", "coverage", "//pkg:spec", "--config=custom"]);
});
