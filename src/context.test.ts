import { describe, expect, test } from "bun:test"
import { buildQuestionPrompt, buildReviewInitializationPrompt, selectedHunkPatch } from "./context"

describe("selectedHunkPatch", () => {
  test("returns only the selected hunk", () => {
    const patch = "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n@@ -8 +8 @@\n-before\n+after"
    expect(selectedHunkPatch(patch, 1)).toBe("@@ -8 +8 @@\n-before\n+after")
  })
})

describe("buildQuestionPrompt", () => {
  test("includes the exact source address and question", () => {
    const prompt = buildQuestionPrompt("Can this throw?", {
      path: "src/a.ts",
      side: "new",
      line: 42,
      hunkNumber: 2,
      hunkHeader: "@@ -40,2 +40,3 @@",
      hunkPatch: "+throw error",
    })
    expect(prompt).toContain("src/a.ts:42 (new side)")
    expect(prompt).toContain("Can this throw?")
  })
})

describe("buildReviewInitializationPrompt", () => {
  test("requires one status command and read-only inspection", () => {
    const prompt = buildReviewInitializationPrompt(" M src/a.ts")
    expect(prompt).toContain("ran git status --short exactly once")
    expect(prompt).toContain("<untrusted-git-status>\n M src/a.ts\n</untrusted-git-status>")
    expect(prompt).toContain("read and glob")
    expect(prompt).toContain("Do not modify files")
  })
})
