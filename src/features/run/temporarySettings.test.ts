import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({
  runConfigs: vi.fn(),
  runWithoutDerived: vi.fn(),
  runApplySettings: vi.fn(),
}));
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: ipc,
}));

import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { adoptTemporary, loadConfigs, resetRuns, useRun } from "./store";

const KEY = "openidea.run.temporary.v2:/p";
const ok = <T>(data: T) => Promise.resolve({ status: "ok" as const, data });

/** A Maven test run made from the tool window, with the settings of the day baked in. */
const goal: RunConfig = {
  id: "maven:goal:pom.xml:test",
  name: "app [test]",
  kind: "maven",
  command: "/old/maven/bin/mvn",
  args: ["-s", "/old/settings.xml", "test"],
  cwd: null,
  env: { JAVA_HOME: "/old/jdk" },
  detected: false,
  isTest: true,
  debugAdapter: null,
};

let mavenHome = "/new/maven";
beforeEach(() => {
  resetRuns();
  localStorage.clear();
  useProject.setState({ project: { root: "/p" } as never });
  ipc.runConfigs.mockImplementation(() => ok([]));
  // The backend drops what settings derived, and applies the current settings again.
  ipc.runWithoutDerived.mockImplementation((configs: RunConfig[]) =>
    ok(
      configs.map((c) => ({
        ...c,
        command: "mvn",
        args: c.args.filter((a, i, all) => a !== "-s" && all[i - 1] !== "-s"),
        env: {},
      })),
    ),
  );
  ipc.runApplySettings.mockImplementation((configs: RunConfig[]) =>
    ok(
      configs.map((c) => ({
        ...c,
        command: `${mavenHome}/bin/mvn`,
        args: ["-s", `${mavenHome}/conf/settings.xml`, ...c.args],
        env: { JAVA_HOME: "/new/jdk" },
      })),
    ),
  );
});
afterEach(() => useProject.setState({ project: null }));

it("keeps temporary configurations without settings-derived values and applies today's settings on load", async () => {
  adoptTemporary(goal);
  await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(KEY)!)[0].command).toBe("mvn"));
  const kept = JSON.parse(localStorage.getItem(KEY)!)[0] as RunConfig;
  expect(kept.args).toEqual(["test"]);
  expect(kept.env).toEqual({});

  // Settings › Maven changed: the reload after it brings the temporary configuration along.
  mavenHome = "/moved/maven";
  await loadConfigs();
  const loaded = useRun.getState().configs.find((c) => c.id === goal.id)!;
  expect(useRun.getState().temporary).toEqual([goal.id]);
  expect(loaded.command).toBe("/moved/maven/bin/mvn");
  expect(loaded.args).toEqual(["-s", "/moved/maven/conf/settings.xml", "test"]);
  expect(loaded.env).toEqual({ JAVA_HOME: "/new/jdk" });
});

it("keeps the newest catalogue when a pre-reload request finishes late", async () => {
  let finish!: (value: { status: "ok"; data: RunConfig[] }) => void;
  ipc.runConfigs.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const older = loadConfigs();
  const current = { ...goal, id: "plugin:example:current" };
  ipc.runConfigs.mockImplementationOnce(() => ok([current]));
  await loadConfigs();
  finish({ status: "ok", data: [goal] });
  await older;
  expect(useRun.getState().configs).toEqual([current]);
});

it("ignores a pre-reload error after the recovered catalogue arrives", async () => {
  let fail!: (error: Error) => void;
  ipc.runConfigs.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  const older = loadConfigs();
  ipc.runConfigs.mockImplementationOnce(() => ok([goal]));
  await loadConfigs();
  fail(new Error("old plugin instance stopped"));
  await older;
  expect(useRun.getState().loadError).toBeNull();
  expect(useRun.getState().configs).toEqual([goal]);
});

it("discards a request after closing and reopening the same project", async () => {
  let finish!: (value: { status: "ok"; data: RunConfig[] }) => void;
  ipc.runConfigs.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const older = loadConfigs();
  resetRuns();
  finish({ status: "ok", data: [goal] });
  await older;
  expect(useRun.getState().configs).toEqual([]);
  expect(useRun.getState().loaded).toBe(false);
});
