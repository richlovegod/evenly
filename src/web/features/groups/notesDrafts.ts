// Whiteboard text typed in 設定 (SettingsTab) that has not saved, what leaving its box does, and
// whether the 復原 of a save that replaced another member's text may still put theirs back.
// No imports: the store clears the drafts when a session ends (store.ts clearSession), and this
// module must not pull SettingsTab, or anything that imports the store, into it.

/**
 * Whiteboard text typed here that has not saved (offline, or the save failed), per group and member
 * (`${gid}:${memberId}`), with the server's text it was typed over (its base). In memory only: the
 * whiteboard holds door codes and account details, which must not outlive the page or a sign-out,
 * so the session's end clears it too (review G10-correct-05).
 */
export const notesDrafts = new Map<string, { text: string; base: string }>();

/**
 * What leaving the whiteboard box does with its `text` (SettingsTab saveNotes): 'send' it when it
 * is neither the server's text it was typed over (`base`) nor what the server has now (`server`).
 * Otherwise nothing is left to save: 'drop' the draft of a save that did not go, when there is one
 * (`hasDraft`), so the box shows the server's copy again instead of bringing that draft back and
 * saving it later (review G10-correct-01), or 'none'.
 */
export function notesOnLeave(text: string, base: string, server: string, hasDraft: boolean): 'none' | 'drop' | 'send' {
  const v = text.trim();
  if (v !== base.trim() && v !== server.trim()) return 'send';
  return hasDraft ? 'drop' : 'none';
}

/**
 * The whiteboard no longer has what a save wrote (`ours`), so the 復原 on that save's notice
 * (「白板剛被別人改過，已換成你寫的內容」) must not put the other member's older text back: the
 * whiteboard changed again since, by a newer save of mine or by another member's edit that a
 * refresh brought (review G2-correct-01, the iPhone app's GroupSettingsView notesMoved). `now` is
 * the group's whiteboard as this device has it now. Both are compared as the server keeps them,
 * trimmed, which is how the save sends the box. Undefined `now` (the group is no longer on this
 * device) counts as unchanged, as on the iPhone app: 復原 then tries, and the server says why it
 * cannot. `pending`: this device has newer whiteboard text for the group that has not landed (its
 * draft in notesDrafts, kept from the blur that sends it until it saves): that counts as a change
 * too, or 復原 would race the newer save, or be replaced by the draft later.
 */
export function notesMoved(now: string | undefined, ours: string, pending = false): boolean {
  return pending || (now !== undefined && now.trim() !== ours.trim());
}
