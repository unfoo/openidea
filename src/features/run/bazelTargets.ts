import { parser } from "@lezer/python";
import type { RunConfig } from "@/platform/ipc";
import type { RunTarget } from "./targets";

export function isBazelBuild(path: string): boolean {
  return /(?:^|\/)BUILD(?:\.bazel)?$/.test(path);
}

/** Only literal names of top-level rule calls, never examples in comments or nested attributes. */
export function bazelTargets(text: string, path: string): RunTarget[] {
  const out: RunTarget[] = [];
  const pkg = path.replace(/(?:^|\/)BUILD(?:\.bazel)?$/, "");
  const tree = parser.parse(text);
  for (let statement = tree.topNode.firstChild; statement; statement = statement.nextSibling) {
    if (statement.name !== "ExpressionStatement") continue;
    const call = statement.firstChild;
    if (call?.name !== "CallExpression") continue;
    const callee = call.firstChild;
    const rule = callee && text.slice(callee.from, callee.to);
    if (!rule || !/^[\w.]+$/.test(rule) || /^(load|package|exports_files)$/.test(rule)) continue;
    const args = call.getChild("ArgList");
    for (let arg = args?.firstChild; arg; arg = arg.nextSibling) {
      if (arg.name !== "VariableName" || text.slice(arg.from, arg.to) !== "name") continue;
      const op = arg.nextSibling;
      const value = op?.nextSibling;
      if (op?.name !== "AssignOp" || value?.name !== "String") continue;
      if (![",", ")"].includes(value.nextSibling?.name ?? "")) continue;
      const literal = text.slice(value.from, value.to);
      const match = /^(["'])([^"'\\\n]+)\1$/.exec(literal);
      if (!match || !/^[\w.\-/+@=,~]+$/.test(match[2]!)) continue;
      const name = match[2]!;
      const label = `//${pkg}:${name}`;
      out.push({
        line: text.slice(0, call.from).split("\n").length - 1,
        endLine: text.slice(0, call.to).split("\n").length - 1,
        kind: /(?:^|_)test$/.test(rule) ? "test" : "main",
        name: label,
        path: [label],
        bazelLabel: label,
        bazelOperation: /(?:^|_)test$/.test(rule) ? "test" : /(?:^|_)binary$/.test(rule) ? "run" : "build",
      });
      break;
    }
  }
  return out;
}

/** Reuse a provider-owned launcher, retaining its identity and explicit executable grant. */
export function bazelTargetConfig(target: RunTarget, configs: readonly RunConfig[], root: string): RunConfig | null {
  const label = target.bazelLabel;
  if (!label) return null;
  const owned = configs.filter((c) => c.id.startsWith("plugin:unfoo.bazel:"));
  const matches = owned.filter((c) => c.args.includes(label));
  const test = matches.find((c) => c.isTest);
  const preferred =
    test ?? matches.find((c) => c.args.includes("run")) ?? matches.find((c) => c.args.includes("build"));
  if (preferred) return { ...preferred, cwd: root };
  const base = owned.find((c) => c.args.includes("build") && c.args.some((a) => a.startsWith("//")));
  if (!base) return null;
  const args = [...base.args];
  const verb = args.indexOf("build");
  const operand = args.findIndex((a, i) => i > verb && a.startsWith("//"));
  if (operand < 0) return null;
  args[verb] = target.bazelOperation ?? "build";
  args[operand] = label;
  return {
    ...base,
    cwd: root,
    args,
    name: `Bazel ${args[verb]} ${label}`,
    isTest: args[verb] === "test",
    params: { ...base.params, contextSource: "bazel" },
  };
}
