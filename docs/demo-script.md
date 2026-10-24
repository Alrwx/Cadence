# Demo script

Owner: Dev 4. See AGENTS(GH).md §1 for the flow that must always work.

## Before the demo
- [ ] Hotspot on; laptop, Quest 3S, and phone all on it
- [ ] `make certs` done for the current LAN IP; certificate accepted on the Quest and the phone
- [ ] `make demo` running; `/healthz` shows the models are ready
- [ ] Phone open at `https://<laptop-ip>:8443/phone/?session=demo`, "Start" tapped
- [ ] Quest Browser open at `https://<laptop-ip>:8443/headset/?session=demo`, "Enter" tapped
- [ ] Backup video ready

## Flow
1. Play a 10-second clip of a teammate's voice and create the clone (show the consent step).
2. A judge asks the "patient" a question.
3. The patient pinches a suggested reply; the phone speaks it in the cloned voice.
4. The patient gives a thumbs-up; the phone says "Yes" in under a second.
5. The patient opens Saved phrases → Hospital → "I need some water".
6. Replay the same exchange with a generic robot voice for contrast.

## On-device checks (Quest)
- [ ] Enter AR shows passthrough
- [ ] Pinch selects a reply; poke works too
- [ ] Thumbs-up / thumbs-down / open palm fire once each, not repeatedly
- [ ] "Type my own" opens the word board; Speak works
- [ ] No console errors
