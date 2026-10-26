# VoiceOver QA Checklist — Workshop frontend (post HextaUI/polish tracks)

Run against `http://localhost:8787` (dev server). VoiceOver: toggle with **Cmd+F5**; rotor **VO+U**; next/prev item **VO+→/←**; interact **VO+Shift+↓**; leave **VO+Shift+↑**. Safari preferred (best WebKit AX fidelity). Each item: PASS/FAIL + note. Allow ~20 min.

## 1. Transcript live region (role=log / aria-busy)
- [ ] Open a chat; VO+Right traverses messages in order; the transcript is announced as a "log" (not silent div soup).
- [ ] Send a prompt during an active turn: VO does **not** re-announce the whole log on each token; new content arrives without focus being yanked.
- [ ] The tool-call running spinner is **skipped** by VO (aria-hidden) — no "loading" spam while tools run.
- [ ] A failed tool group announces its error state; a still-running group is not simultaneously announced as running+failed.

## 2. Jump pill + missed-message announcements
- [ ] During streaming, scroll up ~2 screens: pill appears; VO (staying where it is) receives **one polite announcement** of new content (first occurrence / turn end), not one per token.
- [ ] Reach pill via keyboard (Tab): its accessible name is the honest count ("N new"), not duplicated with the visual status.
- [ ] Activate it (VO+Space): view glides to live edge; landing is confirmed by speech (last message read or position change), not silence.

## 3. BotEditorDialog validation
- [ ] Open New Bot, press Save with empty fields: error announced (role=alert) **once**; focus lands on Name input; input reported as "invalid data".
- [ ] Fill Name, leave model unset, Save: model error announced; focus lands on the model trigger button; trigger described as invalid; error text readable via VO on the trigger (aria-describedby wiring).
- [ ] Typing in Name clears its error silently (no re-announcement churn).
- [ ] Enter in Name/Description submits (deliberate contract); Enter in Instructions textarea inserts newline; Escape closes dialog.

## 4. Pending switches (Admin → Models panel)
- [ ] Toggle a model switch that will fail: switch announces busy state (aria-busy) while pending; on failure it reverts and focus **stays on the switch**; no orphan "on" announcement.

## 5. Approval actions
- [ ] Trigger an agent action needing approval: Approve / Deny / Always-approve buttons reachable by VO with distinct names; while pending, group announced busy and buttons not operable.
- [ ] A failing approval announces the failure (toast, aria-live); a rapid retry (<400ms) keeps button speech coherent (no stuck "failed" label over a running retry).

## 6. Composer attachments
- [ ] Add a file: "Uploading <name>" is announced politely; success/failure path announced once.
- [ ] Remove button's accessible name includes the filename; activating it is confirmed by speech.

## 7. Reduced motion cross-check
- [ ] System Settings → Accessibility → Display → Reduce Motion ON: shimmer placeholders, scroll fades, badge pop, and jump glide become static/instant — verify no VO behavior regressed (announcements still fire).

## Regression focus (newest code)
- MissedMessagesStatus (2 above) — newest, least battle-tested.
- Model-error wiring in 3 — render-prop trigger, first shipped in #48.
- useButtonFeedback retry speech in 5 — supersede semantics from #74.
