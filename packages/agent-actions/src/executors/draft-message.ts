import { ActionConfigMismatchError, type ActionExecutor } from "../types";

/**
 * draft_message — STUB.
 *
 * Real implementation (AGENT-04+) will call Anthropic via
 * @hireops/ai-client with the prompt template referenced by
 * template_prompt_id, the tone modifier, and the max_tokens cap. Output
 * draft_text will be the LLM's generated message body.
 *
 * AGENT-02 stub returns a synthetic draft_text echoing the inputs so
 * the next action (send_message) has something realistic-shaped to
 * read via previousActionOutputs.
 */
export const draftMessageExecutor: ActionExecutor = async ({ config }) => {
  if (config.type !== "draft_message") {
    throw new ActionConfigMismatchError("draft_message", config.type);
  }
  return {
    output: {
      _stub: true,
      _ticket: "AGENT-02",
      draft_text: `[STUB] Drafted message using template_prompt_id=${config.template_prompt_id} tone=${config.tone}`,
      template_prompt_id: config.template_prompt_id,
      tone: config.tone,
      max_tokens: config.max_tokens,
    },
    // Real impl populates from ai_usage_logs after the Anthropic call.
    costMicros: 0n,
    requiresApproval: false,
  };
};
