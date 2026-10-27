# hunk-opencode

Ask OpenCode questions about the current diff line without leaving Hunk. The extension opens a persistent OpenCode session for the review, initializes it from one `git status --short`, and lets OpenCode read the relevant changed files before answering questions in a docked pane.

## Install for development

```sh
cd /home/m-pa/projects/hunk-opencode
bun install
bun run build
hunk diff --extension /home/m-pa/projects/hunk-opencode
```

For a managed local installation:

```sh
hunk extension install /home/m-pa/projects/hunk-opencode
```

OpenCode V2 must be installed and configured with a model. The extension discovers or starts its authenticated background service through `@opencode/client/service`.
Hunk `0.21.1` or newer is required (extension API v16).

## Use

1. Move Hunk's current-line marker to a diff line.
2. Press `Ctrl-G`.
3. Enter a question.
4. Read the response in the right-side **OpenCode Q&A** pane.

Click a Q&A entry to return to its source line. The extension serializes questions into one persistent OpenCode session so follow-up questions retain prior context.

Press `Ctrl-O` to toggle the pane. The **Extensions** menu also provides commands to toggle it and start a new conversation.

Remap the shortcut in `~/.config/hunk/config.toml`:

```toml
[keybindings]
"hunk-opencode.ask" = "ctrl+g"
```

## Safety

During initialization, the extension runs `git status --short` once and supplies its output to the dedicated OpenCode session. OpenCode receives repository `read` and `glob` access so it can select relevant changed files; shell access, mutations, external-directory access, and common environment files remain denied. The selected hunk, side, line, and patch context are supplied directly with each question.
