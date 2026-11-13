import { prepareBazelJavaCoverage } from "./bazelCoverage";
import { registerActions } from "@/platform/actions";
import { writeClipboardText } from "@/platform/clipboard";
import { call, commands, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { tx } from "@/platform/i18n";
import { showContextMenu, type MenuItem } from "@/ui";
import { editorService, registerMenuGroup, type MenuGroupContext } from "@/workbench/contributions";
import { bazelTestBases } from "./bazel";
import { bazelTargets, bazelTargetConfig, isBazelBuild } from "./bazelTargets";
import { editorInput, launchProduced } from "./contextRun";
import { fileTargets } from "./producers";
import { loadConfigs, useRun } from "./store";

interface JavaTarget {
  label: string;
  sources: Array<{ path: string }>;
}
interface JavaModel {
  targets?: JavaTarget[];
}
interface Context extends MenuGroupContext {
  root: string;
  path: string;
  rel: string;
}
interface TargetArg extends MenuGroupContext {
  label?: string;
}

let modelCache: { root: string; loaded: number; value: Promise<JavaModel> } | undefined;
const prepared = new Map<string, { model: JavaModel; text?: string }>();
const localLabel = (label: string) => label.replace(/^@@?(?=\/\/)/, "");
const configLabel = (config: RunConfig) => config.args.find((arg) => arg.startsWith("//"));

function model(root: string): Promise<JavaModel> {
  if (modelCache?.root === root && Date.now() - modelCache.loaded < 1500) return modelCache.value;
  const value = call(commands.fsReadText(`${root}/.openidea/bazel/java-sync/model.json`))
    .then((text): JavaModel => {
      const data = JSON.parse(text) as JavaModel;
      return Array.isArray(data.targets) ? data : {};
    })
    .catch(() => ({}));
  modelCache = { root, loaded: Date.now(), value };
  return value;
}

function context(ctx: MenuGroupContext): Context | null {
  const root = useProject.getState().project?.root;
  const path = ctx.paths[0];
  if (!root || ctx.paths.length !== 1 || !path || (!path.startsWith(root + "/") && path !== root)) return null;
  if (!useRun.getState().configs.some((c) => c.id.startsWith("plugin:unfoo.bazel:"))) return null;
  return { ...ctx, root, path, rel: path === root ? "" : path.slice(root.length + 1) };
}

async function prepare(ctx: MenuGroupContext): Promise<void> {
  const c = context(ctx);
  if (!c) return;
  const [data, text] = await Promise.all([
    model(c.root),
    c.text !== undefined || c.dirs?.[0]
      ? Promise.resolve(c.text)
      : call(commands.fsReadText(c.path)).catch(() => undefined),
  ]);
  prepared.set(c.path, { model: data, text });
  if (prepared.size > 50) prepared.delete(prepared.keys().next().value!);
}

function owners(c: Context): string[] {
  const text = c.text ?? prepared.get(c.path)?.text;
  if (isBazelBuild(c.rel)) {
    const rules = bazelTargets(text ?? "", c.rel);
    const current = c.line == null ? undefined : rules.find((r) => r.line <= c.line! && r.endLine! >= c.line!);
    return (current ? [current] : rules).map((r) => r.bazelLabel!);
  }
  const targets = prepared.get(c.path)?.model.targets ?? [];
  const labels = targets
    .filter((t) => Array.isArray(t.sources) && t.sources.some((s) => s.path === c.rel))
    .map((t) => localLabel(t.label))
    .filter((label) => label.startsWith("//"));
  if (labels.length) return [...new Set(labels)].sort();
  return [
    ...new Set(
      bazelTestBases(c.rel, useRun.getState().configs)
        .map(configLabel)
        .filter((s): s is string => !!s),
    ),
  ];
}

function testLabels(c: Context): string[] {
  if (c.dirs?.[0]) return [c.rel ? `//${c.rel}/...` : "//..."];
  const configs = useRun.getState().configs;
  const text = c.text ?? prepared.get(c.path)?.text ?? "";
  if (isBazelBuild(c.rel))
    return bazelTargets(text, c.rel)
      .filter(
        (t) => t.kind === "test" || configs.some((config) => config.isTest && config.args.includes(t.bazelLabel!)),
      )
      .map((t) => t.bazelLabel!);
  if (!fileTargets({ path: c.path, root: c.root, configs }, text).some((t) => t.kind === "test" || t.kind === "suite"))
    return [];
  return [
    ...new Set(
      bazelTestBases(c.rel, configs)
        .map(configLabel)
        .filter((s): s is string => !!s),
    ),
  ];
}

export function bazelCommandConfig(
  root: string,
  operation: string,
  labels: string[],
  configs: readonly RunConfig[],
): RunConfig | null {
  const owned = configs.filter((c) => c.id.startsWith("plugin:unfoo.bazel:"));
  const base =
    owned.find((c) => c.args.includes("build")) ?? owned.find((c) => c.args.some((a) => a === "test" || a === "run"));
  let selected = base;
  let prefix: string[];
  let suffix: string[] = [];
  if (base) {
    const verb = base.args.findIndex((a) => a === "build" || a === "test" || a === "run");
    const operand = base.args.findIndex((a, i) => i > verb && a.startsWith("//"));
    if (operand < 0) return null;
    prefix = base.args.slice(0, verb);
    suffix = [...base.args.slice(verb + 1, operand), ...base.args.slice(operand + 1)];
  } else {
    selected = owned.find((c) => c.args.some((a) => /(?:^|[\\/])test_runner\.sh$/.test(a)));
    if (!selected) return null;
    const launcherIndex = selected.args.indexOf("--launcher");
    const launcher = selected.args[launcherIndex + 1];
    if (launcherIndex < 0 || !launcher || !["wrapper", "bazel", "bazelisk"].includes(launcher)) return null;
    prefix = launcher === "wrapper" ? ["scripts/bazel.sh"] : ["-c", 'exec "$@"', "--", launcher];
  }
  return {
    ...selected!,
    cwd: root,
    args: [...prefix, operation, ...labels, ...suffix],
    name: `Bazel ${operation} ${labels.join(" ")}`,
    isTest: operation === "test" || operation === "coverage",
    params: { ...selected!.params, contextSource: "bazel" },
  };
}

async function jump(c: Context, label: string): Promise<void> {
  const pkg = label.slice(2, label.indexOf(":"));
  for (const name of ["BUILD.bazel", "BUILD"]) {
    const path = `${c.root}/${pkg ? pkg + "/" : ""}${name}`;
    let text: string;
    try {
      text = await call(commands.fsReadText(path));
    } catch {
      continue;
    }
    const target = bazelTargets(text, pkg ? `${pkg}/${name}` : name).find((t) => t.bazelLabel === label);
    await editorService().openFile(path, { selection: { line: target?.line ?? 0, col: 0 } });
    return;
  }
  throw new Error(tx`The target's BUILD file is unavailable.`);
}

function actionContext(arg: unknown): TargetArg {
  if (arg && typeof arg === "object" && "paths" in arg) return arg as TargetArg;
  const editor = editorInput();
  return editor ? { paths: [editor.path], text: editor.content, line: editor.line } : { paths: [] };
}

async function targetAction(arg: unknown, action: (c: Context, label: string) => Promise<void>): Promise<void> {
  const ctx = actionContext(arg);
  if (!useRun.getState().loaded) await loadConfigs();
  await prepare(ctx);
  const c = context(ctx);
  if (!c) return;
  const labels = owners(c);
  if (ctx.label && labels.includes(ctx.label)) return action(c, ctx.label);
  if (labels.length === 1) return action(c, labels[0]!);
  if (labels.length > 1)
    showContextMenu(
      { x: window.innerWidth / 2, y: window.innerHeight / 3 },
      labels.map((label) => ({ label, run: () => action(c, label) })),
    );
}

async function runAll(arg: unknown, coverage: boolean): Promise<void> {
  const ctx = actionContext(arg);
  if (!useRun.getState().loaded) await loadConfigs();
  await prepare(ctx);
  const c = context(ctx);
  if (!c) return;
  const labels = testLabels(c);
  if (!labels.length) return;
  const configs = useRun.getState().configs;
  if (!coverage && labels.length === 1 && !c.dirs?.[0]) {
    const config = bazelTargetConfig(
      { kind: "test", line: 0, name: labels[0]!, path: [], bazelLabel: labels[0]!, bazelOperation: "test" },
      configs,
      c.root,
    );
    if (config) return launchProduced({ name: config.name, scope: "file", config }, false);
  }
  const config = bazelCommandConfig(c.root, coverage ? "coverage" : "test", labels, configs);
  if (!config) return;
  config.args.push("--color=no", "--curses=no", "--test_summary=detailed");
  if (!coverage) return launchProduced({ name: config.name, scope: "file", config }, false);
  const name = c.path.slice(c.path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
  config.params = { ...config.params, coverageName: name };
  const model = prepared.get(c.path)?.model;
  const hasJava = model?.targets?.some((target) =>
    labels.some((label) => {
      const name = localLabel(target.label);
      return label.endsWith("/...")
        ? name.startsWith(label.slice(0, -3)) || name.startsWith(label.slice(0, -4) + ":")
        : name === label;
    }),
  );
  if (hasJava) {
    const javaCoverage = await prepareBazelJavaCoverage(config, labels, configs);
    if (javaCoverage) return launchProduced({ name: config.name, scope: "file", config: javaCoverage }, false);
  }
  config.args.push("--combined_report=lcov", "--nocache_test_results");
  if (config.args[0] === "scripts/bazel.sh") {
    // The project wrapper forwards its selected JDK for test; coverage is test plus this Bazel flag.
    config.args[config.args.indexOf("coverage")] = "test";
    config.args.push("--collect_code_coverage");
  }
  config.params = { ...config.params, bazelCoverage: "lcov" };
  return launchProduced({ name: config.name, scope: "file", config }, false);
}

function targetItem(title: string, action: string, c: Context, labels: string[]): MenuItem {
  if (labels.length === 1) return { kind: "action", action, label: title, arg: { ...c, label: labels[0] } };
  return {
    label: title,
    submenu: labels.map((label) => ({ kind: "action", action, label, verbatim: true, arg: { ...c, label } })),
  };
}

export function bazelContextItems(ctx: MenuGroupContext): MenuItem[] {
  const c = context(ctx);
  if (!c) return [];
  const labels = owners(c);
  const tests = testLabels(c);
  return [
    ...(labels.length
      ? [
          targetItem(tx`Copy Target Label`, "bazel.copyTargetLabel", c, labels),
          targetItem(tx`Jump to BUILD file`, "bazel.jumpToBuildFile", c, labels),
        ]
      : []),
    ...(tests.length
      ? [
          { kind: "action" as const, action: "bazel.runAllTests", label: tx`Run all tests`, arg: c },
          {
            kind: "action" as const,
            action: "bazel.runAllTestsWithCoverage",
            label: tx`Run all tests with Coverage`,
            arg: c,
          },
        ]
      : []),
  ];
}

export function registerBazelContext(): () => void {
  const offActions = registerActions([
    {
      id: "bazel.copyTargetLabel",
      title: "Copy Target Label",
      category: "Bazel",
      when: "projectOpen",
      icon: "copy",
      run: ({ arg }) => targetAction(arg, (_c, label) => writeClipboardText(label)),
    },
    {
      id: "bazel.jumpToBuildFile",
      title: "Jump to BUILD file",
      category: "Bazel",
      when: "projectOpen",
      icon: "file",
      run: ({ arg }) => targetAction(arg, jump),
    },
    {
      id: "bazel.runAllTests",
      title: "Run all tests",
      category: "Bazel",
      when: "projectOpen",
      icon: "run",
      run: ({ arg }) => runAll(arg, false),
    },
    {
      id: "bazel.runAllTestsWithCoverage",
      title: "Run all tests with Coverage",
      category: "Bazel",
      when: "projectOpen",
      icon: "run-coverage",
      run: ({ arg }) => runAll(arg, true),
    },
  ]);
  const offMenus = registerMenuGroup({
    id: "run.bazel",
    order: 55,
    menus: ["editor", "editorTab", "projectView"],
    items: (_menu, ctx) => bazelContextItems(ctx),
    prepare: (_menu, ctx) => prepare(ctx),
  });
  return () => {
    offMenus();
    offActions();
    prepared.clear();
    modelCache = undefined;
  };
}
