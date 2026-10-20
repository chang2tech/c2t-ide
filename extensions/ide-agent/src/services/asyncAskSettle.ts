/**
 * DEV-GAPS-19 — async ask-question step settling
 * (feature-matrix: `subagent-async-ask-settle`, P2, ai-agent).
 *
 * Evidence: `docs/rea/deepdig-runtime-subagent-2026-10-19.md` §3 —
 * Cursor 3.25.6's agent turn builder (class `Wk`) has
 * `settleAsyncAskQuestionSteps`: async ask-question steps are "settled via
 * **backwards scan with a `stepReads` budget**" (OBSERVED via AST
 * identifier-slice extraction; the identifier `stepReads` is verbatim, so
 * the parameter below keeps that name).
 *
 * Mechanism, as observed:
 * - A subagent turn's builder tracks its steps (message / tool-call /
 *   ask-question steps).
 * - When answers arrive for async ask-question steps that are still
 *   unsettled (e.g. the user answered mid-turn, or a worker turn's question
 *   is answered asynchronously), the builder scans the step log
 *   BACKWARDS — newest step first.
 * - The scan is capped: at most `stepReads` steps are read. Steps beyond
 *   the budget are not read and stay pending.
 * - Settling records the answer into the matching step. Pending questions
 *   are never lost by settling — unsettled steps simply remain pending.
 *
 * HONEST DIVERGENCES (not observable in the identifier slice; our own
 * implementation choices, marked so they are never claimed as Cursor's):
 * 1. The budget VALUE: the slice shows the mechanism (a `stepReads`
 *    budget) but not the number. `DEFAULT_STEP_READS_BUDGET` is our
 *    conservative choice — high enough that a question asked mid-turn is
 *    found within a few dozen steps of tool-call churn, low enough that a
 *    settle call never walks an unbounded transcript.
 * 2. The step record shape: Cursor's dispatch steps are
 *    `SubagentDispatchStep{step_index, tool_call_id, tool, backgrounded}`;
 *    the ask-question step record below mirrors our own `ClarifyingQuestion`
 *    + toolCallId/bubbleId correlation — do not claim the field layout is
 *    Cursor's.
 * 3. Settle order with duplicate asks: when the same questionId was asked
 *    more than once and is still unsettled, one settle call settles the
 *    NEWEST unsettled step only; older duplicates settle on later calls.
 *    This is a deterministic tie-break of our own.
 * 4. The scan exits early once every answered questionId has settled one
 *    step — an obvious budget-saving optimization, not observed.
 */
export type AsyncTurnStepKind = "ask-question" | "other";

export interface AsyncTurnStep {
  /** Position in the step log, assigned at record time (0-based, oldest first). */
  stepIndex: number;
  /**
   * "ask-question" steps are settle targets; "other" steps (message,
   * tool-call, thinking, dispatch…) are only scan fuel — they consume the
   * `stepReads` budget but are never settled.
   */
  kind: AsyncTurnStepKind;
  /** Set for kind === "ask-question": matches ClarifyingQuestion.questionId. */
  questionId?: string;
  /** The engine tool-call id that produced the step, when known. */
  toolCallId?: string;
  /** The composer bubble the step was rendered into, when known. */
  bubbleId?: string;
  /** Wall-clock ms when the step was recorded. */
  recordedAtMs: number;
  /** True once an answer has been recorded into this step. */
  settled: boolean;
  /** The answer text recorded when the step settled (ask-question only). */
  answerText?: string;
  /** Wall-clock ms when the step settled. */
  answeredAtMs?: number;
}

/**
 * HONEST DIVERGENCE (see header note 1): the binary slice observes the
 * `stepReads` budget mechanism but not its value. 50 is our conservative
 * implementation choice — documented, not Cursor's number.
 */
export const DEFAULT_STEP_READS_BUDGET = 50;

export interface AsyncAskQuestionSettleResult {
  /** Steps actually read during the backwards scan — always <= stepReads. */
  stepsRead: number;
  /** How many pending ask-question steps were settled in this call. */
  settledCount: number;
  /** questionIds settled, in settle order (newest step first). */
  settledQuestionIds: string[];
}

/**
 * The per-composer log of subagent-turn steps (the analog of Cursor's
 * turn-builder step list). Shares the `pendingQuestions` lifecycle in
 * ComposerDataService: cleared on dispose/newChat, NOT at turn end —
 * async questions may be answered after their turn finished.
 */
export class AsyncAskQuestionStepLog {
  private readonly steps: AsyncTurnStep[] = [];
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Append a step; returns the recorded step (with its stepIndex). */
  recordStep(init: {
    kind: AsyncTurnStepKind;
    questionId?: string;
    toolCallId?: string;
    bubbleId?: string;
  }): AsyncTurnStep {
    const step: AsyncTurnStep = {
      stepIndex: this.steps.length,
      kind: init.kind,
      questionId: init.questionId,
      toolCallId: init.toolCallId,
      bubbleId: init.bubbleId,
      recordedAtMs: this.now(),
      settled: false,
    };
    this.steps.push(step);
    return step;
  }

  /**
   * `settleAsyncAskQuestionSteps` — verbatim Cursor method name.
   *
   * Scans the step log backwards (newest first), reading at most
   * `stepReads` steps, and records each pending ask-question step's
   * answer into the step itself. For each answered questionId, only the
   * newest unsettled step is settled per call (HONEST DIVERGENCE, header
   * note 3). Steps beyond the budget are not read and stay pending —
   * settling never loses a pending question.
   *
   * @param answers questionId → answer text.
   * @param opts.stepReads budget for this call (default
   *   DEFAULT_STEP_READS_BUDGET). Non-positive / non-finite values and an
   *   empty answers map are no-ops (0 steps read).
   */
  settleAsyncAskQuestionSteps(
    answers: ReadonlyMap<string, string>,
    opts: { stepReads?: number } = {},
  ): AsyncAskQuestionSettleResult {
    const result: AsyncAskQuestionSettleResult = {
      stepsRead: 0,
      settledCount: 0,
      settledQuestionIds: [],
    };
    const stepReads = opts.stepReads ?? DEFAULT_STEP_READS_BUDGET;
    if (!Number.isFinite(stepReads) || stepReads <= 0 || answers.size === 0 || this.steps.length === 0) {
      return result;
    }
    const budget = Math.floor(stepReads);
    const remaining = new Set(answers.keys());
    for (
      let i = this.steps.length - 1;
      i >= 0 && result.stepsRead < budget && remaining.size > 0;
      i--
    ) {
      result.stepsRead += 1;
      const step = this.steps[i];
      if (step.kind === "ask-question" && !step.settled && step.questionId !== undefined && remaining.has(step.questionId)) {
        step.settled = true;
        step.answerText = answers.get(step.questionId) as string;
        step.answeredAtMs = this.now();
        remaining.delete(step.questionId);
        result.settledCount += 1;
        result.settledQuestionIds.push(step.questionId);
      }
    }
    return result;
  }

  /**
   * Unsettled ask-question steps, oldest first. Settling other steps
   * never removes entries here — a pending question is only lost if the
   * log itself is cleared (dispose / newChat, same lifecycle as
   * ComposerDataService.pendingQuestions).
   */
  pendingSteps(): AsyncTurnStep[] {
    return this.steps.filter((s) => s.kind === "ask-question" && !s.settled);
  }

  /** All recorded steps, oldest first (read-only view). */
  allSteps(): readonly AsyncTurnStep[] {
    return this.steps;
  }

  clear(): void {
    this.steps.length = 0;
  }
}
