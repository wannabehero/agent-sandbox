/**
 * oc-events plugin
 *
 * Intercepts tool results via tool.execute.after and appends structured
 * OC_EVENT markers to the tool output.  The backend reads these from
 * message.part.updated (tool-result) events and forwards them as typed
 * SSE events to the browser — no text-regex accumulation needed.
 *
 * Marker format (one per line, appended after the real tool output):
 *   OC_EVENT: {"type":"<event-type>", ...payload}
 *
 * To add a new event: add a detector function to DETECTORS below.
 */

const DETECTORS = [
  // GitHub PR created / opened
  (tool, output) => {
    const match = output.match(/https:\/\/github\.com\/[^\s)>\]"]+\/pull\/\d+/)
    if (match) return { type: 'pr_created', url: match[0] }
  },

  // GitHub PR merged (gh pr merge prints "✓ Merged pull request …")
  (tool, output) => {
    const match = output.match(/Merged pull request[^\n]*\n?\s*(https:\/\/github\.com\/[^\s)>\]"]+\/pull\/\d+)/)
    if (match) return { type: 'pr_merged', url: match[1] }
  },

  // Tests passed — common patterns from pytest / jest / go test
  (tool, output) => {
    if (/\b(PASSED|passed|ok\s+\S+.*\d+\.\d+s|Tests:\s+\d+ passed|\d+ tests? passed)\b/.test(output)) {
      return { type: 'tests_passed' }
    }
  },

  // Tests failed
  (tool, output) => {
    if (/\b(FAILED|failed|FAIL\s+\S+|Tests:\s+\d+ failed|\d+ tests? failed)\b/.test(output)) {
      return { type: 'tests_failed' }
    }
  },
]

export default async () => ({
  'tool.execute.after': async ({ tool }, output) => {
    if (!output?.text) return output

    const events = DETECTORS
      .map(fn => fn(tool, output.text))
      .filter(Boolean)

    if (!events.length) return output

    const markers = events
      .map(e => `OC_EVENT: ${JSON.stringify(e)}`)
      .join('\n')

    return { ...output, text: `${output.text}\n${markers}` }
  },
})
