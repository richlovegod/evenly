// The whiteboard notice's 復原 (review-1106, G2-correct-01; features/groups/notesDrafts.ts
// notesMoved, used by SettingsTab.tsx undoTheirNotes): a whiteboard save that replaced another
// member's newer text says 「白板剛被別人改過，已換成你寫的內容」 with 復原 for their text. 復原 puts it
// back only while the group's whiteboard still has what that save wrote. Once the whiteboard has
// changed again since (a newer save here, or another member's edit that a refresh brought), it
// writes nothing and says 「白板之後又改過了，所以沒有復原」, as the iPhone app does
// (GroupSettingsView notesMoved). The texts are compared trimmed, as the server keeps them. Only the
// rule is tested here: pressing 復原 in the tab would need a DOM.

import { describe, expect, it } from 'vitest';
import { notesMoved } from '../../src/web/features/groups/notesDrafts';

// Abbie wrote 門鎖 9999 while Gino's box, typed over 門鎖 1234, said 門鎖 5678; leaving the box saved
// 門鎖 5678 over hers, so the notice offers 復原 for 門鎖 9999. `ours` is what that save wrote.
const ours = '門鎖 5678';

describe("the whiteboard notice's 復原 (review G2-correct-01)", () => {
  it('runs while the whiteboard still has what the save wrote', () => {
    expect(notesMoved('門鎖 5678', ours)).toBe(false);
    // Spaces and line breaks at the ends do not count: the server keeps the text trimmed.
    expect(notesMoved('門鎖 5678\n', ours)).toBe(false);
    expect(notesMoved('門鎖 5678', '  門鎖 5678 ')).toBe(false);
    // A save that emptied the whiteboard, which is still empty.
    expect(notesMoved('', '')).toBe(false);
    expect(notesMoved(' \n', '')).toBe(false);
  });

  it('writes nothing once a newer save here changed the whiteboard', () => {
    expect(notesMoved('門鎖 5678，停車位 B2', ours)).toBe(true);
    expect(notesMoved('', ours)).toBe(true);
  });

  it("writes nothing once a refresh brought another member's newer edit", () => {
    expect(notesMoved('門鎖 0000', ours)).toBe(true);
    // Abbie wrote on a whiteboard that my save had emptied.
    expect(notesMoved('門鎖 0000', '')).toBe(true);
  });

  it('counts everything inside the text: spaces between words and letter case', () => {
    expect(notesMoved('門鎖  5678', ours)).toBe(true);
    expect(notesMoved('Door code ab12', 'Door code AB12')).toBe(true);
  });

  it('a group no longer on this device counts as unchanged, as on the iPhone app (the write then says why it cannot go)', () => {
    expect(notesMoved(undefined, ours)).toBe(false);
  });

  it('writes nothing while a newer save from this device has not landed (its draft is kept)', () => {
    // Pressing 復原 while typing blurs the box on a desktop, which sends the new text first: the store
    // still has 門鎖 5678 while that save is on its way, or after it failed and its draft waits.
    expect(notesMoved('門鎖 5678', ours, true)).toBe(true);
    expect(notesMoved(undefined, ours, true)).toBe(true);
    // The notice's own save took its draft away when it landed.
    expect(notesMoved('門鎖 5678', ours, false)).toBe(false);
  });
});
