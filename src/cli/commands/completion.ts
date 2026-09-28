import type { CliContext } from "../context.ts";

export function registerCompletionCommand(ctx: CliContext): void {
  ctx.program
    .command("completion")
    .description("generate a shell completion script")
    .argument("<shell>", "bash | zsh | fish | powershell | elvish")
    .action((shell: string) =>
      ctx.run(() => {
        const script = renderCompletion(shell);
        if (script == null) {
          ctx.io.writeErr(
            `error: unknown completion shell ${JSON.stringify(shell)} ` +
              "(expected: bash | zsh | fish | powershell | elvish)\n",
          );
          return 2;
        }
        ctx.io.writeOut(script);
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
  "--db",
  "--json",
  "--format",
  "--quiet",
  "--no-color",
  "--no-sync",
];

function renderCompletion(shell: string): string | null {
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
    default:
      return null;
  }
}
