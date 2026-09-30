import { describe, expect, test } from "bun:test";
import {
  bashBucket,
  blockBucket,
  codexExecCalls,
  countSearches,
  isCodeEditTool,
  toolBucket,
} from "../src/buckets.ts";

describe("activity bucket classifier", () => {
  test("classifies fixed tool families", () => {
    expect(toolBucket("TodoWrite")).toBe("planning");
    expect(toolBucket("update_plan")).toBe("planning");
    expect(toolBucket("Edit")).toBe("code");
    expect(toolBucket("MultiEdit")).toBe("code");
    expect(toolBucket("apply_patch")).toBe("code");
    expect(toolBucket("Read")).toBe("context");
    expect(toolBucket("Task")).toBe("context");
    expect(toolBucket("mcp__github__search_issues")).toBe("context");
    expect(toolBucket("UnknownFutureTool")).toBe("context");
  });

  test("classifies Bash by command head and git subcommand", () => {
    expect(bashBucket("rg auth src")).toBe("context");
    expect(bashBucket("/bin/cat README.md")).toBe("context");
    expect(bashBucket("git status --short")).toBe("context");
    expect(bashBucket("git diff")).toBe("context");
    expect(bashBucket("git commit -m test")).toBe("code");
    expect(bashBucket("bun test")).toBe("code");
  });

  test("classifies compound shell commands by every statement, not the first word", () => {
    // Real read-only chains from a Claude Opus 5.5 session: all context.
    expect(bashBucket('cd $PWD; grep -n -i "sync\\|watch" src/cli.ts | head -80')).toBe("context");
    expect(bashBucket("cd $PWD; sed -n 160,190p src/cli.ts; sed -n 45,70p src/server.ts")).toBe(
      "context",
    );
    expect(
      bashBucket('cd "$PWD"; ls -la; cat .githooks/* scripts/*; git config --local --list'),
    ).toBe("context");
    expect(bashBucket("cd . && grep -n gpt-6 -r src | head -50; wc -l src/cost.ts")).toBe(
      "context",
    );
    expect(bashBucket("cd repo")).toBe("context");
    expect(bashBucket("git ls-files && git rev-parse HEAD")).toBe("context");
    // One mutating statement or stage makes the whole command code.
    expect(bashBucket("ls -la scripts/lib; cat README.md; ./scripts/install.sh")).toBe("code");
    expect(bashBucket("cd $PWD; git stash push src/cli.ts -q && bun test")).toBe("code");
    expect(bashBucket("cd $PWD; sed -i '' 's/a/b/' src/cli.ts; grep -n b src/cli.ts")).toBe("code");
    expect(bashBucket("git config --local core.hooksPath .githooks")).toBe("code");
    expect(bashBucket("cat src/a.ts | tee out.ts")).toBe("code");
    expect(bashBucket("python3 - <<'EOF'\np='src/cli.ts'\nEOF")).toBe("code");
  });

  test("treats output redirects to files as writes, but not descriptor or null redirects", () => {
    expect(bashBucket("cat > src/money.ts <<'EOF'\nexport const x = 1;\nEOF")).toBe("code");
    expect(bashBucket("echo hi >> notes.md")).toBe("code");
    expect(bashBucket("grep -rn foo src 2>&1 | head")).toBe("context");
    expect(bashBucket("cat package.json 2>/dev/null")).toBe("context");
    expect(bashBucket("ls missing &>/dev/null")).toBe("context");
  });

  test("classifies the script inside a shell wrapper", () => {
    expect(bashBucket('/bin/zsh -lc "rg auth src; sed -n 1,20p src/a.ts"')).toBe("context");
    expect(bashBucket("bash -lc 'bun test'")).toBe("code");
    expect(toolBucket("shell", JSON.stringify({ command: ["bash", "-lc", "cat a.ts"] }))).toBe(
      "context",
    );
  });

  test("extracts Bash command from JSON input", () => {
    expect(toolBucket("Bash", { command: "ls -la" })).toBe("context");
    expect(toolBucket("Bash", '{"command":"npm install"}')).toBe("code");
    expect(toolBucket("exec_command", JSON.stringify({ cmd: "cat docs/new.md" }))).toBe("context");
    expect(toolBucket("shell", JSON.stringify({ cmd: "bun test" }))).toBe("code");
    expect(toolBucket("functions.shell", JSON.stringify({ cmd: "git diff" }))).toBe("context");
    expect(toolBucket("local_shell", JSON.stringify(JSON.stringify({ cmd: "bun test" })))).toBe(
      "code",
    );
  });

  test("classifies transcript block families", () => {
    expect(blockBucket("thinking")).toBe("planning");
    expect(blockBucket("text")).toBe("communicating");
    expect(blockBucket("tool_use", "Write")).toBe("code");
    expect(blockBucket("tool_result", "Read")).toBe("context");
  });

  test("isCodeEditTool: structured edit tools", () => {
    for (const t of ["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]) {
      expect(isCodeEditTool(t)).toBe(true);
    }
    expect(isCodeEditTool("Read")).toBe(false);
    expect(isCodeEditTool("Bash")).toBe(false); // no command -> not an edit
  });

  test("isCodeEditTool: shell commands that mutate a file count as edits", () => {
    const edits = [
      "git apply /tmp/pr.diff",
      "sed -i 's/a/b/' src/x.ts",
      "patch -p1 < /tmp/x.patch",
      'node -e \'require("fs").writeFileSync("a.ts", body)\'',
      "python3 -c \"open('a.py','w').write(x)\"",
    ];
    for (const cmd of edits) {
      expect(isCodeEditTool("Bash", { command: cmd })).toBe(true);
      expect(isCodeEditTool("shell", JSON.stringify({ command: cmd }))).toBe(true);
    }
  });

  test("isCodeEditTool: read-only / benign shell is NOT an edit", () => {
    const benign = [
      "git apply --check /tmp/pr.diff",
      "grep -rn foo src",
      "cat package.json",
      "echo hi > /dev/null",
      "yarn build > /tmp/build.log",
      "git diff --stat",
    ];
    for (const cmd of benign) {
      expect(isCodeEditTool("Bash", { command: cmd })).toBe(false);
    }
  });

  describe("search counting", () => {
    test("countSearches: structured search tools count once", () => {
      expect(countSearches("Grep", null)).toBe(1);
      expect(countSearches("Glob", null)).toBe(1);
      expect(countSearches("Read", null)).toBe(0);
    });

    test("countSearches: shell command heads count as searches", () => {
      expect(countSearches("Bash", '{"command":"rg auth src"}')).toBe(1);
      expect(countSearches("Bash", '{"command":"/usr/bin/grep -rn foo"}')).toBe(1);
      expect(countSearches("exec_command", '"{\\"cmd\\":\\"rg TODO\\"}"')).toBe(1);
      expect(countSearches("Bash", '{"command":"cat README.md"}')).toBe(0);
      expect(countSearches("Bash", '{"command":"git grep -n foo"}')).toBe(1);
    });

    test("countSearches: compound statements count each search", () => {
      expect(countSearches("Bash", '{"command":"grep -n a src; echo ---; grep -n b src"}')).toBe(2);
      expect(countSearches("Bash", '{"command":"cd src && rg handler"}')).toBe(1);
    });

    test("countSearches: pipeline filters do not count", () => {
      expect(countSearches("Bash", '{"command":"ps aux | grep node"}')).toBe(0);
      expect(countSearches("Bash", '{"command":"rg foo src | head -20"}')).toBe(1);
    });

    test("countSearches: MCP tools named like shells do not count", () => {
      // "exec" has no dot, so localToolName would leave it unchanged anyway --
      // this line returns 0 with or without the mcp__ guard. The dotted case
      // below is the one that actually exercises the guard: localToolName
      // would flatten it to "shell" (a SHELL_TOOLS name) if the mcp__ check
      // didn't short-circuit first. Don't drop the dotted case as redundant.
      expect(countSearches("mcp__posthog__exec", '{"command":"rg foo"}')).toBe(0);
      expect(countSearches("mcp__codex_apps__x.shell", '{"command":"rg foo"}')).toBe(0);
    });
  });
});

describe("Codex exec programs", () => {
  // Codex stores the custom tool's JavaScript program as a JSON-encoded string.
  const exec = (program: string) => JSON.stringify(program);
  const read = exec(
    'text(await tools.exec_command({cmd:"rg --files -g AGENTS.md","max_output_tokens":2000}));',
  );
  const patch = exec(
    'const patch = "*** Begin Patch\\n*** Update File: calc.py\\n*** End Patch";\ntext(await tools.apply_patch(patch));',
  );
  const test_ = exec("text(await tools.exec_command({cmd:'bun test test/cost.test.ts'}));");
  const plan = exec('await tools.update_plan({plan:[{step:"a",status:"in_progress"}]});');
  const mixed = exec(
    'text(await tools.exec_command({cmd:"cat calc.py"}));\ntext(await tools.apply_patch(p));',
  );

  test("extracts inner calls and literal shell commands", () => {
    expect(codexExecCalls("exec", read)).toEqual([
      { name: "exec_command", command: "rg --files -g AGENTS.md" },
    ]);
    expect(codexExecCalls("exec", test_)).toEqual([
      { name: "exec_command", command: "bun test test/cost.test.ts" },
    ]);
    expect(codexExecCalls("exec", exec("await tools.exec_command({cmd: command});"))).toEqual([
      { name: "exec_command", command: null },
    ]);
    expect(codexExecCalls("exec", exec("const x = 1;"))).toEqual([]);
    expect(codexExecCalls("Bash", read)).toEqual([]);
  });

  test("buckets each program by its inner calls instead of defaulting to context", () => {
    expect(toolBucket("exec", read)).toBe("context");
    expect(toolBucket("exec", patch)).toBe("code");
    expect(toolBucket("exec", test_)).toBe("code");
    expect(toolBucket("exec", plan)).toBe("planning");
    expect(toolBucket("exec", exec("await tools.mcp__exa__web_search_exa({query:'x'});"))).toBe(
      "context",
    );
    expect(toolBucket("exec", exec("const x = 1;"))).toBe("context");
  });

  test("a program that reads and patches counts as code", () => {
    expect(toolBucket("exec", mixed)).toBe("code");
    expect(blockBucket("tool_use", "exec", mixed)).toBe("code");
  });

  test("apply_patch inside exec marks the first edit", () => {
    expect(isCodeEditTool("exec", patch)).toBe(true);
    expect(
      isCodeEditTool("exec", exec('await tools.exec_command({cmd:"sed -i s/a/b/ f.py"});')),
    ).toBe(true);
    expect(isCodeEditTool("exec", read)).toBe(false);
  });

  test("shell searches inside exec count toward discovery", () => {
    expect(countSearches("exec", read)).toBe(1);
    expect(
      countSearches("exec", exec('await tools.exec_command({cmd:"rg a; grep -n b src"});')),
    ).toBe(2);
    expect(countSearches("exec", patch)).toBe(0);
  });

  test("an MCP tool named exec is not treated as a Codex program", () => {
    expect(toolBucket("mcp__posthog__exec", patch)).toBe("context");
    expect(isCodeEditTool("mcp__posthog__exec", patch)).toBe(false);
    expect(countSearches("mcp__posthog__exec", read)).toBe(0);
  });
});

describe("Gemini CLI tool names", () => {
  test("classify shell, edit, and plan tools like their Claude and Codex peers", () => {
    expect(toolBucket("run_shell_command", { command: "cargo test --workspace" })).toBe("code");
    expect(toolBucket("run_shell_command", '{"command":"ls src","description":"List"}')).toBe(
      "context",
    );
    expect(toolBucket("write_file")).toBe("code");
    expect(toolBucket("replace")).toBe("code");
    expect(toolBucket("write_todos")).toBe("planning");
    expect(toolBucket("read_file")).toBe("context");
    expect(isCodeEditTool("replace")).toBe(true);
    expect(isCodeEditTool("run_shell_command", { command: "sed -i '' s/a/b/ src/x.ts" })).toBe(
      true,
    );
  });
});
