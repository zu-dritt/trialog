// How message text is turned into HTML. Kept in its own file so the rules can be tested.
//
// Message text is data written by other participants, and agents may repeat text they read
// elsewhere. So the rendering is deliberately narrow:
//   - No raw HTML. react-markdown shows it as text, and strips javascript: links.
//   - No images. A Markdown image would make the reader's browser fetch any address the writer
//     chose, the moment the message is shown, which tells that server who looked and when.
//     Images are shown as plain links instead; nothing is loaded until the reader clicks.
//   - Links open in a new tab, without passing on where the reader came from.
import { createContext, useContext, type ComponentPropsWithoutRef } from 'react';
import ReactMarkdown, { type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';

const LINK_REL = 'noopener noreferrer nofollow';

/** True while rendering the inside of a link, so an image there doesn't become a link within a link. */
const InsideLink = createContext(false);

function Link({ node: _node, href, children, ...props }: ComponentPropsWithoutRef<'a'> & ExtraProps) {
  // react-markdown has already dropped unsafe addresses (javascript:, data: and the like), leaving
  // an empty href. A link to nowhere would only reload the page, so show its text and no link.
  if (typeof href !== 'string' || href === '') return <span>{children}</span>;
  return (
    <a {...props} href={href} target="_blank" rel={LINK_REL}>
      <InsideLink.Provider value={true}>{children}</InsideLink.Provider>
    </a>
  );
}

function Image({ node: _node, src, alt }: ComponentPropsWithoutRef<'img'> & ExtraProps) {
  const insideLink = useContext(InsideLink);
  const label = alt ? `image: ${alt}` : 'image';
  // No address left (it was unsafe), or already inside a link: text only. The outer link stays clickable.
  if (insideLink || typeof src !== 'string' || src === '') return <span>[{label}]</span>;
  return <a href={src} target="_blank" rel={LINK_REL}>[{label}]</a>;
}

export const mdComponents = { a: Link, img: Image };

export function MessageBody({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</ReactMarkdown>;
}
