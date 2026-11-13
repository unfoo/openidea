import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { getAction } from "@/platform/actions";
import { provideEditorService, prepareMenuGroups, type MenuGroupContext } from "@/workbench/contributions";
import { writeClipboardText } from "@/platform/clipboard";
import { useRun, rerunConfig, baseConfigOf } from "./store";
import { bazelCommandConfig, bazelContextItems, registerBazelContext } from "./bazelContext";

vi.mock("@/platform/clipboard", () => ({ writeClipboardText: vi.fn(async () => {}) }));
const root = "/work/app";
const build: RunConfig = {
  id: "plugin:unfoo.bazel:build-base",
  name: "Bazel build //:base",
  kind: "plugin",
  command: "/bin/bash",
  args: ["scripts/bazel.sh", "build", "//:base"],
  cwd: root,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
};
const test: RunConfig = {
  ...build,
  id: "plugin:unfoo.bazel:test-junit-spec",
  isTest: true,
  args: [
    "/plugin/test_runner.sh",
    "--launcher",
    "wrapper",
    "--target",
    "//pkg:spec",
    "--source-list",
    '["pkg/Spec.java"]',
  ],
};
const files: Record<string, string> = {};
const openFile = vi.fn(async () => {});
let dispose: () => void;
const source: MenuGroupContext = {
  paths: [`${root}/pkg/Spec.java`],
  text: "package pkg;\nclass Spec {\n @Test void works() {}\n}",
  line: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(files)) delete files[key];
  useProject.setState({ project: { root, trusted: true } as never });
  useRun.setState({ configs: [build, test], loaded: true, selectedContext: null });
  files[`${root}/.openidea/bazel/java-sync/model.json`] = JSON.stringify({
    schema: 1,
    targets: [
      { label: "@@//pkg:spec_lib", sources: [{ path: "pkg/Spec.java" }] },
      { label: "@@//other:lib", sources: [{ path: "other/Production.java" }] },
    ],
  });
  vi.spyOn(commands, "fsReadText").mockImplementation(async (path) => {
    if (!(path in files)) throw new Error("missing");
    return { status: "ok", data: files[path]! };
  });
  provideEditorService({ openFile } as never);
  dispose = registerBazelContext();
});
afterEach(() => {
  dispose();
  vi.restoreAllMocks();
  useProject.setState({ project: null });
  useRun.setState({ configs: [], selectedContext: null });
});

async function items(ctx = source) {
  await prepareMenuGroups("editor", ctx);
  return bazelContextItems(ctx);
}
async function runItem(item: Awaited<ReturnType<typeof items>>[number]) {
  if (item.kind !== "action") throw new Error("expected action");
  await getAction(item.action)!.run({ ctx: {}, arg: item.arg });
}

describe("Bazel editor menu", () => {
  it("exposes the reference actions for an owned spec", async () => {
    expect((await items()).map((i) => ("label" in i ? i.label : undefined))).toEqual([
      "Copy Target Label",
      "Jump to BUILD file",
      "Run all tests",
      "Run all tests with Coverage",
    ]);
  });
  it("copies the menu file owner even when the active editor changes", async () => {
    const menu = await items();
    await items({ paths: [`${root}/other/Production.java`], text: "class Production {}" });
    await runItem(menu[0]!);
    expect(writeClipboardText).toHaveBeenCalledWith("//pkg:spec_lib");
  });
  it("opens BUILD.bazel at the owning rule after Unicode text", async () => {
    files[`${root}/pkg/BUILD.bazel`] = '# 中文 🚀\njava_library(\n name="spec_lib",\n)\n';
    await runItem((await items())[1]!);
    expect(openFile).toHaveBeenCalledWith(`${root}/pkg/BUILD.bazel`, { selection: { line: 1, col: 0 } });
  });
  it("selects the BUILD rule under the caret and retains whole-file test actions", async () => {
    const ctx = { paths: [`${root}/pkg/BUILD`], text: 'java_library(name="lib")\njava_test(name="spec")', line: 1 };
    const menu = await items(ctx);
    expect(menu[0]).toMatchObject({ arg: { label: "//pkg:spec" } });
    expect(menu).toHaveLength(4);
  });
  it("offers every source owner instead of choosing the first", async () => {
    const model = JSON.parse(files[`${root}/.openidea/bazel/java-sync/model.json`]!);
    model.targets.push({ label: "@@//pkg:another", sources: [{ path: "pkg/Spec.java" }] });
    files[`${root}/.openidea/bazel/java-sync/model.json`] = JSON.stringify(model);
    expect((await items())[0]).toMatchObject({ submenu: [{ label: "//pkg:another" }, { label: "//pkg:spec_lib" }] });
  });
  it("hides actions outside the project and without an enabled provider", async () => {
    expect(await items({ paths: ["/other/Spec.java"], text: source.text })).toEqual([]);
    useRun.setState({ configs: [] });
    expect(await items()).toEqual([]);
  });
  it("does not offer tests for a production file with no test declarations", async () => {
    expect(
      (await items({ paths: [`${root}/other/Production.java`], text: "class Production {}" })).map((i) =>
        "label" in i ? i.label : undefined,
      ),
    ).toEqual(["Copy Target Label", "Jump to BUILD file"]);
  });
  it("retains the exact source or coverage selection on rerun", () => {
    const selected = {
      ...build,
      args: ["scripts/bazel.sh", "coverage", "//pkg:spec"],
      params: { contextSource: "bazel" },
    };
    const session: Parameters<typeof baseConfigOf>[0] = {
      id: "coverage-run",
      config: selected,
      runId: null,
      status: "finished",
      exitCode: 0,
      startedAt: 1,
      endedAt: 2,
      stdinClosed: false,
    };
    expect(rerunConfig(session)).toBe(selected);
    expect(baseConfigOf(session)).toBe(selected);
    expect(useRun.getState().configs[0]).toBe(build);
  });
  it("builds a multi-target coverage command with the approved provider identity", () => {
    expect(bazelCommandConfig(root, "coverage", ["//pkg:first", "//pkg:second"], [build])).toMatchObject({
      id: build.id,
      command: build.command,
      cwd: root,
      isTest: true,
      args: ["scripts/bazel.sh", "coverage", "//pkg:first", "//pkg:second"],
      params: { contextSource: "bazel" },
    });
  });
  it("handles a list filled entirely by native JUnit profiles", () => {
    expect(bazelCommandConfig(root, "coverage", ["//pkg:spec"], [test])?.args).toEqual([
      "scripts/bazel.sh",
      "coverage",
      "//pkg:spec",
    ]);
    const bazel = { ...test, args: test.args.map((a) => (a === "wrapper" ? "bazel" : a)) };
    expect(bazelCommandConfig(root, "test", ["//pkg/..."], [bazel])?.args).toEqual([
      "-c",
      'exec "$@"',
      "--",
      "bazel",
      "test",
      "//pkg/...",
    ]);
  });
});
