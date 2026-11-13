import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import helper from "./bazelJavaCoverage.py?raw";

const python = spawnSync("python3", ["--version"]);
it.skipIf(python.error != null)(
  "maps the selected Java dependency closure and real JaCoCo lines to source paths",
  () => {
    const checks = String.raw`
import sys, tempfile
from pathlib import Path
scope = {"__name__": "coverage_tests"}
exec(compile(sys.stdin.read(), "bazelJavaCoverage.py", "exec"), scope)
model = {"targets": [
 {"label": "@@//pkg:spec", "dependencies": ["@@//pkg:lib", "@@other//:external"]},
 {"label": "@@//pkg:lib", "dependencies": ["@@//pkg:spec"]},
 {"label": "@@//other:ignored", "dependencies": []},
]}
assert {r["label"] for r in scope["selected_records"](model, ["//pkg:spec"])} == {"@@//pkg:spec", "@@//pkg:lib"}
assert len(scope["selected_records"](model, ["//pkg/..."])) == 2
with tempfile.TemporaryDirectory() as directory:
 root = Path(directory)
 source = root / "src/main/java/p/Hello.java"
 source.parent.mkdir(parents=True)
 source.write_text("package p;\nclass Hello {}")
 xml = root / "jacoco.xml"
 xml.write_text('<report><package name="p"><sourcefile name="Hello.java"><line nr="4" mi="2" ci="3" mb="1" cb="1"/><line nr="5" mi="1" ci="0" mb="0" cb="0"/></sourcefile></package></report>')
 result = scope["lcov"](xml, [{"sources": [{"path": "src/main/java/p/Hello.java"}]}], root)
 assert f"SF:{source}\n" in result
 assert "DA:4,1\n" in result
 assert "DA:5,0\n" in result
 assert "BRDA:4,0,0,1\nBRDA:4,0,1,0\n" in result
 assert result.endswith("end_of_record\n")
`;
    const result = spawnSync("python3", ["-c", checks], { input: helper, encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  },
);
