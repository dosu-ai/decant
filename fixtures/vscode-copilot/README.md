# Copilot Chat in VS Code fixtures

`User` is laid out like VS Code's `User` directory, holding only the chat
session files Decant reads and the `workspace.json` that names their folder.
All of it is invented.

- `workspaceStorage/5f3e9c1a/chatSessions/vscode-sample-session.jsonl` is a
  change log in the format VS Code 1.109 and later write. It has an agent turn
  with thinking, file edits, a failing terminal command, and an MCP call, an
  "auto" model turn, a canceled turn, and a failed turn.
- `workspaceStorage/5f3e9c1a/chatSessions/vscode-legacy-session.json` is a
  whole-file session from an older build that wrote no token usage.
- `globalStorage/emptyWindowChatSessions/vscode-empty-window-session.jsonl` is
  a question asked in a window with no folder open.
