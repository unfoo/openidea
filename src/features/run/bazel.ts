import type { RunConfig } from "@/platform/ipc";

/** The Bazel plugin's ConsoleLauncher helper carries source ownership from JavaInfo. */
export function isBazelJUnit(config: RunConfig): boolean {
  return (
    config.id.startsWith("plugin:unfoo.bazel:") &&
    config.isTest &&
    config.args.some((arg) => /(?:^|[\\/])test_runner\.sh$/.test(arg))
  );
}

export function bazelTestBases(path: string, configs: readonly RunConfig[]): RunConfig[] {
  return configs.filter((config) => {
    if (!isBazelJUnit(config)) return false;
    for (let i = 0; i + 1 < config.args.length; i++) {
      if (config.args[i] !== "--source-list") continue;
      try {
        const sources: unknown = JSON.parse(config.args[++i]!);
        if (Array.isArray(sources) && sources.includes(path)) return true;
      } catch {
        /* Invalid metadata cannot associate a file with a test. */
      }
    }
    return false;
  });
}

export function bazelTestConfig(base: RunConfig, className?: string, method?: string): RunConfig {
  const args: string[] = [];
  for (let i = 0; i < base.args.length; i++) {
    if (base.args[i] === "--class" || base.args[i] === "--method") {
      i++;
      continue;
    }
    args.push(base.args[i]!);
  }
  if (className && base.args.includes("--method-filter"))
    args.push(method ? "--method" : "--class", method ? `${className}#${method}` : className);
  const rootIndex = args.indexOf("--root");
  return {
    ...base,
    cwd: rootIndex < 0 ? base.cwd : (args[rootIndex + 1] ?? base.cwd),
    args,
    params: { ...base.params, contextSource: "bazel" },
    name: base.args.includes("--method-filter") ? (method ?? className ?? base.name) : base.name,
  };
}
