"""Run Bazel JVM tests with JaCoCo, including vanilla Java toolchains."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import urllib.request
import uuid
import xml.etree.ElementTree as ET

VERSION = "0.8.16"
ARTIFACTS = {
    "agent": ("org.jacoco.agent", "runtime", "37ae2f374ad77e85c59c6e5b46565226c3ac3cb460ac19de0bcb844ac2f43e33"),
    "cli": ("org.jacoco.cli", "nodeps", "1f2a806225623fbd9f53d1ee0e42a6975323de0adebe01c12fc464ed147d756a"),
}


def artifact(kind):
    name, classifier, checksum = ARTIFACTS[kind]
    filename = f"{name}-{VERSION}-{classifier}.jar"
    cache = Path(__file__).parent / "jacoco" / VERSION
    cache.mkdir(parents=True, exist_ok=True)
    destination = cache / filename
    if destination.is_file() and hashlib.sha256(destination.read_bytes()).hexdigest() == checksum:
        return destination
    url = f"https://repo.maven.apache.org/maven2/org/jacoco/{name}/{VERSION}/{filename}"
    print(f"Downloading JaCoCo {VERSION} {kind}", flush=True)
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(2 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != checksum:
        raise ValueError(f"JaCoCo checksum mismatch: {filename}")
    with tempfile.NamedTemporaryFile(dir=cache, delete=False) as temporary:
        temporary.write(data)
        path = Path(temporary.name)
    os.replace(path, destination)
    return destination


def local_label(label):
    return re.sub(r"^@@?(?=//)", "", label)


def selected_records(model, labels):
    records = {local_label(record["label"]): record for record in model["targets"]}
    pending = []
    for label in labels:
        if label.endswith("/..."):
            prefix = label[:-3]
            pending.extend(name for name in records if name.startswith(prefix) or name.startswith(prefix.rstrip("/") + ":"))
        else:
            pending.append(label)
    selected = {}
    while pending:
        label = pending.pop()
        if label in selected or not label.startswith("//") or label not in records:
            continue
        record = records[label]
        selected[label] = record
        pending.extend(local_label(dep) for dep in record.get("dependencies", []))
    return list(selected.values())


def lcov(xml, records, root):
    sources = {}
    for record in records:
        for source in record.get("sources", []):
            path = root / source["path"]
            if not path.is_file() or path.suffix != ".java":
                continue
            package = re.search(r"^\s*package\s+([\w.]+)\s*;", path.read_text(), re.MULTILINE)
            key = (package[1].replace(".", "/") if package else "", path.name)
            sources[key] = path
    lines = []
    for package in ET.parse(xml).getroot().findall("package"):
        for source in package.findall("sourcefile"):
            path = sources.get((package.attrib["name"], source.attrib["name"]))
            if path is None:
                continue
            lines.append(f"SF:{path}")
            for line in source.findall("line"):
                lines.append(f"DA:{line.attrib['nr']},{int(int(line.attrib.get('ci', 0)) > 0)}")
                covered = int(line.attrib.get("cb", 0))
                missed = int(line.attrib.get("mb", 0))
                for branch in range(covered + missed):
                    lines.append(f"BRDA:{line.attrib['nr']},0,{branch},{int(branch < covered)}")
            lines.append("end_of_record")
    return "\n".join(lines) + "\n"


def main():
    request = json.loads(Path(sys.argv[1]).read_text())
    root = Path(request["root"])
    model = json.loads((root / ".openidea/bazel/java-sync/model.json").read_text())
    records = selected_records(model, request["labels"])
    if not records:
        raise ValueError("Java coverage needs the selected targets in the Java sync model")
    agent, cli = artifact("agent"), artifact("cli")
    output = root / ".openidea/bazel/coverage" / uuid.uuid4().hex
    output.mkdir(parents=True)
    data = output / "coverage.exec"
    if "," in str(agent) or "," in str(data):
        raise ValueError("JaCoCo agent paths cannot contain commas")
    command = [*request["launcher"], "test", *request["labels"],
               *request.get("options", []), "--nocache_test_results", "--color=no", "--curses=no", "--test_summary=detailed",
               "--strategy=TestRunner=local",
               f"--jvmopt=-javaagent:{agent}=destfile={data},append=true"]
    code = subprocess.run(command, cwd=root).returncode
    if code not in (0, 3):
        return code
    if not data.is_file():
        raise ValueError("The target JVM did not write JaCoCo execution data")
    jars = sorted({str(root / jar) for record in records for jar in record.get("output_jars", []) if (root / jar).is_file()})
    if not jars:
        raise ValueError("The selected Java targets have no class JARs")
    java = str(Path(model["java_home"]) / "bin/java")
    xml = output / "jacoco.xml"
    arguments = [java, "-jar", str(cli), "report", str(data), "--xml", str(xml)]
    for jar in jars:
        arguments.extend(["--classfiles", jar])
    subprocess.run(arguments, cwd=root, check=True)
    report = output / "_coverage_report.dat"
    report.write_text(lcov(xml, records, root))
    print(f"LCOV coverage report is located at {report}", flush=True)
    return code


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(f"Bazel Java coverage failed: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
