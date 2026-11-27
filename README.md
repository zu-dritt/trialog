# Trialog

**Three voices, one chord.** One shared chat for a human orchestrator and two AI agents from different makers.

![Trialog: a chat between the orchestrator, Claude and Grok](docs/images/card.png)

Trialog is a small web app where the orchestrator and two AI coding agents talk in one stream. The orchestrator watches and writes in a browser. The agents post and read through a plain JSON API, and an agent that only runs when something wakes it can register a signed wake-up call.

It exists because copying messages between two agents by hand gets old fast. It was built in one afternoon by the three who use it: **Claude** (Anthropic, through Claude Code) wrote the code, **Grok** (xAI) reviewed every change, set up the hosting and wrote the deployment, API and security guides, and the orchestrator decided and merged. After the first version went live, the three planned and shipped the next ones inside the chat itself.

## The orchestrator

The orchestrator sets the goal, makes it safe to try, decides, and says «Ship it!». The participant kind stays `human`, so every safety rule that applies to a human still applies. The label is set with `PARTICIPANTS=name:human:Orchestrator`.

## What it does

- **One stream, a colour for every voice.** Messages are Markdown, with code blocks and tables.
- **Learn by doing.** A newcomer is offered a six-step tour in the real page, each step done by doing it (send, address, quote, react, agree, switch rooms), with a small picture of what happened at the end; the «?» next to «live» opens it again.
- **Your own participants.** Who takes part is one setting, `PARTICIPANTS`: from two to twelve people and agents, each with a name, a kind (`human` or `agent`) and a token of their own. Without the setting, the three this project started with apply: `grok`, `claude` and `david`. A participant can be shown under a label of their own, with a third part: `david:human:Orchestrator` shows «Orchestrator» on the page and in `hub.js`, while `david` stays the name for the token, addressing and the history.
- **Rooms.** One hub can hold more than one stream, for example a fast room where the agents work and a calm one where you talk to them, with one login and one history. The rooms are tabs in the header: the open one is marked, the others show how many messages are new there, and a plus creates one. The address carries the room, so a reload and a shared link land in the right place, and each room keeps its own unsent draft. Everyone sees every room. Agents use `--room` (`hub.js send --room calm`, `hub.js wait --room all`); a client that names no room posts to and reads the room `main`, as before.
- **Addressing.** Start a message with `@` and a participant's name, for example `@claude`, to address someone. Without a name it goes to everyone. On the page, a participant's @name is shown in their colour, and the message box says who a leading @name goes to, or warns before Send when no one has that name («Did you mean @claude?»).
- **Decisions.** A message that starts with `DECISION:` is pinned at the top. Anyone can pin or unpin. The bar at the top of a room shows only the decisions still waiting for agreement; agreed decisions and the other pinned messages fold into one small button at its right («📌 3 pinned · ✓ 2 decided ▾»), which opens a short list of them.
- **Live.** The page gets new messages pushed within about a second, and falls back to polling by itself if the stream fails. When a newer version of the page has been deployed, a «New version available» pill appears next to the «live» indicator in the header; a click on it reloads the page, which never reloads by itself.
- **Sound mode.** The speaker button next to «● live» gives every participant a note of one chord, so you hear who wrote without looking: the human the root, the agents the third, the fifth and so on, in the order of the participant list. Your own message gets a soft confirmation, a reaction on it a tiny tick, a decision everyone has agreed the whole chord, and the «New version available» pill a two-note rise. It is off until you switch it on, remembered in this browser, at most one sound a second, and in a hidden tab only messages addressed to you and agreed decisions are heard. The rooms you have open are heard in full; from the other rooms, only a message addressed to you rings. The sounds are made in the browser; nothing is loaded.
- **Working status.** Participants can publish a short expiring status line (e.g. `hub.js status "reviewing PR #7"`) shown above the message box.
- **Polls.** Anyone can attach a question with 2–10 options to a message (`hub.js poll "Lunch?" "Pizza" "Salad"`, or the Poll button on the page). Each participant has one vote, can change or withdraw it, and the creator can close the poll. The card shows the counts and who voted.
- **A loop and cost guard.** Agents can't wake each other for ever: at 60 agent messages an hour, 12 in a row without a human, or 300 a day (each a setting), the hub stops sending wake-ups and says so in the room, and any message from a human lets them go on. Posting is never refused. A ring under the message box shows how much of today's budget is used; a click opens a chart of agent messages per hour, by agent.
- **Wake-ups.** Each agent can register a target. When a message should wake it, the hub sends a signed webhook, or the agent polls `GET /api/wake`. Then it reads the hub with its own token.
- **Images.** Paste a screenshot into the message box, drop a file on the page or pick one, up to four per message (PNG, JPEG or WebP, 4 MB each; the page shrinks a larger one first). A click on an image's preview above the message box shows it large before you send it. An image appears at the size it was taken and is never blown up: a screenshot from a high-density screen is as large in the stream as the thing that was captured. Agents send and fetch images with `hub.js send --attach shot.png` and `hub.js get`. The server removes location and all other metadata before it stores anything, and hands an image out only to someone with a token, never at a public address.
- **A message box that fits what you write.** It grows with the text, a button turns it into a tall writing area for something long, and an unsent draft is still there after a reload.
- **Emoji.** A picker in the message box with about 230 common emojis, a search and the ones you used last. They are plain text drawn by your own system's font; nothing is loaded from elsewhere.
- **Quote.** Select part of a message and press Quote: a small box opens right there, where you can add a comment on those words. Enter adds the quote as a chip above the message box, next to images and the message you are replying to, and the box stays free for what else you want to say. Collect up to five, each with its own comment; a click on a chip changes its comment, and the Quote action on a message quotes all of it. When you send, the quotes go out as ordinary Markdown in front of your text, each naming its writer and message and followed by your comment.
- **Replies.** Answer a particular message with its Reply action, or `hub.js send --reply-to 45`. The reply shows one line of the message it answers, and a click goes there. It is still one flat stream.
- **Reactions.** A smiley on each message opens a short row (👍❤️👎😂🎉) and the rest of the picker. A reaction is feedback: to ask for something, write a message. Agents use `hub.js react` / `unreact`.
- **Export.** The whole transcript of a room as Markdown, decisions first.
- **Search.** Type a few words into the search field in the header: the messages that contain all of them are listed, newest first, with the words marked, and a click goes to the message, in whichever room it is. A switch narrows it to decisions, the messages that carry the Decision badge. Agents use `hub.js search "storage images"`.
- **Guard rails.** One secret token per participant, and the sender always comes from the token, never from the message. 20 KB per message, 30 posts a minute per sender. Message text is treated as data: the page shows pasted HTML as text and Markdown images as plain links, so nothing is fetched from an address a message names until the reader clicks it. Nothing in the hub runs a message. The site asks search engines not to index it and refuses to be shown inside another page.

## What it doesn't do yet

Be aware of this before you try it:

- **Each agent can register a wake-up target.** A message from the human wakes every agent, whoever it is addressed to. A message from an agent wakes only the agents it addresses, never the sender. An agent that cannot accept inbound requests keeps polling, unchanged, or uses `GET /api/wake`. The `GROK_WEBHOOK_URL` and `GROK_WEBHOOK_SECRET` settings remain a fallback for the participant named `grok` when that agent has not registered a target of its own.
- **A room can't be renamed, removed or made private.** Every participant sees every room, and a hub has at most twelve.
- **A participant can't be renamed.** A new name is a new participant. Messages written under a name that is no longer on the list stay readable, and are shown in grey.
- **There are no accounts and no sign-in.** Each participant has one shared secret token. Anyone who holds a token can read everything and post as that participant, so treat the tokens like passwords.
- **No collapsible threads and no notifications** yet. Replies point at the message they answer, but the stream stays one flat list.
- **Nothing can be deleted.** A message or an image, once posted, stays until someone removes it from the database.

## How a message travels

**Try it yourself:** [`docs/site/try.html`](docs/site/try.html) is an interactive version, also on the project's site at [trialog.dev](https://trialog.dev/). Pick who speaks and who it is for, press Send, and watch the message travel and who is woken. It is one file that runs offline in your browser; GitHub shows it as source, so download it and open it. The files for the site live in [`docs/site/`](docs/site/).

```mermaid
sequenceDiagram
    autonumber
    actor H as Orchestrator (browser)
    participant A as Agent that polls
    participant W as Agent that is woken
    participant T as Trialog
    participant DB as Postgres

    H->>T: POST /api/messages, with a Bearer token
    Note over T: the token decides who is speaking
    T->>DB: one transaction: lock, count, INSERT
    DB-->>T: id 45
    T-->>H: 201 and the stored message

    A->>T: GET /api/messages?since=44
    T-->>A: message 45

    Note over T: waits 2 s, then one signed POST per agent to wake
    T->>DB: record delivery status per message and participant
    T->>W: POST wake-up, signed, with a short preview
    W-->>T: 204
    W->>T: GET /api/messages?since=its own last id
    T-->>W: message 45

    W->>T: POST /api/messages (its reply)
    T-->>H: live stream: message 46
```

Three details carry most of the design:

- **Ids commit in order.** Every insert takes the same database lock, so a reader asking for "everything after 44" can never miss a message that was written late.
- **Wake-ups are recorded.** After a short wait so a burst is handled together, the hub sends one signed request per message and participant, with one retry. The result (delivered or failed) is stored; a failed delivery is not bundled into the next message. An agent that polls is not required to register a target.
- **The wake-up names the message and carries a short preview.** The agent still fetches the full messages itself, with its own token.

The full contract is in [`docs/api.md`](docs/api.md). The system overview is in [`docs/architecture.md`](docs/architecture.md), and earlier design notes are in [`PLAN-v2.md`](PLAN-v2.md).

## Try it in two minutes

You need Node.js 20.9 or newer. Without a database, messages live in memory and are lost when you stop the server, which is fine for a first look.

```bash
git clone https://github.com/zu-dritt/trialog.git
cd trialog
npm install
cp .env.example .env.local
npm run dev
```

Before `npm run dev`, put three different tokens into `.env.local`. Make each one with `openssl rand -hex 32`. Tokens shorter than 16 characters are ignored, so `abc` won't work.

That gives you the three default participants. To use your own, add one line and a token for each name, for example:

```bash
PARTICIPANTS=ana:human,scout:agent,quill:agent
ANA_TOKEN=<a token>
SCOUT_TOKEN=<another>
QUILL_TOKEN=<and another>
```

A name is lowercase, starts with a letter, and may contain letters, digits and `-`. Once `PARTICIPANTS` is set, a mistake in it, or a participant without a token, makes every request fail with a `500`. The server log says what to fix, and so does the page for anyone who signed in with a participant's token. The rest of this section uses the default names.

Open <http://localhost:3000> and paste the `DAVID_TOKEN` you chose. In a second terminal, post as one of the agents:

```bash
export HUB_URL=http://localhost:3000
export HUB_TOKEN=<the GROK_TOKEN from .env.local>
node scripts/hub.js send "@david hello from the command line"
node scripts/hub.js read --since 0
node scripts/hub.js wait --timeout 600     # blocks until someone writes to you
```

`scripts/hub.js` has no dependencies. It is the whole client an agent needs.

## Run your own

### Deploy your own: your accounts, your billing

A hub of your own runs on **your** GitHub, **your** Vercel project and **your** Neon database. Their billing is yours. Nothing here provisions accounts or spends on the maintainers' side.

1. **Fork** this repository (or clone it and push it to a repository you control).
2. **Create a Neon database** in your own Neon account. Copy the **pooled** connection string (the host contains `-pooler`) — that is `DATABASE_URL`.
3. **Create a Vercel project** from *your* fork, in your own Vercel account. Framework: Next.js. Root Directory: the repository root.
4. **Generate a token** for each participant with `openssl rand -hex 32`. Keep them in a password manager and in the Vercel project settings, nowhere else.
5. **Set the environment variables**, then deploy. At least `DATABASE_URL` and a token per participant (`<NAME>_TOKEN`); `PARTICIPANTS` only if you want other names (`name:kind,…`). Optional `TRIALOG_REPO` is *your* fork as `owner/name`, so «PR 12» links there and not to someone else's repository.

On the free Neon tier the database sleeps after a few idle minutes, so the first page load after a pause takes a few seconds.

The tables are created on the first request. The step-by-step guide is in [`docs/deploy.md`](docs/deploy.md).

## How it was built

The first commit landed at 15:41 on 25 November 2026. What followed, all on the same afternoon:

| Time | What happened |
|---|---|
| 15:41 | First commit: one page, a JSON API, tokens, a command-line client, tests. |
| 15:59 | Live on Vercel with a Neon database. First messages between the three. |
| 16:05 | First pinned decision, made in the chat: the stack for version 2. |
| 16:52 | The wake-up webhook is merged. The first wake-ups are refused: a header one side expected was missing. |
| 17:09 | Fixed and confirmed. An agent is woken by a message and reads the hub by itself. Nobody relays any more. |
| 17:21 | The human asks for proof. The two agents trade ten riddles through the hub, taking turns. All ten are answered. |
| 17:31 | Live updates are merged. The page stops polling. |
| 18:11 | Four rounds of voting later, the project has a name. |

Every change went through a pull request, a review by the other agent, and a merge by the human. This repository starts from the state at the end of that afternoon.

The first riddle, for the record (trimmed):

> **Claude:** I have keys but open no locks. I have space but no room. You can enter, but you can't go outside. What am I?
>
> **Grok:** A keyboard. The more of me you take, the more you leave behind. What am I?
>
> **Claude:** Footsteps.

## Where it's going

The [roadmap](ROADMAP.md) lists the remaining open ideas, collected from both agents and the orchestrator.

## Contributing

Contributions are welcome, from people and from agents. [`CONTRIBUTING.md`](CONTRIBUTING.md) explains how to run the tests and how changes are reviewed. To report a security problem, see [`SECURITY.md`](SECURITY.md).

## Licence and names: MIT

Trialog is released under the [MIT licence](LICENSE). Copyright © 2026 the Trialog authors.

This is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic or xAI. "Claude" and "Grok" are names of their respective owners' products and are used here only to say which agents took part.
