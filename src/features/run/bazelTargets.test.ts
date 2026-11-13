import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { bazelTargets } from "./bazelTargets";
import { fileTargets, OPTIMISTIC, produceContext } from "./producers";

const root = "/work/app";
const build: RunConfig = {
  id: "plugin:unfoo.bazel:build-known",
  name: "Bazel build //:known",
  kind: "plugin",
  command: "bash",
  args: ["scripts/bazel.sh", "build", "//:known"],
  cwd: root,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
};
const test: RunConfig = {
  ...build,
  id: "plugin:unfoo.bazel:test-junit-x",
  name: "Bazel test //pkg:spec",
  args: ["/data/test_runner.sh", "--root", root, "--target", "//pkg:spec"],
  isTest: true,
};

describe("Bazel BUILD context", () => {
  it("detects literal top-level rule and macro names with their declaration lines", () => {
    const text = [
      'load("//:rules.bzl", "custom")',
      '# java_test(name="fake")',
      '"""java_test(name="example")"""',
      "java_test(",
      ' name = "spec",',
      ' deps = [":lib"],',
      ")",
      'custom(name="macro", config=dict(name="nested"))',
      'java_library(name=PREFIX + "computed")',
      'java_library(name="also" + SUFFIX)',
      'package(default_visibility=["//visibility:public"])',
    ].join("\n");
    expect(bazelTargets(text, "pkg/BUILD.bazel").map((t) => [t.line, t.bazelLabel, t.bazelOperation])).toEqual([
      [3, "//pkg:spec", "test"],
      [7, "//pkg:macro", "build"],
    ]);
    expect(bazelTargets('java_binary(name="app")', "BUILD")[0]?.bazelLabel).toBe("//:app");
  });

  it("launches the cached native test profile from any line of its rule", () => {
    const content = 'java_test(\n name = "spec",\n deps = [":lib"],\n)\n';
    const input = { root, path: `${root}/pkg/BUILD.bazel`, configs: [build, test], content, line: 2 };
    expect(fileTargets(input, content)).toHaveLength(1);
    const produced = produceContext(input, OPTIMISTIC);
    expect(produced?.config).toMatchObject({ id: test.id, args: test.args, cwd: root, isTest: true });
    expect(produceContext({ ...input, line: 4 }, OPTIMISTIC)).toBeNull();
  });

  it.each([
    ["java_library", "build"],
    ["java_binary", "run"],
    ["java_test", "test"],
  ])("launches an uncached %s using the granted wrapper", (rule, verb) => {
    const content = `${rule}(name="new")`;
    const config = produceContext(
      { root, path: `${root}/pkg/BUILD`, configs: [build], content, line: 0 },
      OPTIMISTIC,
    )?.config;
    expect(config).toMatchObject({
      id: build.id,
      command: "bash",
      cwd: root,
      args: ["scripts/bazel.sh", verb, "//pkg:new"],
      isTest: verb === "test",
      params: { contextSource: "bazel" },
    });
  });

  it("does not make project BUILD files runnable without an enabled Bazel provider", () => {
    expect(
      produceContext({ root, path: `${root}/BUILD`, configs: [], content: 'java_test(name="x")', line: 0 }, OPTIMISTIC),
    ).toBeNull();
  });
});
