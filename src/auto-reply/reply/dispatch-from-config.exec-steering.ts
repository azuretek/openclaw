import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDeliveryState } from "../../agents/reply-completion.js";
import type { ReplyPayload } from "../reply-payload.js";

/**
 * Whether a turn that folded in steered exec completions settled its reply.
 * A delivered final retires them; a failed, cancelled, or suppressed final
 * returns them for recovery. A turn with no outbound reply content (a
 * deliberate silent reply) or message-tool-only delivery consumed them itself.
 */
export function isExecSteeringReplySettled(params: {
  replies: readonly ReplyPayload[] | undefined;
  terminalDelivery: ReplyDeliveryState;
  messageToolOnly: boolean;
}): boolean {
  if (!params.replies) {
    return false;
  }
  if (params.terminalDelivery === "delivered" || params.messageToolOnly) {
    return true;
  }
  return !params.replies.some((reply) => hasOutboundReplyContent(reply, { trimText: true }));
}
