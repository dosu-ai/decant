import type { CliContext } from "../context.ts";
import { parseChoice } from "../parse.ts";

const SHELLS = ["bash", "zsh", "fish", "powershell", "elvish"] as const;
type Shell = (typeof SHELLS)[number];

export function registerCompletionCommand(ctx: CliContext): void {
  ctx.program
    .command("completion")
    .description("generate a shell completion script")
    .argument("<shell>", SHELLS.join(" | "), parseChoice(SHELLS))
    .action((shell: Shell) =>
      ctx.run(() => {
        ctx.io.writeOut(renderCompletion(shell));
      }),
    );
}

const completionWords = [
  "sync",
  "watch",
  "serve",
  "session",
  "ls",
  "show",
  "rm",
  "project",
  "db",
  "distill",
  "script",
  "replay",
  "skill",
  "recommendations",
  "mark",
  "search",
  "stats",
  "tokens",
  "economics",
  "files",
  "tool",
  "mcp",
  "export",
  "completion",
  "update",
  "doctor",
  "service",
  "install",
  "uninstall",
  "status",
  "--check",
  "--db",
  "--json",
  "--format",
  "--quiet",
  "--no-color",
  "--no-sync",
];

function renderCompletion(shell: Shell): string {
  const words = completionWords.join(" ");
  switch (shell) {
    case "bash":
      return `_decant_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "${words}" -- "$cur") )
}
complete -F _decant_complete decant
`;
    case "zsh":
      return `#compdef decant
_arguments '1:command:(${words})' '*::arg:->args'
`;
    case "fish":
      return `${completionWords.map((word) => `complete -c decant -f -a '${word}'`).join("\n")}\n`;
    case "powershell":
      return `Register-ArgumentCompleter -Native -CommandName decant -ScriptBlock {
  param($wordToComplete)
  "${words}".Split(" ") | Where-Object { $_ -like "$wordToComplete*" }
}
`;
    case "elvish":
      return `set edit:completion:arg-completer[decant] = {|@words|
  put ${completionWords.map((word) => JSON.stringify(word)).join(" ")}
}
`;
  }
}
