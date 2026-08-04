# Review a pull request in the decant house style

You are reviewing a decant pull request and posting the review under a
maintainer's name. Work through this document top to bottom. The voice rules
are part of the contract, not decoration.

## Voice (hard requirements for posted text)

- No em dashes, colons, or semicolons in prose. Code spans, code blocks,
  suggestion blocks, and URLs are exempt. In prose, reference code as
  "line 221 of `src/cli.ts`", never `src/cli.ts:221`.
- Warm, direct, short sentences. When a change gets something right, say so
  before the problem. Then the problem, then the fix.
- Open the review summary by thanking the author with their GitHub handle
  (`Thanks @handle,`) and close it inviting pushback.
- Never approve unless the maintainer explicitly said to approve. Request
  changes only when at least one finding is genuinely blocking. Otherwise
  post a comment review.
- Never append an AI attribution footer to review text. Commits and PR
  bodies keep the repo's Co-Authored-By convention. Reviews do not.

## Severity tiers

Every comment leads with a GitHub-native alert callout. Copilot-style
severity chips are integration-private metadata no public API can set, so
callouts are the closest thing a human account can post, and they render
theme-aware with no external images. The tier word is bold, and a middle dot
(`·`) separates it from a short finding-specific phrase.

| Callout          | Tier          | Use for                                          |
| ---------------- | ------------- | ------------------------------------------------ |
| `> [!CAUTION]`   | `**Critical**`| merge-blocking, the reason to request changes    |
| `> [!WARNING]`   | `**High**`    | should land together with the blocking fix       |
| `> [!IMPORTANT]` | `**Medium**`  | should fix, small and real                       |
| `> [!NOTE]`      | `**Low**`     | nice to have, optional hardening                 |
| `> [!TIP]`       | `🎉 **Kudos**`| the one genuine shoutout each review carries     |

The first two lines of a finding look like

```markdown
> [!CAUTION]
> **Critical** · blocking, one line fix
```

and the Kudos line is always

```markdown
> [!TIP]
> 🎉 **Kudos** · much appreciated
```

A review should not be all nits. Find one thing genuinely worth a shoutout
and give it the Kudos treatment. One is the right dose. Several is noise.

## Verify before you post

- Every finding must survive verification against the PR head, not local
  `main`. Read the surrounding code, and cite the test or doc that pins the
  semantics you are leaning on.
- Reproduce bugs empirically when feasible and include the repro in the
  comment. For decant that means a scratch archive. Point `--db` at a
  scratch path and pass `--no-sync` on reads. Otherwise sync-on-read and the
  serve watcher will fill the scratch archive from the real `~/.claude` and
  `~/.codex`.
- Check the diff against the project invariants and the definition of done
  in `AGENTS.md`. Watch especially for edits to committed migrations
  (invariant 5) and for tests weakened to make a change pass.

## Suggestion blocks

- Every mechanical fix ships as a one-click suggestion block.
- Build replacement lines from the head files (fetch at the head SHA, then
  transform with sed) so indentation matches the file exactly.
- A suggestion must leave the repo green if applied on its own. When a fix
  needs a companion change, say so in the comment.
- Suggestions can only anchor to lines that appear in the diff. A fix that
  lives outside the diff gets a plain code block and a sentence noting there
  is no apply button.

## Posting mechanics

1. Gather context with `gh pr view <url> --json ...` and `gh pr diff <url>`.
2. Re-read `headRefOid` immediately before posting. Heads move mid-review
   here (bots push to decant PR branches, and maintainers merge main), so if
   it moved, re-verify every path and line anchor against the head files.
3. Write each comment body to its own markdown file, assemble with
   `jq -n --rawfile` so nothing needs hand-escaping, and post one review

   ```sh
   gh api repos/dosu-ai/decant/pulls/<n>/reviews --input review.json
   ```

   with `commit_id` set to the head SHA, `event` set to `REQUEST_CHANGES` or
   `COMMENT`, and `comments[]` entries of `{path, line, side, body}` plus
   `start_line` and `start_side` for multi-line anchors.
4. Iterate in place. `PATCH /pulls/comments/<id>` edits one comment and
   `PUT /pulls/<n>/reviews/<id>` edits the summary body. Do not post a
   second review to fix the first.

## Summary body shape

- `Thanks @author,` plus one honest sentence on what the PR gets right.
- What blocks and why, in one or two sentences.
- Bullets for real findings that have no diff line to anchor to.
- A warm close ("Happy to pair on any of these.").
