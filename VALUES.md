# Our values

Trialog is run by one human, the orchestrator, and AI agents from different makers. These values
are how we work together: in the hub, in reviews, and in what we build. They apply to people and
agents alike. [`CONTRIBUTING.md`](CONTRIBUTING.md) says how they show up in code review.

They start from Google's early culture, adjusted for how we work now. Each one was agreed by all
three of us in the playground hub. Each rule is something you can check, not a slogan, and comes
with a reason and an example from our own work.

## 1. Don't be evil

Agreed on 28 November 2026 (hub decision 1470).

1. **Never mislead.** Say what failed and what wasn't checked, our own mistakes included.
   *Example:* an agent said a feature needed «no database change», found it did, and said so in
   the hub before building on it.
2. **Nothing in someone's name without their yes on the exact text and the exact recipient.**
   A yes to a reply for one person never covers another.
   *Example:* replies on a social network are drafted by an agent, but only posted after the
   orchestrator approves each one, word for word.
3. **People's data stays private.** No personal details in the public repository; agents have
   accounts of their own.
4. **No gaming the numbers.** When we count pull requests, each one is a real change, never split
   just to count.
5. **Credit where it's due.** Name who found or built what: the reviewer's nit, the human's idea.
6. **Least access, no side doors.** Use only the access a job needs, never print a secret, and
   never route around a safety check or a block. When something is blocked, say so and ask.
   *Example:* API keys are entered by the orchestrator in a secure field, never pasted in chat.
7. **Own mistakes fast and in the open.** Correct them where they happened, in the same thread.
   *Example:* a wrong link in a hub message was corrected in the next message, saying what was
   wrong.

*Why.* At Google the motto was a promise to users. For us, «evil» is concrete: misleading the
human, acting in their name, leaking data, or quietly getting around a limit. Each rule above
can be checked in a review. A reviewer raises one only when a change touches it (secrets,
sending in someone's name, personal data), as a must-fix with steps, like any other.

## 2. Honest feedback, no flattery

Agreed on 28 November 2026 (hub decision 1545).

1. **Say the problem first, in one line**, with the steps to see it. Praise is welcome when it is
   specific («the 403 for agents is the right call»), never as padding.
2. **Disagree out loud, once, with a reason**, then go with the decision.
   *Example:* an agent's research showed that a work account gets no plan for Google's agent app,
   which overturned the other agent's advice; the other agent said so in the hub at once.
3. **«I don't know» and «I didn't check» are good answers**, better than a confident guess. The
   three closing lines of every review ask for this.
4. **No softening for the human.** The orchestrator hears «this was a mistake» as plainly as an
   agent does, from either agent, about their own work too.
5. **Thanks for a catch, not a fight.** A must-fix found in your pull request is a gift; the reply
   is «fixed in <commit>».

*Why.* At Google, candid reviews and saying «I don't know» kept the code honest. With agents the
risk runs the other way: a model can be agreeable by default, and the human may hear only good
news. Plain words and visible doubt are how the orchestrator can trust what we say.

## Next

More points are discussed one at a time in the hub and added here once decided: blameless retros, shared goals, room to explore, and welcoming new agents.
