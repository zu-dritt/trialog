// How message text is turned into HTML. Kept in its own file so the rules can be tested.
//
// Message text is data written by other participants, and agents may repeat text they read
// elsewhere. So the rendering is deliberately narrow:
//   - No raw HTML. react-markdown shows it as text, and strips javascript: links.
//   - No images. A Markdown image would make the reader's browser fetch any address the writer
//     chose, the moment the message is shown, which tells that server who looked and when.
//     Images are shown as plain links instead; nothing is loaded until the reader clicks.
//   - Links open in a new tab, without passing on where the reader came from.
//   - Links to other sites carry a globe, bare addresses read short, and «PR 62» links the pull
//     request (app/links.ts).
import { createContext, useContext, useMemo, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { splitMentions } from './mentions';
import { REPO, cardText, isExternal, pullRequestUrl, repoForPrefix, shortLabel, splitPullRequests } from './links';
import { PrLink, prNumberOf } from './pr-card';

const LINK_REL = 'noopener noreferrer nofollow';

/** True while rendering the inside of a link, so an image there doesn't become a link within a link. */
const InsideLink = createContext(false);

function Link({ node: _node, href, children, ...props }: ComponentPropsWithoutRef<'a'> & ExtraProps) {
  // react-markdown has already dropped unsafe addresses (javascript:, data: and the like), leaving
  // an empty href. A link to nowhere would only reload the page, so show its text and no link.
  if (typeof href !== 'string' || href === '') return <span>{children}</span>;
  // A bare address (its text is the address itself) reads short. A link that leaves the hub gets a
  // hovercard (on hover and keyboard focus) with the site and the rest of the address; it is drawn by
  // CSS from data-card (.hovercard in globals.css), so no extra text lands in the message.
  const bare = textOf(children) === href;
  const external = isExternal(href);
  // A pull request of this hub's repository: its own hovercard with the PR's summary (app/pr-card.tsx).
  const pr = prNumberOf(href);
  if (pr !== null) {
    return (
      <PrLink n={pr} linkProps={{ ...props, href, target: '_blank', rel: LINK_REL }}>
        <Globe />
        <InsideLink.Provider value={true}>{bare ? shortLabel(href) : children}</InsideLink.Provider>
      </PrLink>
    );
  }
  return (
    <a {...props} href={href} target="_blank" rel={LINK_REL} title={external ? undefined : props.title} data-card={external ? cardText(href) : undefined} className={external ? 'hovercard' : undefined}
      onMouseEnter={external ? placeCard : undefined} onFocus={external ? placeCard : undefined}>
      {external && <Globe />}
      <InsideLink.Provider value={true}>{bare && external ? shortLabel(href) : children}</InsideLink.Provider>
    </a>
  );
}

/**
 * The hovercard opens above the link; near the top of the scrolling area there is no room, so it
 * opens below instead (data-below, read by .hovercard in globals.css).
 */
export const CARD_ROOM_PX = 56;
export function cardBelow(linkTop: number, areaTop: number): boolean {
  return linkTop - areaTop < CARD_ROOM_PX;
}
function placeCard(e: { currentTarget: HTMLElement }) {
  const link = e.currentTarget;
  const area = link.closest('main') ?? document.body;
  link.dataset.below = cardBelow(link.getBoundingClientRect().top, area.getBoundingClientRect().top) ? '1' : '';
}

/** The text of a link's children, when it is only text. */
function textOf(children: unknown): string | null {
  if (typeof children === 'string') return children;
  if (Array.isArray(children) && children.every((c) => typeof c === 'string')) return children.join('');
  return null;
}

/** A small grey globe before a link that leaves the hub (a line icon, not an emoji, so it stays quiet). Decorative: the link's text says where it goes. */
function Globe() {
  return (
    <svg aria-hidden="true" data-globe="" viewBox="0 0 16 16" width="12" height="12" className="mr-[3px] inline-block align-[-1px] text-muted" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="6.3" />
      <path d="M1.8 8h12.4M8 1.7c1.8 1.9 2.7 4 2.7 6.3S9.8 12.4 8 14.3M8 1.7C6.2 3.6 5.3 5.7 5.3 8s.9 4.4 2.7 6.3" />
    </svg>
  );
}

function Image({ node: _node, src, alt }: ComponentPropsWithoutRef<'img'> & ExtraProps) {
  const insideLink = useContext(InsideLink);
  const label = alt ? `image: ${alt}` : 'image';
  // No address left (it was unsafe), or already inside a link: text only. The outer link stays clickable.
  if (insideLink || typeof src !== 'string' || src === '') return <span>[{label}]</span>;
  return <a href={src} target="_blank" rel={LINK_REL}>[{label}]</a>;
}

/** The colour of each participant, for @mentions. Without it, mentions are shown as plain text. */
export const MentionColors = createContext<((name: string) => string) | null>(null);

/** A participant's @name, in that participant's colour. The text is exactly what was written. */
function Span({ node: _node, children, ...props }: ComponentPropsWithoutRef<'span'> & ExtraProps & { 'data-mention'?: string }) {
  const colorOf = useContext(MentionColors);
  const name = props['data-mention'];
  if (!name || !colorOf) return <span {...props}>{children}</span>;
  return <span data-mention={name} className="font-semibold" style={{ color: colorOf(name) }}>{children}</span>;
}

export const mdComponents = { a: Link, img: Image, span: Span };

interface MdNode { type: string; value?: string; url?: string; children?: MdNode[]; data?: Record<string, unknown> }

/**
 * Marks each @name of a participant in the text as a mention (a span, coloured by `Span`). Code
 * spans and blocks are other node types, so a name in code stays as it is.
 */
export function remarkMentions(names: readonly string[]) {
  const walk = (node: MdNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type !== 'text' || !child.value?.includes('@')) { walk(child); return [child]; }
      return splitMentions(child.value, names).map((part) => typeof part === 'string'
        ? { type: 'text', value: part }
        : { type: 'text', value: part.typed, data: { hName: 'span', hProperties: { dataMention: part.name } } });
    });
  };
  return () => (tree: MdNode) => { walk(tree); };
}

/**
 * Turns «PR 62» in the text into a link to that pull request in `repo`. Text inside links and code
 * is left alone, so a link's own words and code stay as written.
 */
export function remarkPullRequests(repo: string | null) {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return;
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type !== 'text' || !child.value || !/p(r|ull request)/i.test(child.value)) { walk(child); return [child]; }
      return splitPullRequests(child.value).map((part): MdNode => {
        if (typeof part === 'string') return { type: 'text', value: part };
        const dest = repoForPrefix(part.prefix, repo);
        return dest
          ? { type: 'link', url: pullRequestUrl(dest, part.n), children: [{ type: 'text', value: part.typed }] } as MdNode
          : { type: 'text', value: part.typed };
      });
    });
  };
  return () => (tree: MdNode) => { walk(tree); };
}

export function MessageBody({ text, names = [], repo = REPO }: { text: string; names?: readonly string[]; repo?: string | null }) {
  const plugins = useMemo(() => [
    remarkGfm,
    ...(names.length ? [remarkMentions(names)] : []),
    remarkPullRequests(repo),
  ], [names, repo]);
  return <ReactMarkdown remarkPlugins={plugins} components={mdComponents}>{text}</ReactMarkdown>;
}
