// "Open in T3": deep links into the T3 Code desktop app (t3code://threads/<environmentId>/<threadId>).
// The environment ID is T3's own UUID (<T3_USERDATA>/environment-id), not this graph's machine name.

const isT3Thread = (id) => typeof id === "string" && id !== "" && !id.startsWith("conductor:");
// Native (Task/Agent) subagents are provider sessions. T3 may give them a synthetic projection thread
// (thread:provider:...:native-thread:...), but that isn't a conversation of their own, so never link it.
const ownsConversation = (n) => n.origin !== "provider_native" && n.origin !== "project" && isT3Thread(n.threadId);

export const t3ThreadUrl = (environmentId, threadId) =>
  `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;

/**
 * The T3 conversation a card opens: its own thread, or for a native subagent (which has no T3
 * thread of its own) the closest ancestor's. Null for project cards, Conductor history, or when
 * the machine's T3 environment ID is unknown. `ancestors` is nearest parent first.
 */
export function t3LinkFor(node, ancestors, environmentId) {
  if (!environmentId) return null;
  if (ownsConversation(node)) return { url: t3ThreadUrl(environmentId, node.threadId), parent: false };
  if (node.origin !== "provider_native") return null;
  const owner = ancestors.find(ownsConversation);
  return owner ? { url: t3ThreadUrl(environmentId, owner.threadId), parent: true, name: owner.name } : null;
}
