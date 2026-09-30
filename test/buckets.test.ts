import { describe, expect, test } from "bun:test";
import {
  bashBucket,
  blockBucket,
  codexExecCalls,
  countSearches,
  isCodeEditTool,
  isUserQuestionTool,
  toolBucket,
} from "../src/buckets.ts";
import type { Json } from "../src/model.ts";

describe("activity bucket classifier", () => {
  test("classifies fixed tool families", () => {
    expect(toolBucket("TodoWrite")).toBe("planning");
    expect(toolBucket("update_plan")).toBe("planning");
    expect(toolBucket("Edit")).toBe("code");
    expect(toolBucket("MultiEdit")).toBe("code");
    expect(toolBucket("apply_patch")).toBe("code");
    expect(toolBucket("Read")).toBe("context");
    expect(toolBucket("Task")).toBe("context");
    expect(toolBucket("TaskCreate")).toBe("planning");
    expect(toolBucket("TaskUpdate")).toBe("planning");
    expect(toolBucket("TaskStop")).toBe("context");
    expect(toolBucket("write_stdin")).toBe("code");
    expect(isCodeEditTool("write_stdin")).toBe(false);
    expect(toolBucket("mcp__github__search_issues")).toBe("context");
    expect(toolBucket("UnknownFutureTool")).toBe("context");
  });

  test("splits browser, desktop, and REPL tools into reads and actions", () => {
    for (const read of [
      "mcp__playwright__browser_snapshot",
      "mcp__playwright__browser_take_screenshot",
      "mcp__playwright__browser_navigate",
      "mcp__playwright__browser_console_messages",
      "mcp__playwright__browser_network_requests",
      "mcp__playwright__browser_tabs",
      "mcp__playwright__browser_wait_for",
      "mcp__playwright____browser_snapshot",
      "mcp__plugin_playwright_playwright__browser_take_screenshot",
      "mcp__claude-in-chrome__read_page",
      "mcp__claude-in-chrome__get_page_text",
      "mcp__claude-in-chrome__find",
      "mcp__claude-in-chrome__navigate",
      "mcp__claude-in-chrome__tabs_context_mcp",
      "mcp__claude-in-chrome__read_console_messages",
      "mcp__computer-use__screenshot",
      "mcp__computer-use__zoom",
      "mcp__computer-use__wait",
      "mcp__computer_use____get_app_state",
    ]) {
      expect(toolBucket(read)).toBe("context");
    }
    for (const action of [
      "mcp__playwright__browser_click",
      "mcp__playwright__browser_type",
      "mcp__playwright__browser_fill_form",
      "mcp__playwright__browser_press_key",
      "mcp__playwright__browser_hover",
      "mcp__playwright__browser_evaluate",
      "mcp__playwright__browser_run_code_unsafe",
      "mcp__playwright__browser_resize",
      "mcp__playwright__browser_handle_dialog",
      "mcp__playwright____browser_click",
      "mcp__plugin_playwright_playwright__browser_evaluate",
      "mcp__claude-in-chrome__form_input",
      "mcp__claude-in-chrome__file_upload",
      "mcp__claude-in-chrome__javascript_tool",
      "mcp__claude-in-chrome__resize_window",
      "mcp__computer-use__left_click",
      "mcp__computer-use__left_click_drag",
      "mcp__computer-use__type",
      "mcp__computer-use__key",
      "mcp__computer-use__scroll",
      "mcp__computer-use__mouse_move",
      "mcp__computer-use__open_application",
      "mcp__computer_use____click",
      "mcp__repl__js",
      "mcp__node_repl__js",
    ]) {
      expect(toolBucket(action)).toBe("code");
    }
    // Multi-action tools are judged by the actions they carry.
    const chrome = "mcp__claude-in-chrome__computer";
    expect(toolBucket(chrome, { action: "screenshot" })).toBe("context");
    expect(toolBucket(chrome, JSON.stringify({ action: "left_click" }))).toBe("code");
    const batch = "mcp__claude-in-chrome__browser_batch";
    const step = (name: string, input: Json) => ({ name, input });
    expect(
      toolBucket(batch, {
        actions: [
          step("navigate", { url: "https://example.com" }),
          step("computer", { action: "wait" }),
        ],
      }),
    ).toBe("context");
    expect(
      toolBucket(batch, {
        actions: [
          step("navigate", { url: "https://example.com" }),
          step("computer", { action: "type" }),
        ],
      }),
    ).toBe("code");
    const desktop = "mcp__computer-use__computer_batch";
    expect(toolBucket(desktop, { actions: [{ action: "screenshot" }, { action: "zoom" }] })).toBe(
      "context",
    );
    expect(toolBucket(desktop, { actions: [{ action: "screenshot" }, { action: "scroll" }] })).toBe(
      "code",
    );
    // Other MCP tools keep the context default, and no UI action is a file edit.
    expect(toolBucket("mcp__exa__web_search_exa")).toBe("context");
    expect(toolBucket("mcp__excalidraw__take_screenshot")).toBe("context");
    expect(isCodeEditTool("mcp__playwright__browser_click")).toBe(false);
  });

  test("keeps agent orchestration in context", () => {
    for (const tool of [
      "Agent",
      "Task",
      "SendMessage",
      "SubagentHandback",
      "collaboration__send_message",
      "collaboration__spawn_agent",
    ]) {
      expect(toolBucket(tool)).toBe("context");
    }
  });

  test("recognizes every spelling of a question to the user", () => {
    for (const tool of [
      "AskUserQuestion",
      "mcp__example__AskUserQuestion",
      "request_user_input",
      "request_user_input_async",
      "functions.request_user_input",
    ]) {
      expect(isUserQuestionTool(tool)).toBe(true);
    }
    expect(isUserQuestionTool("SendMessage")).toBe(false);
    expect(isUserQuestionTool("mcp__docs__ask")).toBe(false);
    // A Codex exec program counts only when all it does is ask.
    const ask = JSON.stringify("await tools.request_user_input({questions:[]});");
    const askAndRead = JSON.stringify(
      'await tools.request_user_input({questions:[]}); text(await tools.exec_command({cmd:"ls"}));',
    );
    expect(isUserQuestionTool("exec", ask)).toBe(true);
    expect(toolBucket("exec", ask)).toBe("communicating");
    expect(isUserQuestionTool("exec", askAndRead)).toBe(false);
  });

  test("files questions to the user as communicating and note writes as code", () => {
    expect(toolBucket("AskUserQuestion")).toBe("communicating");
    expect(toolBucket("request_user_input")).toBe("communicating");
    expect(toolBucket("request_user_input_async")).toBe("communicating");
    expect(toolBucket("mcp__example__AskUserQuestion")).toBe("communicating");
    for (const tool of [
      "notes__write_file",
      "notes__append_to_file",
      "mcp__obsidian__obsidian_append_content",
      "mcp__dosu__write_knowledge",
    ]) {
      expect(toolBucket(tool)).toBe("code");
      // A note is the agent's memory, not the work product: no first edit.
      expect(isCodeEditTool(tool)).toBe(false);
    }
    expect(toolBucket("notes__read_file")).toBe("context");
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
    expect(bashBucket("cd $PWD; git stash list; git status --short")).toBe("context");
    expect(bashBucket("git stash push src/cli.ts")).toBe("code");
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

  test("reads through git globals and read-only gh, kubectl, docker, and curl calls", () => {
    expect(bashBucket("git -C ../repo log --oneline -3")).toBe("context");
    expect(bashBucket("git --no-pager diff --stat")).toBe("context");
    expect(bashBucket("git -C ../repo commit -m x")).toBe("code");
    expect(bashBucket("git merge-base --is-ancestor main HEAD; git ls-remote origin")).toBe(
      "context",
    );
    expect(bashBucket("git branch -a")).toBe("context");
    expect(bashBucket("git branch --contains abc123")).toBe("context");
    expect(bashBucket("git branch -D old")).toBe("code");
    expect(bashBucket("git branch -f main origin/main")).toBe("code");
    expect(bashBucket("git branch feature")).toBe("code");
    expect(bashBucket("git remote -v")).toBe("context");
    expect(bashBucket("git remote add origin git@example.com:a/b.git")).toBe("code");
    expect(bashBucket("git config core.hooksPath")).toBe("context");
    expect(bashBucket("git diff --output=patch.diff")).toBe("code");

    expect(bashBucket("gh pr view 12 --json state")).toBe("context");
    expect(bashBucket("gh pr checks 12")).toBe("context");
    // Waiting on CI or a build is charged to the work being waited on.
    expect(bashBucket("gh pr checks 12 --watch")).toBe("code");
    expect(bashBucket("gh run view 99 --log | rg error")).toBe("context");
    expect(bashBucket("gh api repos/o/r/pulls --jq '.[].number'")).toBe("context");
    expect(bashBucket("gh api -X GET search/issues -f q=bug")).toBe("context");
    expect(bashBucket("gh api graphql -f query='{ viewer { login } }'")).toBe("context");
    expect(bashBucket("gh api graphql -f query='mutation { x }'")).toBe("code");
    expect(bashBucket("gh api repos/o/r/issues -f title=x")).toBe("code");
    expect(bashBucket("gh api -X DELETE repos/o/r/git/refs/heads/x")).toBe("code");
    expect(bashBucket("gh pr merge 12 --squash")).toBe("code");
    expect(bashBucket("gh auth switch --user bot")).toBe("code");

    expect(bashBucket("kubectl --context prod -n app get pods -o wide")).toBe("context");
    expect(bashBucket("kubectl rollout status deploy/api")).toBe("context");
    expect(bashBucket("kubectl --context prod apply -f k8s/")).toBe("code");
    expect(bashBucket("kubectl rollout restart deploy/api")).toBe("code");
    expect(bashBucket("docker compose -f dev.yml logs api --since 3m")).toBe("context");
    expect(bashBucket("docker image inspect app:dev")).toBe("context");
    expect(bashBucket("docker compose exec -T api sh -c 'ls /config'")).toBe("code");
    expect(bashBucket("docker compose up -d")).toBe("code");

    expect(bashBucket("curl -sS https://example.com/api/status | jq .")).toBe("context");
    expect(bashBucket("curl -s -o /dev/null -w '%{http_code}' https://example.com")).toBe(
      "context",
    );
    expect(bashBucket("curl -sL https://example.com/a.tgz -o a.tgz")).toBe("code");
    expect(bashBucket("curl -fsSLO https://example.com/a.tgz")).toBe("code");
    expect(bashBucket("curl -X POST https://example.com/hook -d '{}'")).toBe("code");
    // Probing a local dev server verifies the work, like running its tests.
    expect(bashBucket("curl -s http://localhost:3000/health")).toBe("code");
  });

  test("classifies the command behind assignments, wrappers, loops, and waits", () => {
    expect(bashBucket('DIR="$PWD/out"; ls -la "$DIR"')).toBe("context");
    expect(bashBucket("W=.worktrees/a; git -C $W status --short")).toBe("context");
    expect(bashBucket('GH_TOKEN="$(gh auth token --user bot)" gh pr checks 7')).toBe("context");
    expect(bashBucket("URL=$(gh pr view 7 --json url --jq .url); echo $URL")).toBe("context");
    expect(bashBucket("X=$(rm -rf build); echo $X")).toBe("code");
    expect(bashBucket("env GIT_TRACE=1 git push origin main")).toBe("code");
    expect(bashBucket("env NODE_OPTIONS=--max-old-space-size=4096 pnpm test")).toBe("code");
    expect(bashBucket('for f in src/*.ts; do echo "== $f"; head -5 "$f"; done')).toBe("context");
    expect(bashBucket('for f in src/*.ts; do rm "$f"; done')).toBe("code");
    expect(bashBucket("until grep -q DONE build.log; do sleep 5; done; tail -3 build.log")).toBe(
      "code",
    );
    expect(bashBucket("if [ -f a.txt ]; then cat a.txt; fi")).toBe("context");
    expect(bashBucket("sleep 30; git status --short")).toBe("code");
    expect(bashBucket("timeout 60 bun test")).toBe("code");
    expect(bashBucket("ls src | xargs -n1 basename")).toBe("context");
    expect(bashBucket("git ls-files '*.tmp' | xargs rm")).toBe("code");
    expect(bashBucket("(cd sub && grep -rn TODO .)")).toBe("context");
    expect(bashBucket("command -v bun; node --version; npx playwright --help")).toBe("context");
    expect(bashBucket('dirs=(src tests docs); ls "$dirs"')).toBe("context");
  });

  test("keeps find, sort, awk, and sqlite3 in context only when they only read", () => {
    expect(bashBucket("find . -name '*.ts' -exec cat {} \\; ; wc -l a.ts")).toBe("context");
    expect(bashBucket("find . -name '*.orig' -delete")).toBe("code");
    expect(bashBucket("find . -name '*.bak' -exec rm {} +")).toBe("code");
    expect(bashBucket("sort -u names.txt")).toBe("context");
    expect(bashBucket("sort -o names.txt names.txt")).toBe("code");
    expect(bashBucket("awk '{print $1}' access.log | sort | uniq -c")).toBe("context");
    expect(bashBucket(`awk '{print > "out.txt"}' in.txt`)).toBe("code");
    expect(bashBucket(`awk '{system("rm " $1)}' list.txt`)).toBe("code");
    expect(bashBucket("sqlite3 -readonly app.db 'select count(*) from t'")).toBe("context");
    expect(bashBucket("sqlite3 app.db 'delete from t'")).toBe("code");
    expect(bashBucket("ps aux | grep '[n]ode'; lsof -i :3000; date")).toBe("context");
  });

  test("skips heredoc bodies but still judges the command that reads them", () => {
    expect(bashBucket("cat <<'EOF'\nmake build\nEOF")).toBe("context");
    expect(bashBucket("python3 - <<'EOF'\nprint(1)\nEOF")).toBe("code");
    expect(bashBucket("cat > notes.md <<'EOF'\nhello\nEOF")).toBe("code");
    expect(bashBucket("git commit -F - <<'EOF'\nfix: x\nEOF")).toBe("code");
    // An unterminated heredoc keeps its lines, so a later write still counts.
    expect(bashBucket("cat <<EOF\nnotes\nrm -rf build")).toBe("code");
  });

  test("classifies the script inside a shell wrapper", () => {
    expect(bashBucket('/bin/zsh -lc "rg auth src; sed -n 1,20p src/a.ts"')).toBe("context");
    expect(bashBucket("bash -lc 'bun test'")).toBe("code");
    expect(toolBucket("shell", JSON.stringify({ command: ["bash", "-lc", "cat a.ts"] }))).toBe(
      "context",
    );
    // Each wrapper is its own stage; a quoted script ends at its closing quote.
    expect(bashBucket('bash -lc "cat a"; bash -lc "rm b"')).toBe("code");
    expect(bashBucket("bash -c 'grep x f' | sh -c 'rm y'")).toBe("code");
    expect(bashBucket("bash -c 'rm -rf dist' --help")).toBe("code");
    expect(bashBucket(`sh -c 'cat "$1"' _ a.txt`)).toBe("context");
    expect(bashBucket("ls | xargs -I{} sh -c 'rm {}'")).toBe("code");
  });

  test("counts every file redirect and background job", () => {
    expect(bashBucket("echo x 1>out.txt")).toBe("code");
    expect(bashBucket("bun build 2>errors.log; cat errors.log")).toBe("code");
    expect(bashBucket("echo x >&out.log")).toBe("code");
    expect(bashBucket("cat <>f")).toBe("code");
    expect(bashBucket("echo x 2>/dev/null >&2; ls 2>&1 | head")).toBe("context");
    expect(bashBucket("echo x >/dev/stderr")).toBe("context");
    expect(bashBucket("echo x >1")).toBe("code");
    expect(bashBucket('n=$((x>5 ? x-5 : 1)); sed -n "$n,+5p" f')).toBe("context");
    expect(bashBucket('echo \\" > f \\"')).toBe("code");
    // `&` ends a statement, so a job after a backgrounded read still decides.
    expect(bashBucket("tail -f app.log & npm start")).toBe("code");
    expect(bashBucket("cat a & rm -rf build")).toBe("code");
    expect(bashBucket("tail -f app.log &")).toBe("context");
    expect(bashBucket("echo $(( $(rm -f x; echo 1) + 1 ))")).toBe("code");
    expect(bashBucket("command env rm x")).toBe("code");
  });

  test("keeps read-looking commands in code when their arguments write", () => {
    expect(bashBucket("sqlite3 -readonly app.db \"VACUUM INTO 'snap.db'\"")).toBe("code");
    expect(bashBucket("sqlite3 -readonly app.db '.output out.txt' 'select 1'")).toBe("code");
    expect(bashBucket("sqlite3 -readonly app.db '.shell rm x'")).toBe("code");
    expect(bashBucket("sqlite3 -readonly app.db <<EOF\n.output out.txt\nselect 1;\nEOF")).toBe(
      "code",
    );
    expect(bashBucket("sqlite3 -readonly -json app.db 'select 1'")).toBe("context");
    expect(bashBucket("sed -n '/x/w out.txt' f")).toBe("code");
    expect(bashBucket("sed 's/a/b/w out.txt' f")).toBe("code");
    expect(bashBucket("sed '1e rm -rf x' f")).toBe("code");
    expect(bashBucket("sed 's/.*/date/e' f")).toBe("code");
    expect(bashBucket("sed -n '/^def test_a/,/^def test_b/p' t.py")).toBe("context");
    expect(bashBucket("sed -n '1,40p' f; sed 's/wow/w/g' f; sed -e 's/a/b/' -e '/q/d' f")).toBe(
      "context",
    );
    expect(bashBucket("git branch --set-upstream-to=origin/main")).toBe("code");
    expect(bashBucket("git branch -uorigin/main")).toBe("code");
    expect(bashBucket("git branch --merged | xargs git branch -rd")).toBe("code");
    expect(bashBucket("git tag -fa v1")).toBe("code");
    expect(bashBucket("git config edit")).toBe("code");
    expect(bashBucket("git config get user.name; git branch -vv; git tag -n")).toBe("context");
    expect(bashBucket("aws s3api get-object --bucket b --key k out.bin")).toBe("code");
    expect(bashBucket("aws s3api head-object --bucket b --key k")).toBe("context");
    expect(bashBucket("docker --log-level info rm -f x")).toBe("code");
    expect(bashBucket("docker compose config -o out.yml")).toBe("code");
    expect(bashBucket("kubectl cluster-info dump --output-directory=d")).toBe("code");
    expect(bashBucket("curl -K cfg https://example.com")).toBe("code");
    expect(bashBucket("curl --libcurl out.c https://example.com")).toBe("code");
    expect(bashBucket("curl -w '%output{f}' https://example.com")).toBe("code");
    expect(bashBucket(`awk '{cmd="sh"; print "rm x" | cmd}' f`)).toBe("code");
    expect(bashBucket(`awk '{print "rm x" |& "sh"}' f`)).toBe("code");
    expect(bashBucket(`awk '$1 == "a" || $2 == "b"' f`)).toBe("context");
    expect(bashBucket(`awk -F'|' '{printf "%s |%s\\n", $2, $5}' f`)).toBe("context");
    expect(bashBucket(`awk "{print > \\"out\\"}" f`)).toBe("code");
    expect(bashBucket("fd -e tmp -x rm; fd -e tmp --exec-batch rm")).toBe("code");
    expect(bashBucket("fd -e ts -x wc -l")).toBe("context");
    expect(bashBucket("rg --pre ./x.sh pat")).toBe("code");
    expect(bashBucket("tree -o tree.txt")).toBe("code");
    expect(bashBucket("uniq in.txt out.txt")).toBe("code");
    expect(bashBucket("uniq -c in.txt")).toBe("context");
    // A bare `version` subcommand bumps versions in some tools.
    expect(bashBucket("changeset version")).toBe("code");
    expect(bashBucket("yarn version")).toBe("code");
  });

  test("stays fast and total on pathological commands", () => {
    const nested = `echo ${"$(echo ".repeat(20_000)}x${")".repeat(20_000)}`;
    const started = performance.now();
    expect(bashBucket(nested)).toBe("code");
    expect(bashBucket(`echo ${"$(".repeat(50_000)}`)).toBe("code");
    expect(bashBucket(`diff ${"<(cat ".repeat(20_000)}${")".repeat(20_000)}`)).toBe("code");
    expect(bashBucket(`grep "${'a\\"'.repeat(100_000)}`)).toBe("context");
    // Long unquoted text splits in linear time.
    expect(bashBucket(`echo ${"word ".repeat(100_000)}`)).toBe("context");
    expect(bashBucket(`cat ${"a".repeat(200_000)}`)).toBe("context");
    expect(countSearches("Bash", JSON.stringify({ command: `rg ${"x ".repeat(100_000)}` }))).toBe(
      1,
    );
    expect(performance.now() - started).toBeLessThan(1_000);
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
      // Searches for edit markers are reads, not edits.
      "rg -n writeFileSync src",
      'grep -rn "git apply" docs',
      "sed -n 1,20p a.ts; grep -i todo a.ts",
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

    test("countSearches: finds the search behind assignments, wrappers, and git globals", () => {
      const count = (command: string) => countSearches("Bash", JSON.stringify({ command }));
      expect(count("X=1 rg auth src")).toBe(1);
      expect(count("timeout 5 rg auth src")).toBe(1);
      expect(count('bash -lc "rg auth src; grep -rn b lib"')).toBe(2);
      expect(count('cd repo && bash -lc "rg auth"')).toBe(1);
      expect(count("git -C ../repo grep -n auth")).toBe(1);
      expect(count("git --no-pager grep -n auth")).toBe(1);
      // Separators inside quotes are part of the pattern, not new statements.
      expect(count("rg 'a;b' src")).toBe(1);
      expect(count('grep -n "x && y" f')).toBe(1);
      expect(count("cat <<'EOF'\nrg inside a heredoc\nEOF")).toBe(0);
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
  test("ignores quoted and commented tool examples without inventing edits or searches", () => {
    const program = exec(
      [
        'const example = "tools.apply_patch(patch)";',
        "// tools.exec_command({cmd: 'bun test'})",
        "/* tools.exec_command({cmd: 'rg fake src'}) */",
        "const docs = `tools.update_plan({})`;",
        'await tools.exec_command({cmd: "rg actual src"});',
      ].join("\n"),
    );
    expect(codexExecCalls("exec", program)).toEqual([
      { name: "exec_command", command: "rg actual src" },
    ]);
    expect(toolBucket("exec", program)).toBe("context");
    expect(isCodeEditTool("exec", program)).toBe(false);
    expect(countSearches("exec", program)).toBe(1);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is source code for the parser.
    expect(toolBucket("exec", exec("const output = `${await tools.apply_patch(patch)}`;"))).toBe(
      "code",
    );
  });
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
