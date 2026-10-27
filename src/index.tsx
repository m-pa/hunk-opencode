import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { useEffect, useRef, useSyncExternalStore } from "react"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { ExtensionPaneProps, HunkExtensionAPI } from "hunkdiff/extension"
import { buildQuestionPrompt, buildReviewInitializationPrompt, makeQuestionContext } from "./context"

type EntryStatus = "pending" | "answered" | "error"

interface Entry {
  id: number
  fileId: string
  path: string
  side: "old" | "new"
  line: number
  question: string
  answer?: string
  status: EntryStatus
}

let entries: readonly Entry[] = []
let nextEntryId = 1
let sessionID: string | undefined
let clientPromise: ReturnType<typeof connect> | undefined
let requestQueue = Promise.resolve()
const listeners = new Set<() => void>()

const READ_ONLY_PERMISSIONS = [
  { action: "*", resource: "*", effect: "deny" as const },
  { action: "read", resource: "*", effect: "allow" as const },
  { action: "read", resource: "*.env", effect: "deny" as const },
  { action: "read", resource: "*.env.*", effect: "deny" as const },
  { action: "read", resource: "*.env.example", effect: "allow" as const },
  { action: "glob", resource: "*", effect: "allow" as const },
  { action: "external_directory", resource: "*", effect: "deny" as const },
]

function publish(next: readonly Entry[]) {
  entries = next
  for (const listener of listeners) listener()
}

function updateEntry(id: number, update: Partial<Entry>) {
  publish(entries.map((entry) => (entry.id === id ? { ...entry, ...update } : entry)))
}

function useEntries() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => entries,
  )
}

async function connect() {
  const endpoint = await Service.ensure()
  return OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  })
}

async function gitStatus(cwd: string): Promise<string> {
  const process = Bun.spawn(["git", "status", "--short"], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [status, error, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(error.trim() || `git status exited with code ${exitCode}`)
  return status.trimEnd() || "(clean working tree)"
}

function assistantAnswer(message: Awaited<ReturnType<Awaited<ReturnType<typeof connect>>["message"]["list"]>>) {
  const assistant = message.data.find((item) => item.type === "assistant")
  if (!assistant || assistant.type !== "assistant") return undefined
  const text = assistant.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
  return text ? { id: assistant.id, text } : undefined
}

async function askOpenCode(cwd: string, prompt: string): Promise<string> {
  clientPromise ??= connect().catch((error) => {
    clientPromise = undefined
    throw error
  })
  const client = await clientPromise
  let activeSessionID = sessionID
  if (!activeSessionID) {
    const status = await gitStatus(cwd)
    const session = await client.session.create({
      title: `Hunk review: ${cwd.split("/").filter(Boolean).at(-1) ?? cwd}`,
      location: { directory: cwd },
      metadata: { source: "hunk-opencode" },
      permissions: READ_ONLY_PERMISSIONS,
    })
    activeSessionID = session.id
    sessionID = activeSessionID

    try {
      await client.session.prompt({ sessionID: activeSessionID, text: buildReviewInitializationPrompt(status) })
      await client.session.wait({ sessionID: activeSessionID })
    } catch (error) {
      if (sessionID === activeSessionID) sessionID = undefined
      throw error
    }
  }

  const previous = assistantAnswer(
    await client.message.list({ sessionID: activeSessionID, type: "assistant", order: "desc", limit: 1 }),
  )
  await client.session.prompt({ sessionID: activeSessionID, text: prompt })
  await client.session.wait({ sessionID: activeSessionID })
  const messages = await client.message.list({
    sessionID: activeSessionID,
    type: "assistant",
    order: "desc",
    limit: 1,
  })
  const answer = assistantAnswer(messages)
  if (!answer || answer.id === previous?.id) {
    throw new Error("OpenCode completed without a new text response")
  }
  return answer.text
}

function QuestionPane({ theme, actions, width }: ExtensionPaneProps) {
  const current = useEntries()
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)

  useEffect(() => {
    const last = current.at(-1)
    if (last) scrollRef.current?.scrollChildIntoView(`opencode-question-${last.id}`)
  }, [current])

  if (current.length === 0) {
    return (
      <box style={{ width: "100%", height: "100%", padding: 1, backgroundColor: theme.panel }}>
        <text
          content="Move to a diff line and run Ask OpenCode. Default shortcut: Ctrl-G."
          wrapMode="word"
          style={{ fg: theme.muted }}
        />
      </box>
    )
  }

  return (
    <scrollbox
      ref={scrollRef}
      width="100%"
      height="100%"
      scrollY={true}
      focused={false}
      style={{ backgroundColor: theme.panel }}
    >
      {current.map((entry) => (
        <box
          key={entry.id}
          id={`opencode-question-${entry.id}`}
          style={{ width: "100%", flexDirection: "column", padding: 1 }}
          onMouseUp={() => actions.revealLine(entry.fileId, entry.side, entry.line)}
        >
          <text
            content={`${entry.path}:${entry.line} (${entry.side})`}
            wrapMode="word"
            style={{ fg: theme.accent }}
          />
          <text content={`Q: ${entry.question}`} wrapMode="word" style={{ fg: theme.text }} />
          <text
            content={
              entry.status === "pending"
                ? "OpenCode is thinking..."
                : entry.status === "error"
                  ? `Error: ${entry.answer}`
                  : entry.answer ?? ""
            }
            wrapMode="word"
            style={{ fg: entry.status === "error" ? theme.badgeRemoved : theme.muted }}
          />
          <text content={"─".repeat(Math.max(1, width - 4))} style={{ fg: theme.border }} />
        </box>
      ))}
    </scrollbox>
  )
}

export default function extension(hunk: HunkExtensionAPI) {
  hunk.registerPane({
    id: "answers",
    title: "OpenCode Q&A",
    placement: "right",
    width: { preferred: 52, min: 32, max: 90, fraction: 0.4 },
    component: QuestionPane,
  })

  hunk.registerCommand(
    { id: "ask", title: "Ask OpenCode about this line", key: "ctrl+g" },
    async (ctx) => {
      const file = ctx.selection.file
      const currentLine = ctx.selection.currentLine
      const hunkIndex = ctx.selection.hunkIndex
      if (!file || !currentLine || hunkIndex === null) {
        ctx.notify("Move the current-line marker onto a diff line first", "warning")
        return
      }

      const question = await ctx.dialogs.input({
        title: `Ask about ${file.path}:${currentLine.line}`,
        placeholder: "What would you like to understand?",
      })
      if (!question?.trim()) return

      try {
        const questionContext = makeQuestionContext(
          file,
          hunkIndex,
          currentLine.side,
          currentLine.line,
        )
        const entry: Entry = {
          id: nextEntryId++,
          fileId: file.id,
          path: file.path,
          side: currentLine.side,
          line: currentLine.line,
          question: question.trim(),
          status: "pending",
        }
        publish([...entries, entry])
        ctx.panes.open("answers")

        requestQueue = requestQueue.then(async () => {
          try {
            const answer = await askOpenCode(ctx.cwd, buildQuestionPrompt(entry.question, questionContext))
            updateEntry(entry.id, { status: "answered", answer })
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            updateEntry(entry.id, { status: "error", answer: message })
            ctx.notify(`OpenCode failed: ${message}`, "error")
          }
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.notify(`Could not queue question: ${message}`, "error")
      }
    },
  )

  hunk.registerCommand(
    { id: "toggle", title: "Toggle OpenCode Q&A pane", key: "ctrl+o" },
    (ctx) => {
      ctx.panes.toggle("answers")
    },
  )

  hunk.registerCommand({ id: "new-conversation", title: "Start a new OpenCode Q&A conversation" }, (ctx) => {
    sessionID = undefined
    publish([])
    ctx.notify("The next question will start a new OpenCode session")
  })
}
